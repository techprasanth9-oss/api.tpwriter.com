import { Hono } from "hono";
import { vValidator } from "@hono/valibot-validator";
import { Types, isValidObjectId } from "mongoose";
import { DocumentModel, type DocumentDoc } from "../models/document";
import {
  CommentThread,
  MAX_COMMENTS_PER_THREAD,
  type CommentThreadDoc,
} from "../models/commentThread";
import { Notification } from "../models/notification";
import { requireAuth } from "../auth/middleware";
import { atLeast, memberRole, requireDocRole, type DocEnv } from "../auth/access";
import { publicUser, publicUsers } from "../collab/users";
import { userRateLimit } from "../middleware/rateLimit";
import {
  CommentBodyInput,
  CreateThreadInput,
  MarkReadInput,
  ResolveInput,
} from "../schemas/collab";

/**
 * Comments (Phase 6).
 *   GET    /documents/:id/comments                              viewer+
 *   POST   /documents/:id/comments                { anchor, body }  commenter+
 *   POST   /documents/:id/comments/:tid/replies   { body }      commenter+
 *   PATCH  /documents/:id/comments/:tid           { resolved }  commenter+
 *   PATCH  /documents/:id/comments/:tid/replies/:cid { body }   own comment
 *   DELETE /documents/:id/comments/:tid/replies/:cid            own comment;
 *          the first comment deletes the thread (its author or editor+)
 * Notifications:
 *   GET  /notifications           mentions of me, newest first
 *   POST /notifications/read      { ids }
 *
 * Every change bumps the document's `commentsVersion` (clients see it in
 * /changes and refetch). Mentions are `@[Name](userId)` in the body; only
 * users with real access (owner / member) are kept, and each gets a
 * notification (never the author).
 */
export const comments = new Hono<DocEnv>();
comments.use("*", requireAuth);

const createLimit = userRateLimit({ name: "comment", windowMs: 60_000, max: 30 });

const MENTION_RE = /@\[([^\]\n]{1,100})\]\(([a-f0-9]{24})\)/g;
const EXCERPT_LEN = 140;

comments.get("/:id/comments", requireDocRole("viewer"), async (c) => {
  const threads = await CommentThread.find({ documentId: c.get("doc")._id })
    .sort({ createdAt: 1, _id: 1 })
    .lean<CommentThreadDoc[]>();
  return c.json(await toThreadsResponse(threads));
});

comments.post(
  "/:id/comments",
  requireDocRole("commenter"),
  createLimit,
  vValidator("json", CreateThreadInput),
  async (c) => {
    const doc = c.get("doc");
    const userId = c.get("session").userId;
    const { anchor, body } = c.req.valid("json");
    const mentions = parseMentions(body, doc);
    const commentId = new Types.ObjectId();

    const thread = await CommentThread.create({
      documentId: doc._id,
      anchor,
      comments: [{ _id: commentId, authorId: userId, body, mentions, createdAt: new Date() }],
    });
    await notify(doc, thread._id, commentId, userId, body, mentions);
    await bumpComments(doc._id);
    return c.json((await toThreadsResponse([thread.toObject()]))[0], 201);
  },
);

comments.post(
  "/:id/comments/:tid/replies",
  requireDocRole("commenter"),
  createLimit,
  vValidator("json", CommentBodyInput),
  async (c) => {
    const doc = c.get("doc");
    const tid = threadId(c.req.param("tid"));
    if (!tid) return c.json({ error: "not_found" }, 404);
    const userId = c.get("session").userId;
    const { body } = c.req.valid("json");
    const mentions = parseMentions(body, doc);
    const commentId = new Types.ObjectId();

    const thread = await CommentThread.findOneAndUpdate(
      {
        _id: tid,
        documentId: doc._id,
        [`comments.${MAX_COMMENTS_PER_THREAD - 1}`]: { $exists: false },
      },
      {
        $push: {
          comments: { _id: commentId, authorId: userId, body, mentions, createdAt: new Date() },
        },
      },
      { new: true },
    ).lean<CommentThreadDoc>();
    if (!thread) {
      const exists = await CommentThread.exists({ _id: tid, documentId: doc._id });
      return exists
        ? c.json({ error: "too_many_comments", max: MAX_COMMENTS_PER_THREAD }, 400)
        : c.json({ error: "not_found" }, 404);
    }
    await notify(doc, thread._id, commentId, userId, body, mentions);
    await bumpComments(doc._id);
    return c.json((await toThreadsResponse([thread]))[0], 201);
  },
);

