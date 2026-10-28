import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionToolContext,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import {
  loadExtensions,
  loadExtensionFromFactory,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { createEventBus } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js";
import { Type } from "@earendil-works/pi-ai";
import { registerMemory } from "../src/index.ts";
import { MemoryRuntime } from "../src/runtime.ts";
import { config, fact, identity, model, deferred } from "./helpers.ts";

// Real Pi session + real OpenAI-compatible payload conversion, but only a local
// fixed SSE fixture: no model account, external request or operational memory.
test("Pi SDK sends the reference in a real provider payload and reports observation without claiming answer use", {
  timeout: 15_000,
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-memory-observation-sdk-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const payloads: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    payloads.push(Buffer.concat(chunks).toString());
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: object, finish_reason: string | null) =>
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    res.end(
      chunk({ role: "assistant", content: "Fixture response" }, null) +
        chunk({}, "stop") +
        "data: [DONE]\n\n",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const models = await ModelRuntime.create({
    authPath: join(cwd, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(cwd, "models.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  models.registerProvider("observation-fixture", {
    api: "openai-completions",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: "fixture-not-a-real-key",
    models: [
      {
        id: "fixture",
        name: "Fixture",
        reasoning: false,
        input: ["text"],
        contextWindow: 8192,
        maxTokens: 128,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
  const selected = models.getModel("observation-fixture", "fixture");
  assert.ok(selected);
  const settings = {
    ...config,
    evidence: {
      directory: join(cwd, "evidence"),
      retentionDays: 30,
      maxBytes: 256 * 1024 * 1024,
    },
  };
  let settled = deferred<void>();
  const memory = new MemoryRuntime({
    loadConfig: async () => settings,
    resolveIdentity: async () => identity,
    createReader: () => ({
      getModel: async (id) => model(id),
      recall: async () => [fact({ text: "SDK_PRIVATE_MEMORY_BODY" })],
    }),
  });
  const bus = createEventBus();
  const extensions = await loadExtensions([], cwd, bus);
  let inspect: ((ctx: ExtensionToolContext) => Promise<string>) | undefined;
  extensions.extensions.push(
    await loadExtensionFromFactory(
      (pi) => {
        registerMemory(
          {
            ...pi,
            registerTool: (definition) => {
              inspect = async (ctx) => {
                const result = await definition.execute(
                  "inspect",
                  { action: "status" } as never,
                  new AbortController().signal,
                  () => {},
                  ctx,
                );
                const content = result.content[0];
                assert.ok(content?.type === "text");
                return content.text;
              };
              pi.registerTool(definition);
            },
          },
          memory,
          false,
        );
        pi.on("agent_settled", () => settled.resolve());
      },
      cwd,
      bus,
      extensions.runtime,
      "<observation-sdk-fixture>",
    ),
  );
  const loader = {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "A local fixture. Reply briefly.",
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  } as unknown as ResourceLoader;
  const sessionManager = SessionManager.create(cwd, join(cwd, "sessions"));
  const { session } = await createAgentSession({
    cwd,
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
  await session.prompt("SDK_PRIVATE_QUERY", { expandPromptTemplates: false });
  await settled.promise;
  assert.deepEqual(errors, []);
  assert.equal(session.getLastAssistantText(), "Fixture response");
  assert.equal(payloads.length, 1);
  assert.ok(payloads[0]?.includes("SDK_PRIVATE_MEMORY_BODY"));
  assert.ok(inspect);
  const status = JSON.parse(
    await inspect({
      cwd,
      sessionManager,
      hasUI: false,
    } as unknown as ExtensionToolContext),
  );
  assert.equal(status.observation.context.providerPayloadChecks, 1);
  assert.equal(status.observation.context.providerPayloadMatches, 1);
  assert.equal(status.observation.context.answerUse, "not-assessed");
  assert.ok(!JSON.stringify(status.observation).includes("SDK_PRIVATE_"));
  assert.equal(status.evidence.enabled, true);
  assert.equal(status.evidence.error, undefined);
  const archive = await memory.readEvidence(
    { cwd, sessionId: sessionManager.getSessionId(), prompt: "" },
    status.observation.context.requestId,
    0,
    50,
  );
  assert.ok(archive.events);
  assert.deepEqual(
    archive.events.map((record) => record.type),
    ["prepared", "provider-payload", "settled"],
  );
  const payload = archive.events.find(
    (record) => record.type === "provider-payload",
  );
  assert.ok(typeof payload?.data.snapshot === "string");
  assert.ok(payload.data.snapshot.includes("SDK_PRIVATE_MEMORY_BODY"));
  assert.equal(payload.data.matched, true);
  assert.match(payload.implementation.codeId, /^[a-f0-9]{64}$/);
  const terminal = archive.events.find((record) => record.type === "settled");
  const branch = sessionManager.getBranch();
  assert.ok(
    branch.some((entry) => entry.id === terminal?.data.assistantEntryId),
  );
  assert.ok(branch.some((entry) => entry.id === terminal?.userEntryId));
  assert.equal(terminal?.sessionFile, sessionManager.getSessionFile());
  assert.ok(
    (await readFile(sessionManager.getSessionFile() ?? "", "utf8")).includes(
      "SDK_PRIVATE_QUERY",
    ),
  );
  assert.ok(!JSON.stringify(archive.events).includes("SDK_PRIVATE_QUERY"));
  settled = deferred<void>();
  await session.prompt("SDK_PRIVATE_QUERY", { expandPromptTemplates: false });
  await settled.promise;
  const secondStatus = JSON.parse(
    await inspect({
      cwd,
      sessionManager,
      hasUI: false,
    } as unknown as ExtensionToolContext),
  );
  assert.notEqual(
    secondStatus.observation.context.requestId,
    status.observation.context.requestId,
  );
  const secondArchive = await memory.readEvidence(
    { cwd, sessionId: sessionManager.getSessionId(), prompt: "" },
    secondStatus.observation.context.requestId,
    0,
    50,
  );
  assert.ok(secondArchive.events);
  const secondTerminal = secondArchive.events.find(
    (record) => record.type === "settled",
  );
  assert.ok(secondTerminal?.userEntryId);
  assert.notEqual(secondTerminal.userEntryId, terminal?.userEntryId);
  assert.notEqual(
    secondTerminal.data.assistantEntryId,
    terminal?.data.assistantEntryId,
  );
  await chmod(settings.evidence.directory, 0o755);
  settled = deferred<void>();
  await session.prompt("SDK_PRIVATE_QUERY", { expandPromptTemplates: false });
  await settled.promise;
  assert.equal(session.getLastAssistantText(), "Fixture response");
  const failedStatus = JSON.parse(
    await inspect({
      cwd,
      sessionManager,
      hasUI: false,
    } as unknown as ExtensionToolContext),
  );
  assert.equal(failedStatus.evidence.error, "evidence-unsafe-storage");
  assert.ok(failedStatus.evidence.failuresThisRuntime >= 1);
  await chmod(settings.evidence.directory, 0o700);
});

type ResponsesPayload = {
  input: {
    type?: string;
    role?: string;
    content?: string | { type: string; text?: string }[];
  }[];
  prompt_cache_key?: string;
  tools?: unknown;
};

function inputText(item: ResponsesPayload["input"][number]) {
  return typeof item.content === "string"
    ? item.content
    : (item.content ?? []).map((part) => part.text ?? "").join("\n");
}

function memorySnapshots(payload: ResponsesPayload) {
  return payload.input.filter(
    (item) =>
      item.role === "user" &&
      /CACHE_MEMORY_TURN_|^Memory reference unavailable \(/.test(
        inputText(item),
      ),
  );
}

for (const availability of ["available", "unavailable"] as const) {
  test(`Responses cache prefixes survive tool loops, user turns, native resume and compaction with ${availability} memory`, {
    timeout: 15_000,
  }, async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-memory-cache-sdk-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const payloads: ResponsesPayload[] = [];
    const paths: string[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      paths.push(req.url ?? "");
      payloads.push(JSON.parse(Buffer.concat(chunks).toString()));
      const request = payloads.length;
      const isToolCall = request % 3 !== 0;
      const item = isToolCall
        ? {
            type: "function_call",
            id: `fc_fixture_${request}`,
            call_id: `call_fixture_${request}`,
            name: "cache_probe",
            arguments: JSON.stringify({ step: request }),
            status: "completed",
          }
        : {
            type: "message",
            id: `msg_fixture_${request}`,
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "Cache fixture complete.",
                annotations: [],
              },
            ],
          };
      const events = [
        {
          type: "response.created",
          response: { id: `resp_fixture_${request}`, status: "in_progress" },
        },
        { type: "response.output_item.added", output_index: 0, item },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id: `resp_fixture_${request}`,
            status: "completed",
            output: [item],
            usage: {
              input_tokens: 64,
              output_tokens: 8,
              total_tokens: 72,
              input_tokens_details: { cached_tokens: 0 },
            },
          },
        },
      ];
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        events
          .map(
            (event) =>
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          )
          .join(""),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    t.after(
      () =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const models = await ModelRuntime.create({
      authPath: join(cwd, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(cwd, "models.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    models.registerProvider("cache-fixture", {
      api: "openai-responses",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "fixture-not-a-real-key",
      models: [
        {
          id: "fixture",
          name: "Cache fixture",
          reasoning: false,
          input: ["text"],
          contextWindow: 8192,
          maxTokens: 128,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    });
    const selected = models.getModel("cache-fixture", "fixture");
    assert.ok(selected);
    const errors: unknown[] = [];
    const toolSteps: number[] = [];
    let recalls = 0;
    let settled = deferred<void>();
    const startSession = async (sessionManager: SessionManager) => {
      const memory = new MemoryRuntime({
        loadConfig: async () => config,
        resolveIdentity: async () => {
          if (availability === "unavailable")
            throw new Error("Fixture memory is unavailable");
          return identity;
        },
        createReader: () => ({
          getModel: async (id) => model(id),
          recall: async () => [
            fact({ text: `CACHE_MEMORY_TURN_${++recalls}` }),
          ],
        }),
      });
      const bus = createEventBus();
      const extensions = await loadExtensions([], cwd, bus);
      extensions.extensions.push(
        await loadExtensionFromFactory(
          (pi) => {
            registerMemory(pi, memory, false);
            pi.registerTool({
              name: "cache_probe",
              label: "Cache probe",
              description: "Return a fixed local fixture result.",
              parameters: Type.Object({ step: Type.Number() }),
              async execute(_id, params) {
                toolSteps.push(params.step);
                return {
                  content: [
                    { type: "text", text: `Fixture step ${params.step}` },
                  ],
                  details: {},
                };
              },
            });
            pi.on("agent_settled", () => settled.resolve());
          },
          cwd,
          bus,
          extensions.runtime,
          "<cache-sdk-fixture>",
        ),
      );
      const loader = {
        getExtensions: () => extensions,
        getSkills: () => ({ skills: [], diagnostics: [] }),
        getPrompts: () => ({ prompts: [], diagnostics: [] }),
        getThemes: () => ({ themes: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
        getSystemPrompt: () => "A deterministic local cache fixture.",
        getSystemPromptSource: () => undefined,
        getAppendSystemPrompt: () => [],
        getAppendSystemPromptSources: () => [],
        extendResources: () => {},
        reload: async () => {},
      } as unknown as ResourceLoader;
      const { session } = await createAgentSession({
        cwd,
        modelRuntime: models,
        model: selected,
        resourceLoader: loader,
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: false },
          retry: { enabled: false },
        }),
        sessionManager,
        tools: ["cache_probe"],
      });
      await session.bindExtensions({ onError: (error) => errors.push(error) });
      return session;
    };
    let sessionManager = SessionManager.create(cwd, join(cwd, "sessions"));
    let session = await startSession(sessionManager);
    t.after(() => session.dispose());
    const snapshots: ResponsesPayload["input"] = [];
    const runTurn = async (prompt: string, afterCompaction = false) => {
      settled = deferred<void>();
      const before = payloads.length;
      await session.prompt(prompt, { expandPromptTemplates: false });
      await settled.promise;
      assert.equal(session.getLastAssistantText(), "Cache fixture complete.");
      assert.equal(payloads.length - before, 3, "two tool-loop iterations");
      const requests = payloads.slice(before);
      const first = requests[0];
      assert.ok(first);
      const snapshot = memorySnapshots(first).at(-1);
      assert.ok(snapshot);
      snapshots.push(snapshot);
      const userIndex = first.input.findIndex(
        (item) => item.role === "user" && inputText(item) === prompt,
      );
      assert.ok(userIndex >= 0);
      assert.deepEqual(first.input[userIndex + 1], snapshot);
      for (const payload of requests) {
        assert.deepEqual(
          memorySnapshots(payload),
          snapshots,
          "each user turn adds one snapshot and preserves all prior snapshots",
        );
      }
      assert.equal(
        requests
          .at(-1)
          ?.input.filter((item) => item.type === "function_call_output").length,
        snapshots.length * 2,
      );
      const firstComparable = afterCompaction
        ? before + 1
        : Math.max(1, before);
      for (let index = firstComparable; index < payloads.length; index++) {
        const previous = payloads[index - 1];
        const current = payloads[index];
        assert.ok(previous && current);
        assert.equal(
          JSON.stringify(current.input.slice(0, previous.input.length)),
          JSON.stringify(previous.input),
          `request ${index + 1} preserves the previous cacheable input endpoint`,
        );
        assert.equal(current.prompt_cache_key, previous.prompt_cache_key);
        assert.deepEqual(current.tools, previous.tools);
      }
    };
    await runTurn("CACHE_USER_TURN_ONE");
    await runTurn("CACHE_USER_TURN_TWO");
    const sessionFile = sessionManager.getSessionFile();
    assert.ok(sessionFile);
    const sessionId = sessionManager.getSessionId();
    session.dispose();
    sessionManager = SessionManager.open(sessionFile);
    assert.equal(sessionManager.getSessionId(), sessionId);
    session = await startSession(sessionManager);
    await runTurn("CACHE_USER_AFTER_RESUME");
    const lastUser = sessionManager
      .getBranch()
      .filter(
        (entry) => entry.type === "message" && entry.message.role === "user",
      )
      .at(-1);
    assert.ok(lastUser);
    session.dispose();
    // Exercise Pi's native compaction projection, retaining the last user turn.
    // Compaction may replace the old prefix; subsequent requests must not.
    const summary = "Earlier cache fixture turns were completed.";
    sessionManager.appendCompaction(summary, lastUser.id, 1024);
    sessionManager = SessionManager.open(sessionFile);
    session = await startSession(sessionManager);
    snapshots.splice(0, 2);
    await runTurn("CACHE_USER_AFTER_COMPACTION", true);
    assert.ok(JSON.stringify(payloads.at(-1)?.input).includes(summary));
    assert.deepEqual(errors, []);
    assert.deepEqual(toolSteps, [1, 2, 4, 5, 7, 8, 10, 11]);
    assert.equal(recalls, availability === "available" ? 4 : 0);
    assert.ok(paths.every((path) => path === "/v1/responses"));
    assert.ok(payloads[0]?.prompt_cache_key);
  });
}
