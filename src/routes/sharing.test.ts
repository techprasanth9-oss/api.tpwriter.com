import { describe, expect, it } from "vitest";
import { DocumentModel } from "../models/document";
import { User } from "../models/user";
import { hashPassword } from "../auth/password";
import { tokenMatches } from "../auth/access";
import {
  api,
  app,
  createDoc,
  makeUser,
  para,
  share,
  withToken,
  type Actor,
} from "../test/helpers";

type Role = "viewer" | "commenter" | "editor" | "owner";
const RANK: Record<Role, number> = { viewer: 0, commenter: 1, editor: 2, owner: 3 };

interface Fixture {
  id: string;
  owner: Actor;
  threadId: string;
  versionId: string;
  actors: { name: string; actor: Actor; role: Role | null }[];
}

/** One document with every kind of caller. The link grants "commenter";
 *  "invited" was invited by email before having an account and is
 *  converted the first time they touch the document. */
async function fixture(): Promise<Fixture> {
  const owner = await makeUser("owner");
  const viewer = await makeUser("viewer");
  const commenter = await makeUser("commenter");
  const editor = await makeUser("editor");
  const stranger = await makeUser("stranger");
  const id = await createDoc(owner);

  await share(owner, id, viewer.email, "viewer");
  await share(owner, id, commenter.email, "commenter");
  await share(owner, id, editor.email, "editor");
  const invitedEmail = `invitee-${id}@test.local`;
  const pending = await share(owner, id, invitedEmail, "editor");
  expect(pending.invites).toEqual([{ email: invitedEmail, role: "editor" }]);
  const invited = await makeUser("invited", invitedEmail);

  const link = await api(owner, "PUT", `/documents/${id}/link`, { enabled: true, role: "commenter" });
  expect(link.status).toBe(200);
  const linkHolder = withToken(await makeUser("linkholder"), link.body.link.token);

  await api(owner, "PUT", `/documents/${id}/content`, {
    baseRevision: 1,
    upserts: [para("a", "A")],
    deletes: [],
    order: ["a"],
  });
  const thread = await api(owner, "POST", `/documents/${id}/comments`, {
    anchor: { blockId: "a", quote: "A", prefix: "", suffix: "" },
    body: "First",
  });
  expect(thread.status).toBe(201);
  const version = await api(owner, "POST", `/documents/${id}/versions`, { label: "v1" });
  expect(version.status).toBe(201);

  return {
    id,
    owner,
    threadId: thread.body.id,
    versionId: version.body.id,
    // Weakest first; the owner goes last so DELETE runs after the denials.
    actors: [
      { name: "stranger", actor: stranger, role: null },
      // Token for a *different* doc grants nothing here.
      { name: "stranger+wrong token", actor: withToken(stranger, "x".repeat(32)), role: null },
      { name: "viewer", actor: viewer, role: "viewer" },
      { name: "link holder", actor: linkHolder, role: "commenter" },
      { name: "commenter", actor: commenter, role: "commenter" },
      { name: "invited→signed up", actor: invited, role: "editor" },
      { name: "editor", actor: editor, role: "editor" },
      { name: "owner", actor: owner, role: "owner" },
    ],
  };
}

async function currentRevision(id: string) {
  return (await DocumentModel.findById(id).lean())!.revision!;
}

