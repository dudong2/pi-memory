import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MemoryError, nonempty, object, sameTags } from "./contracts.ts";
import { containsSecretData } from "./safety.ts";

export interface RetainItem {
  content: string;
  document_id: string;
  tags: string[];
  metadata: Record<string, string>;
  timestamp?: string;
  update_mode: "replace";
  observation_scopes: "combined";
}
export interface RetainRequest {
  items: RetainItem[];
  async: true;
  operation_id: string;
}
export type DeliveryState = "queued" | "submitted" | "confirmed" | "failed";
export interface Receipt {
  id: string;
  documentId: string;
  state: DeliveryState;
}
export interface Pending extends Receipt {
  request: RetainRequest;
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
const appId = 0x50494d51;

function receipt(value: unknown): Receipt {
  const row = object(value);
  const state = nonempty(row.state);
  if (!["queued", "submitted", "confirmed", "failed"].includes(state))
    throw new MemoryError("outbox-invalid-state");
  return {
    id: nonempty(row.id),
    documentId: nonempty(row.document_id),
    state: state as DeliveryState,
  };
}
function dead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH";
  }
}

// This is a delivery queue, not a memory index: confirmed payloads are erased.
// SQLite transactions make ownership recovery atomic across Pi processes.
export class Outbox {
  private readonly db: DatabaseSync;
  private readonly route: string;
  private readonly token = randomUUID();
  private readonly host = hostname();
  private closed = false;

  private constructor(db: DatabaseSync, route: string) {
    this.db = db;
    this.route = route;
  }

