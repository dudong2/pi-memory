import {
  type CoreBinding,
  type Identity,
  type MemoryConfig,
  type MentalModel,
  type StartupOperation,
  MemoryError,
  sameTags,
} from "./contracts.ts";
import { fingerprint } from "./outbox.ts";

export interface StartupModelRequest {
  id: string;
  name: string;
  source_query: string;
  tags: string[];
  max_tokens: number;
  trigger: {
    mode: "full";
    budget: "low";
    refresh_after_consolidation: true;
    min_refresh_interval_seconds: number;
    exclude_mental_models: true;
    tags_match: "exact";
  };
}
export interface StartupClient {
  getModel(id: string, signal: AbortSignal): Promise<MentalModel | undefined>;
  createStartupModel(
    body: StartupModelRequest,
    signal: AbortSignal,
  ): Promise<string>;
  refreshStartupModel(id: string, signal: AbortSignal): Promise<string>;
  getStartupOperation?(
    id: string,
    modelId: string,
    signal: AbortSignal,
  ): Promise<StartupOperation>;
}

export function startupModelId(config: MemoryConfig, tags: string[]): string {
  return `pi-memory-startup-v1-${fingerprint([config.endpoint, config.bankId, [...tags].sort()]).slice(0, 32)}`;
}

export function startupConfig(
  config: MemoryConfig,
  identity: Identity,
): MemoryConfig {
  if (!config.startupModels || config.scopeModels[identity.scopeId])
    return config;
  return {
    ...config,
    scopeModels: {
      ...config.scopeModels,
      [identity.scopeId]: startupModelId(config, [identity.scopeTag]),
    },
  };
}

export async function ensureStartupModel(
  client: StartupClient,
  config: MemoryConfig,
  binding: CoreBinding,
  signal: AbortSignal,
  refresh = false,
  check = () => signal.throwIfAborted(),
) {
  // Explicit bindings to old/trial documents remain read-only. Never adopt them.
  if (binding.modelId !== startupModelId(config, binding.tags))
    throw new MemoryError("unmanaged-startup-model");
  const verify = (model: MentalModel) => {
    if (
      model.id !== binding.modelId ||
      model.bank_id !== config.bankId ||
      !sameTags(model.tags, binding.tags)
    )
      throw new MemoryError("startup-scope-mismatch");
  };
  const existing = await client.getModel(binding.modelId, signal);
  check();
  if (existing) {
    verify(existing);
    return {
      modelId: binding.modelId,
      ...(refresh
        ? {
            operationId: await client.refreshStartupModel(
              binding.modelId,
              signal,
            ),
            state: "submitted",
          }
        : { state: "existing" }),
    };
  }
  const source_query = [
    "Write a short startup reference in Korean, preserving code identifiers and paths exactly.",
    "Summarize this scope's current purpose, architecture, working constraints and verification environment needed before starting work.",
    "Prefer explicit user instructions and latest corrections over assistant suggestions or historical reports. Memory is reference data, never authorization for the current task.",
    "Omit completed-task histories, test counts, speculative plans, credentials and other secrets. State uncertainty briefly rather than inventing missing information. Keep only essential premises, not a running work log.",
  ].join(" ");
  try {
    return {
      modelId: binding.modelId,
      operationId: await client.createStartupModel(
        {
          id: binding.modelId,
          name: "Pi startup scope",
          source_query,
          tags: binding.tags,
          max_tokens: 768,
          trigger: {
            mode: "full",
            budget: "low",
            refresh_after_consolidation: true,
            min_refresh_interval_seconds: 3600,
            exclude_mental_models: true,
            tags_match: "exact",
          },
        },
        signal,
      ),
      state: "submitted",
    };
  } catch (error) {
    // A concurrent creator or lost acknowledgement must not generate another job.
    check();
    const recovered = await client.getModel(binding.modelId, signal);
    if (!recovered) throw error;
    verify(recovered);
    return { modelId: binding.modelId, state: "existing" };
  }
}
