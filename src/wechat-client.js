// SPDX-License-Identifier: AGPL-3.0-or-later

import { UpstreamError } from "./errors.js";

const API_ORIGIN = "https://api.weixin.qq.com";
const INVALID_ACCESS_TOKEN_CODES = new Set([40_001, 40_014, 42_001]);

function timeoutError(outcomeUnknown) {
  return new UpstreamError("upstream_timeout", 504, outcomeUnknown);
}

async function settleBefore(promise, deadline, outcomeUnknown) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw timeoutError(outcomeUnknown);
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(timeoutError(outcomeUnknown)), remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedJson(response, maximumBytes, outcomeUnknown) {
  const announced = response.headers.get("content-length");
  if (announced && /^\d+$/u.test(announced) && Number(announced) > maximumBytes) {
    throw new UpstreamError("upstream_response_too_large", 502, outcomeUnknown);
  }
  if (!response.body) {
    throw new UpstreamError("upstream_empty_response", 502, outcomeUnknown);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new UpstreamError("upstream_response_too_large", 502, outcomeUnknown);
    }
    chunks.push(Buffer.from(value));
  }
  let data;
  try {
    data = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch {
    throw new UpstreamError("upstream_invalid_json", 502, outcomeUnknown);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new UpstreamError("upstream_invalid_json_shape", 502, outcomeUnknown);
  }
  return data;
}

export class WechatClient {
  constructor(config, fetchImpl = fetch) {
    this.appId = config.appId;
    this.appSecret = config.appSecret;
    this.timeoutMs = config.upstreamTimeoutMs;
    this.maximumResponseBytes = config.maxUpstreamResponseBytes;
    this.fetchImpl = fetchImpl;
    this.accessToken = "";
    this.accessTokenExpiresAt = 0;
    this.refreshPromise = null;
  }

  async fetchJson(url, options, outcomeUnknown, deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw timeoutError(outcomeUnknown);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const response = await this.fetchImpl(url, {
        ...options,
        redirect: "error",
        signal: controller.signal,
      });
      const data = await readBoundedJson(response, this.maximumResponseBytes, outcomeUnknown);
      return { status: response.status, data };
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      const timeout = error?.name === "AbortError";
      throw new UpstreamError(
        timeout ? "upstream_timeout" : "upstream_unavailable",
        timeout ? 504 : 502,
        outcomeUnknown,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async refreshAccessToken(deadline) {
    const url = new URL("/cgi-bin/token", API_ORIGIN);
    url.searchParams.set("grant_type", "client_credential");
    url.searchParams.set("appid", this.appId);
    url.searchParams.set("secret", this.appSecret);
    const { status, data } = await this.fetchJson(url, { method: "GET" }, false, deadline);
    if (status < 200 || status >= 300 || typeof data.access_token !== "string" || !data.access_token) {
      throw new UpstreamError("upstream_auth_rejected", 502, false);
    }
    const lifetimeSeconds = Number.isFinite(Number(data.expires_in)) ? Number(data.expires_in) : 7_200;
    this.accessToken = data.access_token;
    this.accessTokenExpiresAt = Date.now() + Math.max(60, lifetimeSeconds - 300) * 1_000;
    return this.accessToken;
  }

  async getAccessToken(force = false, deadline = Date.now() + this.timeoutMs) {
    if (force) {
      this.accessToken = "";
      this.accessTokenExpiresAt = 0;
    }
    if (this.accessToken && this.accessTokenExpiresAt > Date.now() + 60_000) {
      return this.accessToken;
    }
    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshAccessToken(deadline).finally(() => {
        this.refreshPromise = null;
      });
    }
    return settleBefore(this.refreshPromise, deadline, false);
  }

  async requestOperation(route, body, contentType, forceToken, deadline) {
    const accessToken = await this.getAccessToken(forceToken, deadline);
    const url = new URL(route.upstreamPath, API_ORIGIN);
    url.searchParams.set("access_token", accessToken);
    if (route.id === "material.add") {
      url.searchParams.set("type", route.query.type);
    }
    return this.fetchJson(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": contentType,
          "User-Agent": "wechat-relay/0.1",
        },
        body,
      },
      true,
      deadline,
    );
  }

  async forward(route, body, contentType) {
    const deadline = Date.now() + this.timeoutMs;
    let response = await this.requestOperation(route, body, contentType, false, deadline);
    if (INVALID_ACCESS_TOKEN_CODES.has(Number(response.data.errcode))) {
      response = await this.requestOperation(route, body, contentType, true, deadline);
    }
    return response;
  }

  async ensureReady() {
    await this.getAccessToken(false, Date.now() + this.timeoutMs);
    return true;
  }

  clearSecrets() {
    this.accessToken = "";
    this.accessTokenExpiresAt = 0;
    this.refreshPromise = null;
  }
}
