// SPDX-License-Identifier: AGPL-3.0-or-later

import http from "node:http";
import { randomUUID } from "node:crypto";
import { createAuthenticator } from "./auth.js";
import {
  assertNoBody,
  bodySha256,
  readBody,
  readIdempotencyKey,
  validateContentType,
  validateJsonBody,
} from "./body.js";
import { isLoopbackAddress } from "./config.js";
import { HttpError, UpstreamError } from "./errors.js";
import { IdempotencyStore } from "./idempotency-store.js";
import { createJsonLogger } from "./logger.js";
import { ConcurrencyGate, FixedWindowRateLimiter } from "./rate-limit.js";
import { resolveRoute } from "./routes.js";
import { WechatClient } from "./wechat-client.js";

const BASE_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});

function sendJson(res, statusCode, payload, requestId, extraHeaders = {}) {
  if (res.destroyed || res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(statusCode, {
    ...BASE_HEADERS,
    ...extraHeaders,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.length),
    "X-Request-Id": requestId,
  });
  res.end(body);
}

function errorForIdempotency(result) {
  if (result.action === "capacity") {
    return new HttpError(
      503,
      "idempotency_capacity_exhausted",
      "Idempotency metadata capacity is exhausted; reconcile retained outcomes before creating another draft.",
    );
  }
  if (result.action === "conflict") {
    return new HttpError(
      409,
      "idempotency_conflict",
      "Idempotency-Key was already used for a different request.",
    );
  }
  return new HttpError(
    409,
    "idempotency_replay_blocked",
    "This idempotent request already reached or may have reached the upstream. Reconcile before retrying.",
  );
}

function errorPayload(error) {
  if (error instanceof HttpError) {
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: error.message,
      headers: error.headers,
    };
  }
  if (error instanceof UpstreamError) {
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: "WeChat upstream request failed.",
      headers: {},
    };
  }
  return {
    statusCode: 500,
    code: "internal_error",
    message: "Internal server error.",
    headers: {},
  };
}

