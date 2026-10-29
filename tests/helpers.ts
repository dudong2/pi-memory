import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { RetainRequest } from "../src/outbox.ts";
import type {
  Fact,
  Identity,
  MemoryConfig,
  MentalModel,
} from "../src/contracts.ts";

export const identity: Identity = {
  scopeId: "scope-test",
  projectId: "project-test",
  scopeTag: "legacy:scope-test",
  root: "/fixture",
};

export const config: MemoryConfig = {
  endpoint: "http://127.0.0.1:1",
  bankId: "test-bank",
  catalogPath: "/fixture/catalog.json",
  scopeModels: { "scope-test": "scope-core" },
  timeoutMs: 1000,
  maxContextBytes: 16000,
};

export function model(
  id = "scope-core",
  overrides: Partial<MentalModel> = {},
): MentalModel {
  return {
    id,
    bank_id: config.bankId,
    content: "Verify UI on the deployed Test URL, not localhost.",
    tags: [identity.scopeTag],
    is_stale: false,
    last_refreshed_at: "2026-10-26T10:00:00Z",
    last_memory_seen_at: "2026-10-26T09:59:00Z",
    last_refresh_failed_at: null,
    ...overrides,
  };
}

export function fact(overrides: Partial<Fact> = {}): Fact {
  return {
    id: "fact-test",
    text: "The deployed Test URL is used for UI verification.",
    type: "observation",
    tags: [identity.scopeTag],
    document_id: "source-session",
    source_fact_ids: ["raw-fact"],
    mentioned_at: "2026-10-25T10:00:00Z",
    metadata: { source_role: "user", kind: "instruction" },
    ...overrides,
  };
}

export function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("not initialized");
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function fakeServer(
  t: TestContext,
  options: {
    models?: Record<string, unknown>;
    facts?: unknown[];
    recallStatus?: number;
    recallBody?: unknown;
    redirect?: string;
    loseRetainAcknowledgement?: boolean;
    loseModelAcknowledgement?: boolean;
    operationStatus?: string;
    beforeReply?: () => Promise<void>;
  } = {},
) {
  const requests: {
    method: string;
    url: string;
    body: unknown;
    authorization?: string;
  }[] = [];
  const retained: RetainRequest[] = [];
  const operations = new Map<string, string>();
  const operationModels = new Map<string, string>();
  let lost = false;
  const models = options.models ?? {
    "user-core": model("user-core"),
    "scope-core": model(),
  };
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString())
        : undefined;
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        body,
        authorization: request.headers.authorization,
      });
      await options.beforeReply?.();
      response.setHeader("Content-Type", "application/json");
      if (options.redirect) {
        response.statusCode = 302;
        response.setHeader("Location", options.redirect);
        response.end("{}");
        return;
      }
      const url = new URL(request.url ?? "/", "http://localhost");
      if (
        request.method === "POST" &&
        url.pathname.endsWith("/mental-models")
      ) {
        const id = body.id as string;
        if (models[id]) {
          response.statusCode = 409;
          response.end("{}");
          return;
        }
        models[id] = {
          ...model(id, { tags: body.tags, content: "", is_stale: true }),
          name: body.name,
        };
        const operationId = randomUUID();
        operations.set(operationId, "processing");
        operationModels.set(operationId, id);
        if (options.loseModelAcknowledgement && !lost) {
          lost = true;
          response.destroy();
          return;
        }
        response.end(
          JSON.stringify({ mental_model_id: id, operation_id: operationId }),
        );
      } else if (
        request.method === "POST" &&
        url.pathname.endsWith("/refresh")
      ) {
        const operationId = randomUUID();
        operations.set(operationId, "processing");
        operationModels.set(
          operationId,
          decodeURIComponent(url.pathname.split("/").at(-2) ?? ""),
        );
        response.end(
          JSON.stringify({ operation_id: operationId, status: "queued" }),
        );
      } else if (
        request.method === "GET" &&
        url.pathname.includes("/mental-models/")
      ) {
        const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
        const value = models[id];
        response.statusCode = value ? 200 : 404;
        response.end(JSON.stringify(value ?? { detail: "not found" }));
      } else if (
        request.method === "POST" &&
        url.pathname.endsWith("/memories/recall")
      ) {
        response.statusCode = options.recallStatus ?? 200;
        response.end(
          JSON.stringify(
            options.recallBody ?? { results: options.facts ?? [fact()] },
          ),
        );
      } else if (
        request.method === "POST" &&
        url.pathname.endsWith("/memories")
      ) {
        const retain = body as RetainRequest;
        if (!operations.has(retain.operation_id)) {
          retained.push(retain);
          operations.set(
            retain.operation_id,
            options.operationStatus ?? "completed",
          );
        }
        if (options.loseRetainAcknowledgement && !lost) {
          lost = true;
          response.destroy();
          return;
        }
        response.end(
          JSON.stringify({
            success: true,
            bank_id: decodeURIComponent(url.pathname.split("/").at(-2) ?? ""),
            items_count: retain.items.length,
            async: true,
            operation_id: retain.operation_id,
          }),
        );
      } else if (
        request.method === "GET" &&
        url.pathname.includes("/operations/")
      ) {
        const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
        // v1.1 returns HTTP 200 with status=not_found for unknown operations.
        response.statusCode = 200;
        response.end(
          JSON.stringify({
            operation_id: id,
            status: operations.get(id) ?? "not_found",
            mental_model_id: operationModels.get(id),
          }),
        );
      } else if (
        request.method === "POST" &&
        url.pathname.endsWith("/reflect")
      ) {
        response.end(
          JSON.stringify({
            text: "Scoped synthesis with evidence",
            based_on: body.include?.facts
              ? {
                  memories: [fact({ id: "source-fact" })],
                  mental_models: [],
                  directives: [],
                }
              : null,
          }),
        );
      } else {
        response.statusCode = 405;
        response.end("{}");
      }
    } catch {
      response.statusCode = 500;
      response.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing server address");
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    requests,
    retained,
    operations,
    operationModels,
  };
}
