import { Hono } from "hono";
import { vValidator } from "@hono/valibot-validator";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import mongoose, { Types } from "mongoose";
import {
  DEFAULT_LAYOUT,
  DocumentModel,
  type DocumentDoc,
  type PageLayout,
} from "../models/document";
import { DocumentBlock, type DocumentBlockDoc } from "../models/documentBlock";
import { DocumentPage } from "../models/documentPage";
import { DocumentVersion } from "../models/documentVersion";
import { CommentThread } from "../models/commentThread";
import { Notification } from "../models/notification";
import { CURRENT_SCHEMA_VERSION } from "../migrations/v2";
import { requireAuth } from "../auth/middleware";
import {
  convertInvites,
  memberRole,
  requireDocRole,
  type DocEnv,
  type Role,
} from "../auth/access";
import { publicUser, publicUsers } from "../collab/users";
import { colorFor, presence } from "../collab/presence";
import { maybeAutoSnapshot } from "../collab/versions";
import { purgeTombstones } from "../collab/tombstones";
import {
  CreateDocumentInput,
  SaveContentInput,
  UpdateDocumentInput,
  type SaveContentInputT,
} from "../schemas/documents";
import { PresenceInput } from "../schemas/collab";

export const documents = new Hono<DocEnv>();

documents.use("*", requireAuth);

/** The caller's own and shared documents, newest-updated first. Blocks NOT
 *  included — only a count, computed in Mongo so we don't ship every
 *  blockOrder here. Link-only access never lists a document. */
documents.get("/", async (c) => {
  const session = c.get("session");
  await convertInvites(session.userId, session.email);
  const uid = new Types.ObjectId(session.userId);
  const rows = await DocumentModel.aggregate<ListRow>([
    { $match: { $or: [{ ownerId: uid }, { "members.userId": uid }] } },
    { $sort: { updatedAt: -1 } },
    {
      $project: {
        ownerId: 1,
        members: 1,
        title: 1,
        defaultLayout: 1,
        createdAt: 1,
        updatedAt: 1,
        // Legacy (unmigrated) docs have no blockOrder → 0. blockOrder only
        // names live blocks, never tombstones.
        blockCount: { $size: { $ifNull: ["$blockOrder", []] } },
      },
    },
  ]);
  const owners = await publicUsers(rows.map((r) => r.ownerId));
  return c.json(
    rows.map((r) => ({
      ...toListDocResponse(r),
      role: memberRole(r, session.userId) ?? "viewer",
      owner: publicUser(owners, r.ownerId),
    })),
  );
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
    members: [],
    invites: [],
    link: { enabled: false, role: "viewer", token: null },
    orderRev: 1,
    metaRev: 1,
    commentsVersion: 0,
    diffFloor: 0,
  });

  // A fresh doc has no blocks; the FE's editor starts from an empty list.
  return c.json(
    { ...toMetaResponse(doc.toObject()), blocks: [], role: "owner" satisfies Role },
    201,
  );
});

/** Full document: metadata + every block in order + the caller's role. */
documents.get("/:id", requireDocRole("viewer"), async (c) => {
  return c.json({ ...(await toFullDocResponse(c.get("doc"))), role: c.get("role") });
});

/** Metadata-only update (editor+). Returns DocumentMeta (no blocks). Bumps
 *  `revision` and `metaRev` so other clients pick it up from /changes. */
documents.patch(
  "/:id",
  requireDocRole("editor"),
  vValidator("json", UpdateDocumentInput),
  async (c) => {
    const doc = c.get("doc");
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

    // Pipeline update so the revision bump is atomic with the write. Client
    // values go through $literal: opaque objects (styles, pageSetup) may
    // contain "$"-prefixed keys that would otherwise parse as expressions.
    const next = { $add: [{ $ifNull: ["$revision", 1] }, 1] };
    const literal = Object.fromEntries(
      Object.entries($set).map(([k, v]) => [k, { $literal: v }]),
    );
    const updated = await DocumentModel.findOneAndUpdate(
      { _id: doc._id },
      [{ $set: { ...literal, revision: next, metaRev: next, updatedAt: "$$NOW" } }],
      { new: true, timestamps: false },
    ).lean<DocumentDoc>();
    if (!updated) return c.json({ error: "not_found" }, 404);

    return c.json(toMetaResponse(updated));
  },
);

/** Owner only. Cascades to blocks, legacy pages, versions, comments and
 *  notifications. */
