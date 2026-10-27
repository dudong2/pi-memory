import { HindsightReader, HindsightClient, checkQuery } from "./client.ts";
import { Delivery } from "./delivery.ts";
import { fingerprint } from "./outbox.ts";
import type { Receipt } from "./outbox.ts";
import { loadInstalledConfig } from "./config.ts";
import {
  startupConfig,
  ensureStartupModel,
  startupModelId,
  type StartupClient,
} from "./startup.ts";
import { prepareContext, recallRequest } from "./context.ts";
import { containsSecretData } from "./safety.ts";
import {
  type Identity,
  type MemoryConfig,
  MemoryError,
  type MemoryReader,
  type MemoryWriter,
  sameTags,
  type PreparedContext,
} from "./contracts.ts";
import { resolveIdentity } from "./identity.ts";

export interface RuntimeInput {
  cwd: string;
  sessionId: string;
  prompt: string;
  previousUserPrompt?: string;
}

export type RuntimeResult =
  | { status: "disabled" }
  | { status: "unavailable"; code: string }
  | { status: "ready"; context: PreparedContext };

interface Dependencies {
  loadConfig: () => Promise<MemoryConfig | undefined>;
  resolveIdentity: (cwd: string, catalogPath: string) => Promise<Identity>;
  createReader: (config: MemoryConfig) => MemoryReader;
  createWriter: (config: MemoryConfig) => MemoryWriter;
  createStartupClient: (config: MemoryConfig) => StartupClient;
}

export interface WriteInput extends RuntimeInput {
  key: string;
  kind: "conversation" | "remember" | "correct" | "retract";
  text: string;
  documentId?: string;
  scope?: "current" | "common";
}

// One live request per extension runtime; a newer run invalidates all older work,
// including asynchronous config and identity resolution before HTTP starts.
export class MemoryRuntime {
  private generation = 0;
  private controller: AbortController | undefined;
  private readonly deps: Dependencies;
  private readonly deliveries = new Map<string, Promise<Delivery>>();

  constructor(deps: Partial<Dependencies> = {}) {
    this.deps = {
      loadConfig: loadInstalledConfig,
      createStartupClient: (config) => new HindsightClient(config),
      resolveIdentity,
      createReader: (config) => new HindsightReader(config),
      createWriter: (config) => new HindsightClient(config),
      ...deps,
    };
  }

  reset(): void {
    this.generation++;
    this.controller?.abort();
    this.controller = undefined;
  }

  private async bound(input: RuntimeInput, signal?: AbortSignal) {
    const epoch = this.generation;
    const check = () => {
      if (signal?.aborted || epoch !== this.generation)
        throw new MemoryError("cancelled");
    };
    const config = await this.deps.loadConfig();
    check();
    if (!config) return undefined;
    const identity = await this.deps.resolveIdentity(
      input.cwd,
      config.catalogPath,
    );
    check();
    return { config: startupConfig(config, identity), identity, check };
  }

  private delivery(config: MemoryConfig): Promise<Delivery> {
    if (!config.outboxPath) throw new MemoryError("delivery-disabled");
    const key = fingerprint([
      config.outboxPath,
      config.endpoint,
      config.bankId,
      config.apiKeyEnv,
      config.apiKeyFile,
    ]);
    let existing = this.deliveries.get(key);
    if (!existing) {
      existing = Delivery.open(config, this.deps.createWriter(config));
      this.deliveries.set(key, existing);
      void existing.catch(() => {
        if (this.deliveries.get(key) === existing) this.deliveries.delete(key);
      });
    }
    return existing;
  }

  async remember(
    input: WriteInput,
    signal?: AbortSignal,
  ): Promise<Receipt | undefined> {
    const binding = await this.bound(input, signal);
    if (!binding || !binding.config.outboxPath) {
      if (input.kind === "conversation") return undefined;
      throw new MemoryError("delivery-disabled");
    }
    const { config, identity, check } = binding;
    const scope =
      input.scope === "common" ? config.common?.tags : [identity.scopeTag];
    if (!scope) throw new MemoryError("common-scope-not-configured");
    if (!input.text.trim()) throw new MemoryError("empty-memory");
    const namespace = fingerprint([
      config.endpoint,
      config.bankId,
      scope,
    ]).slice(0, 24);
    const prefix = `pi-memory:memory:${namespace}:`;
    const correcting = input.kind === "correct" || input.kind === "retract";
    if (
      correcting &&
      (!input.documentId?.startsWith(prefix) ||
        !/^[a-f0-9]{64}$/.test(input.documentId.slice(prefix.length)))
    )
      throw new MemoryError("unsupported-document");
    const documentId = correcting
      ? (input.documentId as string)
      : `pi-memory:${input.kind === "conversation" ? "conversation" : "memory"}:${namespace}:${fingerprint([input.sessionId, input.key])}`;
    const content =
      input.kind === "conversation"
        ? input.text
        : input.kind === "retract"
          ? `USER RETRACTION: The previous instruction in this document no longer applies. This does not delete the conversation history.\nReason: ${input.text}`
          : input.kind === "correct"
            ? `USER CORRECTION (replaces the previous instruction in this document):\n${input.text}`
            : `EXPLICIT USER MEMORY:\n${input.text}`;
    const delivery = await this.delivery(config);
    check();
    return delivery.enqueue(
      fingerprint([input.sessionId, identity.scopeId, scope, input.key]),
      {
        content,
        document_id: documentId,
        tags: [...scope],
        update_mode: "replace",
        observation_scopes: "combined",
        metadata: {
          source: "pi-memory",
          source_role:
            input.kind === "conversation" ? "mixed-conversation" : "user",
          kind: input.kind,
          session_id: input.sessionId,
          scope_id: identity.scopeId,
          project_id: identity.projectId,
          scope_type: input.scope ?? "current",
          ...(correcting ? { supersedes: documentId } : {}),
        },
      },
    );
  }

