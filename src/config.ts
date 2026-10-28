import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import {
  type MemoryConfig,
  MemoryError,
  nonempty,
  object,
} from "./contracts.ts";

function integer(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  ) {
    throw new MemoryError("invalid-config");
  }
  return value as number;
}

export function safeEndpoint(value: unknown): string {
  let url: URL;
  try {
    url = new URL(nonempty(value));
  } catch {
    throw new MemoryError("invalid-endpoint");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new MemoryError("unsafe-endpoint");
  return url.href.replace(/\/$/, "");
}

export function parseConfig(value: unknown): MemoryConfig {
  const data = object(value);
  // A typo must not silently select a wider scope or send data to a default server.
  const keys = [
    "endpoint",
    "bankId",
    "catalogPath",
    "apiKeyEnv",
    "apiKeyFile",
    "startupModels",
    "scopeModels",
    "timeoutMs",
    "maxContextBytes",
    "outboxPath",
    "evidence",
  ];
  if (Object.keys(data).some((key) => !keys.includes(key)))
    throw new MemoryError("invalid-config");
  const catalogPath = nonempty(data.catalogPath);
  if (!isAbsolute(catalogPath))
    throw new MemoryError("catalog-path-not-absolute");
  const scopeModels: Record<string, string> = Object.create(null);
  for (const [scopeId, model] of Object.entries(
    object(data.scopeModels ?? {}),
  )) {
    scopeModels[scopeId] = nonempty(model);
  }
  const config: MemoryConfig = {
    endpoint: safeEndpoint(data.endpoint),
    bankId: nonempty(data.bankId),
    catalogPath,
    scopeModels,
    timeoutMs: integer(data.timeoutMs, 5000, 10, 30000),
    // Conservative UTF-8 byte ceiling, not a measured model-token count.
    maxContextBytes: integer(data.maxContextBytes, 16000, 2048, 64000),
  };
  if (data.outboxPath !== undefined) {
    config.outboxPath = nonempty(data.outboxPath);
    if (!isAbsolute(config.outboxPath))
      throw new MemoryError("outbox-path-not-absolute");
  }
  if (data.apiKeyEnv !== undefined) {
    const key = nonempty(data.apiKeyEnv);
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key))
      throw new MemoryError("invalid-key-env");
    config.apiKeyEnv = key;
  }
  if (data.apiKeyFile !== undefined) {
    config.apiKeyFile = nonempty(data.apiKeyFile);
    if (!isAbsolute(config.apiKeyFile) || config.apiKeyEnv)
      throw new MemoryError("invalid-credential-source");
  }
  if (data.startupModels !== undefined) {
    if (typeof data.startupModels !== "boolean")
      throw new MemoryError("invalid-config");
    if (data.startupModels && !config.outboxPath)
      throw new MemoryError("startup-requires-delivery");
    config.startupModels = data.startupModels;
  }
  if (data.evidence !== undefined) {
    const evidence = object(data.evidence);
    if (
      Object.keys(evidence).some(
        (key) => !["directory", "retentionDays", "maxBytes"].includes(key),
      )
    )
      throw new MemoryError("invalid-evidence-config");
    const directory = nonempty(evidence.directory);
    if (!isAbsolute(directory))
      throw new MemoryError("evidence-path-not-absolute");
    config.evidence = {
      directory,
      retentionDays: integer(evidence.retentionDays, 30, 1, 3650),
      maxBytes: integer(
        evidence.maxBytes,
        256 * 1024 * 1024,
        256 * 1024,
        1024 * 1024 * 1024,
      ),
    };
  }
  return config;
}

export async function loadInstalledConfig(): Promise<MemoryConfig | undefined> {
  if (process.env.PI_MEMORY_CONFIG)
    return loadConfig(process.env.PI_MEMORY_CONFIG);
  const path = join(homedir(), ".config", "pi-memory", "config.json");
  try {
    await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new MemoryError("config-unreadable");
  }
  return loadConfig(path);
}

export async function loadConfig(
  path: string | undefined,
): Promise<MemoryConfig | undefined> {
  if (!path) return undefined;
  try {
    return parseConfig(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    throw new MemoryError("config-unreadable");
  }
}
