import mongoose, { Types } from "mongoose";
import { DocumentModel, type DocumentDoc } from "../models/document";
import { DocumentBlock } from "../models/documentBlock";
import {
  DocumentVersion,
  type DocumentVersionDoc,
  type VersionBlock,
} from "../models/documentVersion";

/** Automatic snapshot after a content save when the newest version is at
 *  least this old (or there is none). */
export const AUTO_VERSION_INTERVAL_MS = 10 * 60_000;
/** Automatic versions kept per document (named ones are never pruned). */
export const AUTO_VERSION_KEEP = 50;
/** Snapshots bigger than this are skipped (Mongo's hard cap is 16 MB). */
export const MAX_VERSION_BYTES = 10 * 1024 * 1024;

export class VersionTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`version snapshot is ${bytes} bytes`);
  }
}

type SnapshotFields = Pick<
  DocumentVersionDoc,
  "revision" | "title" | "defaultLayout" | "pageSetup" | "styles" | "blocks"
>;

/** Current meta + live blocks in order. */
export async function currentState(documentId: Types.ObjectId): Promise<SnapshotFields | null> {
  const doc = await DocumentModel.findById(documentId).lean<DocumentDoc>();
  if (!doc) return null;
  const rows = await DocumentBlock.find(
    { documentId, deleted: { $ne: true } },
    { blockId: 1, type: 1, data: 1, tunes: 1 },
  ).lean();
  const byId = new Map(rows.map((r) => [r.blockId, r]));
  const blocks: VersionBlock[] = (doc.blockOrder ?? []).flatMap((id) => {
    const r = byId.get(id);
    if (!r) return [];
    return [{ id, type: r.type, data: r.data ?? {}, ...(r.tunes ? { tunes: r.tunes } : {}) }];
  });
  return {
    revision: doc.revision ?? 1,
    title: doc.title,
    defaultLayout: doc.defaultLayout,
    pageSetup: doc.pageSetup ?? {},
    styles: doc.styles ?? {},
    blocks,
  };
}

/**
 * Snapshot the document as it is now. Throws VersionTooLargeError over
 * MAX_VERSION_BYTES; returns null if the document is gone.
 */
export async function createVersion(
  documentId: Types.ObjectId,
  opts: { label: string | null; auto: boolean; createdBy: string | null },
): Promise<DocumentVersionDoc | null> {
  const state = await currentState(documentId);
  if (!state) return null;
  const row = {
    documentId,
    ...state,
    label: opts.label,
    auto: opts.auto,
    createdBy: opts.createdBy ? new Types.ObjectId(opts.createdBy) : null,
    createdAt: new Date(),
  };
  const bytes = mongoose.mongo.BSON.calculateObjectSize(row);
  if (bytes > MAX_VERSION_BYTES) throw new VersionTooLargeError(bytes);
  const created = await DocumentVersion.create(row);
  if (opts.auto) await pruneAutoVersions(documentId);
  return created.toObject();
}

/** Like createVersion for automatic snapshots: never throws (a snapshot
 *  must not fail the save or restore that triggered it). */
export async function autoSnapshot(
  documentId: Types.ObjectId,
  createdBy: string | null,
  label: string | null = null,
): Promise<void> {
  try {
    await createVersion(documentId, { label, auto: true, createdBy });
  } catch (err) {
    if (err instanceof VersionTooLargeError) {
      console.warn(
        `[tp-writer-api] skipped version snapshot of ${documentId}: ${err.bytes} bytes > ${MAX_VERSION_BYTES}`,
      );
    } else {
      console.error(`[tp-writer-api] version snapshot of ${documentId} failed:`, err);
    }
  }
}

/** Called after every content save. */
export async function maybeAutoSnapshot(documentId: Types.ObjectId, userId: string): Promise<void> {
  try {
    const latest = await DocumentVersion.findOne({ documentId }, { createdAt: 1 })
      .sort({ createdAt: -1 })
      .lean();
    if (latest && Date.now() - latest.createdAt.getTime() < AUTO_VERSION_INTERVAL_MS) return;
  } catch (err) {
    console.error(`[tp-writer-api] version lookup for ${documentId} failed:`, err);
    return;
  }
  await autoSnapshot(documentId, userId);
}

export async function pruneAutoVersions(documentId: Types.ObjectId): Promise<void> {
  const stale = await DocumentVersion.find({ documentId, auto: true }, { _id: 1 })
    .sort({ createdAt: -1, _id: -1 })
    .skip(AUTO_VERSION_KEEP)
    .lean();
  if (stale.length > 0) {
    await DocumentVersion.deleteMany({ _id: { $in: stale.map((v) => v._id) } });
  }
}
