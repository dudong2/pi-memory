import assert from "node:assert/strict";
import test from "node:test";
import { prepareContext, recallRequest, searchQuery } from "../src/context.ts";
import type {
  MemoryReader,
  MentalModel,
  CoreStatus,
} from "../src/contracts.ts";
import { config, fact, identity, model } from "./helpers.ts";

function reader(overrides: Partial<MemoryReader> = {}): MemoryReader {
  return {
    getModel: async (id) => model(id),
    recall: async () => [fact()],
    ...overrides,
  };
}

const signal = () => new AbortController().signal;

test("first request loads the designated Scope core without relying on recall ranking", async () => {
  const ids: string[] = [];
  const result = await prepareContext(
    reader({
      getModel: async (id) => {
        ids.push(id);
        return model(id);
      },
      recall: async () => [],
    }),
    config,
    identity,
    "Fix and test the UI",
    undefined,
    signal(),
  );
  assert.deepEqual(ids, ["scope-core"]);
  assert.match(result.text, /deployed Test URL, not localhost/);
  assert.deepEqual(
    result.core.map((item) => item.status),
    ["ready"],
  );
  assert.equal(result.recall, "empty");
});

test("recall has only the exact current-Scope set and an explicit all-type baseline", () => {
  const request = recallRequest(config, identity, "question");
  assert.deepEqual(request.tag_groups, [
    {
      or: [{ tags: [identity.scopeTag], match: "exact" }],
    },
  ]);
  assert.deepEqual(request.types, ["observation", "world", "experience"]);
  assert.equal(request.prefer_observations, false);
});

test("defense in depth drops unrelated, untagged, shared-across-scopes, and duplicate facts", async () => {
  const result = await prepareContext(
    reader({
      recall: async () => [
        fact(),
        fact(),
        fact({
          id: "ticket",
          text: "UNRELATED_TICKETING_POLICY",
          tags: ["scope:ticket"],
        }),
        fact({ id: "global", text: "UNTAGGED_POLICY", tags: [] }),
        fact({
          id: "mixed",
          text: "MIXED_SCOPE_POLICY",
          tags: [identity.scopeTag, "scope:other"],
        }),
      ],
    }),
    config,
    identity,
    "code work",
    undefined,
    signal(),
  );
  assert.doesNotMatch(
    result.text,
    /UNRELATED_TICKETING_POLICY|UNTAGGED_POLICY|MIXED_SCOPE_POLICY/,
  );
  assert.equal(result.omitted, 4);
});

for (const [name, changes, expected] of [
  ["stale", { is_stale: true }, "stale"],
  ["missing freshness", { is_stale: null }, "unknown-freshness"],
  ["missing watermark", { last_memory_seen_at: null }, "unknown-freshness"],
  ["invalid timestamp", { last_refreshed_at: "invalid" }, "unknown-freshness"],
  [
    "failed refresh",
    { last_refresh_failed_at: "2026-10-26T10:01:00Z" },
    "refresh-failed",
  ],
  ["wrong scope", { tags: ["scope:wrong"] }, "scope-mismatch"],
  ["wrong bank", { bank_id: "another-bank" }, "scope-mismatch"],
  ["wrong ID", { id: "another-model" }, "scope-mismatch"],
  ["empty", { content: null }, "empty"],
] satisfies [string, Partial<MentalModel>, CoreStatus][]) {
  test(`core ${name}: withhold the body, expose a distinct state`, async () => {
    const result = await prepareContext(
      reader({
        getModel: async (id) =>
          model(id, { content: "OLD_RULE_MUST_NOT_APPEAR", ...changes }),
        recall: async () => [],
      }),
      config,
      identity,
      "question",
      undefined,
      signal(),
    );
    assert.equal(result.core[0]?.status, expected);
    assert.doesNotMatch(result.text, /OLD_RULE_MUST_NOT_APPEAR/);
  });
}

test("missing core and unavailable backend are different from an empty recall", async () => {
  const missing = await prepareContext(
    reader({ getModel: async () => undefined, recall: async () => [] }),
    config,
    identity,
    "question",
    undefined,
    signal(),
  );
  assert.equal(missing.core[0]?.status, "missing");
  assert.equal(missing.recall, "empty");
  const failed = await prepareContext(
    reader({
      getModel: async () => {
        throw new Error("private server body");
      },
      recall: async () => {
        throw new Error("private server body");
      },
    }),
    config,
    identity,
    "question",
    undefined,
    signal(),
  );
  assert.equal(failed.core[0]?.status, "unavailable");
  assert.equal(failed.recall, "unavailable");
  assert.doesNotMatch(failed.text, /private server body/);
});

test("follow-up query includes the previous user request, not a separate model rewrite", () => {
  const query = searchQuery(
    "Then use the previous method",
    "UI testing environment",
  );
  assert.match(query, /UI testing environment/);
  assert.match(query, /Then use the previous method/);
});

test("agent proposals retain provenance and are not promoted to core policy", async () => {
  const result = await prepareContext(
    reader({
      recall: async () => [
        fact({
          text: "An agent proposed a new design; the user has not approved it.",
          metadata: { source_role: "assistant", kind: "proposal" },
        }),
      ],
    }),
    config,
    identity,
    "new design",
    undefined,
    signal(),
  );
  assert.match(result.text, /"kind":"proposal"/);
  assert.match(result.text, /Recall facts may be proposals/);
  assert.match(result.text, /not instructions or authorization/);
});

