import assert from "node:assert/strict";
import test from "node:test";
import { HindsightReader } from "../src/client.ts";
import { prepareContext, recallRequest } from "../src/context.ts";
import {
  config,
  deferred,
  fact,
  fakeServer,
  identity,
  model,
} from "./helpers.ts";

const signal = () => new AbortController().signal;

test("fake HTTP server verifies real v1.1.0 paths, model IDs, and exact recall filters", async (t) => {
  const server = await fakeServer(t);
  const settings = { ...config, endpoint: server.endpoint };
  const reader = new HindsightReader(settings);
  const result = await prepareContext(
    reader,
    settings,
    identity,
    "Fix and test UI",
    undefined,
    signal(),
  );
  assert.equal(result.core[0]?.status, "ready");
  assert.equal(result.recall, "found");
  assert.equal(server.requests.length, 2);
  assert.ok(
    server.requests.some(
      (request) =>
        request.url ===
        "/v1/default/banks/test-bank/mental-models/scope-core?detail=full",
    ),
  );
  const recall = server.requests.find((request) => request.method === "POST");
  assert.deepEqual(
    recall?.body,
    recallRequest(settings, identity, "Fix and test UI"),
  );
  assert.match(result.text, /raw-fact/);
  assert.match(result.text, /source-session/);
  assert.ok(
    server.requests.every(
      (request) =>
        request.method === "GET" || request.url.endsWith("/memories/recall"),
    ),
  );
});

test("404 core is missing, while 503 recall is unavailable and server error text is not exposed", async (t) => {
  const server = await fakeServer(t, {
    models: {},
    recallStatus: 503,
    recallBody: { detail: "PRIVATE_SERVER_ERROR" },
  });
  const settings = { ...config, endpoint: server.endpoint };
  const result = await prepareContext(
    new HindsightReader(settings),
    settings,
    identity,
    "question",
    undefined,
    signal(),
  );
  assert.equal(result.core[0]?.status, "missing");
  assert.equal(result.recall, "unavailable");
  assert.doesNotMatch(result.text, /PRIVATE_SERVER_ERROR/);
});

test("malformed recall is not treated as no memories", async (t) => {
  const server = await fakeServer(t, {
    recallBody: { status: "OK but no results array" },
  });
  const settings = { ...config, endpoint: server.endpoint };
  await assert.rejects(
    new HindsightReader(settings).recall(
      recallRequest(settings, identity, "question"),
      signal(),
    ),
    /invalid-response/,
  );
});

test("result without tags is rejected rather than accepted as shared memory", async (t) => {
  const { tags: _tags, ...untagged } = fact();
  const server = await fakeServer(t, { facts: [untagged] });
  const settings = { ...config, endpoint: server.endpoint };
  await assert.rejects(
    new HindsightReader(settings).recall(
      recallRequest(settings, identity, "question"),
      signal(),
    ),
    /invalid-tags/,
  );
});

test("authorization comes only from a named environment variable and is never returned", async (t) => {
  const server = await fakeServer(t);
  const settings = {
    ...config,
    endpoint: server.endpoint,
    apiKeyEnv: "TEST_MEMORY_API_KEY",
  };
  assert.throws(() => new HindsightReader(settings, {}), /invalid-data/);
  const reader = new HindsightReader(settings, {
    TEST_MEMORY_API_KEY: "synthetic-test-credential",
  });
  const result = await reader.getModel("scope-core", signal());
  assert.equal(
    server.requests[0]?.authorization,
    "Bearer synthetic-test-credential",
  );
  assert.doesNotMatch(JSON.stringify(result), /synthetic-test-credential/);
});

test("model ID and bank ID are encoded as path segments", async (t) => {
  const server = await fakeServer(t, {
    models: { "id/with space": model("id/with space") },
  });
  const reader = new HindsightReader({
    ...config,
    endpoint: server.endpoint,
    bankId: "bank/with space",
  });
  await reader.getModel("id/with space", signal());
  assert.equal(
    server.requests[0]?.url,
    "/v1/default/banks/bank%2Fwith%20space/mental-models/id%2Fwith%20space?detail=full",
  );
});

test("bounded HTTP timeout does not wait forever or expose raw transport errors", async (t) => {
  const gate = deferred<void>();
  t.after(() => gate.resolve());
  const server = await fakeServer(t, { beforeReply: () => gate.promise });
  const reader = new HindsightReader({
    ...config,
    endpoint: server.endpoint,
    timeoutMs: 20,
  });
  await assert.rejects(
    reader.getModel("scope-core", signal()),
    /Memory unavailable: timeout/,
  );
});

test("caller abort cancels a pending HTTP request", async (t) => {
  const arrived = deferred<void>();
  const gate = deferred<void>();
  t.after(() => gate.resolve());
  const server = await fakeServer(t, {
    beforeReply: () => {
      arrived.resolve();
      return gate.promise;
    },
  });
  const reader = new HindsightReader({ ...config, endpoint: server.endpoint });
  const controller = new AbortController();
  const request = reader.getModel("scope-core", controller.signal);
  await arrived.promise;
  controller.abort();
  await assert.rejects(request, /Memory unavailable: cancelled/);
});

test("redirects cannot forward queries or authorization to another endpoint", async (t) => {
  const destination = await fakeServer(t);
  const origin = await fakeServer(t, { redirect: destination.endpoint });
  const reader = new HindsightReader(
    { ...config, endpoint: origin.endpoint, apiKeyEnv: "TEST_MEMORY_API_KEY" },
    { TEST_MEMORY_API_KEY: "synthetic-test-credential" },
  );
  await assert.rejects(
    reader.getModel("scope-core", signal()),
    /request-failed/,
  );
  assert.equal(origin.requests.length, 1);
  assert.equal(destination.requests.length, 0);
});

test("oversized backend response is bounded before JSON decoding", async (t) => {
  const server = await fakeServer(t, {
    models: {
      "scope-core": model("scope-core", { content: "x".repeat(1_048_577) }),
    },
  });
  const reader = new HindsightReader({ ...config, endpoint: server.endpoint });
  await assert.rejects(
    reader.getModel("scope-core", signal()),
    /response-too-large/,
  );
});
