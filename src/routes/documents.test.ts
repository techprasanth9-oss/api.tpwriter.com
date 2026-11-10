import { describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { createApp } from "../app";
import { SESSION_COOKIE, signSession } from "../auth/jwt";
import { DocumentModel } from "../models/document";
import { DocumentBlock } from "../models/documentBlock";
import { DocumentPage } from "../models/documentPage";
import { BLOCK_ID_RE } from "../schemas/documents";

const app = createApp();

// requireAuth only verifies the JWT, so users don't need User rows.
const alice = new Types.ObjectId().toString();
const bob = new Types.ObjectId().toString();

async function api(
  userId: string,
  method: string,
  path: string,
  body?: unknown,
) {
  const token = signSession({ userId, email: `${userId}@test.local` });
  const res = await app.request(path, {
    method,
    headers: {
      Cookie: `${SESSION_COOKIE}=${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json: any = res.status === 204 ? null : await res.json();
  return { status: res.status, body: json };
}

async function createDoc(userId = alice, title = "Doc") {
  const res = await api(userId, "POST", "/documents", { title });
  expect(res.status).toBe(201);
  return res.body as { id: string; revision: number };
}

const para = (id: string, text: string) => ({
  id,
  type: "paragraph",
  data: { text },
});

describe("documents v2", () => {
  it("creates a doc and reads it back empty at revision 1", async () => {
    const created = await createDoc();
    expect(created).toMatchObject({
      title: "Doc",
      revision: 1,
      blocks: [],
      styles: {},
      headerBlocks: [],
      footerBlocks: [],
    });

    const got = await api(alice, "GET", `/documents/${created.id}`);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ id: created.id, revision: 1, blocks: [] });
    expect(got.body.defaultLayout.paperSize).toBe("A4");

    const stored = await DocumentModel.findById(created.id).lean();
    expect(stored?.schemaVersion).toBe(2);

    const list = await api(alice, "GET", "/documents");
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ id: created.id, blockCount: 0 });
    expect(list.body[0].blocks).toBeUndefined();
  });

  it("saves content incrementally and GET reflects it in order", async () => {
    const { id } = await createDoc();

    // Insert two blocks (new ids → order required).
    const s1 = await api(alice, "PUT", `/documents/${id}/content`, {
      baseRevision: 1,
      upserts: [para("b", "second"), para("a", "first")],
      deletes: [],
      order: ["a", "b"],
    });
    expect(s1.status).toBe(200);
    expect(s1.body.revision).toBe(2);
    expect(typeof s1.body.updatedAt).toBe("string");

    // Edit one in place — no order needed. data: null normalises to {}.
    const s2 = await api(alice, "PUT", `/documents/${id}/content`, {
      baseRevision: 2,
      upserts: [{ id: "a", type: "header", data: { text: "Title", level: 1 }, tunes: { align: "center" } }],
      deletes: [],
    });
    expect(s2.status).toBe(200);
    expect(s2.body.revision).toBe(3);

    let got = await api(alice, "GET", `/documents/${id}`);
    expect(got.body.revision).toBe(3);
    expect(got.body.blocks).toEqual([
      { id: "a", type: "header", data: { text: "Title", level: 1 }, tunes: { align: "center" } },
      { id: "b", type: "paragraph", data: { text: "second" }, tunes: {} },
    ]);

    // Add one at the front, delete another.
    const s3 = await api(alice, "PUT", `/documents/${id}/content`, {
      baseRevision: 3,
      upserts: [{ id: "c", type: "paragraph", data: null }],
      deletes: ["a"],
      order: ["c", "b"],
    });
    expect(s3.status).toBe(200);
    expect(s3.body.revision).toBe(4);

    got = await api(alice, "GET", `/documents/${id}`);
    expect(got.body.blocks.map((b: { id: string }) => b.id)).toEqual(["c", "b"]);
    expect(got.body.blocks[0].data).toEqual({});
    expect(await DocumentBlock.countDocuments({ documentId: id })).toBe(2);

    // Pure reorder.
    const s4 = await api(alice, "PUT", `/documents/${id}/content`, {
      baseRevision: 4,
      upserts: [],
      deletes: [],
      order: ["b", "c"],
    });
    expect(s4.status).toBe(200);
    got = await api(alice, "GET", `/documents/${id}`);
    expect(got.body.blocks.map((b: { id: string }) => b.id)).toEqual(["b", "c"]);

    const list = await api(alice, "GET", "/documents");
    expect(list.body[0].blockCount).toBe(2);
  });

  it("rejects a stale baseRevision with 409 and leaves the revision alone", async () => {
    const { id } = await createDoc();
    await api(alice, "PUT", `/documents/${id}/content`, {
      baseRevision: 1,
      upserts: [para("a", "v1")],
      deletes: [],
      order: ["a"],
    });

    const stale = await api(alice, "PUT", `/documents/${id}/content`, {
      baseRevision: 1,
      upserts: [para("a", "clobber")],
      deletes: [],
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ error: "revision_conflict", revision: 2 });

    const got = await api(alice, "GET", `/documents/${id}`);
    expect(got.body.revision).toBe(2);
    expect(got.body.blocks[0].data.text).toBe("v1");
  });

  it("order_mismatch aborts the transaction (no data or revision change)", async () => {
    const { id } = await createDoc();
    await api(alice, "PUT", `/documents/${id}/content`, {
      baseRevision: 1,
      upserts: [para("a", "A"), para("b", "B")],
      deletes: [],
      order: ["a", "b"],
    });

    // Upserts c + edits a, but order forgets c → mismatch after writes.
    const bad = await api(alice, "PUT", `/documents/${id}/content`, {
      baseRevision: 2,
      upserts: [para("c", "C"), para("a", "A edited")],
      deletes: [],
      order: ["a", "b"],
    });
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: "order_mismatch" });

    // Duplicate ids in order.
    const dup = await api(alice, "PUT", `/documents/${id}/content`, {
      baseRevision: 2,
      upserts: [],
      deletes: [],
      order: ["a", "a"],
    });
    expect(dup.status).toBe(400);
    expect(dup.body).toEqual({ error: "order_mismatch" });

    const got = await api(alice, "GET", `/documents/${id}`);
    expect(got.body.revision).toBe(2);
    expect(got.body.blocks).toEqual([
      { id: "a", type: "paragraph", data: { text: "A" }, tunes: {} },
      { id: "b", type: "paragraph", data: { text: "B" }, tunes: {} },
    ]);
    expect(await DocumentBlock.countDocuments({ documentId: id })).toBe(2);
  });

  it("order_required aborts the transaction (no data or revision change)", async () => {
    const { id } = await createDoc();
    await api(alice, "PUT", `/documents/${id}/content`, {
      baseRevision: 1,
      upserts: [para("a", "A")],
      deletes: [],
      order: ["a"],
    });

    // New block id without order: detected inside the transaction, after the
    // revision bump — so a 400 here proves the bump was rolled back.
    const add = await api(alice, "PUT", `/documents/${id}/content`, {
      baseRevision: 2,
      upserts: [para("a", "A edited"), para("new", "N")],
      deletes: [],
    });
    expect(add.status).toBe(400);
    expect(add.body).toEqual({ error: "order_required" });

    const del = await api(alice, "PUT", `/documents/${id}/content`, {
      baseRevision: 2,
      upserts: [],
      deletes: ["a"],
    });
    expect(del.status).toBe(400);
    expect(del.body).toEqual({ error: "order_required" });

    const got = await api(alice, "GET", `/documents/${id}`);
    expect(got.body.revision).toBe(2);
    expect(got.body.blocks).toEqual([
      { id: "a", type: "paragraph", data: { text: "A" }, tunes: {} },
    ]);
    expect(await DocumentBlock.countDocuments({ documentId: id })).toBe(1);
  });

  it("validates block ids and upsert/delete consistency", async () => {
    const { id } = await createDoc();
    const badId = await api(alice, "PUT", `/documents/${id}/content`, {
      baseRevision: 1,
      upserts: [para("has space", "x")],
      deletes: [],
      order: ["has space"],
    });
    expect(badId.status).toBe(400);

    const dup = await api(alice, "PUT", `/documents/${id}/content`, {
      baseRevision: 1,
      upserts: [para("a", "1"), para("a", "2")],
      deletes: [],
      order: ["a"],
    });
    expect(dup.body).toEqual({ error: "duplicate_block_id" });

    const overlap = await api(alice, "PUT", `/documents/${id}/content`, {
      baseRevision: 1,
      upserts: [para("a", "1")],
      deletes: ["a"],
      order: [],
    });
    expect(overlap.body).toEqual({ error: "upsert_delete_overlap" });
  });

  it("returns 404 to another user on every route", async () => {
    const { id } = await createDoc(alice);

    expect((await api(bob, "GET", `/documents/${id}`)).status).toBe(404);
    expect(
      (await api(bob, "PATCH", `/documents/${id}`, { title: "pwned" })).status,
    ).toBe(404);
    const put = await api(bob, "PUT", `/documents/${id}/content`, {
      baseRevision: 1,
      upserts: [para("a", "x")],
      deletes: [],
      order: ["a"],
    });
    expect(put.status).toBe(404);
    expect(put.body).toEqual({ error: "not_found" });
    expect((await api(bob, "DELETE", `/documents/${id}`)).status).toBe(404);
    expect((await api(bob, "GET", "/documents")).body).toEqual([]);

    const got = await api(alice, "GET", `/documents/${id}`);
    expect(got.body).toMatchObject({ title: "Doc", revision: 1, blocks: [] });
  });

  it("PATCH returns meta without blocks and keeps the revision", async () => {
    const { id } = await createDoc();
    await api(alice, "PUT", `/documents/${id}/content`, {
      baseRevision: 1,
      upserts: [para("a", "A")],
      deletes: [],
      order: ["a"],
    });

    const res = await api(alice, "PATCH", `/documents/${id}`, {
      title: "Renamed",
      defaultLayout: { orientation: "landscape" },
      styles: { heading1: { fontSize: 32 } },
      headerBlocks: [para("h", "Header")],
    });
    expect(res.status).toBe(200);
    expect(res.body.blocks).toBeUndefined();
    expect(res.body.pages).toBeUndefined();
    expect(res.body).toMatchObject({
      id,
      title: "Renamed",
      revision: 2,
      styles: { heading1: { fontSize: 32 } },
      headerBlocks: [para("h", "Header")],
    });
    // Partial layout patch merges onto the existing layout.
    expect(res.body.defaultLayout).toMatchObject({
      paperSize: "A4",
      orientation: "landscape",
      marginTop: 96,
    });
    expect(Object.keys(res.body).sort()).toEqual(
      [
        "createdAt",
        "defaultLayout",
        "footerBlocks",
        "headerBlocks",
        "id",
        "revision",
        "styles",
        "title",
        "updatedAt",
      ].sort(),
    );
  });

  it("lazily migrates a legacy doc on GET, idempotently", async () => {
    const ownerId = new Types.ObjectId(alice);
    // Insert raw so no v2 fields (schemaVersion, revision, blockOrder) exist.
    const legacyId = new Types.ObjectId();
    const page0 = new Types.ObjectId();
    const page1 = new Types.ObjectId();
    await DocumentModel.collection.insertOne({
      _id: legacyId,
      ownerId,
      title: "Legacy",
      pageIds: [page0, page1],
      defaultLayout: {
        paperSize: "LETTER",
        orientation: "portrait",
        marginTop: 96,
        marginRight: 96,
        marginBottom: 96,
        marginLeft: 96,
      },
      headerBlocks: [],
      footerBlocks: [],
      createdAt: new Date("2025-01-01"),
      updatedAt: new Date("2025-01-02"),
    });
    await DocumentPage.create([
      {
        _id: page1,
        documentId: legacyId,
        ownerId,
        pageIndex: 1,
        content: {
          blocks: [
            { id: "dup", type: "paragraph", data: { text: "p1-dup" } },
            { type: "paragraph", data: { text: "p1-noid" } },
          ],
        },
        layoutOverride: { orientation: "landscape" },
      },
      {
        _id: page0,
        documentId: legacyId,
        ownerId,
        pageIndex: 0,
        content: {
          blocks: [
            { id: "dup", type: "header", data: { text: "p0-dup", level: 2 } },
            { id: "bad id!", type: "paragraph", data: { text: "p0-badid" } },
          ],
        },
        layoutOverride: null,
      },
    ]);

    const list = await api(alice, "GET", "/documents");
    expect(list.body[0]).toMatchObject({ id: String(legacyId), blockCount: 0 });

    // Two concurrent first reads must not double-insert.
    const [g1, g2] = await Promise.all([
      api(alice, "GET", `/documents/${legacyId}`),
      api(alice, "GET", `/documents/${legacyId}`),
    ]);
    expect(g1.status).toBe(200);
    expect(g2.status).toBe(200);
    expect(g1.body.revision).toBe(1);
    expect(g1.body.defaultLayout.paperSize).toBe("LETTER");
    expect(g1.body.blocks.map((b: { data: { text: string } }) => b.data.text)).toEqual([
      "p0-dup",
      "p0-badid",
      "p1-dup",
      "p1-noid",
    ]);
    const ids = g1.body.blocks.map((b: { id: string }) => b.id);
    expect(new Set(ids).size).toBe(4);
    expect(ids[0]).toBe("dup"); // first valid occurrence keeps its id
    for (const bid of ids) expect(bid).toMatch(BLOCK_ID_RE);
    expect(g2.body.blocks).toEqual(g1.body.blocks);

    const again = await api(alice, "GET", `/documents/${legacyId}`);
    expect(again.body.blocks).toEqual(g1.body.blocks);
    expect(again.body.revision).toBe(1);
    expect(await DocumentBlock.countDocuments({ documentId: legacyId })).toBe(4);

    const stored = await DocumentModel.findById(legacyId).lean();
    expect(stored?.schemaVersion).toBe(2);
    expect(stored?.blockOrder).toEqual(ids);
    // Legacy pages left in place for rollback.
    expect(await DocumentPage.countDocuments({ documentId: legacyId })).toBe(2);

    // And it's editable as a normal v2 doc now.
    const save = await api(alice, "PUT", `/documents/${legacyId}/content`, {
      baseRevision: 1,
      upserts: [{ ...g1.body.blocks[1], data: { text: "edited" } }],
      deletes: [],
    });
    expect(save.status).toBe(200);
    expect(save.body.revision).toBe(2);
  });

  it("DELETE removes the doc, its blocks and legacy pages", async () => {
    const { id } = await createDoc();
    await api(alice, "PUT", `/documents/${id}/content`, {
      baseRevision: 1,
      upserts: [para("a", "A"), para("b", "B")],
      deletes: [],
      order: ["a", "b"],
    });
    await DocumentPage.create({
      documentId: id,
      ownerId: alice,
      pageIndex: 0,
      content: { blocks: [] },
    });

    const del = await api(alice, "DELETE", `/documents/${id}`);
    expect(del.status).toBe(204);
    expect(await DocumentModel.countDocuments({ _id: id })).toBe(0);
    expect(await DocumentBlock.countDocuments({ documentId: id })).toBe(0);
    expect(await DocumentPage.countDocuments({ documentId: id })).toBe(0);
    expect((await api(alice, "GET", `/documents/${id}`)).status).toBe(404);
  });
});
