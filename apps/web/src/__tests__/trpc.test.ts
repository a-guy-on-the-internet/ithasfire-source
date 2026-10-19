import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { QueryClient } from "@tanstack/react-query";

/**
 * Regression coverage for the cold-load auth race: `authClient.useSession()`
 * is still pending when `httpBatchLink` asks for headers on a cold page load,
 * and the old resolver bailed to `null` — so the first batch of every authed
 * page went out with NO Authorization header, every procedure in it came back
 * UNAUTHORIZED inside an HTTP 207, and `retry: false` in the query client
 * left the UI stuck in an error state (21/21 admin-editor loads failing
 * `events.getEventForEdit` in dev logs).
 *
 * Locks in the two halves of the fix:
 *  - `createAuthTokenResolver` waits (bounded) for the session atom to settle
 *    before deciding, WITHOUT regressing the anonymous no-mint path;
 *  - `createAuthRetryFetch` retries exactly once when an unauthenticated
 *    batch 207 lands inside the race window (the plain-401 retry the wrapper
 *    always had never fired for batches — tRPC batches report per-procedure
 *    errors under a 207).
 */

const mocks = vi.hoisted(() => ({
  // vitest 1.x `vi.fn` generics are (args-tuple, return) — not the fn type.
  token: vi.fn<[], Promise<{ data: { token?: string } | null; error: unknown }>>(),
  notify: vi.fn<[string], void>(),
}));

// Keep the module import hermetic: the real auth client is constructed at
// module scope (better-auth createAuthClient) and the resolver's default mint
// path calls `authClient.token()`.
vi.mock("@/lib/auth/auth-client", () => ({
  authClient: {
    token: mocks.token,
    useSession: () => ({ data: null, isPending: true }),
    $store: { notify: mocks.notify },
  },
}));

import { getAuthEpoch, notifySignedOut } from "@/lib/auth/auth-epoch";

import {
  bindQueryCacheToSignOut,
  bindTokenCacheToSignOut,
  createAuthRetryFetch,
  createAuthTokenResolver,
  createSessionReadRetry,
  createSessionTracker,
  isExpectedProcedureError,
  isRetryableSessionReadError,
  isTransientSessionReadError,
  shouldRetryWithFreshToken,
  trpcLogger,
} from "../trpc";

/** What the injectable mint may return: a token, a transient failure, or a 401. */
type MintOutcome = string | null | { unauthorized: true };

/** Wire a resolver to the real session tracker plus controllable cache/mint fakes. */
function makeResolverHarness(options?: {
  settleTimeoutMs?: number;
  mintTimeoutMs?: number;
  unauthorizedSuppressMs?: number;
  mintResult?: MintOutcome;
  /** Full mint override for hung/deferred mints; wins over `mintResult`. */
  mintImpl?: () => Promise<MintOutcome>;
  onTokenIssued?: () => void;
  /** Override for the session refetch the resolver asks for. */
  refetchSessionImpl?: () => void;
  reportError?: (err: unknown) => void;
}) {
  // The provider's own tracker: starts pending and never settled, exactly
  // like a cold load. `update` stands in for the provider's effect.
  const tracker = createSessionTracker();
  const tokenCache: {
    current: { token: string; mintedAtMs: number } | null;
  } = { current: null };
  // `??` would swallow an explicit `mintResult: null` — default only when the
  // option is absent.
  const { mintResult = "minted-token", mintImpl } = options ?? {};
  const mintToken = vi.fn(mintImpl ?? (() => Promise.resolve(mintResult)));
  const refetchSession = vi.fn(options?.refetchSessionImpl ?? (() => {}));
  const resolver = createAuthTokenResolver({
    session: tracker.session,
    tokenCache,
    waitForSettle: tracker.waitForSettle,
    markSettleTimedOut: tracker.markSettleTimedOut,
    mintToken,
    refetchSession,
    reportError: options?.reportError,
    onTokenIssued: options?.onTokenIssued,
    settleTimeoutMs: options?.settleTimeoutMs ?? 1_000,
    mintTimeoutMs: options?.mintTimeoutMs ?? 1_000,
    unauthorizedSuppressMs: options?.unauthorizedSuppressMs,
  });
  const settle = (isAuthenticated: boolean) =>
    tracker.update({ isAuthenticated, isPending: false });
  const refetch = () =>
    tracker.update({ isAuthenticated: false, isPending: true });
  /** A settled null whose get-session read FAILED (5xx, 429, network). */
  const settleReadFailed = () =>
    tracker.update({ isAuthenticated: false, isPending: false, readFailed: true });
  return {
    tracker,
    settle,
    settleReadFailed,
    refetch,
    tokenCache,
    mintToken,
    refetchSession,
    resolver,
  };
}

