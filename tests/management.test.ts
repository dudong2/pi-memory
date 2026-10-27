import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
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
        return answers.select?.(options) ?? options[0];
      },
      notify: (text: string, type?: string) =>
        notifications.push({ text, type }),
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notifications, reloads: () => reloads, prompts: () => prompts };
}

test("startup registration declines, cancellation and headless use never create routing state", async (t) => {
  const { cwd, settings } = await fixture(t);
  for (const options of [
    { confirmations: [false] },
    { confirmations: [true], select: () => undefined },
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

test("startup registration creates one Project and Scope only after interactive approval", async (t) => {
  const { cwd, settings } = await fixture(t);
  const { ctx, prompts } = context(cwd, {
    confirmations: [true, true],
    inputs: ["Product", "api"],
  });
  assert.equal(await ensureScopeRegistration(settings, ctx), true);
  const identity = await resolveIdentity(cwd, settings.catalogPath);
  const catalog = await loadScopeCatalog({ catalogPath: settings.catalogPath });
  assert.equal(catalog.projects[identity.projectId]?.name, "Product");
  assert.equal(catalog.scopes[identity.scopeId]?.name, "api");
  const priorPrompts = prompts();
  assert.equal(await ensureScopeRegistration(settings, ctx), true);
  assert.equal(prompts(), priorPrompts);
});

test("cancelling final registration does not leave a dummy Project", async (t) => {
  const { cwd, settings } = await fixture(t);
  const { ctx } = context(cwd, {
    confirmations: [true, false],
    inputs: ["Product", "api"],
  });
  assert.equal(await ensureScopeRegistration(settings, ctx), false);
  assert.equal(
    Object.keys(
      (await loadScopeCatalog({ catalogPath: settings.catalogPath })).projects,
    ).length,
    0,
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