documents.delete("/:id", requireDocRole("owner"), async (c) => {
  const doc = await DocumentModel.findOneAndDelete({ _id: c.get("doc")._id });
  if (!doc) return c.json({ error: "not_found" }, 404);

  // Cascade by hand — Mongoose can't do this across collections without the
  // discontinued cascading-deletes plugin. Legacy pages may still exist
  // (migration leaves them for rollback safety).
  await Promise.all([
    DocumentBlock.deleteMany({ documentId: doc._id }),
    DocumentPage.deleteMany({ documentId: doc._id }),
    DocumentVersion.deleteMany({ documentId: doc._id }),
    CommentThread.deleteMany({ documentId: doc._id }),
    Notification.deleteMany({ documentId: doc._id }),
  ]);
  presence.clear(doc._id.toString());

  return c.body(null, 204);
});

/**
 * Incremental, atomic content save (editor+).
 *
 * Body: `{ baseRevision, upserts, deletes, order? }`. `order` is the full new
 * block order; it may be omitted only when the save edits existing blocks in
 * place (no new ids, no deletes) — otherwise 400 order_required.
 *
 * Block-level merge: a save from a stale `baseRevision` is still applied
 * (`merged: true`) when none of its upserted / deleted blocks were written
 * after baseRevision and, if it carries `order`, the order hasn't changed
 * since either. Otherwise 409 `{ error: "revision_conflict", revision,
 * conflicts }` listing the clashing block ids (and "order").
 *
 * Everything runs in one transaction whose first write is the revision
 * bump, so concurrent saves serialise (write conflict → retry) and any
 * 409 / 400 aborts with nothing persisted.
 */
documents.put(
  "/:id/content",
  requireDocRole("editor"),
  vValidator("json", SaveContentInput),
  async (c) => {
    const doc = c.get("doc");
    const input = c.req.valid("json");

    const invalid = checkContentInput(input);
    if (invalid) return c.json({ error: invalid }, 400);

    try {
      const saved = await saveContent(doc, input);
      await maybeAutoSnapshot(doc._id, c.get("session").userId);
      return c.json({
        revision: saved.revision,
        updatedAt: saved.updatedAt.toISOString(),
        ...(saved.merged ? { merged: true } : {}),
      });
    } catch (err) {
      if (err instanceof ContentSaveError) return c.json(err.body, err.status);
      throw err;
    }
  },
);

/**
 * Everything that changed after revision `since` (viewer+): live blocks
 * written after it, tombstones after it as deletes, the order / meta if they
 * changed, and the comments counter. `reset: true` when `since` is older than
 * the oldest revision we can still diff from (purged tombstones, or deletes
 * from before tombstones existed) — the client should reload.
 */
documents.get("/:id/changes", requireDocRole("viewer"), async (c) => {
  const doc = c.get("doc");
  const raw = c.req.query("since") ?? "";
  if (!/^\d{1,15}$/.test(raw)) return c.json({ error: "invalid_since" }, 400);
  const since = Number(raw);
  const revision = doc.revision ?? 1;
  if (since > revision) return c.json({ error: "since_ahead", revision }, 400);

  const commentsVersion = doc.commentsVersion ?? 0;
  if (since < (doc.diffFloor ?? revision)) {
    return c.json({ revision, reset: true, upserts: [], deletes: [], commentsVersion });
  }

  // Bounded by `revision` so a save landing mid-request shows up whole in
  // the next poll instead of half in this one.
  const rows = since === revision
    ? []
    : await DocumentBlock.find(
        { documentId: doc._id, rev: { $gt: since, $lte: revision } },
        { blockId: 1, type: 1, data: 1, tunes: 1, deleted: 1, rev: 1 },
      )
        .sort({ rev: 1 })
        .lean();

  return c.json({
    revision,
    upserts: rows.filter((r) => !r.deleted).map(toBlockResponse),
    deletes: rows.filter((r) => r.deleted).map((r) => r.blockId),
    ...((doc.orderRev ?? 0) > since ? { order: doc.blockOrder ?? [] } : {}),
    ...((doc.metaRev ?? 0) > since ? { meta: toMetaResponse(doc) } : {}),
    commentsVersion,
  });
});

