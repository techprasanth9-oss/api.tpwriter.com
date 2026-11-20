import type mongoose from "mongoose";
import type { Types } from "mongoose";
import { DocumentModel } from "../models/document";
import { DocumentBlock } from "../models/documentBlock";

/** Tombstones are kept this many revisions, then purged (and `diffFloor`
 *  raised so /changes answers `reset` to clients that far behind). */
export const TOMBSTONE_KEEP_REVISIONS = 500;

/** Drop tombstones older than TOMBSTONE_KEEP_REVISIONS and raise diffFloor
 *  past them, so /changes knows it can no longer diff from there. */
export async function purgeTombstones(
  documentId: Types.ObjectId,
  revision: number,
  diffFloor: number | undefined,
  tx: mongoose.ClientSession,
): Promise<void> {
  const threshold = revision - TOMBSTONE_KEEP_REVISIONS;
  if (threshold <= (diffFloor ?? 0)) return;
  const purged = await DocumentBlock.deleteMany(
    { documentId, deleted: true, rev: { $lte: threshold } },
    { session: tx },
  );
  if (purged.deletedCount > 0) {
    await DocumentModel.updateOne(
      { _id: documentId },
      { $max: { diffFloor: threshold } },
      { session: tx, timestamps: false },
    );
  }
}

