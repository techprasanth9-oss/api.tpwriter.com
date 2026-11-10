/**
 * Run the real API against a throwaway in-memory MongoDB replica set —
 * for browser end-to-end tests and for local development without Atlas.
 * Nothing persists after the process exits.
 *
 *   pnpm dev:memory            # API on :3001 (PORT to change)
 */
import { MongoMemoryReplSet } from "mongodb-memory-server";

const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
// Set before the app's env module loads; dotenv never overrides an
// existing variable, so the URI in .env is not used.
process.env.MONGODB_URI = replSet.getUri("tp-writer-memory");
process.env.JWT_SECRET ??= "memory-server-only-secret-not-for-production-use";
process.env.CORS_ORIGINS ??= "http://localhost:3000";
process.env.NODE_ENV = "development";
console.log(`[dev:memory] in-memory MongoDB at ${process.env.MONGODB_URI}`);

const shutdown = async () => {
  await replSet.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await import("../src/index.ts");
