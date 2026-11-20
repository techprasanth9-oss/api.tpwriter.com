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
`revision` is bumped on every save; a stale `baseRevision` gets
`409 { error: "revision_conflict", revision }`. `order` (the full new block
order) is required whenever blocks are added or deleted. `PATCH
/documents/:id` updates metadata only and returns it without blocks.

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

Ownership is checked like every document route (404 for other users'
docs), renders are limited to 10/min per user (429), and a render that
doesn't finish in 30 s answers 504. One browser is shared across requests
(launched on first use); each render runs in a fresh context that may only
load `APP_URL` / `API_PUBLIC_URL` and Google Fonts — every other request is
blocked, and no URL comes from the request.

## Tests

```bash
pnpm test
```

Runs against an in-memory MongoDB replica set (`mongodb-memory-server`); the
first run downloads a `mongod` binary. Tests never read `.env`.
