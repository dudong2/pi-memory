import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { previousUserRequest, registerMemory } from "../src/index.ts";
import { MemoryRuntime } from "../src/runtime.ts";
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
function messages(
  result: unknown,
): { role: string; customType?: string; content: string }[] {
  return (
    result as {
      messages: { role: string; customType?: string; content: string }[];
    }
  ).messages;
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
  await h.emit("before_agent_start", userEvent("question"));
  assert.equal(loads, 2);
  assert.deepEqual(messages(await h.emit("context", { messages: [] })), []);
});

test("first user prompt injects only request-local data, replacing earlier own references", async () => {
  const h = harness(runtime());
  assert.equal(
    await h.emit("before_agent_start", userEvent("fix UI")),
    undefined,
  );
  const source = [
    { role: "user", content: "fix UI" },
    {
      role: "custom",
      customType: "pi-memory-reference",
      content: "OLD_MEMORY_REFERENCE",
    },
    {
      role: "custom",
      customType: "another-extension",
      content: "preserve this",
    },
  ];
  const result = messages(await h.emit("context", { messages: source }));
  assert.equal(result.length, 3);
  assert.equal(
    result.filter((item) => item.customType === "pi-memory-reference").length,
    1,
  );
  assert.match(result.at(-1)?.content ?? "", /deployed Test URL/);
  assert.equal(source[1]?.content, "OLD_MEMORY_REFERENCE");
  assert.equal(result[1]?.customType, "another-extension");
});

test("scope/cwd or session change prevents the previous reference from entering context", async () => {
  const h = harness(runtime());
  await h.emit("before_agent_start", userEvent("fix UI"));
  h.changeSession();
  assert.deepEqual(messages(await h.emit("context", { messages: [] })), []);
  await h.emit("before_agent_start", userEvent("fix UI again"));
  h.ctx.cwd = "/other";
  assert.deepEqual(messages(await h.emit("context", { messages: [] })), []);
});

test("tree navigation, shutdown, switching and forking invalidate injected reference", async () => {
  for (const event of [
    "session_tree",
    "session_shutdown",
    "session_before_switch",
    "session_before_fork",
  ]) {
    const h = harness(runtime());
    await h.emit("before_agent_start", userEvent("fix UI"));
    await h.emit(event);
    assert.deepEqual(messages(await h.emit("context", { messages: [] })), []);
  }
});

test("late before_agent_start after shutdown does not inject data into a new session", async () => {
  const gate = deferred<ReturnType<typeof fact>[]>();
  const entered = deferred<void>();
  const h = harness(
    new MemoryRuntime({
      loadConfig: async () => config,
      resolveIdentity: async () => identity,
      createReader: () => ({
        getModel: async (id) => model(id),
        recall: async () => {
          entered.resolve();
          return gate.promise;
        },
      }),
    }),
  );
  const pending = h.emit("before_agent_start", userEvent("fix UI"));
  await entered.promise;
  await h.emit("session_shutdown");
  h.changeSession();
  gate.resolve([fact({ text: "ABANDONED_FACT" })]);
  await pending;
  assert.deepEqual(messages(await h.emit("context", { messages: [] })), []);
});

test("custom-triggered runs do not send unrelated messages as a user recall query", async () => {
  const h = harness(runtime());
  await h.emit("before_agent_start", userEvent("question"));
  await h.emit("before_agent_start", {
    messageType: "custom",
    message: { content: "not a user query" },
  });
  assert.deepEqual(messages(await h.emit("context", { messages: [] })), []);
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
  await h.emit("before_agent_start", userEvent("Use the previous method"));
  const result = messages(await h.emit("context", { messages: [] }));
  assert.match(result[0]?.content ?? "", /source-session/);
  const request = server.requests.find((row) => row.method === "POST");
  assert.match(JSON.stringify(request?.body), /UI testing environment/);
  assert.match(JSON.stringify(request?.body), /Use the previous method/);
});
