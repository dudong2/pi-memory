import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { completedConversation, registerMemory } from "../src/index.ts";
import { MemoryRuntime } from "../src/runtime.ts";
import { config, deferred, fakeServer, identity } from "./helpers.ts";

async function fixture(
  t: TestContext,
  options?: Parameters<typeof fakeServer>[1],
) {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-integration-"));
  const server = await fakeServer(t, options);
  const settings = {
    ...config,
    endpoint: server.endpoint,
    outboxPath: join(root, "queue.sqlite"),
  };
  const memory = new MemoryRuntime({
    loadConfig: async () => settings,
    resolveIdentity: async () => identity,
  });
  t.after(async () => {
    await memory.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const input = {
    cwd: identity.root,
    sessionId: "test-session",
    prompt: "fix UI",
  };
  return { root, server, settings, memory, input };
}

test("real HTTP path connects read -> remember -> confirmation -> correction -> retraction", async (t) => {
  const { memory, input, server, settings } = await fixture(t);
  const read = await memory.prepare(input);
  assert.equal(read?.status, "ready");
  const saved = await memory.remember({
    ...input,
    key: "one",
    kind: "remember",
    text: "Use the deployed test environment",
  });
  assert.ok(saved);
  assert.equal(saved.state, "queued");
  const status = await memory.status(input);
  assert.equal("confirmed" in status && status.confirmed, 1);
  const corrected = await memory.remember({
    ...input,
    key: "two",
    kind: "correct",
    documentId: saved.documentId,
    text: "Use the approved staging environment",
  });
  assert.equal(corrected?.documentId, saved.documentId);
  await memory.status(input);
  await memory.remember({
    ...input,
    key: "three",
    kind: "retract",
    documentId: saved.documentId,
    text: "The old staging restriction is withdrawn",
  });
  await memory.status(input);
  assert.equal(server.retained.length, 3);
  assert.equal(
    new Set(server.retained.map((request) => request.items[0]?.document_id))
      .size,
    1,
  );
  assert.match(server.retained[1]?.items[0]?.content ?? "", /USER CORRECTION/);
  assert.match(server.retained[2]?.items[0]?.content ?? "", /USER RETRACTION/);
  for (const request of server.retained) {
    assert.equal(request.async, true);
    assert.deepEqual(request.items[0]?.tags, [identity.scopeTag]);
    assert.equal(request.items[0]?.update_mode, "replace");
    assert.equal(request.items[0]?.metadata.source_role, "user");
  }
  const sql = new DatabaseSync(settings.outboxPath, { readOnly: true });
  try {
    assert.ok(
      sql
        .prepare("SELECT payload FROM deliveries")
        .all()
        .every((row) => row.payload === null),
    );
  } finally {
    sql.close();
  }
});

test("HTTP acknowledgement loss is recovered by operation ID without another retain", async (t) => {
  const { memory, input, server, settings } = await fixture(t, {
    loseRetainAcknowledgement: true,
  });
  await memory.remember({
    ...input,
    key: "lost-ack",
    kind: "remember",
    text: "A durable user preference",
  });
  const first = await memory.status(input);
  assert.equal("queued" in first && first.queued, 1);
  const sql = new DatabaseSync(settings.outboxPath);
  try {
    sql.exec("UPDATE deliveries SET next_attempt=0");
  } finally {
    sql.close();
  }
  const second = await memory.status(input);
  assert.equal("confirmed" in second && second.confirmed, 1);
  assert.equal(server.retained.length, 1);
  assert.equal(
    server.requests.filter(
      (request) =>
        request.method === "POST" && request.url.endsWith("/memories"),
    ).length,
    1,
  );
});

test("pending user updates are visible without blocking ordinary Recall", async (t) => {
  const { memory, input } = await fixture(t, { operationStatus: "processing" });
  await memory.remember({
    ...input,
    key: "pending-rule",
    kind: "remember",
    text: "A new user instruction",
  });
  const result = await memory.prepare(input);
  assert.equal(result?.status, "ready");
  if (result?.status === "ready") {
    assert.equal(result.context.core[1]?.status, "updates-pending");
    assert.match(result.context.text, /source-session/);
    assert.doesNotMatch(
      result.context.text,
      /Verify UI on the deployed Test URL, not localhost/,
    );
  }
});

test("explicit common memory is opt-in and never inferred from another scope", async (t) => {
  const { memory, input, server } = await fixture(t);
  await memory.remember({
    ...input,
    key: "common",
    kind: "remember",
    scope: "common",
    text: "Reply briefly",
  });
  await memory.status(input);
  assert.deepEqual(server.retained[0]?.items[0]?.tags, ["user:test"]);
  assert.equal(server.retained[0]?.items[0]?.metadata.scope_type, "common");
});

test("secret memory text cannot reach HTTP or the persisted payload", async (t) => {
  const { memory, input, server, settings } = await fixture(t);
  const secret = `sk-${"x".repeat(32)}`;
  await assert.rejects(
    memory.remember({
      ...input,
      key: "secret",
      kind: "remember",
      text: secret,
    }),
    /secret-blocked/,
  );
  assert.equal(server.requests.length, 0);
  const sql = new DatabaseSync(settings.outboxPath, { readOnly: true });
  try {
    assert.equal(
      sql.prepare("SELECT count(*) AS count FROM deliveries").get()?.count,
      0,
    );
  } finally {
    sql.close();
  }
});

test("another scope or a legacy document cannot be corrected through the new tool", async (t) => {
  const { memory, input, server, settings } = await fixture(t);
  await assert.rejects(
    memory.remember({
      ...input,
      key: "legacy",
      kind: "correct",
      documentId: "old-extension-document",
      text: "changed",
    }),
    /unsupported-document/,
  );
  const saved = await memory.remember({
    ...input,
    key: "saved",
    kind: "remember",
    text: "one scope only",
  });
  assert.ok(saved);
  await memory.status(input);
  const other = new MemoryRuntime({
    loadConfig: async () => settings,
    resolveIdentity: async () => ({
      ...identity,
      scopeId: "other",
      scopeTag: "scope:other",
    }),
  });
  t.after(() => other.shutdown());
  await assert.rejects(
    other.remember({
      ...input,
      key: "wrong",
      kind: "correct",
      documentId: saved.documentId,
      text: "changed",
    }),
    /unsupported-document/,
  );
  assert.equal(server.retained.length, 1);
});

test("late write binding is cancelled before enqueue after a session reset", async (t) => {
  const { settings, input, server } = await fixture(t);
  const entered = deferred<void>(),
    gate = deferred<typeof identity>();
  const memory = new MemoryRuntime({
    loadConfig: async () => settings,
    resolveIdentity: async () => {
      entered.resolve();
      return gate.promise;
    },
  });
  t.after(() => memory.shutdown());
  const pending = memory.remember({
    ...input,
    key: "late",
    kind: "remember",
    text: "OLD_SESSION_DATA",
  });
  await entered.promise;
  memory.reset();
  gate.resolve(identity);
  await assert.rejects(pending, /cancelled/);
  assert.equal(server.requests.length, 0);
});

test("read-only configuration never enables automatic writes", async () => {
  const memory = new MemoryRuntime({
    loadConfig: async () => config,
    resolveIdentity: async () => identity,
  });
  const input = { cwd: identity.root, sessionId: "session", prompt: "" };
  assert.equal(
    await memory.remember({
      ...input,
      key: "turn",
      kind: "conversation",
      text: "{}",
    }),
    undefined,
  );
  await assert.rejects(
    memory.remember({
      ...input,
      key: "explicit",
      kind: "remember",
      text: "test",
    }),
    /delivery-disabled/,
  );
  await memory.shutdown();
});

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
function harness(memory: MemoryRuntime) {
  const handlers = new Map<string, Handler>();
  let tool: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
  const pi = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
      return () => {};
    },
    registerTool: (value: Parameters<ExtensionAPI["registerTool"]>[0]) => {
      tool = value;
    },
  };
  const branch: unknown[] = [];
  const context = {
    cwd: identity.root,
    hasUI: false,
    tools: [],
    executeTool: async () => {
      throw new Error("nested tools are not part of this harness");
    },
    sessionManager: { getSessionId: () => "session", getBranch: () => branch },
  } as unknown as ExtensionToolContext;
  registerMemory(pi as unknown as ExtensionAPI, memory);
  return {
    branch,
    context,
    get tool() {
      assert.ok(tool);
      return tool;
    },
    emit: (name: string, event: unknown) =>
      handlers.get(name)?.(event, context),
  };
}

