import assert from "node:assert/strict";
import test from "node:test";
import type { MemoryReader } from "../src/contracts.ts";
import { MemoryRuntime } from "../src/runtime.ts";
import { config, deferred, fact, identity, model } from "./helpers.ts";

const input = { cwd: "/fixture", sessionId: "session-one", prompt: "fix UI" };
const reader: MemoryReader = {
  getModel: async (id) => model(id),
  recall: async () => [fact()],
};

function runtime(backend: MemoryReader = reader) {
  return new MemoryRuntime({
    loadConfig: async () => config,
    resolveIdentity: async () => identity,
    createReader: () => backend,
  });
}

test("no configuration means no identity resolution and no backend activity", async () => {
  const memory = new MemoryRuntime({
    loadConfig: async () => undefined,
    resolveIdentity: async () => {
      throw new Error("must not resolve");
    },
    createReader: () => {
      throw new Error("must not construct");
    },
  });
  assert.deepEqual(await memory.prepare(input), { status: "disabled" });
});

test("scope resolution failure is unavailable, with no default/wider search fallback", async () => {
  const memory = new MemoryRuntime({
    loadConfig: async () => config,
    resolveIdentity: async () => {
      throw new Error("private filesystem details");
    },
    createReader: () => {
      throw new Error("must not construct");
    },
  });
  assert.deepEqual(await memory.prepare(input), {
    status: "unavailable",
    code: "read-failed",
  });
});

test("shutdown/reset discards a late recall even when the backend ignores cancellation", async () => {
  const gate = deferred<ReturnType<typeof fact>[]>();
  const entered = deferred<void>();
  const memory = runtime({
    ...reader,
    recall: async () => {
      entered.resolve();
      return gate.promise;
    },
  });
  const pending = memory.prepare(input);
  await entered.promise;
  memory.reset();
  gate.resolve([fact({ text: "OLD_SESSION_FACT" })]);
  assert.equal(await pending, undefined);
});

test("a new scope/session wins over an earlier request that completes later", async () => {
  const gate = deferred<ReturnType<typeof fact>[]>();
  const entered = deferred<void>();
  let calls = 0;
  const memory = runtime({
    ...reader,
    recall: async () => {
      if (++calls === 1) {
        entered.resolve();
        return gate.promise;
      }
      return [fact({ text: "NEW_SESSION_FACT" })];
    },
  });
  const old = memory.prepare(input);
  await entered.promise;
  const current = await memory.prepare({
    ...input,
    cwd: "/other",
    sessionId: "session-two",
  });
  assert.equal(current?.status, "ready");
  if (current?.status === "ready")
    assert.match(current.context.text, /NEW_SESSION_FACT/);
  gate.resolve([fact({ text: "OLD_SESSION_FACT" })]);
  assert.equal(await old, undefined);
});

test("late identity resolution cannot start backend work after a session switch", async () => {
  const gate = deferred<typeof identity>();
  const entered = deferred<void>();
  let created = false;
  const memory = new MemoryRuntime({
    loadConfig: async () => config,
    resolveIdentity: async () => {
      entered.resolve();
      return gate.promise;
    },
    createReader: () => {
      created = true;
      return reader;
    },
  });
  const pending = memory.prepare(input);
  await entered.promise;
  memory.reset();
  gate.resolve(identity);
  assert.equal(await pending, undefined);
  assert.equal(created, false);
});

test("late configuration resolution cannot reinitialize an abandoned run", async () => {
  const gate = deferred<typeof config>();
  let resolved = false;
  const memory = new MemoryRuntime({
    loadConfig: () => gate.promise,
    resolveIdentity: async () => {
      resolved = true;
      return identity;
    },
  });
  const pending = memory.prepare(input);
  memory.reset();
  gate.resolve(config);
  assert.equal(await pending, undefined);
  assert.equal(resolved, false);
});

test("caller cancellation discards results and later requests remain usable", async () => {
  const memory = runtime();
  const controller = new AbortController();
  controller.abort();
  assert.equal(await memory.prepare(input, controller.signal), undefined);
  assert.equal((await memory.prepare(input))?.status, "ready");
});
