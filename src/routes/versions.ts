import { Hono } from "hono";
import { vValidator } from "@hono/valibot-validator";
import mongoose, { Types, isValidObjectId } from "mongoose";
import { DocumentModel, type DocumentDoc } from "../models/document";
import { DocumentBlock } from "../models/documentBlock";
import { DocumentVersion, type DocumentVersionDoc } from "../models/documentVersion";
import { requireAuth } from "../auth/middleware";
import { requireDocRole, type DocEnv } from "../auth/access";
import { publicUser, publicUsers, type PublicUser } from "../collab/users";
import { autoSnapshot, createVersion, VersionTooLargeError } from "../collab/versions";
import { NamedVersionInput } from "../schemas/collab";
import { purgeTombstones } from "../collab/tombstones";

/**
 * Version history (Phase 6), editor+ throughout.
 *   GET  /documents/:id/versions               newest first, no content
 *   GET  /documents/:id/versions/:vid          with content
 *   POST /documents/:id/versions               { label } → named version
 *   POST /documents/:id/versions/:vid/restore  → { revision }
 * Automatic versions are taken by content saves (src/collab/versions.ts).
 */
export const versions = new Hono<DocEnv>();
versions.use("*", requireAuth);

const SUMMARY_FIELDS = { revision: 1, label: 1, auto: 1, createdAt: 1, createdBy: 1 } as const;

versions.get("/:id/versions", requireDocRole("editor"), async (c) => {
  const rows = await DocumentVersion.find({ documentId: c.get("doc")._id }, SUMMARY_FIELDS)
    .sort({ createdAt: -1, _id: -1 })
    .lean<DocumentVersionDoc[]>();
  const users = await publicUsers(rows.map((r) => r.createdBy));
  return c.json(rows.map((r) => toSummary(r, users)));
});

versions.get("/:id/versions/:vid", requireDocRole("editor"), async (c) => {
  const v = await findVersion(c.get("doc"), c.req.param("vid"));
  if (!v) return c.json({ error: "not_found" }, 404);
  const users = await publicUsers([v.createdBy]);
  return c.json({
    ...toSummary(v, users),
    title: v.title,
    blocks: v.blocks,
    defaultLayout: v.defaultLayout,
    pageSetup: v.pageSetup ?? {},
    styles: v.styles ?? {},
  });
});

versions.post(
  "/:id/versions",
  requireDocRole("editor"),
  vValidator("json", NamedVersionInput),
  async (c) => {
    const userId = c.get("session").userId;
    try {
      const v = await createVersion(c.get("doc")._id, {
        label: c.req.valid("json").label,
        auto: false,
        createdBy: userId,
      });
      if (!v) return c.json({ error: "not_found" }, 404);
      return c.json(toSummary(v, await publicUsers([userId])), 201);
    } catch (err) {
      if (err instanceof VersionTooLargeError) {
        console.warn(`[tp-writer-api] refused named version of ${c.get("doc")._id}: ${err.bytes} bytes`);
        return c.json({ error: "version_too_large" }, 413);
      }
      throw err;
    }
  },
);

/**
 * Restore: snapshot the current state ("Before restore", automatic), then in
 * one transaction replace content + meta with the version — blocks not in it
 * become tombstones, its blocks are upserted — and bump revision, orderRev
 * and metaRev so every client picks it up from /changes.
 */
versions.post("/:id/versions/:vid/restore", requireDocRole("editor"), async (c) => {
  const doc = c.get("doc");
  const v = await findVersion(doc, c.req.param("vid"));
  if (!v) return c.json({ error: "not_found" }, 404);

  await autoSnapshot(doc._id, c.get("session").userId, "Before restore");

  const documentId = doc._id;
  const blockIds = v.blocks.map((b) => b.id);
  let revision: number | undefined;
  const tx = await mongoose.startSession();
  try {
    await tx.withTransaction(async () => {
      const pre = await DocumentModel.findOneAndUpdate(
        { _id: documentId },
        { $inc: { revision: 1 } },
        { session: tx, new: false, timestamps: false, projection: { revision: 1, diffFloor: 1 } },
      ).lean<Pick<DocumentDoc, "revision" | "diffFloor">>();
      if (!pre) throw new Error("document vanished during restore");
      const rev = (pre.revision ?? 1) + 1;

      await DocumentBlock.updateMany(
        { documentId, deleted: { $ne: true }, blockId: { $nin: blockIds } },
        { $set: { deleted: true, rev, data: {}, tunes: null } },
        { session: tx },
      );
      if (v.blocks.length > 0) {
        await DocumentBlock.bulkWrite(
          v.blocks.map((b) => ({
            updateOne: {
              filter: { documentId, blockId: b.id },
              update: {
                $set: {
                  ownerId: doc.ownerId,
                  type: b.type,
                  data: b.data ?? {},
                  tunes: b.tunes ?? null,
                  rev,
                  deleted: false,
                },
              },
              upsert: true,
            },
          })),
          { session: tx, ordered: false },
        );
      }
      await DocumentModel.updateOne(
        { _id: documentId },
        {
          $set: {
            blockOrder: blockIds,
            orderRev: rev,
            metaRev: rev,
            title: v.title,
            defaultLayout: v.defaultLayout,
            pageSetup: v.pageSetup ?? {},
            styles: v.styles ?? {},
            updatedAt: new Date(),
          },
        },
        { session: tx, timestamps: false },
      );
      await purgeTombstones(documentId, rev, pre.diffFloor, tx);
      revision = rev;
    });
  } finally {
    await tx.endSession();
  }
  return c.json({ revision });
});

async function findVersion(doc: DocumentDoc, vid: string | undefined) {
  if (!vid || !isValidObjectId(vid)) return null;
  return DocumentVersion.findOne({
    _id: new Types.ObjectId(vid),
    documentId: doc._id,
  }).lean<DocumentVersionDoc>();
}

function toSummary(
  v: Pick<DocumentVersionDoc, "_id" | "revision" | "label" | "auto" | "createdAt" | "createdBy">,
  users: Map<string, PublicUser>,
) {
  return {
    id: v._id.toString(),
    revision: v.revision,
    label: v.label ?? null,
    auto: v.auto,
    createdAt: v.createdAt.toISOString(),
    createdBy: v.createdBy ? publicUser(users, v.createdBy) : null,
  };
}
