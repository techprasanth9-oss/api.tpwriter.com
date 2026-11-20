import { afterAll, beforeAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { DocumentModel } from "../models/document";
import { DocumentBlock } from "../models/documentBlock";
import { DocumentPage } from "../models/documentPage";
import { User } from "../models/user";
import { DocumentVersion } from "../models/documentVersion";
import { CommentThread } from "../models/commentThread";
import { Notification } from "../models/notification";

/**
 * Per-test-file Mongo: an in-memory single-node replica set (transactions
 * need a replica set). Never touches the MONGODB_URI from .env.
 */

// Belt and braces: vitest.config.ts sets a placeholder URI before anything
// imports src/env.ts. If that ever stops being true, refuse to run rather
// than risk pointing app code at the live cluster from .env.
if (!process.env.MONGODB_URI?.includes("test-placeholder.invalid")) {
  throw new Error("[test] MONGODB_URI is not the test placeholder; aborting.");
}

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  mongoose.set("strictQuery", true);
  await mongoose.connect(replSet.getUri());
  // Create collections + indexes up front: catalog changes racing with the
  // first transaction can fail it.
  await Promise.all(
    [DocumentModel, DocumentBlock, DocumentPage, User, DocumentVersion, CommentThread, Notification].map(async (m) => {
      await m.createCollection();
      await m.syncIndexes();
    }),
  );
});

beforeEach(async () => {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
});

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});
