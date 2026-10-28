import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { spawn, type ChildProcess } from "node:child_process";
import { EvidenceStore } from "../src/evidence.ts";

const event = (requestId: string, snapshot = "preserve exact evidence") => ({
  requestId,
  scopeId: "scope-one",
  projectId: "project-one",
  sessionId: "session-one",
  type: "provider-payload" as const,
  data: { matched: true, snapshot },
});

test("request and recent-list queries use SQLite metadata indexes, not snapshot scans", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-memory-sqlite-"));
  const store = new EvidenceStore({
    directory,
    retentionDays: 30,
    maxBytes: 16 * 1024 * 1024,
  });
  t.after(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const requestId = randomUUID();
  await store.append(event(requestId));
  await store.read("scope-one", requestId);
  const path = join(directory, "evidence.sqlite");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT event_id, metadata_json FROM events WHERE scope_id=? AND request_id=? ORDER BY recorded_at,event_id LIMIT 5",
      )
      .all("scope-one", requestId);
    assert.ok(
      plan.some((row) => String(row.detail).includes("evidence_request_idx")),
    );
    assert.ok(plan.every((row) => !String(row.detail).startsWith("SCAN ")));
    const list = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT request_id,last_stage FROM requests WHERE scope_id=? ORDER BY recorded_at DESC,request_id LIMIT 5",
      )
      .all("scope-one");
    assert.ok(
      list.some((row) => String(row.detail).includes("evidence_recent_idx")),
    );
    assert.equal(
      db
        .prepare("SELECT metadata_json FROM events")
        .get()
        ?.metadata_json?.toString()
        .includes("preserve exact evidence"),
      false,
    );
    assert.equal(
      db.prepare("SELECT snapshot FROM bodies").get()?.snapshot,
      "preserve exact evidence",
    );
    assert.equal(db.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
  } finally {
    db.close();
  }
});

test("lists never read snapshot bodies and missing/secret bodies are explicitly withheld", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "pi-memory-sqlite-integrity-"),
  );
  const store = new EvidenceStore({
    directory,
    retentionDays: 30,
    maxBytes: 16 * 1024 * 1024,
  });
  t.after(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const requestId = randomUUID();
  await store.append(event(requestId));
  await store.read("scope-one");
  const db = new DatabaseSync(join(directory, "evidence.sqlite"));
  try {
    db.exec("DELETE FROM bodies");
  } finally {
    db.close();
  }
  const list = await store.read("scope-one");
  assert.equal(list.total, 1);
  assert.ok(list.requests);
  const missing = await store.read("scope-one", requestId);
  assert.ok(missing.events);
  assert.equal(missing.events.length, 0);
  assert.equal(missing.incompleteRecords, 1);
  const writer = new DatabaseSync(join(directory, "evidence.sqlite"));
  try {
    writer
      .prepare(
        "INSERT INTO bodies(event_id,snapshot) SELECT event_id,? FROM events",
      )
      .run(`Bearer ${"x".repeat(32)}`);
  } finally {
    writer.close();
  }
  const secret = await store.read("scope-one", requestId);
  assert.ok(secret.events);
  assert.equal(secret.events.length, 0);
  assert.equal(secret.incompleteRecords, 1);
  assert.equal(secret.nextOffset, null);
  assert.equal((await store.read("scope-one")).total, 1);
});

test("an initialized store refuses a replaced foreign database before any retention write", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-memory-sqlite-replaced-"));
  const store = new EvidenceStore({
    directory,
    retentionDays: 30,
    maxBytes: 16 * 1024 * 1024,
  });
  t.after(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  await store.append(event(randomUUID()));
  await store.read("scope-one");
  const path = join(directory, "evidence.sqlite");
  await rename(path, path + ".preserved");
  const foreign = new DatabaseSync(path);
  foreign.exec(
    "CREATE TABLE events(event_id INTEGER PRIMARY KEY,recorded_at INTEGER); INSERT INTO events VALUES(1,0)",
  );
  foreign.close();
  await chmod(path, 0o600);
  const before = await readFile(path);
  await assert.rejects(
    store.append(event(randomUUID())),
    /evidence-foreign-database/,
  );
  assert.deepEqual(await readFile(path), before);
});

