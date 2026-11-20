import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(
      `[env] ${name} is not set. Copy .env.example to .env and fill it in.`,
    );
  }
  return v;
}

const isProd = process.env.NODE_ENV === "production";

const JWT_SECRET = required("JWT_SECRET");
if (JWT_SECRET.length < 32) {
  throw new Error("[env] JWT_SECRET must be at least 32 characters.");
}

const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? "http://localhost:3000")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// A wildcard combined with credentialed CORS lets any website read users'
// documents, so it's a dev-only convenience.
if (isProd && CORS_ORIGINS.includes("*")) {
  throw new Error(
    "[env] CORS_ORIGINS=* is not allowed in production. List the FE origins explicitly.",
  );
}

/** Optional absolute http(s) URL, normalised to its origin + path without
 *  a trailing slash. Refuses to boot on a malformed value. */
function optionalUrl(name: string): string | undefined {
  const v = process.env[name]?.trim();
  if (!v) return undefined;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new Error(`[env] ${name} must be an absolute URL (got "${v}").`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`[env] ${name} must be an http(s) URL.`);
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

export const env = {
  MONGODB_URI: required("MONGODB_URI"),
  JWT_SECRET,
  CORS_ORIGINS,
  PORT: Number(process.env.PORT ?? 3001),
  NODE_ENV: process.env.NODE_ENV ?? "development",
  isProd,
  // Set when the API runs behind a reverse proxy / load balancer that sets
  // X-Forwarded-For. Used by the rate limiter to find the real client IP.
  TRUST_PROXY: process.env.TRUST_PROXY === "true",
  // ── Server-side PDF export (POST /documents/:id/pdf) ──────────────────
  // Public URL of the frontend. The renderer opens
  // `${APP_URL}/documents/:id/print` in headless Chromium with the
  // caller's session cookie. Unset → the endpoint answers 501.
  APP_URL: optionalUrl("APP_URL"),
  // Public URL the frontend uses to reach this API, when it's on another
  // origin than APP_URL (VITE_API_URL). The session cookie is also set for
  // it, and it's allowed in the renderer's request allowlist.
  API_PUBLIC_URL: optionalUrl("API_PUBLIC_URL"),
  // Chromium / Chrome binary for the renderer; unset → playwright-core's
  // default browser location (`npx playwright-core install chromium`).
  CHROMIUM_PATH: process.env.CHROMIUM_PATH?.trim() || undefined,
  // Concurrent renders (each is a browser tab).
  PDF_CONCURRENCY: Math.max(1, Number(process.env.PDF_CONCURRENCY ?? 2) || 2),
};
