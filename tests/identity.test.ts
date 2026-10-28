import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { loadConfig, parseConfig, safeEndpoint } from "../src/config.ts";
import { resolveIdentity } from "../src/identity.ts";
import { config, identity } from "./helpers.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const markerPath = join(root, ".pi-memory-scope.json");
  const catalogPath = join(root, "catalog.json");
  const marker = {
    version: 2,
    scopeId: identity.scopeId,
    projectId: identity.projectId,
  };
  const catalog = {
    projects: { [identity.projectId]: { projectId: identity.projectId } },
    scopes: {
      [identity.scopeId]: {
        scopeId: identity.scopeId,
        projectId: identity.projectId,
        memoryTag: identity.scopeTag,
        markerPath,
      },
    },
  };
  await writeFile(markerPath, JSON.stringify(marker));
  await writeFile(catalogPath, JSON.stringify(catalog));
  return { root, markerPath, catalogPath, marker, catalog };
}

test("nested cwd uses registered marker and preserves a legacy tag without writing files", async (t) => {
  const data = await fixture(t);
  const child = join(data.root, "src");
  await mkdir(child);
  const before = await Promise.all([
    readFile(data.markerPath),
    readFile(data.catalogPath),
  ]);
  const result = await resolveIdentity(child, data.catalogPath);
  assert.deepEqual(result, { ...identity, root: await realpath(data.root) });
  assert.deepEqual(
    await Promise.all([readFile(data.markerPath), readFile(data.catalogPath)]),
    before,
  );
});

test("copied marker does not bind a different directory to existing memories", async (t) => {
  const data = await fixture(t);
  const copy = join(data.root, "copied");
  await mkdir(copy);
  await writeFile(
    join(copy, ".pi-memory-scope.json"),
    JSON.stringify(data.marker),
  );
  await assert.rejects(
    resolveIdentity(copy, data.catalogPath),
    /scope-path-mismatch/,
  );
});

test("a symlinked marker alone cannot bind an unregistered directory", async (t) => {
  const data = await fixture(t);
  const copy = join(data.root, "symlinked-marker");
  await mkdir(copy);
  await symlink(data.markerPath, join(copy, ".pi-memory-scope.json"));
  await assert.rejects(
    resolveIdentity(copy, data.catalogPath),
    /scope-path-mismatch/,
  );
});

test("missing project binding fails closed, rather than inferring it from the directory name", async (t) => {
  const data = await fixture(t);
  const registered = data.catalog.scopes[identity.scopeId];
  assert.ok(registered);
  registered.projectId = "other-project";
  await writeFile(data.catalogPath, JSON.stringify(data.catalog));
  await assert.rejects(
    resolveIdentity(data.root, data.catalogPath),
    /scope-binding-mismatch/,
  );
});

test("a malformed nearer marker cannot fall through to the parent's scope", async (t) => {
  const data = await fixture(t);
  const nested = join(data.root, "nested");
  await mkdir(nested);
  await writeFile(join(nested, ".pi-memory-scope.json"), "not json");
  await assert.rejects(
    resolveIdentity(nested, data.catalogPath),
    /identity-unavailable/,
  );
});

test("missing marker does not auto-register a new scope", async (t) => {
  const data = await fixture(t);
  await rm(data.markerPath);
  await assert.rejects(
    resolveIdentity(data.root, data.catalogPath),
    /scope-unregistered/,
  );
});

test("an unregistered nested repository cannot borrow its parent's scope", async (t) => {
  const data = await fixture(t);
  const nested = join(data.root, "nested-repository");
  await mkdir(nested);
  await mkdir(join(nested, ".git"));
  await assert.rejects(
    resolveIdentity(nested, data.catalogPath),
    /scope-unregistered/,
  );
});

test("config is opt-in and has no default server or bank", async () => {
  assert.equal(await loadConfig(undefined), undefined);
  assert.throws(() => parseConfig({}), /invalid-data/);
  assert.throws(
    () => parseConfig({ ...config, catalogPath: "relative.json" }),
    /not-absolute/,
  );
  assert.throws(
    () => parseConfig({ ...config, common: { modelId: "user", tags: [] } }),
    /invalid-config/,
  );
  assert.throws(
    () => parseConfig({ ...config, bankID: "typo" }),
    /invalid-config/,
  );
  assert.throws(
    () => parseConfig({ ...config, apiKey: "must-not-store-inline" }),
    /invalid-config/,
  );
  assert.throws(
    () => parseConfig({ ...config, timeoutMs: 0 }),
    /invalid-config/,
  );
  assert.deepEqual(parseConfig(config), {
    ...config,
    scopeModels: Object.assign(Object.create(null), config.scopeModels),
  });
});

test("missing startup model IDs do not disable the bridge and outbox is an explicit opt-in", () => {
  const settings = parseConfig({
    ...config,
    scopeModels: undefined,
    outboxPath: "/fixture/outbox.sqlite",
  });
  assert.deepEqual(Object.keys(settings.scopeModels), []);
  assert.equal("common" in settings, false);
  assert.equal(settings.outboxPath, "/fixture/outbox.sqlite");
  assert.throws(
    () => parseConfig({ ...config, outboxPath: "relative.sqlite" }),
    /outbox-path-not-absolute/,
  );
});

test("only loopback HTTP or HTTPS endpoints are accepted, without embedded credentials", () => {
  for (const endpoint of [
    "http://example.com",
    "https://user:pass@example.com",
    "https://example.com?key=test",
    "file:///tmp/a",
  ]) {
    assert.throws(() => safeEndpoint(endpoint));
  }
  assert.equal(safeEndpoint("http://127.0.0.1:8888/"), "http://127.0.0.1:8888");
  assert.equal(
    safeEndpoint("https://example.com/prefix/"),
    "https://example.com/prefix",
  );
});
