import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { type MemoryConfig, MemoryError } from "./contracts.ts";
import { resolveIdentity } from "./identity.ts";
import {
  createProject,
  createScope,
  loadScopeCatalog,
  projectByName,
  qualifiedScopeName,
  readScopeMarker,
  reassignScopeProject,
  rebindScopeRepositoryId,
  removeProjectIfEmpty,
  updateScopeLocation,
  type ProjectRecord,
  type ScopeCatalog,
} from "./scope/catalog.ts";
import { resolveGitContext } from "./scope/git.ts";

function location(config: MemoryConfig) {
  return { catalogPath: config.catalogPath };
}
const newProjectLabel = "새 Project 만들기";

function contextGuard(ctx: ExtensionContext): () => void {
  const cwd = ctx.cwd,
    sessionId = ctx.sessionManager.getSessionId();
  return () => {
    ctx.signal?.throwIfAborted();
    if (ctx.cwd !== cwd || ctx.sessionManager.getSessionId() !== sessionId)
      throw new Error("scope-management-context-changed");
  };
}

async function registrationRoot(cwd: string): Promise<string> {
  let current = await realpath(cwd);
  for (;;) {
    for (const name of [".pi-memory-scope.json", ".git"]) {
      try {
        await lstat(join(current, name));
        return current;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const parent = dirname(current);
    if (parent === current) return realpath(cwd);
    current = parent;
  }
}

// Only routing records are backed up. No credentials, memory bodies, sessions,
// backend data or skills are changed by these membership operations.
async function backup(config: MemoryConfig, paths: string[]): Promise<void> {
  const directory = join(
    dirname(config.catalogPath),
    "backups",
    `pi-memory-routing-${Date.now()}-${randomUUID()}`,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const manifest: { source: string; file: string }[] = [];
  for (const [i, path] of [
    ...new Set([config.catalogPath, ...paths]),
  ].entries()) {
    try {
      const content = await readFile(path);
      const file = `${i}.json`;
      await writeFile(join(directory, file), content, {
        flag: "wx",
        mode: 0o600,
      });
      manifest.push({ source: path, file });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    { flag: "wx", mode: 0o600 },
  );
}

export function formatCatalogMatches(
  catalog: ScopeCatalog,
  input: string,
): string[] {
  const query = input.normalize("NFC").trim().toLocaleLowerCase("en-US");
  const matches = (values: string[]) =>
    values.some((value) =>
      value.normalize("NFC").toLocaleLowerCase("en-US").includes(query),
    );
  const projects = Object.values(catalog.projects).filter((p) =>
    matches([p.projectId, p.name, ...p.aliases]),
  );
  const scopes = Object.values(catalog.scopes).filter((s) =>
    matches([
      s.scopeId,
      s.name,
      ...s.aliases,
      qualifiedScopeName(catalog, s),
      ...(s.repositoryId ? [s.repositoryId] : []),
    ]),
  );
  return [
    ...projects.map((p) => `Project ${p.name} (${p.projectId})`),
    ...scopes.map(
      (s) =>
        `Scope ${qualifiedScopeName(catalog, s)} (${s.scopeId})\n  tag=${s.memoryTag}\n  ${dirname(s.markerPath)}`,
    ),
  ];
}

async function chooseProject(
  config: MemoryConfig,
  ctx: ExtensionContext,
): Promise<ProjectRecord | string | undefined> {
  const catalog = await loadScopeCatalog(location(config));
  const projects = Object.values(catalog.projects).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const labels = projects.map((p) => `${p.name} (${p.projectId})`);
  const choice = await ctx.ui.select("Scope를 소속시킬 Project", [
    ...labels,
    newProjectLabel,
  ]);
  if (!choice) return undefined;
  if (choice !== newProjectLabel) return projects[labels.indexOf(choice)];
  const name = (await ctx.ui.input("새 Project 이름"))?.trim();
  if (!name) return undefined;
  return projectByName(catalog, name) ?? name;
}

async function repairLocation(
  config: MemoryConfig,
  ctx: ExtensionContext,
  root: string,
  check: () => void,
): Promise<boolean> {
  const markerPath = join(root, ".pi-memory-scope.json");
  let marker: Awaited<ReturnType<typeof readScopeMarker>>;
  try {
    marker = await readScopeMarker(markerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const catalog = await loadScopeCatalog(location(config));
  const scope = catalog.scopes[marker.scopeId];
  if (
    !scope ||
    scope.projectId !== marker.projectId ||
    !catalog.projects[scope.projectId ?? ""]
  )
    throw new Error("scope-marker-not-registered");
  if (resolve(scope.markerPath) === markerPath)
    throw new Error("scope-binding-repair-required");
  // A copied marker must not adopt the original live repository's identity.
  try {
    await lstat(scope.markerPath);
    throw new Error("scope-original-location-still-exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (
    !ctx.hasUI ||
    !(await ctx.ui.confirm(
      "기존 Scope 경로 재연결",
      `${scope.markerPath}\n→ ${markerPath}\nScope ID와 메모리 태그는 유지합니다. 원본 위치가 이동된 경우에만 승인하세요.`,
    ))
  )
    return false;
  check();
  await backup(config, [markerPath]);
  check();
  await updateScopeLocation(location(config), scope.scopeId, markerPath, root);
  return true;
}

export async function ensureScopeRegistration(
  config: MemoryConfig,
  ctx: ExtensionContext,
): Promise<boolean> {
  const check = contextGuard(ctx);
  check();
  try {
    await resolveIdentity(ctx.cwd, config.catalogPath);
    return true;
  } catch (error) {
    if (!(error instanceof MemoryError)) throw error;
    if (!["scope-unregistered", "scope-path-mismatch"].includes(error.code))
      throw error;
  }
  if (!ctx.hasUI) return false;
  const git = resolveGitContext(ctx.cwd);
  const root = await registrationRoot(ctx.cwd);
  const markerPath = join(root, ".pi-memory-scope.json");
  if (await repairLocation(config, ctx, root, check)) return true;
  // A declined repair is not permission to create a different identity over it.
  try {
    await lstat(markerPath);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (
    !(await ctx.ui.confirm(
      "이 위치에서 메모리를 사용할까요?",
      `${root}\n사용하면 Project·Scope를 등록하고 현재 Scope의 대화를 설정된 Hindsight에 저장합니다.`,
    ))
  )
    return false;
  const project = await chooseProject(config, ctx);
  if (!project) return false;
  const name = (await ctx.ui.input("Scope 이름", basename(root)))?.trim();
  if (!name) return false;
  const projectName = typeof project === "string" ? project : project.name;
  if (
    !(await ctx.ui.confirm(
      "메모리 Scope 등록",
      `${projectName}/${name}\n위치: ${root}\n기존 기억과 스킬은 변경하지 않습니다.`,
    ))
  )
    return false;
  check();
  await backup(config, []);
  check();
  const newId = `project_${randomUUID()}`;
  const selected =
    typeof project === "string"
      ? await createProject(location(config), project, [], newId)
      : project;
  try {
    check();
    await createScope(location(config), {
      root,
      projectId: selected.projectId,
      name,
      ...(git ? { repositoryId: git.repositoryId } : {}),
    });
    await resolveIdentity(ctx.cwd, config.catalogPath);
  } catch (error) {
    if (selected.projectId === newId)
      await removeProjectIfEmpty(location(config), newId);
    throw error;
  }
  ctx.ui.notify(`${projectName}/${name} Scope를 등록했습니다.`, "info");
  return true;
}

export function registerManagement(
  pi: ExtensionAPI,
  config: MemoryConfig,
): void {
  const command = (
    name: string,
    description: string,
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>,
  ) => {
    pi.registerCommand(name, {
      description,
      handler: async (args, ctx) => {
        try {
          await handler(args, ctx);
        } catch {
          ctx.ui.notify(
            "메모리 관리 작업을 완료하지 못했습니다. 카탈로그·마커 충돌 또는 잠금 상태를 확인하세요. 운영 기억·세션은 삭제하지 않았습니다.",
            "error",
          );
        }
      },
    });
  };
  command(
    "memory-find",
    "등록된 메모리 Project·Scope 이름, 별칭, ID 조회",
    async (args, ctx) => {
      const matches = formatCatalogMatches(
        await loadScopeCatalog(location(config)),
        args,
      );
      ctx.ui.notify(
        matches.length
          ? matches.join("\n")
          : "일치하는 Project·Scope가 없습니다.",
        "info",
      );
    },
  );
  command(
    "memory-create-project",
    "메모리 Project 생성 (Scope·기억 저장소는 생성하지 않음)",
    async (args, ctx) => {
      if (!ctx.hasUI) return;
      const check = contextGuard(ctx);
      const name =
        args.trim() || (await ctx.ui.input("새 Project 이름"))?.trim();
      if (!name) return;
      const existing = projectByName(
        await loadScopeCatalog(location(config)),
        name,
      );
      if (existing) {
        ctx.ui.notify(
          `이미 등록된 Project: ${existing.name} (${existing.projectId})`,
          "info",
        );
        return;
      }
      if (!(await ctx.ui.confirm("Project 생성", name))) return;
      check();
      await backup(config, []);
      check();
      const project = await createProject(location(config), name);
      ctx.ui.notify(
        `Project 생성: ${project.name} (${project.projectId})`,
        "info",
      );
    },
  );
  command(
    "memory-register-scope",
    "현재 위치의 Scope 등록을 다시 안내",
    async (_args, ctx) => {
      await ctx.waitForIdle();
      if (await ensureScopeRegistration(config, ctx)) await ctx.reload();
    },
  );
  command(
    "memory-reassign-scope",
    "현재 Scope의 Project 소속 변경 (ID·태그·기억·스킬 유지)",
    async (args, ctx) => {
      if (!ctx.hasUI) return;
      const check = contextGuard(ctx);
      await ctx.waitForIdle();
      check();
      const identity = await resolveIdentity(ctx.cwd, config.catalogPath);
      const catalog = await loadScopeCatalog(location(config));
      const scope = catalog.scopes[identity.scopeId];
      if (!scope) throw new Error("scope-unregistered");
      const choices = Object.values(catalog.projects).filter(
        (p) => p.projectId !== identity.projectId,
      );
      const labels = choices.map((p) => `${p.name} (${p.projectId})`);
      const answer = args.trim()
        ? undefined
        : await ctx.ui.select("이동할 Project", labels);
      const target = args.trim()
        ? (catalog.projects[args.trim()] ?? projectByName(catalog, args.trim()))
        : choices[labels.indexOf(answer ?? "")];
      if (!target || target.projectId === identity.projectId) return;
      if (
        !(await ctx.ui.confirm(
          "Scope Project 재소속",
          `${qualifiedScopeName(catalog, scope)} → ${target.name}/${scope.name}\nscopeId: ${identity.scopeId}\nmemoryTag: ${identity.scopeTag}\n소속만 변경합니다. 기억·스킬·세션은 이동·병합·삭제하지 않습니다.`,
        ))
      )
        return;
      check();
      const current = await resolveIdentity(ctx.cwd, config.catalogPath);
      if (
        current.scopeId !== identity.scopeId ||
        current.projectId !== identity.projectId
      )
        throw new Error("scope-binding-changed");
      await backup(config, [scope.markerPath]);
      check();
      await reassignScopeProject(
        location(config),
        identity.scopeId,
        target.projectId,
        undefined,
        identity.projectId,
      );
      const verified = await resolveIdentity(ctx.cwd, config.catalogPath);
      if (
        verified.scopeId !== identity.scopeId ||
        verified.scopeTag !== identity.scopeTag ||
        verified.projectId !== target.projectId
      )
        throw new Error("scope-reassignment-verification-failed");
      ctx.ui.notify(
        `Project 소속을 ${target.name}으로 변경했습니다. Scope ID·태그·기억·스킬·기존 세션은 유지됐습니다.`,
        "info",
      );
      await ctx.reload();
    },
  );
  command(
    "memory-rebind-repository",
    "저장소 개명 후 현재 Scope의 Git identity 갱신",
    async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const check = contextGuard(ctx);
      await ctx.waitForIdle();
      check();
      const identity = await resolveIdentity(ctx.cwd, config.catalogPath);
      const catalog = await loadScopeCatalog(location(config));
      const scope = catalog.scopes[identity.scopeId],
        git = resolveGitContext(ctx.cwd);
      if (
        !scope?.repositoryId ||
        !git ||
        scope.repositoryId === git.repositoryId
      )
        return;
      if (
        !(await ctx.ui.confirm(
          "저장소 identity 재연결",
          `${scope.repositoryId}\n→ ${git.repositoryId}\nScope ID·메모리 태그는 유지합니다.`,
        ))
      )
        return;
      check();
      const current = await resolveIdentity(ctx.cwd, config.catalogPath);
      if (current.scopeId !== identity.scopeId)
        throw new Error("scope-binding-changed");
      await backup(config, []);
      check();
      if (
        !(await rebindScopeRepositoryId(
          location(config),
          identity.scopeId,
          scope.repositoryId,
          git.repositoryId,
        ))
      )
        throw new Error("repository-rebind-conflict");
      ctx.ui.notify("기존 Scope의 저장소 identity를 갱신했습니다.", "info");
      await ctx.reload();
    },
  );
}
