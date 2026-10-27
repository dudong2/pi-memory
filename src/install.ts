import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadInstalledConfig } from "./config.ts";
import { resolveIdentity } from "./identity.ts";
import { MemoryError } from "./contracts.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import type { MemoryRuntime } from "./runtime.ts";
import { ensureScopeRegistration, registerManagement } from "./management.ts";

export default async function installMemory(pi: ExtensionAPI): Promise<void> {
  const config = await loadInstalledConfig();
  if (!config) return;
  registerManagement(pi, config);
  let active = false;
  let lateRuntime: MemoryRuntime | undefined;
  const activate = async (late: boolean) => {
    if (active) return;
    const { registerMemory } = await import("./index.ts");
    if (late) {
      const { MemoryRuntime } = await import("./runtime.ts");
      lateRuntime = new MemoryRuntime();
      // The onboarding hook owns session initialization after late activation.
      registerMemory(pi, lateRuntime, false);
    } else registerMemory(pi);
    active = true;
  };
  // Discovery compatibility only; no parallel skill-management subsystem.
  pi.on("resources_discover", async (event) => {
    let identity: Awaited<ReturnType<typeof resolveIdentity>>;
    try {
      identity = await resolveIdentity(event.cwd, config.catalogPath);
    } catch (error) {
      if (error instanceof MemoryError) return {};
      throw error;
    }
    const path = join(
      homedir(),
      ".pi",
      "agent",
      "projects-memory",
      identity.scopeId,
      "skills",
    );
    try {
      return (await stat(path)).isDirectory() ? { skillPaths: [path] } : {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  });
  // An unregistered location gets only management/onboarding hooks. It cannot
  // contact Hindsight or expose memory tools before interactive consent.
  pi.on("session_start", async (_event, ctx) => {
    try {
      if (!(await ensureScopeRegistration(config, ctx))) return;
      if (!active) await activate(true);
      if (lateRuntime) {
        lateRuntime.reset();
        await lateRuntime.resume({
          cwd: ctx.cwd,
          sessionId: ctx.sessionManager.getSessionId(),
          prompt: "",
        });
      }
    } catch {
      if (ctx.hasUI)
        ctx.ui.notify(
          "메모리 Scope 등록·초기화를 완료하지 못했습니다. 기존 ID·마커·경로·카탈로그의 일치 여부를 확인하세요.",
          "warning",
        );
    }
  });
  try {
    await resolveIdentity(process.cwd(), config.catalogPath);
    await activate(false);
  } catch (error) {
    if (
      error instanceof MemoryError &&
      ["scope-unregistered", "scope-path-mismatch"].includes(error.code)
    )
      return;
    throw error;
  }
}
