# wechat-relay

`wechat-relay` is a small, public, self-hosted relay for four WeChat Official Account draft APIs. It exists for one narrow deployment problem: the Official Account allowlist sees the relay server's fixed outbound IPv4 instead of a changing client address.

Commercial use is permitted, but users must comply with
`AGPL-3.0-or-later`. For commercial deployment, customization, training, or
technical support, contact the repository maintainer.

> 商业使用：允许，但必须遵守 AGPL-3.0-or-later。
>
> 商业部署、定制、培训与技术支持：可联系维护者。

The relay creates or reads drafts only through the four documented compatibility routes. It does not automate the WeChat client, open the Official Account web console, mass-send, publish, or provide a generic WeChat API proxy.

## Security model

- The Node process refuses to start unless `WECHAT_APP_ID`, `WECHAT_APP_SECRET`, and `RELAY_TOKEN` are all present.
- `RELAY_TOKEN` must encode at least 32 cryptographically random bytes (at least 43 base64/base64url characters or 64 hex characters). Do not invent a memorable password.
- The process binds only to `127.0.0.1` or `::1`. Tailscale Serve or Caddy is the network boundary.
- `/v1/health` is public and returns only `{"ok":true}`. `/v1/ready` is authenticated and checks SQLite plus WeChat credential/IP readiness.
- Request paths, methods, query parameters, content types, body sizes, body time, total upstream-operation time (including token refresh/retry), response size, rate, total connections, and concurrent admitted requests are bounded.
- WeChat `access_token` values live only in process memory.
- SQLite stores only a domain-separated SHA-256 idempotency-key digest, route, SHA-256 body hash, stage, and timestamps. It never stores the caller's raw key, article text, images, response bodies, titles, or media identifiers.
- Idempotency metadata is capped at 10,000 rows by default. Only expired `failed_safe` rows are reclaimed automatically; protected completed, forwarding, and uncertain outcomes are never evicted to make room.
- Logs use a fixed allowlist and never include secrets, authentication headers, request/response bodies, titles, access tokens, or media identifiers.

Read [SECURITY.md](SECURITY.md), [THREAT_MODEL.md](THREAT_MODEL.md), and [docs/PROTOCOL.md](docs/PROTOCOL.md) before deployment.

## Runtime requirements

- Node.js 20.x, 22.x, or 24.x. Startup rejects other majors; install dependencies afresh when changing Node majors because `better-sqlite3` is native.
- Ubuntu 24.04 for the documented production setup
- A user-supplied server with a stable outbound IPv4 already accepted by the WeChat Official Account allowlist

The recommended region is Hong Kong when it provides the appropriate stable IPv4 and acceptable connectivity. The operator remains responsible for the server, fixed IPv4, DNS, firewall, Tailscale ACLs, and WeChat allowlist.

## Local development

```bash
npm ci
npm test
npm run lint
npm run syntax
npm run secret-scan
```

The service intentionally does not auto-load `.env`. Export variables explicitly or provide them through systemd. Start it with:

```bash
npm start
```

The empty [.env.example](.env.example) is a key list, not a working configuration. Never commit a populated environment file.

## Production deployment

Use the manual Ubuntu 24.04 guide: [docs/DEPLOY_UBUNTU_24_04.md](docs/DEPLOY_UBUNTU_24_04.md).

It documents two supported routes:

1. **Tailscale Serve** — preferred for tailnet-only access. Do not enable Funnel.
2. **A domain with Caddy** — for an operator-owned domain on a fixed IPv4, with TLS and a restrictive firewall.

There is deliberately no one-command installer. Credential creation, network exposure, WeChat allowlisting, and service activation remain explicit operator decisions.

## Related repository

- [Ailu](https://github.com/mcncarl/ailu) is the public Obsidian client that
  uses this relay for explicit, draft-only WeChat Official Account uploads.
  Ailu and this service are installed and configured separately.

## License

Copyright 2026 wechat-relay contributors.

Licensed under the GNU Affero General Public License, version 3 or any later version (`AGPL-3.0-or-later`). See [LICENSE](LICENSE).
The project copyright and modification notice is preserved in [NOTICE.md](NOTICE.md).
