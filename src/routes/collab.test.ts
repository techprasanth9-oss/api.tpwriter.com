import { describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { DocumentModel } from "../models/document";
import { DocumentBlock } from "../models/documentBlock";
import { TOMBSTONE_KEEP_REVISIONS } from "../collab/tombstones";
import { api, createDoc, makeUser, para, seed, type Actor } from "../test/helpers";

const save = (a: Actor, id: string, body: object) => api(a, "PUT", `/documents/${id}/content`, body);
const changes = (a: Actor, id: string, since: number) => api(a, "GET", `/documents/${id}/changes?since=${since}`);
const ids = (blocks: { id: string }[]) => blocks.map((b) => b.id);

describe("block-level merge", () => {
  it("merges non-overlapping saves from the same base revision", async () => {
    const alice = await makeUser();
    const id = await createDoc(alice);
    const base = await seed(alice, id, ["a", "b", "c"]); // rev 2

    // Two clients, both at `base`, editing different blocks.
    const first = await save(alice, id, { baseRevision: base, upserts: [para("a", "A by 1")], deletes: [] });
    expect(first.status).toBe(200);
    expect(first.body.revision).toBe(base + 1);
    expect(first.body.merged).toBeUndefined();

    const second = await save(alice, id, { baseRevision: base, upserts: [para("b", "B by 2")], deletes: [] });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ revision: base + 2, merged: true });

    // A stale reorder-free delete is also mergeable when order is unchanged.
    const third = await save(alice, id, { baseRevision: base, upserts: [], deletes: ["c"], order: ["a", "b"] });
    expect(third.status).toBe(200);
    expect(third.body).toMatchObject({ revision: base + 3, merged: true });

    const got = await api(alice, "GET", `/documents/${id}`);
    expect(got.body.blocks).toEqual([
      { id: "a", type: "paragraph", data: { text: "A by 1" }, tunes: {} },
      { id: "b", type: "paragraph", data: { text: "B by 2" }, tunes: {} },
    ]);
    expect(got.body.revision).toBe(base + 3);
  });

  it("serialises truly concurrent saves and merges them", async () => {
    const alice = await makeUser();
    const id = await createDoc(alice);
    const base = await seed(alice, id, ["a", "b", "c", "d"]);
    const results = await Promise.all(
      ["a", "b", "c", "d"].map((b) => save(alice, id, { baseRevision: base, upserts: [para(b, `${b}!`)], deletes: [] })),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(results.map((r) => r.body.revision).sort()).toEqual([base + 1, base + 2, base + 3, base + 4]);
    expect(results.filter((r) => r.body.merged).length).toBe(3);
    const got = await api(alice, "GET", `/documents/${id}`);
    expect(got.body.blocks.map((b: any) => b.data.text)).toEqual(["a!", "b!", "c!", "d!"]);
  });

  it("409s with the clashing block ids when the same block changed", async () => {
    const alice = await makeUser();
    const id = await createDoc(alice);
    const base = await seed(alice, id, ["a", "b", "c"]);

    await save(alice, id, { baseRevision: base, upserts: [para("a", "mine")], deletes: [] });
    await save(alice, id, { baseRevision: base + 1, upserts: [], deletes: ["c"], order: ["a", "b"] });

    const clash = await save(alice, id, {
      baseRevision: base,
      upserts: [para("a", "theirs"), para("b", "fine"), para("c", "resurrect")],
      deletes: [],
    });
    expect(clash.status).toBe(409);
    expect(clash.body).toEqual({ error: "revision_conflict", revision: base + 2, conflicts: ["a", "c"] });

    // Nothing from the rejected save landed.
    const got = await api(alice, "GET", `/documents/${id}`);
    expect(got.body.revision).toBe(base + 2);
    expect(got.body.blocks.map((b: any) => b.data.text)).toEqual(["mine", "B"]);
  });

  it("409s on order when both sides changed the order", async () => {
    const alice = await makeUser();
    const id = await createDoc(alice);
    const base = await seed(alice, id, ["a", "b"]);

    const ins1 = await save(alice, id, { baseRevision: base, upserts: [para("x", "X")], deletes: [], order: ["a", "x", "b"] });
    expect(ins1.status).toBe(200);
    const ins2 = await save(alice, id, { baseRevision: base, upserts: [para("y", "Y")], deletes: [], order: ["a", "b", "y"] });
    expect(ins2.status).toBe(409);
    expect(ins2.body).toEqual({ error: "revision_conflict", revision: base + 1, conflicts: ["order"] });

    // An in-place edit that sends no order still merges.
    const edit = await save(alice, id, { baseRevision: base, upserts: [para("b", "B2")], deletes: [] });
    expect(edit.body).toMatchObject({ merged: true });
  });

  it("validates order against live blocks, ignoring tombstones", async () => {
    const alice = await makeUser();
    const id = await createDoc(alice);
    let rev = await seed(alice, id, ["a", "b"]);
    rev = (await save(alice, id, { baseRevision: rev, upserts: [], deletes: ["b"], order: ["a"] })).body.revision;

    const ghost = await save(alice, id, { baseRevision: rev, upserts: [], deletes: [], order: ["a", "b"] });
    expect(ghost.body).toEqual({ error: "order_mismatch" });
    // Editing a tombstone in place is adding a block → needs order.
    const inPlace = await save(alice, id, { baseRevision: rev, upserts: [para("b", "back")], deletes: [] });
    expect(inPlace.body).toEqual({ error: "order_required" });
    // Re-adding it with order revives it.
    const revive = await save(alice, id, { baseRevision: rev, upserts: [para("b", "back")], deletes: [], order: ["b", "a"] });
    expect(revive.status).toBe(200);
    const got = await api(alice, "GET", `/documents/${id}`);
    expect(ids(got.body.blocks)).toEqual(["b", "a"]);
    expect((await api(alice, "GET", "/documents")).body[0].blockCount).toBe(2);
  });

  it("a PATCH between saves doesn't conflict with a content save", async () => {
    const alice = await makeUser();
    const id = await createDoc(alice);
    const base = await seed(alice, id, ["a"]);
    const patched = await api(alice, "PATCH", `/documents/${id}`, { title: "New" });
    expect(patched.body.revision).toBe(base + 1);
    const res = await save(alice, id, { baseRevision: base, upserts: [para("a", "x")], deletes: [], order: ["a"] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ revision: base + 2, merged: true });
  });
});