comments.patch(
  "/:id/comments/:tid",
  requireDocRole("commenter"),
  vValidator("json", ResolveInput),
  async (c) => {
    const doc = c.get("doc");
    const tid = threadId(c.req.param("tid"));
    if (!tid) return c.json({ error: "not_found" }, 404);
    const { resolved } = c.req.valid("json");
    const thread = await CommentThread.findOneAndUpdate(
      { _id: tid, documentId: doc._id },
      {
        $set: {
          resolved,
          resolvedBy: resolved ? new Types.ObjectId(c.get("session").userId) : null,
        },
      },
      { new: true },
    ).lean<CommentThreadDoc>();
    if (!thread) return c.json({ error: "not_found" }, 404);
    await bumpComments(doc._id);
    return c.json((await toThreadsResponse([thread]))[0]);
  },
);

comments.patch(
  "/:id/comments/:tid/replies/:cid",
  requireDocRole("commenter"),
  vValidator("json", CommentBodyInput),
  async (c) => {
    const doc = c.get("doc");
    const tid = threadId(c.req.param("tid"));
    const cid = threadId(c.req.param("cid"));
    if (!tid || !cid) return c.json({ error: "not_found" }, 404);
    const userId = c.get("session").userId;

    const before = await CommentThread.findOne({ _id: tid, documentId: doc._id }).lean<CommentThreadDoc>();
    const comment = before?.comments.find((x) => x._id.equals(cid));
    if (!before || !comment) return c.json({ error: "not_found" }, 404);
    if (!comment.authorId.equals(userId)) return c.json({ error: "forbidden" }, 403);

    const { body } = c.req.valid("json");
    const mentions = parseMentions(body, doc);
    const thread = await CommentThread.findOneAndUpdate(
      { _id: tid, documentId: doc._id, comments: { $elemMatch: { _id: cid, authorId: userId } } },
      {
        $set: {
          "comments.$.body": body,
          "comments.$.mentions": mentions,
          "comments.$.editedAt": new Date(),
        },
      },
      { new: true },
    ).lean<CommentThreadDoc>();
    if (!thread) return c.json({ error: "not_found" }, 404);

    // Only people newly mentioned by the edit hear about it.
    const already = new Set(comment.mentions.map(String));
    const added = mentions.filter((m) => !already.has(m.toString()));
    await notify(doc, thread._id, cid, userId, body, added);
    await bumpComments(doc._id);
    return c.json((await toThreadsResponse([thread]))[0]);
  },
);

comments.delete("/:id/comments/:tid/replies/:cid", requireDocRole("commenter"), async (c) => {
  const doc = c.get("doc");
  const tid = threadId(c.req.param("tid"));
  const cid = threadId(c.req.param("cid"));
  if (!tid || !cid) return c.json({ error: "not_found" }, 404);
  const userId = c.get("session").userId;

  const thread = await CommentThread.findOne({ _id: tid, documentId: doc._id }).lean<CommentThreadDoc>();
  const index = thread?.comments.findIndex((x) => x._id.equals(cid)) ?? -1;
  if (!thread || index < 0) return c.json({ error: "not_found" }, 404);
  const isAuthor = thread.comments[index]!.authorId.equals(userId);

  if (index === 0) {
    // First comment = the thread itself.
    if (!isAuthor && !atLeast(c.get("role"), "editor")) {
      return c.json({ error: "forbidden" }, 403);
    }
    await CommentThread.deleteOne({ _id: tid });
    await Notification.deleteMany({ threadId: tid });
  } else {
    if (!isAuthor) return c.json({ error: "forbidden" }, 403);
    await CommentThread.updateOne({ _id: tid }, { $pull: { comments: { _id: cid } } });
    await Notification.deleteMany({ threadId: tid, commentId: cid });
  }
  await bumpComments(doc._id);
  return c.body(null, 204);
});

// ── Notifications ───────────────────────────────────────────────────────

export const notifications = new Hono<DocEnv>();
notifications.use("*", requireAuth);

const NOTIFICATION_LIMIT = 100;

