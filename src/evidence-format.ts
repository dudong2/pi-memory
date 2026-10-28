import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { MemoryError } from "./contracts.ts";

export const evidenceFormat = "pi-memory-evidence/v1";
export const legacyName = /^pi-memory-evidence-v1-([a-f0-9-]{36})\.jsonl$/;
export const maxEventBytes = 256 * 1024;
export const stages = new Set([
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
export function dictionary(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function isRecord(value: unknown): value is EvidenceRecord {
  return (
    dictionary(value) &&
    value.format === evidenceFormat &&
    ["requestId", "scopeId", "projectId", "sessionId", "recordedAt"].every(
      (key) => typeof value[key] === "string",
    ) &&
    typeof value.recordedAt === "string" &&
    Number.isFinite(Date.parse(value.recordedAt)) &&
    typeof value.type === "string" &&
    stages.has(value.type) &&
    dictionary(value.data) &&
    dictionary(value.implementation) &&
    typeof value.implementation.version === "string" &&
    typeof value.implementation.codeId === "string" &&
    /^[a-f0-9]{64}$/.test(value.implementation.codeId)
  );
}
let implementation: Promise<EvidenceRecord["implementation"]> | undefined;
export function sourceIdentity() {
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
