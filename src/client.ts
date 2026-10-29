import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import type { StartupModelRequest } from "./startup.ts";
import {
  type Fact,
  type MemoryConfig,
  MemoryError,
  type MemoryReader,
  type MentalModel,
  type StartupOperation,
  nonempty,
  object,
  type RecallRequest,
  tags,
} from "./contracts.ts";
import { defaultReflectTimeoutMs, safeEndpoint } from "./config.ts";
import { containsSecret, containsSecretData } from "./safety.ts";
import type { MemoryWriter } from "./contracts.ts";
import type { RetainRequest } from "./outbox.ts";

export function checkQuery(value: string): void {
  nonempty(value);
  if (containsSecret(value)) throw new MemoryError("secret-blocked");
  if (Buffer.byteLength(value) > 8192) throw new MemoryError("query-too-large");
}

function nullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new MemoryError("invalid-response");
  return value;
}

function fact(value: unknown): Fact {
  const row = object(value);
  if (!["observation", "world", "experience"].includes(String(row.type))) {
    throw new MemoryError("invalid-response");
  }
  const result: Fact = {
    id: nonempty(row.id),
    text: nonempty(row.text),
    type: row.type as Fact["type"],
    // Missing tags are not evidence that a result is in the requested scope.
    tags: tags(row.tags),
  };
  for (const field of ["document_id", "mentioned_at"] as const) {
    if (row[field] != null) result[field] = nonempty(row[field]);
  }
  for (const field of [
    "context",
    "occurred_start",
    "occurred_end",
    "chunk_id",
  ] as const) {
    const value = nullableText(row[field]);
    if (value !== null) result[field] = value;
  }
  if (row.source_fact_ids != null)
    result.source_fact_ids = tags(row.source_fact_ids);
  if (row.metadata != null) {
    const metadata = object(row.metadata);
    if (!Object.values(metadata).every((value) => typeof value === "string")) {
      throw new MemoryError("invalid-response");
    }
    result.metadata = metadata as Record<string, string>;
  }
  return result;
}

// Reading and delivery share one bounded, redacted HTTP transport.
export class HindsightReader implements MemoryReader {
  protected readonly config: MemoryConfig;
  private readonly apiKey: string | undefined;

  constructor(config: MemoryConfig, env: NodeJS.ProcessEnv = process.env) {
    this.config = { ...config, endpoint: safeEndpoint(config.endpoint) };
    if (config.apiKeyFile) {
      try {
        const info = lstatSync(config.apiKeyFile);
        if (
          !info.isFile() ||
          info.mode & 0o077 ||
          info.uid !== process.getuid?.() ||
          config.apiKeyEnv
        )
          throw new MemoryError("unsafe-credential-file");
        const credentials = object(
          JSON.parse(readFileSync(config.apiKeyFile, "utf8")),
        );
        if (
          (credentials.apiUrl !== undefined &&
            safeEndpoint(credentials.apiUrl) !== this.config.endpoint) ||
          (credentials.bankId !== undefined &&
            credentials.bankId !== config.bankId)
        )
          throw new MemoryError("credential-destination-mismatch");
        this.apiKey = nonempty(credentials.apiKey);
      } catch (error) {
        throw new MemoryError(
          error instanceof MemoryError ? error.code : "credential-unavailable",
        );
      }
    } else
      this.apiKey = config.apiKeyEnv
        ? nonempty(env[config.apiKeyEnv])
        : undefined;
  }

  get destinationIdentity(): string {
    // Persist only an opaque routing fingerprint, never the credential. Pending
    // data must not move to another authenticated destination after reconfiguration.
    return createHash("sha256")
      .update(
        JSON.stringify([
          this.config.endpoint,
          this.config.bankId,
          this.apiKey ?? null,
        ]),
      )
      .digest("hex");
  }

  async getModel(
    id: string,
    signal: AbortSignal,
  ): Promise<MentalModel | undefined> {
    const value = await this.request(
      `mental-models/${encodeURIComponent(id)}?detail=full`,
      undefined,
      signal,
      true,
    );
    if (value === undefined) return undefined;
    const row = object(value);
    if (row.is_stale != null && typeof row.is_stale !== "boolean") {
      throw new MemoryError("invalid-response");
    }
    return {
      id: nonempty(row.id),
      bank_id: nonempty(row.bank_id),
      content: nullableText(row.content),
      tags: tags(row.tags),
      is_stale: (row.is_stale as boolean | null | undefined) ?? null,
      last_refreshed_at: nullableText(row.last_refreshed_at),
      last_memory_seen_at: nullableText(row.last_memory_seen_at),
      last_refresh_failed_at: nullableText(row.last_refresh_failed_at),
    };
  }

  async recall(body: RecallRequest, signal: AbortSignal): Promise<Fact[]> {
    checkQuery(body.query);
    const row = object(await this.request("memories/recall", body, signal));
    if (!Array.isArray(row.results)) throw new MemoryError("invalid-response");
    return row.results.map(fact);
  }

