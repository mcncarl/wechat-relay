# Relay protocol

## Transport

- The backend speaks HTTP on loopback only.
- Production clients should reach it through Tailscale Serve or a TLS-terminating Caddy reverse proxy.
- Every response is `application/json; charset=utf-8`, has `Cache-Control: no-store`, and includes an opaque `X-Request-Id`.
- Except for `/v1/health`, authenticate with exactly one of:
  - `Authorization: Bearer <RELAY_TOKEN>` (preferred)
  - `X-Relay-Token: <RELAY_TOKEN>` (legacy compatibility)
- Supplying both authentication headers is rejected.

## Health and readiness

### `GET /v1/health`

Public liveness check. It performs no WeChat request and returns only:

```json
{"ok":true}
```

### `GET /v1/ready`

Authenticated readiness check. It verifies SQLite and obtains or reuses an in-memory WeChat access token. Success returns:

```json
{"ready":true}
```

## Compatible WeChat routes

All four routes require authentication and accept only `POST`.

| Relay route | Required content type | Accepted query | WeChat operation |
| --- | --- | --- | --- |
| `/wechat/material/add_material` | `multipart/form-data; boundary=...` | optional single `type=image|thumb|voice|video` | permanent material upload |
| `/wechat/media/uploadimg` | `multipart/form-data; boundary=...` | none | article body image upload |
| `/wechat/draft/add` | `application/json` or UTF-8 charset | none | create draft |
| `/wechat/draft/get` | `application/json` or UTF-8 charset | none | read draft |

The relay forwards the normalized WeChat JSON response to the authenticated client. It retries once with a fresh in-memory access token only for WeChat error codes `40001`, `40014`, or `42001`.

## Idempotency

`/wechat/draft/add` requires an `Idempotency-Key` of 8–200 ASCII letters, digits, dots, underscores, colons, or hyphens. Missing keys fail closed before the request body is forwarded.

Use an opaque UUID or content digest. Never put a title, article text, filename, media identifier, credential, or other sensitive value in this key because the key itself is persistent metadata.

- First use stores only a domain-separated SHA-256 digest of the key, route, SHA-256 body hash, `forwarding` stage, and timestamps. The caller's raw key is never persisted.
- A known response moves the stage to `completed`.
- A failure known to occur before the draft operation moves it to `failed_safe` and may be retried with the same key and body.
- A timeout or transport failure after the operation may have reached WeChat moves it to `outcome_unknown`.
- Reuse with another body or route is `409 idempotency_conflict`.
- Reuse after `completed`, `forwarding`, or `outcome_unknown` is blocked with `409 idempotency_replay_blocked`.

The relay intentionally does not persist the WeChat response or media identifier. Therefore a blocked replay does not return the prior result: reconcile the existing draft before deciding on another key. This fails closed instead of silently creating duplicates.

### Capacity and retention

The metadata table is capped at `IDEMPOTENCY_MAX_RECORDS` (default 10,000; configurable from 100 to 100,000). On every new reservation and readiness check, `failed_safe` rows older than `IDEMPOTENCY_FAILED_SAFE_RETENTION_MS` are reclaimed (default seven days; configurable from one minute to 30 days).

`completed`, `forwarding`, and `outcome_unknown` rows are protected and never evicted automatically. If protected rows fill the table, new draft reservations and readiness fail with `503 idempotency_capacity_exhausted`; existing keys still return their conflict or replay-blocked decision. This bounds storage without weakening uncertain-outcome replay protection. The database uses WAL auto-checkpointing and a journal-size limit, and deleted pages are reused by SQLite.

The three other routes reject `Idempotency-Key`; compatible clients send it only when creating a draft.

## Relay errors

Relay-level errors use:

```json
{
  "error": {
    "code": "machine_readable_code",
    "message": "Safe public explanation."
  }
}
```

The response never includes configuration values, upstream URLs, access tokens, request bodies, or internal exception text.

## Non-goals

- No generic path forwarding
- No client-supplied upstream URL
- No browser or WeChat-client automation
- No publishing or mass-send endpoint
- No credential management API
- No public metrics that reveal configuration or token state
