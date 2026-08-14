// SPDX-License-Identifier: AGPL-3.0-or-later

import path from "node:path";
import { ConfigurationError } from "./errors.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);
const SUPPORTED_NODE_MAJORS = new Set([20, 22, 24]);

export function assertSupportedNodeVersion(version = process.versions.node) {
  const major = Number.parseInt(String(version).split(".")[0], 10);
  if (!SUPPORTED_NODE_MAJORS.has(major)) {
    throw new ConfigurationError(
      "unsupported_NODE_VERSION",
      "Node.js major version must be 20, 22, or 24.",
    );
  }
}

function required(env, name) {
  const value = String(env[name] ?? "").trim();
  if (!value) {
    throw new ConfigurationError(`missing_${name}`, `${name} is required.`);
  }
  return value;
}

function boundedInteger(env, name, fallback, minimum, maximum) {
  const raw = String(env[name] ?? "").trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ConfigurationError(
      `invalid_${name}`,
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function validateRelayToken(token) {
  if (!/^[A-Za-z0-9._~+/=-]+$/u.test(token)) {
    throw new ConfigurationError(
      "invalid_RELAY_TOKEN",
      "RELAY_TOKEN must use visible ASCII base64, base64url, hex, or equivalent token characters.",
    );
  }
  const byteLength = Buffer.byteLength(token, "utf8");
  const minimumEncodedLength = /^[0-9a-f]+$/iu.test(token) ? 64 : 43;
  if (byteLength < minimumEncodedLength || byteLength > 512) {
    throw new ConfigurationError(
      "invalid_RELAY_TOKEN_length",
      "RELAY_TOKEN must encode at least 32 random bytes (43 base64/base64url characters or 64 hex characters) and be at most 512 characters.",
    );
  }
}

export function loadConfig(env = process.env) {
  assertSupportedNodeVersion();
  const appId = required(env, "WECHAT_APP_ID");
  const appSecret = required(env, "WECHAT_APP_SECRET");
  const relayToken = required(env, "RELAY_TOKEN");
  validateRelayToken(relayToken);

  const host = String(env.HOST ?? "").trim() || "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new ConfigurationError(
      "non_loopback_HOST",
      "HOST must be 127.0.0.1 or ::1. Put a private or TLS reverse proxy in front.",
    );
  }

  const dbPathValue = String(env.DB_PATH ?? "").trim() || "./data/idempotency.sqlite3";
  if (dbPathValue.includes("\u0000")) {
    throw new ConfigurationError("invalid_DB_PATH", "DB_PATH contains a null byte.");
  }

  return Object.freeze({
    appId,
    appSecret,
    relayToken,
    host,
    port: boundedInteger(env, "PORT", 18_794, 1_024, 65_535),
    dbPath: dbPathValue === ":memory:" ? dbPathValue : path.resolve(dbPathValue),
    maxJsonBodyBytes: boundedInteger(env, "MAX_JSON_BODY_BYTES", 4 * 1024 * 1024, 1_024, 8 * 1024 * 1024),
    maxMediaBodyBytes: boundedInteger(env, "MAX_MEDIA_BODY_BYTES", 20 * 1024 * 1024, 1_024, 32 * 1024 * 1024),
    maxUpstreamResponseBytes: boundedInteger(
      env,
      "MAX_UPSTREAM_RESPONSE_BYTES",
      2 * 1024 * 1024,
      1_024,
      8 * 1024 * 1024,
    ),
    bodyTimeoutMs: boundedInteger(env, "BODY_TIMEOUT_MS", 15_000, 1_000, 60_000),
    upstreamTimeoutMs: boundedInteger(env, "UPSTREAM_TIMEOUT_MS", 25_000, 1_000, 120_000),
    rateLimitWindowMs: boundedInteger(env, "RATE_LIMIT_WINDOW_MS", 60_000, 1_000, 3_600_000),
    rateLimitMaxRequests: boundedInteger(env, "RATE_LIMIT_MAX_REQUESTS", 60, 1, 10_000),
    healthRateLimitMaxRequests: boundedInteger(
      env,
      "HEALTH_RATE_LIMIT_MAX_REQUESTS",
      120,
      1,
      10_000,
    ),
    preauthRateLimitMaxRequests: boundedInteger(
      env,
      "PREAUTH_RATE_LIMIT_MAX_REQUESTS",
      120,
      1,
      10_000,
    ),
    maxConcurrentUpstream: boundedInteger(env, "MAX_CONCURRENT_UPSTREAM", 4, 1, 32),
    maxConnections: boundedInteger(env, "MAX_CONNECTIONS", 64, 4, 512),
    idempotencyMaxRecords: boundedInteger(
      env,
      "IDEMPOTENCY_MAX_RECORDS",
      10_000,
      100,
      100_000,
    ),
    idempotencyFailedSafeRetentionMs: boundedInteger(
      env,
      "IDEMPOTENCY_FAILED_SAFE_RETENTION_MS",
      7 * 24 * 60 * 60 * 1_000,
      60_000,
      30 * 24 * 60 * 60 * 1_000,
    ),
  });
}

export function isLoopbackAddress(address) {
  const normalized = String(address ?? "").toLowerCase();
  return normalized === "127.0.0.1"
    || normalized === "::1"
    || normalized === "::ffff:127.0.0.1";
}
