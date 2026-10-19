import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { verifyClientIpForward } from "@th/trpc/client-ip";

/**
 * The `/api/auth/token` mint carries the signed visitor IP. Better Auth
 * rate-limits `/token` per IP and the mint leaves from the web server, so
 * without the forward every signed-in visitor shares one bucket.
 */

type HeadersFn = () => Promise<Record<string, string>>;

const SECRET = "test-origin-shared-secret-0123456789abcdef";

const mocks = vi.hoisted(() => ({
  requestHeaders: {} as Record<string, string>,
  linkOptions: null as { headers: () => Promise<Record<string, string>> } | null,
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(mocks.requestHeaders),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

vi.mock("@trpc/client", () => ({
  createTRPCProxyClient: () => ({}),
  httpBatchLink: (opts: { headers: HeadersFn }) => {
    mocks.linkOptions = opts;
    return () => undefined;
  },
}));

// A real single-arg memoizer, as in trpc-client.test.ts: React's `cache()` is
// a passthrough outside a request scope.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    cache: <Args extends unknown[], R>(fn: (...args: Args) => R) => {
      const entries = new Map<unknown, R>();
      return (...args: Args): R => {
        if (!entries.has(args[0])) entries.set(args[0], fn(...args));
        return entries.get(args[0]) as R;
      };
    },
  };
});

const fetchMock = vi.fn();

/** Headers of the `fetch` call that hit `/api/auth/token`. */
const tokenFetchHeaders = (): Record<string, string> => {
  const call = fetchMock.mock.calls.find(([url]) =>
    String(url).endsWith("/api/auth/token"),
  );
  if (!call) throw new Error("no /api/auth/token fetch");
  return (call[1] as { headers: Record<string, string> }).headers;
};

describe("mintTokenFromCookie — signed client-IP forward", () => {
  let savedSecret: string | undefined;
  let savedEnforce: string | undefined;

  beforeEach(() => {
    savedSecret = process.env.ORIGIN_SHARED_SECRET;
    savedEnforce = process.env.ENFORCE_ORIGIN_SECRET;
    process.env.ORIGIN_SHARED_SECRET = SECRET;
    delete process.env.ENFORCE_ORIGIN_SECRET;
    mocks.requestHeaders = {
      cookie: "better-auth.session_token=abc",
      "cf-connecting-ip": "198.51.100.23",
    };
    mocks.linkOptions = null;
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ token: "jwt-token" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedSecret === undefined) delete process.env.ORIGIN_SHARED_SECRET;
    else process.env.ORIGIN_SHARED_SECRET = savedSecret;
    if (savedEnforce === undefined) delete process.env.ENFORCE_ORIGIN_SECRET;
    else process.env.ENFORCE_ORIGIN_SECRET = savedEnforce;
  });

  it("signs the visitor IP when given the incoming headers", async () => {
    const { mintTokenFromCookie } = await import("../trpc-client");
    const token = await mintTokenFromCookie(
      "better-auth.session_token=abc",
      new Headers({ "cf-connecting-ip": "198.51.100.23" }),
    );

    expect(token).toBe("jwt-token");
    const headers = tokenFetchHeaders();
    expect(headers.cookie).toBe("better-auth.session_token=abc");
    expect(
      verifyClientIpForward(headers, SECRET, Math.floor(Date.now() / 1000)),
    ).toBe("198.51.100.23");
  });

  it("sends no forward without incoming headers (unchanged legacy call)", async () => {
    const { mintTokenFromCookie } = await import("../trpc-client");
    await mintTokenFromCookie("better-auth.session_token=abc");

    expect(
      Object.keys(tokenFetchHeaders()).filter((k) =>
        k.startsWith("x-th-client-ip"),
      ),
    ).toEqual([]);
  });

  it("the SSR client's cached mint signs the visitor IP, once per request", async () => {
    const mod = await import("../trpc-client");
    mod.getServerTrpcClient();
    const headersFn = mocks.linkOptions!.headers;

    const [a, b] = await Promise.all([headersFn(), headersFn()]);

    expect(a.Authorization).toBe("Bearer jwt-token");
    expect(b.Authorization).toBe("Bearer jwt-token");
    const tokenCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/api/auth/token"),
    );
    expect(tokenCalls).toHaveLength(1);
    expect(
      verifyClientIpForward(
        tokenFetchHeaders(),
        SECRET,
        Math.floor(Date.now() / 1000),
      ),
    ).toBe("198.51.100.23");
  });
});
