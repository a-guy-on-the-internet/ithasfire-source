import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type HeadersFn = () => Promise<Record<string, string>>;

const mocks = vi.hoisted(() => ({
  cookieHeader: null as string | null,
  /** Other inbound request headers (lower-case names), e.g. cf-connecting-ip. */
  requestHeaders: {} as Record<string, string>,
  /** Simulate calling `headers()` outside a request scope. */
  headersThrows: false,
  captureException: vi.fn(),
  /** Options `httpBatchLink` was constructed with, so we can call `headers()`. */
  linkOptions: null as { headers: HeadersFn } | null,
  /** Backing store for the stubbed React `cache()` (see the mock below). */
  cacheStore: new Map<unknown, unknown>(),
}));

vi.mock("next/headers", () => ({
  headers: async () => {
    if (mocks.headersThrows) {
      throw new Error("`headers` was called outside a request scope");
    }
    return {
      get: (name: string) =>
        name.toLowerCase() === "cookie"
          ? mocks.cookieHeader
          : (mocks.requestHeaders[name.toLowerCase()] ?? null),
    };
  },
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => mocks.captureException(...args),
}));

vi.mock("@trpc/client", () => ({
  createTRPCProxyClient: () => ({}),
  httpBatchLink: (opts: { headers: HeadersFn }) => {
    mocks.linkOptions = opts;
    return () => undefined;
  },
}));

// React's `cache()` degrades to an uncached passthrough outside a request
// scope, which a unit test never has. Stub it with a real single-arg memoizer so
// we can assert that `headers()` goes through the CACHED mint wrapper rather
// than calling `mintTokenFromCookie` directly once per batch.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    cache: <Args extends unknown[], R>(fn: (...args: Args) => R) => {
      const key = Symbol("cache-entry");
      mocks.cacheStore.set(key, new Map<unknown, R>());
      return (...args: Args): R => {
        const entries = mocks.cacheStore.get(key) as Map<unknown, R>;
        const argKey = args[0];
        if (!entries.has(argKey)) {
          entries.set(argKey, fn(...args));
        }
        return entries.get(argKey) as R;
      };
    },
  };
});

const fetchMock = vi.fn();

function takeCapturedHeadersFn(): HeadersFn {
  const opts = mocks.linkOptions;
  if (!opts) throw new Error("httpBatchLink was never constructed");
  return opts.headers;
}

/**
 * Re-import fresh per test: the link options and the `cache()` wrappers are
 * built at module scope, so one test's state must not bleed into the next.
 */
async function loadHeadersFn(
  cookie: string | null,
  which: "identity" | "public" = "identity",
): Promise<HeadersFn> {
  vi.resetModules();
  mocks.cookieHeader = cookie;
  mocks.linkOptions = null;
  mocks.cacheStore.clear();
  const mod = await import("../trpc-client");
  if (which === "public") mod.getPublicTrpcClient();
  else mod.getServerTrpcClient();
  return takeCapturedHeadersFn();
}

describe("server tRPC client headers()", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    mocks.captureException.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ token: "jwt-token" }),
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does NOT mint a token when the viewer has no session cookie", async () => {
    const headers = await loadHeadersFn("th-theme=dark; th_consent=1");

    const result = await headers();

    // Signed-out visitors still carry cookies; the old `if (cookie)` guard
    // fired a GET /api/auth/token per batch that could only ever 401.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.Authorization).toBeUndefined();
  });

  it("still forwards event-unlock cookies for signed-out viewers", async () => {
    const headers = await loadHeadersFn(
      "th-theme=dark; th_eu_evt-1=sig-1; th_eu_evt-2=sig-2",
    );

    const result = await headers();

    // Password-gated events are viewable anonymously — unlock forwarding must
    // NOT sit behind the session check.
    expect(result.cookie).toBe("th_eu_evt-1=sig-1; th_eu_evt-2=sig-2");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards application grant cookies (th_ea_*) alongside password unlocks", async () => {
    const headers = await loadHeadersFn(
      "th-theme=dark; th_ea_evt-1=sub.1.sig; th_consent=1; th_eu_evt-2=sig-2",
    );

    const result = await headers();

    // An anonymous approved applicant's grant must reach the API, which
    // verifies it and checks the submission is still APPROVED.
    expect(result.cookie).toBe("th_ea_evt-1=sub.1.sig; th_eu_evt-2=sig-2");
  });

  it("forwards invite grant cookies (th_ei_*) alongside the other gate cookies", async () => {
    const headers = await loadHeadersFn(
      "th-theme=dark; th_ei_evt-1=inv.9.sig; th_consent=1; th_ea_evt-2=sub.1.sig; th_eu_evt-3=sig-3",
    );

    const result = await headers();

    // A signed-out invite holder's grant must reach the API, which verifies
    // it and re-checks the invite (revoked / event over) on every read.
    expect(result.cookie).toBe(
      "th_ei_evt-1=inv.9.sig; th_ea_evt-2=sub.1.sig; th_eu_evt-3=sig-3",
    );
  });

  it("mints and forwards a Bearer token when a session cookie is present", async () => {
    const headers = await loadHeadersFn(
      "th-theme=dark; better-auth.session_token=abc; th_eu_evt-1=sig-1",
    );

    const result = await headers();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/auth/token");
    expect(result.Authorization).toBe("Bearer jwt-token");
    expect(result.cookie).toBe("th_eu_evt-1=sig-1");
  });

  it("recognises the prod __Secure- prefixed session cookie", async () => {
    const headers = await loadHeadersFn(
      "__Secure-better-auth.session_token=abc",
    );

    await headers();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("mints the token once across the batches of a single request", async () => {
    const headers = await loadHeadersFn("better-auth.session_token=abc");

    // httpBatchLink calls headers() once per HTTP batch, and one page render
    // issues several batches.
    const [a, b, c] = await Promise.all([headers(), headers(), headers()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a.Authorization).toBe("Bearer jwt-token");
    expect(b.Authorization).toBe("Bearer jwt-token");
    expect(c.Authorization).toBe("Bearer jwt-token");
  });

  it("degrades to an anonymous request and reports when the mint throws", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const headers = await loadHeadersFn("better-auth.session_token=abc");

    const result = await headers();

    expect(result.Authorization).toBeUndefined();
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
  });

  it("does not set Authorization when the mint returns a non-ok response", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) });
    const headers = await loadHeadersFn("better-auth.session_token=abc");

    const result = await headers();

    expect(result.Authorization).toBeUndefined();
    // A 401 is an expected outcome (stale cookie), not an error to report.
    expect(mocks.captureException).not.toHaveBeenCalled();
  });
});

