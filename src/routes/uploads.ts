import { Hono } from "hono";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { nanoid } from "nanoid";
import { requireAuth, type AuthContext } from "../auth/middleware";

const UPLOAD_DIR = path.resolve(process.cwd(), "data/uploads");
const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);
const extFromMime: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
};
const mimeFromExt: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

export const uploads = new Hono<AuthContext>();

uploads.post("/", requireAuth, async (c) => {
  await mkdir(UPLOAD_DIR, { recursive: true });

  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: "invalid_form" }, 400);

  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "no_file" }, 400);
  if (!ALLOWED_MIME.has(file.type))
    return c.json({ error: "unsupported_mime", mime: file.type }, 415);
  if (file.size > MAX_BYTES)
    return c.json({ error: "too_large", max: MAX_BYTES }, 413);

  const id = nanoid(16);
  const ext = extFromMime[file.type] ?? "";
  const filename = `${id}${ext}`;
  const target = path.join(UPLOAD_DIR, filename);

  const nodeStream = Readable.fromWeb(file.stream() as never);
  await pipeline(nodeStream, createWriteStream(target));

  return c.json(
    { url: `/uploads/${filename}`, filename, size: file.size, mime: file.type },
    201,
  );
});

// Public read — image URLs are embedded in documents and need to render in
// &lt;img src="/uploads/..." /&gt; without a session.
uploads.get("/:filename", async (c) => {
  const filename = c.req.param("filename");
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(filename))
    return c.json({ error: "bad_filename" }, 400);
  const target = path.join(UPLOAD_DIR, filename);
  const info = await stat(target).catch(() => null);
  if (!info) return c.json({ error: "not_found" }, 404);
  const ext = path.extname(filename).toLowerCase();
  const mime = mimeFromExt[ext] ?? "application/octet-stream";
  const stream = Readable.toWeb(createReadStream(target)) as ReadableStream;
  return new Response(stream, {
    headers: {
      "content-type": mime,
      "content-length": String(info.size),
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
});
