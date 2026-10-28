import { containsSecret } from "./safety.ts";

// Identifiers are the only backend strings retained by diagnostics. Withhold
// malformed/secret-like IDs instead of turning this into another content store.
export function safeRecordIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].filter(
    (id) => id.trim().length > 0 && id.length <= 256 && !containsSecret(id),
  );
}

// Inspect, never retain, the SDK's provider payload. A non-match is inconclusive:
// a provider or another extension may have transformed/split the reference.
export function payloadContainsReference(
  payload: unknown,
  text: string,
): boolean {
  if (!text) return false;
  const pending: unknown[] = [payload];
  const seen = new Set<object>();
  let inspected = 0;
  try {
    while (pending.length && inspected++ < 20_000) {
      const value = pending.pop();
      if (typeof value === "string" && value.includes(text)) return true;
      if (value && typeof value === "object" && !seen.has(value)) {
        seen.add(value);
        pending.push(...Object.values(value));
      }
    }
  } catch {
    // Diagnostics must not interrupt a model request, including for unusual
    // non-JSON payloads with throwing getters.
  }
  return false;
}
