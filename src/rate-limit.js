// SPDX-License-Identifier: AGPL-3.0-or-later

export class FixedWindowRateLimiter {
  constructor(windowMs, limits) {
    this.windowMs = windowMs;
    this.limits = Object.freeze({ ...limits });
    this.windows = new Map();
  }

  consume(key, policy = "authenticated", now = Date.now()) {
    const limit = this.limits[policy];
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("Unknown rate-limit policy.");
    }
    const current = this.windows.get(key);
    if (!current || current.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (current.count >= limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1_000)),
      };
    }
    current.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

export class ConcurrencyGate {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
  }

  tryAcquire() {
    if (this.active >= this.limit) return null;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }
}
