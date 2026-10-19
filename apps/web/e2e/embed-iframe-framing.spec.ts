// Embed iframe framing — verifies the public widget route is framable by
// third-party customer sites (WordPress, Squarespace, Wix, Shopify, etc.) while
// the rest of the site remains click-jack locked.
//
// This is the load-bearing header config in apps/web/next.config.ts. If anyone
// tightens the global CSP/XFO without adding an /embed override, this test
// breaks.
import { test, expect } from "@playwright/test";

const WEB_ORIGIN =
  process.env.PLAYWRIGHT_BASE_URL ??
  process.env.WEB_BASE_URL ??
  "http://127.0.0.1:3000";
const PROBE_EMBED_ID = "00000000-0000-4000-8000-00000000d060";

test.describe("Embed iframe framing headers", () => {
  test("/embed/* response permits third-party framing", async ({ request }) => {
    const res = await request.get(`${WEB_ORIGIN}/embed/${PROBE_EMBED_ID}`);

    // Use headersArray() so we'd catch a regression where Next.js (or a future
    // middleware addition) silently emits duplicate CSP / XFO headers — browsers
    // intersect duplicate CSPs, so two headers would re-lock framing even if
    // each individual header looks permissive.
    const all = res.headersArray();
    const cspHeaders = all.filter(
      (h) => h.name.toLowerCase() === "content-security-policy",
    );
    const xfoHeaders = all.filter(
      (h) => h.name.toLowerCase() === "x-frame-options",
    );

    expect(cspHeaders, "exactly one CSP header expected").toHaveLength(1);
    expect(cspHeaders[0].value).toContain("frame-ancestors *");
    expect(cspHeaders[0].value).not.toContain("frame-ancestors 'self'");

    // CSP frame-ancestors is authoritative. Do not emit legacy XFO for embeds;
    // a duplicated or blocking XFO can re-lock the iframe in older clients.
    expect(xfoHeaders).toHaveLength(0);
  });

  test("/embed/book/* (booking widget) permits third-party framing", async ({
    request,
  }) => {
    // The booking-request widget (booking-request-embed-button FR-002) lives
    // at /embed/book/[embedId] and must be covered by the same
    // "/embed/:path*" header override as the ticket widget.
    const res = await request.get(
      `${WEB_ORIGIN}/embed/book/${PROBE_EMBED_ID}`,
    );

    const all = res.headersArray();
    const cspHeaders = all.filter(
      (h) => h.name.toLowerCase() === "content-security-policy",
    );
    const xfoHeaders = all.filter(
      (h) => h.name.toLowerCase() === "x-frame-options",
    );

    expect(cspHeaders, "exactly one CSP header expected").toHaveLength(1);
    expect(cspHeaders[0].value).toContain("frame-ancestors *");
    expect(cspHeaders[0].value).not.toContain("frame-ancestors 'self'");
    expect(xfoHeaders).toHaveLength(0);
  });

  test("non-embed routes remain click-jack locked", async ({ request }) => {
    const res = await request.get(`${WEB_ORIGIN}/`);

    const csp = res.headers()["content-security-policy"] ?? "";
    expect(csp).toContain("frame-ancestors 'self'");

    expect(res.headers()["x-frame-options"]).toBeUndefined();
  });

  test("/embed/auth-handoff is NOT frame-permissive", async ({ request }) => {
    // The auth-handoff popup mints a bearer JWT and posts it to its opener
    // (booking-request-embed-button FR-010). It lives under /embed/* for
    // routing symmetry but must keep the global click-jack lock — a specific
    // header rule in next.config.ts re-applies frame-ancestors 'self' over
    // the frame-permissive /embed/:path* override.
    const res = await request.get(`${WEB_ORIGIN}/embed/auth-handoff`);

    const all = res.headersArray();
    const cspHeaders = all.filter(
      (h) => h.name.toLowerCase() === "content-security-policy",
    );
    const xfoHeaders = all.filter(
      (h) => h.name.toLowerCase() === "x-frame-options",
    );

    expect(cspHeaders, "exactly one CSP header expected").toHaveLength(1);
    expect(cspHeaders[0].value).toContain("frame-ancestors 'self'");
    expect(cspHeaders[0].value).not.toContain("frame-ancestors *");
    expect(xfoHeaders).toHaveLength(0);
  });

  test("/embed page loads inside a cross-origin iframe", async ({ page }) => {
    // Host page on a separate origin (about:blank) and frame the embed route.
    // If XFO/CSP frame-ancestors blocks the load, the iframe document is
    // unreachable and the test fails.
    await page.goto("about:blank");

    await page.evaluate(
      ({ origin, embedId }) => {
        const iframe = document.createElement("iframe");
        iframe.id = "embed-probe";
        iframe.src = `${origin}/embed/${embedId}`;
        iframe.width = "600";
        iframe.height = "400";
        document.body.appendChild(iframe);
      },
      { origin: WEB_ORIGIN, embedId: PROBE_EMBED_ID },
    );

    const frame = page.frameLocator("#embed-probe");
    // Any element from the embed surface — we don't care what specifically
    // renders, only that the document is reachable (no framing block).
    await expect(frame.locator("body")).toBeAttached({ timeout: 10_000 });
  });
});