  static async open(path: string, route: string): Promise<Outbox> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.close();
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      )
        throw new MemoryError("outbox-unavailable");
    }
    const stat = await lstat(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.mode & 0o077 ||
      (process.getuid && stat.uid !== process.getuid())
    ) {
      throw new MemoryError("outbox-permissions");
    }
    if (stat.size) {
      const probe = new DatabaseSync(path, { readOnly: true });
      try {
        if (
          Number(
            probe.prepare("PRAGMA application_id").get()?.application_id,
          ) !== appId
        )
          throw new MemoryError("outbox-foreign-database");
      } finally {
        probe.close();
      }
    }
    const db = new DatabaseSync(path);
    try {
      db.exec(`PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        BEGIN IMMEDIATE;
        PRAGMA application_id=${appId};
        CREATE TABLE IF NOT EXISTS deliveries (
          id TEXT PRIMARY KEY, route TEXT NOT NULL, dedupe TEXT NOT NULL UNIQUE,
          document_id TEXT NOT NULL, payload_hash TEXT NOT NULL, payload TEXT,
          state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt INTEGER NOT NULL DEFAULT 0, error_code TEXT,
          owner_pid INTEGER, owner_host TEXT, owner_token TEXT,
          created_at INTEGER NOT NULL);
        COMMIT;`);
      return new Outbox(db, route);
    } catch {
      db.close();
      throw new MemoryError("outbox-unavailable");
    }
  }

  enqueue(key: string, item: RetainItem): Receipt {
    if (containsSecretData(item)) throw new MemoryError("secret-blocked");
    if (!item.content.trim() || Buffer.byteLength(item.content) > 65536)
      throw new MemoryError("content-size");
    const dedupe = fingerprint([this.route, key]);
    const hash = fingerprint({ ...item, timestamp: undefined });
    const id = randomUUID();
    const request: RetainRequest = {
      items: [
        { ...item, timestamp: item.timestamp ?? new Date().toISOString() },
      ],
      async: true,
      operation_id: id,
    };
    this.db
      .prepare(`INSERT OR IGNORE INTO deliveries
      (id,route,dedupe,document_id,payload_hash,payload,state,created_at) VALUES (?,?,?,?,?,?,'queued',?)`)
      .run(
        id,
        this.route,
        dedupe,
        item.document_id,
        hash,
        JSON.stringify(request),
        Date.now(),
      );
    const row = object(
      this.db.prepare("SELECT * FROM deliveries WHERE dedupe=?").get(dedupe),
    );
    if (row.payload_hash !== hash)
      throw new MemoryError("outbox-idempotency-conflict");
    return receipt(row);
  }

  claim(now = Date.now()): Pending | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db
        .prepare(`SELECT d.* FROM deliveries d WHERE d.route=? AND d.state IN ('queued','submitted')
        AND d.next_attempt<=? AND NOT EXISTS (
          SELECT 1 FROM deliveries prior WHERE prior.route=d.route AND prior.document_id=d.document_id
          AND prior.rowid<d.rowid AND prior.state!='confirmed') ORDER BY d.rowid`)
        .all(this.route, now);
      for (const raw of rows) {
        const row = object(raw);
        if (
          row.owner_pid != null &&
          (row.owner_host !== this.host || !dead(Number(row.owner_pid)))
        )
          continue;
        const next = receipt(row);
        const request = JSON.parse(nonempty(row.payload)) as RetainRequest;
        if (request.operation_id !== next.id)
          throw new MemoryError("outbox-operation-mismatch");
        this.db
          .prepare(
            "UPDATE deliveries SET owner_pid=?,owner_host=?,owner_token=? WHERE id=?",
          )
          .run(process.pid, this.host, this.token, next.id);
        this.db.exec("COMMIT");
        return { ...next, request };
      }
      this.db.exec("COMMIT");
      return undefined;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  submitted(id: string): void {
    this.db
      .prepare(
        "UPDATE deliveries SET state='submitted',error_code=NULL WHERE id=? AND owner_token=?",
      )
      .run(id, this.token);
  }
  finish(id: string): void {
    this.db
      .prepare(`UPDATE deliveries SET state='confirmed',payload=NULL,error_code=NULL,
      owner_pid=NULL,owner_host=NULL,owner_token=NULL WHERE id=? AND owner_token=?`)
      .run(id, this.token);
  }
  defer(id: string, code: string, terminal = false): void {
    const safe =
      /^(http-\d{3}|timeout|cancelled|request-failed|invalid-response|invalid-operation-id|operation-failed|operation-missing|operation-mismatch|operation-pending)$/.test(
        code,
      )
        ? code
        : "delivery-failed";
    const row = this.db
      .prepare("SELECT attempts FROM deliveries WHERE id=? AND owner_token=?")
      .get(id, this.token);
    if (!row) return;
    const attempts = Number(row.attempts) + 1;
    const wait =
      safe === "operation-pending"
        ? 2000
        : Math.min(60000, 1000 * 2 ** Math.min(attempts, 6));
    this.db
      .prepare(`UPDATE deliveries SET state=CASE WHEN ? THEN 'failed' ELSE state END,
      attempts=?,next_attempt=?,error_code=?,owner_pid=NULL,owner_host=NULL,owner_token=NULL WHERE id=? AND owner_token=?`)
      .run(terminal ? 1 : 0, attempts, Date.now() + wait, safe, id, this.token);
  }
  hasPendingChanges(scopes: readonly string[][]): boolean {
    const rows = this.db
      .prepare(
        "SELECT payload FROM deliveries WHERE route=? AND state!='confirmed'",
      )
      .all(this.route);
    return rows.some((row) => {
      try {
        const request = JSON.parse(nonempty(row.payload)) as RetainRequest;
        return request.items.some(
          (item) =>
            item.metadata.kind !== "conversation" &&
            scopes.some((scope) => sameTags(scope, item.tags)),
        );
      } catch {
        throw new MemoryError("outbox-invalid-payload");
      }
    });
  }
  stats() {
    const counts = {
      queued: 0,
      submitted: 0,
      confirmed: 0,
      failed: 0,
      otherDestinations: 0,
    };
    for (const row of this.db
      .prepare(
        "SELECT route,state,count(*) AS count FROM deliveries GROUP BY route,state",
      )
      .all()) {
      if (row.route !== this.route) {
        counts.otherDestinations += Number(row.count);
        continue;
      }
      const key = receipt({
        id: "count",
        document_id: "count",
        state: row.state,
      }).state;
      counts[key] += Number(row.count);
    }
    const errors = this.db
      .prepare(
        "SELECT error_code AS code,count(*) AS count FROM deliveries WHERE route=? AND error_code IS NOT NULL GROUP BY error_code",
      )
      .all(this.route)
      .map((row) => ({ code: String(row.code), count: Number(row.count) }));
    return { ...counts, errors };
  }
  nextAttempt(): number | undefined {
    const row = this.db
      .prepare(
        "SELECT min(next_attempt) AS next FROM deliveries WHERE route=? AND state IN ('queued','submitted')",
      )
      .get(this.route);
    return row?.next == null ? undefined : Number(row.next);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db
      .prepare(
        "UPDATE deliveries SET owner_pid=NULL,owner_host=NULL,owner_token=NULL WHERE owner_token=?",
      )
      .run(this.token);
    this.db.close();
  }
}