describe("changes feed", () => {
  it("reports upserts, deletes, order, meta and commentsVersion after R", async () => {
    const alice = await makeUser();
    const id = await createDoc(alice);
    const r2 = await seed(alice, id, ["a", "b", "c"]);

    const none = await changes(alice, id, r2);
    expect(none.body).toEqual({ revision: r2, upserts: [], deletes: [], commentsVersion: 0 });

    const r3 = (await save(alice, id, { baseRevision: r2, upserts: [para("a", "A2")], deletes: [] })).body.revision;
    const r4 = (await save(alice, id, { baseRevision: r3, upserts: [para("d", "D")], deletes: ["b"], order: ["d", "a", "c"] })).body.revision;
    const r5 = (await api(alice, "PATCH", `/documents/${id}`, { title: "Retitled", styles: { $weird: { a: 1 } } })).body.revision;
    expect(r5).toBe(r4 + 1);

    const since3 = await changes(alice, id, r3);
    expect(since3.status).toBe(200);
    expect(since3.body).toMatchObject({
      revision: r5,
      upserts: [{ id: "d", type: "paragraph", data: { text: "D" }, tunes: {} }],
      deletes: ["b"],
      order: ["d", "a", "c"],
      commentsVersion: 0,
    });
    expect(since3.body.meta).toMatchObject({ id, title: "Retitled", revision: r5, styles: { $weird: { a: 1 } } });

    const since2 = await changes(alice, id, r2);
    expect(ids(since2.body.upserts).sort()).toEqual(["a", "d"]);

    const since4 = await changes(alice, id, r4);
    expect(since4.body.upserts).toEqual([]);
    expect(since4.body.order).toBeUndefined();
    expect(since4.body.meta.title).toBe("Retitled");

    await api(alice, "POST", `/documents/${id}/comments`, {
      anchor: { blockId: "a", quote: "A", prefix: "", suffix: "" },
      body: "note",
    });
    expect((await changes(alice, id, r5)).body).toEqual({
      revision: r5,
      upserts: [],
      deletes: [],
      commentsVersion: 1,
    });
  });

  it("validates since", async () => {
    const alice = await makeUser();
    const id = await createDoc(alice);
    expect((await changes(alice, id, 2)).body).toEqual({ error: "since_ahead", revision: 1 });
    for (const q of ["", "-1", "abc", "1.5"]) {
      expect((await api(alice, "GET", `/documents/${id}/changes?since=${q}`)).status).toBe(400);
    }
    // A brand-new doc can be diffed from 0: everything set at revision 1.
    expect((await changes(alice, id, 0)).body).toMatchObject({
      revision: 1,
      upserts: [],
      deletes: [],
      order: [],
      meta: { id, title: "Doc", revision: 1 },
      commentsVersion: 0,
    });
  });

  it("answers reset once tombstones older than R are purged", async () => {
    const alice = await makeUser();
    const id = await createDoc(alice);
    let rev = await seed(alice, id, ["a", "b"]);
    rev = (await save(alice, id, { baseRevision: rev, upserts: [], deletes: ["b"], order: ["a"] })).body.revision;
    const deletedAt = rev;

    // Jump the revision far ahead instead of making 500 saves.
    const far = deletedAt + TOMBSTONE_KEEP_REVISIONS + 10;
    await DocumentModel.updateOne({ _id: id }, { $set: { revision: far } });
    const next = await save(alice, id, { baseRevision: far, upserts: [para("a", "x")], deletes: [] });
    expect(next.status).toBe(200);

    expect(await DocumentBlock.countDocuments({ documentId: id, deleted: true })).toBe(0);
    const floor = (await DocumentModel.findById(id).lean())!.diffFloor!;
    expect(floor).toBe(far + 1 - TOMBSTONE_KEEP_REVISIONS);

    expect((await changes(alice, id, deletedAt - 1)).body).toEqual({
      revision: far + 1,
      reset: true,
      upserts: [],
      deletes: [],
      commentsVersion: 0,
    });
    expect((await changes(alice, id, floor)).body.reset).toBeUndefined();
    // A save from before the floor can't be proven safe.
    const stale = await save(alice, id, { baseRevision: deletedAt, upserts: [para("a", "old")], deletes: [] });
    expect(stale.status).toBe(409);
    expect(stale.body.conflicts).toEqual(["a"]);
  });
});

