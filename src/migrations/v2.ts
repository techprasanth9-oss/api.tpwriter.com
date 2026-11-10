import mongoose, { type Types } from "mongoose";
import { nanoid } from "nanoid";
import { DocumentModel, type DocumentDoc } from "../models/document";
import { DocumentBlock } from "../models/documentBlock";
import { DocumentPage, type EditorBlock } from "../models/documentPage";
import { BLOCK_ID_RE } from "../schemas/documents";

/**
 * Lazy v1 → v2 migration, run on read (GET / PATCH / PUT content).
 *
 * v1 stored content as N `DocumentPage` rows, each with its own Editor.js
 * `OutputData`. v2 stores one block list: a `DocumentBlock` row per block plus
 * `Document.blockOrder`. Migrating concatenates every page's blocks in
 * `pageIndex` order.
 *
 * - Every block gets a valid, document-unique id: the existing one if it
 *   matches BLOCK_ID_RE and hasn't been used yet, else `nanoid(10)`. Legacy
 *   data can contain duplicate ids (copy/paste between pages) or none at all.
 * - Per-page `layoutOverride` values are dropped. Mixed layouts within a doc
 *   will come back as sections; until then the doc's `defaultLayout` applies.
 * - DocumentPage rows are left in place for rollback safety.
 *
 * Race safety: everything runs in one transaction, and the first write is the
 * conditional "claim" (`schemaVersion` still legacy → set to 2). Two
 * concurrent migrations of the same doc write-conflict on that update; the
 * loser's transaction is retried by `withTransaction`, finds the doc already
 * at v2, and writes nothing — so blocks are never inserted twice. Block writes
 * are also upserts keyed on (documentId, blockId), so a retried attempt is
 * idempotent.
 */

export const CURRENT_SCHEMA_VERSION = 2;

type DocLike = Pick<DocumentDoc, "_id" | "ownerId"> & {
  schemaVersion?: number;
};

export function isV2(doc: { schemaVersion?: number }): boolean {
  return doc.schemaVersion === CURRENT_SCHEMA_VERSION;
}

/**
 * Make sure `doc` is stored as v2 and return its current (lean) state.
 * Returns `null` if the document disappeared (deleted concurrently).
 */
export async function ensureV2<T extends DocLike>(
  doc: T,
): Promise<DocumentDoc | null> {
  if (isV2(doc)) return doc as unknown as DocumentDoc;

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const pages = await DocumentPage.find({ documentId: doc._id })
        .sort({ pageIndex: 1 })
        .session(session)
        .lean();

      const blocks = assignBlockIds(
        pages.flatMap((p) => p.content?.blocks ?? []),
      );
      const blockOrder = blocks.map((b) => b.id);

      // Claim first (see header comment). No timestamps: merely opening a
      // legacy doc shouldn't move it to the top of the "recent" list.
      const claimed = await DocumentModel.updateOne(
        { _id: doc._id, schemaVersion: { $ne: CURRENT_SCHEMA_VERSION } },
        {
          $set: {
            schemaVersion: CURRENT_SCHEMA_VERSION,
            revision: 1,
            blockOrder,
          },
        },
        { session, timestamps: false },
      );
      if (claimed.matchedCount === 0) return; // already migrated / deleted

      if (blocks.length > 0) {
        await DocumentBlock.bulkWrite(
          blocks.map((b) => ({
            updateOne: {
              filter: { documentId: doc._id, blockId: b.id },
              update: {
                $set: {
                  ownerId: doc.ownerId as Types.ObjectId,
                  type: b.type,
                  data: b.data ?? {},
                  tunes: b.tunes ?? null,
                },
              },
              upsert: true,
            },
          })),
          { session, ordered: true },
        );
      }
    });
  } finally {
    await session.endSession();
  }

  return DocumentModel.findById(doc._id).lean<DocumentDoc>();
}

/** Give every block a valid id that's unique within the list. */
function assignBlockIds(
  blocks: EditorBlock[],
): (EditorBlock & { id: string })[] {
  const used = new Set<string>();
  return blocks
    // Drop malformed entries — Editor.js can't render a block without a type.
    .filter((b) => b && typeof b.type === "string")
    .map((b) => {
      let id =
        typeof b.id === "string" && BLOCK_ID_RE.test(b.id) && !used.has(b.id)
          ? b.id
          : nanoid(10);
      // nanoid's alphabet is BLOCK_ID_RE-safe; just guard the (absurdly
      // unlikely) collision with an id already kept from the legacy data.
      while (used.has(id)) id = nanoid(10);
      used.add(id);
      return { ...b, id };
    });
}
