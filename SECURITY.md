# Security policy

## Supported version

Security fixes target the latest published release and the current `main`
branch. Deploy an immutable tag or commit and keep its matching
`package-lock.json`.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/mcncarl/wechat-relay/security/advisories/new).
Do not open a public issue containing a credential, request body, media
identifier, unpublished article, server address, or exploit details.

Include the affected revision, route, preconditions, impact, and a minimal redacted reproduction. Never use a real Official Account credential or create a real draft while demonstrating a report.

## Security invariants

- Startup fails when any required secret is absent or the relay token is shorter than 32 bytes.
- The Node service binds only to loopback. Network exposure belongs to an explicitly configured Tailscale Serve or Caddy boundary.
- Only the six exact routes in [docs/PROTOCOL.md](docs/PROTOCOL.md) exist; only four proxy to fixed WeChat API paths.
- The client cannot select a host, scheme, arbitrary path, redirect target, or arbitrary query parameter.
- Authentication uses a constant-size digest and `crypto.timingSafeEqual`.
- Body, header, response, total upstream-operation time (including token refresh/retry), rate, and concurrency bounds fail closed; rejected unread bodies close their connection. Anonymous abuse and authenticated operations use separate rate buckets so an outsider cannot consume the trusted client's quota.
- Access tokens never leave process memory.
- SQLite stores only a domain-separated digest of the idempotency key and never stores the caller's raw key, request/response bodies, article text, images, titles, access tokens, app credentials, or media identifiers.
- Logs never contain credentials, authentication headers, bodies, titles, upstream URLs, access tokens, or media identifiers.
- An uncertain idempotent draft outcome is blocked until manually reconciled; the service never silently retries it.
- Idempotency metadata has a fixed row cap. Only expired `failed_safe` rows are reclaimed automatically; completed, forwarding, and uncertain outcomes are never evicted merely to admit another draft.
- Dependency lifecycle scripts run only as the dedicated non-login build account. The deployed checkout is restored to root ownership, while runtime remains a separate systemd `DynamicUser`.

## Operator responsibilities

- Generate `RELAY_TOKEN` from at least 32 cryptographically random bytes (43+ base64/base64url characters or 64+ hex characters) and rotate it after suspected exposure.
- Use only an opaque UUID or content digest for `Idempotency-Key`; never encode article text or another secret in persistent metadata.
- Keep the environment file root-readable only and outside the repository.
- Use a dedicated fixed IPv4 in the WeChat allowlist.
- Keep Tailscale ACLs or Caddy/firewall rules narrow. Never expose port 18794 directly.
- Reconcile a draft in WeChat before changing an `outcome_unknown` idempotency record.
- Treat `idempotency_capacity_exhausted` as an operational stop. Raise the bounded cap only after checking disk capacity; never purge protected rows until their outcomes have been independently reconciled.
- Install and update dependencies as the dedicated build account, never with root npm, and restore the checkout to root ownership before starting the service.
- Do not weaken logs or add request-body diagnostics in production.

## Out of scope

- Security of WeChat, Tailscale, Caddy, the VPS provider, DNS registrar, operator workstation, or client plugin outside this repository
- Denial of service by an attacker who already controls the VPS root account
- Recovery of an Official Account after its app secret is independently compromised
- Public publishing or mass-send behavior, which this repository does not implement
