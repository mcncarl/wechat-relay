// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { HttpError } from "./errors.js";

function headerValue(req, name) {
  let occurrences = 0;
  for (let index = 0; index < (req.rawHeaders?.length ?? 0); index += 2) {
    if (String(req.rawHeaders[index]).toLowerCase() === name) occurrences += 1;
  }
  const value = req.headers[name];
  if (occurrences > 1 || Array.isArray(value)) {
    throw new HttpError(400, "ambiguous_header", `${name} must appear once.`);
  }
  return typeof value === "string" ? value.trim() : "";
}

export function validateContentType(req, kind) {
  const contentEncoding = headerValue(req, "content-encoding").toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    throw new HttpError(415, "unsupported_content_encoding", "Compressed request bodies are not accepted.");
  }

  const raw = headerValue(req, "content-type");
  const [mediaType, ...parameters] = raw.split(";").map((part) => part.trim());
  if (kind === "json") {
    if (mediaType.toLowerCase() !== "application/json") {
      throw new HttpError(415, "unsupported_content_type", "Content-Type must be application/json.");
    }
    if (parameters.length > 1) {
      throw new HttpError(415, "unsupported_json_parameter", "Only one UTF-8 charset parameter is accepted.");
    }
    for (const parameter of parameters) {
      if (parameter && parameter.toLowerCase() !== "charset=utf-8") {
        throw new HttpError(415, "unsupported_json_parameter", "Only UTF-8 JSON is accepted.");
      }
    }
    return "application/json";
  }

  if (mediaType.toLowerCase() !== "multipart/form-data") {
    throw new HttpError(415, "unsupported_content_type", "Content-Type must be multipart/form-data.");
  }
  const boundaryParameters = parameters.filter((parameter) => /^boundary=/iu.test(parameter));
  if (boundaryParameters.length !== 1 || parameters.length !== 1) {
    throw new HttpError(415, "invalid_multipart_boundary", "A single multipart boundary is required.");
  }
  let boundary = boundaryParameters[0].slice("boundary=".length);
  if (boundary.startsWith("\"") && boundary.endsWith("\"")) {
    boundary = boundary.slice(1, -1);
  }
  if (!boundary || boundary.length > 70 || !/^[0-9A-Za-z'()+_,./:=?-]+$/u.test(boundary)) {
    throw new HttpError(415, "invalid_multipart_boundary", "Multipart boundary is invalid.");
  }
  return raw;
}

function declaredLength(req) {
  const raw = headerValue(req, "content-length");
  if (!raw) return null;
  if (!/^\d+$/u.test(raw)) {
    throw new HttpError(400, "invalid_content_length", "Content-Length is invalid.");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new HttpError(400, "invalid_content_length", "Content-Length is invalid.");
  }
  return value;
}

export function assertNoBody(req) {
  const contentLength = headerValue(req, "content-length");
  const transferEncoding = headerValue(req, "transfer-encoding");
  if ((contentLength && contentLength !== "0") || transferEncoding) {
    throw new HttpError(400, "unexpected_body", "This endpoint does not accept a request body.");
  }
}

export function readBody(req, maximumBytes, timeoutMs) {
  const announced = declaredLength(req);
  if (announced !== null && announced > maximumBytes) {
    req.resume();
    throw new HttpError(413, "body_too_large", "Request body exceeds the configured limit.");
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("aborted", onAborted);
      req.off("error", onError);
    };
    const fail = (error, destroy = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (destroy) req.destroy();
      else req.resume();
      reject(error);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > maximumBytes) {
        fail(new HttpError(413, "body_too_large", "Request body exceeds the configured limit."));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, size));
    };
    const onAborted = () => fail(new HttpError(400, "request_aborted", "Request body was aborted."));
    const onError = () => fail(new HttpError(400, "request_stream_error", "Request body could not be read."));
    const timer = setTimeout(() => {
      fail(new HttpError(408, "body_timeout", "Request body timed out."), true);
    }, timeoutMs);

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("aborted", onAborted);
    req.on("error", onError);
  });
}

export function bodySha256(body) {
  return createHash("sha256").update(body).digest("hex");
}

export function validateJsonBody(routeId, body) {
  let text;
  let data;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    data = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be valid UTF-8 JSON.");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new HttpError(400, "invalid_json_shape", "JSON body must be an object.");
  }
  if (routeId === "draft.add") {
    if (!Array.isArray(data.articles) || data.articles.length < 1 || data.articles.length > 8) {
      throw new HttpError(400, "invalid_articles", "Draft request must contain between one and eight articles.");
    }
    if (data.articles.some((article) => !article || typeof article !== "object" || Array.isArray(article))) {
      throw new HttpError(400, "invalid_articles", "Each article must be an object.");
    }
  }
  if (routeId === "draft.get") {
    if (typeof data.media_id !== "string" || !data.media_id || data.media_id.length > 256) {
      throw new HttpError(400, "invalid_media_reference", "Draft lookup requires a valid media reference.");
    }
  }
}

export function readIdempotencyKey(req, mode) {
  const key = headerValue(req, "idempotency-key");
  if (!key && mode === "required") {
    throw new HttpError(400, "missing_idempotency_key", "Idempotency-Key is required for draft creation.");
  }
  if (!key) return "";
  if (mode === "forbidden") {
    throw new HttpError(400, "idempotency_not_supported", "This route does not accept Idempotency-Key.");
  }
  if (key.length < 8 || key.length > 200 || !/^[A-Za-z0-9._:-]+$/u.test(key)) {
    throw new HttpError(400, "invalid_idempotency_key", "Idempotency-Key format is invalid.");
  }
  return key;
}
