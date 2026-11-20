import { expect } from "vitest";
import { Types } from "mongoose";
import { createApp } from "../app";
import { SESSION_COOKIE, signSession } from "../auth/jwt";
import { User } from "../models/user";

export const app = createApp();

export interface Actor {
  id: string;
  email: string;
  /** Sent as X-Share-Token when set. */
  shareToken?: string;
}

let seq = 0;

/** A real User row (needed wherever PublicUser fields or email matching
 *  matter). */
export async function makeUser(name = `u${++seq}`, email?: string): Promise<Actor> {
  const id = new Types.ObjectId();
  const mail = (email ?? `${name}-${id.toString().slice(-6)}@test.local`).toLowerCase();
  await User.create({ _id: id, email: mail, passwordHash: "x", displayName: name });
  return { id: id.toString(), email: mail };
}

export function withToken(actor: Actor, shareToken: string | undefined): Actor {
  return { ...actor, shareToken };
}

export async function api(actor: Actor, method: string, path: string, body?: unknown) {
  const token = signSession({ userId: actor.id, email: actor.email });
  const res = await app.request(path, {
    method,
    headers: {
      Cookie: `${SESSION_COOKIE}=${token}`,
      ...(actor.shareToken ? { "X-Share-Token": actor.shareToken } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json: any = text ? JSON.parse(text) : null;
  return { status: res.status, body: json };
}

export async function createDoc(owner: Actor, title = "Doc"): Promise<string> {
  const res = await api(owner, "POST", "/documents", { title });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

export const para = (id: string, text: string) => ({ id, type: "paragraph", data: { text } });

export async function revisionOf(actor: Actor, id: string): Promise<number> {
  const res = await api(actor, "GET", `/documents/${id}`);
  expect(res.status).toBe(200);
  return res.body.revision as number;
}

/** Save blocks a, b, … as a fresh document body. */
export async function seed(owner: Actor, id: string, ids: string[]) {
  const res = await api(owner, "PUT", `/documents/${id}/content`, {
    baseRevision: await revisionOf(owner, id),
    upserts: ids.map((b) => para(b, b.toUpperCase())),
    deletes: [],
    order: ids,
  });
  expect(res.status).toBe(200);
  return res.body.revision as number;
}

export async function share(owner: Actor, id: string, email: string, role: string) {
  const res = await api(owner, "PUT", `/documents/${id}/shares`, { email, role });
  expect(res.status).toBe(200);
  return res.body;
}
