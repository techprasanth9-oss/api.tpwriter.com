import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { env } from "./env";
import { connectMongo } from "./db/connect";
import { auth } from "./routes/auth";
import { documents } from "./routes/documents";
import { uploads } from "./routes/uploads";

async function main() {
  await connectMongo();

  const app = new Hono();

  app.use("*", logger());

  // `credentials: true` makes the browser forbid `Access-Control-Allow-Origin: *`,
  // so when CORS_ORIGINS contains `*` we reflect the request's Origin instead of
  // literally emitting `*`. Non-wildcard config falls through to Hono's allowlist.
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

  app.get("/health", (c) =>
    c.json({ ok: true, service: "tp-writer-api", env: env.NODE_ENV }),
  );

  app.route("/auth", auth);
  app.route("/documents", documents);
  app.route("/uploads", uploads);

  serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    console.log(`[tp-writer-api] listening on http://localhost:${info.port}`);
  });
}

main().catch((err) => {
  console.error("[tp-writer-api] fatal boot error:", err);
  process.exit(1);
});
