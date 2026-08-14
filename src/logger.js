// SPDX-License-Identifier: AGPL-3.0-or-later

const ALLOWED_FIELDS = new Set([
  "bodyBytes",
  "durationMs",
  "errorCode",
  "event",
  "idempotency",
  "method",
  "port",
  "requestId",
  "route",
  "status",
  "time",
]);

export function createJsonLogger(stream = process.stdout) {
  return {
    write(record) {
      const sanitized = { time: new Date().toISOString() };
      for (const [key, value] of Object.entries(record ?? {})) {
        if (ALLOWED_FIELDS.has(key) && value !== undefined) {
          sanitized[key] = value;
        }
      }
      stream.write(`${JSON.stringify(sanitized)}\n`);
    },
  };
}
