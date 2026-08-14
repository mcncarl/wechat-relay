#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

function isAllowedIpv4(value) {
  const octets = value.split(".").map(Number);
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true;
  const [a, b] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && octets[2] === 2)
    || (a === 198 && b === 51 && octets[2] === 100)
    || (a === 203 && b === 0 && octets[2] === 113)
    || a >= 224;
}

export function scanText(content) {
  const rules = [];
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(content)) {
    rules.push("private-key");
  }
  if (/\bwx[0-9a-f]{16}\b/iu.test(content)) {
    rules.push("wechat-app-id");
  }
  for (const match of content.matchAll(/^[^\S\r\n]*(WECHAT_APP_SECRET|RELAY_TOKEN)[^\S\r\n]*=[^\S\r\n]*(.*?)[^\S\r\n]*$/gmu)) {
    if (match[2] && !match[2].startsWith("${") && !match[2].startsWith("<")) {
      rules.push(`nonempty-${match[1].toLowerCase()}`);
    }
  }
  if (/\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]{32,}/iu.test(content)) {
    rules.push("literal-bearer-token");
  }
  if (/["'](?:access_token|WECHAT_APP_SECRET|RELAY_TOKEN)["']\s*:\s*["'][A-Za-z0-9._~+/=-]{24,}["']/iu.test(content)) {
    rules.push("literal-secret-field");
  }
  if (/\/(?:Users|home)\/[A-Za-z0-9._-]+\//u.test(content) || /[A-Za-z]:\\Users\\[^\\]+\\/iu.test(content)) {
    rules.push("personal-absolute-path");
  }
  for (const match of content.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu)) {
    if (!isAllowedIpv4(match[0])) rules.push("public-ipv4");
  }
  return [...new Set(rules)];
}

function run() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const listed = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8" },
  );
  const files = listed.split("\n").filter(Boolean);
  const findings = [];
  for (const relative of files) {
    const filename = path.join(root, relative);
    const stat = fs.statSync(filename);
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024) continue;
    const content = fs.readFileSync(filename, "utf8");
    for (const rule of scanText(content)) findings.push({ file: relative, rule });
  }

  if (findings.length) {
    for (const finding of findings) {
      process.stderr.write(`${finding.file}: ${finding.rule}\n`);
    }
    process.exitCode = 1;
  } else {
    process.stdout.write(`secret-scan: ${files.length} files clean\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
