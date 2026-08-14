// SPDX-License-Identifier: AGPL-3.0-or-later

export class ConfigurationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ConfigurationError";
    this.code = code;
  }
}

export class HttpError extends Error {
  constructor(statusCode, code, message, headers = {}) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
    this.headers = headers;
  }
}

export class UpstreamError extends Error {
  constructor(code, statusCode = 502, outcomeUnknown = false) {
    super(code);
    this.name = "UpstreamError";
    this.code = code;
    this.statusCode = statusCode;
    this.outcomeUnknown = outcomeUnknown;
  }
}