describe("server tRPC client headers() — signed client-IP forward", () => {
  const SECRET = "test-origin-shared-secret-0123456789abcdef";
  let savedSecret: string | undefined;
  let savedEnforce: string | undefined;

  const ipHeaderNames = (h: Record<string, string>) =>
    Object.keys(h).filter((k) => k.startsWith("x-th-client-ip"));

  beforeEach(() => {
    savedSecret = process.env.ORIGIN_SHARED_SECRET;
    savedEnforce = process.env.ENFORCE_ORIGIN_SECRET;
    process.env.ORIGIN_SHARED_SECRET = SECRET;
    delete process.env.ENFORCE_ORIGIN_SECRET;
    mocks.headersThrows = false;
    mocks.requestHeaders = {
      "x-origin-secret": SECRET,
      "cf-connecting-ip": "198.51.100.23",
    };
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ token: "jwt-token" }),
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    mocks.requestHeaders = {};
    mocks.headersThrows = false;
    if (savedSecret === undefined) delete process.env.ORIGIN_SHARED_SECRET;
    else process.env.ORIGIN_SHARED_SECRET = savedSecret;
    if (savedEnforce === undefined) delete process.env.ENFORCE_ORIGIN_SECRET;
    else process.env.ENFORCE_ORIGIN_SECRET = savedEnforce;
  });

  it.each(["identity", "public"] as const)(
    "the %s client forwards the visitor's IP (no cookie)",
    async (which) => {
      const headers = await loadHeadersFn(null, which);
      const result = await headers();
      expect(result["x-th-client-ip"]).toBe("198.51.100.23");
      expect(ipHeaderNames(result).sort()).toEqual([
        "x-th-client-ip",
        "x-th-client-ip-sig",
        "x-th-client-ip-ts",
      ]);
      expect(result["x-origin-secret"]).toBe(SECRET);
    },
  );

  it("the identity client forwards the IP alongside the viewer's session", async () => {
    const headers = await loadHeadersFn(
      "better-auth.session_token=abc; th_eu_evt-1=sig-1",
    );
    const result = await headers();
    expect(result.Authorization).toBe("Bearer jwt-token");
    expect(result.cookie).toBe("th_eu_evt-1=sig-1");
    expect(result["x-th-client-ip"]).toBe("198.51.100.23");
  });

  it("the public client still carries no viewer identity", async () => {
    const headers = await loadHeadersFn(
      "better-auth.session_token=abc; th_eu_evt-1=sig-1",
      "public",
    );
    const result = await headers();
    expect(result.Authorization).toBeUndefined();
    expect(result.cookie).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result["x-th-client-ip"]).toBe("198.51.100.23");
  });

  it.each(["identity", "public"] as const)(
    "the %s client still forwards the IP without an inbound origin secret in log-only mode",
    async (which) => {
      mocks.requestHeaders = { "cf-connecting-ip": "10.9.8.7" };
      const headers = await loadHeadersFn(null, which);
      expect((await headers())["x-th-client-ip"]).toBe("10.9.8.7");
    },
  );

  it.each(["identity", "public"] as const)(
    "the %s client forwards no IP without an inbound origin secret when ENFORCE_ORIGIN_SECRET=true",
    async (which) => {
      process.env.ENFORCE_ORIGIN_SECRET = "true";
      mocks.requestHeaders = { "cf-connecting-ip": "10.9.8.7" };
      const headers = await loadHeadersFn(null, which);
      expect(ipHeaderNames(await headers())).toEqual([]);
    },
  );

  it.each(["identity", "public"] as const)(
    "the %s client forwards the IP when ENFORCE_ORIGIN_SECRET=true and the origin secret matches",
    async (which) => {
      process.env.ENFORCE_ORIGIN_SECRET = "true";
      const headers = await loadHeadersFn(null, which);
      expect((await headers())["x-th-client-ip"]).toBe("198.51.100.23");
    },
  );

  it.each(["identity", "public"] as const)(
    "the %s client sends no IP (and does not throw) outside a request scope",
    async (which) => {
      mocks.headersThrows = true;
      const headers = await loadHeadersFn("better-auth.session_token=abc", which);
      const result = await headers();
      expect(ipHeaderNames(result)).toEqual([]);
      expect(result.Authorization).toBeUndefined();
      expect(result["x-origin-secret"]).toBe(SECRET);
    },
  );
});