const ROUTES: {
  name: string;
  min: Role;
  call: (f: Fixture, a: Actor, i: number) => Promise<{ status: number; body: any }>;
}[] = [
  { name: "GET doc", min: "viewer", call: (f, a) => api(a, "GET", `/documents/${f.id}`) },
  { name: "GET changes", min: "viewer", call: (f, a) => api(a, "GET", `/documents/${f.id}/changes?since=1`) },
  {
    name: "POST presence",
    min: "viewer",
    call: (f, a) => api(a, "POST", `/documents/${f.id}/presence`, { state: "viewing", blockId: null }),
  },
  { name: "GET comments", min: "viewer", call: (f, a) => api(a, "GET", `/documents/${f.id}/comments`) },
  {
    name: "POST thread",
    min: "commenter",
    call: (f, a) =>
      api(a, "POST", `/documents/${f.id}/comments`, {
        anchor: { blockId: "a", quote: "A", prefix: "", suffix: "" },
        body: "hi",
      }),
  },
  {
    name: "POST reply",
    min: "commenter",
    call: (f, a) => api(a, "POST", `/documents/${f.id}/comments/${f.threadId}/replies`, { body: "re" }),
  },
  {
    name: "PATCH resolve",
    min: "commenter",
    call: (f, a, i) =>
      api(a, "PATCH", `/documents/${f.id}/comments/${f.threadId}`, { resolved: i % 2 === 0 }),
  },
  {
    name: "PUT content",
    min: "editor",
    call: async (f, a, i) =>
      api(a, "PUT", `/documents/${f.id}/content`, {
        baseRevision: await currentRevision(f.id),
        upserts: [para("a", `edit ${i}`)],
        deletes: [],
      }),
  },
  { name: "PATCH meta", min: "editor", call: (f, a, i) => api(a, "PATCH", `/documents/${f.id}`, { title: `T${i}` }) },
  { name: "GET versions", min: "editor", call: (f, a) => api(a, "GET", `/documents/${f.id}/versions`) },
  {
    name: "GET version",
    min: "editor",
    call: (f, a) => api(a, "GET", `/documents/${f.id}/versions/${f.versionId}`),
  },
  {
    name: "POST version",
    min: "editor",
    call: (f, a) => api(a, "POST", `/documents/${f.id}/versions`, { label: "named" }),
  },
  {
    name: "POST restore",
    min: "editor",
    call: (f, a) => api(a, "POST", `/documents/${f.id}/versions/${f.versionId}/restore`),
  },
  { name: "GET shares", min: "editor", call: (f, a) => api(a, "GET", `/documents/${f.id}/shares`) },
  {
    name: "PUT shares",
    min: "owner",
    call: (f, a) => api(a, "PUT", `/documents/${f.id}/shares`, { email: "new@test.local", role: "viewer" }),
  },
  {
    name: "DELETE share",
    min: "owner",
    call: (f, a) => api(a, "DELETE", `/documents/${f.id}/shares/new@test.local`),
  },
  {
    name: "PUT link",
    min: "owner",
    call: (f, a) => api(a, "PUT", `/documents/${f.id}/link`, { enabled: true, role: "commenter" }),
  },
  { name: "DELETE doc", min: "owner", call: (f, a) => api(a, "DELETE", `/documents/${f.id}`) },
];

describe("role matrix", () => {
  it.each(ROUTES)("$name requires $min", async ({ min, call }) => {
    const f = await fixture();
    const results: Record<string, number> = {};
    const expected: Record<string, number | "2xx"> = {};
    let i = 0;
    for (const { name, actor, role } of f.actors) {
      const res = await call(f, actor, i++);
      const ok = res.status >= 200 && res.status < 300;
      results[name] = ok ? 200 : res.status;
      expected[name] = role === null ? 404 : RANK[role] >= RANK[min] ? 200 : 403;
    }
    expect(results).toEqual(expected);
  });
});

