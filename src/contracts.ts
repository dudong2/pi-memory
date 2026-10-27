export class MemoryError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`Memory unavailable: ${code}`);
    this.name = "MemoryError";
    this.code = code;
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MemoryError("invalid-data");
  }
  return value as Record<string, unknown>;
}

export function nonempty(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new MemoryError("invalid-data");
  }
  return value;
}

export function tags(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((tag) => typeof tag === "string" && tag.trim())
  ) {
    throw new MemoryError("invalid-tags");
  }
  return [...new Set(value as string[])].sort();
}

export function sameTags(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    JSON.stringify([...new Set(left)].sort()) ===
    JSON.stringify([...new Set(right)].sort())
  );
}

export interface Identity {
  scopeId: string;
  projectId: string;
  scopeTag: string;
  root: string;
}

export interface CoreBinding {
  modelId: string;
  tags: string[];
}

export interface MemoryConfig {
  endpoint: string;
  bankId: string;
  catalogPath: string;
  apiKeyEnv?: string;
  apiKeyFile?: string;
  startupModels?: boolean;
  common?: CoreBinding;
  scopeModels: Record<string, string>;
  timeoutMs: number;
  maxContextBytes: number;
  outboxPath?: string;
}

export interface MentalModel {
  id: string;
  bank_id: string;
  content: string | null;
  tags: string[];
  is_stale: boolean | null;
  last_refreshed_at: string | null;
  last_memory_seen_at: string | null;
  last_refresh_failed_at: string | null;
}

export interface Fact {
  id: string;
  text: string;
  tags: string[];
  type: "observation" | "world" | "experience";
  document_id?: string;
  source_fact_ids?: string[];
  mentioned_at?: string;
  metadata?: Record<string, string>;
}

export interface RecallRequest {
  query: string;
  types: Fact["type"][];
  budget: "mid";
  max_tokens: number;
  prefer_observations: boolean;
  tag_groups: [{ or: { tags: string[]; match: "exact" }[] }];
}

export interface MemoryReader {
  getModel(id: string, signal: AbortSignal): Promise<MentalModel | undefined>;
  recall(request: RecallRequest, signal: AbortSignal): Promise<Fact[]>;
}

export interface MemoryWriter {
  readonly destinationIdentity?: string;
  retain(
    request: import("./outbox.ts").RetainRequest,
    signal: AbortSignal,
  ): Promise<string>;
  operation(
    id: string,
    signal: AbortSignal,
  ): Promise<
    | "not_found"
    | "pending"
    | "processing"
    | "completed"
    | "failed"
    | "cancelled"
  >;
  reflect(request: RecallRequest, signal: AbortSignal): Promise<string>;
}

export type CoreStatus =
  | "ready"
  | "missing"
  | "empty"
  | "stale"
  | "unknown-freshness"
  | "refresh-failed"
  | "updates-pending"
  | "scope-mismatch"
  | "budget-exceeded"
  | "secret-blocked"
  | "unavailable";

export interface CoreResult {
  kind: "common" | "scope";
  modelId?: string;
  status: CoreStatus;
  refreshedAt?: string | null;
  memorySeenAt?: string | null;
}

export interface PreparedContext {
  text: string;
  core: CoreResult[];
  recall:
    | "found"
    | "empty"
    | "unavailable"
    | "secret-blocked"
    | "query-too-large";
  omitted: number;
}