export function createRequestHandler({ config, store, wechat, logger }) {
  const authenticate = createAuthenticator(config.relayToken);
  const rateLimiter = new FixedWindowRateLimiter(
    config.rateLimitWindowMs,
    {
      authenticated: config.rateLimitMaxRequests,
      health: config.healthRateLimitMaxRequests,
      preauth: config.preauthRateLimitMaxRequests,
    },
  );
  const concurrency = new ConcurrencyGate(config.maxConcurrentUpstream);

  const enforceRateLimit = (key, policy) => {
    const rate = rateLimiter.consume(key, policy);
    if (!rate.allowed) {
      throw new HttpError(
        429,
        "rate_limited",
        "Rate limit exceeded.",
        { "Retry-After": String(rate.retryAfterSeconds) },
      );
    }
  };

  return async function handle(req, res) {
    const requestId = randomUUID();
    const startedAt = Date.now();
    let routeId = "unresolved";
    let bodyBytes = 0;
    let idempotency = false;
    let responseStatus = 500;
    let errorCode;

    try {
      if (!isLoopbackAddress(req.socket.remoteAddress)) {
        throw new HttpError(403, "non_loopback_peer", "Direct non-loopback peers are not accepted.");
      }
      let route;
      try {
        route = resolveRoute(req.url, req.method);
      } catch (error) {
        enforceRateLimit("preauth", "preauth");
        throw error;
      }
      routeId = route.id;

      if (route.kind === "health") {
        enforceRateLimit("health", "health");
        assertNoBody(req);
        responseStatus = 200;
        sendJson(res, 200, { ok: true }, requestId);
        return;
      }

      try {
        authenticate(req);
      } catch (error) {
        enforceRateLimit("preauth", "preauth");
        throw error;
      }
      enforceRateLimit("authenticated", "authenticated");
      if (route.kind === "ready") {
        assertNoBody(req);
        const release = concurrency.tryAcquire();
        if (!release) {
          throw new HttpError(503, "upstream_busy", "Upstream concurrency limit reached.");
        }
        try {
          if (!store.ready()) {
            throw new HttpError(503, "storage_not_ready", "Relay storage is not ready.");
          }
          if (!store.hasCapacity()) {
            throw new HttpError(
              503,
              "idempotency_capacity_exhausted",
              "Idempotency metadata capacity is exhausted.",
            );
          }
          await wechat.ensureReady();
        } finally {
          release();
        }
        responseStatus = 200;
        sendJson(res, 200, { ready: true }, requestId);
        return;
      }

      const contentType = validateContentType(req, route.contentKind);
      const idempotencyKey = readIdempotencyKey(req, route.idempotency);
      idempotency = Boolean(idempotencyKey);
      const release = concurrency.tryAcquire();
      if (!release) {
        throw new HttpError(503, "upstream_busy", "Upstream concurrency limit reached.");
      }
      try {
        const maximumBodyBytes = route.maxBody === "media"
          ? config.maxMediaBodyBytes
          : config.maxJsonBodyBytes;
        const body = await readBody(req, maximumBodyBytes, config.bodyTimeoutMs);
        bodyBytes = body.length;
        if (route.contentKind === "json") validateJsonBody(route.id, body);
        const hash = bodySha256(body);

        let reservationStarted = false;
        let reservationFinalized = false;
        let upstreamStarted = false;
        try {
          if (idempotencyKey) {
            const reservation = store.begin(idempotencyKey, route.id, hash);
            if (reservation.action !== "proceed") throw errorForIdempotency(reservation);
            reservationStarted = true;
          }
          upstreamStarted = true;
          const upstream = await wechat.forward(route, body, contentType);
          if (reservationStarted) {
            store.mark(idempotencyKey, route.id, hash, "completed");
            reservationFinalized = true;
          }
          responseStatus = upstream.status >= 200 && upstream.status <= 599 ? upstream.status : 502;
          sendJson(res, responseStatus, upstream.data, requestId);
        } catch (error) {
          if (reservationStarted && !reservationFinalized) {
            const stage = error instanceof UpstreamError
              ? (error.outcomeUnknown ? "outcome_unknown" : "failed_safe")
              : (upstreamStarted ? "outcome_unknown" : "failed_safe");
            store.mark(idempotencyKey, route.id, hash, stage);
          }
          throw error;
        }
      } finally {
        release();
      }
    } catch (error) {
      const publicError = errorPayload(error);
      responseStatus = publicError.statusCode;
      errorCode = publicError.code;
      const closeUnreadRequest = !req.complete && !req.destroyed;
      if (closeUnreadRequest) {
        res.once("finish", () => req.destroy());
      }
      sendJson(
        res,
        publicError.statusCode,
        { error: { code: publicError.code, message: publicError.message } },
        requestId,
        closeUnreadRequest
          ? { ...publicError.headers, Connection: "close" }
          : publicError.headers,
      );
    } finally {
      logger.write({
        event: "request.complete",
        requestId,
        method: req.method,
        route: routeId,
        status: responseStatus,
        durationMs: Date.now() - startedAt,
        bodyBytes,
        idempotency,
        errorCode,
      });
    }
  };
}

export function createRelayService({ config, fetchImpl = fetch, logStream = process.stdout } = {}) {
  const logger = createJsonLogger(logStream);
  const store = new IdempotencyStore(config.dbPath, {
    maxRecords: config.idempotencyMaxRecords,
    failedSafeRetentionMs: config.idempotencyFailedSafeRetentionMs,
  });
  const wechat = new WechatClient(config, fetchImpl);
  const handler = createRequestHandler({ config, store, wechat, logger });
  const server = http.createServer(
    {
      maxHeaderSize: 16 * 1024,
      requestTimeout: config.bodyTimeoutMs + config.upstreamTimeoutMs + 5_000,
      requireHostHeader: true,
    },
    handler,
  );
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = config.maxConnections;
  server.maxRequestsPerSocket = 100;
  server.on("clientError", (_error, socket) => {
    if (!socket.writable) return;
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });

  return {
    server,
    store,
    wechat,
    logger,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      logger.write({ event: "server.started", port: server.address().port });
      return server.address();
    },
    async close() {
      wechat.clearSecrets();
      if (server.listening) {
        await new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
      store.close();
    },
  };
}