  protected async request(
    path: string,
    body: object | undefined,
    signal: AbortSignal,
    allowMissing = false,
    timeoutMs = this.config.timeoutMs,
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (body) headers["Content-Type"] = "application/json";
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
      const response = await fetch(
        `${this.config.endpoint}/v1/default/banks/${encodeURIComponent(this.config.bankId)}/${path}`,
        {
          method: body ? "POST" : "GET",
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: combined,
          redirect: "error",
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        if (allowMissing && response.status === 404) return undefined;
        // Never expose server error bodies or credentials in retry/log metadata.
        throw new MemoryError(`http-${response.status}`);
      }
      if (!response.body) throw new MemoryError("invalid-response");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 1_048_576) {
            await reader.cancel();
            throw new MemoryError("response-too-large");
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      if (signal.aborted) throw new MemoryError("cancelled");
      if (timeout.aborted) throw new MemoryError("timeout");
      if (error instanceof MemoryError) throw error;
      throw new MemoryError("request-failed");
    }
  }
}

export class HindsightClient extends HindsightReader implements MemoryWriter {
  async createStartupModel(
    body: StartupModelRequest,
    signal: AbortSignal,
  ): Promise<string> {
    if (containsSecretData(body)) throw new MemoryError("secret-blocked");
    const row = object(await this.request("mental-models", body, signal));
    if (row.mental_model_id !== body.id)
      throw new MemoryError("model-mismatch");
    return nonempty(row.operation_id);
  }

  async refreshStartupModel(id: string, signal: AbortSignal): Promise<string> {
    const row = object(
      await this.request(
        `mental-models/${encodeURIComponent(id)}/refresh`,
        {},
        signal,
      ),
    );
    return nonempty(row.operation_id);
  }

  async retain(body: RetainRequest, signal: AbortSignal): Promise<string> {
    if (containsSecretData(body)) throw new MemoryError("secret-blocked");
    if (
      !body.items.length ||
      body.items.some((item) => !item.tags.length || !item.content.trim())
    )
      throw new MemoryError("invalid-retain");
    const row = object(await this.request("memories", body, signal));
    if (row.operation_id !== body.operation_id)
      throw new MemoryError("operation-mismatch");
    return nonempty(row.operation_id);
  }

  private async operationResponse(id: string, signal: AbortSignal) {
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id))
      throw new MemoryError("invalid-operation-id");
    const value = await this.request(
      `operations/${encodeURIComponent(id)}`,
      undefined,
      signal,
      true,
    );
    if (value === undefined) return undefined;
    const row = object(value);
    if (row.operation_id !== id) throw new MemoryError("operation-mismatch");
    const status = nonempty(row.status);
    if (status === "not_found") return undefined;
    if (
      ![
        "not_found",
        "pending",
        "processing",
        "completed",
        "failed",
        "cancelled",
      ].includes(status)
    )
      throw new MemoryError("invalid-response");
    return {
      state: status as Awaited<ReturnType<MemoryWriter["operation"]>>,
      modelId:
        row.mental_model_id == null ? undefined : nonempty(row.mental_model_id),
    };
  }

  async operation(
    id: string,
    signal: AbortSignal,
  ): ReturnType<MemoryWriter["operation"]> {
    return (await this.operationResponse(id, signal))?.state ?? "not_found";
  }

  async getStartupOperation(
    id: string,
    modelId: string,
    signal: AbortSignal,
  ): Promise<StartupOperation> {
    const operation = await this.operationResponse(id, signal);
    if (operation && operation.modelId !== modelId)
      throw new MemoryError("operation-scope-mismatch");
    return { operationId: id, modelId, state: operation?.state ?? "not_found" };
  }

  async reflect(request: RecallRequest, signal: AbortSignal): Promise<string> {
    checkQuery(request.query);
    const row = object(
      await this.request(
        "reflect",
        {
          query: request.query,
          budget: "low",
          max_tokens: request.max_tokens,
          tag_groups: request.tag_groups,
          include: { facts: {} },
        },
        signal,
        false,
        this.config.reflectTimeoutMs ?? defaultReflectTimeoutMs,
      ),
    );
    const text = nonempty(row.text);
    const based = row.based_on == null ? {} : object(row.based_on);
    const ids = Object.values(based)
      .flatMap((value) => (Array.isArray(value) ? value : []))
      .filter(
        (value) =>
          value && typeof value === "object" && typeof value.id === "string",
      )
      .map((value) => String(value.id))
      .slice(0, 100);
    const result = JSON.stringify({ text, evidenceIds: ids });
    if (containsSecretData({ text, evidenceIds: ids }))
      throw new MemoryError("secret-blocked");
    if (Buffer.byteLength(result) > this.config.maxContextBytes)
      throw new MemoryError("response-too-large");
    return result;
  }
}
