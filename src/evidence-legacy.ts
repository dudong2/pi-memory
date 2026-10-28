import { constants, type Stats } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { MemoryError } from "./contracts.ts";
import { containsSecretData } from "./safety.ts";
import { acquireCatalogLock } from "./scope/catalog-lock.ts";
import {
  dictionary,
  evidenceFormat,
  isRecord,
  legacyName,
  maxEventBytes,
  type EvidenceRecord,
} from "./evidence-format.ts";

export interface LegacyFile {
  path: string;
  size: number;
}
export interface LegacyCursor {
  offset: number;
  lastStart: number;
  lastHash: string;
  headerHash: string;
}
export interface LegacyRow {
  start: number;
  end: number;
  hash: string;
  record?: EvidenceRecord;
}
export interface LegacyBatch {
  fileId: string;
  scopeId: string;
  headerHash: string;
  path: string;
  rows: LegacyRow[];
  offset: number;
  lastStart: number;
  lastHash: string;
  partial: boolean;
}
export interface MigrationStatus {
  state: "pending" | "running" | "ready" | "failed" | "cancelled";
  files: number;
  imported: number;
  skipped: number;
  unrecognized: number;
  code?: string;
}
export async function legacyInventory(
  directory: string,
): Promise<LegacyFile[]> {
  const files: LegacyFile[] = [];
  for (const name of (await readdir(directory)).sort()) {
    if (!legacyName.test(name)) continue;
    const path = join(directory, name);
    let info: Stats;
    try {
      info = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid()) ||
      info.size > 4 * 1024 * 1024
    )
      throw new MemoryError("evidence-unsafe-legacy");
    files.push({ path, size: info.size });
  }
  return files;
}
const hash = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

// Only the descriptor and its byte boundary are captured under the old writer
// lock. Parsing/importing never holds that lock. Originals are never modified.
export async function importLegacy(
  directory: string,
  files: LegacyFile[],
  hooks: {
    signal: AbortSignal;
    status: MigrationStatus;
    cursor: (fileId: string) => Promise<LegacyCursor | undefined>;
    commit: (
      batch: LegacyBatch,
    ) => Promise<{ imported: number; skipped: number }>;
    reserve: (delta: number) => void;
  },
): Promise<void> {
  for (const source of files) {
    hooks.signal.throwIfAborted();
    const release = await acquireCatalogLock(
      join(directory, ".evidence-writer.lock"),
    );
    let file: Awaited<ReturnType<typeof open>> | undefined;
    let size = 0;
    try {
      const info = await lstat(source.path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        (info.mode & 0o077) !== 0 ||
        info.size > 4 * 1024 * 1024
      )
        throw new MemoryError("evidence-unsafe-legacy");
      file = await open(source.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const checked = await file.stat();
      if (checked.dev !== info.dev || checked.ino !== info.ino)
        throw new MemoryError("evidence-unsafe-legacy");
      size = checked.size;
    } catch (error) {
      await file?.close();
      file = undefined;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hooks.status.unrecognized++;
    } finally {
      await release();
    }
    if (!file) continue;
    try {
      hooks.reserve(Math.max(0, size - source.size));
      const buffer = Buffer.alloc(size);
      let read = 0;
      while (read < size) {
        const part = await file.read(buffer, read, size - read, read);
        if (!part.bytesRead) throw new MemoryError("evidence-legacy-truncated");
        read += part.bytesRead;
      }
      const headerEnd = buffer.indexOf(10);
      if (headerEnd < 0 || headerEnd > 4096) {
        hooks.status.unrecognized++;
        continue;
      }
      let header: unknown;
      try {
        header = JSON.parse(buffer.subarray(0, headerEnd).toString("utf8"));
      } catch {
        hooks.status.unrecognized++;
        continue;
      }
      const match = legacyName.exec(source.path.split(/[\\/]/).at(-1) ?? "");
      if (
        !dictionary(header) ||
        header.format !== evidenceFormat ||
        header.fileId !== match?.[1] ||
        typeof header.scopeId !== "string"
      ) {
        hooks.status.unrecognized++;
        continue;
      }
      const fileId = String(header.fileId),
        scopeId = header.scopeId;
      const headerHash = hash(buffer.subarray(0, headerEnd + 1));
      const cursor = await hooks.cursor(fileId);
      if (
        cursor &&
        (cursor.headerHash !== headerHash ||
          cursor.offset > size ||
          cursor.offset < headerEnd + 1 ||
          (cursor.lastHash &&
            hash(buffer.subarray(cursor.lastStart, cursor.offset)) !==
              cursor.lastHash))
      )
        throw new MemoryError("evidence-legacy-changed");
      let position = cursor?.offset ?? headerEnd + 1;
      let lastStart = cursor?.lastStart ?? position,
        lastHash = cursor?.lastHash ?? "";
      let rows: LegacyRow[] = [],
        batchBytes = 0;
      const commit = async (partial: boolean) => {
        hooks.signal.throwIfAborted();
        const result = await hooks.commit({
          fileId,
          scopeId,
          headerHash,
          path: source.path,
          rows,
          offset: position,
          lastStart,
          lastHash,
          partial,
        });
        hooks.status.imported += result.imported;
        hooks.status.skipped += result.skipped;
        rows = [];
        batchBytes = 0;
      };
      while (position < size) {
        hooks.signal.throwIfAborted();
        const end = buffer.indexOf(10, position);
        if (end < 0) break;
        const raw = buffer.subarray(position, end + 1);
        let value: unknown;
        if (raw.length <= maxEventBytes) {
          try {
            value = JSON.parse(raw.toString("utf8"));
          } catch {
            /* Retain the original and count malformed evidence. */
          }
        }
        const record =
          isRecord(value) &&
          value.scopeId === scopeId &&
          !containsSecretData(value)
            ? value
            : undefined;
        lastStart = position;
        lastHash = hash(raw);
        rows.push({ start: position, end: end + 1, hash: lastHash, record });
        position = end + 1;
        batchBytes += raw.length;
        if (rows.length >= 32 || batchBytes >= 512 * 1024) await commit(false);
      }
      await commit(position < size);
      hooks.status.files++;
    } finally {
      await file.close();
    }
  }
}
