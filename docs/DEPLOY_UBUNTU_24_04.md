# Manual deployment on Ubuntu 24.04

This is intentionally a manual procedure. Read every command, substitute only operator-owned values, and preserve a rollback path. Do not paste real credentials into tickets, chat, shell history, or Git.

## 1. Prepare the server

Use an operator-controlled Ubuntu 24.04 server with a stable outbound IPv4. Hong Kong is the preferred region when it provides the required IPv4 and acceptable access to `api.weixin.qq.com`; it is not a substitute for testing connectivity.

Install one supported Node.js LTS major (20.x, 22.x, or 24.x) from an official
system-level distribution channel. The provided systemd unit executes
`/usr/bin/node`, so that exact path must exist and npm must be visible to the
dedicated build account. Verify the paths and major before installing
dependencies:

```bash
test "$(command -v node)" = "/usr/bin/node"
test "$(command -v npm)" = "/usr/bin/npm"
/usr/bin/node --version
/usr/bin/npm --version
```

Never reuse `node_modules` across Node major versions. `better-sqlite3` is a native addon and must be installed for the selected LTS runtime.

Install the local native-build prerequisites because `better-sqlite3` may need to compile:

```bash
sudo apt update
sudo apt install --yes build-essential python3 git openssl
```

Create a dedicated, non-login build account. It may write the source tree only while installing a reviewed revision; it cannot read runtime credentials or state and is not the systemd runtime identity:

```bash
sudo useradd --system --create-home --home-dir /var/lib/wechat-relay-build --shell /usr/sbin/nologin wechat-relay-build
sudo install -d -m 0755 -o wechat-relay-build -g wechat-relay-build /opt/wechat-relay
sudo -H -u wechat-relay-build /usr/bin/node --version
sudo -H -u wechat-relay-build /usr/bin/npm --version
sudo -H -u wechat-relay-build git clone --branch 0.1.0 --depth 1 https://github.com/mcncarl/wechat-relay.git /opt/wechat-relay
cd /opt/wechat-relay
sudo -H -u wechat-relay-build /usr/bin/npm ci --omit=dev
sudo chown -R root:root /opt/wechat-relay
sudo chmod -R u=rwX,go=rX /opt/wechat-relay
```

The public repository can be cloned anonymously; do not put a GitHub token or
Deploy Key in the clone URL or server checkout. Review `package-lock.json`
before installation. Dependency lifecycle scripts never run as root; after
installation, the root-owned checkout is no longer writable by the build
account. The systemd service still runs as a separate `DynamicUser` with access
only to its private state directory.

Do not copy local test results, launchd property lists, old server configuration, or an existing `.env` into this directory.

## 2. Create the protected environment file

Create the directory and an empty root-readable file:

```bash
sudo install -d -m 0750 -o root -g root /etc/wechat-relay
sudo install -m 0600 -o root -g root /dev/null /etc/wechat-relay/wechat-relay.env
sudoedit /etc/wechat-relay/wechat-relay.env
```

Generate a relay token from at least 32 random bytes. The following generates 48 random bytes:

```bash
openssl rand -base64 48
```

Put only these three populated values in the protected environment file:

```dotenv
WECHAT_APP_ID=<operator-supplied-app-id>
WECHAT_APP_SECRET=<operator-supplied-app-secret>
RELAY_TOKEN=<operator-generated-random-token>
```

Do not add quotes unless they are part of the actual secret. Do not reuse another service's token.

The bounded idempotency defaults are 10,000 metadata rows and seven days for automatic retention of `failed_safe` rows. Optional overrides are:

```dotenv
IDEMPOTENCY_MAX_RECORDS=10000
IDEMPOTENCY_FAILED_SAFE_RETENTION_MS=604800000
```

Only expired `failed_safe` rows are reclaimed automatically. `completed`, `forwarding`, and `outcome_unknown` rows are never evicted to admit a new draft; this preserves replay protection. At capacity, readiness and new draft creation fail closed with `idempotency_capacity_exhausted`. The operator may raise the bounded limit deliberately after reviewing disk capacity, but must reconcile protected outcomes before any offline archival or database rotation.

## 3. Install the hardened systemd unit

