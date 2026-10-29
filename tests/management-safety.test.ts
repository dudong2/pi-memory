import assert from "node:assert/strict";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ensureScopeRegistration } from "../src/management.ts";
import {
  createProject,
  createScope,
  loadScopeCatalog,
} from "../src/scope/catalog.ts";
import { resolveIdentity } from "../src/identity.ts";
import { config } from "./helpers.ts";

async function setup(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-management-safety-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "work");
  await mkdir(cwd);
  const settings = {
    ...config,
    catalogPath: join(root, "state", "catalog.json"),
  };
  const controller = new AbortController();
  const ctx = {
    cwd,
    hasUI: true,
    signal: controller.signal,
    sessionManager: { getSessionId: () => "fixture" },
    ui: {
      confirm: async () => true,
      select: async (_title: string, options: string[]) => options.at(-1),
      input: async () => "name",
      notify: () => {},
    },
  } as unknown as ExtensionContext;
  return {
    root,
    cwd,
    settings,
    ctx,
    controller,
    location: { catalogPath: settings.catalogPath },
  };
}

for (const stage of [
  "Project selection",
  "new Project input",
  "Scope conflict input",
] as const) {
  test(`aborting during ${stage} cannot register routing state`, async (t) => {
    const { root, settings, ctx, controller, location } = await setup(t);
    if (stage === "Scope conflict input") {
      const project = await createProject(location, "Product");
      const other = join(root, "other");
      await mkdir(other);
      await createScope(location, {
        root: other,
        projectId: project.projectId,
        name: "work",
      });
      ctx.ui.select = async (_title, options) => options[0];
    }
    const before = await loadScopeCatalog(location);
    if (stage === "Project selection") {
      ctx.ui.select = async (_title, options) => {
        controller.abort();
        return options.at(-1);
      };
    } else {
      ctx.ui.input = async () => {
        controller.abort();
        return "name";
      };
    }
    await assert.rejects(ensureScopeRegistration(settings, ctx));
    assert.deepEqual(await loadScopeCatalog(location), before);
  });
}

test("changing location during Project selection cannot register routing state", async (t) => {
  const { root, settings, ctx, location } = await setup(t);
  ctx.ui.select = async (_title, options) => {
    Object.assign(ctx, { cwd: root });
    return options.at(-1);
  };
  await assert.rejects(
    ensureScopeRegistration(settings, ctx),
    /scope-management-context-changed/,
  );
  assert.deepEqual(await loadScopeCatalog(location), {
    projects: {},
    scopes: {},
  });
});

test("moved directory Scope can be repaired from its nested working directory", async (t) => {
  const { root, cwd, settings, ctx, location } = await setup(t);
  const project = await createProject(location, "Project");
  const scope = await createScope(location, {
    root: cwd,
    projectId: project.projectId,
    name: "api",
  });
  const moved = join(root, "moved");
  await rename(cwd, moved);
  const nested = join(moved, "nested");
  await mkdir(nested);
  Object.assign(ctx, { cwd: nested });
  assert.equal(await ensureScopeRegistration(settings, ctx), true);
  assert.equal(
    (await resolveIdentity(nested, settings.catalogPath)).scopeId,
    scope.scopeId,
  );
});

test("copied marker cannot steal a live Scope's registered location", async (t) => {
  const { root, cwd, settings, ctx, location } = await setup(t);
  const project = await createProject(location, "Project");
  const scope = await createScope(location, {
    root: cwd,
    projectId: project.projectId,
    name: "api",
  });
  const clone = join(root, "clone");
  await mkdir(clone);
  await copyFile(scope.markerPath, join(clone, ".pi-memory-scope.json"));
  const before = await readFile(settings.catalogPath, "utf8");
  Object.assign(ctx, { cwd: clone });
  await assert.rejects(
    ensureScopeRegistration(settings, ctx),
    /original-location-still-exists/,
  );
  assert.equal(await readFile(settings.catalogPath, "utf8"), before);
});
