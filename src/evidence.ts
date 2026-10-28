import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { MemoryError, type EvidenceConfig } from "./contracts.ts";
import { containsSecretData } from "./safety.ts";
import { acquireCatalogLock } from "./scope/catalog-lock.ts";

const format = "pi-memory-evidence/v1";
const filename = /^pi-memory-evidence-v1-([a-f0-9-]{36})\.jsonl$/;
const maxFileBytes = 4 * 1024 * 1024;
const stages = new Set([
  "prepared",
  "provider-payload",
  "lookup-result",
  "settled",
  "invalidated",
]);
export interface EvidenceEvent {
  requestId: string;
  scopeId: string;
  projectId: string;
  sessionId: string;
  userEntryId?: string;
  sessionFile?: string;
  type:
    | "prepared"
    | "provider-payload"
    | "lookup-result"
    | "settled"
    | "invalidated";
  data: Record<string, unknown>;
}
export interface EvidenceRecord extends EvidenceEvent {
  format: string;
  recordedAt: string;
  implementation: { version: string; codeId: string };
}
interface Header {
  format: string;
  fileId: string;
  scopeId: string;
}
interface Managed {
  path: string;
  size: number;
  modified: number;
  ino: number;
  header: Header;
}
let implementation: Promise<EvidenceRecord["implementation"]> | undefined;
function sourceIdentity() {
  if (implementation) return implementation;
  implementation = (async () => {
    const hash = createHash("sha256");
    const visit = async (dir: URL): Promise<void> => {
      for (const entry of (await readdir(dir, { withFileTypes: true })).sort(
        (a, b) => a.name.localeCompare(b.name),
      )) {
        const path = new URL(entry.name, dir);
        if (entry.isDirectory()) await visit(new URL(`${entry.name}/`, dir));
        else if (entry.isFile() && entry.name.endsWith(".ts")) {
          hash.update(path.pathname.split("/src/").at(-1) ?? entry.name);
          hash.update(await readFile(path));
        }
      }
    };
    await visit(new URL("./", import.meta.url));
    let pkg: unknown;
    try {
      pkg = JSON.parse(
        await readFile(new URL("../package.json", import.meta.url), "utf8"),
      );
    } catch {
      throw new MemoryError("evidence-source-unavailable");
    }
    if (!dictionary(pkg) || typeof pkg.version !== "string")
      throw new MemoryError("evidence-source-unavailable");
    return { version: pkg.version, codeId: hash.digest("hex") };
  })();
  return implementation;
}
function dictionary(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isRecord(value: unknown): value is EvidenceRecord {
  return (
    dictionary(value) &&
    value.format === format &&
    ["requestId", "scopeId", "projectId", "sessionId", "recordedAt"].every(
      (key) => typeof value[key] === "string",
    ) &&
    typeof value.type === "string" &&
    stages.has(value.type) &&
    dictionary(value.data) &&
    dictionary(value.implementation) &&
    typeof value.implementation.version === "string" &&
    typeof value.implementation.codeId === "string" &&
    /^[a-f0-9]{64}$/.test(value.implementation.codeId)
  );
}

// Diagnostic journal only: never searched as knowledge or sent to Hindsight.
// The existing cross-process/dead-writer-safe lock serializes append + retention.
export class EvidenceStore {
  private readonly targets = new Map<string, string>();
  readonly config: EvidenceConfig;
  constructor(config: EvidenceConfig) {
    this.config = config;
  }
  private async secureRoot(): Promise<void> {
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
  private async managed(): Promise<Managed[]> {
    const result: Managed[] = [];
    for (const name of await readdir(this.config.directory)) {
      const match = filename.exec(name);
      if (!match) continue;
      const path = join(this.config.directory, name);
      const info = await lstat(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid()) ||
        info.size > maxFileBytes
      )
        throw new MemoryError("evidence-unsafe-storage");
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const checked = await file.stat();
        if (checked.ino !== info.ino || checked.dev !== info.dev)
          throw new MemoryError("evidence-unsafe-storage");
        const buffer = Buffer.alloc(4096);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        const first =
          buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0] ??
          "";
        let header: unknown;
        try {
          header = JSON.parse(first);
        } catch {
          continue;
        }
        if (
          !dictionary(header) ||
          header.format !== format ||
          header.fileId !== match[1] ||
          typeof header.scopeId !== "string"
        )
          continue;
        result.push({
          path,
          size: info.size,
          modified: info.mtimeMs,
          ino: info.ino,
          header: { format, fileId: match[1] ?? "", scopeId: header.scopeId },
        });
      } finally {
        await file.close();
      }
    }
    return result.sort(
      (a, b) => a.modified - b.modified || a.path.localeCompare(b.path),
    );
  }
  private async remove(file: Managed): Promise<void> {
    const info = await lstat(file.path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.ino !== file.ino
    )
      throw new MemoryError("evidence-unsafe-storage");
    await unlink(file.path);
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
      format,
      recordedAt: new Date().toISOString(),
      implementation: await sourceIdentity(),
    };
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes > Math.min(256 * 1024, this.config.maxBytes - 512))
      throw new MemoryError("evidence-event-too-large");
    await this.secureRoot();
    const release = await acquireCatalogLock(
      join(this.config.directory, ".evidence-writer.lock"),
    );
    try {
      let files = await this.managed();
      const cutoff = Date.now() - this.config.retentionDays * 86400000;
      for (const file of files.filter((file) => file.modified < cutoff))
        await this.remove(file);
      files = files.filter((file) => file.modified >= cutoff);
      const key = `${event.scopeId}:${record.recordedAt.slice(0, 10)}`;
      let target = files.find((file) => file.path === this.targets.get(key));
      if (
        target &&
        target.size + bytes > Math.min(maxFileBytes, this.config.maxBytes)
      )
        target = undefined;
      const fileId = randomUUID();
      const header = `${JSON.stringify({ format, fileId, scopeId: event.scopeId })}\n`;
      let needed = bytes + (target ? 0 : Buffer.byteLength(header));
      let total = files.reduce((sum, file) => sum + file.size, 0);
      while (total + needed > this.config.maxBytes) {
        const oldest = files.shift();
        if (!oldest) throw new MemoryError("evidence-budget-exceeded");
        await this.remove(oldest);
        total -= oldest.size;
        if (target?.path === oldest.path) {
          target = undefined;
          needed = bytes + Buffer.byteLength(header);
        }
      }
      const path =
        target?.path ??
        join(this.config.directory, `pi-memory-evidence-v1-${fileId}.jsonl`);
      const handle = await open(
        path,
        target
          ? constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW
          : constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_EXCL |
              constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const info = await handle.stat();
        if (
          !info.isFile() ||
          info.nlink !== 1 ||
          (info.mode & 0o077) !== 0 ||
          (target && info.ino !== target.ino)
        )
          throw new MemoryError("evidence-unsafe-storage");
        await handle.writeFile(`${target ? "" : header}${line}`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.targets.set(key, path);
    } catch (error) {
      // A failed append can leave a partial tail. Never append another event to
      // that segment; readers report its incomplete tail and a new segment is used.
      this.targets.clear();
      throw error;
    } finally {
      await release();
    }
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
    await this.secureRoot();
    const release = await acquireCatalogLock(
      join(this.config.directory, ".evidence-writer.lock"),
    );
    const events: EvidenceRecord[] = [];
    const summaries = new Map<
      string,
      {
        requestId: string;
        sessionId: string;
        userEntryId?: string;
        recordedAt: string;
        lastStage: string;
      }
    >();
    let total = 0,
      pageBytes = 0,
      pageFull = false,
      incompleteRecords = 0;
    try {
      for (const file of await this.managed()) {
        if (file.modified < Date.now() - this.config.retentionDays * 86400000) {
          await this.remove(file);
          continue;
        }
        if (file.header.scopeId !== scopeId) continue;
        const handle = await open(
          file.path,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const info = await handle.stat();
          if (info.ino !== file.ino || info.nlink !== 1)
            throw new MemoryError("evidence-unsafe-storage");
          const lines = (await handle.readFile("utf8")).split("\n");
          lines.shift();
          if (lines.at(-1) === "") lines.pop();
          else {
            lines.pop();
            incompleteRecords++;
          }
          for (const line of lines) {
            let value: unknown;
            try {
              value = JSON.parse(line);
            } catch {
              incompleteRecords++;
              continue;
            }
            if (
              !isRecord(value) ||
              value.scopeId !== scopeId ||
              containsSecretData(value)
            ) {
              incompleteRecords++;
              continue;
            }
            if (requestId) {
              if (value.requestId !== requestId) continue;
              const size = Buffer.byteLength(line);
              if (total >= offset && events.length < limit && !pageFull) {
                if (pageBytes + size > 512 * 1024) pageFull = true;
                else {
                  events.push(value);
                  pageBytes += size;
                }
              }
              total++;
            } else {
              const previous = summaries.get(value.requestId);
              if (!previous || previous.recordedAt <= value.recordedAt)
                summaries.set(value.requestId, {
                  requestId: value.requestId,
                  sessionId: value.sessionId,
                  userEntryId: value.userEntryId ?? previous?.userEntryId,
                  recordedAt: value.recordedAt,
                  lastStage: value.type,
                });
            }
          }
        } finally {
          await handle.close();
        }
      }
    } finally {
      await release();
    }
    if (requestId)
      return {
        events,
        total,
        nextOffset:
          offset + events.length < total ? offset + events.length : null,
        incompleteRecords,
      };
    const requests = [...summaries.values()].sort((a, b) =>
      b.recordedAt.localeCompare(a.recordedAt),
    );
    return {
      requests: requests.slice(offset, offset + limit),
      total: requests.length,
      nextOffset: offset + limit < requests.length ? offset + limit : null,
      incompleteRecords,
    };
  }
}
