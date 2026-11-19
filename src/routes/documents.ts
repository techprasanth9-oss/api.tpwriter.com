import { Hono } from "hono";
import { vValidator } from "@hono/valibot-validator";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import mongoose, { Types, isValidObjectId } from "mongoose";
import {
  DEFAULT_LAYOUT,
  DocumentModel,
  type DocumentDoc,
  type PageLayout,
} from "../models/document";
import { DocumentBlock, type DocumentBlockDoc } from "../models/documentBlock";
import { DocumentPage } from "../models/documentPage";
import { CURRENT_SCHEMA_VERSION, ensureV2 } from "../migrations/v2";
import { requireAuth, type AuthContext } from "../auth/middleware";
import {
  CreateDocumentInput,
  SaveContentInput,
  UpdateDocumentInput,
  type SaveContentInputT,
} from "../schemas/documents";

export const documents = new Hono<AuthContext>();

documents.use("*", requireAuth);

/** List this user's documents, newest-updated first. Blocks NOT included —
 *  only a count, computed in Mongo so we don't ship every blockOrder here. */
documents.get("/", async (c) => {
  const session = c.get("session");
  const rows = await DocumentModel.aggregate<ListRow>([
    { $match: { ownerId: new Types.ObjectId(session.userId) } },
    { $sort: { updatedAt: -1 } },
    {
      $project: {
        title: 1,
        defaultLayout: 1,
        createdAt: 1,
        updatedAt: 1,
        // Legacy (unmigrated) docs have no blockOrder → 0.
        blockCount: { $size: { $ifNull: ["$blockOrder", []] } },
      },
    },
  ]);
  return c.json(rows.map(toListDocResponse));
});

documents.post("/", vValidator("json", CreateDocumentInput), async (c) => {
  const session = c.get("session");
  const input = c.req.valid("json");

  const doc = await DocumentModel.create({
    ownerId: new Types.ObjectId(session.userId),
    title: input.title,
    defaultLayout: { ...DEFAULT_LAYOUT, ...(input.defaultLayout ?? {}) },
    schemaVersion: CURRENT_SCHEMA_VERSION,
    revision: 1,
    blockOrder: [],
    styles: {},
    pageSetup: {},
  });

  // A fresh doc has no blocks; the FE's editor starts from an empty list.
  return c.json({ ...toMetaResponse(doc.toObject()), blocks: [] }, 201);
});

/** Full document: metadata + every block in order. Migrates legacy docs. */
documents.get("/:id", async (c) => {
  const session = c.get("session");
  const doc = await loadOwnedDoc(c.req.param("id"), session.userId);
  if (!doc) return c.json({ error: "not_found" }, 404);

  return c.json(await toFullDocResponse(doc));
});

/** Metadata-only update. Returns DocumentMeta (no blocks) and leaves
 *  `revision` alone — content goes through PUT /:id/content. */
documents.patch(
  "/:id",
  vValidator("json", UpdateDocumentInput),
  async (c) => {
    const session = c.get("session");
    const doc = await loadOwnedDoc(c.req.param("id"), session.userId);
    if (!doc) return c.json({ error: "not_found" }, 404);
    const patch = c.req.valid("json");

    const $set: Record<string, unknown> = {};
    if (patch.title !== undefined) $set.title = patch.title;
    if (patch.defaultLayout !== undefined) {
      $set.defaultLayout = { ...doc.defaultLayout, ...patch.defaultLayout };
    }
    if (patch.headerBlocks !== undefined) $set.headerBlocks = patch.headerBlocks;
    if (patch.footerBlocks !== undefined) $set.footerBlocks = patch.footerBlocks;
    if (patch.styles !== undefined) $set.styles = patch.styles;
    if (patch.pageSetup !== undefined) $set.pageSetup = patch.pageSetup;

    const updated = await DocumentModel.findOneAndUpdate(
      { _id: doc._id, ownerId: session.userId },
      { $set },
      { new: true },
    ).lean<DocumentDoc>();
    if (!updated) return c.json({ error: "not_found" }, 404);

    return c.json(toMetaResponse(updated));
  },
);