test("settled conversation is retained once with user/assistant attribution and no tool output", async (t) => {
  const { memory, input, server } = await fixture(t),
    h = harness(memory);
  h.branch.push(
    {
      type: "message",
      id: "u",
      message: { role: "user", content: "Please consider the design" },
    },
    {
      type: "message",
      id: "tool",
      message: { role: "toolResult", content: "PRIVATE_TOOL_OUTPUT" },
    },
    {
      type: "message",
      id: "a",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [
          { type: "text", text: "I propose a design, not yet approved" },
          { type: "thinking", thinking: "PRIVATE_THINKING" },
        ],
      },
    },
  );
  await h.emit("agent_settled", { aborted: false });
  await memory.status(input);
  await h.emit("agent_settled", { aborted: false });
  await memory.status(input);
  assert.equal(server.retained.length, 1);
  const retained = server.retained[0]?.items[0];
  assert.equal(retained?.metadata.kind, "conversation");
  assert.match(retained?.content ?? "", /not user approval/);
  assert.doesNotMatch(
    retained?.content ?? "",
    /PRIVATE_TOOL_OUTPUT|PRIVATE_THINKING/,
  );
  assert.deepEqual(retained?.tags, [identity.scopeTag]);
});

test("aborted conversations and unapproved Reflect do not call the backend", async (t) => {
  const { memory, server } = await fixture(t),
    h = harness(memory);
  h.branch.push({
    type: "message",
    id: "u",
    message: { role: "user", content: "question" },
  });
  assert.equal(completedConversation(h.context), undefined);
  await h.emit("agent_settled", { aborted: true });
  await assert.rejects(
    h.tool.execute(
      "reflect",
      { action: "reflect", query: "complex investigation" },
      undefined,
      undefined,
      h.context,
    ),
    /reflect-not-approved/,
  );
  await assert.rejects(
    h.tool.execute(
      "refresh",
      { action: "refresh" },
      undefined,
      undefined,
      h.context,
    ),
    /refresh-not-approved/,
  );
  assert.equal(server.requests.length, 0);
});

