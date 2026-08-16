# Contributing

## Before opening a change

- Use only synthetic credentials, account identifiers, article bodies, media
  identifiers, server addresses, logs, and database fixtures.
- Never commit a populated environment file, WeChat credential, relay token,
  request or response body, unpublished article, server configuration, or
  SQLite runtime state.
- Preserve loopback binding, exact upstream route allowlists, bounded requests,
  authenticated readiness, idempotency fail-closed behavior, redacted logs,
  and the draft-only boundary.

## Development

Use a supported Node.js major and the exact lockfile:

```bash
npm ci
npm run audit:dependencies
npm run check
```

## Contribution license

By submitting a contribution, you license it under
`AGPL-3.0-or-later` and confirm that you have the right to submit it under
those terms. Explain user-visible behavior, trust-boundary changes, deployment
or rollback impact, and the tests used to validate the change.