describe("createAuthTokenResolver", () => {
  beforeEach(() => {
    mocks.token.mockReset();
  });

  it("waits for a pending session to settle, then mints for an authenticated viewer", async () => {
    const { settle, mintToken, resolver } = makeResolverHarness();

    const pending = resolver();
    // The resolver must be parked on the settle signal, not racing ahead to a mint
    // (nor bailing to null, which was the cold-load bug).
    await Promise.resolve();
    expect(mintToken).not.toHaveBeenCalled();

    settle(true);

    await expect(pending).resolves.toBe("minted-token");
    expect(mintToken).toHaveBeenCalledTimes(1);
  });

  it("returns null WITHOUT minting when the session settles unauthenticated", async () => {
    const { settle, mintToken, resolver } = makeResolverHarness();

    const pending = resolver();
    settle(false);

    // Anonymous viewers must not fire a doomed mint on every batch.
    await expect(pending).resolves.toBeNull();
    expect(mintToken).not.toHaveBeenCalled();
  });

  it("bails immediately for an already-settled anonymous session", async () => {
    const { settle, mintToken, resolver } = makeResolverHarness();
    settle(false);

    await expect(resolver()).resolves.toBeNull();
    expect(mintToken).not.toHaveBeenCalled();
  });

  it("does not hang or throw when the session never settles within the bound", async () => {
    const { resolver, mintToken } = makeResolverHarness({
      settleTimeoutMs: 20,
      mintResult: null,
    });

    const startedAt = Date.now();
    // The atom never settles: the bounded race must resolve on its own. A
    // still-pending atom is NOT "clearly unauthenticated", so the resolver
    // falls through to the cookie-based mint (which can succeed independently
    // of the atom); here the mint yields nothing, so the batch degrades to
    // anonymous — exactly the pre-fix behaviour, just delayed by the bound.
    await expect(resolver()).resolves.toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(mintToken).toHaveBeenCalledTimes(1);
  });

  it("caches the minted token and reuses it while fresh", async () => {
    const { settle, tokenCache, mintToken, resolver } = makeResolverHarness();
    settle(true);

    await expect(resolver()).resolves.toBe("minted-token");
    expect(tokenCache.current?.token).toBe("minted-token");

    // Second call within the TTL: no new mint, and (via `hadPriorToken`) no
    // wait on the settle signal either.
    await expect(resolver()).resolves.toBe("minted-token");
    expect(mintToken).toHaveBeenCalledTimes(1);
  });

  it("wires the default mint to authClient.token()", async () => {
    mocks.token.mockResolvedValue({ data: { token: "jwt-abc" }, error: null });
    const tracker = createSessionTracker();
    tracker.update({ isAuthenticated: true, isPending: false });
    const resolver = createAuthTokenResolver({
      session: tracker.session,
      tokenCache: { current: null },
      waitForSettle: tracker.waitForSettle,
    });

    await expect(resolver()).resolves.toBe("jwt-abc");
    expect(mocks.token).toHaveBeenCalledTimes(1);
  });

  it("re-mints once the cached token's TTL lapses", async () => {
    const { settle, tokenCache, mintToken, resolver } = makeResolverHarness();
    settle(true);
    // Past the 55s client-side TTL, well inside the 10-minute stale window.
    tokenCache.current = { token: "old-token", mintedAtMs: Date.now() - 56_000 };

    await expect(resolver()).resolves.toBe("minted-token");
    expect(mintToken).toHaveBeenCalledTimes(1);
    expect(tokenCache.current?.token).toBe("minted-token");
  });

  it("falls back to a stale cached token (<10 min) when the mint fails", async () => {
    const { settle, tokenCache, resolver } = makeResolverHarness({
      mintResult: null,
    });
    settle(true);
    tokenCache.current = {
      token: "stale-token",
      mintedAtMs: Date.now() - 5 * 60_000,
    };

    // The JWT's server-side expiry (15 min) outlives the 55s client TTL, so a
    // failed re-mint prefers a possibly-still-valid token over anonymity.
    await expect(resolver()).resolves.toBe("stale-token");
  });

  it("gives up on a stale token older than 10 minutes", async () => {
    const { settle, tokenCache, resolver } = makeResolverHarness({
      mintResult: null,
    });
    settle(true);
    tokenCache.current = {
      token: "ancient-token",
      mintedAtMs: Date.now() - 11 * 60_000,
    };

    await expect(resolver()).resolves.toBeNull();
  });

  it("bounds a hung mint instead of wedging headers()", async () => {
    const { settle, resolver } = makeResolverHarness({
      mintTimeoutMs: 20,
      mintImpl: () => new Promise<string | null>(() => undefined),
    });
    settle(true);

    const startedAt = Date.now();
    // A hung token endpoint must degrade the batch to anonymous, not block
    // dispatch of every (public) query behind a never-settling headers().
    await expect(resolver()).resolves.toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("clears a timed-out mint so the next call can try afresh", async () => {
    let calls = 0;
    const { settle, mintToken, resolver } = makeResolverHarness({
      mintTimeoutMs: 20,
      mintImpl: () => {
        calls += 1;
        return calls === 1
          ? new Promise<string | null>(() => undefined)
          : Promise.resolve("recovered");
      },
    });
    settle(true);

    await expect(resolver()).resolves.toBeNull();
    // The hung first attempt was dropped on timeout — the second call must
    // start a fresh mint rather than re-await the wedged promise.
    await expect(resolver()).resolves.toBe("recovered");
    expect(mintToken).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight mint across concurrent batches", async () => {
    let settleMint!: (token: string | null) => void;
    const { settle, mintToken, resolver } = makeResolverHarness({
      mintImpl: () =>
        new Promise<string | null>((resolve) => {
          settleMint = resolve;
        }),
    });
    settle(true);

    // A settle releases parked cold-load batches together, so
    // concurrent resolver calls are the norm on an authed cold load.
    const first = resolver();
    const second = resolver();
    await Promise.resolve();
    expect(mintToken).toHaveBeenCalledTimes(1);

    settleMint("minted-token");
    await expect(first).resolves.toBe("minted-token");
    await expect(second).resolves.toBe("minted-token");
    expect(mintToken).toHaveBeenCalledTimes(1);
  });

  it("a hung attempt settling late cannot clobber the fresh attempt that replaced it", async () => {
    // Pins the identity guards inside the mint dedup: they look redundant but
    // are load-bearing. Interleaving: attempt A hangs → caller 1 times out
    // (drops A) → caller 2 starts fresh attempt B → A settles LATE. A's
    // cleanup must not clear B out from under later callers, and A's value
    // must not win the cache.
    const settlers: Array<(token: string | null) => void> = [];
    const { settle, tokenCache, mintToken, resolver } = makeResolverHarness({
      mintTimeoutMs: 20,
      mintImpl: () =>
        new Promise<string | null>((resolve) => {
          settlers.push(resolve);
        }),
    });
    settle(true);

    // Caller 1 joins attempt A, which hangs past the bound.
    await expect(resolver()).resolves.toBeNull();
    expect(mintToken).toHaveBeenCalledTimes(1);

    // Caller 2 starts fresh attempt B (A was dropped on timeout).
    const second = resolver();
    await Promise.resolve();
    expect(mintToken).toHaveBeenCalledTimes(2);

    // A settles late — its cleanup must see it was already replaced.
    settlers[0]("stale-token-A");
    await Promise.resolve();

    // Caller 3 must still dedup onto B, not start an attempt C.
    const third = resolver();
    await Promise.resolve();
    expect(mintToken).toHaveBeenCalledTimes(2);

    settlers[1]("token-B");
    await expect(second).resolves.toBe("token-B");
    await expect(third).resolves.toBe("token-B");
    // Nobody was left awaiting A, so its late value never reaches the cache.
    expect(tokenCache.current?.token).toBe("token-B");
  });
});

/**
 * The token cache after a sign-out. The provider stays mounted through every
 * sign-out (they are all client-side), and nothing used to clear its cache:
 * measured on the dev stack, the batch right after a navbar sign-out still
 * carried the old bearer (207), every batch did for the 55s TTL, and then for
 * up to 10 minutes each batch hit a 401 mint and fell back to the stale token.
 *
 * These use the REAL auth-epoch module (the resolver's default `getEpoch`,
 * and `notifySignedOut`, which is what the auth client's plugin calls).
 */
describe("createAuthTokenResolver — sign-out and revoked sessions", () => {
  const unbinds: Array<() => void> = [];
  afterEach(() => {
    // The epoch module is process-wide; leave no listener behind.
    for (const unbind of unbinds.splice(0)) unbind();
    mocks.token.mockReset();
    mocks.notify.mockReset();
  });

  it("a sign-out signal clears a fresh cache; the next batch for a settled signed-out session returns null without minting", async () => {
    const { settle, tokenCache, mintToken, resolver } = makeResolverHarness();
    unbinds.push(bindTokenCacheToSignOut(tokenCache));
    settle(true);
    await expect(resolver()).resolves.toBe("minted-token");
    expect(tokenCache.current?.token).toBe("minted-token");

    notifySignedOut();
    expect(tokenCache.current).toBeNull();
    settle(false);

    // The cached token was still FRESH — before the fix this returned it.
    await expect(resolver()).resolves.toBeNull();
    expect(mintToken).toHaveBeenCalledTimes(1);
  });

  it("an unbound listener (StrictMode cleanup) no longer touches the cache", () => {
    const tokenCache = {
      current: { token: "kept", mintedAtMs: Date.now() },
    };
    const unbind = bindTokenCacheToSignOut(tokenCache);
    unbind();
    notifySignedOut();
    expect(tokenCache.current?.token).toBe("kept");
  });

  it("notifySignedOut bumps the auth epoch", () => {
    const before = getAuthEpoch();
    notifySignedOut();
    expect(getAuthEpoch()).toBe(before + 1);
  });

  it("a mint in flight across a sign-out does not populate the cache or reach the batch", async () => {
    let settleMint!: (token: MintOutcome) => void;
    const { settle, tokenCache, mintToken, resolver } = makeResolverHarness({
      mintImpl: () =>
        new Promise<MintOutcome>((resolve) => {
          settleMint = resolve;
        }),
    });
    unbinds.push(bindTokenCacheToSignOut(tokenCache));
    settle(true);

    const pending = resolver();
    await Promise.resolve();
    expect(mintToken).toHaveBeenCalledTimes(1);

    notifySignedOut();
    // The request left with the signed-in cookie, so it can still come back
    // with a token for the session that was just signed out.
    settleMint("token-of-the-signed-out-session");

    await expect(pending).resolves.toBeNull();
    expect(tokenCache.current).toBeNull();
  });

  it("a mint in flight across a sign-out is not stale-fallback'd to the pre-sign-out token", async () => {
    let settleMint!: (token: MintOutcome) => void;
    const { settle, tokenCache, resolver } = makeResolverHarness({
      mintImpl: () =>
        new Promise<MintOutcome>((resolve) => {
          settleMint = resolve;
        }),
    });
    unbinds.push(bindTokenCacheToSignOut(tokenCache));
    settle(true);
    // Past the TTL, inside the 10-minute stale window: the batch captures
    // this token as its fallback before it starts the mint.
    tokenCache.current = { token: "pre-sign-out", mintedAtMs: Date.now() - 60_000 };

    const pending = resolver();
    await Promise.resolve();
    notifySignedOut();
    settleMint(null);

    await expect(pending).resolves.toBeNull();
  });

  it("a batch after a sign-out does not join the mint that started before it", async () => {
    const settlers: Array<(token: MintOutcome) => void> = [];
    const { settle, tokenCache, mintToken, resolver } = makeResolverHarness({
      mintImpl: () =>
        new Promise<MintOutcome>((resolve) => {
          settlers.push(resolve);
        }),
    });
    settle(true);

    const before = resolver();
    await Promise.resolve();
    notifySignedOut();
    // Say the user signed straight back in (LoginCard signs out first).
    const after = resolver();
    await Promise.resolve();
    expect(mintToken).toHaveBeenCalledTimes(2);

    settlers[0]("old-session-token");
    settlers[1]("new-session-token");
    await expect(before).resolves.toBeNull();
    await expect(after).resolves.toBe("new-session-token");
    expect(tokenCache.current?.token).toBe("new-session-token");
  });

  it("a 401 mint clears the cache and returns null, with no stale fallback", async () => {
    const { settle, tokenCache, mintToken, resolver } = makeResolverHarness({
      mintResult: { unauthorized: true },
    });
    settle(true);
    tokenCache.current = { token: "revoked", mintedAtMs: Date.now() - 82_000 };

    // Before the fix: "token mint failed, using stale token (age: 82s)".
    await expect(resolver()).resolves.toBeNull();
    expect(tokenCache.current).toBeNull();
    expect(mintToken).toHaveBeenCalledTimes(1);

    // Once the atom catches up, no further doomed mints.
    settle(false);
    await expect(resolver()).resolves.toBeNull();
    expect(mintToken).toHaveBeenCalledTimes(1);
  });

  it("the default mint maps a Better Auth 401 to an unauthorized result", async () => {
    mocks.token.mockResolvedValue({
      data: null,
      error: { status: 401, statusText: "Unauthorized" },
    });
    const tracker = createSessionTracker();
    tracker.update({ isAuthenticated: true, isPending: false });
    const tokenCache: { current: { token: string; mintedAtMs: number } | null } = {
      current: { token: "revoked", mintedAtMs: Date.now() - 82_000 },
    };
    const resolver = createAuthTokenResolver({
      session: tracker.session,
      tokenCache,
      waitForSettle: tracker.waitForSettle,
    });

    await expect(resolver()).resolves.toBeNull();
    expect(tokenCache.current).toBeNull();
    // The default refetch toggles Better Auth's session signal.
    expect(mocks.notify).toHaveBeenCalledWith("$sessionSignal");
  });

  it("a 401 mint asks the session atom to refetch; a transient failure does not", async () => {
    const revoked = makeResolverHarness({ mintResult: { unauthorized: true } });
    revoked.settle(true);
    await expect(revoked.resolver()).resolves.toBeNull();
    expect(revoked.refetchSession).toHaveBeenCalledTimes(1);

    const blip = makeResolverHarness({ mintResult: null });
    blip.settle(true);
    await expect(blip.resolver()).resolves.toBeNull();
    expect(blip.refetchSession).not.toHaveBeenCalled();
  });

  it("after a 401, the 207 retry inside the window does not mint again; a forwarded session report ends the window early", async () => {
    const { settle, mintToken, resolver } = makeResolverHarness({
      mintResult: { unauthorized: true },
    });
    settle(true);

    await expect(resolver()).resolves.toBeNull();
    // The header-less batch came back 207 → `createAuthRetryFetch` retries
    // with bypassCache while the session refetch is still in flight.
    await expect(resolver({ bypassCache: true })).resolves.toBeNull();
    await expect(resolver()).resolves.toBeNull();
    expect(mintToken).toHaveBeenCalledTimes(1);

    // The provider forwards a new reading (a successful refetch changes the
    // user reference). Minting resumes before the 5s window is up.
    settle(true);
    await expect(resolver()).resolves.toBeNull();
    expect(mintToken).toHaveBeenCalledTimes(2);
  });

  it("a transient 401 does not strand a signed-in user: with NO session report, the next batch past the window mints again", async () => {
    // A /token 401 can be a server blip (Better Auth answers 401 when its
    // session lookup throws), and an ERRORED session refetch never reaches
    // the tracker. So nothing but time may end the suppression.
    let calls = 0;
    const { settle, tokenCache, mintToken, resolver } = makeResolverHarness({
      unauthorizedSuppressMs: 30,
      mintImpl: () => {
        calls += 1;
        return Promise.resolve(
          calls === 1 ? { unauthorized: true as const } : "recovered-token",
        );
      },
    });
    settle(true);

    await expect(resolver()).resolves.toBeNull();
    await expect(resolver({ bypassCache: true })).resolves.toBeNull();
    expect(mintToken).toHaveBeenCalledTimes(1);

    // No tracker update at all — the session refetch errored.
    await new Promise((r) => setTimeout(r, 50));

    await expect(resolver()).resolves.toBe("recovered-token");
    expect(mintToken).toHaveBeenCalledTimes(2);
    expect(tokenCache.current?.token).toBe("recovered-token");
  });

  it("callers joined to one 401 mint trigger a single session refetch", async () => {
    let settleMint!: (token: MintOutcome) => void;
    const { settle, mintToken, refetchSession, resolver } = makeResolverHarness({
      mintImpl: () =>
        new Promise<MintOutcome>((resolve) => {
          settleMint = resolve;
        }),
    });
    settle(true);

    const batches = [resolver(), resolver(), resolver()];
    await Promise.resolve();
    expect(mintToken).toHaveBeenCalledTimes(1);
    settleMint({ unauthorized: true });

    await expect(Promise.all(batches)).resolves.toEqual([null, null, null]);
    expect(refetchSession).toHaveBeenCalledTimes(1);
  });

  it("a slow attempt's late 401 does not wipe a token a newer attempt cached", async () => {
    const settlers: Array<(token: MintOutcome) => void> = [];
    const { settle, tokenCache, refetchSession, resolver } = makeResolverHarness({
      mintTimeoutMs: 100,
      mintImpl: () =>
        new Promise<MintOutcome>((resolve) => {
          settlers.push(resolve);
        }),
    });
    settle(true);
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    // Caller 1 starts attempt A at t=0; caller X joins A at t≈50 (empty cache).
    const first = resolver();
    await sleep(50);
    const joiner = resolver();
    // Caller 1 times out at t≈100 and drops A; caller 2 starts attempt B.
    await expect(first).resolves.toBeNull();
    const second = resolver();
    await Promise.resolve();
    settlers[1]("token-B");
    await expect(second).resolves.toBe("token-B");

    // A finally answers 401 inside X's own bound (t≈150).
    settlers[0]({ unauthorized: true });
    await expect(joiner).resolves.toBeNull();
    expect(tokenCache.current?.token).toBe("token-B");
    expect(refetchSession).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a 5xx",
      () =>
        mocks.token.mockResolvedValue({
          data: null,
          error: { status: 503, statusText: "Service Unavailable" },
        }),
    ],
    ["a network throw", () => mocks.token.mockRejectedValue(new TypeError("Failed to fetch"))],
  ])("the default mint treats %s as transient and keeps the stale fallback", async (_label, arrange) => {
    arrange();
    const tracker = createSessionTracker();
    tracker.update({ isAuthenticated: true, isPending: false });
    const tokenCache: { current: { token: string; mintedAtMs: number } | null } = {
      current: { token: "stale-but-valid", mintedAtMs: Date.now() - 82_000 },
    };
    const resolver = createAuthTokenResolver({
      session: tracker.session,
      tokenCache,
      waitForSettle: tracker.waitForSettle,
    });

    await expect(resolver()).resolves.toBe("stale-but-valid");
    expect(tokenCache.current?.token).toBe("stale-but-valid");
  });
});

/**
 * `onTokenIssued` arms the provider's sign-out query reset. It must fire for
 * every token that goes out (a cold start can mint from the cookie without the
 * session reading ever settling signed-in) and never for a null.
 */
describe("createAuthTokenResolver — onTokenIssued", () => {
  it("fires for a fresh mint, a cached token and a stale fallback", async () => {
    vi.useFakeTimers();
    try {
      const onTokenIssued = vi.fn();
      let mintResult: MintOutcome = "minted-token";
      const { settle, resolver } = makeResolverHarness({
        onTokenIssued,
        mintImpl: () => Promise.resolve(mintResult),
      });
      settle(true);

      await expect(resolver()).resolves.toBe("minted-token");
      expect(onTokenIssued).toHaveBeenCalledTimes(1);

      await expect(resolver()).resolves.toBe("minted-token"); // cached
      expect(onTokenIssued).toHaveBeenCalledTimes(2);

      // TTL lapses and the re-mint fails transiently: stale fallback.
      vi.advanceTimersByTime(60_000);
      mintResult = null;
      await expect(resolver()).resolves.toBe("minted-token");
      expect(onTokenIssued).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fires for a cold-start mint whose session never settles", async () => {
    const onTokenIssued = vi.fn();
    const { resolver } = makeResolverHarness({
      onTokenIssued,
      settleTimeoutMs: 10,
    });

    await expect(resolver()).resolves.toBe("minted-token");
    expect(onTokenIssued).toHaveBeenCalledTimes(1);
  });

  it("does not fire when no token goes out (anonymous, 401, transient failure)", async () => {
    const onTokenIssued = vi.fn();
    const anonymous = makeResolverHarness({ onTokenIssued });
    anonymous.settle(false);
    await expect(anonymous.resolver()).resolves.toBeNull();

    const revoked = makeResolverHarness({
      onTokenIssued,
      mintResult: { unauthorized: true },
    });
    revoked.settle(true);
    await expect(revoked.resolver()).resolves.toBeNull();

    const blip = makeResolverHarness({ onTokenIssued, mintResult: null });
    blip.settle(true);
    await expect(blip.resolver()).resolves.toBeNull();

    expect(onTokenIssued).not.toHaveBeenCalled();
  });
});

/**
 * The query cache half of sign-out. The provider stays mounted across a
 * sign-out, so before `bindQueryCacheToSignOut` the next user to sign in on
 * the browser saw the previous user's orders until their own refetch landed.
 * Real auth-epoch module, real QueryClient.
 */
describe("bindQueryCacheToSignOut", () => {
  const unbinds: Array<() => void> = [];
  afterEach(() => {
    for (const unbind of unbinds.splice(0)) unbind();
  });

  /** A cache holding an inactive query with data, and an errored query that
   * kept the data it had before the error (React Query's default). */
  async function seededClient() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(["orders"], { orders: ["user-a-order"] });
    queryClient.setQueryData(["profile"], { name: "User A" });
    await queryClient
      .fetchQuery({
        queryKey: ["profile"],
        queryFn: () => Promise.reject(new Error("UNAUTHORIZED")),
        staleTime: 0,
      })
      .catch(() => undefined);
    // Precondition: the errored query still holds the old user's data.
    expect(queryClient.getQueryState(["profile"])?.status).toBe("error");
    expect(queryClient.getQueryData(["profile"])).toEqual({ name: "User A" });
    return queryClient;
  }

  it("a signal after an authenticated reading drops every query's data, errored ones included", async () => {
    const queryClient = await seededClient();
    const hadAuthenticated = { current: true };
    unbinds.push(bindQueryCacheToSignOut(queryClient, hadAuthenticated));

    notifySignedOut();

    expect(queryClient.getQueryData(["orders"])).toBeUndefined();
    expect(queryClient.getQueryData(["profile"])).toBeUndefined();
    expect(queryClient.getQueryState(["profile"])?.status).toBe("pending");
    expect(hadAuthenticated.current).toBe(false);
  });

  it("a signal with no authenticated reading since the last reset leaves the cache alone (defensive sign-out before a password sign-in)", async () => {
    const queryClient = await seededClient();
    const reset = vi.spyOn(queryClient, "resetQueries");
    unbinds.push(bindQueryCacheToSignOut(queryClient, { current: false }));

    notifySignedOut();

    expect(reset).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(["orders"])).toEqual({
      orders: ["user-a-order"],
    });
  });

  it("a second signal in a row is a no-op", async () => {
    const queryClient = await seededClient();
    const reset = vi.spyOn(queryClient, "resetQueries");
    unbinds.push(bindQueryCacheToSignOut(queryClient, { current: true }));

    notifySignedOut();
    queryClient.setQueryData(["orders"], { orders: ["fetched-after"] });
    notifySignedOut();

    expect(reset).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(["orders"])).toEqual({
      orders: ["fetched-after"],
    });
  });

  it("an unbound listener (StrictMode cleanup) no longer resets", async () => {
    const queryClient = await seededClient();
    const reset = vi.spyOn(queryClient, "resetQueries");
    const unbind = bindQueryCacheToSignOut(queryClient, { current: true });
    unbind();

    notifySignedOut();

    expect(reset).not.toHaveBeenCalled();
  });

  it("a reset that throws is reported, never reaches the signer-out, and is tried again on the next signal", () => {
    const boom = new Error("reset blew up");
    const reportError = vi.fn<[unknown], void>();
    const resetQueries = vi.fn(() => {
      throw boom;
    });
    const hadAuthenticated = { current: true };
    unbinds.push(
      bindQueryCacheToSignOut(
        { resetQueries },
        hadAuthenticated,
        undefined,
        reportError,
      ),
    );

    expect(() => notifySignedOut()).not.toThrow();
    expect(reportError).toHaveBeenCalledWith(boom);
    // The reset never started, so the guard stays armed.
    expect(hadAuthenticated.current).toBe(true);

    notifySignedOut();
    expect(resetQueries).toHaveBeenCalledTimes(2);
  });

  it("a reset that rejects is reported, not left unhandled", async () => {
    const boom = new Error("refetch rejected");
    const reportError = vi.fn<[unknown], void>();
    unbinds.push(
      bindQueryCacheToSignOut(
        { resetQueries: () => Promise.reject(boom) },
        { current: true },
        undefined,
        reportError,
      ),
    );

    notifySignedOut();
    await Promise.resolve();

    expect(reportError).toHaveBeenCalledWith(boom);
  });

  it("a throwing reporter does not escape the listener either", () => {
    unbinds.push(
      bindQueryCacheToSignOut(
        {
          resetQueries: () => {
            throw new Error("reset blew up");
          },
        },
        { current: true },
        undefined,
        () => {
          throw new Error("reporter blew up");
        },
      ),
    );

    expect(() => notifySignedOut()).not.toThrow();
  });
});

