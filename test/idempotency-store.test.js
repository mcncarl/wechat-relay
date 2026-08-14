// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { IdempotencyStore } from "../src/idempotency-store.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

test("SQLite stores only a key digest, route, body hash, stage, and timestamps", (t) => {
  const store = new IdempotencyStore(":memory:");
  t.after(() => store.close());
  assert.deepEqual(store.columns(), [
    "idempotency_key_sha256",
    "route",
    "body_sha256",
    "stage",
    "created_at_ms",
    "updated_at_ms",
  ]);
  assert.equal(store.ready(), true);
});

test("completed and uncertain requests block replay without storing a response", (t) => {
  const store = new IdempotencyStore(":memory:");
  t.after(() => store.close());

  assert.deepEqual(store.begin("draft-key", "draft.add", HASH_A), {
    action: "proceed",
    stage: "forwarding",
  });
  store.mark("draft-key", "draft.add", HASH_A, "completed");
  assert.equal(store.begin("draft-key", "draft.add", HASH_A).action, "blocked");
  assert.equal(store.begin("draft-key", "draft.add", HASH_B).action, "conflict");
  assert.deepEqual(store.get("draft-key"), {
    idempotency_key_sha256: "f7fd33b02ccda6d361d7796707f2cfd496ef99439ce27ab6cb51754b4ed83ad9",
    route: "draft.add",
    body_sha256: HASH_A,
    stage: "completed",
  });
  assert.equal(JSON.stringify(store.get("draft-key")).includes("draft-key"), false);

  store.begin("unknown-key", "draft.add", HASH_B);
  store.mark("unknown-key", "draft.add", HASH_B, "outcome_unknown");
  assert.equal(store.begin("unknown-key", "draft.add", HASH_B).action, "blocked");
});

test("only a safely failed request may reuse the same key and hash", (t) => {
  const store = new IdempotencyStore(":memory:");
  t.after(() => store.close());
  store.begin("retry-key", "draft.add", HASH_A);
  store.mark("retry-key", "draft.add", HASH_A, "failed_safe");
  assert.deepEqual(store.begin("retry-key", "draft.add", HASH_A), {
    action: "proceed",
    stage: "forwarding",
  });
  assert.equal(store.get("retry-key").stage, "forwarding");
});

test("protected outcomes fill a fixed capacity without being evicted", (t) => {
  const store = new IdempotencyStore(":memory:", {
    maxRecords: 2,
    failedSafeRetentionMs: 50,
  });
  t.after(() => store.close());
  store.begin("completed-key", "draft.add", HASH_A, 0);
  store.mark("completed-key", "draft.add", HASH_A, "completed", 1);
  store.begin("uncertain-key", "draft.add", HASH_B, 2);
  store.mark("uncertain-key", "draft.add", HASH_B, "outcome_unknown", 3);

  assert.deepEqual(store.begin("new-key", "draft.add", HASH_A, 100), {
    action: "capacity",
    stage: "capacity",
  });
  assert.equal(store.size(), 2);
  assert.equal(store.hasCapacity(102), false);
  assert.equal(store.begin("completed-key", "draft.add", HASH_A, 101).action, "blocked");
  assert.equal(store.get("uncertain-key").stage, "outcome_unknown");
});

test("only expired failed-safe metadata is reclaimed automatically", (t) => {
  const store = new IdempotencyStore(":memory:", {
    maxRecords: 2,
    failedSafeRetentionMs: 50,
  });
  t.after(() => store.close());
  store.begin("completed-key", "draft.add", HASH_A, 0);
  store.mark("completed-key", "draft.add", HASH_A, "completed", 1);
  store.begin("safe-failure-key", "draft.add", HASH_B, 2);
  store.mark("safe-failure-key", "draft.add", HASH_B, "failed_safe", 3);

  assert.equal(store.hasCapacity(54), true);
  assert.equal(store.begin("replacement-key", "draft.add", HASH_B, 55).action, "proceed");
  assert.equal(store.get("safe-failure-key"), null);
  assert.equal(store.size(), 2);
  assert.equal(store.hasCapacity(56), false);
  assert.equal(store.get("completed-key").stage, "completed");
});
