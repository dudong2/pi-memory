import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import {
  loadExtensions,
  loadExtensionFromFactory,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { createEventBus } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js";
import { registerMemory } from "../src/index.ts";
import { MemoryRuntime } from "../src/runtime.ts";
import { assertContract } from "./hindsight-contract.ts";
import { config, deferred, fact, fakeServer, identity } from "./helpers.ts";

test("real Pi SDK replays Hindsight v1.1 contracts across reads, synthesis, startup jobs and durable Retain", {
  timeout: 15000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-contract-sdk-"));
  const incoming = {
    ...fact(),
    context: "Staging only; production is not authorized.",
    occurred_start: "2026-10-20T09:00:00Z",
    occurred_end: "2026-10-20T10:00:00Z",
    chunk_id: "source-chunk-7",
  };
  const backend = await fakeServer(t, {
    facts: [incoming],
    models: {},
    operationStatus: "processing",
  });
  const settings = {
    ...config,
    endpoint: backend.endpoint,
    scopeModels: {},
    startupModels: true,
    outboxPath: join(root, "outbox.sqlite"),
  };
  let memory = new MemoryRuntime({
    loadConfig: async () => settings,
    resolveIdentity: async () => identity,
  });
  t.after(async () => {
    await memory.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const payloads: { messages: { role: string; content?: string }[] }[] = [];
  const provider = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const payload = JSON.parse(text);
    payloads.push(payload);
    const step = payloads.length;
    const latestOperation = [...backend.operationModels.keys()].at(-1);
    if (step === 6 && latestOperation)
      backend.operations.set(latestOperation, "completed");
    const action =
      step === 1
        ? "search"
        : step === 2
          ? "reflect"
          : step <= 4
            ? "refresh"
            : "status";
    const params =
      step <= 2
        ? { action, query: "maintenance decisions" }
        : step <= 4
          ? { action }
          : { action, operationId: latestOperation };
    const delta =
      step < 7
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `contract-call-${step}`,
                type: "function",
                function: {
                  name: "hindsight_memory",
                  arguments: JSON.stringify(params),
                },
              },
            ],
          }
        : { role: "assistant", content: "Contract workflow completed." };
    const chunk = (value: object, finish: string | null) =>
      `data: ${JSON.stringify({ id: `contract-${step}`, object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      chunk(delta, null) +
        chunk({}, step < 7 ? "tool_calls" : "stop") +
        "data: [DONE]\n\n",
    );
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        provider.closeAllConnections();
        provider.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  const modelUrl = `http://127.0.0.1:${address.port}`;
  const originalFetch = globalThis.fetch;
  const contracts = new Set<string>();
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      assert.ok(
        [backend.endpoint, modelUrl].includes(url.origin),
        "External network is forbidden",
      );
      const response = await originalFetch(input, init);
      if (url.origin === backend.endpoint) {
        const method = init?.method ?? "GET";
        let requestSchema: string | undefined,
          responseSchema: string | undefined;
        if (method === "POST") {
          if (url.pathname.endsWith("/memories/recall")) {
            requestSchema = "RecallRequest";
            responseSchema = "RecallResponse";
          } else if (url.pathname.endsWith("/reflect")) {
            requestSchema = "ReflectRequest";
            responseSchema = "ReflectResponse";
          } else if (url.pathname.endsWith("/mental-models")) {
            requestSchema = "CreateMentalModelRequest";
            responseSchema = "CreateMentalModelResponse";
          } else if (url.pathname.endsWith("/refresh")) {
            requestSchema = "RefreshMentalModelRequest";
            responseSchema = "AsyncOperationSubmitResponse";
          } else if (url.pathname.endsWith("/memories")) {
            requestSchema = "RetainRequest";
            responseSchema = "RetainResponse";
          }
        } else if (url.pathname.includes("/operations/"))
          responseSchema = "OperationStatusResponse";
        else if (url.pathname.includes("/mental-models/"))
          responseSchema = "MentalModelResponse";
        assert.ok(responseSchema, "Undeclared Hindsight route");
        if (requestSchema) {
          assertContract(requestSchema, JSON.parse(String(init?.body)));
          contracts.add(requestSchema);
        }
        if (response.ok) {
          assertContract(responseSchema, await response.clone().json());
          contracts.add(responseSchema);
        }
      }
      return response;
    },
  );
  const bus = createEventBus(),
    extensions = await loadExtensions([], root, bus),
    settled = deferred<void>();
  extensions.extensions.push(
    await loadExtensionFromFactory(
      (pi) => {
        registerMemory(pi, memory, false);
        pi.on("agent_settled", () => settled.resolve());
      },
      root,
      bus,
      extensions.runtime,
      "<contract-sdk>",
    ),
  );
  const loader = {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "Replay the fixed contract workflow.",
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  } as unknown as ResourceLoader;
  const models = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(root, "models.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  models.registerProvider("contract-fixture", {
    api: "openai-completions",
    baseUrl: `${modelUrl}/v1`,
    apiKey: "fixture-not-real-key",
    models: [
      {
        id: "fixture",
        name: "Contract fixture",
        input: ["text"],
        reasoning: false,
        contextWindow: 32768,
        maxTokens: 128,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
  const selected = models.getModel("contract-fixture", "fixture");
  assert.ok(selected);
  const sessionManager = SessionManager.create(root, join(root, "sessions"));
  const { session } = await createAgentSession({
    cwd: root,
    modelRuntime: models,
    model: selected,
    resourceLoader: loader,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
    sessionManager,
    tools: ["hindsight_memory"],
  });
  t.after(() => session.dispose());
  const errors: unknown[] = [];
  await session.bindExtensions({ onError: (error) => errors.push(error) });
  await session.prompt("Use the maintenance decisions.", {
    expandPromptTemplates: false,
  });
  await settled.promise;
  assert.deepEqual(errors, []);
  assert.equal(session.getLastAssistantText(), "Contract workflow completed.");
  assert.equal(payloads.length, 7);
  for (const value of [
    incoming.context,
    incoming.occurred_start,
    incoming.occurred_end,
    incoming.chunk_id,
  ])
    assert.ok(JSON.stringify(payloads[0]).includes(value));
  for (let index = 1; index < payloads.length; index++) {
    const before = payloads[index - 1],
      current = payloads[index];
    assert.ok(before && current);
    assert.deepEqual(
      current.messages.slice(0, before.messages.length),
      before.messages,
      "Prior provider input remains a stable prefix",
    );
  }
  const results = payloads
    .at(-1)
    ?.messages.filter((message) => message.role === "tool")
    .map((message) => JSON.parse(String(message.content)));
  assert.ok(results);
  assert.equal(results.length, 6);
  assert.deepEqual(results[0].facts, [incoming]);
  assert.deepEqual(results[1].evidenceIds, ["source-fact"]);
  assert.equal(results[2][0].state, "submitted");
  assert.equal(results[3][0].state, "submitted");
  assert.equal(results[4].startupOperation.state, "processing");
  assert.equal(results[5].startupOperation.state, "completed");
  const input = {
    cwd: root,
    sessionId: sessionManager.getSessionId(),
    prompt: "",
  };
  const pending = await memory.status(input);
  assert.ok("submitted" in pending && pending.submitted === 1);
  assert.equal(backend.retained.length, 1);
  const retained = backend.retained[0];
  assert.ok(retained);
  const item = retained.items[0];
  assert.ok(item);
  assert.deepEqual(item.tags, [identity.scopeTag]);
  assert.equal(item.metadata.source_role, "mixed-conversation");
  assert.deepEqual(JSON.parse(item.content), {
    user: { role: "user", text: "Use the maintenance decisions." },
    assistant: {
      role: "assistant",
      attribution: "report-or-proposal, not user approval",
      text: "Contract workflow completed.",
    },
  });
  assert.ok(item.timestamp);
  assert.equal(retained.async, true);
  await memory.shutdown();
  backend.operations.set(retained.operation_id, "completed");
  const queue = new DatabaseSync(settings.outboxPath);
  queue
    .prepare("UPDATE deliveries SET next_attempt=0 WHERE id=?")
    .run(retained.operation_id);
  queue.close();
  memory = new MemoryRuntime({
    loadConfig: async () => settings,
    resolveIdentity: async () => identity,
  });
  await memory.resume(input);
  const confirmed = await memory.status(input);
  assert.ok("confirmed" in confirmed && confirmed.confirmed === 1);
  assert.equal(
    backend.retained.length,
    1,
    "Restart checks the same operation without duplicate submissions",
  );
  const probe = new DatabaseSync(settings.outboxPath, { readOnly: true });
  try {
    assert.equal(
      probe
        .prepare("SELECT payload FROM deliveries WHERE id=?")
        .get(retained.operation_id)?.payload,
      null,
    );
  } finally {
    probe.close();
  }
  for (const name of [
    "RecallRequest",
    "RecallResponse",
    "ReflectRequest",
    "ReflectResponse",
    "CreateMentalModelRequest",
    "CreateMentalModelResponse",
    "RefreshMentalModelRequest",
    "AsyncOperationSubmitResponse",
    "OperationStatusResponse",
    "MentalModelResponse",
    "RetainRequest",
    "RetainResponse",
  ])
    assert.ok(
      contracts.has(name),
      `${name} was exercised through native SDK or restart`,
    );
});
