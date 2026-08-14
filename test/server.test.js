// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createRelayService } from "../src/server.js";
import { authHeaders, jsonResponse, testConfig } from "./helpers.js";

async function withService(t, overrides = {}) {
  const config = testConfig(overrides.config);
  const logs = [];
  const upstreamCalls = [];
  const fetchImpl = overrides.fetchImpl ?? (async (url, options) => {
    const parsed = new URL(url);
    upstreamCalls.push({ url: parsed, options });
    if (parsed.pathname === "/cgi-bin/token") {
      return jsonResponse({ access_token: "memory-only-token", expires_in: 7_200 });
    }
    if (parsed.pathname === "/cgi-bin/material/add_material") {
      return jsonResponse({ errcode: 0, media_id: "private-cover-id" });
    }
    if (parsed.pathname === "/cgi-bin/media/uploadimg") {
      return jsonResponse({ errcode: 0, url: "https://mmbiz.qpic.cn/test-image" });
    }
    if (parsed.pathname === "/cgi-bin/draft/add") {
      return jsonResponse({ errcode: 0, media_id: "private-draft-id" });
    }
    if (parsed.pathname === "/cgi-bin/draft/get") {
      return jsonResponse({ errcode: 0, news_item: [{ title: "private-title" }] });
    }
    throw new Error("unexpected test URL");
  });
  const service = createRelayService({
    config,
    fetchImpl,
    logStream: { write: (chunk) => { logs.push(chunk); } },
  });
  const address = await service.listen();
  t.after(async () => service.close());
  return {
    config,
    logs,
    upstreamCalls,
    service,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for test condition.");
}

test("health is minimal while readiness is authenticated", async (t) => {
  const fixture = await withService(t);
  assert.equal(fixture.service.server.maxConnections, fixture.config.maxConnections);
  const health = await fetch(`${fixture.baseUrl}/v1/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  const denied = await fetch(`${fixture.baseUrl}/v1/ready`);
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get("cache-control"), "no-store");

  const ready = await fetch(`${fixture.baseUrl}/v1/ready`, {
    headers: authHeaders(fixture.config),
  });
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { ready: true });
});

test("all four compatibility routes use fixed upstream paths and strict content types", async (t) => {
  const fixture = await withService(t);
  const boundary = "test-boundary";
  const multipartHeaders = authHeaders(fixture.config, {
    "Content-Type": `multipart/form-data; boundary=${boundary}`,
  });
  const cover = await fetch(`${fixture.baseUrl}/wechat/material/add_material?type=image`, {
    method: "POST",
    headers: multipartHeaders,
    body: Buffer.from(`--${boundary}--\r\n`),
  });
  assert.equal(cover.status, 200);
  assert.equal((await cover.json()).media_id, "private-cover-id");

  const image = await fetch(`${fixture.baseUrl}/wechat/media/uploadimg`, {
    method: "POST",
    headers: multipartHeaders,
    body: Buffer.from(`--${boundary}--\r\n`),
  });
  assert.equal(image.status, 200);

  const draftBody = JSON.stringify({
    articles: [{ title: "private-title", content: "private-body" }],
  });
  const draft = await fetch(`${fixture.baseUrl}/wechat/draft/add`, {
    method: "POST",
    headers: authHeaders(fixture.config, {
      "Content-Type": "application/json; charset=utf-8",
      "Idempotency-Key": "draft-key-0001",
    }),
    body: draftBody,
  });
  assert.equal(draft.status, 200);
  assert.equal((await draft.json()).media_id, "private-draft-id");

  const readback = await fetch(`${fixture.baseUrl}/wechat/draft/get`, {
    method: "POST",
    headers: authHeaders(fixture.config, { "Content-Type": "application/json" }),
    body: JSON.stringify({ media_id: "private-draft-id" }),
  });
  assert.equal(readback.status, 200);

  assert.deepEqual(
    fixture.upstreamCalls.map((call) => call.url.pathname),
    [
      "/cgi-bin/token",
      "/cgi-bin/material/add_material",
      "/cgi-bin/media/uploadimg",
      "/cgi-bin/draft/add",
      "/cgi-bin/draft/get",
    ],
  );
  assert.equal(fixture.upstreamCalls.every((call) => call.url.origin === "https://api.weixin.qq.com"), true);
  const logText = fixture.logs.join("");
  for (const forbidden of [
    fixture.config.relayToken,
    fixture.config.appSecret,
    "private-title",
    "private-body",
    "private-draft-id",
    "memory-only-token",
    "Authorization",
  ]) {
    assert.equal(logText.includes(forbidden), false);
  }
});

test("persistent idempotency stage blocks duplicate draft forwarding", async (t) => {
  const fixture = await withService(t);
  const request = {
    method: "POST",
    headers: authHeaders(fixture.config, {
      "Content-Type": "application/json",
      "Idempotency-Key": "same-draft-key",
    }),
    body: JSON.stringify({ articles: [{ title: "one" }] }),
  };
  assert.equal((await fetch(`${fixture.baseUrl}/wechat/draft/add`, request)).status, 200);
  const operationCount = fixture.upstreamCalls.filter(
    (call) => call.url.pathname === "/cgi-bin/draft/add",
  ).length;
  const duplicate = await fetch(`${fixture.baseUrl}/wechat/draft/add`, request);
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error.code, "idempotency_replay_blocked");
  assert.equal(
    fixture.upstreamCalls.filter((call) => call.url.pathname === "/cgi-bin/draft/add").length,
    operationCount,
  );

  const changed = await fetch(`${fixture.baseUrl}/wechat/draft/add`, {
    ...request,
    body: JSON.stringify({ articles: [{ title: "changed" }] }),
  });
  assert.equal(changed.status, 409);
  assert.equal((await changed.json()).error.code, "idempotency_conflict");
  assert.equal(fixture.service.store.get("same-draft-key").stage, "completed");
});

test("draft creation fails closed before forwarding when Idempotency-Key is absent", async (t) => {
  const fixture = await withService(t);
  const response = await fetch(`${fixture.baseUrl}/wechat/draft/add`, {
    method: "POST",
    headers: authHeaders(fixture.config, { "Content-Type": "application/json" }),
    body: JSON.stringify({ articles: [{ title: "private-title" }] }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "missing_idempotency_key");
  assert.equal(
    fixture.upstreamCalls.some((call) => call.url.pathname === "/cgi-bin/draft/add"),
    false,
  );
});

test("idempotency capacity rejects new drafts without evicting protected outcomes", async (t) => {
  const fixture = await withService(t, {
    config: {
      idempotencyMaxRecords: 1,
      idempotencyFailedSafeRetentionMs: 60_000,
    },
  });
  const create = (key, title) => fetch(`${fixture.baseUrl}/wechat/draft/add`, {
    method: "POST",
    headers: authHeaders(fixture.config, {
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    }),
    body: JSON.stringify({ articles: [{ title }] }),
  });

  assert.equal((await create("capacity-first-key", "first")).status, 200);
  const blocked = await create("capacity-second-key", "second");
  assert.equal(blocked.status, 503);
  assert.equal((await blocked.json()).error.code, "idempotency_capacity_exhausted");
  assert.equal(fixture.service.store.get("capacity-first-key").stage, "completed");
  assert.equal(
    fixture.upstreamCalls.filter((call) => call.url.pathname === "/cgi-bin/draft/add").length,
    1,
  );
  const ready = await fetch(`${fixture.baseUrl}/v1/ready`, {
    headers: authHeaders(fixture.config),
  });
  assert.equal(ready.status, 503);
  assert.equal((await ready.json()).error.code, "idempotency_capacity_exhausted");
});

test("a local completion-write failure remains blocked as outcome unknown", async (t) => {
  const fixture = await withService(t);
  const originalMark = fixture.service.store.mark.bind(fixture.service.store);
  let simulatedFailure = true;
  fixture.service.store.mark = (...args) => {
    if (simulatedFailure && args[3] === "completed") {
      simulatedFailure = false;
      throw new Error("simulated local completion failure");
    }
    return originalMark(...args);
  };

  const response = await fetch(`${fixture.baseUrl}/wechat/draft/add`, {
    method: "POST",
    headers: authHeaders(fixture.config, {
      "Content-Type": "application/json",
      "Idempotency-Key": "completion-write-failure",
    }),
    body: JSON.stringify({ articles: [{ title: "private-title" }] }),
  });
  assert.equal(response.status, 500);
  assert.equal(fixture.service.store.get("completion-write-failure").stage, "outcome_unknown");
});

test("path, method, query, content type, and body size are bounded", async (t) => {
  const fixture = await withService(t, {
    config: {
      maxJsonBodyBytes: 96,
    },
  });
  const auth = authHeaders(fixture.config);

  assert.equal((await fetch(`${fixture.baseUrl}/unknown`)).status, 404);
  assert.equal((await fetch(`${fixture.baseUrl}/wechat/draft/add`, { headers: auth })).status, 405);
  assert.equal((await fetch(`${fixture.baseUrl}/wechat/material/add_material?type=image&`, {
    method: "POST",
    headers: authHeaders(fixture.config, { "Content-Type": "multipart/form-data; boundary=x" }),
    body: Buffer.from("--x--\r\n"),
  })).status, 400);
  assert.equal((await fetch(`${fixture.baseUrl}/wechat/draft/get?extra=1`, {
    method: "POST",
    headers: authHeaders(fixture.config, { "Content-Type": "application/json" }),
    body: JSON.stringify({ media_id: "x" }),
  })).status, 400);
  assert.equal((await fetch(`${fixture.baseUrl}/wechat/draft/add`, {
    method: "POST",
    headers: authHeaders(fixture.config, { "Content-Type": "text/plain" }),
    body: "not-json",
  })).status, 415);
  assert.equal((await fetch(`${fixture.baseUrl}/wechat/draft/add`, {
    method: "POST",
    headers: authHeaders(fixture.config, {
      "Content-Type": "application/json",
      "Idempotency-Key": "oversized-draft-request",
    }),
    body: JSON.stringify({ articles: [{ content: "x".repeat(200) }] }),
  })).status, 413);

  assert.equal((await fetch(`${fixture.baseUrl}/v1/ready`, { headers: auth })).status, 200);
});

test("pre-authentication abuse cannot exhaust the authenticated quota", async (t) => {
  const fixture = await withService(t, {
    config: {
      preauthRateLimitMaxRequests: 2,
      rateLimitMaxRequests: 1,
    },
  });
  assert.equal((await fetch(`${fixture.baseUrl}/unknown-one`)).status, 404);
  assert.equal((await fetch(`${fixture.baseUrl}/unknown-two`)).status, 404);
  const rejectedAbuse = await fetch(`${fixture.baseUrl}/unknown-three`);
  assert.equal(rejectedAbuse.status, 429);
  assert.ok(Number(rejectedAbuse.headers.get("retry-after")) >= 1);

  const firstReady = await fetch(`${fixture.baseUrl}/v1/ready`, {
    headers: authHeaders(fixture.config),
  });
  assert.equal(firstReady.status, 200);
  const exhaustedAuthenticated = await fetch(`${fixture.baseUrl}/v1/ready`, {
    headers: authHeaders(fixture.config),
  });
  assert.equal(exhaustedAuthenticated.status, 429);
});

test("authenticated admission happens before body buffering and releases after abort", async (t) => {
  const fixture = await withService(t, { config: { maxConcurrentUpstream: 1 } });
  const firstSeen = new Promise((resolve) => fixture.service.server.once("request", resolve));
  const slowRequest = http.request(`${fixture.baseUrl}/wechat/draft/add`, {
    method: "POST",
    headers: authHeaders(fixture.config, {
      "Content-Type": "application/json",
      "Idempotency-Key": "slow-request-key",
      "Transfer-Encoding": "chunked",
    }),
  });
  slowRequest.on("error", () => {});
  t.after(() => slowRequest.destroy());
  slowRequest.write('{"articles":[');
  await firstSeen;

  const competing = await fetch(`${fixture.baseUrl}/wechat/draft/add`, {
    method: "POST",
    headers: authHeaders(fixture.config, {
      "Content-Type": "application/json",
      "Idempotency-Key": "competing-request-key",
    }),
    body: JSON.stringify({ articles: [{ title: "competing" }] }),
  });
  assert.equal(competing.status, 503);
  assert.equal((await competing.json()).error.code, "upstream_busy");

  slowRequest.destroy();
  await waitFor(() => fixture.logs.join("").includes("request_aborted"));
  const afterAbort = await fetch(`${fixture.baseUrl}/wechat/draft/add`, {
    method: "POST",
    headers: authHeaders(fixture.config, {
      "Content-Type": "application/json",
      "Idempotency-Key": "after-abort-key",
    }),
    body: JSON.stringify({ articles: [{ title: "after abort" }] }),
  });
  assert.equal(afterAbort.status, 200);
});

test("early authentication rejection closes an unread streamed body", async (t) => {
  const fixture = await withService(t);
  const result = await new Promise((resolve, reject) => {
    const request = http.request(`${fixture.baseUrl}/wechat/draft/add`, {
      method: "POST",
      headers: {
        Authorization: "Bearer wrong-token",
        "Content-Type": "application/json",
        "Idempotency-Key": "unauthorized-stream",
        "Transfer-Encoding": "chunked",
      },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve({
        statusCode: response.statusCode,
        connection: response.headers.connection,
      }));
    });
    request.once("error", reject);
    request.write('{"articles":[');
  });
  assert.deepEqual(result, { statusCode: 401, connection: "close" });
});
