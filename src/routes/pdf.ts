import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { env } from "../env";
import { requireAuth, type AuthContext } from "../auth/middleware";
import { SESSION_COOKIE } from "../auth/jwt";
import { atLeast, linkRole, loadDocAccess, memberRole, SHARE_TOKEN_HEADER } from "../auth/access";
import { userLimiter } from "../middleware/rateLimit";
import {
  chromiumRenderer,
  RenderFailedError,
  RenderTimeoutError,
  type PdfRenderer,
} from "../pdf/renderer";

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 10;
const RENDER_TIMEOUT_MS = 30_000;

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
    // Viewer+ — the same access check as every document route.
    const shareToken = c.req.header(SHARE_TOKEN_HEADER) || undefined;
    const access = await loadDocAccess(id, session, shareToken);
    if (!access || !atLeast(access.role, "viewer")) return c.json({ error: "not_found" }, 404);
    const { doc } = access;
    // A link-only reader needs the token on the print page too.
    const viaLink = !memberRole(doc, session.userId) && !!linkRole(doc, shareToken);

    try {
      const bytes = await renderer.render({
        documentId: String(doc._id),
        // requireAuth verified this cookie; the renderer browses as the caller.
        sessionToken: getCookie(c, SESSION_COOKIE)!,
        appUrl,
        apiUrl: env.API_PUBLIC_URL,
        ...(viaLink ? { shareToken } : {}),
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
