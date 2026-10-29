import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  ensureScopeRegistration,
  formatCatalogMatches,
  registerManagement,
} from "../src/management.ts";
import {
  createProject,
  createScope,
  loadScopeCatalog,
} from "../src/scope/catalog.ts";
import { resolveIdentity } from "../src/identity.ts";
import { config } from "./helpers.ts";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-management-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "work");
  await mkdir(cwd);
  return {
    root,
    cwd,
    settings: { ...config, catalogPath: join(root, "state", "catalog.json") },
  };
}
function context(
  cwd: string,
  answers: {
    confirmations?: boolean[];
    inputs?: (string | undefined)[];
    select?: (options: string[]) => string | undefined;
    hasUI?: boolean;
  } = {},
) {
  const notifications: { text: string; type?: string }[] = [];
  let reloads = 0,
    prompts = 0;
  const ctx = {
    cwd,
    hasUI: answers.hasUI ?? true,
    signal: new AbortController().signal,
    sessionManager: { getSessionId: () => "test-session" },
    waitForIdle: async () => {},
    reload: async () => {
      reloads++;
    },
    ui: {
      confirm: async () => {
        prompts++;
        return answers.confirmations?.shift() ?? false;
      },
      input: async () => {
        prompts++;
        return answers.inputs?.shift();
      },
      select: async (_title: string, options: string[]) => {
        prompts++;
        return answers.select ? answers.select(options) : options[0];
      },
      notify: (text: string, type?: string) =>
        notifications.push({ text, type }),
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notifications, reloads: () => reloads, prompts: () => prompts };
}

test("cancelled Project selection, cancelled new Project input and headless use never create routing state", async (t) => {
  const { cwd, settings } = await fixture(t);
  for (const options of [
    { select: () => undefined },
    { inputs: [undefined] },
    { hasUI: false },
  ]) {
    const { ctx } = context(cwd, options);
    assert.equal(await ensureScopeRegistration(settings, ctx), false);
    assert.deepEqual(
      await loadScopeCatalog({ catalogPath: settings.catalogPath }),
      { projects: {}, scopes: {} },
    );
    await assert.rejects(readFile(join(cwd, ".pi-memory-scope.json")));
  }
});

test("new Project registration asks only its name and automatically names the Scope", async (t) => {
  const { cwd, settings } = await fixture(t);
  const { ctx, prompts } = context(cwd, {
    inputs: ["Product"],
  });
  assert.equal(await ensureScopeRegistration(settings, ctx), true);
  const identity = await resolveIdentity(cwd, settings.catalogPath);
  const catalog = await loadScopeCatalog({ catalogPath: settings.catalogPath });
  assert.equal(catalog.projects[identity.projectId]?.name, "Product");
  assert.equal(catalog.scopes[identity.scopeId]?.name, basename(cwd));
  assert.equal(prompts(), 2);
  const priorPrompts = prompts();
  assert.equal(await ensureScopeRegistration(settings, ctx), true);
  assert.equal(prompts(), priorPrompts);
});

test("cancelling new Project input does not leave a dummy Project", async (t) => {
  const { cwd, settings } = await fixture(t);
  const { ctx } = context(cwd, {
    inputs: [undefined],
  });
  assert.equal(await ensureScopeRegistration(settings, ctx), false);
  assert.equal(
    Object.keys(
      (await loadScopeCatalog({ catalogPath: settings.catalogPath })).projects,
    ).length,
    0,
  );
});

test("existing Project selection alone registers a Scope with name-only labels", async (t) => {
  const { cwd, settings } = await fixture(t);
  const location = { catalogPath: settings.catalogPath };
  const project = await createProject(location, "Product");
  const { ctx, prompts } = context(cwd, {
    select: (options) => {
      assert.deepEqual(options, ["Product", "새 Project 만들기"]);
      return "Product";
    },
  });
  ctx.ui.confirm = async () => {
    throw new Error("unexpected confirmation");
  };
  ctx.ui.input = async () => {
    throw new Error("unexpected name input");
  };
  assert.equal(await ensureScopeRegistration(settings, ctx), true);
  assert.equal(prompts(), 1);
  const identity = await resolveIdentity(cwd, settings.catalogPath);
  assert.equal(identity.projectId, project.projectId);
  assert.equal(
    (await loadScopeCatalog(location)).scopes[identity.scopeId]?.name,
    "work",
  );
});

test("a Project named like the create action stays selectable without showing its ID", async (t) => {
  const { cwd, settings } = await fixture(t);
  const project = await createProject(
    { catalogPath: settings.catalogPath },
    "새 Project 만들기",
  );
  const { ctx, prompts } = context(cwd, {
    select: (options) => {
      assert.deepEqual(options, ["새 Project 만들기", "새 Project 만들기…"]);
      return options[0];
    },
  });
  ctx.ui.input = async () => {
    throw new Error("must select the existing Project");
  };
  assert.equal(await ensureScopeRegistration(settings, ctx), true);
  assert.equal(prompts(), 1);
  assert.equal(
    (await resolveIdentity(cwd, settings.catalogPath)).projectId,
    project.projectId,
  );
});

test("Git registration uses the repository root name from a nested directory", async (t) => {
  const { cwd, settings } = await fixture(t);
  execFileSync("git", ["init", "--quiet", cwd]);
  execFileSync("git", [
    "-C",
    cwd,
    "remote",
    "add",
    "origin",
    "git@github.com:owner/remote-name.git",
  ]);
  const nested = join(cwd, "src");
  await mkdir(nested);
  const { ctx, prompts } = context(nested, { inputs: ["Product"] });
  assert.equal(await ensureScopeRegistration(settings, ctx), true);
  const identity = await resolveIdentity(nested, settings.catalogPath);
  const scope = (await loadScopeCatalog({ catalogPath: settings.catalogPath }))
    .scopes[identity.scopeId];
  assert.equal(scope?.name, "work");
  assert.equal(
    scope?.markerPath,
    join(await realpath(cwd), ".pi-memory-scope.json"),
  );
  assert.equal(prompts(), 2);
});

test("worktree Scope naming uses the main repository name without changing its registration root", async (t) => {
  const { root, cwd, settings } = await fixture(t);
  execFileSync("git", ["init", "--quiet", cwd]);
  execFileSync("git", [
    "-C",
    cwd,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  const worktree = join(root, "feature-checkout");
  execFileSync("git", [
    "-C",
    cwd,
    "worktree",
    "add",
    "--quiet",
    "-b",
    "feature",
    worktree,
  ]);
  const { ctx, prompts } = context(worktree, { inputs: ["Product"] });
  assert.equal(await ensureScopeRegistration(settings, ctx), true);
  const identity = await resolveIdentity(worktree, settings.catalogPath);
  const scope = (await loadScopeCatalog({ catalogPath: settings.catalogPath }))
    .scopes[identity.scopeId];
  assert.equal(scope?.name, "work");
  assert.equal(
    scope?.markerPath,
    join(await realpath(worktree), ".pi-memory-scope.json"),
  );
  assert.equal(prompts(), 2);
});

test("Scope name conflicts alone ask for a name and never overwrite existing identities", async (t) => {
  const { root, cwd, settings } = await fixture(t);
  const location = { catalogPath: settings.catalogPath };
  const project = await createProject(location, "Product");
  const other = join(root, "other");
  await mkdir(other);
  const existing = await createScope(location, {
    root: other,
    projectId: project.projectId,
    name: "WORK",
    memoryTag: "legacy:work",
  });
  const before = await readFile(existing.markerPath, "utf8");
  const { ctx, prompts } = context(cwd);
  let inputs = 0;
  ctx.ui.input = async (_title, proposed) => {
    assert.equal(proposed, "work-2");
    return ++inputs === 1 ? "work" : "";
  };
  assert.equal(await ensureScopeRegistration(settings, ctx), true);
  assert.equal(inputs, 2);
  assert.equal(prompts(), 1);
  const identity = await resolveIdentity(cwd, settings.catalogPath);
  const catalog = await loadScopeCatalog(location);
  assert.equal(catalog.scopes[identity.scopeId]?.name, "work-2");
  assert.deepEqual(catalog.scopes[existing.scopeId], existing);
  assert.equal(await readFile(existing.markerPath, "utf8"), before);
  assert.equal(
    (await resolveIdentity(other, settings.catalogPath)).scopeTag,
    "legacy:work",
  );
});

test("cancelling a conflicting Scope name leaves catalog and markers unchanged", async (t) => {
  const { root, cwd, settings } = await fixture(t);
  const location = { catalogPath: settings.catalogPath };
  const project = await createProject(location, "Product");
  const other = join(root, "other");
  await mkdir(other);
  await createScope(location, {
    root: other,
    projectId: project.projectId,
    name: "work",
  });
  const before = await readFile(settings.catalogPath, "utf8");
  const { ctx } = context(cwd, { inputs: [undefined] });
  assert.equal(await ensureScopeRegistration(settings, ctx), false);
  assert.equal(await readFile(settings.catalogPath, "utf8"), before);
  await assert.rejects(readFile(join(cwd, ".pi-memory-scope.json")));
});

test("new Project input defaults to the automatic Scope name", async (t) => {
  const { cwd, settings } = await fixture(t);
  const { ctx, prompts } = context(cwd, { inputs: [""] });
  assert.equal(await ensureScopeRegistration(settings, ctx), true);
  const catalog = await loadScopeCatalog({ catalogPath: settings.catalogPath });
  assert.equal(Object.values(catalog.projects)[0]?.name, "work");
  assert.equal(Object.values(catalog.scopes)[0]?.name, "work");
  assert.equal(prompts(), 2);
});

test("Scope names are rechecked when another registration takes the proposed name", async (t) => {
  const { root, cwd, settings } = await fixture(t);
  const location = { catalogPath: settings.catalogPath };
  const project = await createProject(location, "Product");
  const other = join(root, "other"),
    concurrent = join(root, "concurrent");
  await mkdir(other);
  await mkdir(concurrent);
  await createScope(location, {
    root: other,
    projectId: project.projectId,
    name: "work",
  });
  const { ctx } = context(cwd);
  const proposals: (string | undefined)[] = [];
  ctx.ui.input = async (_title, proposed) => {
    proposals.push(proposed);
    if (proposals.length === 1)
      await createScope(location, {
        root: concurrent,
        projectId: project.projectId,
        name: "work-2",
      });
    return "";
  };
  assert.equal(await ensureScopeRegistration(settings, ctx), true);
  assert.deepEqual(proposals, ["work-2", "work-3"]);
  const identity = await resolveIdentity(cwd, settings.catalogPath);
  assert.equal(
    (await loadScopeCatalog(location)).scopes[identity.scopeId]?.name,
    "work-3",
  );
  assert.notEqual(
    (await resolveIdentity(concurrent, settings.catalogPath)).scopeId,
    identity.scopeId,
  );
});

test("existing catalog lookup is read-only and finds aliases, qualified names and IDs", async (t) => {
  const { cwd, settings } = await fixture(t),
    location = { catalogPath: settings.catalogPath };
  const project = await createProject(location, "Product", ["old-product"]);
  const scope = await createScope(location, {
    root: cwd,
    projectId: project.projectId,
    name: "api",
    aliases: ["backend"],
  });
  const bytes = await readFile(settings.catalogPath, "utf8"),
    catalog = await loadScopeCatalog(location);
  for (const query of ["old-product", "Product/api", "backend", scope.scopeId])
    assert.ok(formatCatalogMatches(catalog, query).length);
  assert.equal(await readFile(settings.catalogPath, "utf8"), bytes);
});

test("management commands preserve source Project, sessions and Scope tag on reassignment", async (t) => {
  const { cwd, root, settings } = await fixture(t),
    location = { catalogPath: settings.catalogPath };
  const first = await createProject(location, "First"),
    second = await createProject(location, "Second");
  const scope = await createScope(location, {
    root: cwd,
    projectId: first.projectId,
    name: "api",
    memoryTag: "legacy:api",
  });
  const commands = new Map<
    string,
    { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
  >();
  registerManagement(
    {
      registerCommand: (name: string, command: never) =>
        commands.set(name, command),
    } as unknown as ExtensionAPI,
    settings,
  );
  for (const name of [
    "memory-find",
    "memory-create-project",
    "memory-register-scope",
    "memory-reassign-scope",
    "memory-rebind-repository",
  ])
    assert.ok(commands.has(name));
  const denied = context(cwd, { confirmations: [false] });
  await commands.get("memory-reassign-scope")?.handler("Second", denied.ctx);
  assert.equal(
    (await resolveIdentity(cwd, settings.catalogPath)).projectId,
    first.projectId,
  );
  const approved = context(cwd, { confirmations: [true] });
  await commands
    .get("memory-reassign-scope")
    ?.handler(second.projectId, approved.ctx);
  assert.equal(
    (await resolveIdentity(cwd, settings.catalogPath)).scopeTag,
    "legacy:api",
  );
  assert.equal(
    (await resolveIdentity(cwd, settings.catalogPath)).projectId,
    second.projectId,
  );
  assert.ok((await loadScopeCatalog(location)).projects[first.projectId]);
  assert.equal(approved.reloads(), 1);
  assert.ok(approved.notifications.every((n) => n.type !== "error"));
  assert.ok(await readFile(join(root, "state", "catalog.json")));
  assert.equal(
    scope.scopeId,
    (await resolveIdentity(cwd, settings.catalogPath)).scopeId,
  );
});

test("moved Scope is repaired only after approval and copied markers do not hijack identity", async (t) => {
  const { cwd, root, settings } = await fixture(t),
    location = { catalogPath: settings.catalogPath };
  const project = await createProject(location, "Product");
  const scope = await createScope(location, {
    root: cwd,
    projectId: project.projectId,
    name: "api",
  });
  const moved = join(root, "moved");
  await rename(cwd, moved);
  const denied = context(moved, { confirmations: [false] });
  assert.equal(await ensureScopeRegistration(settings, denied.ctx), false);
  await assert.rejects(resolveIdentity(moved, settings.catalogPath));
  const approved = context(moved, { confirmations: [true] });
  assert.equal(await ensureScopeRegistration(settings, approved.ctx), true);
  assert.equal(
    (await resolveIdentity(moved, settings.catalogPath)).scopeId,
    scope.scopeId,
  );
});
