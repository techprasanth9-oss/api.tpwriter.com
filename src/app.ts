import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { env } from "./env";
import { auth } from "./routes/auth";
import { documents } from "./routes/documents";
import { sharing } from "./routes/sharing";
import { comments, notifications } from "./routes/comments";
import { versions } from "./routes/versions";
import { createPdfRoutes } from "./routes/pdf";
import { uploads, UPLOAD_BODY_LIMIT } from "./routes/uploads";

// Block JSON can carry inline (base64) images until every image goes through
// /uploads, so allow generous bodies — but stay under Mongo's 16 MB BSON cap.
const DOCUMENT_BODY_LIMIT = 12 * 1024 * 1024;
const AUTH_BODY_LIMIT = 16 * 1024;

function tooLarge(maxSize: number) {
  return bodyLimit({
    maxSize,
    onError: (c) => c.json({ error: "too_large", max: maxSize }, 413),
  });
}

/**
 * Build the Hono app: middleware, routes, error mapping. No I/O here — the
 * caller connects Mongo first (src/index.ts at boot, the test setup in tests).
 */
export function createApp() {
  const app = new Hono();

  // Request logs are noise in test output.
  if (env.NODE_ENV !== "test") app.use("*", logger());
  app.use(
    "*",
    secureHeaders({
      // The API serves JSON and images only; it never needs to be framed or
      // to run script.
      contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      // Uploaded images are embedded by the FE, which may live on another origin.
      crossOriginResourcePolicy: "cross-origin",
    }),
  );

  // `credentials: true` makes the browser forbid `Access-Control-Allow-Origin: *`,
  // so when CORS_ORIGINS contains `*` we reflect the request's Origin instead of
  // literally emitting `*`. env.ts refuses `*` in production; non-wildcard
  // config falls through to Hono's allowlist.
  const allowAny = env.CORS_ORIGINS.includes("*");
  app.use(
    "*",
    cors({
      origin: allowAny
        ? (origin) => origin || "*"
        : env.CORS_ORIGINS,
      credentials: true,
    }),
  );

  app.use("/auth/*", tooLarge(AUTH_BODY_LIMIT));
  app.use("/documents/*", tooLarge(DOCUMENT_BODY_LIMIT));
  app.use("/documents", tooLarge(DOCUMENT_BODY_LIMIT));
  app.use("/uploads", tooLarge(UPLOAD_BODY_LIMIT));
  app.use("/notifications/*", tooLarge(AUTH_BODY_LIMIT));

  app.get("/health", (c) =>
    c.json({ ok: true, service: "tp-writer-api", env: env.NODE_ENV }),
  );

  app.route("/auth", auth);
  app.route("/documents", documents);
  // Phase 6 collaboration: /documents/:id/{shares,link,comments,versions}.
  app.route("/documents", sharing);
  app.route("/documents", comments);
  app.route("/documents", versions);
  app.route("/notifications", notifications);
  // GET /pdf/status, POST /documents/:id/pdf
  app.route("/", createPdfRoutes());
  app.route("/uploads", uploads);

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    // Unique-index violations (e.g. two signups racing for one email).
    if ((err as { code?: number }).code === 11000) {
      return c.json({ error: "conflict" }, 409);
    }
    console.error(`[tp-writer-api] ${c.req.method} ${c.req.path} failed:`, err);
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
