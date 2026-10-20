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

Modeled after `api.esigns.io`: each document is a metadata row that owns N
`document_pages`, where each page stores EditorJS `OutputData` + an optional
layout override. The default layout (paper size, orientation, margins) lives
on the document itself; headers / footers are block arrays also on the
document, rendered on every page.
