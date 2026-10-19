/**
 * Shared fixture helpers for the booking-loop E2E specs
 * (booking-loop.spec.ts + booking-embed-loop.spec.ts).
 *
 * Seeding goes through the dedicated `/e2e/seed/booking-loop` API route
 * (same guard/shape family as seed-admin-tables), and multi-actor sign-in
 * follows the auth.setup API-only pattern: POST Better Auth's
 * /sign-in/email through a BrowserContext's request jar so the session
 * cookie lands on the context and its pages are signed in.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  expect,
  type APIRequestContext,
  type BrowserContext,
} from "@playwright/test";

export const API_BASE_URL =
  process.env.E2E_API_BASE_URL ??
  process.env.PLAYWRIGHT_API_BASE_URL ??
  "http://localhost:3001";

export const WEB_BASE_URL =
  process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

export const E2E_SECRET =
  process.env.E2E_RESET_SECRET ?? "playwright-reset-secret";

export const TEST_EMAIL =
  process.env.PLAYWRIGHT_TEST_EMAIL ??
  process.env.PLAYWRIGHT_TEST_IDENTIFIER ??
  "playwright-setup@example.com";

/**
 * `browser.newContext()` under @playwright/test inherits the project's `use`
 * options — including the venue storage state. Secondary-actor contexts must
 * opt out explicitly or they silently run as the signed-in venue user.
 */
export const EMPTY_STORAGE_STATE: { cookies: never[]; origins: never[] } = {
  cookies: [],
  origins: [],
};

export interface BookingLoopSeed {
  venueHumanId: string;
  orgId: string;
  orgSlug: string;
  placeId: string;
  placeName: string;
  pageSlug: string;
  embedId: string;
  embedDomain: string;
  performer: {
    humanId: string;
    email: string;
    password: string;
    displayName: string;
  };
  thirdPayee: {
    humanId: string;
    email: string;
    password: string;
    displayName: string;
  };
}

export async function seedBookingLoop(
  request: APIRequestContext,
  opts?: { embedDomain?: string },
): Promise<BookingLoopSeed> {
  const res = await request.post(`${API_BASE_URL}/e2e/seed/booking-loop`, {
    headers: {
      "x-e2e-reset-secret": E2E_SECRET,
      "content-type": "application/json",
    },
    data: {
      email: TEST_EMAIL,
      ...(opts?.embedDomain ? { embedDomain: opts.embedDomain } : {}),
    },
  });
  expect(res.ok(), `Booking-loop seed failed: ${await res.text()}`).toBeTruthy();
  const body = await res.json();
  const seed = body.seed as BookingLoopSeed;
  expect(seed.orgSlug).toBeTruthy();
  expect(seed.placeId).toBeTruthy();
  expect(seed.pageSlug).toBeTruthy();
  return seed;
}

/** Mark an auth user email-verified so credential sign-in isn't 403-gated. */
export async function verifyEmail(
  request: APIRequestContext,
  email: string,
): Promise<void> {
  await request.post(`${API_BASE_URL}/e2e/auth/verify-email`, {
    headers: {
      "x-e2e-reset-secret": E2E_SECRET,
      "content-type": "application/json",
    },
    data: { email },
  });
}

/**
 * API-only sign-in for a secondary actor context (auth.setup's
 * PLAYWRIGHT_REQUIRE_WEB_SERVER=0 branch): the Better Auth session cookie
 * lands in the context's shared jar, so pages opened from this context are
 * signed in. Uses `localhost` hosts throughout — the cookie domain must
 * match the web origin (see auth.setup.ts).
 */
export async function signInContext(
  context: BrowserContext,
  credentials: { email: string; password: string },
): Promise<void> {
  // Keep the cookie-consent banner out of the way for UI steps.
  await context.addCookies([
    { name: "th-consent", value: "all", domain: "localhost", path: "/" },
  ]);
  const res = await context.request.post(
    `${API_BASE_URL.replace(/\/+$/, "")}/api/auth/sign-in/email`,
    {
      headers: {
        "content-type": "application/json",
        origin: WEB_BASE_URL,
      },
      data: { email: credentials.email, password: credentials.password },
    },
  );
  expect(
    res.ok(),
    `API sign-in failed for ${credentials.email} (${res.status()}): ${await res.text()}`,
  ).toBeTruthy();
}

/**
 * Minimal cross-origin host page for the embed widget: a bare Node HTTP
 * server on an ephemeral localhost port (different origin from :3000, same
 * `localhost` hostname → passes the Embed.domain allowlist) serving the
 * REAL paste snippet — async-safe HF stub queue + hf-embed.js +
 * widget:"booking" modal trigger (BookingEmbedSection.buildBookingSnippet).
 */
export interface EmbedHostServer {
  url: string;
  close: () => Promise<void>;
}

export async function startEmbedHostServer(
  embedId: string,
): Promise<EmbedHostServer> {
  const html = [
    "<!doctype html>",
    "<html><head><title>E2E embed host</title></head><body>",
    "<h1>Venue site</h1>",
    // The exact stub-queue line the admin snippet ships (SDK race fix).
    `<script>window.HF=window.HF||{_q:[],createWidget:function(o){this._q.push(["createWidget",o])}};</script>`,
    `<script src="${WEB_BASE_URL}/embed/hf-embed.js" async></script>`,
    `<div id="hf-book-${embedId}"></div>`,
    "<script>",
    "  HF.createWidget({",
    `    embedId: "${embedId}",`,
    `    container: "#hf-book-${embedId}",`,
    '    widget: "booking",',
    '    mode: "modal",',
    '    triggerText: "Request to book"',
    "  });",
    "</script>",
    "</body></html>",
  ].join("\n");

  const server = http.createServer((_req, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(html);
  });

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    // Ephemeral port; bind all interfaces so `localhost` resolves regardless
    // of the v4/v6 preference of the browser's resolver.
    server.listen(0, resolve);
  });

  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://localhost:${port}/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
