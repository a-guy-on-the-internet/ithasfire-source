// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The authorization contract of the ISR purge endpoint.
 *
 * This is the one piece of this change that is a security surface rather than a
 * layout question: an unauthenticated or path-taking revalidation route is a
 * cache-busting DoS. These cases pin the three properties that keep it from
 * being one — a session is required, place ownership is required, and the paths
 * are DERIVED from the place id rather than accepted from the caller.
 *
 * WHAT THIS CANNOT SEE: that `entityPages.getMyPage` really is ownership-gated.
 * That lives in `packages/core` (`resolveEntityPageEditor` →
 * `authz.canManagePlace`, or a community moderator on a place nobody owns)
 * and has its own tests; here the upstream is a stub, so these cases prove the
 * handler HONOURS the upstream's answer, not that the answer is right.
 */

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  mintTokenFromCookie: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

vi.mock("@/config/env.server", () => ({
  webEnv: { siteUrl: "http://localhost:3000" },
}));

vi.mock("@/config/trpc", () => ({
  getTrpcHttpUrl: () => "http://api.test/trpc",
}));

vi.mock("@/server/trpc-client", () => ({
  mintTokenFromCookie: mocks.mintTokenFromCookie,
}));

import { NextRequest } from "next/server";

import { POST } from "../route";

const PLACE_ID = "00000000-0000-4000-8000-00000000d030";

function request(init?: { headers?: Record<string, string> }): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/places/${PLACE_ID}/revalidate`,
    { method: "POST", headers: init?.headers ?? {} },
  );
}

function params(placeId = PLACE_ID) {
  return { params: Promise.resolve({ placeId }) };
}

/** tRPC v11 batch envelope — success. */
function upstreamOk(slug: string) {
  return {
    ok: true,
    json: () =>
      Promise.resolve([{ result: { data: { json: { page: { slug } } } } }]),
  } as unknown as Response;
}

/** tRPC v11 batch envelope — procedure error. */
function upstreamError(code: string) {
  return {
    ok: true,
    json: () =>
      Promise.resolve([{ error: { json: { message: code, data: { code } } } }]),
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.mintTokenFromCookie.mockResolvedValue("jwt-token");
});

describe("POST /api/places/[placeId]/revalidate — authorization", () => {
  it("refuses an anonymous caller (no cookie, so no token to mint)", async () => {
    const res = await POST(request(), params());

    expect(res.status).toBe(401);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses a caller whose session cannot be exchanged for a token", async () => {
    mocks.mintTokenFromCookie.mockResolvedValue(null);

    const res = await POST(
      request({ headers: { cookie: "stale=1" } }),
      params(),
    );

    expect(res.status).toBe(401);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses a signed-in caller who does not own the place", async () => {
    mocks.fetch.mockResolvedValue(upstreamError("FORBIDDEN"));

    const res = await POST(
      request({ headers: { cookie: "session=1" } }),
      params(),
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses a cross-origin POST", async () => {
    const res = await POST(
      request({
        headers: { cookie: "session=1", origin: "https://evil.example" },
      }),
      params(),
    );

    expect(res.status).toBe(403);
    expect(mocks.mintTokenFromCookie).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses a placeId that is not a uuid, before touching the network", async () => {
    const res = await POST(
      request({ headers: { cookie: "session=1" } }),
      params("../../etc/passwd"),
    );

    expect(res.status).toBe(400);
    expect(mocks.mintTokenFromCookie).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("POST /api/places/[placeId]/revalidate — scope", () => {
  it("purges BOTH public routes for the place's own slug", async () => {
    mocks.fetch.mockResolvedValue(upstreamOk("the-paramount-theatre-austin"));

    const res = await POST(
      request({ headers: { cookie: "session=1" } }),
      params(),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      revalidated: [
        "/places/the-paramount-theatre-austin",
        "/p/the-paramount-theatre-austin",
      ],
    });
    expect(mocks.revalidatePath.mock.calls.map((c) => c[0])).toEqual([
      "/places/the-paramount-theatre-austin",
      "/p/the-paramount-theatre-austin",
    ]);
  });

  it("derives the slug from the place id — the request body is never read", async () => {
    mocks.fetch.mockResolvedValue(upstreamOk("real-slug"));

    await POST(request({ headers: { cookie: "session=1" } }), params());

    const [url, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("entityPages.getMyPage");
    expect(decodeURIComponent(url)).toContain(`"ownerId":"${PLACE_ID}"`);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer jwt-token",
    );
    expect(mocks.revalidatePath.mock.calls.map((c) => c[0])).toEqual([
      "/places/real-slug",
      "/p/real-slug",
    ]);
  });

  it("refuses a slug that could climb out of its path segment", async () => {
    // Server-derived and therefore trusted, but it is about to become a cache
    // key — a shape check is cheaper than trusting the whole chain forever.
    mocks.fetch.mockResolvedValue(upstreamOk("../../"));

    const res = await POST(
      request({ headers: { cookie: "session=1" } }),
      params(),
    );

    expect(res.status).toBe(502);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("purges nothing when the place has no public page", async () => {
    mocks.fetch.mockResolvedValue(upstreamError("NOT_FOUND"));

    const res = await POST(
      request({ headers: { cookie: "session=1" } }),
      params(),
    );

    expect(res.status).toBe(404);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
