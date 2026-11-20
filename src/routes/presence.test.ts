import { afterEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import { colorFor, PRESENCE_COLORS, PRESENCE_TTL_MS, PresenceStore } from "../collab/presence";
import { api, createDoc, makeUser, share } from "../test/helpers";

describe("presence store", () => {
  it("expires entries after the TTL (injected clock)", () => {
    let now = 1_000_000;
    const store = new PresenceStore(() => now);
    store.heartbeat("d", "alice", "viewing", null);
    expect(store.heartbeat("d", "bob", "editing", "b1")).toEqual([
      { userId: "alice", state: "viewing", blockId: null, lastSeen: 1_000_000 },
    ]);
    now += PRESENCE_TTL_MS - 1;
    expect(store.heartbeat("d", "bob", "editing", "b2").map((e) => e.userId)).toEqual(["alice"]);
    now += 2;
    expect(store.heartbeat("d", "bob", "editing", "b2")).toEqual([]);

    // The sweeper drops documents nobody is on any more.
    now += PRESENCE_TTL_MS + 1;
    store.sweep();
    expect(store.size()).toBe(0);
  });

  it("clears a document or a single user", () => {
    const store = new PresenceStore(() => 0);
    store.heartbeat("d", "a", "viewing", null);
    store.heartbeat("d", "b", "viewing", null);
    store.clear("d", "a");
    expect(store.heartbeat("d", "c", "viewing", null).map((e) => e.userId)).toEqual(["b"]);
    store.clear("d");
    expect(store.size()).toBe(0);
  });

  it("gives each user a stable colour from the palette", () => {
    const ids = Array.from({ length: 200 }, () => new Types.ObjectId().toString());
    for (const id of ids) {
      expect(PRESENCE_COLORS).toContain(colorFor(id));
      expect(colorFor(id)).toBe(colorFor(id));
    }
    // Spread over the palette rather than piling onto one colour.
    expect(new Set(ids.map(colorFor)).size).toBe(PRESENCE_COLORS.length);
  });
});

describe("POST /documents/:id/presence", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns everyone else with public fields and colour, and expires them", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-20T10:00:00Z"));

    const alice = await makeUser("Alice");
    const bob = await makeUser("Bob");
    const id = await createDoc(alice);
    await share(alice, id, bob.email, "viewer");

    const first = await api(alice, "POST", `/documents/${id}/presence`, { state: "editing", blockId: "b1" });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ present: [] });

    const bobs = await api(bob, "POST", `/documents/${id}/presence`, { state: "viewing", blockId: null });
    expect(bobs.body.present).toEqual([
      {
        id: alice.id,
        email: alice.email,
        displayName: "Alice",
        state: "editing",
        blockId: "b1",
        color: colorFor(alice.id),
        lastSeen: "2026-11-20T10:00:00.000Z",
      },
    ]);

    vi.setSystemTime(new Date("2026-11-20T10:00:20Z"));
    expect((await api(alice, "POST", `/documents/${id}/presence`, { state: "viewing" })).body.present).toEqual([
      expect.objectContaining({ id: bob.id, state: "viewing", blockId: null, color: colorFor(bob.id) }),
    ]);

    // Bob stops heartbeating; 31 s after his last one he's gone.
    vi.setSystemTime(new Date("2026-11-20T10:00:51Z"));
    expect((await api(alice, "POST", `/documents/${id}/presence`, { state: "viewing", blockId: null })).body.present).toEqual([]);
  });

  it("validates input and hides the document from strangers", async () => {
    const alice = await makeUser();
    const eve = await makeUser();
    const id = await createDoc(alice);
    expect((await api(alice, "POST", `/documents/${id}/presence`, { state: "typing", blockId: null })).status).toBe(400);
    expect((await api(alice, "POST", `/documents/${id}/presence`, { state: "editing", blockId: "bad id" })).status).toBe(400);
    expect((await api(eve, "POST", `/documents/${id}/presence`, { state: "viewing", blockId: null })).status).toBe(404);
  });
});