describe("sharing", () => {
  it("lists own and shared docs with role and owner; link access never lists", async () => {
    const owner = await makeUser("Olivia");
    const bob = await makeUser("Bob");
    const linkUser = await makeUser("Lin");
    const mine = await createDoc(owner, "Mine");
    const bobs = await createDoc(bob, "Bob's");
    await share(bob, bobs, owner.email, "commenter");
    const link = await api(bob, "PUT", `/documents/${bobs}/link`, { enabled: true, role: "editor" });

    const list = await api(owner, "GET", "/documents");
    expect(list.status).toBe(200);
    const byId = Object.fromEntries(list.body.map((d: any) => [d.id, d]));
    expect(byId[mine]).toMatchObject({
      role: "owner",
      owner: { id: owner.id, email: owner.email, displayName: "Olivia" },
      blockCount: 0,
    });
    expect(byId[bobs]).toMatchObject({
      role: "commenter",
      owner: { id: bob.id, email: bob.email, displayName: "Bob" },
    });

    // GET carries the caller's role.
    expect((await api(owner, "GET", `/documents/${bobs}`)).body.role).toBe("commenter");
    expect((await api(bob, "GET", `/documents/${bobs}`)).body.role).toBe("owner");

    // The link opens it, but it never shows up in the holder's list.
    const viaLink = withToken(linkUser, link.body.link.token);
    expect((await api(viaLink, "GET", `/documents/${bobs}`)).body.role).toBe("editor");
    expect((await api(viaLink, "GET", "/documents")).body).toEqual([]);
  });

  it("the stronger of membership and link wins", async () => {
    const owner = await makeUser();
    const member = await makeUser();
    const id = await createDoc(owner);
    await share(owner, id, member.email, "viewer");
    const link = await api(owner, "PUT", `/documents/${id}/link`, { enabled: true, role: "editor" });
    expect((await api(member, "GET", `/documents/${id}`)).body.role).toBe("viewer");
    const both = withToken(member, link.body.link.token);
    expect((await api(both, "GET", `/documents/${id}`)).body.role).toBe("editor");

    await share(owner, id, member.email, "editor");
    await api(owner, "PUT", `/documents/${id}/link`, { enabled: true, role: "viewer" });
    expect((await api(both, "GET", `/documents/${id}`)).body.role).toBe("editor");
  });

  it("rotates the link token on re-enable and scopes it to one document", async () => {
    const owner = await makeUser();
    const reader = await makeUser();
    const id = await createDoc(owner);
    const other = await createDoc(owner, "Other");

    const off = await api(owner, "GET", `/documents/${id}/shares`);
    expect(off.body.link).toEqual({ enabled: false, role: "viewer" });

    const on1 = await api(owner, "PUT", `/documents/${id}/link`, { enabled: true, role: "viewer" });
    const t1: string = on1.body.link.token;
    expect(t1).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(on1.body.link).toEqual({ enabled: true, role: "viewer", token: t1 });

    expect((await api(withToken(reader, t1), "GET", `/documents/${id}`)).status).toBe(200);
    // Same token, other document: nothing.
    expect((await api(withToken(reader, t1), "GET", `/documents/${other}`)).status).toBe(404);
    // Viewer via link can't write.
    expect((await api(withToken(reader, t1), "PATCH", `/documents/${id}`, { title: "x" })).status).toBe(403);

    // Changing the role while enabled keeps the token.
    const upgraded = await api(owner, "PUT", `/documents/${id}/link`, { enabled: true, role: "editor" });
    expect(upgraded.body.link.token).toBe(t1);
    expect((await api(withToken(reader, t1), "PATCH", `/documents/${id}`, { title: "x" })).status).toBe(200);

    const disabled = await api(owner, "PUT", `/documents/${id}/link`, { enabled: false, role: "editor" });
    expect(disabled.body.link).toEqual({ enabled: false, role: "editor" });
    expect((await api(withToken(reader, t1), "GET", `/documents/${id}`)).status).toBe(404);

    const on2 = await api(owner, "PUT", `/documents/${id}/link`, { enabled: true, role: "viewer" });
    const t2: string = on2.body.link.token;
    expect(t2).not.toBe(t1);
    expect((await api(withToken(reader, t1), "GET", `/documents/${id}`)).status).toBe(404);
    expect((await api(withToken(reader, t2), "GET", `/documents/${id}`)).status).toBe(200);

    expect(tokenMatches(t2, t2)).toBe(true);
    expect(tokenMatches(t1, t2)).toBe(false);
    expect(tokenMatches("", t2)).toBe(false);
  });

  it("requires a session even with a valid token (no anonymous access)", async () => {
    const owner = await makeUser();
    const id = await createDoc(owner);
    const on = await api(owner, "PUT", `/documents/${id}/link`, { enabled: true, role: "viewer" });
    const res = await app.request(`/documents/${id}`, { headers: { "X-Share-Token": on.body.link.token } });
    expect(res.status).toBe(401);
  });

  it("adds members by email, invites unknown emails, updates and removes", async () => {
    const owner = await makeUser("Owner");
    const bob = await makeUser("Bob");
    const id = await createDoc(owner);

    let shares = await share(owner, id, bob.email.toUpperCase(), "viewer");
    expect(shares.owner).toEqual({ id: owner.id, email: owner.email, displayName: "Owner" });
    expect(shares.members).toEqual([{ id: bob.id, email: bob.email, displayName: "Bob", role: "viewer" }]);

    shares = await share(owner, id, bob.email, "editor");
    expect(shares.members).toEqual([expect.objectContaining({ id: bob.id, role: "editor" })]);

    shares = await share(owner, id, "Nobody@Test.Local", "commenter");
    expect(shares.invites).toEqual([{ email: "nobody@test.local", role: "commenter" }]);
    shares = await share(owner, id, "nobody@test.local", "viewer");
    expect(shares.invites).toEqual([{ email: "nobody@test.local", role: "viewer" }]);

    // Editors can look but not change.
    expect((await api(bob, "GET", `/documents/${id}/shares`)).body.members).toHaveLength(1);
    expect((await api(bob, "PUT", `/documents/${id}/shares`, { email: "z@test.local", role: "viewer" })).status).toBe(403);

    let del = await api(owner, "DELETE", `/documents/${id}/shares/${encodeURIComponent("nobody@test.local")}`);
    expect(del.body.invites).toEqual([]);
    del = await api(owner, "DELETE", `/documents/${id}/shares/${bob.id}`);
    expect(del.body.members).toEqual([]);
    expect((await api(bob, "GET", `/documents/${id}`)).status).toBe(404);
    // Idempotent.
    expect((await api(owner, "DELETE", `/documents/${id}/shares/${bob.id}`)).status).toBe(200);
  });

  it("lists people to @mention for commenters, without invites or the link token", async () => {
    const owner = await makeUser("Owner");
    const carol = await makeUser("Carol");
    const vic = await makeUser("Vic");
    const id = await createDoc(owner);
    await share(owner, id, carol.email, "commenter");
    await share(owner, id, vic.email, "viewer");
    await share(owner, id, "pending@test.local", "editor");

    const res = await api(carol, "GET", `/documents/${id}/people`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: owner.id, email: owner.email, displayName: "Owner" },
      { id: carol.id, email: carol.email, displayName: "Carol" },
      { id: vic.id, email: vic.email, displayName: "Vic" },
    ]);
    expect((await api(vic, "GET", `/documents/${id}/people`)).status).toBe(403);
    expect((await api(await makeUser("Stranger"), "GET", `/documents/${id}/people`)).status).toBe(404);
  });

  it("rejects sharing with the owner and invalid input", async () => {
    const owner = await makeUser();
    const id = await createDoc(owner);
    const self = await api(owner, "PUT", `/documents/${id}/shares`, { email: owner.email.toUpperCase(), role: "editor" });
    expect(self.status).toBe(400);
    expect(self.body).toEqual({ error: "cannot_share_with_owner" });
    for (const body of [
      { email: "x@test.local", role: "owner" },
      { email: "x@test.local", role: "admin" },
      { email: "not-an-email", role: "viewer" },
      { email: "x@test.local" },
    ]) {
      expect((await api(owner, "PUT", `/documents/${id}/shares`, body)).status).toBe(400);
    }
    expect((await api(owner, "PUT", `/documents/${id}/link`, { enabled: true, role: "owner" })).status).toBe(400);
  });

  it("converts invites at signup", async () => {
    const owner = await makeUser();
    const id = await createDoc(owner, "Shared before signup");
    await share(owner, id, "newbie@test.local", "commenter");

    const res = await app.request("/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "NewBie@test.local", password: "password123" }),
    });
    expect(res.status).toBe(201);
    const newbie = (await res.json()) as { id: string; email: string };

    const doc = await DocumentModel.findById(id).lean();
    expect(doc?.invites).toEqual([]);
    expect(doc?.members?.map((m) => [m.userId.toString(), m.role])).toEqual([[newbie.id, "commenter"]]);

    const list = await api(newbie, "GET", "/documents");
    expect(list.body).toEqual([expect.objectContaining({ id, role: "commenter" })]);
  });

  it("converts invites at login and keeps the stronger of invite and membership", async () => {
    const owner = await makeUser();
    const id1 = await createDoc(owner, "One");
    const id2 = await createDoc(owner, "Two");
    const carol = await User.create({
      email: "carol@test.local",
      passwordHash: await hashPassword("password123"),
      displayName: "Carol",
    });
    // Invites recorded directly (as if made before the account existed).
    await DocumentModel.updateOne({ _id: id1 }, { $set: { invites: [{ email: "carol@test.local", role: "editor" }] } });
    await DocumentModel.updateOne(
      { _id: id2 },
      {
        $set: {
          members: [{ userId: carol._id, role: "commenter" }],
          invites: [{ email: "carol@test.local", role: "viewer" }],
        },
      },
    );

    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "carol@test.local", password: "password123" }),
    });
    expect(res.status).toBe(200);

    const d1 = await DocumentModel.findById(id1).lean();
    const d2 = await DocumentModel.findById(id2).lean();
    expect(d1?.invites).toEqual([]);
    expect(d1?.members?.map((m) => m.role)).toEqual(["editor"]);
    expect(d2?.invites).toEqual([]);
    expect(d2?.members?.map((m) => m.role)).toEqual(["commenter"]);
  });
});
