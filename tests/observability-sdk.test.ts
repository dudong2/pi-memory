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
  assert.ok(status.observation.context.contextHookCalls >= 1);
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