/**
 * The signed-out refetch window. The navbar's `useSessionVerdict` re-checks a
 * no-user session once on cold start (`refetch()`), and Better Auth's atom
 * reports `isPending: data === null` while ANY refetch is in flight — so for
 * a signed-out visitor the atom goes settled → pending → settled. The old
 * one-shot barrier was already released by the first settle, so a batch in
 * that window skipped the wait, still saw "pending", and minted: a GET
 * /api/auth/token 401 for every anonymous visitor.
 */
describe("createAuthTokenResolver — session refetch window", () => {
  it("settled signed-out → refetch → settles signed-out: null, never mints", async () => {
    const { settle, refetch, mintToken, resolver } = makeResolverHarness();
    settle(false);
    refetch();

    const pending = resolver();
    // Let the resolver run as far as it can: it must be parked on THIS
    // refetch, not released by the settle that already happened.
    await new Promise((r) => setTimeout(r, 5));
    expect(mintToken).not.toHaveBeenCalled();

    settle(false);
    await expect(pending).resolves.toBeNull();
    expect(mintToken).not.toHaveBeenCalled();
  });

  it("settled signed-out → refetch that outlives the bound: null, never mints", async () => {
    const { settle, refetch, mintToken, resolver } = makeResolverHarness({
      settleTimeoutMs: 20,
    });
    settle(false);
    refetch();

    const startedAt = Date.now();
    await expect(resolver()).resolves.toBeNull();
    // It did wait for the refetch (bounded), it did not bail early...
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15);
    // ...and a refetch of a known-anonymous session is no grounds to mint.
    expect(mintToken).not.toHaveBeenCalled();
  });

  it("never-settled cold start past the bound still mints from the cookie", async () => {
    const { mintToken, resolver } = makeResolverHarness({ settleTimeoutMs: 20 });

    // No settle at all: a slow/hung session endpoint on a signed-in cold
    // load. The cookie-based mint is the only way the first batch gets auth.
    await expect(resolver()).resolves.toBe("minted-token");
    expect(mintToken).toHaveBeenCalledTimes(1);
  });

  it("settled signed-out → sign-in refetch → settles signed-in: waits, then mints", async () => {
    const { settle, refetch, mintToken, resolver } = makeResolverHarness();
    settle(false);
    // Fresh sign-in: Better Auth refetches, atom pending with data null.
    refetch();

    const pending = resolver();
    // Let the resolver run as far as it can: it must be parked on THIS
    // refetch, not released by the settle that already happened.
    await new Promise((r) => setTimeout(r, 5));
    expect(mintToken).not.toHaveBeenCalled();

    settle(true);
    await expect(pending).resolves.toBe("minted-token");
    expect(mintToken).toHaveBeenCalledTimes(1);
  });

  it("a viewer who already holds a token skips the wait on later refetches", async () => {
    const { settle, refetch, mintToken, resolver } = makeResolverHarness();

    // Cold start pending → batch parks → settles signed-in → mints.
    const first = resolver();
    settle(true);
    await expect(first).resolves.toBe("minted-token");
    expect(mintToken).toHaveBeenCalledTimes(1);

    // Later refetches do not disturb a viewer who already holds a token.
    refetch();
    await expect(resolver()).resolves.toBe("minted-token");
    expect(mintToken).toHaveBeenCalledTimes(1);
  });

  it("after one batch times out in a signed-out refetch, later batches in that stretch return null at once", async () => {
    const { settle, refetch, mintToken, resolver } = makeResolverHarness({
      settleTimeoutMs: 50,
    });
    settle(false);
    refetch();

    // First batch pays the bound once.
    const firstStartedAt = Date.now();
    await expect(resolver()).resolves.toBeNull();
    expect(Date.now() - firstStartedAt).toBeGreaterThanOrEqual(40);

    // Second batch, same hung stretch: no wait, no mint.
    const secondStartedAt = Date.now();
    await expect(resolver()).resolves.toBeNull();
    expect(Date.now() - secondStartedAt).toBeLessThan(20);
    expect(mintToken).not.toHaveBeenCalled();
  });

  it("a bypassCache retry in a timed-out stretch waits, and mints when a sign-in settles inside the stretch", async () => {
    const { settle, refetch, mintToken, resolver } = makeResolverHarness({
      settleTimeoutMs: 50,
    });
    settle(false);
    refetch();
    await expect(resolver()).resolves.toBeNull(); // first batch sets the flag

    const retry = resolver({ bypassCache: true });
    await new Promise((r) => setTimeout(r, 5));
    expect(mintToken).not.toHaveBeenCalled();

    // Sign-in fetch merged into the open stretch: settle(true), no settle(false).
    settle(true);
    await expect(retry).resolves.toBe("minted-token");
    expect(mintToken).toHaveBeenCalledTimes(1);
  });

  it("a bypassCache retry in a timed-out stretch with no settle returns null after the bound, never minting", async () => {
    const { settle, refetch, mintToken, resolver } = makeResolverHarness({
      settleTimeoutMs: 50,
    });
    settle(false);
    refetch();
    await expect(resolver()).resolves.toBeNull(); // sets the stretch flag

    const startedAt = Date.now();
    await expect(resolver({ bypassCache: true })).resolves.toBeNull();
    // It waited the bound instead of taking the shortcut.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40);
    expect(mintToken).not.toHaveBeenCalled();
  });

  it("a new refetch after a settle waits again (the timed-out flag is per stretch)", async () => {
    const { settle, refetch, mintToken, resolver } = makeResolverHarness({
      settleTimeoutMs: 50,
    });
    settle(false);
    refetch();
    await expect(resolver()).resolves.toBeNull(); // stretch 1 times out

    settle(false);
    // Stretch 2 is a sign-in refetch: the batch must park, then mint.
    refetch();
    const pending = resolver();
    await new Promise((r) => setTimeout(r, 5));
    expect(mintToken).not.toHaveBeenCalled();

    settle(true);
    await expect(pending).resolves.toBe("minted-token");
    expect(mintToken).toHaveBeenCalledTimes(1);
  });

  it("a never-settled cold start waits on every batch and still mints", async () => {
    let mints = 0;
    const { mintToken, resolver } = makeResolverHarness({
      settleTimeoutMs: 30,
      // Fail the first mint so the second batch has no cached token.
      mintImpl: () => Promise.resolve(++mints === 1 ? null : "late-token"),
    });

    await expect(resolver()).resolves.toBeNull();
    const secondStartedAt = Date.now();
    await expect(resolver()).resolves.toBe("late-token");
    // No shortcut for a cold start: the second batch waited the bound too.
    expect(Date.now() - secondStartedAt).toBeGreaterThanOrEqual(25);
    expect(mintToken).toHaveBeenCalledTimes(2);
  });

  describe("dev warning", () => {
    let warnSpy: MockInstance<Parameters<typeof console.warn>, void>;

    beforeEach(() => {
      vi.stubEnv("NODE_ENV", "development");
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
      vi.unstubAllEnvs();
    });

    it("warns only after a real wait on a never-settled atom", async () => {
      const { resolver } = makeResolverHarness({ settleTimeoutMs: 20 });

      await resolver();

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain(
        "has not settled after waiting 20ms",
      );
    });

    it("stays quiet for a known-anonymous refetch that outlives the bound", async () => {
      const { settle, refetch, resolver } = makeResolverHarness({
        settleTimeoutMs: 20,
      });
      settle(false);
      refetch();

      await expect(resolver()).resolves.toBeNull();
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});

describe("createSessionTracker", () => {
  it("a waiter created after the first settle is released by a LATER settle", async () => {
    const tracker = createSessionTracker();
    tracker.update({ isAuthenticated: false, isPending: false });
    tracker.update({ isAuthenticated: false, isPending: true });

    let released = false;
    const waiter = tracker.waitForSettle().then(() => {
      released = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    // The first settle already happened; that must NOT release this waiter.
    expect(released).toBe(false);

    tracker.update({ isAuthenticated: false, isPending: false });
    await waiter;
    expect(released).toBe(true);
  });

  it("a settle releases the waiter of its stretch, and the next refetch re-arms with a new promise", async () => {
    const tracker = createSessionTracker();
    let aReleased = false;
    const a = tracker.waitForSettle();
    void a.then(() => {
      aReleased = true;
    });

    tracker.update({ isAuthenticated: false, isPending: false });
    tracker.update({ isAuthenticated: false, isPending: true });
    await a;
    expect(aReleased).toBe(true);

    const b = tracker.waitForSettle();
    expect(b).not.toBe(a);
    let bReleased = false;
    void b.then(() => {
      bReleased = true;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(bReleased).toBe(false);
  });

  it("clears the timed-out flag on settle, and ignores it once settled", () => {
    const tracker = createSessionTracker();
    tracker.update({ isAuthenticated: false, isPending: false });
    tracker.markSettleTimedOut(); // settled: no-op
    expect(tracker.session.current.stretchTimedOut).toBe(false);

    tracker.update({ isAuthenticated: false, isPending: true });
    tracker.markSettleTimedOut();
    // A repeated pending reading (StrictMode) keeps it.
    tracker.update({ isAuthenticated: false, isPending: true });
    expect(tracker.session.current.stretchTimedOut).toBe(true);

    tracker.update({ isAuthenticated: false, isPending: false });
    expect(tracker.session.current.stretchTimedOut).toBe(false);
  });

  it("resolves at once when the atom is not pending", async () => {
    const tracker = createSessionTracker();
    tracker.update({ isAuthenticated: true, isPending: false });
    await expect(tracker.waitForSettle()).resolves.toBeUndefined();
  });

  it("shares one promise per pending stretch and re-arms after a settle", () => {
    const tracker = createSessionTracker();
    const a = tracker.waitForSettle();
    // Concurrent waiters share one promise, so timed-out waiters never pile up.
    expect(tracker.waitForSettle()).toBe(a);

    tracker.update({ isAuthenticated: false, isPending: false });
    tracker.update({ isAuthenticated: false, isPending: true });
    expect(tracker.waitForSettle()).not.toBe(a);
  });

  it("tracks what the atom last settled to across pending stretches", () => {
    const tracker = createSessionTracker();
    expect(tracker.session.current).toMatchObject({
      isPending: true,
      hasSettled: false,
    });

    tracker.update({ isAuthenticated: false, isPending: false });
    tracker.update({ isAuthenticated: false, isPending: true });
    expect(tracker.session.current).toMatchObject({
      isPending: true,
      hasSettled: true,
      lastSettledAuthenticated: false,
    });

    tracker.update({ isAuthenticated: true, isPending: false });
    // StrictMode re-runs the effect with the same reading: a no-op.
    tracker.update({ isAuthenticated: true, isPending: false });
    expect(tracker.session.current).toMatchObject({
      isAuthenticated: true,
      isPending: false,
      lastSettledAuthenticated: true,
    });
  });
});

/**
 * A FAILED session read (get-session 500 during a DB outage, a 429, a network
 * throw) leaves Better Auth's atom with `data: null` and `error` set, which
 * the tracker used to read as a settled sign-out. Reproduced live: after the
 * outage every batch went out anonymous and the navbar showed the user signed
 * out until a focus event. The tracker now records the failed read, the
 * resolver treats it as unknown (cookie mint, gated by the 401 window), and
 * `createSessionReadRetry` re-reads the session with backoff.
 */
describe("createSessionTracker — failed session reads", () => {
  it("records a failed read on settle, carries it through a pending stretch, and a clean settle clears it", () => {
    const tracker = createSessionTracker();
    tracker.update({ isAuthenticated: false, isPending: false, readFailed: true });
    expect(tracker.session.current.lastSettledReadFailed).toBe(true);

    // The retry's own refetch: pending, the last settle still stands.
    tracker.update({ isAuthenticated: false, isPending: true });
    expect(tracker.session.current.lastSettledReadFailed).toBe(true);

    tracker.update({ isAuthenticated: false, isPending: false });
    expect(tracker.session.current.lastSettledReadFailed).toBe(false);
  });

  it("a reading with a user is never a failed read", () => {
    const tracker = createSessionTracker();
    tracker.update({ isAuthenticated: true, isPending: false, readFailed: true });
    expect(tracker.session.current.lastSettledReadFailed).toBe(false);
  });
});

describe("isRetryableSessionReadError", () => {
  it("is false for no error and for get-session's own 401 (session row gone)", () => {
    expect(isRetryableSessionReadError(null)).toBe(false);
    expect(isRetryableSessionReadError(undefined)).toBe(false);
    expect(isRetryableSessionReadError({ status: 401, statusText: "Unauthorized" })).toBe(false);
  });

  it("is true for 5xx, 429 and a network throw with no status", () => {
    expect(isRetryableSessionReadError({ status: 500 })).toBe(true);
    expect(isRetryableSessionReadError({ status: 429 })).toBe(true);
    expect(isRetryableSessionReadError(new TypeError("Failed to fetch"))).toBe(true);
  });
});

describe("isTransientSessionReadError", () => {
  it("is true for 5xx, 429 and an error with no HTTP status (network)", () => {
    expect(isTransientSessionReadError({ status: 500 })).toBe(true);
    expect(isTransientSessionReadError({ status: 503 })).toBe(true);
    expect(isTransientSessionReadError({ status: 429 })).toBe(true);
    expect(isTransientSessionReadError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isTransientSessionReadError({ message: "aborted" })).toBe(true);
  });

  it("is false for no error and for a permanent 4xx", () => {
    expect(isTransientSessionReadError(null)).toBe(false);
    expect(isTransientSessionReadError(undefined)).toBe(false);
    expect(isTransientSessionReadError({ status: 400 })).toBe(false);
    expect(isTransientSessionReadError({ status: 401 })).toBe(false);
    expect(isTransientSessionReadError({ status: 403 })).toBe(false);
    expect(isTransientSessionReadError({ status: 404 })).toBe(false);
  });
});

describe("createSessionReadRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * No jitter (`random` 0.5 is the midpoint, factor 1) and no document, so
   * the delays are exact. The jitter and visibility tests pass their own.
   */
  const createSessionReadRetryForTest = (
    deps: Parameters<typeof createSessionReadRetry>[0] = {},
  ) => createSessionReadRetry({ random: () => 0.5, doc: null, ...deps });

  const failed = { isPending: false, readFailed: true };
  const pending = { isPending: true, readFailed: false };
  const clean = { isPending: false, readFailed: false };

  /**
   * Drive N failed attempts and return the delay before each re-read. Each
   * re-read is answered like Better Auth answers it: pending, then failed.
   */
  function measureDelays(attempts: number) {
    const refetchSession = vi.fn();
    const retry = createSessionReadRetryForTest({ refetchSession });
    const delays: number[] = [];
    retry.onReading(failed);
    for (let i = 0; i < attempts; i += 1) {
      const before = refetchSession.mock.calls.length;
      let waited = 0;
      while (refetchSession.mock.calls.length === before) {
        vi.advanceTimersByTime(500);
        waited += 500;
        if (waited > 120_000) throw new Error("no retry within 120s");
      }
      delays.push(waited);
      retry.onReading(pending);
      retry.onReading(failed);
    }
    return { delays, refetchSession, retry };
  }

  it("a failed read schedules one re-read after 2s, not before", () => {
    const refetchSession = vi.fn();
    const retry = createSessionReadRetryForTest({ refetchSession });
    retry.onReading(failed);

    vi.advanceTimersByTime(1_999);
    expect(refetchSession).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refetchSession).toHaveBeenCalledTimes(1);
  });

  it("the backoff doubles and caps at 30s", () => {
    const { delays } = measureDelays(7);
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  });

  it("repeated failed readings while a re-read is armed do not stack timers", () => {
    const refetchSession = vi.fn();
    const retry = createSessionReadRetryForTest({ refetchSession });
    // A focus refetch failing: session-refresh sets the atom, then the
    // signal's own fetch fails too. Three failed readings, one timer.
    retry.onReading(failed);
    retry.onReading(pending);
    retry.onReading(failed);
    retry.onReading(failed);
    expect(vi.getTimerCount()).toBe(1);

    // One re-read at 2s, the self-armed next one at 2s + 4s; no extras.
    vi.advanceTimersByTime(5_999);
    expect(refetchSession).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("a clean settle cancels the armed re-read and resets the backoff", () => {
    const { refetchSession, retry } = measureDelays(3); // next would be 16s
    retry.onReading(clean);
    vi.advanceTimersByTime(60_000);
    expect(refetchSession).toHaveBeenCalledTimes(3);

    // The next outage starts over at 2s.
    retry.onReading(failed);
    vi.advanceTimersByTime(2_000);
    expect(refetchSession).toHaveBeenCalledTimes(4);
  });

  it("a pending reading leaves an armed re-read in place", () => {
    const refetchSession = vi.fn();
    const retry = createSessionReadRetryForTest({ refetchSession });
    retry.onReading(failed);
    // Some other fetch (a focus event) starts and hangs.
    retry.onReading(pending);
    vi.advanceTimersByTime(2_000);
    expect(refetchSession).toHaveBeenCalledTimes(1);
  });

  it("cancel (unmount) stops the armed re-read; a later failed reading re-arms at the same step", () => {
    const refetchSession = vi.fn();
    const retry = createSessionReadRetryForTest({ refetchSession });
    retry.onReading(failed);
    retry.cancel();
    vi.advanceTimersByTime(120_000);
    expect(refetchSession).not.toHaveBeenCalled();

    // StrictMode: cleanup, then the reading effect runs again.
    retry.onReading(failed);
    vi.advanceTimersByTime(2_000);
    expect(refetchSession).toHaveBeenCalledTimes(1);
  });

  it("a throwing re-read is reported and the next one is armed", () => {
    const reportError = vi.fn();
    const boom = new Error("notify threw");
    const refetchSession = vi
      .fn<[], void>()
      .mockImplementationOnce(() => {
        throw boom;
      });
    const retry = createSessionReadRetryForTest({ refetchSession, reportError });
    retry.onReading(failed);

    vi.advanceTimersByTime(2_000);
    expect(reportError).toHaveBeenCalledWith(boom);
    // No reading will arrive (no fetch started), so the retry re-armed itself.
    vi.advanceTimersByTime(4_000);
    expect(refetchSession).toHaveBeenCalledTimes(2);
  });

  it("a throwing reporter does not stop the retries", () => {
    const refetchSession = vi
      .fn<[], void>()
      .mockImplementationOnce(() => {
        throw new Error("notify threw");
      });
    const retry = createSessionReadRetryForTest({
      refetchSession,
      reportError: () => {
        throw new Error("reporter threw");
      },
    });
    retry.onReading(failed);
    expect(() => vi.advanceTimersByTime(6_000)).not.toThrow();
    expect(refetchSession).toHaveBeenCalledTimes(2);
  });

  it("a clean signed-out reading (anonymous visitor) never schedules anything", () => {
    const refetchSession = vi.fn();
    const retry = createSessionReadRetryForTest({ refetchSession });
    retry.onReading(pending);
    retry.onReading(clean);
    vi.advanceTimersByTime(300_000);
    expect(refetchSession).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  /**
   * Review finding: Better Auth sets the atom twice per attempt (pending,
   * then failed). When React batches both into one render the provider effect
   * sees unchanged inputs and forwards no reading, so a loop that waited for
   * the re-read's reading to re-arm stopped after one attempt.
   */
  it("keeps re-reading on the backoff when no reading arrives after an attempt", () => {
    const refetchSession = vi.fn();
    const retry = createSessionReadRetryForTest({ refetchSession });
    retry.onReading(failed);

    const expected = [2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
    expected.forEach((delay, i) => {
      vi.advanceTimersByTime(delay - 1);
      expect(refetchSession).toHaveBeenCalledTimes(i);
      vi.advanceTimersByTime(1);
      expect(refetchSession).toHaveBeenCalledTimes(i + 1);
    });
    // One timer at a time, never a pile.
    expect(vi.getTimerCount()).toBe(1);
  });

  it("a clean settle after an attempt stops the self-armed next one", () => {
    const refetchSession = vi.fn();
    const retry = createSessionReadRetryForTest({ refetchSession });
    retry.onReading(failed);
    vi.advanceTimersByTime(2_000);
    expect(refetchSession).toHaveBeenCalledTimes(1);

    // pending + signed-in batched: the provider forwards only the settle.
    retry.onReading(clean);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(120_000);
    expect(refetchSession).toHaveBeenCalledTimes(1);
  });

  it("a permanent 4xx (not retryable) never starts the loop and stops a running one", () => {
    const refetchSession = vi.fn();
    const retry = createSessionReadRetryForTest({ refetchSession });
    const forbidden = { isPending: false, readFailed: true, retryable: false };

    retry.onReading(forbidden);
    vi.advanceTimersByTime(120_000);
    expect(refetchSession).not.toHaveBeenCalled();

    retry.onReading(failed);
    vi.advanceTimersByTime(2_000);
    expect(refetchSession).toHaveBeenCalledTimes(1);
    retry.onReading(forbidden);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(120_000);
    expect(refetchSession).toHaveBeenCalledTimes(1);

    // The backoff was reset: a later transient failure starts over at 2s.
    retry.onReading(failed);
    vi.advanceTimersByTime(2_000);
    expect(refetchSession).toHaveBeenCalledTimes(2);
  });

  it("each delay carries up to ±20% jitter", () => {
    const delaysWith = (r: number) => {
      const refetchSession = vi.fn();
      const retry = createSessionReadRetryForTest({
        refetchSession,
        random: () => r,
      });
      retry.onReading(failed);
      const delays: number[] = [];
      let waited = 0;
      while (delays.length < 5) {
        vi.advanceTimersByTime(100);
        waited += 100;
        if (refetchSession.mock.calls.length > delays.length) {
          delays.push(waited);
          waited = 0;
        }
      }
      retry.cancel();
      return delays;
    };
    expect(delaysWith(0)).toEqual([1_600, 3_200, 6_400, 12_800, 24_000]);
    expect(delaysWith(1)).toEqual([2_400, 4_800, 9_600, 19_200, 36_000]);
  });

  function makeVisibilityDoc() {
    const target = new EventTarget();
    const doc = {
      visibilityState: "visible" as DocumentVisibilityState,
      addEventListener: vi.fn(target.addEventListener.bind(target)),
      removeEventListener: vi.fn(target.removeEventListener.bind(target)),
    };
    const setVisibility = (next: DocumentVisibilityState) => {
      doc.visibilityState = next;
      target.dispatchEvent(new Event("visibilitychange"));
    };
    return { doc: doc as unknown as Document, raw: doc, setVisibility };
  }

  it("pauses while the tab is hidden and re-arms that step's delay once it is visible again", () => {
    const { doc, setVisibility } = makeVisibilityDoc();
    const refetchSession = vi.fn();
    const retry = createSessionReadRetryForTest({ refetchSession, doc });
    retry.onReading(failed);
    vi.advanceTimersByTime(2_000);
    expect(refetchSession).toHaveBeenCalledTimes(1);

    setVisibility("hidden");
    // The 4s attempt comes due while hidden: no fetch, no timer, it waits.
    vi.advanceTimersByTime(300_000);
    expect(refetchSession).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    // Visible again. Better Auth re-reads on this event itself, so ours does
    // not fire at once; it waits the step that was due (4s), then goes on.
    setVisibility("visible");
    expect(refetchSession).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3_999);
    expect(refetchSession).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(refetchSession).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(8_000);
    expect(refetchSession).toHaveBeenCalledTimes(3);
  });

  it("a clean settle while paused (Better Auth's own focus re-read worked) removes the listener", () => {
    const { doc, raw, setVisibility } = makeVisibilityDoc();
    const refetchSession = vi.fn();
    const retry = createSessionReadRetryForTest({ refetchSession, doc });
    setVisibility("hidden");
    retry.onReading(failed);
    vi.advanceTimersByTime(2_000);
    expect(raw.addEventListener).toHaveBeenCalledTimes(1);

    retry.onReading(clean);
    expect(raw.removeEventListener).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    vi.advanceTimersByTime(120_000);
    expect(refetchSession).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancel (unmount) while paused removes the visibility listener", () => {
    const { doc, raw, setVisibility } = makeVisibilityDoc();
    const refetchSession = vi.fn();
    const retry = createSessionReadRetryForTest({ refetchSession, doc });
    setVisibility("hidden");
    retry.onReading(failed);
    vi.advanceTimersByTime(2_000);
    retry.cancel();
    expect(raw.removeEventListener).toHaveBeenCalledWith(
      "visibilitychange",
      raw.addEventListener.mock.calls[0]?.[1],
    );

    setVisibility("visible");
    vi.advanceTimersByTime(120_000);
    expect(refetchSession).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("createAuthTokenResolver — failed session read is unknown, not signed-out", () => {
  it("with an empty cache, a batch mints from the cookie instead of going anonymous", async () => {
    const { settleReadFailed, mintToken, tokenCache, resolver } =
      makeResolverHarness();
    settleReadFailed();

    await expect(resolver()).resolves.toBe("minted-token");
    expect(mintToken).toHaveBeenCalledTimes(1);
    expect(tokenCache.current?.token).toBe("minted-token");
  });

  it("a clean signed-out settle still never mints", async () => {
    const { settle, mintToken, refetchSession, resolver } = makeResolverHarness();
    settle(false);

    await expect(resolver()).resolves.toBeNull();
    await expect(resolver({ bypassCache: true })).resolves.toBeNull();
    expect(mintToken).not.toHaveBeenCalled();
    expect(refetchSession).not.toHaveBeenCalled();
  });

  it("a mint that works while the last read failed re-reads the session once", async () => {
    const { settleReadFailed, refetchSession, resolver } = makeResolverHarness();
    settleReadFailed();

    await expect(resolver()).resolves.toBe("minted-token");
    expect(refetchSession).toHaveBeenCalledTimes(1);
    // Cached: no mint, no further re-read.
    await expect(resolver()).resolves.toBe("minted-token");
    expect(refetchSession).toHaveBeenCalledTimes(1);
  });

  it("a mint that works for a clean signed-in reading does not re-read the session", async () => {
    const { settle, refetchSession, resolver } = makeResolverHarness();
    settle(true);
    await expect(resolver()).resolves.toBe("minted-token");
    expect(refetchSession).not.toHaveBeenCalled();
  });

  it("a throwing post-mint re-read is reported and the batch keeps its token", async () => {
    const boom = new Error("notify threw");
    const reportError = vi.fn();
    const { settleReadFailed, resolver } = makeResolverHarness({
      refetchSessionImpl: () => {
        throw boom;
      },
      reportError,
    });
    settleReadFailed();

    await expect(resolver()).resolves.toBe("minted-token");
    expect(reportError).toHaveBeenCalledWith(boom);
  });

  it("during an outage the 401 window holds across the failed re-reads it triggers, then lapses", async () => {
    let calls = 0;
    const { settleReadFailed, refetch, mintToken, refetchSession, resolver } =
      makeResolverHarness({
        unauthorizedSuppressMs: 40,
        mintImpl: () => {
          calls += 1;
          return Promise.resolve(
            calls === 1 ? { unauthorized: true as const } : "recovered-token",
          );
        },
      });
    settleReadFailed();

    // Outage: /token 401 → cache empty, session re-read requested.
    await expect(resolver()).resolves.toBeNull();
    expect(mintToken).toHaveBeenCalledTimes(1);
    expect(refetchSession).toHaveBeenCalledTimes(1);

    // That re-read fails too: the provider forwards pending, then failed.
    // New snapshots, but no news: the window holds.
    refetch();
    settleReadFailed();
    await expect(resolver()).resolves.toBeNull();
    await expect(resolver({ bypassCache: true })).resolves.toBeNull();
    expect(mintToken).toHaveBeenCalledTimes(1);

    // Past the window the next batch tries the cookie again (DB is back).
    await new Promise((r) => setTimeout(r, 60));
    await expect(resolver()).resolves.toBe("recovered-token");
    expect(mintToken).toHaveBeenCalledTimes(2);
  });

  it("a hung re-read after a failed read falls through to the cookie mint past the bound", async () => {
    const { settleReadFailed, refetch, mintToken, resolver } =
      makeResolverHarness({ settleTimeoutMs: 15 });
    settleReadFailed();
    refetch(); // the retry's get-session hangs

    await expect(resolver()).resolves.toBe("minted-token");
    // The stretch timed out once; the known-anonymous shortcut must still
    // not apply to a failed read.
    const second = makeResolverHarness({ settleTimeoutMs: 15 });
    second.settleReadFailed();
    second.refetch();
    second.tracker.markSettleTimedOut();
    await expect(second.resolver()).resolves.toBe("minted-token");
    expect(mintToken).toHaveBeenCalledTimes(1);
    expect(second.mintToken).toHaveBeenCalledTimes(1);
  });
});

describe("createAuthRetryFetch + real resolver", () => {
  const fetchMock = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>();
  const url = "https://api.test/trpc/events.list";

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(null, { status: 207 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("an anonymous 207 in the refetch window never mints and never retries", async () => {
    const { settle, refetch, mintToken, resolver } = makeResolverHarness();
    settle(false);
    refetch();

    const response = createAuthRetryFetch(resolver)(url, {
      method: "GET",
      headers: {},
    });
    await Promise.resolve();
    settle(false);
    await response;

    expect(mintToken).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a signed-in 207 from the cold-load race is still rescued", async () => {
    const { settle, mintToken, resolver } = makeResolverHarness();
    settle(true);

    await createAuthRetryFetch(resolver)(url, { method: "GET", headers: {} });

    expect(mintToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Authorization"),
    ).toBe("Bearer minted-token");
  });
});

describe("shouldRetryWithFreshToken", () => {
  it("retries plain 401s regardless of method or auth header", () => {
    // A uniform 401 means the server rejected the request before executing
    // anything, so even a mutation batch is safe to replay.
    expect(shouldRetryWithFreshToken(401, true, "POST")).toBe(true);
    expect(shouldRetryWithFreshToken(401, false, "GET")).toBe(true);
    expect(shouldRetryWithFreshToken(401, false, undefined)).toBe(true);
  });

  it("retries an unauthenticated 207 only for GET batches", () => {
    expect(shouldRetryWithFreshToken(207, false, "GET")).toBe(true);
    // Absent method means GET (fetch's default); lowercase normalizes.
    expect(shouldRetryWithFreshToken(207, false, undefined)).toBe(true);
    expect(shouldRetryWithFreshToken(207, false, "get")).toBe(true);
    // A 207 means SOME procedures may have executed; POST batches carry
    // mutations, which must never be replayed wholesale.
    expect(shouldRetryWithFreshToken(207, false, "POST")).toBe(false);
    expect(shouldRetryWithFreshToken(207, true, "GET")).toBe(false);
  });

  it("never retries ordinary statuses", () => {
    expect(shouldRetryWithFreshToken(200, false, "GET")).toBe(false);
    expect(shouldRetryWithFreshToken(200, true, "POST")).toBe(false);
    expect(shouldRetryWithFreshToken(500, false, "GET")).toBe(false);
  });
});

describe("createAuthRetryFetch", () => {
  // vitest 1.x `vi.fn` generics are (args-tuple, return) — not the fn type.
  const fetchMock = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const url = "https://api.test/trpc/events.getEventForEdit";

  function retryFetchWith(freshToken: string | null) {
    const resolveAuthToken = vi.fn((_options?: { bypassCache?: boolean }) =>
      Promise.resolve(freshToken),
    );
    return { resolveAuthToken, doFetch: createAuthRetryFetch(resolveAuthToken) };
  }

  it("retries an unauthenticated 207 query batch exactly once with the fresh token", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 207 }));
    const { resolveAuthToken, doFetch } = retryFetchWith("fresh-token");

    await doFetch(url, {
      method: "GET",
      headers: { "content-type": "application/json" },
    });

    // One retry even though the retry ALSO came back 207 — no loops.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(resolveAuthToken).toHaveBeenCalledTimes(1);
    expect(resolveAuthToken).toHaveBeenCalledWith({ bypassCache: true });
    const retryInit = fetchMock.mock.calls[1]?.[1];
    expect(new Headers(retryInit?.headers).get("Authorization")).toBe(
      "Bearer fresh-token",
    );
    // Session cookies must still ride along on the retry.
    expect(retryInit?.credentials).toBe("include");
  });

  it("does not retry a 207 when no fresh token is available (anonymous viewer)", async () => {
    const original = new Response(null, { status: 207 });
    fetchMock.mockResolvedValue(original);
    const { doFetch } = retryFetchWith(null);

    const response = await doFetch(url, { method: "GET", headers: {} });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response).toBe(original);
  });

  it("never replays a POST batch on 207 — mutations may have partially executed", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 207 }));
    const { resolveAuthToken, doFetch } = retryFetchWith("fresh-token");

    // Even inside the race window (no auth header, token mintable): a public
    // mutation in the batch may already have succeeded server-side.
    await doFetch(url, { method: "POST", headers: {} });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resolveAuthToken).not.toHaveBeenCalled();
  });

  it("does not retry a successful response", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const { resolveAuthToken, doFetch } = retryFetchWith("fresh-token");

    await doFetch(url, { method: "POST", headers: {} });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resolveAuthToken).not.toHaveBeenCalled();
  });

  it("does not retry a 207 when the request already carried an auth header", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 207 }));
    const { resolveAuthToken, doFetch } = retryFetchWith("fresh-token");

    // Headers instance — exercises normalization, and Headers lookups are
    // case-insensitive.
    await doFetch(url, {
      method: "GET",
      headers: new Headers({ authorization: "Bearer already-sent" }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resolveAuthToken).not.toHaveBeenCalled();
  });

  it("detects the auth header in tuple-array form too", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 207 }));
    const { resolveAuthToken, doFetch } = retryFetchWith("fresh-token");

    await doFetch(url, {
      method: "GET",
      headers: [["authorization", "Bearer already-sent"]],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resolveAuthToken).not.toHaveBeenCalled();
  });

  it("still retries a plain 401 with a fresh token (pre-existing behaviour)", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    const { doFetch } = retryFetchWith("fresh-token");

    // Deliberately a POST: a uniform 401 means nothing executed, so the
    // method gate on the 207 branch must not apply here.
    await doFetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer expired" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Authorization"),
    ).toBe("Bearer fresh-token");
  });
});

