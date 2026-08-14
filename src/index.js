#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { loadConfig } from "./config.js";
import { createRelayService } from "./server.js";

let service;
let closing = false;

async function shutdown() {
  if (closing) return;
  closing = true;
  try {
    await service?.close();
  } finally {
    process.exitCode = 0;
  }
}

try {
  const config = loadConfig();
  service = createRelayService({ config });
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await service.listen();
} catch (error) {
  const code = typeof error?.code === "string" ? error.code : "startup_failed";
  process.stderr.write(`${JSON.stringify({ event: "startup.failed", code })}\n`);
  process.exitCode = 1;
}
