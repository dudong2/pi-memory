import { constants } from "node:fs";
import { lstat, mkdir, open, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldLoop } from "node:timers/promises";
import { MemoryError, type EvidenceConfig } from "./contracts.ts";
import { containsSecretData } from "./safety.ts";
import { acquireCatalogLock } from "./scope/catalog-lock.ts";
import {
  evidenceFormat,
  isRecord,
  maxEventBytes,
  sourceIdentity,
  stages,
  type EvidenceEvent,
  type EvidenceRecord,
} from "./evidence-format.ts";
import {
  importLegacy,
  legacyInventory,
  type LegacyBatch,
  type LegacyFile,
  type MigrationStatus,
} from "./evidence-legacy.ts";
export type { EvidenceEvent, EvidenceRecord } from "./evidence-format.ts";

const applicationId = 0x50494556;
const schema = `
CREATE TABLE IF NOT EXISTS accounting (id INTEGER PRIMARY KEY CHECK(id=1), bytes INTEGER NOT NULL, events INTEGER NOT NULL);
INSERT OR IGNORE INTO accounting VALUES(1,0,0);
CREATE TABLE IF NOT EXISTS events (
 event_id INTEGER PRIMARY KEY, scope_id TEXT NOT NULL, request_id TEXT NOT NULL,
 recorded_at INTEGER NOT NULL, bytes INTEGER NOT NULL CHECK(bytes>0), metadata_json TEXT NOT NULL, has_body INTEGER NOT NULL CHECK(has_body IN (0,1)), legacy_key TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS evidence_request_idx ON events(scope_id,request_id,recorded_at,event_id);
CREATE INDEX IF NOT EXISTS evidence_retention_idx ON events(recorded_at,event_id);
CREATE TABLE IF NOT EXISTS bodies (event_id INTEGER PRIMARY KEY REFERENCES events(event_id) ON DELETE CASCADE, snapshot TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS requests (
 scope_id TEXT NOT NULL, request_id TEXT NOT NULL, session_id TEXT NOT NULL, user_entry_id TEXT, session_file TEXT,
 recorded_at INTEGER NOT NULL, last_stage TEXT NOT NULL, event_count INTEGER NOT NULL,
 PRIMARY KEY(scope_id,request_id)
);
CREATE INDEX IF NOT EXISTS evidence_recent_idx ON requests(scope_id,recorded_at DESC,request_id);
CREATE TABLE IF NOT EXISTS legacy_imports (
 file_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, header_hash TEXT NOT NULL, source_path TEXT NOT NULL,
 offset INTEGER NOT NULL, last_start INTEGER NOT NULL, last_hash TEXT NOT NULL, invalid_count INTEGER NOT NULL, partial_tail INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS evidence_legacy_scope_idx ON legacy_imports(scope_id);
CREATE TRIGGER IF NOT EXISTS evidence_insert AFTER INSERT ON events BEGIN
 UPDATE accounting SET bytes=bytes+NEW.bytes,events=events+1 WHERE id=1;
 INSERT INTO requests(scope_id,request_id,session_id,user_entry_id,session_file,recorded_at,last_stage,event_count)
 VALUES(NEW.scope_id,NEW.request_id,json_extract(NEW.metadata_json,'$.sessionId'),json_extract(NEW.metadata_json,'$.userEntryId'),json_extract(NEW.metadata_json,'$.sessionFile'),NEW.recorded_at,json_extract(NEW.metadata_json,'$.type'),1)
 ON CONFLICT(scope_id,request_id) DO UPDATE SET
 user_entry_id=coalesce(excluded.user_entry_id,requests.user_entry_id),session_file=coalesce(excluded.session_file,requests.session_file),
 last_stage=CASE WHEN excluded.recorded_at>=requests.recorded_at THEN excluded.last_stage ELSE requests.last_stage END,
 recorded_at=max(requests.recorded_at,excluded.recorded_at),event_count=requests.event_count+1;
END;
CREATE TRIGGER IF NOT EXISTS evidence_delete AFTER DELETE ON events BEGIN
 UPDATE accounting SET bytes=bytes-OLD.bytes,events=events-1 WHERE id=1;
 UPDATE requests SET event_count=event_count-1 WHERE scope_id=OLD.scope_id AND request_id=OLD.request_id;
 DELETE FROM requests WHERE scope_id=OLD.scope_id AND request_id=OLD.request_id AND event_count=0;
END;`;