notifications.get("/", async (c) => {
  const userId = c.get("session").userId;
  const rows = await Notification.find({ userId })
    .sort({ createdAt: -1, _id: -1 })
    .limit(NOTIFICATION_LIMIT)
    .lean();
  const docs = await DocumentModel.find(
    { _id: { $in: [...new Set(rows.map((r) => r.documentId.toString()))] } },
    { title: 1, ownerId: 1, members: 1 },
  ).lean<Pick<DocumentDoc, "_id" | "title" | "ownerId" | "members">[]>();
  // Hide mentions in documents the user can no longer open.
  const visible = new Map(
    docs.filter((d) => memberRole(d, userId)).map((d) => [d._id.toString(), d]),
  );
  const shown = rows.filter((r) => visible.has(r.documentId.toString()));
  const users = await publicUsers(shown.map((r) => r.fromUserId));
  return c.json(
    shown.map((r) => ({
      id: r._id.toString(),
      documentId: r.documentId.toString(),
      documentTitle: visible.get(r.documentId.toString())!.title,
      threadId: r.threadId.toString(),
      from: publicUser(users, r.fromUserId),
      excerpt: r.excerpt,
      read: r.read,
      createdAt: r.createdAt.toISOString(),
    })),
  );
});

notifications.post("/read", vValidator("json", MarkReadInput), async (c) => {
  const ids = c.req.valid("json").ids.filter((id) => isValidObjectId(id));
  if (ids.length > 0) {
    await Notification.updateMany(
      { _id: { $in: ids.map((id) => new Types.ObjectId(id)) }, userId: c.get("session").userId },
      { $set: { read: true } },
    );
  }
  return c.body(null, 204);
});

// ── Helpers ─────────────────────────────────────────────────────────────

function threadId(raw: string | undefined): Types.ObjectId | null {
  return raw && isValidObjectId(raw) && /^[a-f0-9]{24}$/i.test(raw) ? new Types.ObjectId(raw) : null;
}

/** Unique mentioned user ids that can open the document without a link. */
export function parseMentions(
  body: string,
  doc: Pick<DocumentDoc, "ownerId" | "members">,
): Types.ObjectId[] {
  const ids = new Set<string>();
  for (const m of body.matchAll(MENTION_RE)) ids.add(m[2]!.toLowerCase());
  return [...ids].filter((id) => memberRole(doc, id)).map((id) => new Types.ObjectId(id));
}

function excerptOf(body: string): string {
  const plain = body.replace(MENTION_RE, (_m, name: string) => `@${name}`).replace(/\s+/g, " ").trim();
  return plain.length > EXCERPT_LEN ? `${plain.slice(0, EXCERPT_LEN - 1)}…` : plain;
}

async function notify(
  doc: DocumentDoc,
  thread: Types.ObjectId,
  commentId: Types.ObjectId,
  fromUserId: string,
  body: string,
  mentions: Types.ObjectId[],
): Promise<void> {
  const targets = mentions.filter((m) => !m.equals(fromUserId));
  if (targets.length === 0) return;
  const excerpt = excerptOf(body);
  await Notification.insertMany(
    targets.map((userId) => ({
      userId,
      documentId: doc._id,
      threadId: thread,
      commentId,
      fromUserId: new Types.ObjectId(fromUserId),
      excerpt,
    })),
  );
}

async function bumpComments(documentId: Types.ObjectId): Promise<void> {
  await DocumentModel.updateOne(
    { _id: documentId },
    { $inc: { commentsVersion: 1 } },
    { timestamps: false },
  );
}

async function toThreadsResponse(threads: CommentThreadDoc[]) {
  const users = await publicUsers(
    threads.flatMap((t) => [t.resolvedBy, ...t.comments.map((x) => x.authorId)]),
  );
  return threads.map((t) => ({
    id: t._id.toString(),
    anchor: {
      blockId: t.anchor.blockId,
      quote: t.anchor.quote ?? "",
      prefix: t.anchor.prefix ?? "",
      suffix: t.anchor.suffix ?? "",
    },
    resolved: !!t.resolved,
    resolvedBy: t.resolvedBy ? publicUser(users, t.resolvedBy) : null,
    comments: t.comments.map((x) => ({
      id: x._id.toString(),
      author: publicUser(users, x.authorId),
      body: x.body,
      mentions: (x.mentions ?? []).map(String),
      createdAt: x.createdAt.toISOString(),
      editedAt: x.editedAt ? x.editedAt.toISOString() : null,
    })),
    createdAt: t.createdAt.toISOString(),
  }));
}
