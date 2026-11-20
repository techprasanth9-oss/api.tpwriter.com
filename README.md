# tp-writer-api

Backend for **TP Writer** — a Google-Docs / Zoho-Writer-style word processor.

- **Runtime:** Node.js 20+
- **Framework:** Hono
- **Validation:** Valibot (via `@hono/valibot-validator`)
- **DB:** MongoDB Atlas (Mongoose ODM)
- **Auth:** email + password (bcrypt), JWT session in httpOnly cookie

## Dev

```bash
cp .env.example .env
# edit MONGODB_URI with your Atlas SRV string
# edit JWT_SECRET with: openssl rand -hex 32
pnpm install
pnpm dev
```

API listens on `http://localhost:${PORT:-3001}`.

No database handy? `pnpm dev:memory` runs the API against a throwaway
in-memory MongoDB (nothing persists; your `.env` URI is not used). The
frontend's browser tests use it too.

## Document model

**v2 (current).** A document is one Editor.js block list; pagination is
computed visually on the FE, so pages are not stored.

- `Document` — metadata: `title`, `defaultLayout` (paper size, orientation,
  margins), `headerBlocks` / `footerBlocks`, `styles` (doc-level named styles,
  opaque to the server), `blockOrder` (ordered block ids), `revision` and
  `schemaVersion: 2`.
- `DocumentBlock` — one row per Editor.js block (`documentId`, `blockId`,
  `type`, `data`, `tunes`), unique on `(documentId, blockId)`. Small rows keep
  saves cheap and big docs far from the 16 MB BSON limit.

Content is saved incrementally with `PUT /documents/:id/content`
(`{ baseRevision, upserts, deletes, order? }`) in a single transaction.
`revision` is bumped on every save. `order` (the full new block order) is
required whenever blocks are added or deleted. `PATCH /documents/:id`
updates metadata only, returns it without blocks, and also bumps
`revision` (so other clients see it in the changes feed).

**Block-level merge.** Each `DocumentBlock` records `rev` (the revision that
last wrote it); deleted blocks stay as tombstones (`deleted: true`) for ~500
revisions. A save from a stale `baseRevision` is still applied — response
`{ revision, updatedAt, merged: true }` — when none of its upserted/deleted
blocks were written after `baseRevision` and, if it sends `order`, the order
hasn't changed since (`Document.orderRev`). Otherwise
`409 { error: "revision_conflict", revision, conflicts: [blockId…, "order"?] }`.
Saves are serialised by the revision bump being the transaction's first
write.

**v1 (legacy).** Documents without `schemaVersion: 2` stored content as N
`DocumentPage` rows. They're migrated lazily on first read
(`src/migrations/v2.ts`): page blocks are concatenated in page order and given
unique ids; per-page layout overrides are dropped; the old page rows are kept
for rollback.

Transactions require MongoDB running as a replica set (Atlas always is).

## PDF export

`POST /documents/:id/pdf` returns the document as `application/pdf`,
rendered exactly as the editor paginates it: headless Chromium
(`playwright-core`) opens the frontend's print route
`${APP_URL}/documents/:id/print` with the caller's session cookie, waits for
the page to set `window.__TP_PRINT_READY__`, and prints with the page's own
`@page` sizes (mixed paper sizes / orientations come out per page).
`GET /pdf/status` answers `200 { enabled: true }` or `501` so the frontend
can hide the option.

- `APP_URL` (required to enable it) — the frontend's public URL. Unset →
  `501 { error: "pdf_not_configured" }`.
- `API_PUBLIC_URL` — the URL the frontend calls this API on, when it's a
  different origin from `APP_URL`; the session cookie is set for it too.
- `CHROMIUM_PATH` — browser binary. Unset → playwright-core's default
  install location (`npx playwright-core install chromium`; on Linux also
  `npx playwright-core install-deps chromium`).
- `PDF_CONCURRENCY` — simultaneous renders (default 2).

Access is checked like every document route (viewer+; 404 without
access). A caller reading through a share link has the token passed to the
print page as `?share=`. Renders are limited to 10/min per user (429), and a render that
doesn't finish in 30 s answers 504. One browser is shared across requests
(launched on first use); each render runs in a fresh context that may only
load `APP_URL` / `API_PUBLIC_URL` and Google Fonts — every other request is
blocked, and no URL comes from the request.

