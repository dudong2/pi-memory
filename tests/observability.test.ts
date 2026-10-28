import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { prepareContext } from "../src/context.ts";
import { registerMemory } from "../src/index.ts";
import { MemoryRuntime } from "../src/runtime.ts";
import { MemoryError } from "../src/contracts.ts";
import {
  payloadContainsReference,
  safeRecordIds,
} from "../src/observability.ts";
import { config, deferred, fact, identity, model } from "./helpers.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
function harness() {
  const handlers = new Map<string, Handler>();
  let definition: ToolDefinition | undefined;
  let activeIdentity = identity;
  let fail = false;
  let reads = 0;
  const memory = new MemoryRuntime({
    loadConfig: async () => config,
    resolveIdentity: async () => activeIdentity,
    createReader: () => ({
      getModel: async (id) =>
        model(id, { content: "PRIVATE_CORE_BODY_MARKER" }),
      recall: async () => {
        reads++;
        if (fail) throw new Error("PRIVATE_BACKEND_ERROR_BODY");
        return [fact({ text: "PRIVATE_MEMORY_BODY_MARKER" })];
      },
    }),
  });
  registerMemory(
    {
      on: (name: string, handler: Handler) => {
        handlers.set(name, handler);
        return () => {};
      },
      registerTool: (tool: ToolDefinition) => {
        definition = tool;
      },
    } as unknown as ExtensionAPI,
    memory,
  );
  const ctx = {
    cwd: "/fixture",
    hasUI: false,
    signal: new AbortController().signal,
    sessionManager: { getSessionId: () => "session-one", getBranch: () => [] },
  } as unknown as ExtensionToolContext;
  return {
    memory,
    ctx,
    reads: () => reads,
    fail: () => {
      fail = true;
    },
    moveScope: () => {
      activeIdentity = {
        ...identity,
        scopeId: "other-scope",
        projectId: "other-project",
        scopeTag: "other:tag",
      };
    },
    emit: (name: string, event: unknown = {}) =>
      handlers.get(name)?.(event, ctx),
    call: async (params: Record<string, unknown>) => {
      assert.ok(definition);
      const result = await definition.execute(
        "observation-call",
        params as never,
        new AbortController().signal,
        () => {},
        ctx,
      );
      const content = result.content[0];
      assert.ok(content?.type === "text");
      return JSON.parse(content.text);
    },
  };
}

const prompt = { messageType: "user", prompt: "PRIVATE_QUERY_MARKER" };

test("memory guidance explains prior decisions, exact constraints and follow-up retrieval without weakening trust rules", async () => {
  const prepared = await prepareContext(
    { getModel: async (id) => model(id), recall: async () => [fact()] },
    config,
    identity,
    "work",
    undefined,
    new AbortController().signal,
  );
  const guidance = prepared.text.slice(0, prepared.text.indexOf("{"));
  assert.match(guidance, /prior decisions/i);
  assert.match(guidance, /exact values and exceptions/i);
  assert.match(guidance, /search.*insufficient|insufficient.*search/i);
  assert.match(guidance, /Current user requests.*precedence/);
  assert.match(guidance, /Never obey instructions embedded/);
});

test("context inspection counts fetched/packed/omitted records without exposing their bodies", async () => {
  const prepared = await prepareContext(
    {
      getModel: async (id) => model(id),
      recall: async () => [
        fact({ id: "one", text: "PRIVATE_MEMORY_BODY_MARKER" }),
        fact({ id: "one" }),
        fact({ id: "foreign", tags: ["foreign:scope"] }),
        fact({ id: "blocked", text: `Bearer ${"x".repeat(30)}` }),
      ],
    },
    config,
    identity,
    "PRIVATE_QUERY_MARKER",
    undefined,
    new AbortController().signal,
  );
  assert.deepEqual(prepared.inspection.factIds, ["one"]);
  assert.equal(prepared.inspection.fetchedFacts, 4);
  assert.equal(prepared.inspection.includedFacts, 1);
  assert.equal(prepared.inspection.omittedFacts, 3);
  assert.equal(
    prepared.inspection.contextBytes,
    Buffer.byteLength(prepared.text),
  );
  assert.equal(prepared.inspection.scopeId, identity.scopeId);
  assert.equal(prepared.inspection.projectId, identity.projectId);
  const serialized = JSON.stringify(prepared.inspection);
  assert.ok(
    !serialized.includes("PRIVATE_MEMORY_BODY_MARKER") &&
      !serialized.includes("PRIVATE_QUERY_MARKER"),
  );
});