// An indexed diagnostic archive, not a knowledge store. JSONL originals are
// read-only recovery sources; their reserved bytes also reduce the live budget.
export class EvidenceStore {
  readonly config: Readonly<EvidenceConfig>;
  readonly path: string;
  private initialized: Promise<void> | undefined;
  private migrating: Promise<void> | undefined;
  private migration: MigrationStatus = {
    state: "pending",
    files: 0,
    imported: 0,
    skipped: 0,
    unrecognized: 0,
  };
  private legacyFiles: LegacyFile[] = [];
  private legacyBytes = 0;
  private diskBytes = 0;
  private readonly controller = new AbortController();
  private closed = false;
  constructor(config: EvidenceConfig) {
    this.config = Object.freeze({ ...config });
    this.path = join(config.directory, "evidence.sqlite");
  }
  status() {
    return {
      backend: "sqlite",
      migration: { ...this.migration },
      preservedLegacyBytes: this.legacyBytes,
      lastMeasuredDiskBytes: this.diskBytes,
    };
  }
  private reserve() {
    return Math.max(
      64 * 1024,
      Math.min(16 * 1024 * 1024, Math.floor(this.config.maxBytes / 8)),
    );
  }
  private budget() {
    return this.config.maxBytes - this.legacyBytes - this.reserve();
  }
  private async secureRoot() {
    await mkdir(this.config.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.config.directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new MemoryError("evidence-unsafe-storage");
  }
  private async checkFiles() {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try {
        const info = await lstat(this.path + suffix);
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          info.nlink !== 1 ||
          (info.mode & 0o077) !== 0 ||
          (process.getuid && info.uid !== process.getuid())
        )
          throw new MemoryError("evidence-unsafe-storage");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  private async ready() {
    if (this.closed) throw new MemoryError("evidence-closed");
    if (!this.initialized) this.initialized = this.initialize();
    await this.initialized;
    if (this.closed) throw new MemoryError("evidence-closed");
  }
  private async initialize() {
    await this.secureRoot();
    this.legacyFiles = await legacyInventory(this.config.directory);
    this.legacyBytes = this.legacyFiles.reduce(
      (sum, file) => sum + file.size,
      0,
    );
    if (this.budget() < 128 * 1024)
      throw new MemoryError("evidence-budget-too-small");
    const release = await acquireCatalogLock(
      join(this.config.directory, ".evidence-sqlite-init.lock"),
    );
    try {
      await this.checkFiles();
      let created = false;
      try {
        const file = await open(
          this.path,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        await file.close();
        created = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (!created) {
        const probe = new DatabaseSync(this.path, { readOnly: true });
        try {
          if (
            Number(
              probe.prepare("PRAGMA application_id").get()?.application_id,
            ) !== applicationId ||
            Number(probe.prepare("PRAGMA user_version").get()?.user_version) > 1
          )
            throw new MemoryError("evidence-foreign-database");
        } finally {
          probe.close();
        }
      }
      const db = new DatabaseSync(this.path);
      try {
        db.exec(
          `PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;`,
        );
        if (created)
          db.exec(
            `PRAGMA auto_vacuum=FULL; PRAGMA application_id=${applicationId};`,
          );
        if (Number(db.prepare("PRAGMA auto_vacuum").get()?.auto_vacuum) !== 1)
          throw new MemoryError("evidence-incompatible-database");
        db.exec("PRAGMA journal_mode=WAL;");
        this.transaction(db, () => {
          db.exec(schema);
          db.exec("PRAGMA user_version=1;");
        });
      } finally {
        db.close();
      }
    } finally {
      await release();
    }
    await this.checkFiles();
  }
  private async connect(readOnly = false) {
    await this.ready();
    await this.secureRoot();
    await this.checkFiles();
    const db = new DatabaseSync(this.path, { readOnly });
    try {
      if (
        Number(db.prepare("PRAGMA application_id").get()?.application_id) !==
          applicationId ||
        Number(db.prepare("PRAGMA user_version").get()?.user_version) !== 1
      )
        throw new MemoryError("evidence-foreign-database");
      db.exec("PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON;");
      if (readOnly) db.exec("PRAGMA query_only=ON;");
      else
        db.exec(
          `PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=64; PRAGMA journal_size_limit=${Math.floor(this.reserve() / 2)};`,
        );
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }
  private transaction<T>(db: DatabaseSync, action: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = action();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  private usedBytes(db: DatabaseSync) {
    const pages = Number(db.prepare("PRAGMA page_count").get()?.page_count);
    const free = Number(
      db.prepare("PRAGMA freelist_count").get()?.freelist_count,
    );
    return (
      (pages - free) * Number(db.prepare("PRAGMA page_size").get()?.page_size)
    );
  }
  private async physicalBytes() {
    let bytes = this.legacyBytes;
    for (const name of [
      this.path,
      this.path + "-wal",
      this.path + "-shm",
      join(this.config.directory, ".scope-catalog-locks.sqlite"),
      join(this.config.directory, ".scope-catalog-locks.sqlite-wal"),
      join(this.config.directory, ".scope-catalog-locks.sqlite-shm"),
    ]) {
      try {
        bytes += (await stat(name)).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    this.diskBytes = bytes;
    return bytes;
  }
  private insert(db: DatabaseSync, record: EvidenceRecord, legacyKey?: string) {
    const { snapshot, ...data } = record.data;
    if (snapshot !== undefined && typeof snapshot !== "string")
      throw new MemoryError("evidence-invalid-event");
    const bytes = Buffer.byteLength(JSON.stringify(record) + "\n");
    if (bytes > maxEventBytes)
      throw new MemoryError("evidence-event-too-large");
    const inserted = db
      .prepare(
        "INSERT OR IGNORE INTO events(scope_id,request_id,recorded_at,bytes,metadata_json,has_body,legacy_key) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        record.scopeId,
        record.requestId,
        Date.parse(record.recordedAt),
        bytes,
        JSON.stringify({ ...record, data }),
        typeof snapshot === "string" ? 1 : 0,
        legacyKey ?? null,
      );
    if (inserted.changes && typeof snapshot === "string")
      db.prepare("INSERT INTO bodies(event_id,snapshot) VALUES(?,?)").run(
        inserted.lastInsertRowid,
        snapshot,
      );
    return Number(inserted.changes);
  }
  private prune(db: DatabaseSync, cutoff?: number) {
    return this.transaction(db, () =>
      Number(
        db
          .prepare(
            cutoff === undefined
              ? "DELETE FROM events WHERE event_id IN (SELECT event_id FROM events ORDER BY recorded_at,event_id LIMIT 8)"
              : "DELETE FROM events WHERE event_id IN (SELECT event_id FROM events WHERE recorded_at<? ORDER BY recorded_at,event_id LIMIT 8)",
          )
          .run(...(cutoff === undefined ? [] : [cutoff])).changes,
      ),
    );
  }
  private checkpoint(db: DatabaseSync) {
    // Never wait behind a reader for maintenance. WAL permits the actual write.
    db.exec("PRAGMA busy_timeout=0;");
    try {
      db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    } finally {
      db.exec("PRAGMA busy_timeout=1000;");
    }
  }
  private startMigration() {
    if (!this.migrating) {
      this.migration.state = "running";
      this.migrating = importLegacy(this.config.directory, this.legacyFiles, {
        signal: this.controller.signal,
        status: this.migration,
        reserve: (delta) => {
          this.legacyBytes += delta;
        },
        cursor: async (fileId) => {
          const db = await this.connect(true);
          try {
            const row = db
              .prepare(
                "SELECT offset,last_start,last_hash,header_hash FROM legacy_imports WHERE file_id=?",
              )
              .get(fileId);
            return row
              ? {
                  offset: Number(row.offset),
                  lastStart: Number(row.last_start),
                  lastHash: String(row.last_hash),
                  headerHash: String(row.header_hash),
                }
              : undefined;
          } finally {
            db.close();
          }
        },
        commit: (batch) => this.commitLegacy(batch),
      }).then(
        () => {
          this.migration.state = "ready";
        },
        (error) => {
          this.migration.state = this.controller.signal.aborted
            ? "cancelled"
            : "failed";
          this.migration.code =
            error instanceof MemoryError
              ? error.code
              : "evidence-migration-failed";
        },
      );
    }
    return this.migrating;
  }
  private async commitLegacy(batch: LegacyBatch) {
    const db = await this.connect();
    try {
      return this.transaction(db, () => {
        const prior = db
          .prepare("SELECT offset FROM legacy_imports WHERE file_id=?")
          .get(batch.fileId);
        const offset = prior ? Number(prior.offset) : 0;
        if (offset > batch.offset) return { imported: 0, skipped: 0 };
        let invalid = 0,
          imported = 0,
          skipped = 0;
        for (const row of batch.rows) {
          if (row.end <= offset) continue;
          if (!row.record) {
            invalid++;
            skipped++;
            continue;
          }
          if (
            Date.parse(row.record.recordedAt) >=
            Date.now() - this.config.retentionDays * 86400000
          )
            imported += this.insert(
              db,
              row.record,
              `${batch.fileId}:${row.start}`,
            );
          else skipped++;
        }
        if (this.usedBytes(db) > this.budget())
          throw new MemoryError("evidence-migration-needs-space");
        db.prepare(`INSERT INTO legacy_imports VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(file_id) DO UPDATE SET
          offset=excluded.offset,last_start=excluded.last_start,last_hash=excluded.last_hash,invalid_count=legacy_imports.invalid_count+?,partial_tail=excluded.partial_tail`).run(
          batch.fileId,
          batch.scopeId,
          batch.headerHash,
          batch.path,
          batch.offset,
          batch.lastStart,
          batch.lastHash,
          invalid,
          batch.partial ? 1 : 0,
          invalid,
        );
        return { imported, skipped };
      });
    } finally {
      db.close();
    }
  }
  async migrateLegacy() {
    await this.ready();
    await this.startMigration();
    return { ...this.migration };
  }
  async append(event: EvidenceEvent): Promise<void> {
    if (containsSecretData(event))
      throw new MemoryError("evidence-secret-blocked");
    if (
      !stages.has(event.type) ||
      ![event.requestId, event.scopeId, event.projectId, event.sessionId].every(
        (value) => value.length > 0 && value.length <= 256,
      )
    )
      throw new MemoryError("evidence-invalid-event");
    const record: EvidenceRecord = {
      ...event,
      format: evidenceFormat,
      recordedAt: new Date().toISOString(),
      implementation: await sourceIdentity(),
    };
    const bytes = Buffer.byteLength(JSON.stringify(record) + "\n");
    if (bytes > Math.min(maxEventBytes, this.config.maxBytes - 512))
      throw new MemoryError("evidence-event-too-large");
    const db = await this.connect();
    try {
      if (bytes * 2 + 64 * 1024 > this.budget())
        throw new MemoryError("evidence-budget-too-small");
      this.prune(db, Date.now() - this.config.retentionDays * 86400000);
      let committed = false;
      for (let attempt = 0; attempt < 512; attempt++) {
        this.checkpoint(db);
        if (
          (await this.physicalBytes()) + bytes * 2 + 64 * 1024 >
          this.config.maxBytes
        ) {
          if (!this.prune(db)) throw new MemoryError("evidence-storage-busy");
          await yieldLoop();
          continue;
        }
        try {
          this.transaction(db, () => {
            this.insert(db, record);
            if (this.usedBytes(db) > this.budget())
              throw new MemoryError("evidence-quota-retry");
          });
          committed = true;
          break;
        } catch (error) {
          if (
            !(
              error instanceof MemoryError &&
              error.code === "evidence-quota-retry"
            )
          )
            throw error;
          if (!this.prune(db))
            throw new MemoryError("evidence-budget-too-small");
          await yieldLoop();
        }
      }
      if (!committed)
        throw new MemoryError("evidence-quota-maintenance-pending");
      this.checkpoint(db);
      await this.physicalBytes();
    } finally {
      db.close();
    }
    void this.startMigration();
  }
  async read(scopeId: string, requestId?: string, offset = 0, limit = 5) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 50
    )
      throw new MemoryError("evidence-invalid-page");
    await this.ready();
    await this.startMigration();
    const db = await this.connect(true);
    let incompleteRecords = 0;
    const migration = { ...this.migration };
    try {
      db.exec("BEGIN");
      const cutoff = Date.now() - this.config.retentionDays * 86400000;
      incompleteRecords = Number(
        db
          .prepare(
            "SELECT coalesce(sum(invalid_count+partial_tail),0) AS total FROM legacy_imports WHERE scope_id=?",
          )
          .get(scopeId)?.total ?? 0,
      );
      if (requestId) {
        const total = Number(
          db
            .prepare(
              "SELECT count(*) AS total FROM events WHERE scope_id=? AND request_id=? AND recorded_at>=?",
            )
            .get(scopeId, requestId, cutoff)?.total ?? 0,
        );
        const rows = db
          .prepare(
            "SELECT event_id,bytes,metadata_json,has_body FROM events WHERE scope_id=? AND request_id=? AND recorded_at>=? ORDER BY recorded_at,event_id LIMIT ? OFFSET ?",
          )
          .all(scopeId, requestId, cutoff, limit, offset);
        const events: EvidenceRecord[] = [];
        let bytes = 0,
          consumed = 0;
        for (const row of rows) {
          const size = Number(row.bytes),
            eventId = Number(row.event_id);
          if (
            !Number.isSafeInteger(eventId) ||
            eventId < 1 ||
            !Number.isSafeInteger(size) ||
            size < 1 ||
            size > maxEventBytes
          ) {
            consumed++;
            incompleteRecords++;
            continue;
          }
          if (bytes + size > 512 * 1024) break;
          consumed++;
          let record: unknown;
          try {
            record = JSON.parse(String(row.metadata_json));
          } catch {
            incompleteRecords++;
            continue;
          }
          if (
            !isRecord(record) ||
            record.scopeId !== scopeId ||
            record.requestId !== requestId
          ) {
            incompleteRecords++;
            continue;
          }
          if (Number(row.has_body) === 1) {
            const body = db
              .prepare(
                "SELECT snapshot FROM bodies WHERE event_id=? AND length(CAST(snapshot AS BLOB))<=?",
              )
              .get(eventId, maxEventBytes);
            if (!body || typeof body.snapshot !== "string") {
              incompleteRecords++;
              continue;
            }
            record.data.snapshot = body.snapshot;
          }
          if (containsSecretData(record)) {
            incompleteRecords++;
            continue;
          }
          events.push(record);
          bytes += size;
        }
        return {
          events,
          total,
          nextOffset: offset + consumed < total ? offset + consumed : null,
          incompleteRecords,
          migration,
        };
      }
      const total = Number(
        db
          .prepare(
            "SELECT count(*) AS total FROM requests WHERE scope_id=? AND recorded_at>=?",
          )
          .get(scopeId, cutoff)?.total ?? 0,
      );
      const rows = db
        .prepare(
          "SELECT request_id,session_id,user_entry_id,recorded_at,last_stage FROM requests WHERE scope_id=? AND recorded_at>=? ORDER BY recorded_at DESC,request_id LIMIT ? OFFSET ?",
        )
        .all(scopeId, cutoff, limit, offset);
      const requests = rows
        .map((row) => ({
          requestId: String(row.request_id),
          sessionId: String(row.session_id),
          userEntryId:
            row.user_entry_id === null ? undefined : String(row.user_entry_id),
          recordedAt: new Date(Number(row.recorded_at)).toISOString(),
          lastStage: String(row.last_stage),
        }))
        .filter((value) => {
          if (containsSecretData(value)) {
            incompleteRecords++;
            return false;
          }
          return true;
        });
      return {
        requests,
        total,
        nextOffset: offset + rows.length < total ? offset + rows.length : null,
        incompleteRecords,
        migration,
      };
    } finally {
      db.exec("ROLLBACK");
      db.close();
    }
  }
  async close() {
    this.closed = true;
    this.controller.abort();
    await this.migrating;
  }
}