## Sharing

Roles, weakest to strongest: **viewer** (read the doc, changes, presence,
comments) < **commenter** (+ create / reply / resolve threads, edit/delete own
comments) < **editor** (+ save content, PATCH meta, version history and
restore, view shares) < **owner** (+ sharing, delete). Every document route
resolves the caller's role in `src/auth/access.ts`; no access at all is a
`404` (existence isn't leaked), too weak a role is `403 { error: "forbidden" }`.

A caller's role is the strongest of:

- **owner** — `Document.ownerId`;
- **member** — `Document.members[{ userId, role }]`;
- **invite** — `Document.invites[{ email, role }]` for people without an
  account yet. Converted to a membership at signup / login, when listing
  documents, or the first time they open the document;
- **link** — `Document.link { enabled, role, token }`. A signed-in user
  sending `X-Share-Token: <token>` gets the link's role for that document
  only (it never appears in their list). The token is 24 random bytes
  (base64url), compared in constant time; disabling forgets it, so
  re-enabling issues a new one.

| Route | Role |
| --- | --- |
| `GET /documents` | own + shared docs, each with `role` and `owner` |
| `GET /documents/:id/shares` | editor |
| `PUT /documents/:id/shares` `{ email, role }` | owner — member if the email has an account, else invite; the owner's email is a 400 |
| `DELETE /documents/:id/shares/:who` | owner — `who` is a user id or invited email |
| `PUT /documents/:id/link` `{ enabled, role }` | owner |

## Collaboration

| Route | Role | |
| --- | --- | --- |
| `GET /documents/:id/changes?since=R` | viewer | `{ revision, upserts, deletes, order?, meta?, commentsVersion }` for everything after R; `{ reset: true }` when R is older than the oldest diffable revision (`diffFloor`); R > revision → 400 |
| `POST /documents/:id/presence` `{ state, blockId }` | viewer | heartbeat; returns everyone else present (public fields + stable colour). Entries expire after 30 s |
| `GET /documents/:id/comments` | viewer | threads with comments |
| `POST /documents/:id/comments` `{ anchor, body }` | commenter | new thread (30 comments/min/user) |
| `POST /documents/:id/comments/:tid/replies` `{ body }` | commenter | reply |
| `PATCH /documents/:id/comments/:tid` `{ resolved }` | commenter | resolve / reopen |
| `PATCH /documents/:id/comments/:tid/replies/:cid` `{ body }` | own comment | edit |
| `DELETE /documents/:id/comments/:tid/replies/:cid` | own comment | the first comment deletes the thread (its author or editor+) |
| `GET /notifications`, `POST /notifications/read` `{ ids }` | — | your mentions, newest first |
| `GET /documents/:id/versions[/:vid]` | editor | history, newest first / one version with content |
| `POST /documents/:id/versions` `{ label }` | editor | named version |
| `POST /documents/:id/versions/:vid/restore` | editor | saves the current state as "Before restore", then replaces content + meta; returns `{ revision }` |

- **Comments** (`CommentThread`, comments embedded): anchor
  `{ blockId, quote ≤ 1000, prefix ≤ 64, suffix ≤ 64 }`, body 1–5000 chars of
  plain text. Mentions are written `@[Name](userId)`; only users with real
  access (owner / member) are kept, and each gets a `Notification` (not the
  author). Every comment change bumps `Document.commentsVersion`.
- **Versions** (`DocumentVersion`): full snapshots. An automatic one is taken
  after a content save when the newest version is over 10 minutes old;
  named ones on request. All named versions and the newest 50 automatic ones
  are kept. Snapshots over ~10 MB are skipped with a warning (a named one
  answers 413).
- **Presence is per-process** (in memory). Run a single API instance, or
  move `src/collab/presence.ts` to a shared store before scaling out.
- Deleting a document also deletes its blocks, versions, comments and
  notifications.
- Documents written before Phase 6 need no migration: missing `rev`,
  `orderRev`, `metaRev`, `commentsVersion` read as 0, and `diffFloor` is set
  to the current revision on first access (earlier deletes left no
  tombstones, so older revisions answer `reset`).

## Tests

```bash
pnpm test
```

Runs against an in-memory MongoDB replica set (`mongodb-memory-server`); the
first run downloads a `mongod` binary. Tests never read `.env`.
