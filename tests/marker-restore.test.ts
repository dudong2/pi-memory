import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ensureScopeRegistration } from "../src/management.ts";
import {
  createProject,
  createScope,
  findScopeMarkerRestoration,
  loadScopeCatalog,
} from "../src/scope/catalog.ts";
import { resolveIdentity } from "../src/identity.ts";
import { config } from "./helpers.ts";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-marker-restore-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "work");
  await mkdir(cwd);
  const settings = {
    ...config,
    catalogPath: join(root, "state", "catalog.json"),
  };
  const location = { catalogPath: settings.catalogPath };
  const project = await createProject(location, "Product");
  const scope = await createScope(location, {
    root: cwd,
    projectId: project.projectId,
    name: "api",
    memoryTag: "legacy:api",
  });
  const originalMarker = await readFile(scope.markerPath, "utf8");
  await rm(scope.markerPath);
  const confirmations: string[] = [];
  const controller = new AbortController();
  const ctx = {
    cwd,
    hasUI: true,
    signal: controller.signal,
    sessionManager: { getSessionId: () => "marker-restoration" },
    ui: {
      confirm: async (title: string) => {
        confirmations.push(title);
        return true;
      },
      select: async () => {
        throw new Error("restoration must not onboard another Scope");
      },
      input: async () => {
        throw new Error("restoration must not ask for a new name");
      },
      notify: () => {},
    },
  } as unknown as ExtensionContext;
  return {
    root,
    cwd,
    settings,
    location,
    scope,
    originalMarker,
    ctx,
    confirmations,
    controller,
  };
}

test("startup restores a missing marker with the same ID/tag and unchanged catalog", async (t) => {
  const { settings, scope, originalMarker, ctx, confirmations } =
    await fixture(t);
  const before = await readFile(settings.catalogPath, "utf8");
  assert.equal(await ensureScopeRegistration(settings, ctx), true);
  const identity = await resolveIdentity(ctx.cwd, settings.catalogPath);
  assert.equal(identity.scopeId, scope.scopeId);
  assert.equal(identity.scopeTag, scope.memoryTag);
  assert.equal(await readFile(scope.markerPath, "utf8"), originalMarker);
  assert.equal(await readFile(settings.catalogPath, "utf8"), before);
  assert.equal((await stat(scope.markerPath)).mode & 0o777, 0o600);
  assert.deepEqual(confirmations, ["기존 Scope 마커 복원"]);
});

test("a missing directory marker is found from a nested cwd without .git", async (t) => {
  const { cwd, settings, scope, ctx } = await fixture(t);
  const nested = join(cwd, "src", "nested");
  await mkdir(nested, { recursive: true });
  Object.assign(ctx, { cwd: nested });
  assert.equal(await ensureScopeRegistration(settings, ctx), true);
  assert.equal(
    (await resolveIdentity(nested, settings.catalogPath)).scopeId,
    scope.scopeId,
  );
});

test("declining marker restoration never falls through to new Scope registration", async (t) => {
  const { settings, scope, ctx, confirmations } = await fixture(t);
  ctx.ui.confirm = async (title) => {
    confirmations.push(title);
    return false;
  };
  const before = await readFile(settings.catalogPath, "utf8");
  assert.equal(await ensureScopeRegistration(settings, ctx), false);
  assert.deepEqual(confirmations, ["기존 Scope 마커 복원"]);
  await assert.rejects(readFile(scope.markerPath));
  assert.equal(await readFile(settings.catalogPath, "utf8"), before);
});

test("a missing child Scope marker cannot fall through to an intact parent Scope", async (t) => {
  const { root, settings, location, scope, ctx } = await fixture(t);
  const project = await createProject(location, "Parent");
  await createScope(location, {
    root,
    projectId: project.projectId,
    name: "parent",
  });
  await assert.rejects(
    resolveIdentity(ctx.cwd, settings.catalogPath),
    /scope-unregistered/,
  );
  assert.equal(await ensureScopeRegistration(settings, ctx), true);
  assert.equal(
    (await resolveIdentity(ctx.cwd, settings.catalogPath)).scopeId,
    scope.scopeId,
  );
});

