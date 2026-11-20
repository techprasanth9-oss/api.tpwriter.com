import { afterEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import { DocumentModel } from "../models/document";
import { DocumentBlock } from "../models/documentBlock";
import { DocumentPage } from "../models/documentPage";
import { DocumentVersion } from "../models/documentVersion";
import { CommentThread } from "../models/commentThread";
import { Notification } from "../models/notification";
import { AUTO_VERSION_KEEP } from "../collab/versions";
import { presence } from "../collab/presence";
import { api, createDoc, makeUser, para, seed, share, type Actor } from "../test/helpers";

const save = (a: Actor, id: string, body: object) => api(a, "PUT", `/documents/${id}/content`, body);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("versions", () => {
  it("snapshots automatically after a save at most every 10 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-20T09:00:00Z"));
    const alice = await makeUser("Alice");
    const id = await createDoc(alice);

    const r2 = await seed(alice, id, ["a", "b"]);
    let list = await api(alice, "GET", `/documents/${id}/versions`);
    expect(list.body).toEqual([
      {
        id: expect.any(String),
        revision: r2,
        label: null,
        auto: true,
        createdAt: "2026-11-20T09:00:00.000Z",
        createdBy: { id: alice.id, email: alice.email, displayName: "Alice" },
      },
    ]);
    // The snapshot is the state AFTER the save.
    const v1 = await api(alice, "GET", `/documents/${id}/versions/${list.body[0].id}`);
    expect(v1.body.blocks.map((b: any) => b.id)).toEqual(["a", "b"]);
    expect(v1.body).toMatchObject({ title: "Doc", styles: {}, pageSetup: {}, defaultLayout: { paperSize: "A4" } });

    vi.setSystemTime(new Date("2026-11-20T09:09:00Z"));
    const r3 = (await save(alice, id, { baseRevision: r2, upserts: [para("a", "x")], deletes: [] })).body.revision;
    expect((await api(alice, "GET", `/documents/${id}/versions`)).body).toHaveLength(1);

    vi.setSystemTime(new Date("2026-11-20T09:10:01Z"));
    const r4 = (await save(alice, id, { baseRevision: r3, upserts: [para("a", "y")], deletes: [] })).body.revision;
    list = await api(alice, "GET", `/documents/${id}/versions`);
    expect(list.body.map((v: any) => v.revision)).toEqual([r4, r2]);
  });

  it("creates named versions and validates labels", async () => {
    const alice = await makeUser();
    const id = await createDoc(alice);
    await seed(alice, id, ["a"]);
    const named = await api(alice, "POST", `/documents/${id}/versions`, { label: "  Draft 1 " });
    expect(named.status).toBe(201);
    expect(named.body).toMatchObject({ label: "Draft 1", auto: false, revision: 2, createdBy: { id: alice.id } });
    expect((await api(alice, "POST", `/documents/${id}/versions`, { label: "" })).status).toBe(400);
    expect((await api(alice, "GET", `/documents/${id}/versions/${new Types.ObjectId()}`)).status).toBe(404);

    // A version id from another document is not found here.
    const other = await createDoc(alice, "Other");
    expect((await api(alice, "GET", `/documents/${other}/versions/${named.body.id}`)).status).toBe(404);
  });

  it("keeps every named version and the newest 50 automatic ones", async () => {
    const alice = await makeUser();
    const id = await createDoc(alice);
    const documentId = new Types.ObjectId(id);
    const old = Date.now() - 24 * 3600_000;
    const row = (i: number, auto: boolean) => ({
      documentId,
      revision: 1,
      title: "Doc",
      blocks: [],
      auto,
      label: auto ? null : `named ${i}`,
      createdAt: new Date(old + i * 1000),
    });
    await DocumentVersion.insertMany([
      ...Array.from({ length: 60 }, (_, i) => row(i, true)),
      row(0, false),
      row(100, false),
    ]);

    await seed(alice, id, ["a"]); // newest is a day old → snapshot + prune
    const autos = await DocumentVersion.find({ documentId, auto: true }).sort({ createdAt: -1 }).lean();
    expect(autos).toHaveLength(AUTO_VERSION_KEEP);
    expect(autos[0]!.revision).toBe(2); // the new one survives
    expect(autos.at(-1)!.createdAt.getTime()).toBe(old + 11 * 1000); // oldest kept
    expect(await DocumentVersion.countDocuments({ documentId, auto: false })).toBe(2);
  });

  it("restores a version: before-restore snapshot, tombstones, revision bump, changes feed", async () => {
    const alice = await makeUser();
    const id = await createDoc(alice, "Original");
    await seed(alice, id, ["a", "b"]);
    const rev = (await api(alice, "PATCH", `/documents/${id}`, { styles: { h1: { size: 1 } } })).body.revision;
    const named = await api(alice, "POST", `/documents/${id}/versions`, { label: "good" });

    await (save(alice, id, { baseRevision: rev, upserts: [para("c", "C"), para("a", "changed")], deletes: ["b"], order: ["c", "a"] }));
    await api(alice, "PATCH", `/documents/${id}`, { title: "Changed", styles: {} });
    const before = (await api(alice, "GET", `/documents/${id}`)).body.revision;

    const restored = await api(alice, "POST", `/documents/${id}/versions/${named.body.id}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body).toEqual({ revision: before + 1 });

    const got = await api(alice, "GET", `/documents/${id}`);
    expect(got.body).toMatchObject({ title: "Original", revision: before + 1, styles: { h1: { size: 1 } } });
    expect(got.body.blocks).toEqual([
      { id: "a", type: "paragraph", data: { text: "A" }, tunes: {} },
      { id: "b", type: "paragraph", data: { text: "B" }, tunes: {} },
    ]);
    expect(await DocumentBlock.findOne({ documentId: id, blockId: "c" }).lean()).toMatchObject({ deleted: true, rev: before + 1 });

    const feed = await api(alice, "GET", `/documents/${id}/changes?since=${before}`);
    expect(feed.body).toMatchObject({ revision: before + 1, deletes: ["c"], order: ["a", "b"], meta: { title: "Original" } });
    expect(feed.body.upserts.map((b: any) => b.id).sort()).toEqual(["a", "b"]);

    const versions = (await api(alice, "GET", `/documents/${id}/versions`)).body;
    const snap = versions.find((v: any) => v.label === "Before restore");
    expect(snap).toMatchObject({ auto: true, revision: before });
    const snapContent = await api(alice, "GET", `/documents/${id}/versions/${snap.id}`);
    expect(snapContent.body).toMatchObject({ title: "Changed" });
    expect(snapContent.body.blocks.map((b: any) => b.id)).toEqual(["c", "a"]);

    // A client still on `before` sees its save to a restored block conflict.
    const stale = await save(alice, id, { baseRevision: before, upserts: [para("a", "late")], deletes: [] });
    expect(stale.status).toBe(409);
    expect(stale.body.conflicts).toEqual(["a"]);
  });

  it("skips oversized snapshots without failing the save; refuses named ones", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const alice = await makeUser();
    const id = await createDoc(alice);
    const documentId = new Types.ObjectId(id);
    // ~11 MB of block data, written straight to the DB.
    const big = "x".repeat(1024 * 1024);
    const blockIds = Array.from({ length: 11 }, (_, i) => `big${i}`);
    await DocumentBlock.insertMany(
      blockIds.map((blockId) => ({ documentId, ownerId: alice.id, blockId, type: "paragraph", data: { text: big }, rev: 1 })),
    );
    await DocumentModel.updateOne({ _id: id }, { $set: { blockOrder: blockIds } });

    const res = await save(alice, id, { baseRevision: 1, upserts: [para("big0", "small")], deletes: [] });
    expect(res.status).toBe(200);
    expect(await DocumentVersion.countDocuments({ documentId })).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("skipped version snapshot"));

    const named = await api(alice, "POST", `/documents/${id}/versions`, { label: "too big" });
    expect(named.status).toBe(413);
    expect(named.body).toEqual({ error: "version_too_large" });
  });
});

describe("DELETE /documents/:id cascade", () => {
  it("removes blocks, pages, versions, comments, notifications and presence", async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    const id = await createDoc(alice);
    const keep = await createDoc(alice, "Keep");
    await share(alice, id, bob.email, "editor");
    await seed(alice, id, ["a", "b"]);
    await seed(alice, keep, ["k"]);
    await save(alice, id, { baseRevision: 2, upserts: [], deletes: ["b"], order: ["a"] }); // tombstone
    await api(alice, "POST", `/documents/${id}/versions`, { label: "v" });
    await api(alice, "POST", `/documents/${id}/comments`, {
      anchor: { blockId: "a", quote: "A", prefix: "", suffix: "" },
      body: `@[Bob](${bob.id})`,
    });
    await api(bob, "POST", `/documents/${id}/presence`, { state: "viewing", blockId: null });
    await DocumentPage.create({ documentId: id, ownerId: alice.id, pageIndex: 0, content: { blocks: [] } });
    expect(await Notification.countDocuments({ documentId: id })).toBe(1);

    // Editors can't delete.
    expect((await api(bob, "DELETE", `/documents/${id}`)).status).toBe(403);

    expect((await api(alice, "DELETE", `/documents/${id}`)).status).toBe(204);
    for (const model of [DocumentBlock, DocumentPage, DocumentVersion, CommentThread, Notification] as const) {
      expect(await (model as any).countDocuments({ documentId: id })).toBe(0);
    }
    expect(presence.heartbeat(id, alice.id, "viewing", null)).toEqual([]);
    presence.clear(id);
    expect((await api(bob, "GET", "/notifications")).body).toEqual([]);
    // Other documents untouched.
    expect(await DocumentBlock.countDocuments({ documentId: keep })).toBe(1);
    expect(await DocumentVersion.countDocuments({ documentId: keep })).toBe(1);
  });
});
