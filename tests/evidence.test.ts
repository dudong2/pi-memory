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
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { EvidenceStore, type EvidenceRecord } from "../src/evidence.ts";
import { acquireCatalogLock } from "../src/scope/catalog-lock.ts";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "pi-memory-evidence-"));
  await chmod(directory, 0o700);
  const stores: EvidenceStore[] = [];
  t.after(async () => {
    await Promise.all(stores.map((store) => store.close()));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    store: (maxBytes = 16 * 1024 * 1024, retentionDays = 30) => {
      const store = new EvidenceStore({ directory, retentionDays, maxBytes });
      stores.push(store);
      return store;
    },
  };
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
function legacyRecord(requestId: string, index: number): EvidenceRecord {
  return {
    ...event(),
    requestId,
    format: "pi-memory-evidence/v1",
    recordedAt: new Date(Date.now() + index).toISOString(),
    implementation: { version: "0.2.0", codeId: "a".repeat(64) },
    data: { index, snapshot: `정확한 전달본 ${index}\n"quoted"` },
  };
}
async function legacyFile(
  directory: string,
  rows: EvidenceRecord[],
  tail = "",
) {
  const fileId = randomUUID();
  const path = join(directory, `pi-memory-evidence-v1-${fileId}.jsonl`);
  await writeFile(
    path,
    JSON.stringify({
      format: "pi-memory-evidence/v1",
      fileId,
      scopeId: "scope-one",
    }) +
      "\n" +
      rows.map((row) => JSON.stringify(row) + "\n").join("") +
      tail,
    { mode: 0o600 },
  );
  return path;
}
const checksum = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

test("evidence is private, durable, current-Scope queryable and retains exact snapshots", async (t) => {
  const data = await fixture(t),
    store = data.store(),
    first = event();
  await store.append(first);
  await store.append(event("other-scope"));
  const restarted = data.store();
  const result = await restarted.read("scope-one", first.requestId);
  assert.ok(result.events);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]?.data.snapshot, first.data.snapshot);
  const wrong = await restarted.read("other-scope", first.requestId);
  assert.ok(wrong.events);
  assert.equal(wrong.events.length, 0);
  for (const name of (await readdir(data.directory)).filter((name) =>
    name.startsWith("evidence.sqlite"),
  ))
    assert.equal((await stat(join(data.directory, name))).mode & 0o777, 0o600);
});

test("retention deletes only expired SQL evidence, cascades bodies, and preserves unrelated files", async (t) => {
  const data = await fixture(t),
    store = data.store(1024 * 1024, 1),
    first = event();
  await store.append(first);
  await store.read("scope-one");
  const db = new DatabaseSync(join(data.directory, "evidence.sqlite"));
  try {
    const old = Date.now() - 3 * 86400000;
    db.prepare("UPDATE events SET recorded_at=?").run(old);
    db.prepare("UPDATE requests SET recorded_at=?").run(old);
  } finally {
    db.close();
  }
  await writeFile(join(data.directory, "unrelated.jsonl"), "keep");
  await store.append(event());
  const removed = await store.read("scope-one", first.requestId);
  assert.ok(removed.events);
  assert.equal(removed.events.length, 0);
  assert.equal(
    await readFile(join(data.directory, "unrelated.jsonl"), "utf8"),
    "keep",
  );
  const checked = new DatabaseSync(join(data.directory, "evidence.sqlite"), {
    readOnly: true,
  });
  try {
    assert.equal(
      checked
        .prepare(
          "SELECT count(*) AS n FROM bodies LEFT JOIN events USING(event_id) WHERE events.event_id IS NULL",
        )
        .get()?.n,
      0,
    );
  } finally {
    checked.close();
  }
});

test("secrets, symlink roots and foreign databases are refused without modification", async (t) => {
  const data = await fixture(t),
    store = data.store();
  await assert.rejects(
    store.append({
      ...event(),
      data: { snapshot: `Bearer ${"x".repeat(32)}` },
    }),
    /evidence-secret-blocked/,
  );
  const outside = await fixture(t),
    link = join(data.directory, "linked");
  await symlink(outside.directory, link);
  await assert.rejects(
    new EvidenceStore({
      directory: link,
      retentionDays: 30,
      maxBytes: 1024 * 1024,
    }).append(event()),
    /evidence-unsafe/,
  );
  assert.deepEqual(await readdir(outside.directory), []);
  const foreign = join(data.directory, "evidence.sqlite");
  const db = new DatabaseSync(foreign);
  db.exec(
    "CREATE TABLE keep(value TEXT); INSERT INTO keep VALUES('unrelated')",
  );
  db.close();
  await chmod(foreign, 0o600);
  const before = await checksum(foreign);
  await assert.rejects(store.append(event()), /evidence-foreign-database/);
  assert.equal(await checksum(foreign), before);
});

