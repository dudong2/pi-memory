import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  appendFile,
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
  utimes,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { EvidenceStore } from "../src/evidence.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-evidence-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const event = (scopeId = "scope-one") => ({
  requestId: randomUUID(),
  scopeId,
  projectId: "project-one",
  sessionId: "session-one",
  userEntryId: "user-entry",
  type: "provider-payload" as const,
  data: { matched: true, snapshot: "private scope memory fixture" },
});

test("evidence is private, durable, current-Scope queryable and retains exact snapshots", async (t) => {
  const directory = await fixture(t);
  const store = new EvidenceStore({
    directory,
    retentionDays: 30,
    maxBytes: 256 * 1024 * 1024,
  });
  const first = event();
  await store.append(first);
  await store.append(event("other-scope"));
  const restarted = new EvidenceStore({
    directory,
    retentionDays: 30,
    maxBytes: 256 * 1024 * 1024,
  });
  const result = await restarted.read("scope-one", first.requestId);
  assert.ok(result.events);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]?.data.snapshot, first.data.snapshot);
  const wrong = await restarted.read("other-scope", first.requestId);
  assert.ok(wrong.events);
  assert.equal(wrong.events.length, 0);
  for (const file of (await readdir(directory)).filter((name) =>
    name.endsWith(".jsonl"),
  ))
    assert.equal((await stat(join(directory, file))).mode & 0o777, 0o600);
});

test("retention deletes only owned expired evidence and preserves unrelated files", async (t) => {
  const directory = await fixture(t);
  const store = new EvidenceStore({
    directory,
    retentionDays: 1,
    maxBytes: 8192,
  });
  await store.append(event());
  const files = (await readdir(directory)).filter((name) =>
    name.endsWith(".jsonl"),
  );
  const old = new Date(Date.now() - 3 * 86400000);
  for (const name of files) await utimes(join(directory, name), old, old);
  await writeFile(join(directory, "unrelated.jsonl"), "keep");
  await new EvidenceStore({
    directory,
    retentionDays: 1,
    maxBytes: 8192,
  }).append(event());
  for (const name of files)
    await assert.rejects(stat(join(directory, name)), { code: "ENOENT" });
  assert.equal(
    await readFile(join(directory, "unrelated.jsonl"), "utf8"),
    "keep",
  );
});

test("secrets and symlink destinations are refused without following or exposing them", async (t) => {
  const directory = await fixture(t);
  const store = new EvidenceStore({
    directory,
    retentionDays: 30,
    maxBytes: 8192,
  });
  await assert.rejects(
    store.append({
      ...event(),
      data: { snapshot: `Bearer ${"x".repeat(32)}` },
    }),
    /evidence-secret-blocked/,
  );
  const outside = await fixture(t);
  const link = join(directory, "linked");
  await symlink(outside, link);
  await assert.rejects(
    new EvidenceStore({
      directory: link,
      retentionDays: 30,
      maxBytes: 8192,
    }).append(event()),
    /evidence-unsafe/,
  );
  assert.deepEqual(await readdir(outside), []);
});

test("quota and concurrent writers keep only bounded owned data", async (t) => {
  const directory = await fixture(t);
  const options = { directory, retentionDays: 30, maxBytes: 8192 };
  const a = new EvidenceStore(options),
    b = new EvidenceStore(options);
  for (let i = 0; i < 12; i++)
    await Promise.all([
      a.append({
        ...event(),
        data: { snapshot: "fixture ".repeat(100), index: i },
      }),
      b.append({
        ...event(),
        data: { snapshot: "fixture ".repeat(100), index: i },
      }),
    ]);
  const sizes = await Promise.all(
    (await readdir(directory))
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => stat(join(directory, name))),
  );
  assert.ok(
    sizes.reduce((sum, info) => sum + info.size, 0) <= options.maxBytes,
  );
  const list = await a.read("scope-one");
  assert.ok(list.requests);
  assert.ok(list.requests.length > 0);
});

test("paged evidence survives restart with an explicitly reported partial crash tail", async (t) => {
  const directory = await fixture(t);
  const options = { directory, retentionDays: 30, maxBytes: 65536 };
  const store = new EvidenceStore(options),
    first = event();
  for (let i = 0; i < 5; i++)
    await store.append({ ...first, data: { index: i } });
  const path = join(
    directory,
    (await readdir(directory)).find((name) => name.endsWith(".jsonl")) ?? "",
  );
  await appendFile(path, '{"partial":');
  const restarted = new EvidenceStore(options);
  await restarted.append({
    ...first,
    type: "settled",
    data: { answerUse: "not-assessed" },
  });
  const page = await restarted.read("scope-one", first.requestId, 0, 2);
  assert.ok(page.events);
  assert.equal(page.events.length, 2);
  assert.equal(page.nextOffset, 2);
  assert.equal(page.total, 6);
  assert.equal(page.incompleteRecords, 1);
  const last = await restarted.read("scope-one", first.requestId, 4, 2);
  assert.ok(last.events);
  assert.equal(last.events.at(-1)?.type, "settled");
  assert.equal(last.nextOffset, null);
});
