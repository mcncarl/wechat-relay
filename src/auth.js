// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, timingSafeEqual } from "node:crypto";
import { HttpError } from "./errors.js";

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

function singleHeader(req, name) {
  let occurrences = 0;
  for (let index = 0; index < (req.rawHeaders?.length ?? 0); index += 2) {
    if (String(req.rawHeaders[index]).toLowerCase() === name) occurrences += 1;
  }
  const value = req.headers[name];
  if (occurrences > 1) {
    throw new HttpError(400, "ambiguous_authentication", "Authentication header is ambiguous.");
  }
  if (Array.isArray(value)) {
    throw new HttpError(400, "ambiguous_authentication", "Authentication header is ambiguous.");
  }
  return {
    present: occurrences > 0 || Object.hasOwn(req.headers, name),
    value: typeof value === "string" ? value : "",
  };
}

export function createAuthenticator(expectedToken) {
  const expectedDigest = digest(expectedToken);

  return function authenticate(req) {
    const authorization = singleHeader(req, "authorization");
    const legacyToken = singleHeader(req, "x-relay-token");
    if (authorization.present && legacyToken.present) {
      throw new HttpError(400, "ambiguous_authentication", "Use exactly one authentication header.");
    }

    let candidate = legacyToken.value;
    if (authorization.present) {
      const match = /^Bearer ([^\s]+)$/u.exec(authorization.value);
      if (!match) {
        throw new HttpError(
          401,
          "unauthorized",
          "A valid relay bearer token is required.",
          { "WWW-Authenticate": "Bearer realm=\"wechat-relay\"" },
        );
      }
      candidate = match[1];
    }

    const candidateDigest = digest(candidate);
    if (!candidate || !timingSafeEqual(candidateDigest, expectedDigest)) {
      throw new HttpError(
        401,
        "unauthorized",
        "A valid relay bearer token is required.",
        { "WWW-Authenticate": "Bearer realm=\"wechat-relay\"" },
      );
    }
  };
}
