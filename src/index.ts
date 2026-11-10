import { serve } from "@hono/node-server";
import { env } from "./env";
import { connectMongo } from "./db/connect";
import { createApp } from "./app";

async function main() {
  await connectMongo();

  const app = createApp();

  serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    console.log(`[tp-writer-api] listening on http://localhost:${info.port}`);
  });
}

main().catch((err) => {
  console.error("[tp-writer-api] fatal boot error:", err);
  process.exit(1);
});
