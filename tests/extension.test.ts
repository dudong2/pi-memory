import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { previousUserRequest, registerMemory } from "../src/index.ts";
import { MemoryRuntime } from "../src/runtime.ts";
import type { Fact } from "../src/contracts.ts";
import {
  config,
  deferred,
  fact,
  fakeServer,
  identity,
  model,
} from "./helpers.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function harness(runtime: MemoryRuntime) {
  const handlers = new Map<string, Handler>();
  const pi = {
    registerTool: () => {},
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
      return () => {};
    },
  };
  let sessionId = "session-one";
  const branch: unknown[] = [];
  const ctx = {
    cwd: "/fixture",
    sessionManager: { getSessionId: () => sessionId, getBranch: () => branch },
  } as unknown as ExtensionContext;
  registerMemory(pi as unknown as ExtensionAPI, runtime);
  return {
    ctx,
    branch,
    changeSession: () => {
      sessionId = "session-two";
    },
    emit: async (event: string, value: unknown = {}) =>
      handlers.get(event)?.(value, ctx),
  };
}

const userEvent = (prompt: string) => ({ messageType: "user", prompt });
function reference(result: unknown) {
  const message = (
    result as
      | {
          message?: { customType: string; content: string; display: boolean };
        }
      | undefined
  )?.message;
  assert.ok(message);
  assert.equal(message.customType, "pi-memory-reference");
  assert.equal(message.display, false);
  return message;
}

function runtime() {
  return new MemoryRuntime({
    loadConfig: async () => config,
    resolveIdentity: async () => identity,
    createReader: () => ({
      getModel: async (id) => model(id),
      recall: async () => [fact()],
    }),
  });
}

function pendingRecall() {
  const entered = deferred<void>();
  const gate = deferred<Fact[]>();
  const h = harness(
    new MemoryRuntime({
      loadConfig: async () => config,
      resolveIdentity: async () => identity,
      createReader: () => ({
        getModel: async (id) => model(id),
        recall: () => {
          entered.resolve();
          return gate.promise;
        },
      }),
    }),
  );
  return { h, entered, gate };
}

test("extension factory and session_start never contact Hindsight", async () => {
  let loads = 0;
  const h = harness(
    new MemoryRuntime({
      loadConfig: async () => {
        loads++;
        return undefined;
      },
    }),
  );
  assert.equal(loads, 0);
  await h.emit("session_start");
  assert.equal(loads, 1);
  assert.equal(
    await h.emit("before_agent_start", userEvent("question")),
    undefined,
  );
  assert.equal(loads, 2);
});

test("a user turn receives a hidden memory reference with source evidence", async () => {
  const h = harness(runtime());
  const message = reference(
    await h.emit("before_agent_start", userEvent("fix UI")),
  );
  assert.match(message.content, /deployed Test URL/);
  assert.match(message.content, /source-session/);
});

test("a session or cwd change during recall prevents a stale reference from being returned", async () => {
  for (const change of ["session", "cwd"]) {
    const { h, entered, gate } = pendingRecall();
    const pending = h.emit("before_agent_start", userEvent("fix UI"));
    await entered.promise;
    if (change === "session") h.changeSession();
    else h.ctx.cwd = "/other";
    gate.resolve([fact({ text: "ABANDONED_FACT" })]);
    assert.equal(await pending, undefined);
  }
});

test("tree navigation, shutdown, switching and forking cancel an in-flight reference", async () => {
  for (const event of [
    "session_tree",
    "session_shutdown",
    "session_before_switch",
    "session_before_fork",
  ]) {
    const { h, entered, gate } = pendingRecall();
    const pending = h.emit("before_agent_start", userEvent("fix UI"));
    await entered.promise;
    await h.emit(event);
    gate.resolve([fact({ text: "ABANDONED_FACT" })]);
    assert.equal(await pending, undefined);
  }
});

test("late recall after shutdown cannot return data to a new session", async () => {
  const { h, entered, gate } = pendingRecall();
  const pending = h.emit("before_agent_start", userEvent("fix UI"));
  await entered.promise;
  await h.emit("session_shutdown");
  h.changeSession();
  gate.resolve([fact({ text: "ABANDONED_FACT" })]);
  assert.equal(await pending, undefined);
});

test("cancellation during recall returns no new memory message", async () => {
  const { h, entered, gate } = pendingRecall();
  const controller = new AbortController();
  Object.assign(h.ctx, { signal: controller.signal });
  const pending = h.emit("before_agent_start", userEvent("fix UI"));
  await entered.promise;
  controller.abort();
  gate.resolve([fact({ text: "ABANDONED_FACT" })]);
  assert.equal(await pending, undefined);
});

test("custom-triggered runs neither recall unrelated messages nor return a new reference", async () => {
  let reads = 0;
  const h = harness(
    new MemoryRuntime({
      loadConfig: async () => config,
      resolveIdentity: async () => identity,
      createReader: () => ({
        getModel: async (id) => model(id),
        recall: async () => {
          reads++;
          return [fact()];
        },
      }),
    }),
  );
  reference(await h.emit("before_agent_start", userEvent("question")));
  assert.equal(
    await h.emit("before_agent_start", {
      messageType: "custom",
      message: { content: "not a user query" },
    }),
    undefined,
  );
  assert.equal(reads, 1);
});

test("follow-up context comes only from the nearest user request on the active branch", () => {
  const h = harness(runtime());
  h.branch.push(
    {
      type: "message",
      message: { role: "user", content: "UI testing environment" },
    },
    {
      type: "message",
      message: { role: "assistant", content: "UNAPPROVED_PROPOSAL" },
    },
    {
      type: "message",
      message: { role: "toolResult", content: "PRIVATE_TOOL_OUTPUT" },
    },
    {
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "Use the previous method" }],
      },
    },
  );
  assert.equal(
    previousUserRequest(h.ctx, "Use the previous method"),
    "UI testing environment",
  );
});

test("HTTP-to-Pi lifecycle harness passes a follow-up and preserves source evidence", async (t) => {
  const server = await fakeServer(t);
  const h = harness(
    new MemoryRuntime({
      loadConfig: async () => ({ ...config, endpoint: server.endpoint }),
      resolveIdentity: async () => identity,
    }),
  );
  h.branch.push({
    type: "message",
    message: { role: "user", content: "UI testing environment" },
  });
  await h.emit("session_start");
  const message = reference(
    await h.emit("before_agent_start", userEvent("Use the previous method")),
  );
  assert.match(message.content, /source-session/);
  const request = server.requests.find((row) => row.method === "POST");
  assert.match(JSON.stringify(request?.body), /UI testing environment/);
  assert.match(JSON.stringify(request?.body), /Use the previous method/);
});
