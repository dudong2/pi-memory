import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Stats } from "node:fs";
import { DatabaseSync } from "node:sqlite";

function exited(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}
function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.ctimeMs === b.ctimeMs;
}
async function checkFile(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      throw new Error("invalid-scope-lock-storage");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

// Same SQLite lease schema and PID-file gate as the previous extension. Both
// versions serialize on this lease; elapsed time never permits stealing a live
// writer. node:sqlite avoids bringing the old memory/database subsystem along.
export async function acquireCatalogLock(
  lockPath: string,
): Promise<() => Promise<void>> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const parent = await realpath(dirname(lockPath));
  const dbPath = join(parent, ".scope-catalog-locks.sqlite");
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    await checkFile(dbPath + suffix);
  try {
    const file = await open(dbPath, "wx", 0o600);
    await file.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const db = new DatabaseSync(dbPath);
  const token = randomUUID(),
    key = basename(lockPath),
    deadline = Date.now() + 5000;
  let leased = false;
  const releaseLease = () => {
    try {
      if (leased)
        db.prepare("DELETE FROM locks WHERE lock_key = ? AND token = ?").run(
          key,
          token,
        );
    } finally {
      db.close();
    }
  };
  try {
    await chmod(dbPath, 0o600);
    db.exec(`PRAGMA busy_timeout = 100; PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS locks (lock_key TEXT PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL, incarnation TEXT, acquired_at INTEGER NOT NULL);`);
    while (!leased) {
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          const owner = db
            .prepare("SELECT pid FROM locks WHERE lock_key = ?")
            .get(key);
          if (!owner || exited(Number(owner.pid))) {
            db.prepare(
              "INSERT OR REPLACE INTO locks (lock_key, token, pid, incarnation, acquired_at) VALUES (?, ?, ?, NULL, ?)",
            ).run(key, token, process.pid, Date.now());
            leased = true;
          }
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      } catch (error) {
        if (
          !["database is locked", "database table is locked"].includes(
            (error as Error).message,
          )
        )
          throw error;
      }
      if (!leased) {
        if (Date.now() >= deadline) throw new Error("scope-catalog-lock-busy");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    while (true) {
      try {
        const handle = await open(lockPath, "wx", 0o600);
        try {
          await handle.writeFile(
            `${process.pid}\n${new Date().toISOString()}\n`,
          );
        } catch (error) {
          await handle.close();
          throw error;
        }
        const identity = await handle.stat();
        return async () => {
          try {
            await handle.close();
            try {
              if (sameFile(identity, await lstat(lockPath)))
                await unlink(lockPath);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
            }
          } finally {
            releaseLease();
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const info = await lstat(lockPath);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
          throw new Error("invalid-scope-catalog-lock");
        const pid = (await readFile(lockPath, "utf8")).split("\n", 1)[0] ?? "";
        if (
          /^\d+$/.test(pid) &&
          exited(Number(pid)) &&
          sameFile(info, await lstat(lockPath))
        ) {
          await unlink(lockPath);
          continue;
        }
        if (Date.now() >= deadline) throw new Error("scope-catalog-lock-busy");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  } catch (error) {
    releaseLease();
    throw error;
  }
}