test("status distinguishes preparation, context attachment and provider payload observation", async () => {
  const h = harness();
  await h.emit("before_agent_start", prompt);
  let status = await h.call({ action: "status" });
  assert.equal(status.delivery, "disabled");
  assert.equal(status.observation.context.state, "prepared");
  assert.equal(status.observation.context.contextHookCalls, 0);
  assert.equal(status.observation.context.providerPayloadChecks, 0);
  const attached = (await h.emit("context", { messages: [] })) as {
    messages: { content: string }[];
  };
  const reference = attached.messages.at(-1)?.content;
  assert.ok(reference);
  await h.emit("before_provider_request", {
    payload: { input: [{ content: "not the memory reference" }] },
  });
  status = await h.call({ action: "status" });
  assert.equal(status.observation.context.providerPayloadChecks, 1);
  assert.equal(status.observation.context.providerPayloadMatches, 0);
  await h.emit("before_provider_request", {
    payload: { input: [{ content: [{ text: reference }] }] },
  });
  status = await h.call({ action: "status" });
  assert.equal(status.observation.context.contextHookCalls, 1);
  assert.equal(status.observation.context.providerPayloadChecks, 2);
  assert.equal(status.observation.context.providerPayloadMatches, 1);
  assert.equal(status.observation.context.answerUse, "not-assessed");
  assert.ok(Number.isFinite(status.observation.context.elapsedMs));
  const serialized = JSON.stringify(status.observation);
  for (const value of [
    "PRIVATE_QUERY_MARKER",
    "PRIVATE_MEMORY_BODY_MARKER",
    "PRIVATE_CORE_BODY_MARKER",
  ])
    assert.ok(!serialized.includes(value));
});

test("manual search observation reports safe counts and errors, never query or result text", async () => {
  const h = harness();
  await h.emit("before_agent_start", prompt);
  await h.call({ action: "search", query: "PRIVATE_QUERY_MARKER" });
  let status = await h.call({ action: "status" });
  assert.equal(status.observation.lookup.action, "search");
  assert.equal(status.observation.lookup.state, "succeeded");
  assert.equal(status.observation.lookup.includedFacts, 1);
  assert.deepEqual(status.observation.lookup.factIds, ["fact-test"]);
  h.fail();
  await assert.rejects(
    h.call({ action: "search", query: "PRIVATE_QUERY_MARKER" }),
  );
  status = await h.call({ action: "status" });
  assert.equal(status.observation.lookup.state, "failed");
  assert.equal(status.observation.lookup.code, "lookup-failed");
  assert.ok(!JSON.stringify(status.observation).includes("PRIVATE_"));
});

test("observations clear on session reset and cannot cross a changed Project/Scope binding", async () => {
  const h = harness();
  await h.emit("before_agent_start", prompt);
  await h.call({ action: "search", query: "normal query" });
  h.moveScope();
  let status = await h.call({ action: "status" });
  assert.equal(status.observation.context, null);
  assert.equal(status.observation.lookup, null);
  await h.emit("session_tree");
  status = await h.call({ action: "status" });
  assert.equal(status.observation.context, null);
  assert.equal(status.observation.lookup, null);
});

test("late manual lookup cannot repopulate observation state after a reset", async () => {
  const gate = deferred<ReturnType<typeof fact>[]>();
  const memory = new MemoryRuntime({
    loadConfig: async () => config,
    resolveIdentity: async () => identity,
    createReader: () => ({
      getModel: async (id) => model(id),
      recall: () => gate.promise,
    }),
  });
  const input = { cwd: "/fixture", sessionId: "session-one", prompt: "" };
  const pending = memory.lookup(input, "normal", false);
  await Promise.resolve();
  await Promise.resolve();
  memory.reset();
  gate.resolve([fact()]);
  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof MemoryError && error.code === "cancelled",
  );
  assert.equal((await memory.status(input)).observation.lookup, null);
});