test("headless startup cannot restore a marker without user consent", async (t) => {
  const { settings, scope, ctx, confirmations } = await fixture(t);
  Object.assign(ctx, { hasUI: false });
  assert.equal(await ensureScopeRegistration(settings, ctx), false);
  assert.deepEqual(confirmations, []);
  await assert.rejects(readFile(scope.markerPath));
});

test("a nested unregistered repository cannot restore its parent's missing marker", async (t) => {
  const { cwd, settings, scope, ctx, confirmations } = await fixture(t);
  const child = join(cwd, "other-repo");
  await mkdir(join(child, ".git"), { recursive: true });
  Object.assign(ctx, { cwd: child });
  let selections = 0;
  ctx.ui.select = async () => {
    selections++;
    return undefined;
  };
  assert.equal(await ensureScopeRegistration(settings, ctx), false);
  assert.equal(selections, 1);
  assert.deepEqual(confirmations, []);
  await assert.rejects(readFile(scope.markerPath));
});

test("ambiguous catalog bindings cannot restore or onboard a replacement identity", async (t) => {
  const { settings, location, scope, ctx } = await fixture(t);
  const catalog = await loadScopeCatalog(location);
  catalog.scopes.duplicate = {
    ...scope,
    scopeId: "duplicate",
    marker: { ...scope.marker, scopeId: "duplicate" },
  };
  await writeFile(settings.catalogPath, JSON.stringify(catalog));
  const before = await readFile(settings.catalogPath, "utf8");
  await assert.rejects(ensureScopeRegistration(settings, ctx), /ambiguous/);
  await assert.rejects(readFile(scope.markerPath));
  assert.equal(await readFile(settings.catalogPath, "utf8"), before);
});

test("an inconsistent Project record cannot publish a restored marker", async (t) => {
  const { settings, location, scope, ctx } = await fixture(t);
  const catalog = await loadScopeCatalog(location);
  const project = catalog.projects[scope.projectId ?? ""];
  assert.ok(project);
  project.projectId = "wrong-project";
  await writeFile(settings.catalogPath, JSON.stringify(catalog));
  await assert.rejects(ensureScopeRegistration(settings, ctx));
  await assert.rejects(readFile(scope.markerPath));
});

test("an existing or concurrently created marker is never overwritten", async (t) => {
  const { settings, scope, ctx } = await fixture(t);
  ctx.ui.confirm = async () => {
    await writeFile(scope.markerPath, "do-not-overwrite");
    return true;
  };
  await assert.rejects(ensureScopeRegistration(settings, ctx));
  assert.equal(await readFile(scope.markerPath, "utf8"), "do-not-overwrite");
});

test("a changed catalog binding during confirmation invalidates the restoration", async (t) => {
  const { settings, location, scope, ctx } = await fixture(t);
  ctx.ui.confirm = async () => {
    const catalog = await loadScopeCatalog(location);
    const current = catalog.scopes[scope.scopeId];
    assert.ok(current);
    current.memoryTag = "changed:tag";
    await writeFile(settings.catalogPath, JSON.stringify(catalog));
    return true;
  };
  await assert.rejects(ensureScopeRegistration(settings, ctx), /changed/);
  await assert.rejects(readFile(scope.markerPath));
});

test("a matching remote or historical path cannot adopt another directory's Scope", async (t) => {
  const { root, cwd, settings, location, scope } = await fixture(t);
  const clone = join(root, "clone");
  await mkdir(clone);
  const catalog = await loadScopeCatalog(location);
  const current = catalog.scopes[scope.scopeId];
  assert.ok(current);
  current.repositoryId = "github.com/example/repository";
  current.paths.push(clone);
  await writeFile(settings.catalogPath, JSON.stringify(catalog));
  assert.equal(
    await findScopeMarkerRestoration(location, clone, current.repositoryId),
    null,
  );
  await assert.rejects(
    findScopeMarkerRestoration(location, cwd, "github.com/example/different"),
    /repository-mismatch/,
  );
  await assert.rejects(readFile(scope.markerPath));
});

test("aborting restoration during confirmation cannot write the marker", async (t) => {
  const { settings, scope, ctx, controller } = await fixture(t);
  ctx.ui.confirm = async () => {
    controller.abort();
    return true;
  };
  await assert.rejects(ensureScopeRegistration(settings, ctx));
  await assert.rejects(readFile(scope.markerPath));
});
