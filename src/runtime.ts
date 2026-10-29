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
import { safeRecordIds } from "./observability.ts";
import { EvidenceStore, type EvidenceEvent } from "./evidence.ts";
import {
  type Identity,
  type MemoryConfig,
  MemoryError,
  type MemoryReader,
  type MemoryWriter,
  sameTags,
  type PreparedContext,
  type LookupInspection,
  type StartupOperation,
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
  | {
      status: "unavailable";
      code: string;
      scope?: Pick<Identity, "scopeId" | "projectId">;
    }
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
}

// One live request per extension runtime; a newer run invalidates all older work,
// including asynchronous config and identity resolution before HTTP starts.
export class MemoryRuntime {
  private generation = 0;
  private controller: AbortController | undefined;
  private readonly deps: Dependencies;
  private readonly deliveries = new Map<string, Promise<Delivery>>();
  private readonly evidenceStores = new Map<string, EvidenceStore>();
  private evidenceError: string | undefined;
  private evidenceWrites = 0;
  private evidenceFailures = 0;
  private lookupSequence = 0;
  private lastLookup:
    | { cwd: string; sessionId: string; data: LookupInspection }
    | undefined;

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
    this.lastLookup = undefined;
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
    if ("scope" in input) throw new MemoryError("scope-argument-removed");
    const binding = await this.bound(input, signal);
    if (!binding || !binding.config.outboxPath) {
      if (input.kind === "conversation") return undefined;
      throw new MemoryError("delivery-disabled");
    }
    const { config, identity, check } = binding;
    const scope = [identity.scopeTag];
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
          scope_type: "current",
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
    const epoch = this.generation;
    const sequence = ++this.lookupSequence;
    const started = performance.now();
    checkQuery(query);
    const binding = await this.bound(input, signal);
    if (!binding) throw new MemoryError("memory-disabled");
    const { config, identity, check } = binding;
    const request = recallRequest(config, identity, query);
    const record = (
      data: Omit<
        LookupInspection,
        "projectId" | "scopeId" | "action" | "elapsedMs"
      >,
    ) => {
      if (
        epoch !== this.generation ||
        sequence !== this.lookupSequence ||
        signal.aborted
      )
        return;
      this.lastLookup = {
        cwd: input.cwd,
        sessionId: input.sessionId,
        data: {
          projectId: identity.projectId,
          scopeId: identity.scopeId,
          action: reflect ? "reflect" : "search",
          elapsedMs: performance.now() - started,
          ...data,
        },
      };
    };
    try {
      if (reflect) {
        const text = await this.deps
          .createWriter(config)
          .reflect(request, signal);
        check();
        record({ state: "succeeded", resultBytes: Buffer.byteLength(text) });
        return text;
      }
      const facts = await this.deps
        .createReader(config)
        .recall(request, signal);
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
      const text = JSON.stringify({ facts: safe, omitted });
      record({
        state: "succeeded",
        resultBytes: Buffer.byteLength(text),
        fetchedFacts: facts.length,
        includedFacts: safe.length,
        omittedFacts: omitted,
        factIds: safeRecordIds(safe.map((fact) => fact.id)),
      });
      return text;
    } catch (error) {
      record({
        state: "failed",
        code: error instanceof MemoryError ? error.code : "lookup-failed",
      });
      throw error;
    }
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
    signal = new AbortController().signal,
  ) {
    const binding = await this.bound(input, signal);
    if (!binding?.config.startupModels)
      throw new MemoryError("startup-disabled");
    const { config, identity, check } = binding;
    const candidates = [
      {
        binding: {
          modelId: config.scopeModels[identity.scopeId] as string,
          tags: [identity.scopeTag],
        },
      },
    ];
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

  private evidenceStore(config: MemoryConfig): EvidenceStore | undefined {
    if (!config.evidence) return undefined;
    const key = fingerprint(config.evidence);
    let store = this.evidenceStores.get(key);
    if (!store) {
      store = new EvidenceStore(config.evidence);
      this.evidenceStores.set(key, store);
    }
    return store;
  }

  async recordEvidence(
    input: RuntimeInput,
    event: EvidenceEvent,
    signal?: AbortSignal,
  ): Promise<"recorded" | "disabled" | "failed"> {
    try {
      const binding = await this.bound(input, signal);
      if (!binding) return "disabled";
      const store = this.evidenceStore(binding.config);
      if (!store) return "disabled";
      if (
        event.scopeId !== binding.identity.scopeId ||
        event.projectId !== binding.identity.projectId ||
        event.sessionId !== input.sessionId
      )
        throw new MemoryError("evidence-binding-changed");
      binding.check();
      const lookup =
        event.type === "lookup-result" &&
        event.data.state === "produced" &&
        this.lastLookup?.data.state === "succeeded" &&
        this.lastLookup?.cwd === input.cwd &&
        this.lastLookup.sessionId === input.sessionId &&
        this.lastLookup.data.scopeId === event.scopeId
          ? this.lastLookup.data
          : undefined;
      await store.append({
        ...event,
        data: {
          ...event.data,
          ...(lookup ? { lookup } : {}),
          configurationId: fingerprint([
            binding.config.endpoint,
            binding.config.bankId,
            binding.config.scopeModels,
            binding.config.maxContextBytes,
            binding.config.timeoutMs,
            binding.config.startupModels,
            binding.config.evidence,
          ]),
        },
      });
      this.evidenceError = undefined;
      this.evidenceWrites++;
      return "recorded";
    } catch (error) {
      if (!(error instanceof MemoryError && error.code === "cancelled")) {
        this.evidenceFailures++;
        this.evidenceError =
          error instanceof MemoryError ? error.code : "evidence-write-failed";
      }
      return "failed";
    }
  }

  async readEvidence(
    input: RuntimeInput,
    requestId?: string,
    offset = 0,
    limit = 5,
    signal?: AbortSignal,
  ) {
    const binding = await this.bound(input, signal);
    if (!binding) throw new MemoryError("memory-disabled");
    const store = this.evidenceStore(binding.config);
    if (!store) throw new MemoryError("evidence-disabled");
    const result = await store.read(
      binding.identity.scopeId,
      requestId,
      offset,
      limit,
    );
    binding.check();
    return result;
  }

  async status(
    input: RuntimeInput,
    signal?: AbortSignal,
    operationId?: string,
  ) {
    const binding = await this.bound(input, signal);
    let startupOperation: StartupOperation | undefined;
    if (operationId !== undefined) {
      if (!binding) throw new MemoryError("memory-disabled");
      const { config, identity, check } = binding;
      const modelId = config.scopeModels[identity.scopeId];
      if (!modelId) throw new MemoryError("startup-disabled");
      const client = this.deps.createStartupClient(config);
      if (!client.getStartupOperation)
        throw new MemoryError("operation-status-unavailable");
      const model = await client.getModel(
        modelId,
        signal ?? new AbortController().signal,
      );
      check();
      if (
        !model ||
        model.id !== modelId ||
        model.bank_id !== config.bankId ||
        !sameTags(model.tags, [identity.scopeTag])
      )
        throw new MemoryError("startup-scope-mismatch");
      startupOperation = await client.getStartupOperation(
        operationId,
        modelId,
        signal ?? new AbortController().signal,
      );
      check();
    }
    const scope = binding
      ? {
          scopeId: binding.identity.scopeId,
          projectId: binding.identity.projectId,
        }
      : null;
    const evidence = {
      enabled: !!binding?.config.evidence,
      directory: binding?.config.evidence?.directory,
      retentionDays: binding?.config.evidence?.retentionDays,
      maxBytes: binding?.config.evidence?.maxBytes,
      writesThisRuntime: this.evidenceWrites,
      failuresThisRuntime: this.evidenceFailures,
      error: this.evidenceError,
      storage: binding
        ? this.evidenceStore(binding.config)?.status()
        : undefined,
    };
    const lookup = this.lastLookup;
    const observation = {
      lookup:
        scope &&
        lookup &&
        lookup.cwd === input.cwd &&
        lookup.sessionId === input.sessionId &&
        lookup.data.scopeId === scope.scopeId &&
        lookup.data.projectId === scope.projectId
          ? structuredClone(lookup.data)
          : null,
    };
    if (!binding?.config.outboxPath)
      return {
        delivery: "disabled",
        scope,
        observation,
        evidence,
        ...(startupOperation ? { startupOperation } : {}),
      };
    const delivery = await this.delivery(binding.config);
    binding.check();
    await delivery.flush();
    binding.check();
    return {
      ...delivery.status(),
      scope,
      observation,
      evidence,
      ...(startupOperation ? { startupOperation } : {}),
    };
  }

  async shutdown(): Promise<void> {
    this.reset();
    const pending = [...this.deliveries.values()];
    const stores = [...this.evidenceStores.values()];
    this.deliveries.clear();
    this.evidenceStores.clear();
    await Promise.allSettled([
      ...pending.map(async (value) => (await value).close()),
      ...stores.map((store) => store.close()),
    ]);
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
    let scope: Pick<Identity, "scopeId" | "projectId"> | undefined;
    try {
      let config = await this.deps.loadConfig();
      if (!current()) return undefined;
      if (!config) return { status: "disabled" };
      const identity = await this.deps.resolveIdentity(
        input.cwd,
        config.catalogPath,
      );
      if (!current()) return undefined;
      scope = { scopeId: identity.scopeId, projectId: identity.projectId };
      config = startupConfig(config, identity);
      let localDelivery: "idle" | "pending" | "unavailable" = "idle";
      if (config.outboxPath) {
        try {
          const delivery = await this.delivery(config);
          if (!current()) return undefined;
          const scopes = [[identity.scopeTag]];
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
        ...(scope ? { scope } : {}),
      };
    } finally {
      if (generation === this.generation) this.controller = undefined;
    }
  }
}