```bash
sudo install -m 0644 deploy/wechat-relay.service /etc/systemd/system/wechat-relay.service
sudo systemctl daemon-reload
sudo systemctl enable --now wechat-relay.service
sudo systemctl status wechat-relay.service
```

The unit uses a dynamic user, a private state directory, a read-only filesystem, no Linux capabilities, loopback binding, and a restrictive syscall/address-family policy. The SQLite database is created under `/var/lib/wechat-relay/` and is not part of the source tree.

Confirm the public liveness endpoint locally:

```bash
curl --fail --silent --show-error http://127.0.0.1:18794/v1/health
```

For authenticated readiness, load the root-only environment into a root shell and pass the header over curl standard input rather than placing the token directly in curl's command-line arguments:

```bash
sudo --preserve-env=PATH bash
set -a
. /etc/wechat-relay/wechat-relay.env
set +a
curl --fail --silent --show-error --config - <<EOF
url = "http://127.0.0.1:18794/v1/ready"
header = "Authorization: Bearer ${RELAY_TOKEN}"
EOF
exit
```

If readiness fails, inspect only the structured service metadata. Do not increase logging to include headers, request bodies, upstream URLs, or secrets.

## 4A. Route A — Tailscale Serve (preferred private route)

Install Tailscale using its official Ubuntu instructions, join the intended tailnet, and apply an ACL that permits only the client device or user to reach this node. Keep the relay itself on loopback.

Configure tailnet-only HTTPS reverse proxying:

```bash
sudo tailscale serve --bg --https=443 http://127.0.0.1:18794
sudo tailscale serve status
```

Use the HTTPS MagicDNS name printed by `tailscale serve status` as the client relay base URL. Keep bearer-token authentication enabled even inside the tailnet.

Do **not** enable Tailscale Funnel. Serve is the private route; Funnel would deliberately expose it to the public internet.

Official command reference: <https://tailscale.com/docs/reference/tailscale-cli/serve>

## 4B. Route B — operator domain plus Caddy

Use this route only when the relay must be reachable without joining the tailnet.

1. Point an operator-owned DNS `A` record at the server's fixed IPv4.
2. Add only that server IPv4 to the WeChat Official Account API allowlist.
3. Permit inbound TCP 80/443 in the cloud firewall; do not expose port 18794.
4. Install Caddy from its official Ubuntu repository.
5. Copy [deploy/Caddyfile.example](../deploy/Caddyfile.example), replace only the reserved example domain, then validate and reload:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy terminates TLS and proxies to `127.0.0.1:18794`. The relay still requires its bearer token and ignores forwarded client-IP headers.

Official reverse-proxy reference: <https://caddyserver.com/docs/caddyfile/directives/reverse_proxy>

## 5. Firewall and verification

- The Node process must listen only on loopback. Verify with `ss -ltnp`.
- Tailscale route: do not open a public relay port.
- Caddy route: expose only SSH according to operator policy and HTTP/HTTPS for Caddy.
- Never allow direct public access to 18794.
- Verify `/v1/health`, authenticated `/v1/ready`, one controlled draft workflow, and draft readback before relying on the service.
- Creating a real draft is an operator-authorized external action; repository tests never do it.

## 6. Updating and rollback

Review a specific revision before updating. Stop the service, back up only the SQLite metadata database and protected environment file with mode `0600`, temporarily return the checkout to the non-login build account, install the reviewed revision as that account, then restore root ownership before restart:

```bash
sudo systemctl stop wechat-relay.service
sudo chown -R wechat-relay-build:wechat-relay-build /opt/wechat-relay
sudo -H -u wechat-relay-build git -C /opt/wechat-relay fetch --all --prune
sudo -H -u wechat-relay-build git -C /opt/wechat-relay checkout <reviewed-revision>
sudo -H -u wechat-relay-build /usr/bin/npm ci --omit=dev --prefix /opt/wechat-relay
sudo chown -R root:root /opt/wechat-relay
sudo chmod -R u=rwX,go=rX /opt/wechat-relay
sudo systemctl start wechat-relay.service
```

Do not copy the database into Git, and never run npm lifecycle scripts with root privileges.

If an update fails, restore the reviewed source revision and matching `package-lock.json`. Do not delete or rewrite idempotency rows to force a retry unless the operator has independently reconciled the corresponding WeChat draft state.
