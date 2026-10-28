import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Outbox, type RetainItem } from "../src/outbox.ts";
import { Delivery } from "../src/delivery.ts";
import { HindsightClient } from "../src/client.ts";
import { MemoryError, type MemoryWriter } from "../src/contracts.ts";
import { config, deferred } from "./helpers.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-outbox-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "queue.sqlite");
}
function item(
  text = "A durable user preference",
  documentId = "test-document",
): RetainItem {
  return {
    content: text,
    document_id: documentId,
    tags: ["scope:test"],
    metadata: { source_role: "user", kind: "remember" },
    update_mode: "replace",
    observation_scopes: "combined",
  };
}
function db(path: string, action: (value: DatabaseSync) => void) {
  const value = new DatabaseSync(path);
  try {
    action(value);
  } finally {
    value.close();
  }
}
function writer(): MemoryWriter & {
  posts: string[];
  operations: Map<string, string>;
} {
  const operations = new Map<string, string>(),
    posts: string[] = [];
  return {
    posts,
    operations,
    retain: async (request) => {
      posts.push(request.operation_id);
      operations.set(request.operation_id, "completed");
      return request.operation_id;
    },
    operation: async (id) =>
      (operations.get(id) ?? "not_found") as Awaited<
        ReturnType<MemoryWriter["operation"]>
      >,
    reflect: async () => "not used",
  };
}

test("legacy non-current Scope deliveries are preserved but never transmitted", async (t) => {
  const path = await fixture(t);
  const client = { ...writer(), destinationIdentity: "legacy-destination" };
  const queue = await Outbox.open(path, client.destinationIdentity);
  const receipt = queue.enqueue("legacy-common", {
    ...item(),
    metadata: { scope_type: "common" },
  });
  queue.close();
  const delivery = await Delivery.open({ ...config, outboxPath: path }, client);
  t.after(() => delivery.close());
  await delivery.flush();
  assert.deepEqual(client.posts, []);
  assert.equal(delivery.status().failed, 1);
  db(path, (sql) =>
    assert.ok(
      sql.prepare("SELECT payload FROM deliveries WHERE id=?").get(receipt.id)
        ?.payload,
    ),
  );
});

test("queue is private, durable, idempotent, and erases confirmed payloads", async (t) => {
  const path = await fixture(t),
    q = await Outbox.open(path, "destination");
  t.after(() => q.close());
  const first = q.enqueue("one", item());
  assert.equal(q.enqueue("one", item()).id, first.id);
  assert.throws(
    () => q.enqueue("one", item("changed")),
    /idempotency-conflict/,
  );
  assert.equal((await stat(path)).mode & 0o077, 0);
  const claimed = q.claim();
  assert.ok(claimed);
  assert.equal(claimed.id, first.id);
  q.finish(first.id);
  db(path, (sql) =>
    assert.equal(
      sql.prepare("SELECT payload FROM deliveries WHERE id=?").get(first.id)
        ?.payload,
      null,
    ),
  );
  assert.equal(q.enqueue("one", item()).state, "confirmed");
});

test("secret values are refused before a queue row is written", async (t) => {
  const q = await Outbox.open(await fixture(t), "destination");
  t.after(() => q.close());
  assert.throws(
    () => q.enqueue("secret", item(`sk-${"x".repeat(32)}`)),
    /secret-blocked/,
  );
  assert.throws(
    () =>
      q.enqueue(
        "json-secret",
        item('User memory:\n{"api_key":"synthetic-test-credential"}'),
      ),
    /secret-blocked/,
  );
  assert.equal(q.stats().queued, 0);
});

test("a later correction cannot overtake the pending write to the same document", async (t) => {
  const path = await fixture(t),
    q = await Outbox.open(path, "destination");
  t.after(() => q.close());
  const first = q.enqueue("one", item("old"));
  db(path, (sql) =>
    sql.prepare("UPDATE deliveries SET created_at=1 WHERE id=?").run(first.id),
  );
  q.enqueue("two", item("new"));
  assert.equal(q.claim()?.id, first.id);
  q.submitted(first.id);
  q.defer(first.id, "operation-pending");
  assert.equal(q.claim(), undefined);
});

test("another live owner is never stolen even when timestamps are old", async (t) => {
  const path = await fixture(t),
    a = await Outbox.open(path, "destination"),
    b = await Outbox.open(path, "destination");
  t.after(() => {
    a.close();
    b.close();
  });
  a.enqueue("one", item());
  assert.ok(a.claim());
  db(path, (sql) =>
    sql.exec("UPDATE deliveries SET created_at=0,next_attempt=0"),
  );
  assert.equal(b.claim(Date.now() + 86400000), undefined);
});

