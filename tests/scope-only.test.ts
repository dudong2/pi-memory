import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../src/config.ts";
import { prepareContext, recallRequest } from "../src/context.ts";
import { MemoryRuntime, type WriteInput } from "../src/runtime.ts";
import { config, identity, model } from "./helpers.ts";

test("removed common configuration is rejected rather than silently ignored", () => {
  assert.throws(
    () =>
      parseConfig({
        ...config,
        common: { modelId: "legacy-user-core", tags: ["legacy:common"] },
      }),
    /invalid-config/,
  );
});

test("only the current Scope is queried and its model is loaded", async () => {
  const request = recallRequest(config, identity, "question");
  assert.deepEqual(request.tag_groups, [
    { or: [{ tags: [identity.scopeTag], match: "exact" }] },
  ]);
  const ids: string[] = [];
  const result = await prepareContext(
    {
      getModel: async (id) => {
        ids.push(id);
        return model(id);
      },
      recall: async () => [],
    },
    config,
    identity,
    "question",
    undefined,
    new AbortController().signal,
  );
  assert.deepEqual(ids, ["scope-core"]);
  assert.deepEqual(
    result.core.map((item) => item.kind),
    ["scope"],
  );
});

test("legacy write scope arguments fail at the runtime boundary before any backend work", async () => {
  let work = false;
  const runtime = new MemoryRuntime({
    loadConfig: async () => {
      work = true;
      return config;
    },
  });
  await assert.rejects(
    runtime.remember({
      cwd: "/fixture",
      sessionId: "one",
      prompt: "",
      key: "legacy",
      kind: "conversation",
      text: "legacy payload",
      scope: "common",
    } as WriteInput),
    /scope-argument-removed/,
  );
  assert.equal(work, false);
});
