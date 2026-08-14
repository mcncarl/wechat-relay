# Threat model

## Overview

This repository runs one loopback-only Node.js service that authenticates a trusted client and forwards four fixed draft-related operations to `https://api.weixin.qq.com`. Its assets are the Official Account AppID/AppSecret, relay bearer token, in-memory WeChat access token, unpublished article/media content in transit, fixed-IP allowlist privilege, and idempotency decisions that prevent duplicate drafts.

Primary runtime code is under `src/`. The systemd and reverse-proxy examples under `deploy/` define the production isolation boundary. Tests, documentation, and the local secret scanner are developer/operator surfaces and are not network services.

## Threat Model, Trust Boundaries, and Assumptions

### Trust boundaries

1. **Client to network edge:** an authenticated Ailu-compatible client reaches Tailscale Serve or Caddy over HTTPS. The edge is operator-controlled; forwarded client-IP headers are not trusted by the relay.
2. **Network edge to Node process:** the edge connects to `127.0.0.1:18794`. `src/config.js` rejects non-loopback binding and `src/server.js` rejects non-loopback peers.
3. **Node process to WeChat:** `src/wechat-client.js` selects a fixed HTTPS origin and four fixed upstream paths. Request bodies are attacker-controlled after authentication, but the upstream host/path is not.
4. **Node process to local state:** `src/idempotency-store.js` writes only a domain-separated idempotency-key digest plus route/body-hash/stage metadata to a mode-0600 SQLite database. Raw caller keys, credentials, bodies, images, responses, and media identifiers never cross this boundary.
5. **Operator to runtime configuration:** the root-only systemd environment file supplies three required secrets. Repository files, logs, service status, and public health output must not reveal them.

### Inputs

- **Attacker-controlled:** unauthenticated HTTP requests at the edge; path, method, query, headers, body bytes, connection pacing, and replay timing; authenticated malicious payloads if a relay token is stolen.
- **Operator-controlled:** AppID, AppSecret, relay token, fixed IPv4, WeChat allowlist, DNS, Caddy/Tailscale policy, firewall, deployment revision, body/rate/time limits, and SQLite file handling.
- **Developer-controlled:** dependency versions, route mapping, validation, logging allowlist, systemd hardening, tests, and release contents.

### Assumptions

- The VPS kernel, root account, reverse proxy or Tailscale daemon, DNS account, and client device are not already compromised.
- WeChat's TLS endpoint and CA trust chain are valid.
- The operator does not enable Tailscale Funnel or directly expose port 18794.
- A client treats `409 idempotency_replay_blocked` as a reconciliation requirement, not permission to invent a new key immediately.

## Attack Surface, Mitigations, and Attacker Stories

### HTTP parser and resource exhaustion

An attacker may send oversized, slow, compressed, malformed, or high-rate requests. `src/routes.js` accepts exact paths/methods/query shapes; `src/body.js` rejects unsupported encodings/content types and bounds body bytes/time; `src/server.js` bounds total connections, headers, request time, keepalive reuse, and concurrent admitted request bodies. `src/wechat-client.js` applies one total deadline across token acquisition, operation, invalid-token refresh, and the single retry. Separate pre-authentication, public-health, and authenticated rate buckets prevent anonymous rejection traffic from exhausting the trusted client's operation quota. An authenticated attacker cannot grow SQLite without bound: the fixed row cap fails closed, while automatic reclamation is limited to expired `failed_safe` rows so protected replay decisions are preserved. The public health response is intentionally minimal.

### Authentication and secret disclosure

An attacker may guess a bearer token, submit ambiguous authentication headers, or try to make errors/logs echo secrets. `src/auth.js` accepts exactly one supported header and compares fixed-size SHA-256 digests with `timingSafeEqual`. `src/logger.js` serializes only allowlisted metadata. Public errors never use upstream URLs or internal exception messages. Startup rejects missing credentials and short tokens.

### SSRF and confused-deputy abuse

A stolen relay token could otherwise turn the server's allowlisted IPv4 into a generic WeChat or internet proxy. `src/routes.js` exposes only four WeChat operations. `src/wechat-client.js` constructs all URLs from one constant HTTPS origin and fixed path table, disables redirects, and allowlists the sole material query value. There is no client-supplied URL, host, scheme, or generic path.

### Duplicate drafts and crash recovery

A network timeout after WeChat accepted a draft can cause a client retry. `src/idempotency-store.js` binds the caller key to route and body SHA-256 before forwarding. Completed, forwarding, conflicting, or uncertain outcomes block replay. Only failures known to occur before the operation may retry. Because response bodies/media identifiers are deliberately not stored, reconciliation is manual rather than a potentially unsafe synthetic success response.

### Persistence and dependency compromise

SQLite compromise should reveal request timing and hashes, not unpublished content or credentials. Row capacity, failed-safe retention, WAL auto-checkpointing, and a journal-size limit bound ordinary metadata growth without evicting completed or uncertain replay decisions. Dependency lifecycle scripts run as a dedicated non-login build account rather than root; the installed checkout is then root-owned. The systemd runtime remains a separate dynamic user with a private state directory, read-only system paths, no capabilities, and syscall/address-family restrictions. `package-lock.json`, exact dependency versions, tests, lint, syntax checks, and the secret scanner reduce supply-chain and release drift; they do not replace revision review.

### Out-of-scope stories

Root/VPS compromise, malicious changes to Caddy/Tailscale, DNS takeover, client-device compromise, or direct WeChat credential theft can bypass repository controls and require infrastructure/account incident response. Public publishing and mass-send attacks are out of scope because no such route exists.

No generic path forwarding is implemented: the relay recognizes only the four documented compatibility routes plus its two service-status endpoints.

## Severity Calibration (Critical, High, Medium, Low)

- **Critical:** unauthenticated recovery of AppSecret/access token; arbitrary upstream host selection from the allowlisted IPv4; a hidden route that publishes or mass-sends; remote code execution in the relay process.
- **High:** authentication bypass on a WeChat route; request/body logging that exposes unpublished articles or credentials; idempotency logic that automatically duplicates drafts after an uncertain outcome; non-loopback default binding combined with missing authentication.
- **Medium:** reliable authenticated resource exhaustion beyond documented bounds; a readiness endpoint leaking token/configuration state; idempotency conflicts accepted across different body hashes; persisted media identifiers contrary to the storage contract.
- **Low:** verbose but non-sensitive version/uptime disclosure, minor error-code inconsistency, or a local developer-only validation weakness requiring an already trusted workstation.

Repository: github.com/mcncarl/wechat-relay
Snapshot digest covers every non-ignored repository file except `.git/` and `node_modules/`, ordered by path, with the following version line normalized to `Version: snapshot-pending`.
Version: uncommitted-snapshot-sha256:21f02bc51782da31fedad3dbb1b5b90f93ac278dd6878655d3faac48987ccce5