test("quota and concurrent writers keep actual managed database files bounded", async (t) => {
  const data = await fixture(t),
    maxBytes = 1024 * 1024,
    a = data.store(maxBytes),
    b = data.store(maxBytes);
  await writeFile(join(data.directory, "unrelated.keep"), "preserve");
  for (let i = 0; i < 40; i++)
    await Promise.all([
      a.append({
        ...event(),
        data: { snapshot: "fixture ".repeat(2000), index: i },
      }),
      b.append({
        ...event(),
        data: { snapshot: "fixture ".repeat(2000), index: i },
      }),
    ]);
  await a.read("scope-one");
  await b.read("scope-one");
  let bytes = 0;
  for (const name of await readdir(data.directory))
    if (
      name.startsWith("evidence.sqlite") ||
      name.startsWith(".scope-catalog-locks.sqlite")
    )
      bytes += (await stat(join(data.directory, name))).size;
  assert.ok(bytes <= maxBytes, `${bytes} > ${maxBytes}`);
  const list = await a.read("scope-one");
  assert.ok(list.requests);
  assert.ok(list.total > 0 && list.total < 80);
  assert.equal(
    await readFile(join(data.directory, "unrelated.keep"), "utf8"),
    "preserve",
  );
});

test("JSONL migration is exact, idempotent, resumable and preserves malformed/partial originals", async (t) => {
  const data = await fixture(t),
    requestId = randomUUID();
  const originals = Array.from({ length: 5 }, (_, i) =>
    legacyRecord(requestId, i),
  );
  const path = await legacyFile(
    data.directory,
    originals,
    'not-json\n{"partial":',
  );
  const before = await checksum(path);
  const store = data.store(),
    first = await store.read("scope-one", requestId, 0, 2);
  assert.ok(first.events);
  assert.deepEqual(first.events, originals.slice(0, 2));
  assert.equal(first.total, 5);
  assert.equal(first.nextOffset, 2);
  assert.equal(first.incompleteRecords, 2);
  assert.equal(first.migration.state, "ready");
  assert.equal(await checksum(path), before);
  const second = data.store();
  const same = await second.read("scope-one", requestId, 0, 50);
  assert.ok(same.events);
  assert.deepEqual(same.events, originals);
  const final = { ...legacyRecord(requestId, 100), type: "settled" as const };
  await appendFile(path, `true}\n${JSON.stringify(final)}\n`);
  const third = data.store(),
    resumed = await third.read("scope-one", requestId, 4, 2);
  assert.ok(resumed.events);
  assert.equal(resumed.total, 6);
  assert.deepEqual(resumed.events.at(-1), final);
  assert.equal(resumed.nextOffset, null);
  assert.equal(resumed.incompleteRecords, 2);
  assert.ok(
    (await readFile(path, "utf8")).includes('not-json\n{"partial":true}'),
  );
});

test("collection does not wait on the old JSONL reader lock during migration", async (t) => {
  const data = await fixture(t);
  await legacyFile(data.directory, [legacyRecord(randomUUID(), 0)]);
  const release = await acquireCatalogLock(
    join(data.directory, ".evidence-writer.lock"),
  );
  const store = data.store();
  try {
    const started = performance.now();
    await store.append(event());
    assert.ok(performance.now() - started < 1500);
  } finally {
    await release();
  }
  const list = await store.read("scope-one");
  assert.equal(list.migration.state, "ready");
  assert.equal(list.total, 2);
});

test("insufficient migration space never deletes or rewrites legacy evidence", async (t) => {
  const data = await fixture(t),
    rows = [legacyRecord(randomUUID(), 0)];
  rows[0]!.data.snapshot = "fixture ".repeat(80_000);
  const path = await legacyFile(data.directory, rows),
    before = await checksum(path);
  await assert.rejects(
    data.store(256 * 1024).append(event()),
    /evidence-budget-too-small/,
  );
  assert.equal(await checksum(path), before);
});