/** Presence heartbeat (viewer+): returns everyone else on the document. */
documents.post(
  "/:id/presence",
  requireDocRole("viewer"),
  vValidator("json", PresenceInput),
  async (c) => {
    const { state, blockId } = c.req.valid("json");
    const others = presence.heartbeat(
      c.get("doc")._id.toString(),
      c.get("session").userId,
      state,
      blockId,
    );
    const users = await publicUsers(others.map((e) => e.userId));
    return c.json({
      present: others.map((e) => ({
        ...publicUser(users, e.userId),
        state: e.state,
        blockId: e.blockId,
        color: colorFor(e.userId),
        lastSeen: new Date(e.lastSeen).toISOString(),
      })),
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

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

type SavePre = Pick<DocumentDoc, "_id" | "revision" | "orderRev" | "diffFloor">;

/** Block ids (and "order") this stale save would clobber. */
async function findConflicts(
  documentId: Types.ObjectId,
  pre: SavePre,
  input: SaveContentInputT,
  tx: mongoose.ClientSession,
): Promise<string[]> {
  const current = pre.revision ?? 1;
  const ids = [...input.upserts.map((b) => b.id), ...input.deletes];
  const base = input.baseRevision;
  // A base from the future, or older than what we can still diff from
  // (tombstones purged / pre-tombstone deletes): can't prove it's safe.
  if (base > current || base < (pre.diffFloor ?? current)) {
    return [...ids, ...(input.order ? ["order"] : [])];
  }
  const changed: string[] = ids.length
    ? await DocumentBlock.distinct("blockId", {
        documentId,
        blockId: { $in: ids },
        rev: { $gt: base },
      }).session(tx)
    : [];
  const conflicts = ids.filter((id) => changed.includes(id));
  if (input.order && (pre.orderRev ?? 0) > base) conflicts.push("order");
  return conflicts;
}

async function saveContent(
  doc: DocumentDoc,
  input: SaveContentInputT,
): Promise<{ revision: number; updatedAt: Date; merged: boolean }> {
  const documentId = doc._id;
  const upsertIds = input.upserts.map((b) => b.id);
  let result: { revision: number; updatedAt: Date; merged: boolean } | undefined;

  const tx = await mongoose.startSession();
  try {
    // withTransaction retries the callback on transient errors (e.g. a write
    // conflict with a concurrent save), so it must not leak state between
    // attempts — `result` is only assigned on the success path.
    await tx.withTransaction(async () => {
      const updatedAt = new Date();
      // First write: claims the document for this transaction. Returns the
      // pre-image so we know which revision we're building on.
      const pre = await DocumentModel.findOneAndUpdate(
        { _id: documentId },
        { $inc: { revision: 1 }, $set: { updatedAt } },
        {
          session: tx,
          new: false,
          timestamps: false,
          projection: { revision: 1, orderRev: 1, diffFloor: 1 },
        },
      ).lean<SavePre>();
      if (!pre) throw new ContentSaveError(404, { error: "not_found" });
      const current = pre.revision ?? 1;
      const rev = current + 1;

      let merged = false;
      if (input.baseRevision !== current) {
        const conflicts = await findConflicts(documentId, pre, input, tx);
        if (conflicts.length > 0) {
          throw new ContentSaveError(409, {
            error: "revision_conflict",
            revision: current,
            conflicts,
          });
        }
        merged = true;
      }

      // Without `order`, the live block set must not change: every upsert
      // has to be an edit of a block that exists (and isn't a tombstone).
      if (!input.order && upsertIds.length > 0) {
        const existing = await DocumentBlock.countDocuments({
          documentId,
          blockId: { $in: upsertIds },
          deleted: { $ne: true },
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

      if (input.deletes.length > 0) {
        await DocumentBlock.updateMany(
          { documentId, blockId: { $in: input.deletes }, deleted: { $ne: true } },
          { $set: { deleted: true, rev, data: {}, tunes: null } },
          { session: tx },
        );
      }

      // `order` must name exactly the live blocks after this save.
      if (input.order) {
        const actual: string[] = await DocumentBlock.distinct("blockId", {
          documentId,
          deleted: { $ne: true },
        }).session(tx);
        if (!sameSet(actual, input.order)) {
          throw new ContentSaveError(400, { error: "order_mismatch" });
        }
        await DocumentModel.updateOne(
          { _id: documentId },
          { $set: { blockOrder: input.order, orderRev: rev } },
          { session: tx, timestamps: false },
        );
      }

      await purgeTombstones(documentId, rev, pre.diffFloor, tx);

      result = { revision: rev, updatedAt, merged };
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

interface ListRow extends Pick<DocumentDoc, "ownerId" | "members"> {
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

export function toMetaResponse(doc: DocumentDoc) {
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
    { documentId: doc._id, deleted: { $ne: true } },
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

export function toBlockResponse(
  b: Pick<DocumentBlockDoc, "blockId" | "type" | "data" | "tunes">,
) {
  return {
    id: b.blockId,
    type: b.type,
    data: b.data ?? {},
    ...(b.tunes ? { tunes: b.tunes } : {}),
  };
}
