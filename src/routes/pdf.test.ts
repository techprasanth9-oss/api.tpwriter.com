import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";

// The real renderer launches Chromium; these tests only exercise the route.
const render = vi.hoisted(() => vi.fn());
vi.mock("../pdf/renderer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pdf/renderer")>();
  return { ...actual, chromiumRenderer: { render } };
});

import { createApp } from "../app";
import { env } from "../env";
import { SESSION_COOKIE, signSession } from "../auth/jwt";
import { isAllowedRequest, printUrl, RenderFailedError, RenderTimeoutError } from "../pdf/renderer";
import { pdfDisposition } from "./pdf";

const app = createApp();
const alice = new Types.ObjectId().toString();
const bob = new Types.ObjectId().toString();
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"

const tokenFor = (userId: string) => signSession({ userId, email: `${userId}@test.local` });

function request(userId: string | null, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      ...(userId ? { Cookie: `${SESSION_COOKIE}=${tokenFor(userId)}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function createDoc(userId: string, title = "Quarterly — Report") {
  const res = await request(userId, "POST", "/documents", { title });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

describe("PDF export", () => {
  beforeEach(() => {
    env.APP_URL = "http://app.test";
    env.API_PUBLIC_URL = undefined;
    render.mockReset();
    render.mockResolvedValue(PDF);
  });
  afterEach(() => {
    env.APP_URL = undefined;
  });

  it("answers 501 when APP_URL isn't configured", async () => {
    env.APP_URL = undefined;
    const id = await createDoc(alice);
    const res = await request(alice, "POST", `/documents/${id}/pdf`);
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "pdf_not_configured" });
    expect(render).not.toHaveBeenCalled();

    const status = await request(alice, "GET", "/pdf/status");
    expect(status.status).toBe(501);
  });

  it("reports availability when configured", async () => {
    const res = await request(alice, "GET", "/pdf/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true });
  });

  it("requires a session", async () => {
    const id = await createDoc(alice);
    expect((await request(null, "POST", `/documents/${id}/pdf`)).status).toBe(401);
    expect((await request(null, "GET", "/pdf/status")).status).toBe(401);
    expect(render).not.toHaveBeenCalled();
  });

  it("404s for someone else's document and for bad ids", async () => {
    const id = await createDoc(alice);
    const res = await request(bob, "POST", `/documents/${id}/pdf`);
    expect(res.status).toBe(404);
    expect((await request(alice, "POST", "/documents/not-an-id/pdf")).status).toBe(404);
    expect((await request(alice, "POST", `/documents/${new Types.ObjectId()}/pdf`)).status).toBe(404);
    expect(render).not.toHaveBeenCalled();
  });

  it("renders the owner's document as the caller and returns the PDF", async () => {
    env.API_PUBLIC_URL = "http://api.test";
    const id = await createDoc(alice);
    const res = await request(alice, "POST", `/documents/${id}/pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="Quarterly _ Report.pdf"; filename*=UTF-8''${encodeURIComponent("Quarterly — Report.pdf")}`,
    );
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF);
    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls[0]![0]).toMatchObject({
      documentId: id,
      sessionToken: tokenFor(alice),
      appUrl: "http://app.test",
      apiUrl: "http://api.test",
    });
  });

  it("maps renderer failures", async () => {
    const id = await createDoc(alice);
    render.mockRejectedValueOnce(new RenderTimeoutError());
    expect((await request(alice, "POST", `/documents/${id}/pdf`)).status).toBe(504);
    render.mockRejectedValueOnce(new RenderFailedError("not_found"));
    expect((await request(alice, "POST", `/documents/${id}/pdf`)).status).toBe(404);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render.mockRejectedValueOnce(new Error("chromium crashed"));
    const failed = await request(alice, "POST", `/documents/${id}/pdf`);
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: "pdf_failed" });
    spy.mockRestore();
  });

  it("rate-limits renders per user", async () => {
    const carol = new Types.ObjectId().toString();
    const id = await createDoc(carol);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await request(carol, "POST", `/documents/${id}/pdf`)).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
    // Another user is unaffected.
    const dave = new Types.ObjectId().toString();
    const other = await createDoc(dave);
    expect((await request(dave, "POST", `/documents/${other}/pdf`)).status).toBe(200);
  });
});

describe("renderer helpers", () => {
  it("allows only the app / API origins, Google Fonts and inline URLs", () => {
    const origins = new Set(["http://app.test", "http://api.test"]);
    expect(isAllowedRequest("http://app.test/assets/index.js", origins)).toBe(true);
    expect(isAllowedRequest("http://api.test/uploads/x.png", origins)).toBe(true);
    expect(isAllowedRequest("https://fonts.googleapis.com/css2?family=Inter", origins)).toBe(true);
    expect(isAllowedRequest("https://fonts.gstatic.com/s/inter.woff2", origins)).toBe(true);
    expect(isAllowedRequest("data:image/png;base64,AA==", origins)).toBe(true);
    expect(isAllowedRequest("http://169.254.169.254/latest/meta-data", origins)).toBe(false);
    expect(isAllowedRequest("https://app.test/", origins)).toBe(false); // scheme is part of the origin
    expect(isAllowedRequest("http://app.test.evil.com/", origins)).toBe(false);
    expect(isAllowedRequest("file:///etc/passwd", origins)).toBe(false);
    expect(isAllowedRequest("not a url", origins)).toBe(false);
  });

  it("builds the print URL from APP_URL and the id only", () => {
    expect(printUrl("https://app.example.com", "65f0c0ffee")).toBe("https://app.example.com/documents/65f0c0ffee/print");
    expect(printUrl("https://app.example.com", "../x?y")).toBe("https://app.example.com/documents/..%2Fx%3Fy/print");
  });

  it("names the download safely", () => {
    expect(pdfDisposition("")).toContain('filename="Untitled document.pdf"');
    expect(pdfDisposition('a/b\\c"d\r\ne')).toContain('filename="a_b_c_d_e.pdf"');
  });
});
