/**
 * Who is on a document right now. Clients heartbeat every few seconds
 * (POST /documents/:id/presence); an entry expires PRESENCE_TTL_MS after its
 * last heartbeat.
 *
 * PER-PROCESS: this lives in memory, so it's only correct while the API runs
 * as a single instance. Behind a load balancer with several instances, move
 * it to a shared store (e.g. Redis hashes with a TTL) — the interface below
 * is all the routes use.
 */

export const PRESENCE_TTL_MS = 30_000;

/** Eight colours that keep ≥ 4.5:1 contrast with white text and are
 *  distinguishable for the common colour-vision deficiencies. */
export const PRESENCE_COLORS = [
  "#1f6feb", // blue
  "#c2410c", // orange
  "#047857", // green
  "#a21caf", // magenta
  "#b91c1c", // red
  "#0e7490", // teal
  "#6d28d9", // violet
  "#854d0e", // brown
] as const;

/** Stable colour per user: FNV-1a hash of the id into the palette. */
export function colorFor(userId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return PRESENCE_COLORS[(h >>> 0) % PRESENCE_COLORS.length]!;
}

export type PresenceState = "viewing" | "editing";

export interface PresenceEntry {
  userId: string;
  state: PresenceState;
  blockId: string | null;
  lastSeen: number;
}

export class PresenceStore {
  private readonly docs = new Map<string, Map<string, PresenceEntry>>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = PRESENCE_TTL_MS,
  ) {}

  /** Record a heartbeat and return everyone else still present. */
  heartbeat(
    documentId: string,
    userId: string,
    state: PresenceState,
    blockId: string | null,
  ): PresenceEntry[] {
    const now = this.now();
    let users = this.docs.get(documentId);
    if (!users) {
      users = new Map();
      this.docs.set(documentId, users);
    }
    users.set(userId, { userId, state, blockId, lastSeen: now });
    this.prune(documentId, now);
    return [...users.values()].filter((e) => e.userId !== userId);
  }

  /** Forget a document (deleted) or a single user on it (access revoked). */
  clear(documentId: string, userId?: string): void {
    if (userId === undefined) this.docs.delete(documentId);
    else this.docs.get(documentId)?.delete(userId);
  }

  /** Drop expired entries everywhere (called by the sweeper). */
  sweep(): void {
    const now = this.now();
    for (const id of [...this.docs.keys()]) this.prune(id, now);
  }

  size(): number {
    return this.docs.size;
  }

  private prune(documentId: string, now: number): void {
    const users = this.docs.get(documentId);
    if (!users) return;
    for (const [uid, e] of users) if (now - e.lastSeen > this.ttlMs) users.delete(uid);
    if (users.size === 0) this.docs.delete(documentId);
  }
}

/** The process-wide store used by the routes. */
export const presence = new PresenceStore(() => Date.now());

// Documents nobody heartbeats any more would otherwise linger forever.
setInterval(() => presence.sweep(), PRESENCE_TTL_MS).unref();
