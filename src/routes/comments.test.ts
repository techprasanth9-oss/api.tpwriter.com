import { describe, expect, it } from "vitest";
import { DocumentModel } from "../models/document";
import { CommentThread } from "../models/commentThread";
import { Notification } from "../models/notification";
import { api, createDoc, makeUser, share, withToken, type Actor } from "../test/helpers";

const anchor = { blockId: "a", quote: "hello", prefix: "say ", suffix: " world" };
const mention = (u: Actor, name: string) => `@[${name}](${u.id})`;

async function setup() {
  const owner = await makeUser("Owner");
  const editor = await makeUser("Ed");
  const commenter = await makeUser("Cam");
  const viewer = await makeUser("Vi");
  const stranger = await makeUser("Stranger");
  const id = await createDoc(owner, "Spec");
  await share(owner, id, editor.email, "editor");
  await share(owner, id, commenter.email, "commenter");
  await share(owner, id, viewer.email, "viewer");
  return { owner, editor, commenter, viewer, stranger, id };
}

const commentsVersion = async (id: string) => (await DocumentModel.findById(id).lean())!.commentsVersion;

describe("comments", () => {
  it("creates, replies, resolves, edits and lists threads", async () => {
    const { owner, commenter, viewer, id } = await setup();

    const created = await api(commenter, "POST", `/documents/${id}/comments`, { anchor, body: "  Typo here  " });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      anchor,
      resolved: false,
      resolvedBy: null,
      comments: [
        {
          author: { id: commenter.id, email: commenter.email, displayName: "Cam" },
          body: "Typo here",
          mentions: [],
          editedAt: null,
        },
      ],
    });
    const tid = created.body.id;
    expect(await commentsVersion(id)).toBe(1);

    const reply = await api(owner, "POST", `/documents/${id}/comments/${tid}/replies`, { body: "Fixed" });
    expect(reply.status).toBe(201);
    expect(reply.body.comments.map((c: any) => c.body)).toEqual(["Typo here", "Fixed"]);

    const resolved = await api(commenter, "PATCH", `/documents/${id}/comments/${tid}`, { resolved: true });
    expect(resolved.body).toMatchObject({ resolved: true, resolvedBy: { id: commenter.id } });
    const reopened = await api(owner, "PATCH", `/documents/${id}/comments/${tid}`, { resolved: false });
    expect(reopened.body).toMatchObject({ resolved: false, resolvedBy: null });

    const cid = reply.body.comments[1].id;
    const edited = await api(owner, "PATCH", `/documents/${id}/comments/${tid}/replies/${cid}`, { body: "Fixed now" });
    expect(edited.status).toBe(200);
    expect(edited.body.comments[1]).toMatchObject({ body: "Fixed now", editedAt: expect.any(String) });

    const list = await api(viewer, "GET", `/documents/${id}/comments`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].comments).toHaveLength(2);
    expect(await commentsVersion(id)).toBe(5);

    // Viewers read but can't write.
    expect((await api(viewer, "POST", `/documents/${id}/comments`, { anchor, body: "x" })).status).toBe(403);
    expect((await api(viewer, "PATCH", `/documents/${id}/comments/${tid}`, { resolved: true })).status).toBe(403);
  });

  it("only lets authors edit or delete their own comments", async () => {
    const { owner, editor, commenter, id } = await setup();
    const t = await api(commenter, "POST", `/documents/${id}/comments`, { anchor, body: "root" });
    const tid = t.body.id;
    const rootId = t.body.comments[0].id;
    const r = await api(editor, "POST", `/documents/${id}/comments/${tid}/replies`, { body: "editor reply" });
    const replyId = r.body.comments[1].id;

    expect((await api(owner, "PATCH", `/documents/${id}/comments/${tid}/replies/${rootId}`, { body: "hijack" })).status).toBe(403);
    expect((await api(commenter, "PATCH", `/documents/${id}/comments/${tid}/replies/${replyId}`, { body: "hijack" })).status).toBe(403);
    // Even the owner can't delete someone else's reply.
    expect((await api(owner, "DELETE", `/documents/${id}/comments/${tid}/replies/${replyId}`)).status).toBe(403);

    expect((await api(editor, "DELETE", `/documents/${id}/comments/${tid}/replies/${replyId}`)).status).toBe(204);
    const after = await api(commenter, "GET", `/documents/${id}/comments`);
    expect(after.body[0].comments.map((c: any) => c.body)).toEqual(["root"]);

    expect((await api(owner, "PATCH", `/documents/${id}/comments/${tid}/replies/nope`, { body: "x" })).status).toBe(404);
  });

  it("deleting the first comment deletes the thread (author or editor+)", async () => {
    const { owner, editor, commenter, id } = await setup();
    const mk = async (by: Actor) => {
      const t = await api(by, "POST", `/documents/${id}/comments`, { anchor, body: `by ${by.id}` });
      return { tid: t.body.id as string, root: t.body.comments[0].id as string };
    };

    const a = await mk(owner);
    // A commenter who isn't the author can't.
    expect((await api(commenter, "DELETE", `/documents/${id}/comments/${a.tid}/replies/${a.root}`)).status).toBe(403);
    // An editor can.
    expect((await api(editor, "DELETE", `/documents/${id}/comments/${a.tid}/replies/${a.root}`)).status).toBe(204);

    const b = await mk(commenter);
    await api(owner, "POST", `/documents/${id}/comments/${b.tid}/replies`, { body: "reply" });
    expect((await api(commenter, "DELETE", `/documents/${id}/comments/${b.tid}/replies/${b.root}`)).status).toBe(204);

    expect((await api(owner, "GET", `/documents/${id}/comments`)).body).toEqual([]);
    expect(await CommentThread.countDocuments({ documentId: id })).toBe(0);
  });

  it("validates anchors and bodies", async () => {
    const { owner, id } = await setup();
    const bad = [
      { anchor: { ...anchor, blockId: "has space" }, body: "x" },
      { anchor: { ...anchor, quote: "q".repeat(1001) }, body: "x" },
      { anchor: { ...anchor, prefix: "p".repeat(65) }, body: "x" },
      { anchor: { ...anchor, suffix: "s".repeat(65) }, body: "x" },
      { anchor, body: "   " },
      { anchor, body: "b".repeat(5001) },
      { body: "no anchor" },
    ];
    for (const body of bad) {
      expect((await api(owner, "POST", `/documents/${id}/comments`, body)).status).toBe(400);
    }
    const ok = await api(owner, "POST", `/documents/${id}/comments`, {
      anchor: { blockId: "a", quote: "q".repeat(1000), prefix: "p".repeat(64), suffix: "s".repeat(64) },
      body: "b".repeat(5000),
    });
    expect(ok.status).toBe(201);
    expect((await api(owner, "POST", `/documents/${id}/comments/not-an-id/replies`, { body: "x" })).status).toBe(404);
  });

  it("rate-limits comment creation per user", async () => {
    const { owner, commenter, id } = await setup();
    for (let i = 0; i < 30; i++) {
      expect((await api(owner, "POST", `/documents/${id}/comments`, { anchor, body: `c${i}` })).status).toBe(201);
    }
    const limited = await api(owner, "POST", `/documents/${id}/comments`, { anchor, body: "one too many" });
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe("rate_limited");
    // Another user has their own budget.
    expect((await api(commenter, "POST", `/documents/${id}/comments`, { anchor, body: "mine" })).status).toBe(201);
  });
});