const stress = process.env.PI_MEMORY_EVIDENCE_STRESS === "1";
test(`indexed reads and collection coexist with a held WAL reader (${stress ? 1024 : 64}MiB snapshot corpus)`, {
  timeout: 120_000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-memory-sqlite-load-"));
  // Extra headroom belongs only to this temporary load fixture, not live policy.
  const store = new EvidenceStore({
    directory,
    retentionDays: 30,
    maxBytes: 2 * 1024 * 1024 * 1024,
  });
  let reader: ChildProcess | undefined, finished: Promise<void> | undefined;
  t.after(async () => {
    if (reader && reader.exitCode === null) {
      reader.kill("SIGTERM");
      await finished?.catch(() => {});
    }
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const requestId = randomUUID(),
    snapshot = "fixture ".repeat(2048);
  for (let i = 0; i < 5; i++) await store.append(event(requestId, snapshot));
  await store.read("scope-one", requestId);
  const path = join(directory, "evidence.sqlite"),
    db = new DatabaseSync(path);
  const count =
    ((stress ? 1024 : 64) * 1024 * 1024) / Buffer.byteLength(snapshot);
  try {
    db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA cache_size=-8192; PRAGMA wal_autocheckpoint=512;",
    );
    const insert = db.prepare(
      "INSERT INTO events(scope_id,request_id,recorded_at,bytes,metadata_json,has_body) VALUES(?,?,?,?,?,1)",
    );
    const body = db.prepare(
      "INSERT INTO bodies(event_id,snapshot) VALUES(?,?)",
    );
    for (let i = 0; i < count; i++) {
      if (i % 512 === 0) db.exec("BEGIN");
      const record = {
        ...event(`bulk-${Math.floor(i / 100)}`, snapshot),
        format: "pi-memory-evidence/v1",
        recordedAt: new Date().toISOString(),
        implementation: { version: "fixture", codeId: "a".repeat(64) },
      };
      const metadata = JSON.stringify({ ...record, data: { matched: true } });
      const added = insert.run(
        "scope-one",
        record.requestId,
        Date.parse(record.recordedAt),
        Buffer.byteLength(JSON.stringify(record) + "\n"),
        metadata,
      );
      body.run(added.lastInsertRowid, snapshot);
      if (i % 512 === 511 || i === count - 1) db.exec("COMMIT");
    }
  } finally {
    db.close();
  }
  const readTimes: number[] = [];
  for (let i = 0; i < 10; i++) {
    const started = performance.now(),
      result = await store.read("scope-one", requestId, 0, 5);
    readTimes.push(performance.now() - started);
    assert.ok(result.events);
    assert.equal(result.events.length, 5);
    assert.equal(result.total, 5);
  }
  const listStart = performance.now();
  await store.read("scope-one");
  const listMs = performance.now() - listStart;
  const code = `import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync(process.argv[1],{readOnly:true});db.exec('BEGIN');
    db.prepare('SELECT event_id FROM events LIMIT 1').get();process.send?.('held');
    process.on('message',()=>{db.exec('ROLLBACK');db.close();process.disconnect?.();});`;
  reader = spawn(process.execPath, ["--input-type=module", "-e", code, path], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const held = new Promise<void>((resolve) =>
    reader?.once("message", () => resolve()),
  );
  finished = new Promise<void>((resolve, reject) => {
    reader?.once("error", reject);
    reader?.once("exit", (value) =>
      value === 0 ? resolve() : reject(new Error(`reader exit ${value}`)),
    );
  });
  await Promise.race([
    held,
    finished.then(() => {
      throw new Error("reader exited before holding a snapshot");
    }),
  ]);
  const started = performance.now();
  await store.append(event(randomUUID(), "concurrent collector"));
  const appendMs = performance.now() - started;
  reader.send?.("release");
  await finished;
  assert.ok(appendMs < 1500, `writer blocked for ${appendMs}ms`);
  assert.ok(
    Math.max(...readTimes) < 1000,
    `indexed read took ${Math.max(...readTimes)}ms`,
  );
  t.diagnostic(
    JSON.stringify({
      snapshotCorpusMiB: (count * Buffer.byteLength(snapshot)) / 1048576,
      databaseMiB: (await stat(path)).size / 1048576,
      requestReadMaxMs: Math.max(...readTimes),
      listMs,
      writerWhileReaderHeldMs: appendMs,
    }),
  );
});