test("approved Reflect uses the same exact scope boundary through the real HTTP client", async (t) => {
  const { memory, server } = await fixture(t),
    h = harness(memory);
  let confirmations = 0;
  const approved = {
    ...h.context,
    hasUI: true,
    ui: {
      confirm: async () => {
        confirmations++;
        return true;
      },
    },
  } as unknown as ExtensionToolContext;
  const result = await h.tool.execute(
    "reflect-approved",
    { action: "reflect", query: "Compare the previous decisions" },
    undefined,
    undefined,
    approved,
  );
  assert.equal(confirmations, 1);
  assert.match(JSON.stringify(result.content), /source-fact/);
  const request = server.requests.find((value) =>
    value.url.endsWith("/reflect"),
  );
  assert.ok(request);
  assert.deepEqual((request.body as { tag_groups: unknown }).tag_groups, [
    {
      or: [
        { tags: ["user:test"], match: "exact" },
        { tags: [identity.scopeTag], match: "exact" },
      ],
    },
  ]);
});

test("registered tool can remember and search through the real runtime and fake HTTP", async (t) => {
  const { memory, input, server } = await fixture(t),
    h = harness(memory);
  await h.tool.execute(
    "memory-call",
    { action: "remember", text: "A durable user preference" },
    undefined,
    undefined,
    h.context,
  );
  await memory.status(input);
  const searched = await h.tool.execute(
    "search-call",
    { action: "search", query: "testing rule" },
    undefined,
    undefined,
    h.context,
  );
  assert.match(JSON.stringify(searched.content), /deployed Test URL/);
  assert.equal(server.retained.length, 1);
});
