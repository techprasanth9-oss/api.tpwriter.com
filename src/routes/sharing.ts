import { Hono } from "hono";
import { vValidator } from "@hono/valibot-validator";
import { Types, isValidObjectId } from "mongoose";
import { DocumentModel, type DocumentDoc } from "../models/document";
import { User } from "../models/user";
import { requireAuth } from "../auth/middleware";
import { newLinkToken, requireDocRole, type DocEnv } from "../auth/access";
import { publicUser, publicUsers } from "../collab/users";
import { presence } from "../collab/presence";
import { LinkInput, ShareInput } from "../schemas/collab";

/** Members + pending invites per document. */
export const MAX_SHARES = 100;

/**
 * Sharing (Phase 6).
 *   GET    /documents/:id/people        commenter+ → PublicUser[] (who can be @mentioned)
 *   GET    /documents/:id/shares        editor+  → Shares
 *   PUT    /documents/:id/shares        owner    { email, role } → Shares
 *   DELETE /documents/:id/shares/:who   owner    (user id or invited email)
 *   PUT    /documents/:id/link          owner    { enabled, role } → Shares
 *
 * Sharing with an email that has an account adds a member; otherwise it
 * records an invite that turns into a membership when that email signs up.
 */
export const sharing = new Hono<DocEnv>();

sharing.use("*", requireAuth);

/** Owner + members — for @mentions. No invites, roles or link token. */
sharing.get("/:id/people", requireDocRole("commenter"), async (c) => {
  const doc = c.get("doc");
  const ids = [doc.ownerId, ...(doc.members ?? []).map((m) => m.userId)];
  const users = await publicUsers(ids);
  return c.json(ids.map((id) => publicUser(users, id)));
});

sharing.get("/:id/shares", requireDocRole("editor"), async (c) => {
  return c.json(await toSharesResponse(c.get("doc")));
});

sharing.put("/:id/shares", requireDocRole("owner"), vValidator("json", ShareInput), async (c) => {
  const doc = c.get("doc");
  const { email, role } = c.req.valid("json");

  const target = await User.findOne({ email }, { _id: 1 }).lean();
  if (email === c.get("session").email.toLowerCase() || target?._id.equals(doc.ownerId)) {
    return c.json({ error: "cannot_share_with_owner" }, 400);
  }

  const members = doc.members ?? [];
  const invites = doc.invites ?? [];
  const isNew = target
    ? !members.some((m) => m.userId.equals(target._id))
    : !invites.some((i) => i.email === email);
  if (isNew && members.length + invites.length >= MAX_SHARES) {
    return c.json({ error: "too_many_shares", max: MAX_SHARES }, 400);
  }

  if (target) {
    // Existing account → membership (and drop any stale invite for it).
    const updated = await DocumentModel.updateOne(
      { _id: doc._id, "members.userId": target._id },
      { $set: { "members.$.role": role }, $pull: { invites: { email } } },
      { timestamps: false },
    );
    if (updated.matchedCount === 0) {
      await DocumentModel.updateOne(
        { _id: doc._id, "members.userId": { $ne: target._id } },
        { $push: { members: { userId: target._id, role } }, $pull: { invites: { email } } },
        { timestamps: false },
      );
    }
  } else {
    const updated = await DocumentModel.updateOne(
      { _id: doc._id, "invites.email": email },
      { $set: { "invites.$.role": role } },
      { timestamps: false },
    );
    if (updated.matchedCount === 0) {
      await DocumentModel.updateOne(
        { _id: doc._id, "invites.email": { $ne: email } },
        { $push: { invites: { email, role } } },
        { timestamps: false },
      );
    }
  }

  return c.json(await toSharesResponse(await reload(doc)));
});

/** Idempotent: removing someone who isn't shared is not an error. */
sharing.delete("/:id/shares/:who", requireDocRole("owner"), async (c) => {
  const doc = c.get("doc");
  const who = c.req.param("who").trim(); // Hono already URL-decodes params

  if (isValidObjectId(who) && !who.includes("@")) {
    const userId = new Types.ObjectId(who);
    await DocumentModel.updateOne(
      { _id: doc._id },
      { $pull: { members: { userId } } },
      { timestamps: false },
    );
    presence.clear(doc._id.toString(), who);
  } else {
    await DocumentModel.updateOne(
      { _id: doc._id },
      { $pull: { invites: { email: who.toLowerCase() } } },
      { timestamps: false },
    );
  }

  return c.json(await toSharesResponse(await reload(doc)));
});

/** Enabling a disabled link issues a fresh token (old links stop working);
 *  disabling forgets the token. */
sharing.put("/:id/link", requireDocRole("owner"), vValidator("json", LinkInput), async (c) => {
  const doc = c.get("doc");
  const { enabled, role } = c.req.valid("json");
  const keep = enabled && doc.link?.enabled && doc.link.token;
  const token = enabled ? (keep ? doc.link!.token : newLinkToken()) : null;

  await DocumentModel.updateOne(
    { _id: doc._id },
    { $set: { link: { enabled, role, token } } },
    { timestamps: false },
  );

  return c.json(await toSharesResponse(await reload(doc)));
});

async function reload(doc: DocumentDoc): Promise<DocumentDoc> {
  return (await DocumentModel.findById(doc._id).lean<DocumentDoc>()) ?? doc;
}

async function toSharesResponse(doc: DocumentDoc) {
  const members = doc.members ?? [];
  const users = await publicUsers([doc.ownerId, ...members.map((m) => m.userId)]);
  const link = doc.link;
  return {
    owner: publicUser(users, doc.ownerId),
    members: members.map((m) => ({ ...publicUser(users, m.userId), role: m.role })),
    invites: (doc.invites ?? []).map((i) => ({ email: i.email, role: i.role })),
    link: {
      enabled: !!link?.enabled,
      role: link?.role ?? "viewer",
      ...(link?.enabled && link.token ? { token: link.token } : {}),
    },
  };
}
