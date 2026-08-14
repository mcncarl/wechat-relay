// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { UpstreamError } from "../src/errors.js";
import { WechatClient } from "../src/wechat-client.js";
import { jsonResponse, testConfig } from "./helpers.js";

const DRAFT_ROUTE = {
  id: "draft.add",
  upstreamPath: "/cgi-bin/draft/add",
  query: {},
};

test("client uses fixed WeChat paths and refreshes an invalid access token once", async () => {
  const calls = [];
  const responses = [
    jsonResponse({ access_token: "first-memory-token", expires_in: 7_200 }),
    jsonResponse({ errcode: 40_001, errmsg: "invalid credential" }),
    jsonResponse({ access_token: "second-memory-token", expires_in: 7_200 }),
    jsonResponse({ errcode: 0, media_id: "private-result" }),
  ];
  const client = new WechatClient(testConfig(), async (url, options) => {
    calls.push({ url: new URL(url), options });
    return responses.shift();
  });

  const result = await client.forward(
    DRAFT_ROUTE,
    Buffer.from('{"articles":[{}]}'),
    "application/json",
  );
  assert.equal(result.data.media_id, "private-result");
  assert.deepEqual(calls.map((call) => call.url.pathname), [
    "/cgi-bin/token",
    "/cgi-bin/draft/add",
    "/cgi-bin/token",
    "/cgi-bin/draft/add",
  ]);
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[1].url.origin, "https://api.weixin.qq.com");
  assert.equal(calls[1].url.searchParams.get("access_token"), "first-memory-token");
  assert.equal(calls[3].url.searchParams.get("access_token"), "second-memory-token");
  client.clearSecrets();
  assert.equal(client.accessToken, "");
});

test("operation timeout is marked as outcome unknown", async () => {
  const config = testConfig({ upstreamTimeoutMs: 10 });
  let calls = 0;
  const client = new WechatClient(config, async (_url, options) => {
    calls += 1;
    if (calls === 1) return jsonResponse({ access_token: "memory-token", expires_in: 7_200 });
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
  });

  await assert.rejects(
    client.forward(DRAFT_ROUTE, Buffer.from("{}"), "application/json"),
    (error) => error instanceof UpstreamError
      && error.code === "upstream_timeout"
      && error.outcomeUnknown === true,
  );
});

test("token refresh and retry share one total upstream deadline", async () => {
  const config = testConfig({ upstreamTimeoutMs: 30 });
  let calls = 0;
  const client = new WechatClient(config, async (_url, options) => {
    calls += 1;
    const call = calls;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (call === 1 || call === 3) {
          resolve(jsonResponse({ access_token: `memory-token-${call}`, expires_in: 7_200 }));
        } else if (call === 2) {
          resolve(jsonResponse({ errcode: 40_001, errmsg: "invalid credential" }));
        } else {
          resolve(jsonResponse({ errcode: 0, media_id: "should-not-complete" }));
        }
      }, 12);
      options.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
  });

  await assert.rejects(
    client.forward(DRAFT_ROUTE, Buffer.from("{}"), "application/json"),
    { code: "upstream_timeout" },
  );
  assert.ok(calls <= 3, `expected total deadline before fourth fetch, got ${calls}`);
});

test("oversized upstream JSON is rejected without exposing its content", async () => {
  const config = testConfig({ maxUpstreamResponseBytes: 32 });
  const client = new WechatClient(config, async () => jsonResponse(
    { access_token: "x".repeat(100), expires_in: 7_200 },
    { headers: { "Content-Length": "200" } },
  ));
  await assert.rejects(client.ensureReady(), { code: "upstream_response_too_large" });
});
