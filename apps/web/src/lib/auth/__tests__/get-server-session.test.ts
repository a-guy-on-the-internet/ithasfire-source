// @vitest-environment node
// (node, as for src/server/**: `server-only` is not an installed package, and
// only the node transform externalizes it so vitest.setup.ts's mock applies.)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { verifyClientIpForward } from "@th/trpc/client-ip";

/**
 * `getServerSession` calls `/api/auth/get-session` from the web server, so it
 * forwards the signed visitor IP — otherwise Better Auth keys every visitor
 * on our address.
 */

const SECRET = "test-origin-shared-secret-0123456789abcdef";

const mocks = vi.hoisted(() => ({
  requestHeaders: {} as Record<string, string>,
  captureException: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(mocks.requestHeaders),
}));
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => mocks.captureException(...args),
}));

const fetchMock = vi.fn();

describe("getServerSession", () => {
  let savedSecret: string | undefined;

  beforeEach(() => {
    savedSecret = process.env.ORIGIN_SHARED_SECRET;
    process.env.ORIGIN_SHARED_SECRET = SECRET;
    mocks.captureException.mockReset();
    mocks.requestHeaders = {
      cookie: "better-auth.session_token=abc",
      "cf-connecting-ip": "198.51.100.23",
    };
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ user: { id: "human_1" }, session: {} }),
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedSecret === undefined) delete process.env.ORIGIN_SHARED_SECRET;
    else process.env.ORIGIN_SHARED_SECRET = savedSecret;
  });

  it("sends the cookie and the signed visitor IP to /api/auth/get-session", async () => {
    const { getServerSession } = await import("../get-server-session");

    const session = await getServerSession();

    expect(session?.user.id).toBe("human_1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/api\/auth\/get-session$/);
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers.cookie).toBe("better-auth.session_token=abc");
    expect(
      verifyClientIpForward(headers, SECRET, Math.floor(Date.now() / 1000)),
    ).toBe("198.51.100.23");
  });

  it("sends no forward when the web has no signing secret", async () => {
    delete process.env.ORIGIN_SHARED_SECRET;
    const { getServerSession } = await import("../get-server-session");

    await getServerSession();

    const headers = (fetchMock.mock.calls[0]![1] as {
      headers: Record<string, string>;
    }).headers;
    expect(Object.keys(headers)).toEqual(["cookie"]);
  });

  it("still makes no call without a cookie", async () => {
    mocks.requestHeaders = { "cf-connecting-ip": "198.51.100.23" };
    const { getServerSession } = await import("../get-server-session");

    expect(await getServerSession()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
