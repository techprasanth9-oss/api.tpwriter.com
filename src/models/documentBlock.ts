import { Schema, model, type Model, type Types } from "mongoose";

/**
 * One Editor.js block of a v2 document. The document's `blockOrder` holds the
 * display order; rows here are unordered. One row per block keeps each content
 * save a handful of small writes (only the blocks that changed) and keeps a
 * long document far from the 16 MB BSON limit.
 *
 * `blockId` is the Editor.js block id, unique per document — the client
 * addresses blocks by it, so it's the upsert key for content saves.
 *
 * Phase 6: `rev` is the document revision that last wrote the row, and a
 * deleted block is kept as a tombstone (`deleted: true`, data cleared) so
 * GET /documents/:id/changes can report deletes and concurrent saves can be
 * merged block by block. Rows written before Phase 6 have neither field:
 * a missing `rev` reads as 0, a missing `deleted` as false. Tombstones are
 * purged ~500 revisions later (see routes/documents.ts).
 */

export interface DocumentBlockDoc {
  _id: Types.ObjectId;
  documentId: Types.ObjectId;
  // Owner duplicated here (as on DocumentPage) so block rows can be scoped
  // to a user without a join.
  ownerId: Types.ObjectId;
  blockId: string;
  type: string;
  // Mixed because Editor.js tool data is open — any registered tool can add
  // its own keys without a schema migration here.
  data: Record<string, unknown>;
  tunes: Record<string, unknown> | null;
  rev?: number;
  deleted?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const blockSchema = new Schema<DocumentBlockDoc>(
  {
    documentId: {
      type: Schema.Types.ObjectId,
      ref: "Document",
      required: true,
    },
    ownerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    blockId: { type: String, required: true },
    type: { type: String, required: true },
    data: { type: Schema.Types.Mixed, default: () => ({}) },
    tunes: { type: Schema.Types.Mixed, default: null },
    rev: { type: Number },
    deleted: { type: Boolean },
  },
  {
    timestamps: true,
    versionKey: false,
    // Empty `data: {}` is meaningful to Editor.js (e.g. a blank paragraph).
    minimize: false,
  },
);

// Upsert key for content saves; also serves "all blocks of a document".
blockSchema.index({ documentId: 1, blockId: 1 }, { unique: true });
// Changes feed ("everything after revision R") and tombstone GC.
blockSchema.index({ documentId: 1, rev: 1 });

export const DocumentBlock: Model<DocumentBlockDoc> = model<DocumentBlockDoc>(
  "DocumentBlock",
  blockSchema,
);
