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
};
