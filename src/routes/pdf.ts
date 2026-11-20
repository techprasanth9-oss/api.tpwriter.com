import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { isValidObjectId } from "mongoose";
import { env } from "../env";
import { requireAuth, type AuthContext } from "../auth/middleware";
import { SESSION_COOKIE } from "../auth/jwt";
import { DocumentModel } from "../models/document";
import {
  chromiumRenderer,
  RenderFailedError,
  RenderTimeoutError,
  type PdfRenderer,
} from "../pdf/renderer";

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 10;
const RENDER_TIMEOUT_MS = 30_000;

/** Fixed-window limiter keyed by user id (PDF renders are expensive). */
function userLimiter(windowMs: number, max: number) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }, windowMs).unref();
  return (key: string): number | null => {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(key, b);
    }
    b.count += 1;
    return b.count > max ? Math.ceil((b.resetAt - now) / 1000) : null;
  };
}

/** `Content-Disposition` for a download named after the document. */
export function pdfDisposition(title: string): string {
  const base = (title.trim() || "Untitled document").replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, "_").slice(0, 120);
  const ascii = base.replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${ascii}.pdf"; filename*=UTF-8''${encodeURIComponent(`${base}.pdf`)}`;
}

/**
 * PDF export.
 *   GET  /pdf/status          → 200 { enabled: true } | 501 pdf_not_configured
 *   POST /documents/:id/pdf   → application/pdf
 * The document is rendered by the frontend's print route in headless
 * Chromium (see src/pdf/renderer.ts); `renderer` is injectable for tests.
 */
export function createPdfRoutes(renderer: PdfRenderer = chromiumRenderer) {
  const pdf = new Hono<AuthContext>();
  const limit = userLimiter(RATE_WINDOW_MS, RATE_MAX);

  pdf.get("/pdf/status", requireAuth, (c) =>
    env.APP_URL ? c.json({ enabled: true }) : c.json({ error: "pdf_not_configured" }, 501),
  );

  pdf.post("/documents/:id/pdf", requireAuth, async (c) => {
    const appUrl = env.APP_URL;
    if (!appUrl) return c.json({ error: "pdf_not_configured" }, 501);
    const session = c.get("session");

    const retryAfter = limit(session.userId);
    if (retryAfter !== null) {
      c.header("Retry-After", String(retryAfter));
      return c.json({ error: "rate_limited", retryAfter }, 429);
    }

    const id = c.req.param("id");
    if (!isValidObjectId(id)) return c.json({ error: "not_found" }, 404);
    const doc = await DocumentModel.findOne({ _id: id, ownerId: session.userId })
      .select({ title: 1 })
      .lean<{ _id: unknown; title: string }>();
    if (!doc) return c.json({ error: "not_found" }, 404);

    try {
      const bytes = await renderer.render({
        documentId: String(doc._id),
        // requireAuth verified this cookie; the renderer browses as the caller.
        sessionToken: getCookie(c, SESSION_COOKIE)!,
        appUrl,
        apiUrl: env.API_PUBLIC_URL,
        timeoutMs: RENDER_TIMEOUT_MS,
      });
      return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": pdfDisposition(doc.title ?? ""),
        "Cache-Control": "no-store",
      });
    } catch (err) {
      if (err instanceof RenderTimeoutError) return c.json({ error: "pdf_timeout" }, 504);
      if (err instanceof RenderFailedError) {
        if (err.code === "not_found") return c.json({ error: "not_found" }, 404);
        if (err.code === "unauthorized") return c.json({ error: "unauthorized" }, 401);
      }
      console.error(`[tp-writer-api] PDF render for ${id} failed:`, err);
      return c.json({ error: "pdf_failed" }, 502);
    }
  });

  return pdf;
}
