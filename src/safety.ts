// A conservative initial guard, not a comprehensive DLP guarantee.
// Apply to outbound query text and inbound memory content; never log matches.
const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\b(?:sk-|ghp_|github_pat_|glpat-)[A-Za-z0-9_-]{16,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/i,
  /\b(?:api[_-]?key|access[_-]?token|password|secret)\s*["']?\s*[:=]\s*["']?[^\s"',;]{8,}/i,
];

export function containsSecret(text: string): boolean {
  // JSON-escaped separators otherwise put a word character (`n`/`t`) right
  // before a token and defeat the word boundary in the raw-text patterns.
  const separated = text.replace(/\\[nrt]/g, "\n");
  return patterns.some(
    (pattern) => pattern.test(text) || pattern.test(separated),
  );
}

// Inspect original string values too: serialized JSON can hide quoted labels
// inside a conversation field. The caller supplies bounded JSON-shaped data.
export function containsSecretData(value: unknown): boolean {
  if (typeof value === "string") return containsSecret(value);
  if (Array.isArray(value)) return value.some(containsSecretData);
  if (value && typeof value === "object") {
    return (
      containsSecret(JSON.stringify(value)) ||
      Object.values(value).some(containsSecretData)
    );
  }
  return false;
}