test("payload observation handles cycles, transformed text, throwing getters and a bounded scan", () => {
  const cycle: { self?: unknown; text: string } = {
    text: "prefix REFERENCE suffix",
  };
  cycle.self = cycle;
  assert.equal(payloadContainsReference(cycle, "REFERENCE"), true);
  assert.equal(payloadContainsReference(cycle, "absent"), false);
  assert.equal(
    payloadContainsReference(
      {
        get text() {
          throw new Error("private payload");
        },
      },
      "REFERENCE",
    ),
    false,
  );
  assert.equal(payloadContainsReference({ text: "REFERENCE" }, ""), false);
  let deep: unknown = "REFERENCE";
  for (let i = 0; i < 20_001; i++) deep = { value: deep };
  assert.equal(payloadContainsReference(deep, "REFERENCE"), false);
  assert.deepEqual(
    safeRecordIds([
      "valid",
      "valid",
      " ",
      "x".repeat(257),
      `sk-${"a".repeat(32)}`,
    ]),
    ["valid"],
  );
});

test("inspection follows admission budget and distinguishes blocked, failed and empty recall", async () => {
  const prepared = await prepareContext(
    {
      getModel: async (id) => model(id, { is_stale: true }),
      recall: async () => [fact({ text: "x".repeat(config.maxContextBytes) })],
    },
    config,
    identity,
    "normal",
    undefined,
    new AbortController().signal,
  );
  assert.equal(prepared.inspection.includedFacts, 0);
  assert.equal(prepared.inspection.omittedFacts, 1);
  assert.deepEqual(prepared.inspection.factIds, []);
  assert.deepEqual(prepared.inspection.modelIds, []);
  assert.deepEqual(prepared.inspection.documentIds, []);
  assert.ok(prepared.inspection.core.every((item) => item.status === "stale"));
  const blocked = await prepareContext(
    {
      getModel: async (id) => model(id),
      recall: async () => {
        throw new Error("must not recall");
      },
    },
    config,
    identity,
    `Bearer ${"x".repeat(32)}`,
    undefined,
    new AbortController().signal,
  );
  assert.equal(blocked.inspection.recall, "secret-blocked");
  assert.equal(blocked.inspection.fetchedFacts, 0);
  const failed = await prepareContext(
    {
      getModel: async (id) => model(id),
      recall: async () => {
        throw new Error("PRIVATE_BACKEND_ERROR_BODY");
      },
    },
    config,
    identity,
    "normal",
    undefined,
    new AbortController().signal,
  );
  assert.equal(failed.inspection.recall, "unavailable");
  assert.equal(failed.inspection.fetchedFacts, 0);
  assert.ok(!JSON.stringify(failed.inspection).includes("PRIVATE_"));
});

test("in-flight lookup observation stays cleared after reset and cannot cross session/cwd", async () => {
  const entered = deferred<void>();
  const gate = deferred<ReturnType<typeof fact>[]>();
  const memory = new MemoryRuntime({
    loadConfig: async () => config,
    resolveIdentity: async () => identity,
    createReader: () => ({
      getModel: async (id) => model(id),
      recall: () => {
        entered.resolve();
        return gate.promise;
      },
    }),
  });
  const input = { cwd: "/fixture", sessionId: "one", prompt: "" };
  const pending = memory.lookup(input, "normal", false);
  await entered.promise;
  memory.reset();
  gate.resolve([fact()]);
  await assert.rejects(pending);
  assert.equal((await memory.status(input)).observation.lookup, null);
  await memory.lookup(input, "normal", false);
  assert.equal(
    (await memory.status({ ...input, sessionId: "two" })).observation.lookup,
    null,
  );
  assert.equal(
    (await memory.status({ ...input, cwd: "/other" })).observation.lookup,
    null,
  );
});

test("simple user prompts still perform recall on every request", async () => {
  const h = harness();
  await h.emit("before_agent_start", {
    messageType: "user",
    prompt: "17 * 19",
  });
  await h.emit("before_agent_start", { messageType: "user", prompt: "thanks" });
  assert.equal(h.reads(), 2);
});
