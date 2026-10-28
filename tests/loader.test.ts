import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

test("Pi's real loader registers the bridge without starting lifecycle work", async () => {
  // Explicit path only: do not discover installed/global extensions or run hooks.
  const result = await loadExtensions([resolve("src/index.ts")], process.cwd());
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  const extension = result.extensions[0];
  assert.ok(extension);
  assert.ok(extension.tools.has("hindsight_memory"));
  for (const event of [
    "before_agent_start",
    "agent_settled",
    "session_shutdown",
    "before_provider_request",
  ]) {
    assert.ok(extension.handlers.has(event));
  }
  assert.equal(extension.handlers.has("context"), false);
});
