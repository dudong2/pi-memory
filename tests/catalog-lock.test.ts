import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { acquireCatalogLock } from "../src/scope/catalog-lock.ts";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-catalog-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    lock: join(root, "scope-catalog.json.lock"),
    database: join(root, ".scope-catalog-locks.sqlite"),
  };
}

test("catalog writer never steals a live legacy lease merely because it is old", async (t) => {
  const { lock, database } = await fixture(t);
  const initial = await acquireCatalogLock(lock);
  await initial();
  const db = new DatabaseSync(database);
  t.after(() => db.close());
  db.prepare(
    "INSERT INTO locks (lock_key, token, pid, incarnation, acquired_at) VALUES (?, ?, ?, NULL, 0)",
  ).run("scope-catalog.json.lock", "legacy-live-owner", process.pid);
  await assert.rejects(acquireCatalogLock(lock), /lock-busy/);
  assert.equal(
    db.prepare("SELECT token FROM locks").get()?.token,
    "legacy-live-owner",
  );
});

test("catalog lock recovers an exited writer through the compatible SQLite and PID-file gates", async (t) => {
  const { lock, database } = await fixture(t);
  const module = pathToFileURL(resolve("src/scope/catalog-lock.ts")).href;
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {acquireCatalogLock} from ${JSON.stringify(module)}; await acquireCatalogLock(${JSON.stringify(lock)}); process.exit(0);`,
    ],
    { timeout: 10000 },
  );
  assert.ok(await readFile(lock, "utf8"));
  const release = await acquireCatalogLock(lock);
  await release();
  await assert.rejects(readFile(lock));
  const db = new DatabaseSync(database);
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM locks").get()?.n, 0);
  } finally {
    db.close();
  }
});
