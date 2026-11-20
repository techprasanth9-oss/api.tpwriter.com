import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { Types, isValidObjectId } from "mongoose";
import { DocumentModel, type DocumentDoc, type ShareRole } from "../models/document";
import { ensureV2 } from "../migrations/v2";
import type { SessionPayload } from "./jwt";

/**
 * Document access control (Phase 6).
 *
 * Roles, weakest to strongest: viewer < commenter < editor < owner.
 *   viewer    — read the document, changes, presence, comments, notifications
 *   commenter — + create / reply / resolve threads, edit / delete own comments
 *   editor    — + content save, PATCH meta, versions, view shares
 *   owner     — + sharing (members, invites, link), delete the document
 *
 * A caller's role on a document is the strongest of:
 *   - owner (`ownerId`)
 *   - membership (`members[]`)
 *   - a pending invite for their email — converted to a membership on the
 *     spot (and for all their documents at signup / login / list)
 *   - the document's share link, when the request carries a matching
 *     `X-Share-Token` header. Only honoured for that one document; it never
 *     adds the document to anyone's list. Signed-in users only.
 *
 * No access at all → 404 (indistinguishable from a missing document); some
 * access but too weak a role → 403 `forbidden`.
 */

export type Role = ShareRole | "owner";

export const ROLE_RANK: Record<Role, number> = { viewer: 0, commenter: 1, editor: 2, owner: 3 };

export function atLeast(role: Role | null | undefined, needed: Role): boolean {
  return !!role && ROLE_RANK[role] >= ROLE_RANK[needed];
}

function stronger<R extends Role>(a: R | null, b: R | null): R | null {
  if (!a) return b;
  if (!b) return a;
  return ROLE_RANK[a] >= ROLE_RANK[b] ? a : b;
}

export const SHARE_TOKEN_HEADER = "x-share-token";

// ── Link tokens ─────────────────────────────────────────────────────────

/** 24 random bytes, URL-safe (32 chars). */
export function newLinkToken(): string {
  return randomBytes(24).toString("base64url");
}

/** Constant-time comparison. Hashing first gives equal-length buffers, so
 *  neither the content nor the length of the stored token leaks. */
export function tokenMatches(presented: string, stored: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(stored).digest();
  return timingSafeEqual(a, b);
}

// ── Role resolution ─────────────────────────────────────────────────────

type AccessFields = Pick<DocumentDoc, "ownerId" | "members" | "invites" | "link">;

/** Owner or member role — the "real" access that survives without a link
 *  token (used for mentions, notifications and the documents list). */
export function memberRole(doc: AccessFields, userId: string): Role | null {
  if (doc.ownerId.toString() === userId) return "owner";
  const m = doc.members?.find((x) => x.userId.toString() === userId);
  return m ? m.role : null;
}

export function linkRole(doc: AccessFields, shareToken: string | undefined): ShareRole | null {
  const link = doc.link;
  if (!shareToken || !link?.enabled || !link.token) return null;
  return tokenMatches(shareToken, link.token) ? link.role : null;
}

export function inviteFor(doc: AccessFields, email: string): ShareRole | null {
  const e = email.toLowerCase();
  return doc.invites?.find((i) => i.email === e)?.role ?? null;
}

/** Turn a pending invite for `email` on `docId` into a membership for
 *  `userId` (keeping an existing membership if it's stronger). */
async function convertInvite(
  docId: Types.ObjectId,
  userId: string,
  email: string,
  role: ShareRole,
  current: ShareRole | null,
): Promise<void> {
  const e = email.toLowerCase();
  const uid = new Types.ObjectId(userId);
  if (!current) {
    const res = await DocumentModel.updateOne(
      { _id: docId, "invites.email": e, "members.userId": { $ne: uid }, ownerId: { $ne: uid } },
      { $pull: { invites: { email: e } }, $push: { members: { userId: uid, role } } },
      { timestamps: false },
    );
    if (res.matchedCount > 0) return;
  }
  const upgrade = current && ROLE_RANK[role] > ROLE_RANK[current];
  await DocumentModel.updateOne(
    { _id: docId, "invites.email": e },
    {
      $pull: { invites: { email: e } },
      ...(upgrade ? { $set: { "members.$[m].role": role } } : {}),
    },
    { timestamps: false, ...(upgrade ? { arrayFilters: [{ "m.userId": uid }] } : {}) },
  );
}

/** Convert every pending invite for this email (signup, login, list). */
export async function convertInvites(userId: string, email: string): Promise<void> {
  const e = email.toLowerCase();
  const docs = await DocumentModel.find(
    { "invites.email": e },
    { ownerId: 1, members: 1, invites: 1 },
  ).lean<Pick<DocumentDoc, "_id" | "ownerId" | "members" | "invites">[]>();
  for (const doc of docs) {
    const role = inviteFor(doc, e);
    if (!role) continue;
    const current = memberRole(doc, userId);
    // The owner can't be invited to their own document; just drop it.
    await convertInvite(doc._id, userId, e, role, current === "owner" ? "editor" : (current as ShareRole | null));
  }
}

/**
 * Phase 6 fields on a pre-Phase-6 v2 doc: deletes before now left no
 * tombstones, so the changes feed can only diff from the current revision.
 * Atomic and idempotent (only sets a missing `diffFloor`).
 */
async function upgradeCollab(doc: DocumentDoc): Promise<DocumentDoc | null> {
  if (doc.diffFloor !== undefined) return doc;
  await DocumentModel.updateOne(
    { _id: doc._id, diffFloor: { $exists: false } },
    [{ $set: { diffFloor: { $ifNull: ["$revision", 1] } } }],
    { timestamps: false },
  );
  return DocumentModel.findById(doc._id).lean<DocumentDoc>();
}

export interface DocAccess {
  doc: DocumentDoc;
  role: Role;
}

/**
 * Load a document with the caller's role, migrating it to the current
 * schema. `null` → no access (respond 404).
 */
export async function loadDocAccess(
  id: string,
  session: SessionPayload,
  shareToken: string | undefined,
): Promise<DocAccess | null> {
  if (!isValidObjectId(id)) return null;
  const raw = await DocumentModel.findById(id).lean<DocumentDoc>();
  if (!raw) return null;

  const own = memberRole(raw, session.userId);
  const invited = own === "owner" ? null : inviteFor(raw, session.email);
  const role = stronger<Role>(stronger<Role>(own, invited), linkRole(raw, shareToken));
  if (!role) return null;

  if (invited) {
    await convertInvite(raw._id, session.userId, session.email, invited, own as ShareRole | null);
  }

  const v2 = await ensureV2(raw);
  const doc = v2 && (await upgradeCollab(v2));
  if (!doc) return null;
  return { doc, role };
}

export interface DocEnv {
  Variables: {
    session: SessionPayload;
    doc: DocumentDoc;
    role: Role;
  };
}

/**
 * Route middleware: resolve `:id` and require at least `needed`. Sets
 * `c.var.doc` (lean, migrated) and `c.var.role`. Mount after requireAuth.
 */
export function requireDocRole(needed: Role): MiddlewareHandler<DocEnv> {
  return async (c, next) => {
    const access = await loadDocAccess(
      c.req.param("id") ?? "",
      c.get("session"),
      c.req.header(SHARE_TOKEN_HEADER) || undefined,
    );
    if (!access) return c.json({ error: "not_found" }, 404);
    if (!atLeast(access.role, needed)) return c.json({ error: "forbidden" }, 403);
    c.set("doc", access.doc);
    c.set("role", access.role);
    await next();
  };
}
