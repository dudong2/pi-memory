import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HindsightClient } from "../src/client.ts";
import { startupModelId, ensureStartupModel } from "../src/startup.ts";
import { MemoryRuntime } from "../src/runtime.ts";
import { config, identity, fakeServer, model, deferred } from "./helpers.ts";

const input = {
  cwd: identity.root,
  sessionId: "startup-test",
  prompt: "Start work",
};

test("native startup creation -> backend refresh -> next request reads plain model", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-startup-"));
  const models: Record<string, unknown> = {};
  const server = await fakeServer(t, { models, facts: [] });
  const settings = {
    ...config,
    endpoint: server.endpoint,
    startupModels: true,
    outboxPath: join(root, "queue.sqlite"),
    scopeModels: {},
  };
  const runtime = new MemoryRuntime({
    loadConfig: async () => settings,
    resolveIdentity: async () => identity,
  });
  t.after(async () => {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await runtime.resume(input);
  const creates = server.requests.filter(
    (r) => r.method === "POST" && r.url.endsWith("/mental-models"),
  );
  assert.equal(creates.length, 1);
  for (const request of creates) {
    const body = request.body as {
      id: string;
      tags: string[];
      trigger: Record<string, unknown>;
    };
    assert.equal(body.trigger.tags_match, "exact");
    assert.equal(body.trigger.refresh_after_consolidation, true);
    assert.equal(body.trigger.min_refresh_interval_seconds, 3600);
    assert.equal(body.trigger.exclude_mental_models, true);
    assert.equal(body.trigger.response_schema, undefined);
    models[body.id] = model(body.id, {
      tags: body.tags,
      content: "새 세션에 필요한 현재 전제입니다.",
    });
  }
  const read = await runtime.prepare(input);
  assert.equal(read?.status, "ready");
  if (read?.status === "ready")
    assert.match(read.context.text, /새 세션에 필요한 현재 전제/);
  await runtime.resume(input);
  assert.equal(
    server.requests.filter(
      (r) => r.method === "POST" && r.url.endsWith("/mental-models"),
    ).length,
    1,
  );
  const refreshed = await runtime.initializeStartup(input, true);
  assert.equal(refreshed[0]?.state, "submitted");
  assert.equal(
    server.requests.filter((r) => r.url.endsWith("/refresh")).length,
    1,
  );
});

test("lost model creation response does not submit a second generation", async (t) => {
  const server = await fakeServer(t, {
    models: {},
    loseModelAcknowledgement: true,
  });
  const settings = { ...config, endpoint: server.endpoint };
  const client = new HindsightClient(settings);
  const binding = {
    modelId: startupModelId(settings, [identity.scopeTag]),
    tags: [identity.scopeTag],
  };
  const result = await ensureStartupModel(
    client,
    settings,
    binding,
    new AbortController().signal,
  );
  assert.equal(result.state, "existing");
  assert.equal(server.requests.filter((r) => r.method === "POST").length, 1);
});

test("old or trial models are never adopted and another scope cannot be refreshed", async () => {
  let writes = 0;
  const client = {
    getModel: async () => model(),
    createStartupModel: async () => {
      writes++;
      return "x";
    },
    refreshStartupModel: async () => {
      writes++;
      return "x";
    },
  };
  await assert.rejects(
    ensureStartupModel(
      client,
      config,
      { modelId: "scope-core", tags: [identity.scopeTag] },
      new AbortController().signal,
    ),
    /unmanaged-startup-model/,
  );
  const id = startupModelId(config, [identity.scopeTag]);
  client.getModel = async () => model(id, { tags: ["other-scope"] });
  await assert.rejects(
    ensureStartupModel(
      client,
      config,
      { modelId: id, tags: [identity.scopeTag] },
      new AbortController().signal,
      true,
    ),
    /startup-scope-mismatch/,
  );
  assert.equal(writes, 0);
});

test("session reset during model lookup prevents later creation", async () => {
  const pending = deferred<undefined>();
  let writes = 0;
  const settings = {
    ...config,
    startupModels: true,
    outboxPath: "/unused",
    scopeModels: {},
  };
  const runtime = new MemoryRuntime({
    loadConfig: async () => settings,
    resolveIdentity: async () => identity,
    createStartupClient: () => ({
      getModel: () => pending.promise,
      createStartupModel: async () => {
        writes++;
        return "x";
      },
      refreshStartupModel: async () => "x",
    }),
  });
  const request = runtime.initializeStartup(input);
  await new Promise<void>((resolve) => setImmediate(resolve));
  runtime.reset();
  pending.resolve(undefined);
  await assert.rejects(request, /cancelled/);
  assert.equal(writes, 0);
});

test("existing approved private credential file is used without copying its key", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-auth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "client.json"),
    key = "synthetic-file-credential";
  await writeFile(path, JSON.stringify({ apiKey: key }), { mode: 0o600 });
  const server = await fakeServer(t);
  const client = new HindsightClient({
    ...config,
    endpoint: server.endpoint,
    apiKeyFile: path,
  });
  await client.getModel("scope-core", new AbortController().signal);
  assert.equal(server.requests[0]?.authorization, `Bearer ${key}`);
  assert.ok(!client.destinationIdentity.includes(key));
  await writeFile(
    path,
    JSON.stringify({
      apiKey: key,
      apiUrl: "https://different.example",
      bankId: config.bankId,
    }),
  );
  assert.throws(
    () =>
      new HindsightClient({
        ...config,
        endpoint: server.endpoint,
        apiKeyFile: path,
      }),
    /credential-destination-mismatch/,
  );
  await chmod(path, 0o644);
  assert.throws(
    () => new HindsightClient({ ...config, apiKeyFile: path }),
    /unsafe-credential-file/,
  );
});
