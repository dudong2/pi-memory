import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createProject,
  createScope,
  loadScopeCatalog,
  reassignScopeProject,
  updateScopeLocation,
  rebindScopeRepositoryId,
} from "../src/scope/catalog.ts";
import { resolveIdentity } from "../src/identity.ts";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const location = { catalogPath: join(root, "state", "custom-catalog.json") };
  const owned = join(root, "owned");
  await mkdir(owned);
  return { root, location, owned };
}

test("Project/Scope management preserves the existing schema, identity, tags and unrelated records", async (t) => {
  const { location, owned } = await fixture(t);
  const first = await createProject(location, "First", ["original"]);
  const second = await createProject(location, "Second");
  const scope = await createScope(location, {
    root: owned,
    projectId: first.projectId,
    name: "service",
    memoryTag: "legacy:service",
  });
  const before = await resolveIdentity(owned, location.catalogPath);
  const after = await reassignScopeProject(
    location,
    scope.scopeId,
    second.projectId,
  );
  assert.equal(after.scopeId, before.scopeId);
  assert.equal(after.memoryTag, before.scopeTag);
  assert.equal(
    (await resolveIdentity(owned, location.catalogPath)).projectId,
    second.projectId,
  );
  const catalog = await loadScopeCatalog(location);
  assert.deepEqual(catalog.projects[first.projectId], first);
  assert.deepEqual(Object.keys(catalog).sort(), ["projects", "scopes"]);
});

test("project creation is idempotent but aliases cannot silently choose another identity", async (t) => {
  const { location } = await fixture(t);
  const first = await createProject(location, "First");
  await createProject(location, "Second");
  assert.equal(
    (await createProject(location, " first ")).projectId,
    first.projectId,
  );
  await assert.rejects(createProject(location, "Third", ["First"]), /conflict/);
  await assert.rejects(
    createProject(location, "First", ["Second"]),
    /conflict/,
  );
});

test("Scope registration cannot overwrite a marker or reuse another location's name", async (t) => {
  const { root, location, owned } = await fixture(t);
  const project = await createProject(location, "Product");
  const scope = await createScope(location, {
    root: owned,
    projectId: project.projectId,
    name: "service",
  });
  const marker = await readFile(scope.markerPath, "utf8");
  const elsewhere = join(root, "elsewhere");
  await mkdir(elsewhere);
  await assert.rejects(
    createScope(location, {
      root: elsewhere,
      projectId: project.projectId,
      name: "service",
    }),
    /conflict/,
  );
  await assert.rejects(
    createScope(location, {
      root: owned,
      projectId: project.projectId,
      name: "other",
    }),
    /marker/,
  );
  assert.equal(await readFile(scope.markerPath, "utf8"), marker);
});

test("failed marker publication rolls catalog registration back", async (t) => {
  const { location, owned } = await fixture(t);
  const project = await createProject(location, "Product");
  await mkdir(join(owned, ".pi-memory-scope.json"));
  const before = await readFile(location.catalogPath, "utf8");
  await assert.rejects(
    createScope(location, {
      root: owned,
      projectId: project.projectId,
      name: "service",
    }),
  );
  assert.equal(await readFile(location.catalogPath, "utf8"), before);
});

test("reassignment rejects duplicate names and stale markers without mutation", async (t) => {
  const { root, location, owned } = await fixture(t);
  const a = await createProject(location, "A"),
    b = await createProject(location, "B");
  const scope = await createScope(location, {
    root: owned,
    projectId: a.projectId,
    name: "same",
  });
  const other = join(root, "other");
  await mkdir(other);
  await createScope(location, {
    root: other,
    projectId: b.projectId,
    name: "same",
  });
  await assert.rejects(
    reassignScopeProject(location, scope.scopeId, b.projectId),
    /already has/,
  );
  const target = await createProject(location, "C");
  await writeFile(
    scope.markerPath,
    JSON.stringify({ ...scope.marker, projectId: target.projectId }),
  );
  const before = await readFile(location.catalogPath, "utf8");
  await assert.rejects(
    reassignScopeProject(location, scope.scopeId, target.projectId),
    /does not match/,
  );
  assert.equal(await readFile(location.catalogPath, "utf8"), before);
});

test("repository rebind and explicit location update keep scope and memory identities", async (t) => {
  const { root, location, owned } = await fixture(t);
  const project = await createProject(location, "Product");
  const scope = await createScope(location, {
    root: owned,
    projectId: project.projectId,
    name: "app",
    repositoryId: "github.com/me/old",
  });
  const moved = join(root, "moved");
  await rename(owned, moved);
  const record = await updateScopeLocation(
    location,
    scope.scopeId,
    join(moved, ".pi-memory-scope.json"),
    moved,
  );
  assert.equal(record.scopeId, scope.scopeId);
  assert.equal(
    (
      await rebindScopeRepositoryId(
        location,
        scope.scopeId,
        "github.com/me/old",
        "github.com/me/new",
      )
    )?.memoryTag,
    scope.memoryTag,
  );
  assert.equal(
    (await resolveIdentity(moved, location.catalogPath)).scopeId,
    scope.scopeId,
  );
});

test("concurrent Project registrations do not lose records", async (t) => {
  const { location } = await fixture(t);
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      createProject(location, `Project ${i}`),
    ),
  );
  assert.equal(
    Object.keys((await loadScopeCatalog(location)).projects).length,
    8,
  );
});
