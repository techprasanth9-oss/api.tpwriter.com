import { chromium, type Browser } from "playwright-core";
import { env } from "../env";
import { SESSION_COOKIE } from "../auth/jwt";

/**
 * Server-side PDF rendering: headless Chromium opens the frontend's print
 * route (`${APP_URL}/documents/:id/print`) as the caller, waits for the
 * page to report `window.__TP_PRINT_READY__`, and prints it with the
 * page's own @page sizes.
 *
 * One browser is shared by all requests (launched lazily, relaunched if it
 * dies, killed on process exit); each render gets a fresh context, so
 * cookies never leak between users. Concurrency is capped.
 */

export interface RenderRequest {
  documentId: string;
  /** The caller's session JWT (their `tp_session` cookie). */
  sessionToken: string;
  /** Frontend base URL (env.APP_URL). */
  appUrl: string;
  /** API base URL when it's another origin (env.API_PUBLIC_URL). */
  apiUrl?: string;
  timeoutMs?: number;
}

export interface PdfRenderer {
  render(req: RenderRequest): Promise<Uint8Array>;
}

export class RenderTimeoutError extends Error {
  constructor() {
    super("PDF render timed out");
    this.name = "RenderTimeoutError";
  }
}

/** The print page reported a problem (e.g. "not_found", "unauthorized"). */
export class RenderFailedError extends Error {
  constructor(public readonly code: string) {
    super(`PDF render failed: ${code}`);
    this.name = "RenderFailedError";
  }
}

/** Third-party origins the print page may load (web fonts only). */
const FONT_ORIGINS = new Set(["https://fonts.googleapis.com", "https://fonts.gstatic.com"]);

/**
 * Whether the renderer lets a request through: the app's (and API's)
 * origins, Google Fonts, and inline data / blob URLs. Everything else is
 * aborted, so a document can't make the server fetch arbitrary URLs.
 */
export function isAllowedRequest(url: string, allowedOrigins: ReadonlySet<string>): boolean {
  if (url.startsWith("data:") || url.startsWith("blob:")) return true;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return false;
  }
  return allowedOrigins.has(origin) || FONT_ORIGINS.has(origin);
}

/** Path-safe print URL for a document id (ids are ObjectIds; encode anyway). */
export function printUrl(appUrl: string, documentId: string): string {
  return `${appUrl}/documents/${encodeURIComponent(documentId)}/print`;
}

// ── Shared browser ────────────────────────────────────────────────────

let browserPromise: Promise<Browser> | null = null;
let launched: Browser | null = null;

function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium
      .launch({ headless: true, executablePath: env.CHROMIUM_PATH })
      .then((browser) => {
        launched = browser;
        browser.on("disconnected", () => {
          if (launched === browser) {
            launched = null;
            browserPromise = null;
          }
        });
        return browser;
      })
      .catch((err) => {
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

export async function closeBrowser(): Promise<void> {
  const b = launched;
  launched = null;
  browserPromise = null;
  await b?.close().catch(() => undefined);
}

// Don't leave an orphaned Chromium behind.
process.once("exit", () => {
  try {
    (launched as unknown as { process?: () => { kill: () => void } | null } | null)?.process?.()?.kill();
  } catch {
    /* already gone */
  }
});

// ── Concurrency cap ───────────────────────────────────────────────────

let running = 0;
const waiting: Array<() => void> = [];

async function acquire(): Promise<() => void> {
  if (running >= env.PDF_CONCURRENCY) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  running++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    running--;
    waiting.shift()?.();
  };
}

// ── Renderer ──────────────────────────────────────────────────────────

export const chromiumRenderer: PdfRenderer = {
  async render({ documentId, sessionToken, appUrl, apiUrl, timeoutMs = 30_000 }) {
    const release = await acquire();
    const deadline = Date.now() + timeoutMs;
    const remaining = () => Math.max(1, deadline - Date.now());
    try {
      const browser = await getBrowser();
      const context = await browser.newContext({
        viewport: { width: 1400, height: 1000 },
        acceptDownloads: false,
        serviceWorkers: "block",
      });
      try {
        const origins = new Set<string>([new URL(appUrl).origin]);
        if (apiUrl) origins.add(new URL(apiUrl).origin);
        await context.addCookies(
          [...new Set([appUrl, ...(apiUrl ? [apiUrl] : [])])].map((url) => ({
            name: SESSION_COOKIE,
            value: sessionToken,
            url,
            httpOnly: true,
            secure: url.startsWith("https:"),
            sameSite: "Lax" as const,
          })),
        );
        await context.route("**/*", (route) =>
          isAllowedRequest(route.request().url(), origins) ? route.continue() : route.abort("blockedbyclient"),
        );

        const page = await context.newPage();
        await page.goto(printUrl(appUrl, documentId), { waitUntil: "domcontentloaded", timeout: remaining() });
        const status = await (
          await page.waitForFunction(
            // Runs in the page (no DOM types here).
            () => {
              const w = globalThis as unknown as {
                __TP_PRINT_READY__?: boolean;
                __TP_PRINT_ERROR__?: string;
                location: { pathname: string };
              };
              if (w.__TP_PRINT_READY__ === true) return "ready";
              if (w.__TP_PRINT_ERROR__) return w.__TP_PRINT_ERROR__;
              // The app redirects to /login when the session isn't accepted.
              if (w.location.pathname.startsWith("/login")) return "unauthorized";
              return false;
            },
            undefined,
            { timeout: remaining(), polling: 100 },
          )
        ).jsonValue();
        if (status !== "ready") throw new RenderFailedError(String(status));

        const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
        return new Uint8Array(pdf);
      } finally {
        await context.close().catch(() => undefined);
      }
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") throw new RenderTimeoutError();
      throw err;
    } finally {
      release();
    }
  },
};