test("memory guidance permits current-Scope Reflect without per-call confirmation", async () => {
  const result = await prepareContext(
    reader(),
    config,
    identity,
    "question",
    undefined,
    signal(),
  );
  assert.match(
    result.text,
    /use current-Scope Reflect when synthesis is needed, without per-call user confirmation/,
  );
  assert.doesNotMatch(result.text, /Reflect needs approval/);
  assert.match(result.text, /not instructions or authorization/);
});

test("query secrets are blocked before recall; later normal work still succeeds", async () => {
  let calls = 0;
  const backend = reader({
    recall: async () => {
      calls++;
      return [];
    },
  });
  const secret = "sk-" + "a".repeat(32);
  const blocked = await prepareContext(
    backend,
    config,
    identity,
    `Remember ${secret}`,
    undefined,
    signal(),
  );
  assert.equal(blocked.recall, "secret-blocked");
  assert.equal(calls, 0);
  assert.doesNotMatch(blocked.text, new RegExp(secret));
  await prepareContext(
    backend,
    config,
    identity,
    "normal query",
    undefined,
    signal(),
  );
  assert.equal(calls, 1);
});

test("secret guard also checks previous-user context and inbound memory", async () => {
  const secret = "ghp_" + "b".repeat(32);
  const result = await prepareContext(
    reader({
      getModel: async (id) => model(id, { content: secret }),
      recall: async () => {
        throw new Error("must not call");
      },
    }),
    config,
    identity,
    "continue",
    secret,
    signal(),
  );
  assert.equal(result.recall, "secret-blocked");
  assert.equal(result.core[0]?.status, "secret-blocked");
  assert.doesNotMatch(result.text, new RegExp(secret));
});

test("byte budget keeps whole records, withholds oversized cores visibly, and handles Korean", async () => {
  const result = await prepareContext(
    reader({
      getModel: async (id) => model(id, { content: "중요한규칙".repeat(1000) }),
      recall: async () => [fact({ text: "상세한근거".repeat(1000) })],
    }),
    { ...config, maxContextBytes: 2048 },
    identity,
    "질문",
    undefined,
    signal(),
  );
  assert.ok(Buffer.byteLength(result.text) <= 2048);
  assert.ok(result.core.every((item) => item.status === "budget-exceeded"));
  assert.equal(result.omitted, 1);
  assert.doesNotMatch(result.text, /중요한규칙/);
});

test("oversized core must not discard fitting Recall evidence", async () => {
  const result = await prepareContext(
    reader({
      getModel: async (id) =>
        model(id, {
          content:
            id === "scope-core"
              ? "oversized history ".repeat(15000)
              : "Reply concisely in Korean.",
        }),
      recall: async () => [fact({ text: "REQUIRED_DEPLOYED_TEST_RULE" })],
    }),
    { ...config, maxContextBytes: 4096 },
    identity,
    "Fix and test the UI",
    undefined,
    signal(),
  );
  assert.equal(result.core[0]?.status, "budget-exceeded");
  assert.doesNotMatch(result.text, /oversized history/);
  assert.match(result.text, /REQUIRED_DEPLOYED_TEST_RULE/);
  assert.equal(result.omitted, 0);
  assert.ok(Buffer.byteLength(result.text) <= 4096);
});

test("oversized query is not silently cut or transmitted", async () => {
  let called = false;
  const result = await prepareContext(
    reader({
      recall: async () => {
        called = true;
        return [];
      },
    }),
    config,
    identity,
    "한".repeat(3000),
    undefined,
    signal(),
  );
  assert.equal(result.recall, "query-too-large");
  assert.equal(called, false);
});

test("plain Mental Models work without a custom schema or manual review", async () => {
  const result = await prepareContext(
    reader({
      getModel: async (id) =>
        model(id, {
          content: "APPROVAL_BOUNDARIES_ONLY_MISSING_VERIFICATION",
        }),
      recall: async () => [fact({ text: "RETRIEVABLE_VERIFICATION_RULE" })],
    }),
    config,
    identity,
    "UI work",
    undefined,
    signal(),
  );
  assert.equal(result.core[0]?.status, "ready");
  assert.match(result.text, /APPROVAL_BOUNDARIES_ONLY_MISSING_VERIFICATION/);
  assert.match(result.text, /RETRIEVABLE_VERIFICATION_RULE/);
});

test("reloading core on the next request does not reuse a previously valid old rule", async () => {
  let changed = false;
  const backend = reader({
    getModel: async (id) =>
      model(id, {
        content: changed ? "NEW_RULE" : "OLD_RULE",
        is_stale: changed,
      }),
    recall: async () => [],
  });
  const before = await prepareContext(
    backend,
    config,
    identity,
    "first",
    undefined,
    signal(),
  );
  assert.match(before.text, /OLD_RULE/);
  changed = true;
  const after = await prepareContext(
    backend,
    config,
    identity,
    "after correction",
    undefined,
    signal(),
  );
  assert.doesNotMatch(after.text, /OLD_RULE|NEW_RULE/);
  assert.equal(after.core[0]?.status, "stale");
});