test("dead process ownership is recovered transactionally", async (t) => {
  const path = await fixture(t),
    q = await Outbox.open(path, "destination");
  t.after(() => q.close());
  const first = q.enqueue("one", item());
  await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {Outbox} from './src/outbox.ts'; const q=await Outbox.open(${JSON.stringify(path)},'destination'); if(!q.claim())process.exit(2);process.exit(0);`,
    ],
    { cwd: process.cwd() },
  );
  assert.equal(q.claim()?.id, first.id);
});

test("unknown host ownership and another destination are preserved", async (t) => {
  const path = await fixture(t),
    a = await Outbox.open(path, "destination"),
    b = await Outbox.open(path, "other");
  t.after(() => {
    a.close();
    b.close();
  });
  a.enqueue("one", item());
  assert.ok(a.claim());
  db(path, (sql) =>
    sql.exec("UPDATE deliveries SET owner_host='unknown-host'"),
  );
  assert.equal(a.claim(), undefined);
  assert.equal(b.claim(), undefined);
  assert.equal(b.stats().otherDestinations, 1);
});

test("delivery waits for the exact operation completion, not just acceptance", async (t) => {
  const path = await fixture(t),
    backend = writer();
  backend.retain = async (request) => {
    backend.posts.push(request.operation_id);
    backend.operations.set(request.operation_id, "processing");
    return request.operation_id;
  };
  const delivery = await Delivery.open(
    { ...config, outboxPath: path },
    backend,
  );
  t.after(() => delivery.close());
  const receipt = delivery.enqueue("one", item());
  await delivery.flush();
  assert.equal(receipt.state, "queued");
  assert.equal(delivery.status().submitted, 1);
  assert.equal(delivery.status().confirmed, 0);
  backend.operations.set(receipt.id, "completed");
  db(path, (sql) => sql.exec("UPDATE deliveries SET next_attempt=0"));
  await delivery.flush();
  assert.equal(delivery.status().confirmed, 1);
  assert.equal(backend.posts.length, 1);
});

test("lost retain acknowledgement reuses the operation and does not enqueue duplicate server work", async (t) => {
  const path = await fixture(t),
    backend = writer();
  backend.retain = async (request) => {
    backend.posts.push(request.operation_id);
    backend.operations.set(request.operation_id, "completed");
    throw new MemoryError("request-failed");
  };
  const delivery = await Delivery.open(
    { ...config, outboxPath: path },
    backend,
  );
  t.after(() => delivery.close());
  delivery.enqueue("one", item());
  await delivery.flush();
  assert.equal(delivery.status().queued, 1);
  db(path, (sql) => sql.exec("UPDATE deliveries SET next_attempt=0"));
  await delivery.flush();
  assert.equal(delivery.status().confirmed, 1);
  assert.equal(backend.posts.length, 1);
});

test("outage survives restart and retry metadata does not contain raw server errors", async (t) => {
  const path = await fixture(t),
    backend = writer();
  backend.operation = async () => {
    throw new Error("PRIVATE_SERVER_BODY");
  };
  const first = await Delivery.open({ ...config, outboxPath: path }, backend);
  first.enqueue("one", item());
  await first.flush();
  await first.close();
  db(path, (sql) => {
    assert.doesNotMatch(
      JSON.stringify(sql.prepare("SELECT error_code FROM deliveries").all()),
      /PRIVATE_SERVER_BODY/,
    );
    sql.exec("UPDATE deliveries SET next_attempt=0");
  });
  const second = await Delivery.open({ ...config, outboxPath: path }, writer());
  t.after(() => second.close());
  await second.flush();
  assert.equal(second.status().confirmed, 1);
});

test("pending data is not retargeted when the configured credential identity changes", async (t) => {
  const path = await fixture(t),
    settings = { ...config, outboxPath: path, apiKeyEnv: "QUEUE_TEST_KEY" };
  const firstClient = new HindsightClient(settings, {
    QUEUE_TEST_KEY: "synthetic-account-one",
  });
  firstClient.operation = async () => {
    throw new MemoryError("request-failed");
  };
  const first = await Delivery.open(settings, firstClient);
  first.enqueue("one", item());
  await first.flush();
  await first.close();
  const secondClient = new HindsightClient(settings, {
    QUEUE_TEST_KEY: "synthetic-account-two",
  });
  const second = await Delivery.open(settings, secondClient);
  t.after(() => second.close());
  assert.equal(second.status().queued, 0);
  assert.equal(second.status().otherDestinations, 1);
});

test("shutdown aborts network activity and leaves the payload for a later process", async (t) => {
  const path = await fixture(t),
    backend = writer(),
    entered = deferred<void>();
  backend.operation = async (_id, signal) => {
    entered.resolve();
    await new Promise<void>((_resolve, reject) =>
      signal.addEventListener(
        "abort",
        () => reject(new MemoryError("cancelled")),
        { once: true },
      ),
    );
    return "pending";
  };
  const delivery = await Delivery.open(
    { ...config, outboxPath: path },
    backend,
  );
  delivery.enqueue("one", item());
  await entered.promise;
  await delivery.close();
  db(path, (sql) => {
    const row = sql.prepare("SELECT payload,owner_pid FROM deliveries").get();
    assert.ok(row?.payload);
    assert.equal(row?.owner_pid, null);
  });
});
