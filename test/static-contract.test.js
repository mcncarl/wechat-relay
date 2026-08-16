// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function text(path) {
  return fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("package is private, AGPL, and limited to verified Node LTS lines", () => {
  const pkg = JSON.parse(text("package.json"));
  assert.equal(pkg.private, true);
  assert.equal(pkg.license, "AGPL-3.0-or-later");
  assert.equal(pkg.engines.node, "20.x || 22.x || 24.x");
  assert.match(text("LICENSE").trimStart(), /^GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3/iu);
  assert.ok(text("NOTICE.md").includes("Copyright (C) 2026 wechat-relay contributors"));
  assert.ok(text("README.md").includes("Commercial use is permitted"));
  assert.ok(text("README.md").includes("commercial deployment, customization, training, or"));
  assert.ok(text("README.md").includes("商业使用：允许，但必须遵守 AGPL-3.0-or-later"));
});

test("environment example contains keys but no values", () => {
  for (const line of text(".env.example").trim().split("\n")) {
    assert.match(line, /^[A-Z0-9_]+=$/u);
  }
  const ignored = text(".gitignore");
  for (const sensitive of [".env", ".npmrc", "*.pem", "*.key", "*.sqlite3", "*.log"]) {
    assert.ok(ignored.includes(sensitive), sensitive);
  }
});

test("systemd unit keeps Node on loopback with a private writable state directory", () => {
  const unit = text("deploy/wechat-relay.service");
  for (const required of [
    "DynamicUser=yes",
    "Environment=HOST=127.0.0.1",
    "StateDirectory=wechat-relay",
    "NoNewPrivileges=yes",
    "ProtectSystem=strict",
    "ProtectHome=yes",
    "CapabilityBoundingSet=",
    "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
    "LimitCORE=0",
  ]) {
    assert.ok(unit.includes(required), required);
  }
  assert.equal(unit.includes("0.0.0.0"), false);
  assert.ok(text("deploy/Caddyfile.example").includes("reverse_proxy 127.0.0.1:18794"));
});

test("manual deployment documents exactly the two approved edge routes", () => {
  const guide = text("docs/DEPLOY_UBUNTU_24_04.md");
  assert.match(guide, /sudo -H -u wechat-relay-build \/usr\/bin\/npm ci --omit=dev/u);
  assert.doesNotMatch(guide, /sudo\s+npm\s+(?:ci|install|rebuild)/u);
  assert.ok(guide.includes("git clone --branch 0.1.0 --depth 1 https://github.com/mcncarl/wechat-relay.git"));
  assert.ok(guide.includes("public repository can be cloned anonymously"));
  assert.ok(guide.includes('test "$(command -v node)" = "/usr/bin/node"'));
  assert.ok(guide.includes("lifecycle scripts never run as root"));
  assert.ok(guide.includes("Tailscale Serve"));
  assert.ok(guide.includes("operator domain plus Caddy"));
  assert.ok(guide.includes("Do **not** enable Tailscale Funnel"));
  assert.match(guide, /manual/iu);
  assert.deepEqual(guide.match(/^## 4[A-Z]\. Route /gmu), ["## 4A. Route ", "## 4B. Route "]);
  for (const installer of ["install.sh", "setup.sh", "deploy.sh", "bootstrap.sh"]) {
    assert.equal(fs.existsSync(new URL(`../${installer}`, import.meta.url)), false);
  }
});

test("protocol and threat model preserve the narrow four-route boundary", () => {
  const protocol = text("docs/PROTOCOL.md");
  const threatModel = text("THREAT_MODEL.md");
  for (const route of [
    "/wechat/material/add_material",
    "/wechat/media/uploadimg",
    "/wechat/draft/add",
    "/wechat/draft/get",
  ]) {
    assert.ok(protocol.includes(route));
  }
  assert.ok(threatModel.includes("No generic path forwarding"));
  assert.match(threatModel, /^Version: uncommitted-snapshot-sha256:[0-9a-f]{64}$/mu);
  assert.equal(/^Version: snapshot-pending$/mu.test(threatModel), false);
  assert.ok(text("SECURITY.md").includes("Access tokens never leave process memory"));
  assert.ok(text("SECURITY.md").includes("/security/advisories/new"));
});
