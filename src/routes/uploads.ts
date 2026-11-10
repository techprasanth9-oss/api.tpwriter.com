import { Hono } from "hono";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { nanoid } from "nanoid";
import { requireAuth, type AuthContext } from "../auth/middleware";

const UPLOAD_DIR = path.resolve(process.cwd(), "data/uploads");
const MAX_BYTES = 10 * 1024 * 1024;
/** Whole multipart body: the file plus form overhead. Enforced in index.ts. */
export const UPLOAD_BODY_LIMIT = MAX_BYTES + 64 * 1024;

// SVG is deliberately not accepted: it can carry script, and these files are
// served from the API origin where the session cookie is valid.
const extFromMime: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};
const mimeFromExt: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Identify the image type from its magic bytes — the client-sent
 *  Content-Type is trivially spoofable. */
function sniffImageMime(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG") return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.toString("ascii", 0, 4) === "GIF8") return "image/gif";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return null;
}

export const uploads = new Hono<AuthContext>();

uploads.post("/", requireAuth, async (c) => {
  await mkdir(UPLOAD_DIR, { recursive: true });

  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: "invalid_form" }, 400);

  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "no_file" }, 400);
  if (file.size > MAX_BYTES)
    return c.json({ error: "too_large", max: MAX_BYTES }, 413);

  const buf = Buffer.from(await file.arrayBuffer());
  const mime = sniffImageMime(buf);
  if (!mime) return c.json({ error: "unsupported_mime", mime: file.type }, 415);

  const id = nanoid(16);
  const filename = `${id}${extFromMime[mime]}`;
  await writeFile(path.join(UPLOAD_DIR, filename), buf);

  return c.json(
    { url: `/uploads/${filename}`, filename, size: buf.length, mime },
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
  const mime = mimeFromExt[ext];
  const stream = Readable.toWeb(createReadStream(target)) as ReadableStream;
  return new Response(stream, {
    headers: {
      // Anything that isn't a known raster image (e.g. legacy .svg uploads)
      // is forced to download rather than render on our origin.
      "content-type": mime ?? "application/octet-stream",
      ...(mime ? {} : { "content-disposition": "attachment" }),
      "content-length": String(info.size),
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "cross-origin",
    },
  });
});
