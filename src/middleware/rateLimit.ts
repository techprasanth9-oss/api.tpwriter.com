import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { env } from "../env";
import type { AuthContext } from "../auth/middleware";

interface Bucket {
  count: number;
  resetAt: number;
}

interface Options {
  /** Unique name so separate limiters don't share counters. */
  name: string;
  windowMs: number;
  max: number;
}

/**
 * Fixed-window, in-memory rate limiter keyed by client IP. Good enough for a
 * single API instance; swap the Map for Redis once we run more than one.
 */
export function rateLimit({ name, windowMs, max }: Options): MiddlewareHandler {
  const buckets = new Map<string, Bucket>();

  // Drop expired buckets so the map can't grow without bound.
  setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, windowMs).unref();

  return async (c, next) => {
    const key = `${name}:${clientIp(c)}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      c.header("Retry-After", String(retryAfter));
      return c.json({ error: "rate_limited", retryAfter }, 429);
    }
    await next();
  };
}

function clientIp(c: Context): string {
  // Only trust X-Forwarded-For when we know a proxy in front of us sets it;
  // otherwise any client could spoof it to dodge the limit.
  if (env.TRUST_PROXY) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Fixed-window counter keyed by an arbitrary string (a user id). Returns
 * null while under the limit, else the seconds until the window resets.
 * In-memory, so per-process like `rateLimit`.
 */
export function userLimiter(windowMs: number, max: number) {
  const buckets = new Map<string, Bucket>();
  setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }, windowMs).unref();
  return (key: string): number | null => {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(key, b);
    }
    b.count += 1;
    return b.count > max ? Math.ceil((b.resetAt - now) / 1000) : null;
  };
}

/** Middleware form of `userLimiter`, keyed by the signed-in user. Mount
 *  after requireAuth. */
export function userRateLimit({ name, windowMs, max }: Options): MiddlewareHandler<AuthContext> {
  const limit = userLimiter(windowMs, max);
  return async (c, next) => {
    const retryAfter = limit(`${name}:${c.get("session").userId}`);
    if (retryAfter !== null) {
      c.header("Retry-After", String(retryAfter));
      return c.json({ error: "rate_limited", retryAfter }, 429);
    }
    await next();
  };
}