describe("pre-Phase-6 v2 documents", () => {
  async function legacyV2(owner: Actor) {
    const _id = new Types.ObjectId();
    const ownerId = new Types.ObjectId(owner.id);
    // As written before Phase 6: no members/link/orderRev/metaRev/
    // commentsVersion/diffFloor, blocks without rev/deleted.
    await DocumentModel.collection.insertOne({
      _id,
      ownerId,
      title: "Old v2",
      schemaVersion: 2,
      revision: 5,
      blockOrder: ["a", "b"],
      styles: {},
      pageSetup: {},
      defaultLayout: { paperSize: "A4", orientation: "portrait", marginTop: 96, marginRight: 96, marginBottom: 96, marginLeft: 96 },
      headerBlocks: [],
      footerBlocks: [],
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-02"),
    });
    await DocumentBlock.collection.insertMany([
      { documentId: _id, ownerId, blockId: "a", type: "paragraph", data: { text: "A" }, tunes: null },
      { documentId: _id, ownerId, blockId: "b", type: "paragraph", data: { text: "B" }, tunes: null },
    ]);
    return _id.toString();
  }

  it("load, list, diff, save and comment", async () => {
    const alice = await makeUser();
    const id = await legacyV2(alice);

    const list = await api(alice, "GET", "/documents");
    expect(list.body[0]).toMatchObject({ id, role: "owner", blockCount: 2 });

    const got = await api(alice, "GET", `/documents/${id}`);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ revision: 5, role: "owner" });
    expect(ids(got.body.blocks)).toEqual(["a", "b"]);

    // Deletes before Phase 6 left no tombstones: only "now" is diffable.
    expect((await changes(alice, id, 5)).body).toEqual({ revision: 5, upserts: [], deletes: [], commentsVersion: 0 });
    expect((await changes(alice, id, 4)).body.reset).toBe(true);

    const s = await save(alice, id, { baseRevision: 5, upserts: [para("b", "B2")], deletes: ["a"], order: ["b"] });
    expect(s.status).toBe(200);
    expect(s.body.revision).toBe(6);
    expect((await changes(alice, id, 5)).body).toMatchObject({
      upserts: [{ id: "b", data: { text: "B2" } }],
      deletes: ["a"],
      order: ["b"],
    });

    // Stale base from before the upgrade → conservative conflict.
    const stale = await save(alice, id, { baseRevision: 4, upserts: [para("b", "x")], deletes: [] });
    expect(stale.status).toBe(409);

    expect((await api(alice, "PATCH", `/documents/${id}`, { title: "Renamed" })).body.revision).toBe(7);
    const c = await api(alice, "POST", `/documents/${id}/comments`, {
      anchor: { blockId: "b", quote: "B", prefix: "", suffix: "" },
      body: "hi",
    });
    expect(c.status).toBe(201);
    expect((await changes(alice, id, 7)).body.commentsVersion).toBe(1);
  });
});