documents.delete("/:id", async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");
  if (!isValidObjectId(id)) return c.json({ error: "not_found" }, 404);

  const doc = await DocumentModel.findOneAndDelete({
    _id: id,
    ownerId: session.userId,
  });
  if (!doc) return c.json({ error: "not_found" }, 404);

  // Cascade by hand — Mongoose can't do this across collections without the
  // discontinued cascading-deletes plugin. Legacy pages may still exist
  // (migration leaves them for rollback safety).
  await Promise.all([
    DocumentBlock.deleteMany({ documentId: doc._id }),
    DocumentPage.deleteMany({ documentId: doc._id }),
  ]);

  return c.body(null, 204);
});

/**
 * Incremental, atomic content save.
 *
 * Body: `{ baseRevision, upserts, deletes, order? }`. `order` is the full new
 * block order; it may be omitted only when the save edits existing blocks in
 * place (no new ids, no deletes) — otherwise 400 order_required.
 *
 * Everything runs in one transaction: the conditional revision bump is the
 * first write, so a stale `baseRevision` (409) or any later validation
 * failure (400) aborts with nothing persisted.
 */
documents.put(
  "/:id/content",
  vValidator("json", SaveContentInput),
  async (c) => {
    const session = c.get("session");
    const doc = await loadOwnedDoc(c.req.param("id"), session.userId);
    if (!doc) return c.json({ error: "not_found" }, 404);
    const input = c.req.valid("json");

    const invalid = checkContentInput(input);
    if (invalid) return c.json({ error: invalid }, 400);

    try {
      const saved = await saveContent(doc, input);
      return c.json({
        revision: saved.revision,
        updatedAt: saved.updatedAt.toISOString(),
      });
    } catch (err) {
      if (err instanceof ContentSaveError) return c.json(err.body, err.status);
      throw err;
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Owned doc by id, migrated to v2. `null` → respond 404 (missing, malformed
 *  id, or owned by someone else — indistinguishable on purpose). */
async function loadOwnedDoc(
  id: string,
  userId: string,
): Promise<DocumentDoc | null> {
  if (!isValidObjectId(id)) return null;
  const doc = await DocumentModel.findOne({
    _id: id,
    ownerId: userId,
  }).lean<DocumentDoc>();
  if (!doc) return null;
  return ensureV2(doc);
}

/** Thrown inside the content-save transaction to abort it; mapped to an
 *  HTTP response outside. */
class ContentSaveError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly body: { error: string; [k: string]: unknown },
  ) {
    super(body.error);
  }
}

/** Request-only checks that don't need the DB. Returns an error code. */
function checkContentInput(input: SaveContentInputT): string | null {
  const upsertIds = new Set(input.upserts.map((b) => b.id));
  if (upsertIds.size !== input.upserts.length) return "duplicate_block_id";
  if (input.deletes.some((id) => upsertIds.has(id))) {
    return "upsert_delete_overlap";
  }
  if (input.order) {
    if (new Set(input.order).size !== input.order.length) {
      return "order_mismatch";
    }
  } else if (input.deletes.length > 0) {
    return "order_required";
  }
  return null;
}

async function saveContent(
  doc: DocumentDoc,
  input: SaveContentInputT,
): Promise<{ revision: number; updatedAt: Date }> {
  const documentId = doc._id;
  const upsertIds = input.upserts.map((b) => b.id);
  let result: { revision: number; updatedAt: Date } | undefined;

  const tx = await mongoose.startSession();
  try {
    // withTransaction retries the callback on transient errors (e.g. a write
    // conflict with a concurrent save), so it must not leak state between
    // attempts — `result` is only assigned on the success path.
    await tx.withTransaction(async () => {
      const $set: Record<string, unknown> = { updatedAt: new Date() };
      if (input.order) $set.blockOrder = input.order;

      const bumped = await DocumentModel.findOneAndUpdate(
        { _id: documentId, ownerId: doc.ownerId, revision: input.baseRevision },
        { $inc: { revision: 1 }, $set },
        {
          session: tx,
          new: true,
          timestamps: false,
          projection: { revision: 1, updatedAt: 1 },
        },
      ).lean<Pick<DocumentDoc, "revision" | "updatedAt">>();

      if (!bumped) {
        const current = await DocumentModel.findOne(
          { _id: documentId, ownerId: doc.ownerId },
          { revision: 1 },
        )
          .session(tx)
          .lean<Pick<DocumentDoc, "revision">>();
        if (!current) throw new ContentSaveError(404, { error: "not_found" });
        throw new ContentSaveError(409, {
          error: "revision_conflict",
          revision: current.revision,
        });
      }

      // Without `order`, the block set must not change: every upsert has to
      // be an edit of a block that already exists.
      if (!input.order && upsertIds.length > 0) {
        const existing = await DocumentBlock.countDocuments({
          documentId,
          blockId: { $in: upsertIds },
        }).session(tx);
        if (existing !== upsertIds.length) {
          throw new ContentSaveError(400, { error: "order_required" });
        }
      }

      if (input.upserts.length > 0) {
        await DocumentBlock.bulkWrite(
          input.upserts.map((b) => ({
            updateOne: {
              filter: { documentId, blockId: b.id },
              update: {
                $set: {
                  ownerId: doc.ownerId,
                  type: b.type,
                  data: b.data,
                  tunes: b.tunes,
                },
              },
              upsert: true,
            },
          })),
          { session: tx, ordered: false },
        );
      }

      if (input.deletes.length > 0) {
        await DocumentBlock.deleteMany(
          { documentId, blockId: { $in: input.deletes } },
          { session: tx },
        );
      }

      // `order` must name exactly the blocks that exist after this save.
      if (input.order) {
        const actual: string[] = await DocumentBlock.distinct("blockId", {
          documentId,
        }).session(tx);
        if (!sameSet(actual, input.order)) {
          throw new ContentSaveError(400, { error: "order_mismatch" });
        }
      }

      result = { revision: bumped.revision!, updatedAt: bumped.updatedAt };
    });
  } finally {
    await tx.endSession();
  }

  if (!result) throw new Error("content save transaction did not complete");
  return result;
}

/** `b` is known to be duplicate-free (checkContentInput). */
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

// ─────────────────────────────────────────────────────────────────────────────
// Response serialisers — one place to control what we expose to clients.
// ─────────────────────────────────────────────────────────────────────────────

interface ListRow {
  _id: unknown;
  title: string;
  defaultLayout: PageLayout;
  blockCount: number;
  createdAt: Date;
  updatedAt: Date;
}

function toListDocResponse(d: ListRow) {
  return {
    id: String(d._id),
    title: d.title,
    defaultLayout: d.defaultLayout,
    blockCount: d.blockCount,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

function toMetaResponse(doc: DocumentDoc) {
  return {
    id: doc._id.toString(),
    title: doc.title,
    revision: doc.revision ?? 1,
    defaultLayout: doc.defaultLayout,
    headerBlocks: doc.headerBlocks ?? [],
    footerBlocks: doc.footerBlocks ?? [],
    styles: doc.styles ?? {},
    pageSetup: doc.pageSetup ?? {},
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

async function toFullDocResponse(doc: DocumentDoc) {
  const rows = await DocumentBlock.find(
    { documentId: doc._id },
    { blockId: 1, type: 1, data: 1, tunes: 1 },
  ).lean();
  const byId = new Map(rows.map((r) => [r.blockId, r]));
  // blockOrder is the source of truth for order; rows are unordered.
  const blocks = (doc.blockOrder ?? []).flatMap((id) => {
    const row = byId.get(id);
    return row ? [toBlockResponse(row)] : [];
  });
  return { ...toMetaResponse(doc), blocks };
}

function toBlockResponse(
  b: Pick<DocumentBlockDoc, "blockId" | "type" | "data" | "tunes">,
) {
  return {
    id: b.blockId,
    type: b.type,
    data: b.data ?? {},
    ...(b.tunes ? { tunes: b.tunes } : {}),
  };
}
