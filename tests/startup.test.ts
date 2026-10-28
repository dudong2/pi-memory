import assert from "node:assert/strict";
import test from "node:test";
import { prepareContext } from "../src/context.ts";
import { config, fact, identity, model } from "./helpers.ts";

const signal = () => new AbortController().signal;

test("designated plain-text startup notes work when Recall is empty", async () => {
  const result = await prepareContext(
    {
      getModel: async (id) =>
        model(id, {
          content:
            id === "user-core"
              ? "Reply concisely in Korean."
              : "Test using the deployed site in the local browser.",
        }),
      recall: async () => [],
    },
    config,
    identity,
    "fix UI",
    undefined,
    signal(),
  );
  assert.deepEqual(
    result.core.map((item) => item.status),
    ["ready"],
  );
  assert.match(result.text, /deployed site in the local browser/);
  assert.equal(result.recall, "empty");
});

test("an oversized overview do not evict fitting Recall evidence", async () => {
  const result = await prepareContext(
    {
      getModel: async (id) =>
        model(id, { content: "historical overview ".repeat(15000) }),
      recall: async () => [fact({ text: "CURRENT_SOURCE_EVIDENCE" })],
    },
    { ...config, maxContextBytes: 2048 },
    identity,
    "code work",
    undefined,
    signal(),
  );
  assert.ok(result.core.every((item) => item.status === "budget-exceeded"));
  assert.match(result.text, /CURRENT_SOURCE_EVIDENCE/);
  assert.equal(result.omitted, 0);
});

test("a missing or stale core never blocks ordinary scoped Recall", async () => {
  for (const missing of [true, false]) {
    const result = await prepareContext(
      {
        getModel: async (id) =>
          missing
            ? undefined
            : model(id, { is_stale: true, content: "OLD_RULE" }),
        recall: async () => [fact({ text: "SCOPED_DETAIL" })],
      },
      config,
      identity,
      "code work",
      undefined,
      signal(),
    );
    assert.equal(result.core[0]?.status, missing ? "missing" : "stale");
    assert.match(result.text, /SCOPED_DETAIL/);
    assert.doesNotMatch(result.text, /OLD_RULE/);
  }
});
