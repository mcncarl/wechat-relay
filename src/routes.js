// SPDX-License-Identifier: AGPL-3.0-or-later

import { HttpError } from "./errors.js";

const MATERIAL_TYPES = new Set(["image", "thumb", "voice", "video"]);

const ROUTES = new Map([
  ["/v1/health", { id: "health", method: "GET", public: true, kind: "health" }],
  ["/v1/ready", { id: "ready", method: "GET", public: false, kind: "ready" }],
  [
    "/wechat/material/add_material",
    {
      id: "material.add",
      method: "POST",
      public: false,
      kind: "wechat",
      contentKind: "multipart",
      upstreamPath: "/cgi-bin/material/add_material",
      maxBody: "media",
      idempotency: "forbidden",
    },
  ],
  [
    "/wechat/media/uploadimg",
    {
      id: "media.uploadimg",
      method: "POST",
      public: false,
      kind: "wechat",
      contentKind: "multipart",
      upstreamPath: "/cgi-bin/media/uploadimg",
      maxBody: "media",
      idempotency: "forbidden",
    },
  ],
  [
    "/wechat/draft/add",
    {
      id: "draft.add",
      method: "POST",
      public: false,
      kind: "wechat",
      contentKind: "json",
      upstreamPath: "/cgi-bin/draft/add",
      maxBody: "json",
      idempotency: "required",
    },
  ],
  [
    "/wechat/draft/get",
    {
      id: "draft.get",
      method: "POST",
      public: false,
      kind: "wechat",
      contentKind: "json",
      upstreamPath: "/cgi-bin/draft/get",
      maxBody: "json",
      idempotency: "forbidden",
    },
  ],
]);

function assertNoQuery(queryIndex) {
  if (queryIndex !== -1) {
    throw new HttpError(400, "unexpected_query", "This route does not accept query parameters.");
  }
}

function materialType(rawSearch) {
  if (!rawSearch) return "image";
  const match = /^\?type=([a-z]+)$/u.exec(rawSearch);
  if (!match || !MATERIAL_TYPES.has(match[1])) {
    throw new HttpError(400, "invalid_material_type", "Unsupported material type.");
  }
  return match[1];
}

export function resolveRoute(rawUrl, method) {
  if (typeof rawUrl !== "string" || !rawUrl.startsWith("/") || rawUrl.startsWith("//")) {
    throw new HttpError(400, "invalid_request_target", "Request target must use origin form.");
  }
  let url;
  try {
    url = new URL(rawUrl, "http://relay.invalid");
  } catch {
    throw new HttpError(400, "invalid_request_target", "Request target is invalid.");
  }
  const queryIndex = rawUrl.indexOf("?");
  const rawPath = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  if (url.hash || rawPath !== url.pathname) {
    throw new HttpError(400, "invalid_request_target", "Request target path must be canonical.");
  }
  const route = ROUTES.get(url.pathname);
  if (!route) {
    throw new HttpError(404, "not_found", "Route not found.");
  }
  if (method !== route.method) {
    throw new HttpError(405, "method_not_allowed", "Method not allowed.", { Allow: route.method });
  }

  let query = Object.freeze({});
  if (route.id === "material.add") {
    query = Object.freeze({ type: materialType(queryIndex === -1 ? "" : rawUrl.slice(queryIndex)) });
  } else {
    assertNoQuery(queryIndex);
  }
  return { ...route, query };
}
