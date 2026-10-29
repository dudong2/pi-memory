import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { config, fakeServer } from "./helpers.ts";

test("installed entry gates memory tools but offers consent-based onboarding outside a Scope", async (t) => {
  const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  const entry = resolve(manifest.pi.extensions[0]);
  // Pi's compact startup list uses the basename for local extension entries.
  assert.equal(basename(entry), "pi-memory.ts");
  const original = process.cwd(),
    prior = process.env.PI_MEMORY_CONFIG;
  const root = await mkdtemp(join(tmpdir(), "pi-memory-install-"));
  const server = await fakeServer(t);
  t.after(async () => {
    process.chdir(original);
    if (prior === undefined) delete process.env.PI_MEMORY_CONFIG;
    else process.env.PI_MEMORY_CONFIG = prior;
    await rm(root, { recursive: true, force: true });
  });
  const owned = join(root, "owned"),
    outside = join(root, "outside");
  await mkdir(owned);
  await mkdir(outside);
  await mkdir(join(outside, ".git"));
  const markerPath = join(owned, ".pi-memory-scope.json"),
    catalogPath = join(root, "catalog.json");
  await writeFile(
    markerPath,
    JSON.stringify({
      version: 2,
      scopeId: "test-scope",
      projectId: "test-project",
    }),
  );
  await writeFile(
    catalogPath,
    JSON.stringify({
      projects: {
        "test-project": {
          projectId: "test-project",
          name: "Existing",
          aliases: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
      scopes: {
        "test-scope": {
          scopeId: "test-scope",
          projectId: "test-project",
          name: "owned",
          markerPath,
          memoryTag: "legacy:test-scope",
        },
      },
    }),
  );
  process.env.PI_MEMORY_CONFIG = join(root, "config.json");
  // Record requests to prove refusal/headless startup never contacts Hindsight.
  await writeFile(
    process.env.PI_MEMORY_CONFIG,
    JSON.stringify({ ...config, endpoint: server.endpoint, catalogPath }),
  );
  process.chdir(owned);
  const active = await loadExtensions([entry], owned);
  assert.deepEqual(active.errors, []);
  assert.ok(active.extensions[0]?.tools.has("hindsight_memory"));
  assert.ok(active.extensions[0]?.handlers.has("resources_discover"));
  process.chdir(outside);
  const inactive = await loadExtensions([entry], outside);
  assert.deepEqual(inactive.errors, []);
  const extension = inactive.extensions[0];
  assert.ok(extension);
  assert.equal(extension.tools.size, 0);
  assert.deepEqual([...extension.handlers.keys()].sort(), [
    "resources_discover",
    "session_start",
  ]);
  assert.ok(extension.commands.has("memory-find"));
  assert.ok(extension.commands.has("memory-create-project"));
  assert.ok(extension.commands.has("memory-reassign-scope"));
  const startup = extension.handlers.get("session_start")?.[0];
  assert.ok(startup);
  const context = {
    cwd: outside,
    hasUI: false,
    signal: new AbortController().signal,
    sessionManager: { getSessionId: () => "new-session", getBranch: () => [] },
    ui: { select: async () => undefined, notify: () => {} },
  };
  await startup({ type: "session_start" }, context as never);
  assert.equal(extension.tools.size, 0);
  context.hasUI = true;
  await startup({ type: "session_start" }, context as never);
  assert.equal(extension.tools.size, 0);
  await assert.rejects(readFile(join(outside, ".pi-memory-scope.json")));
  assert.equal(server.requests.length, 0);
  const onboardingPrompts: string[] = [];
  const approved = {
    ...context,
    ui: {
      confirm: async () => {
        throw new Error("new registration must not ask for confirmation");
      },
      select: async (title: string, options: string[]) => {
        onboardingPrompts.push(title);
        assert.deepEqual(options, ["Existing", "새 Project 만들기"]);
        return "Existing";
      },
      input: async () => {
        throw new Error(
          "existing Project registration must not ask for a name",
        );
      },
      notify: () => {},
    },
  };
  await startup({ type: "session_start" }, approved as never);
  assert.deepEqual(onboardingPrompts, ["outside Scope를 등록할 Project"]);
  const registered = JSON.parse(await readFile(catalogPath, "utf8"));
  assert.equal(
    Object.values(registered.scopes as Record<string, { name: string }>).filter(
      (scope) => scope.name === "outside",
    ).length,
    1,
  );
  assert.ok(extension.tools.has("hindsight_memory"));
  assert.ok(extension.handlers.has("before_agent_start"));
  assert.equal(extension.handlers.get("session_start")?.length, 1);
  const restoredMarkerPath = join(outside, ".pi-memory-scope.json");
  const originalMarker = await readFile(restoredMarkerPath, "utf8");
  assert.equal(server.requests.length, 0);
  await rm(restoredMarkerPath);
  const restoration = await loadExtensions([entry], outside);
  assert.deepEqual(restoration.errors, []);
  const restoredExtension = restoration.extensions[0];
  assert.ok(restoredExtension);
  assert.equal(restoredExtension.tools.size, 0);
  const restoreOnStart = restoredExtension.handlers.get("session_start")?.[0];
  assert.ok(restoreOnStart);
  const restorationPrompts: string[] = [];
  const restoreContext = {
    ...approved,
    ui: {
      ...approved.ui,
      confirm: async (title: string) => {
        restorationPrompts.push(title);
        return true;
      },
      select: async () => {
        throw new Error("restoration must not create another Scope");
      },
      input: async () => {
        throw new Error("restoration must keep the existing name");
      },
    },
  };
  await restoreOnStart({ type: "session_start" }, restoreContext as never);
  assert.deepEqual(restorationPrompts, ["기존 Scope 마커 복원"]);
  assert.equal(await readFile(restoredMarkerPath, "utf8"), originalMarker);
  assert.ok(restoredExtension.tools.has("hindsight_memory"));
  assert.equal(server.requests.length, 0);
  for (const stop of restoredExtension.handlers.get("session_shutdown") ?? [])
    await stop({ type: "session_shutdown" }, restoreContext as never);
  for (const before of extension.handlers.get("before_agent_start") ?? [])
    await before(
      {
        type: "before_agent_start",
        prompt: "project context",
        messageType: "user",
        images: [],
        systemPrompt: "",
      },
      approved as never,
    );
  assert.ok(server.requests.length > 0);
  for (const stop of extension.handlers.get("session_shutdown") ?? [])
    await stop({ type: "session_shutdown" }, approved as never);
});