describe("trpcLogger — expected procedure errors", () => {
  // A procedure error as the tRPC client surfaces it: `data` is the wire
  // shape's data, where the router's errorFormatter puts `appCode`.
  const procedureError = (code: string, appCode?: string) =>
    Object.assign(new Error("Payment has not succeeded"), {
      data: { code, ...(appCode ? { appCode } : {}) },
    });

  const logDown = (path: string, result: Error) =>
    trpcLogger({
      direction: "down",
      type: "mutation",
      path,
      id: 1,
      input: undefined,
      context: {},
      elapsedMs: 12,
      result,
    } as unknown as Parameters<typeof trpcLogger>[0]);

  type ConsoleSpy = MockInstance<Parameters<typeof console.error>, void>;
  let errorSpy: ConsoleSpy;
  let warnSpy: ConsoleSpy;
  let debugSpy: ConsoleSpy;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it("orders.confirmPayment + CONFLICT + PAYMENT_NOT_SUCCEEDED is a handled outcome: debug, never console.error", () => {
    logDown(
      "orders.confirmPayment",
      procedureError("CONFLICT", "PAYMENT_NOT_SUCCEEDED"),
    );
    expect(errorSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(String(debugSpy.mock.calls[0]?.[0])).toContain(
      "orders.confirmPayment",
    );
  });

  it("the same path with a different app code still console.errors", () => {
    logDown(
      "orders.confirmPayment",
      procedureError("CONFLICT", "ORDER_ALREADY_FINALIZED"),
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("the same path with a different tRPC code still console.errors", () => {
    logDown(
      "orders.confirmPayment",
      procedureError("INTERNAL_SERVER_ERROR", "PAYMENT_NOT_SUCCEEDED"),
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("the same path with no app code on the wire still console.errors", () => {
    logDown("orders.confirmPayment", procedureError("CONFLICT"));
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("PAYMENT_NOT_SUCCEEDED on another path still console.errors", () => {
    logDown(
      "orders.createCheckout",
      procedureError("CONFLICT", "PAYMENT_NOT_SUCCEEDED"),
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("the listed NOT_FOUND public reads stay off console.error, for any app code", () => {
    logDown("volunteer.publicRoles.list", procedureError("NOT_FOUND"));
    logDown(
      "volunteer.publicRoles.waiver",
      procedureError("NOT_FOUND", "EVENT_NOT_FOUND"),
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("a listed NOT_FOUND path with a different code still console.errors", () => {
    logDown("volunteer.publicRoles.list", procedureError("FORBIDDEN"));
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  // B2: every web surface answers the email gate with the verify prompt, so
  // the refusal is a handled outcome on ANY path (see isEmailGateRefusal).
  const gateRefusal = () =>
    Object.assign(new Error("email_verification_required"), {
      data: { code: "FORBIDDEN", appCode: "FORBIDDEN" },
    });

  it("the email gate refusal is debug on any path, never console.error", () => {
    logDown("orders.listMyOrders", gateRefusal());
    logDown("resale.createCheckout", gateRefusal());
    logDown("volunteer.roster.coordinator", gateRefusal());
    expect(errorSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledTimes(3);
    expect(String(debugSpy.mock.calls[0]?.[0])).toContain(
      "email_verification_required",
    );
  });

  it("any other FORBIDDEN on a gated path still console.errors", () => {
    logDown(
      "orders.listMyOrders",
      Object.assign(new Error("forbidden"), {
        data: { code: "FORBIDDEN", appCode: "FORBIDDEN" },
      }),
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("the gate message under another tRPC code still console.errors", () => {
    logDown(
      "orders.listMyOrders",
      Object.assign(new Error("email_verification_required"), {
        data: { code: "INTERNAL_SERVER_ERROR" },
      }),
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("network failures (no tRPC code) still warn, unchanged", () => {
    logDown("orders.confirmPayment", new TypeError("fetch failed"));
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["CONFLICT", "PAYMENT_INTENT_ORDER_MISMATCH"],
    ["TOO_MANY_REQUESTS", "RATE_LIMITED"],
  ])(
    "embeds.releaseGuestOrder + %s + %s is a handled refusal: debug, never console.error",
    (code, appCode) => {
      logDown("embeds.releaseGuestOrder", procedureError(code, appCode));
      expect(debugSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).not.toHaveBeenCalled();
    },
  );

  it("embeds.releaseGuestOrder TOO_MANY_REQUESTS with no appCode (the per-IP limiter) still console.errors", () => {
    logDown("embeds.releaseGuestOrder", procedureError("TOO_MANY_REQUESTS"));
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("embeds.releaseGuestOrder with any other code still console.errors", () => {
    logDown(
      "embeds.releaseGuestOrder",
      procedureError("INTERNAL_SERVER_ERROR", "RATE_LIMITED"),
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("a deal read with no deal to show is a handled outcome, a fault is not", () => {
    expect(
      isExpectedProcedureError(
        "deals.getTermsDeal",
        "NOT_FOUND",
        "PAYOUT_TERMS_NOT_FOUND",
      ),
    ).toBe(true);
    expect(
      isExpectedProcedureError(
        "deals.getTermsDeal",
        "FORBIDDEN",
        "AGREEMENT_FINALIZED",
      ),
    ).toBe(true);
    expect(
      isExpectedProcedureError(
        "deals.getTermsDeal",
        "CONFLICT",
        "AGREEMENT_MISSING_PAYOUT_TERMS",
      ),
    ).toBe(true);
    // Not a party is a real refusal; a write refusal is not a read outcome.
    expect(
      isExpectedProcedureError(
        "deals.getTermsDeal",
        "FORBIDDEN",
        "NOT_AGREEMENT_PARTY",
      ),
    ).toBe(false);
    expect(
      isExpectedProcedureError(
        "deals.setTermsDeal",
        "CONFLICT",
        "AGREEMENT_MISSING_PAYOUT_TERMS",
      ),
    ).toBe(false);
  });

  it("an archived place's public read is a handled outcome, a missing one is not", () => {
    expect(
      isExpectedProcedureError(
        "places.getPlacePublic",
        "NOT_FOUND",
        "PLACE_ARCHIVED",
      ),
    ).toBe(true);
    expect(
      isExpectedProcedureError(
        "places.getPlacePublic",
        "NOT_FOUND",
        "PLACE_NOT_FOUND",
      ),
    ).toBe(false);
    expect(
      isExpectedProcedureError("places.getPlacePublic", "NOT_FOUND", undefined),
    ).toBe(false);
  });

  it("an archived place's booking options are a handled outcome, a missing place is not", () => {
    expect(
      isExpectedProcedureError(
        "places.getBookingOptions",
        "NOT_FOUND",
        "PLACE_ARCHIVED",
      ),
    ).toBe(true);
    expect(
      isExpectedProcedureError(
        "places.getBookingOptions",
        "NOT_FOUND",
        "PLACE_NOT_FOUND",
      ),
    ).toBe(false);
  });

  it("a non-owner's place-for-edit read is a handled outcome, other refusals are not", () => {
    expect(
      isExpectedProcedureError(
        "places.getPlaceForEdit",
        "FORBIDDEN",
        "NOT_RESOURCE_OWNER",
      ),
    ).toBe(true);
    expect(
      isExpectedProcedureError(
        "places.getPlaceForEdit",
        "NOT_FOUND",
        "PLACE_NOT_FOUND",
      ),
    ).toBe(false);
    expect(
      isExpectedProcedureError(
        "places.getPlaceForEdit",
        "FORBIDDEN",
        undefined,
      ),
    ).toBe(false);
    // The same refusal from another procedure is still a fault.
    expect(
      isExpectedProcedureError(
        "places.upsertPlace",
        "FORBIDDEN",
        "NOT_RESOURCE_OWNER",
      ),
    ).toBe(false);
  });

  it("isExpectedProcedureError needs a tRPC code", () => {
    expect(
      isExpectedProcedureError(
        "orders.confirmPayment",
        undefined,
        "PAYMENT_NOT_SUCCEEDED",
      ),
    ).toBe(false);
  });
});
