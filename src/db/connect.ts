import mongoose from "mongoose";
import { env } from "../env";

/**
 * Connect once at boot. Mongoose maintains the connection pool after this;
 * routes just read from the model singletons. Called from src/index.ts
 * before Hono starts listening.
 */
export async function connectMongo(): Promise<void> {
  mongoose.set("strictQuery", true);
  await mongoose.connect(env.MONGODB_URI, {
    // Fail fast in dev if Atlas can't be reached — otherwise mongoose waits
    // ~30s before any error, which hides misconfigured URIs.
    serverSelectionTimeoutMS: 10_000,
  });
  console.log("[mongo] connected");
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect();
}