  async lookup(
    input: RuntimeInput,
    query: string,
    reflect: boolean,
    signal = new AbortController().signal,
  ): Promise<string> {
    checkQuery(query);
    const binding = await this.bound(input, signal);
    if (!binding) throw new MemoryError("memory-disabled");
    const { config, identity, check } = binding;
    const request = recallRequest(config, identity, query);
    if (reflect) {
      const text = await this.deps
        .createWriter(config)
        .reflect(request, signal);
      check();
      return text;
    }
    const facts = await this.deps.createReader(config).recall(request, signal);
    check();
    const safe = facts.filter(
      (fact) =>
        request.tag_groups[0].or.some((group) =>
          sameTags(fact.tags, group.tags),
        ) && !containsSecretData(fact),
    );
    let omitted = facts.length - safe.length;
    while (
      safe.length &&
      Buffer.byteLength(JSON.stringify({ facts: safe, omitted })) >
        config.maxContextBytes
    ) {
      safe.pop();
      omitted++;
    }
    return JSON.stringify({ facts: safe, omitted });
  }

  async resume(input: RuntimeInput): Promise<void> {
    const binding = await this.bound(input);
    if (!binding?.config.outboxPath) return;
    const delivery = await this.delivery(binding.config);
    binding.check();
    delivery.kick();
    if (binding.config.startupModels) await this.initializeStartup(input);
  }

  async initializeStartup(
    input: RuntimeInput,
    refresh = false,
    scope?: "current" | "common",
    signal = new AbortController().signal,
  ) {
    const binding = await this.bound(input, signal);
    if (!binding?.config.startupModels)
      throw new MemoryError("startup-disabled");
    const { config, identity, check } = binding;
    const candidates = [
      ...(scope !== "current" && config.common
        ? [{ kind: "common" as const, binding: config.common }]
        : []),
      ...(scope !== "common"
        ? [
            {
              kind: "scope" as const,
              binding: {
                modelId: config.scopeModels[identity.scopeId] as string,
                tags: [identity.scopeTag],
              },
            },
          ]
        : []),
    ];
    if (!candidates.length)
      throw new MemoryError("common-scope-not-configured");
    const client = this.deps.createStartupClient(config);
    const results = await Promise.all(
      candidates.map(async (candidate) => {
        check();
        if (
          candidate.binding.modelId !==
          startupModelId(config, candidate.binding.tags)
        )
          return { modelId: candidate.binding.modelId, state: "read-only" };
        const result = await ensureStartupModel(
          client,
          config,
          candidate.binding,
          candidate.kind,
          signal,
          refresh,
          check,
        );
        check();
        return result;
      }),
    );
    return results;
  }

  async status(input: RuntimeInput, signal?: AbortSignal) {
    const binding = await this.bound(input, signal);
    if (!binding?.config.outboxPath) return { delivery: "disabled" };
    const delivery = await this.delivery(binding.config);
    binding.check();
    await delivery.flush();
    binding.check();
    return delivery.status();
  }

  async shutdown(): Promise<void> {
    this.reset();
    const pending = [...this.deliveries.values()];
    this.deliveries.clear();
    await Promise.allSettled(
      pending.map(async (value) => (await value).close()),
    );
  }

  async prepare(
    input: RuntimeInput,
    callerSignal?: AbortSignal,
  ): Promise<RuntimeResult | undefined> {
    this.reset();
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal;
    const current = () => generation === this.generation && !signal.aborted;
    try {
      let config = await this.deps.loadConfig();
      if (!current()) return undefined;
      if (!config) return { status: "disabled" };
      const identity = await this.deps.resolveIdentity(
        input.cwd,
        config.catalogPath,
      );
      if (!current()) return undefined;
      config = startupConfig(config, identity);
      let localDelivery: "idle" | "pending" | "unavailable" = "idle";
      if (config.outboxPath) {
        try {
          const delivery = await this.delivery(config);
          if (!current()) return undefined;
          const scopes = [
            [identity.scopeTag],
            ...(config.common ? [config.common.tags] : []),
          ];
          if (delivery.hasPendingChanges(scopes)) localDelivery = "pending";
          delivery.kick();
        } catch {
          localDelivery = "unavailable";
        }
      }
      if (!current()) return undefined;
      const context = await prepareContext(
        this.deps.createReader(config),
        config,
        identity,
        input.prompt,
        input.previousUserPrompt,
        signal,
        localDelivery,
      );
      return current() ? { status: "ready", context } : undefined;
    } catch (error) {
      if (!current()) return undefined;
      return {
        status: "unavailable",
        code: error instanceof MemoryError ? error.code : "read-failed",
      };
    } finally {
      if (generation === this.generation) this.controller = undefined;
    }
  }
}