describe("mentions and notifications", () => {
  it("keeps mentions of people with access and notifies them (not the author)", async () => {
    const { owner, editor, commenter, viewer, stranger, id } = await setup();
    const body = `Ping ${mention(editor, "Ed")} ${mention(viewer, "Vi")} ${mention(stranger, "Stranger")} ${mention(commenter, "Me")} ${mention(editor, "Ed again")}`;
    const t = await api(commenter, "POST", `/documents/${id}/comments`, { anchor, body });
    expect(t.status).toBe(201);
    expect(t.body.comments[0].body).toBe(body);
    expect([...t.body.comments[0].mentions].sort()).toEqual([editor.id, viewer.id, commenter.id].sort());

    const edNotes = await api(editor, "GET", "/notifications");
    expect(edNotes.body).toEqual([
      {
        id: expect.any(String),
        documentId: id,
        documentTitle: "Spec",
        threadId: t.body.id,
        from: { id: commenter.id, email: commenter.email, displayName: "Cam" },
        excerpt: "Ping @Ed @Vi @Stranger @Me @Ed again",
        read: false,
        createdAt: expect.any(String),
      },
    ]);
    expect((await api(viewer, "GET", "/notifications")).body).toHaveLength(1);
    expect((await api(stranger, "GET", "/notifications")).body).toEqual([]);
    expect((await api(commenter, "GET", "/notifications")).body).toEqual([]);
    expect((await api(owner, "GET", "/notifications")).body).toEqual([]);

    // A reply mentioning the owner notifies the owner.
    await api(editor, "POST", `/documents/${id}/comments/${t.body.id}/replies`, { body: `${mention(owner, "Owner")} ok?` });
    const ownerNotes = await api(owner, "GET", "/notifications");
    expect(ownerNotes.body).toEqual([expect.objectContaining({ excerpt: "@Owner ok?", from: expect.objectContaining({ id: editor.id }) })]);

    // Editing to add a mention only notifies the newcomer.
    const replyId = (await api(editor, "GET", `/documents/${id}/comments`)).body[0].comments[1].id;
    await api(editor, "PATCH", `/documents/${id}/comments/${t.body.id}/replies/${replyId}`, {
      body: `${mention(owner, "Owner")} ${mention(viewer, "Vi")} ok?`,
    });
    expect((await api(owner, "GET", "/notifications")).body).toHaveLength(1);
    expect((await api(viewer, "GET", "/notifications")).body).toHaveLength(2);
  });

  it("marks only your own notifications read", async () => {
    const { owner, editor, viewer, id } = await setup();
    await api(owner, "POST", `/documents/${id}/comments`, {
      anchor,
      body: `${mention(editor, "Ed")} and ${mention(viewer, "Vi")}`,
    });
    const edNote = (await api(editor, "GET", "/notifications")).body[0];
    const viNote = (await api(viewer, "GET", "/notifications")).body[0];

    // The viewer tries to mark the editor's notification (and junk) read.
    expect((await api(viewer, "POST", "/notifications/read", { ids: [edNote.id, "junk"] })).status).toBe(204);
    expect((await api(editor, "GET", "/notifications")).body[0].read).toBe(false);

    expect((await api(editor, "POST", "/notifications/read", { ids: [edNote.id] })).status).toBe(204);
    expect((await api(editor, "GET", "/notifications")).body[0].read).toBe(true);
    expect((await api(viewer, "GET", "/notifications")).body[0]).toMatchObject({ id: viNote.id, read: false });
  });

  it("hides notifications once access is revoked; deleting the thread removes them", async () => {
    const { owner, editor, viewer, id } = await setup();
    const t = await api(owner, "POST", `/documents/${id}/comments`, {
      anchor,
      body: `${mention(editor, "Ed")} ${mention(viewer, "Vi")}`,
    });
    await api(owner, "DELETE", `/documents/${id}/shares/${viewer.id}`);
    expect((await api(viewer, "GET", "/notifications")).body).toEqual([]);

    await api(owner, "DELETE", `/documents/${id}/comments/${t.body.id}/replies/${t.body.comments[0].id}`);
    expect(await Notification.countDocuments({ documentId: id })).toBe(0);
  });

  it("link holders can comment (if the link allows) but can't be mentioned", async () => {
    const { owner, stranger, id } = await setup();
    const link = await api(owner, "PUT", `/documents/${id}/link`, { enabled: true, role: "commenter" });
    const holder = withToken(stranger, link.body.link.token);
    const t = await api(holder, "POST", `/documents/${id}/comments`, { anchor, body: `hi ${mention(owner, "Owner")}` });
    expect(t.status).toBe(201);
    const r = await api(owner, "POST", `/documents/${id}/comments/${t.body.id}/replies`, { body: `${mention(stranger, "S")} hi` });
    expect(r.body.comments[1].mentions).toEqual([]);
    expect((await api(owner, "GET", "/notifications")).body).toHaveLength(1);
  });
});
