// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS idempotency_requests (
    idempotency_key_sha256 TEXT PRIMARY KEY CHECK(length(idempotency_key_sha256) = 64),
    route TEXT NOT NULL,
    body_sha256 TEXT NOT NULL CHECK(length(body_sha256) = 64),
    stage TEXT NOT NULL CHECK(stage IN ('forwarding', 'completed', 'failed_safe', 'outcome_unknown')),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idempotency_failed_safe_age
    ON idempotency_requests(updated_at_ms)
    WHERE stage = 'failed_safe';
`;

function idempotencyKeySha256(key) {
  return createHash("sha256")
    .update("wechat-relay:idempotency-key:v1\0", "utf8")
    .update(key, "utf8")
    .digest("hex");
}

export class IdempotencyStore {
  constructor(filename, options = {}) {
    this.maxRecords = options.maxRecords ?? 10_000;
    this.failedSafeRetentionMs = options.failedSafeRetentionMs ?? 7 * 24 * 60 * 60 * 1_000;
    if (!Number.isSafeInteger(this.maxRecords) || this.maxRecords < 1) {
      throw new TypeError("maxRecords must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(this.failedSafeRetentionMs) || this.failedSafeRetentionMs < 1) {
      throw new TypeError("failedSafeRetentionMs must be a positive safe integer.");
    }
    if (filename !== ":memory:") {
      fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    }
    this.database = new Database(filename);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("synchronous = FULL");
    this.database.pragma("busy_timeout = 5000");
    this.database.pragma("wal_autocheckpoint = 1000");
    this.database.pragma("journal_size_limit = 16777216");
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("trusted_schema = OFF");
    this.database.exec(SCHEMA);
    if (filename !== ":memory:") {
      fs.chmodSync(filename, 0o600);
    }

    this.select = this.database.prepare(`
      SELECT idempotency_key_sha256, route, body_sha256, stage
      FROM idempotency_requests
      WHERE idempotency_key_sha256 = ?
    `);
    this.insert = this.database.prepare(`
      INSERT INTO idempotency_requests (
        idempotency_key_sha256, route, body_sha256, stage, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, 'forwarding', ?, ?)
    `);
    this.updateStage = this.database.prepare(`
      UPDATE idempotency_requests
      SET stage = ?, updated_at_ms = ?
      WHERE idempotency_key_sha256 = ? AND route = ? AND body_sha256 = ?
    `);
    this.restartFailed = this.database.prepare(`
      UPDATE idempotency_requests
      SET stage = 'forwarding', updated_at_ms = ?
      WHERE idempotency_key_sha256 = ? AND route = ? AND body_sha256 = ? AND stage = 'failed_safe'
    `);
    this.deleteExpiredFailedSafe = this.database.prepare(`
      DELETE FROM idempotency_requests
      WHERE stage = 'failed_safe' AND updated_at_ms <= ?
    `);
    this.countRecords = this.database.prepare(`
      SELECT COUNT(*) AS count FROM idempotency_requests
    `);
    this.beginTransaction = this.database.transaction((key, route, bodyHash, now) => {
      this.deleteExpiredFailedSafe.run(now - this.failedSafeRetentionMs);
      const existing = this.select.get(key);
      if (!existing) {
        if (this.countRecords.get().count >= this.maxRecords) {
          return { action: "capacity", stage: "capacity" };
        }
        this.insert.run(key, route, bodyHash, now, now);
        return { action: "proceed", stage: "forwarding" };
      }
      if (existing.route !== route || existing.body_sha256 !== bodyHash) {
        return { action: "conflict", stage: existing.stage };
      }
      if (existing.stage === "failed_safe") {
        this.restartFailed.run(now, key, route, bodyHash);
        return { action: "proceed", stage: "forwarding" };
      }
      return { action: "blocked", stage: existing.stage };
    });
    this.capacityTransaction = this.database.transaction((now) => {
      this.deleteExpiredFailedSafe.run(now - this.failedSafeRetentionMs);
      return this.countRecords.get().count < this.maxRecords;
    });
  }

  begin(key, route, bodyHash, now = Date.now()) {
    return this.beginTransaction.immediate(idempotencyKeySha256(key), route, bodyHash, now);
  }

  mark(key, route, bodyHash, stage, now = Date.now()) {
    if (!["completed", "failed_safe", "outcome_unknown"].includes(stage)) {
      throw new Error("Invalid idempotency stage transition.");
    }
    const result = this.updateStage.run(stage, now, idempotencyKeySha256(key), route, bodyHash);
    if (result.changes !== 1) {
      throw new Error("Idempotency stage transition lost its reservation.");
    }
  }

  ready() {
    return this.database.prepare("SELECT 1 AS ready").get()?.ready === 1;
  }

  hasCapacity(now = Date.now()) {
    return this.capacityTransaction.immediate(now);
  }

  get(key) {
    return this.select.get(idempotencyKeySha256(key)) ?? null;
  }

  columns() {
    return this.database.prepare("PRAGMA table_info(idempotency_requests)").all().map((row) => row.name);
  }

  size() {
    return this.countRecords.get().count;
  }

  close() {
    this.database.close();
  }
}
