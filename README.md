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

## Tests

```bash
pnpm test
```

Runs against an in-memory MongoDB replica set (`mongodb-memory-server`); the
first run downloads a `mongod` binary. Tests never read `.env`.
