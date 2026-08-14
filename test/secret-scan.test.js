// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { scanText } from "../scripts/secret-scan.mjs";

test("secret scanner catches common credential and private-host artifacts", () => {
  const longToken = "A".repeat(48);
  const cases = [
    ["WECHAT_APP_SECRET=" + longToken, "nonempty-wechat_app_secret"],
    ["Authorization: Bearer " + longToken, "literal-bearer-token"],
    [JSON.stringify({ access_token: longToken }), "literal-secret-field"],
    ["wx" + "1".repeat(16), "wechat-app-id"],
    ["server=" + [8, 8, 8, 8].join("."), "public-ipv4"],
    ["/" + ["Users", "private-user", "secret"].join("/"), "personal-absolute-path"],
  ];
  for (const [fixture, expected] of cases) {
    assert.ok(scanText(fixture).includes(expected), expected);
  }
});

test("secret scanner permits empty examples, placeholders, and reserved addresses", () => {
  const safe = [
    "WECHAT_APP_SECRET=",
    "RELAY_TOKEN=<operator-generated>",
    "Authorization: Bearer ${RELAY_TOKEN}",
    "relay.example.com",
    "127.0.0.1",
    "192.0.2.10",
  ].join("\n");
  assert.deepEqual(scanText(safe), []);
});
