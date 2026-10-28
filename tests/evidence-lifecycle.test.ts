import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { registerMemory } from "../src/index.ts";
import { MemoryRuntime } from "../src/runtime.ts";
import { parseConfig } from "../src/config.ts";
import { config, fact, identity, model } from "./helpers.ts";

test("evidence configuration is explicit, private-path only and defaults to the approved retention", () => {
  assert.equal(parseConfig(config).evidence, undefined);
  const settings = parseConfig({
    ...config,
    evidence: { directory: "/private/evidence" },
  });
  assert.deepEqual(settings.evidence, {
    directory: "/private/evidence",
    retentionDays: 30,
    maxBytes: 268435456,
  });
  assert.throws(
    () => parseConfig({ ...config, evidence: { directory: "relative" } }),
    /not-absolute/,
  );
  assert.throws(
    () =>
      parseConfig({
        ...config,
        evidence: { directory: "/private/evidence", retentionDays: 0 },
      }),
    /invalid-config/,
  );
});

test("tool memory bodies are archived only once observed in a provider payload; scope arguments and cross-Scope reads remain denied", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-evidence-hooks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settings = {
    ...config,
    evidence: {
      directory: join(root, "evidence"),
      retentionDays: 30,
      maxBytes: 65536,
    },
  };
  let activeIdentity = identity,
    reads = 0;
  const runtime = new MemoryRuntime({
    loadConfig: async () => settings,
    resolveIdentity: async () => activeIdentity,
    createReader: () => ({
      getModel: async (id) => model(id),
      recall: async () => {
        reads++;
        return [fact({ text: "PRIVATE_MEMORY_FIXTURE" })];
      },
    }),
  });
  const handlers = new Map<
    string,
    (event: unknown, ctx: ExtensionContext) => unknown
  >();
  let tool: ToolDefinition | undefined;
  registerMemory(
    {
      on: (
        name: string,
        handler: (event: unknown, ctx: ExtensionContext) => unknown,
      ) => {
        handlers.set(name, handler);
        return () => {};
      },
      registerTool: (definition: ToolDefinition) => {
        tool = definition;
      },
    } as unknown as ExtensionAPI,
    runtime,
    false,
  );
  const ctx = {
    cwd: root,
    hasUI: false,
    signal: new AbortController().signal,
    sessionManager: { getSessionId: () => "session-one", getBranch: () => [] },
  } as unknown as ExtensionToolContext;
  await handlers.get("before_agent_start")?.(
    { messageType: "user", prompt: "PRIVATE_QUERY_FIXTURE" },
    ctx,
  );
  assert.ok(tool);
  const result = await tool.execute(
    "search-one",
    { action: "search", query: "PRIVATE_QUERY_FIXTURE" } as never,
    ctx.signal,
    () => {},
    ctx,
  );
  const text = result.content[0];
  assert.ok(text?.type === "text");
  const input = { cwd: root, sessionId: "session-one", prompt: "" };
  const list = await runtime.readEvidence(input);
  assert.ok(list.requests);
  const requestId = list.requests[0]?.requestId;
  assert.ok(requestId);
  const before = await runtime.readEvidence(input, requestId, 0, 50);
  assert.ok(before.events);
  assert.ok(!JSON.stringify(before.events).includes("PRIVATE_MEMORY_FIXTURE"));
  assert.equal(
    before.events.find((record) => record.type === "lookup-result")?.data
      .snapshot,
    undefined,
  );
  await handlers.get("before_provider_request")?.(
    { payload: { messages: [{ content: text.text }] } },
    ctx,
  );
  const after = await runtime.readEvidence(input, requestId, 0, 50);
  assert.ok(after.events);
  assert.equal(
    after.events.find(
      (record) =>
        record.type === "provider-payload" &&
        record.data.channel === "tool-result",
    )?.data.snapshot,
    text.text,
  );
  assert.ok(!JSON.stringify(after.events).includes("PRIVATE_QUERY_FIXTURE"));
  await assert.rejects(
    tool.execute(
      "legacy",
      { action: "search", query: "unused", scope: "common" } as never,
      ctx.signal,
      () => {},
      ctx,
    ),
    /scope-argument-removed/,
  );
  assert.equal(reads, 2);
  const rejected = await runtime.readEvidence(input, requestId, 0, 50);
  assert.ok(rejected.events);
  assert.equal(rejected.events.at(-1)?.data.state, "failed");
  assert.equal(rejected.events.at(-1)?.data.lookup, undefined);
  activeIdentity = { ...identity, scopeId: "other", scopeTag: "other:scope" };
  const blocked = await runtime.readEvidence(input, requestId);
  assert.ok(blocked.events);
  assert.deepEqual(blocked.events, []);
});
