import { Hono } from "hono";
import { vValidator } from "@hono/valibot-validator";
import { Types, isValidObjectId } from "mongoose";
import {
  DEFAULT_LAYOUT,
  DocumentModel,
  type DocumentDoc,
} from "../models/document";
import { DocumentPage } from "../models/documentPage";
import { requireAuth, type AuthContext } from "../auth/middleware";
import {
  CreateDocumentInput,
  ReorderPagesInput,
  UpdateDocumentInput,
  UpsertPageInput,
} from "../schemas/documents";

export const documents = new Hono<AuthContext>();

documents.use("*", requireAuth);

/** List this user's documents, newest-updated first. Pages NOT included. */
documents.get("/", async (c) => {
  const session = c.get("session");
  const rows = await DocumentModel.find(
    { ownerId: session.userId },
    { title: 1, pageIds: 1, defaultLayout: 1, createdAt: 1, updatedAt: 1 },
  )
    .sort({ updatedAt: -1 })
    .lean();
  return c.json(rows.map(toListDocResponse));
});

documents.post("/", vValidator("json", CreateDocumentInput), async (c) => {
  const session = c.get("session");
  const input = c.req.valid("json");
  const ownerId = new Types.ObjectId(session.userId);

  // Create document + first blank page in one go so the client doesn't need
  // a two-call dance just to have somewhere to type.
  const doc = await DocumentModel.create({
    ownerId,
    title: input.title,
    defaultLayout: { ...DEFAULT_LAYOUT, ...(input.defaultLayout ?? {}) },
    pageIds: [],
  });

  const page = await DocumentPage.create({
    documentId: doc._id,
    ownerId,
    pageIndex: 0,
    content: { blocks: [] },
    layoutOverride: null,
  });

  doc.pageIds = [page._id];
  await doc.save();

  return c.json(await toFullDocResponse(doc), 201);
});

/** Full document: metadata + ordered pages (content included). */
documents.get("/:id", async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");
  if (!isValidObjectId(id)) return c.json({ error: "not_found" }, 404);

  const doc = await DocumentModel.findOne({
    _id: id,
    ownerId: session.userId,
  });
  if (!doc) return c.json({ error: "not_found" }, 404);

  return c.json(await toFullDocResponse(doc));
});

documents.patch(
  "/:id",
  vValidator("json", UpdateDocumentInput),
  async (c) => {
    const session = c.get("session");
    const id = c.req.param("id");
    if (!isValidObjectId(id)) return c.json({ error: "not_found" }, 404);
    const patch = c.req.valid("json");

    const doc = await DocumentModel.findOne({
      _id: id,
      ownerId: session.userId,
    });
    if (!doc) return c.json({ error: "not_found" }, 404);

    if (patch.title !== undefined) doc.title = patch.title;
    if (patch.defaultLayout !== undefined) {
      doc.defaultLayout = { ...doc.defaultLayout, ...patch.defaultLayout };
    }
    if (patch.headerBlocks !== undefined) doc.headerBlocks = patch.headerBlocks;
    if (patch.footerBlocks !== undefined) doc.footerBlocks = patch.footerBlocks;
    await doc.save();

    return c.json(await toFullDocResponse(doc));
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

  // Cascade-delete pages — Mongoose can't do this automatically across
  // collections without the discontinued cascading-deletes plugin.
  await DocumentPage.deleteMany({ documentId: doc._id });

  return c.body(null, 204);
});

/** Reorder pages. Body is the new pageIds order; must contain exactly the
 *  current set — no adds / removes here (use the per-page add/delete). */
documents.post(
  "/:id/pages/reorder",
  vValidator("json", ReorderPagesInput),
  async (c) => {
    const session = c.get("session");
    const id = c.req.param("id");
    if (!isValidObjectId(id)) return c.json({ error: "not_found" }, 404);
    const { pageIds: nextOrder } = c.req.valid("json");

    const doc = await DocumentModel.findOne({
      _id: id,
      ownerId: session.userId,
    });
    if (!doc) return c.json({ error: "not_found" }, 404);

    const current = doc.pageIds.map((p) => p.toString()).sort();
    const incoming = [...nextOrder].sort();
    if (
      current.length !== incoming.length ||
      !current.every((v, i) => v === incoming[i])
    ) {
      return c.json({ error: "page_set_mismatch" }, 400);
    }

    doc.pageIds = nextOrder.map((id) => new Types.ObjectId(id));
    await doc.save();

    // Rewrite pageIndex on every page so lookups-by-index stay correct.
    await Promise.all(
      nextOrder.map((pageId, idx) =>
        DocumentPage.updateOne(
          { _id: pageId, documentId: doc._id },
          { $set: { pageIndex: idx } },
        ),
      ),
    );

    return c.json(await toFullDocResponse(doc));
  },
);

