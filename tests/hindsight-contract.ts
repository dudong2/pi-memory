import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Compile } from "typebox/compile";

// Projected from the running Hindsight 1.1.0 OpenAPI, not memory contents.
// Replaying a schema snapshot keeps routine tests offline and deterministic.
const { components } = JSON.parse(
  readFileSync(
    process.env.PI_MEMORY_CONTRACT_SCHEMA ??
      new URL("./fixtures/hindsight-v1.1.0.schema.json", import.meta.url),
    "utf8",
  ),
);
const validators = new Map<string, { Check(value: unknown): boolean }>();
export function assertContract(name: string, value: unknown): void {
  let validator = validators.get(name);
  if (!validator) {
    validator = Compile({ $ref: `#/components/schemas/${name}`, components });
    validators.set(name, validator);
  }
  assert.ok(
    validator.Check(value),
    `Hindsight 1.1.0 ${name} contract mismatch`,
  );
}
