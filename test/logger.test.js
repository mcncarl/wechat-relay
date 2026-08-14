// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { createJsonLogger } from "../src/logger.js";

test("logger discards secrets, headers, bodies, titles, URLs, and media identifiers", () => {
  let output = "";
  const logger = createJsonLogger({ write: (chunk) => { output += chunk; } });
  logger.write({
    event: "request.complete",
    route: "draft.add",
    status: 200,
    secret: "should-never-appear",
    authorization: "Bearer should-never-appear",
    body: "unpublished-body",
    title: "unpublished-title",
    media_id: "private-media-id",
    upstreamUrl: "https://example.invalid/?access_token=should-never-appear",
  });
  const parsed = JSON.parse(output);
  assert.deepEqual(
    Object.keys(parsed).sort(),
    ["event", "route", "status", "time"],
  );
  assert.equal(output.includes("should-never-appear"), false);
  assert.equal(output.includes("unpublished"), false);
  assert.equal(output.includes("private-media-id"), false);
});
