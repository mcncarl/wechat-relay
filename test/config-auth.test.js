// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createAuthenticator } from "../src/auth.js";
import { assertNoBody } from "../src/body.js";
import { assertSupportedNodeVersion, isLoopbackAddress, loadConfig } from "../src/config.js";
import { resolveRoute } from "../src/routes.js";

function validEnv() {
  return {
    WECHAT_APP_ID: "test-app-id",
    WECHAT_APP_SECRET: "test-app-secret",
    RELAY_TOKEN: "r".repeat(48),
    DB_PATH: ":memory:",
  };
}

test("startup fails closed when any required credential is missing", () => {
  for (const name of ["WECHAT_APP_ID", "WECHAT_APP_SECRET", "RELAY_TOKEN"]) {
    const env = validEnv();
    delete env[name];
    assert.throws(() => loadConfig(env), { code: `missing_${name}` });
  }
});

test("executable exits before listening when credentials are absent", () => {
  const result = spawnSync(process.execPath, ["src/index.js"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /"event":"startup\.failed"/u);
  assert.match(result.stderr, /"code":"missing_WECHAT_APP_ID"/u);
});

test("relay token must encode at least 32 random bytes", () => {
  assert.throws(
    () => loadConfig({ ...validEnv(), RELAY_TOKEN: "x".repeat(31) }),
    { code: "invalid_RELAY_TOKEN_length" },
  );
  assert.throws(
    () => loadConfig({ ...validEnv(), RELAY_TOKEN: "z".repeat(42) }),
    { code: "invalid_RELAY_TOKEN_length" },
  );
  assert.equal(loadConfig({ ...validEnv(), RELAY_TOKEN: "z".repeat(43) }).relayToken.length, 43);
  assert.throws(
    () => loadConfig({ ...validEnv(), RELAY_TOKEN: "a".repeat(63) }),
    { code: "invalid_RELAY_TOKEN_length" },
  );
  assert.equal(loadConfig({ ...validEnv(), RELAY_TOKEN: "a".repeat(64) }).relayToken.length, 64);
  assert.throws(
    () => loadConfig({ ...validEnv(), RELAY_TOKEN: "密".repeat(32) }),
    { code: "invalid_RELAY_TOKEN" },
  );
  assert.throws(
    () => loadConfig({ ...validEnv(), RELAY_TOKEN: `${"x".repeat(32)} internal-space` }),
    { code: "invalid_RELAY_TOKEN" },
  );
});

test("configuration rejects non-loopback binding", () => {
  assert.throws(
    () => loadConfig({ ...validEnv(), HOST: "0.0.0.0" }),
    { code: "non_loopback_HOST" },
  );
  assert.equal(loadConfig({ ...validEnv(), HOST: "::1" }).host, "::1");
});

test("runtime rejects unverified Node major lines", () => {
  for (const version of ["20.20.2", "22.22.0", "24.14.1"]) {
    assert.doesNotThrow(() => assertSupportedNodeVersion(version));
  }
  for (const version of ["19.9.0", "21.7.3", "23.11.1", "25.0.0", "invalid"]) {
    assert.throws(
      () => assertSupportedNodeVersion(version),
      { code: "unsupported_NODE_VERSION" },
    );
  }
});

test("idempotency capacity and failed-safe retention are bounded", () => {
  const defaults = loadConfig(validEnv());
  assert.equal(defaults.idempotencyMaxRecords, 10_000);
  assert.equal(defaults.idempotencyFailedSafeRetentionMs, 7 * 24 * 60 * 60 * 1_000);
  assert.throws(
    () => loadConfig({ ...validEnv(), IDEMPOTENCY_MAX_RECORDS: "99" }),
    { code: "invalid_IDEMPOTENCY_MAX_RECORDS" },
  );
  assert.throws(
    () => loadConfig({ ...validEnv(), IDEMPOTENCY_FAILED_SAFE_RETENTION_MS: "59999" }),
    { code: "invalid_IDEMPOTENCY_FAILED_SAFE_RETENTION_MS" },
  );
});

test("loopback peer recognition is narrow", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("192.0.2.10"), false);
});

test("route matching rejects non-canonical paths and query spellings", () => {
  assert.throws(
    () => resolveRoute("/wechat/ignored/../draft/get", "POST"),
    { statusCode: 400, code: "invalid_request_target" },
  );
  assert.throws(
    () => resolveRoute("/wechat/material/add_material?type=image&", "POST"),
    { statusCode: 400, code: "invalid_material_type" },
  );
  assert.throws(
    () => resolveRoute("/v1/health?", "GET"),
    { statusCode: 400, code: "unexpected_query" },
  );
  assert.throws(
    () => resolveRoute("/wechat/material/add_material?", "POST"),
    { statusCode: 400, code: "invalid_material_type" },
  );
  assert.equal(resolveRoute("/wechat/material/add_material?type=image", "POST").query.type, "image");
});

test("status endpoints reject declared or streamed request bodies", () => {
  assert.doesNotThrow(() => assertNoBody({ headers: { "content-length": "0" } }));
  assert.throws(
    () => assertNoBody({ headers: { "content-length": "1" } }),
    { statusCode: 400, code: "unexpected_body" },
  );
  assert.throws(
    () => assertNoBody({ headers: { "transfer-encoding": "chunked" } }),
    { statusCode: 400, code: "unexpected_body" },
  );
});

test("authentication accepts exactly one correct credential header", () => {
  const token = "a".repeat(48);
  const authenticate = createAuthenticator(token);
  assert.doesNotThrow(() => authenticate({ headers: { authorization: `Bearer ${token}` } }));
  assert.doesNotThrow(() => authenticate({ headers: { "x-relay-token": token } }));
  assert.throws(() => authenticate({ headers: { authorization: "Bearer wrong" } }), { statusCode: 401 });
  assert.throws(
    () => authenticate({
      headers: { authorization: `Bearer ${token}`, "x-relay-token": token },
    }),
    { statusCode: 400, code: "ambiguous_authentication" },
  );
  for (const headers of [
    { authorization: "", "x-relay-token": token },
    { authorization: `Bearer ${token}`, "x-relay-token": "" },
  ]) {
    assert.throws(
      () => authenticate({ headers }),
      { statusCode: 400, code: "ambiguous_authentication" },
    );
  }
  assert.throws(
    () => authenticate({
      headers: { authorization: `Bearer ${token}` },
      rawHeaders: ["Authorization", `Bearer ${token}`, "Authorization", "Bearer other"],
    }),
    { statusCode: 400, code: "ambiguous_authentication" },
  );
});