/** Add a blank page at the end. Returns the full doc with new page_ids. */
documents.post("/:id/pages", async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");
  if (!isValidObjectId(id)) return c.json({ error: "not_found" }, 404);

  const doc = await DocumentModel.findOne({
    _id: id,
    ownerId: session.userId,
  });
  if (!doc) return c.json({ error: "not_found" }, 404);

  const page = await DocumentPage.create({
    documentId: doc._id,
    ownerId: doc.ownerId,
    pageIndex: doc.pageIds.length,
    content: { blocks: [] },
    layoutOverride: null,
  });
  doc.pageIds.push(page._id);
  await doc.save();

  return c.json(await toFullDocResponse(doc), 201);
});

/** Update (or create at a specific index) a page's content + layout.
 *  Use the pageId in the URL — mapping index→id lives on the parent doc. */
documents.put(
  "/:id/pages/:pageId",
  vValidator("json", UpsertPageInput),
  async (c) => {
    const session = c.get("session");
    const id = c.req.param("id");
    const pageId = c.req.param("pageId");
    if (!isValidObjectId(id) || !isValidObjectId(pageId)) {
      return c.json({ error: "not_found" }, 404);
    }

    // Ownership check through the parent doc.
    const parent = await DocumentModel.findOne({
      _id: id,
      ownerId: session.userId,
      pageIds: pageId,
    }).select({ _id: 1 });
    if (!parent) return c.json({ error: "not_found" }, 404);

    const patch = c.req.valid("json");
    const page = await DocumentPage.findOneAndUpdate(
      { _id: pageId, documentId: id },
      { $set: { content: patch.content, layoutOverride: patch.layoutOverride } },
      { new: true },
    );
    if (!page) return c.json({ error: "not_found" }, 404);

    // Touch the parent so list ordering reflects the edit.
    await DocumentModel.updateOne({ _id: id }, { $currentDate: { updatedAt: true } });

    return c.json(toPageResponse(page.toObject()));
  },
);

documents.delete("/:id/pages/:pageId", async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");
  const pageId = c.req.param("pageId");
  if (!isValidObjectId(id) || !isValidObjectId(pageId)) {
    return c.json({ error: "not_found" }, 404);
  }

  const doc = await DocumentModel.findOne({
    _id: id,
    ownerId: session.userId,
  });
  if (!doc) return c.json({ error: "not_found" }, 404);

  if (doc.pageIds.length <= 1) {
    return c.json({ error: "cannot_delete_last_page" }, 400);
  }

  const stillHasPage = doc.pageIds.some((p) => p.toString() === pageId);
  if (!stillHasPage) return c.json({ error: "not_found" }, 404);

  doc.pageIds = doc.pageIds.filter((p) => p.toString() !== pageId);
  await doc.save();
  await DocumentPage.deleteOne({ _id: pageId, documentId: id });

  // Re-pack pageIndex on the remaining pages.
  await Promise.all(
    doc.pageIds.map((pid, idx) =>
      DocumentPage.updateOne(
        { _id: pid, documentId: id },
        { $set: { pageIndex: idx } },
      ),
    ),
  );

  return c.body(null, 204);
});

// ─────────────────────────────────────────────────────────────────────────────
// Response serialisers — one place to control what we expose to clients.
// ─────────────────────────────────────────────────────────────────────────────

function toListDocResponse(d: {
  _id: unknown;
  title: string;
  pageIds: unknown[];
  defaultLayout: unknown;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: String(d._id),
    title: d.title,
    pageCount: d.pageIds.length,
    defaultLayout: d.defaultLayout,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

async function toFullDocResponse(doc: DocumentDoc) {
  const pages = await DocumentPage.find({ documentId: doc._id })
    .sort({ pageIndex: 1 })
    .lean();
  return {
    id: doc._id.toString(),
    title: doc.title,
    defaultLayout: doc.defaultLayout,
    headerBlocks: doc.headerBlocks,
    footerBlocks: doc.footerBlocks,
    pageIds: doc.pageIds.map((p) => p.toString()),
    pages: pages.map(toPageResponse),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

function toPageResponse(p: {
  _id: unknown;
  pageIndex: number;
  content: unknown;
  layoutOverride: unknown;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: String(p._id),
    pageIndex: p.pageIndex,
    content: p.content,
    layoutOverride: p.layoutOverride,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}
