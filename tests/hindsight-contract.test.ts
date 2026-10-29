import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { HindsightReader } from "../src/client.ts";
import { recallRequest, prepareContext } from "../src/context.ts";
import { registerMemory } from "../src/index.ts";
import { MemoryRuntime } from "../src/runtime.ts";
import { startupModelId } from "../src/startup.ts";
import { assertContract } from "./hindsight-contract.ts";
import {
  config,
  identity,
  fact,
  fakeServer,
  model,
  deferred,
} from "./helpers.ts";

export const sourceFact = {
  ...fact(),
  context:
    "Approved staging maintenance; production requires a separate decision.",
  occurred_start: "2026-10-20T09:00:00Z",
  occurred_end: "2026-10-20T10:00:00Z",
  chunk_id: "source-chunk-7",
};

test("v1.1 Recall context, event times and chunk provenance survive client and context projection", async (t) => {
  const server = await fakeServer(t, { facts: [sourceFact] });
  const settings = { ...config, endpoint: server.endpoint };
  assertContract(
    "RecallRequest",
    recallRequest(settings, identity, "maintenance"),
  );
  assertContract("RecallResponse", { results: [sourceFact] });
  const reader = new HindsightReader(settings);
  assert.deepEqual(
    await reader.recall(
      recallRequest(settings, identity, "maintenance"),
      new AbortController().signal,
    ),
    [sourceFact],
  );
  const context = await prepareContext(
    reader,
    settings,
    identity,
    "maintenance",
    undefined,
    new AbortController().signal,
  );
  for (const value of [
    sourceFact.context,
    sourceFact.occurred_start,
    sourceFact.occurred_end,
    sourceFact.chunk_id,
  ])
    assert.ok(context.text.includes(value));
});

test("new Recall provenance fields still pass the shared secret guard", async (t) => {
  const secret = "sk-" + "a".repeat(32);
  const server = await fakeServer(t, {
    facts: [{ ...sourceFact, context: secret }],
  });
  const settings = { ...config, endpoint: server.endpoint };
  const result = await prepareContext(
    new HindsightReader(settings),
    settings,
    identity,
    "maintenance",
    undefined,
    new AbortController().signal,
  );
  assert.ok(!result.text.includes(secret));
  assert.ok(!result.text.includes(sourceFact.id));
});

test("a reset during startup status lookup discards the response before reading the operation", async (t) => {
  const arrived = deferred<void>(),
    gate = deferred<void>();
  const server = await fakeServer(t, {
    beforeReply: () => {
      arrived.resolve();
      return gate.promise;
    },
  });
  const settings = { ...config, endpoint: server.endpoint };
  const memory = new MemoryRuntime({
    loadConfig: async () => settings,
    resolveIdentity: async () => identity,
  });
  t.after(async () => {
    gate.resolve();
    await memory.shutdown();
  });
  const pending = memory.status(
    { cwd: identity.root, sessionId: "status-reset", prompt: "" },
    undefined,
    randomUUID(),
  );
  await arrived.promise;
  memory.reset();
  gate.resolve();
  await assert.rejects(pending, /cancelled/);
  assert.equal(server.requests.length, 1);
  assert.ok(!server.requests[0]?.url.includes("/operations/"));
});

for (const foreign of [false, true]) {
  test(`startup operation status is queryable only for the current Scope (foreign=${foreign})`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-memory-job-contract-"));
    const models: Record<string, unknown> = {};
    const server = await fakeServer(t, { models });
    const settings = {
      ...config,
      endpoint: server.endpoint,
      scopeModels: {},
      startupModels: true,
      outboxPath: join(root, "outbox.sqlite"),
    };
    const modelId = startupModelId(settings, [identity.scopeTag]);
    models[modelId] = { ...model(modelId), name: "Scope startup" };
    const runtime = new MemoryRuntime({
      loadConfig: async () => settings,
      resolveIdentity: async () => identity,
    });
    t.after(async () => {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    });
    let tool: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
    registerMemory(
      {
        on: () => () => {},
        registerTool: (value: Parameters<ExtensionAPI["registerTool"]>[0]) => {
          tool = value;
        },
      } as unknown as ExtensionAPI,
      runtime,
      false,
    );
    assert.ok(tool);
    const ctx = {
      cwd: identity.root,
      hasUI: false,
      sessionManager: {
        getSessionId: () => "scope-contract",
        getBranch: () => [],
      },
    } as unknown as ExtensionToolContext;
    const invoke = async (params: Record<string, unknown>) => {
      assert.ok(tool);
      const result = await tool.execute(
        "contract",
        params,
        undefined,
        undefined,
        ctx,
      );
      const part = result.content[0];
      assert.ok(part?.type === "text");
      return JSON.parse(part.text);
    };
    let operationId: string;
    if (foreign) {
      operationId = randomUUID();
      server.operations.set(operationId, "completed");
      server.operationModels.set(operationId, "other-scope-model");
      await assert.rejects(
        invoke({ action: "status", operationId }),
        /operation-scope-mismatch/,
      );
    } else {
      const receipt = await invoke({ action: "refresh" });
      operationId = receipt[0].operationId;
      const pending = await invoke({ action: "status", operationId });
      assert.deepEqual(pending.startupOperation, {
        operationId,
        modelId,
        state: "processing",
      });
      server.operations.set(operationId, "completed");
      const completed = await invoke({ action: "status", operationId });
      assert.deepEqual(completed.startupOperation, {
        operationId,
        modelId,
        state: "completed",
      });
      const restarted = new MemoryRuntime({
        loadConfig: async () => settings,
        resolveIdentity: async () => identity,
      });
      try {
        const state = await restarted.status(
          { cwd: identity.root, sessionId: "restarted", prompt: "" },
          undefined,
          operationId,
        );
        assert.equal(state.startupOperation?.state, "completed");
      } finally {
        await restarted.shutdown();
      }
      const missing = await invoke({
        action: "status",
        operationId: randomUUID(),
      });
      assert.equal(missing.startupOperation.state, "not_found");
      await assert.rejects(
        invoke({ action: "status", operationId: "not-an-operation" }),
        /invalid-operation-id/,
      );
      models[modelId] = {
        ...model(modelId, { tags: ["other-scope"] }),
        name: "Other Scope",
      };
      await assert.rejects(
        invoke({ action: "status", operationId }),
        /startup-scope-mismatch/,
      );
    }
    assert.ok(
      server.requests.every(
        (request) => !request.url.includes("include_payload"),
      ),
    );
  });
}
