"use client";

import {
  createElement,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { httpBatchLink, loggerLink } from "@trpc/client";
import type { LoggerLinkOptions } from "@trpc/client/links/loggerLink";
import { createTRPCReact } from "@trpc/react-query";
import superjson from "superjson";

import type { AppRouter } from "@th/trpc";

import { getTrpcHttpUrl } from "@/config/trpc";
import { authClient } from "@/lib/auth/auth-client";
import { getAuthEpoch, subscribeSignedOut } from "@/lib/auth/auth-epoch";
import { isEmailVerificationRequired } from "@/lib/email-verification-required";
import { makeQueryClient } from "@/lib/query-client";
import { traceIgnoredError } from "@/lib/trace-ignored-error";

export const trpc: ReturnType<typeof createTRPCReact<AppRouter>> =
  createTRPCReact<AppRouter>();

type AuthTokenResolver = (options?: {
  bypassCache?: boolean;
}) => Promise<string | null>;

type TokenCache = { token: string; mintedAtMs: number };
const TOKEN_TTL_MS = 55_000; // keep < query staleTime; JWTs are typically short-lived

type AuthSessionSnapshot = {
  isAuthenticated: boolean;
  isPending: boolean;
  /** The atom has reported `isPending: false` at least once. */
  hasSettled: boolean;
  /** `isAuthenticated` as of the most recent settle (false until one). */
  lastSettledAuthenticated: boolean;
  /**
   * The most recent settle carried no user because the session READ failed
   * (get-session 5xx, 429, network), not because the server answered "no
   * session". Such a reading says nothing about whether the cookie is still
   * good, so the resolver treats it as unknown rather than signed-out.
   */
  lastSettledReadFailed: boolean;
  /**
   * A batch already waited the full settle bound during THIS pending stretch
   * and the atom did not settle. Cleared by the next settle, so every new
   * stretch starts false.
   */
  stretchTimedOut: boolean;
};

/**
 * How long a cold-load batch will wait for `authClient.useSession()` to settle
 * before proceeding with whatever the session ref says. Generous enough for
 * the session round trip on a slow connection; bounded so a hung session
 * endpoint degrades to an anonymous first batch (the old behaviour) instead of
 * blocking the page.
 */
const SESSION_SETTLE_TIMEOUT_MS = 3_000;

/**
 * Bound on the token mint itself. `headers()` awaits the mint before ANY
 * batch — including the public queries an anonymous page depends on — is
 * dispatched, so a hung `/api/auth/token` endpoint must degrade the batch to
 * anonymous (the old behaviour) rather than wedge the whole page's data
 * fetching behind a promise that may never settle.
 */
const MINT_TIMEOUT_MS = 3_000;

/**
 * After a mint answers 401, how long further mints are skipped while the
 * session atom has not reported anything new. It only has to cover the
 * immediate 207 retry of the batch that just went out without a header
 * (milliseconds later). It must stay SHORT: a 401 can come from a transient
 * server-side session-lookup failure, and an errored session refetch tells
 * the tracker nothing new (with a user still in `data`, `useAuthQuery` keeps
 * it and the provider effect does not re-run; without one, the reading is
 * "read failed", which does not end the window either). Without the time
 * bound, a signed-in user would be stranded on anonymous batches until the
 * tab is hidden or reloaded.
 */
const UNAUTHORIZED_SUPPRESS_MS = 5_000;

/**
 * Backoff for re-reading the session after a read FAILED with no user in the
 * atom (see `createSessionReadRetry`): the first retry after this long, then
 * doubling per failed attempt up to the cap. The cap bounds how long a tab
 * that stays put (no focus or visibility event, which are Better Auth's own
 * refetch triggers) keeps looking signed out after the server recovers.
 */
const SESSION_READ_RETRY_BASE_MS = 2_000;
const SESSION_READ_RETRY_MAX_MS = 30_000;

export type SessionTracker = {
  /** Live view of the session atom, read by the token resolver. */
  readonly session: { readonly current: AuthSessionSnapshot };
  /**
   * Resolves at once when the atom is not pending, otherwise on the NEXT
   * update that reports `isPending: false`. Re-armable: the atom goes back to
   * pending on every Better Auth refetch (`isPending: data === null` while a
   * refetch is in flight), and a waiter created during such a refetch must
   * wait for THAT refetch, not for a settle that already happened.
   */
  waitForSettle: () => Promise<void>;
  /**
   * Record that a wait hit the settle bound while the atom was still pending.
   * No-op once the atom has settled.
   */
  markSettleTimedOut: () => void;
  /**
   * Feed one `useSession()` reading. A repeated reading changes no field, but
   * it does swap in a fresh snapshot object, which ends a post-401 mint
   * suppression early (at most one extra mint). `readFailed` marks a settled
   * reading whose null came from a failed session read (see
   * `isRetryableSessionReadError`); omitted means false.
   */
  update: (next: {
    isAuthenticated: boolean;
    isPending: boolean;
    readFailed?: boolean;
  }) => void;
};

/**
 * The provider's session state, extracted (and exported) so the settle
 * semantics are unit-testable without rendering. All waiters of one pending
 * stretch share a single promise, so no new promise is created however many
 * batches time out against a hung session endpoint (each waiter still attaches
 * a small reaction to it until the settle); a settle resolves that promise and
 * drops it. StrictMode's double-run effects just call `update` twice with
 * the same reading, which changes no field the second time.
 */
export function createSessionTracker(): SessionTracker {
  const session: { current: AuthSessionSnapshot } = {
    current: {
      isAuthenticated: false,
      isPending: true,
      hasSettled: false,
      lastSettledAuthenticated: false,
      lastSettledReadFailed: false,
      stretchTimedOut: false,
    },
  };
  let nextSettle: { promise: Promise<void>; resolve: () => void } | null =
    null;

  return {
    session,
    waitForSettle() {
      if (!session.current.isPending) return Promise.resolve();
      if (!nextSettle) {
        let resolve!: () => void;
        const promise = new Promise<void>((r) => {
          resolve = r;
        });
        nextSettle = { promise, resolve };
      }
      return nextSettle.promise;
    },
    markSettleTimedOut() {
      if (!session.current.isPending) return;
      session.current = { ...session.current, stretchTimedOut: true };
    },
    update({ isAuthenticated, isPending, readFailed = false }) {
      const prev = session.current;
      session.current = {
        isAuthenticated,
        isPending,
        hasSettled: prev.hasSettled || !isPending,
        lastSettledAuthenticated: isPending
          ? prev.lastSettledAuthenticated
          : isAuthenticated,
        // A reading with a user is never "read failed", whatever the caller
        // passed: the user is the evidence.
        lastSettledReadFailed: isPending
          ? prev.lastSettledReadFailed
          : readFailed && !isAuthenticated,
        // Cleared on settle, so a stretch that ends gives the next one a fresh
        // flag. A repeated pending reading (StrictMode) keeps it. Better Auth
        // may also start a NEW fetch inside an open stretch with no settle
        // between (a sign-in fetch while a signed-out one hangs), so two
        // fetches can merge into one stretch and the flag stays set. That is
        // why the retry path (`bypassCache`) skips the at-once shortcut below.
        stretchTimedOut: isPending ? prev.stretchTimedOut : false,
      };
      if (!isPending && nextSettle) {
        const settled = nextSettle;
        nextSettle = null;
        settled.resolve();
      }
    },
  };
}

/**
 * Whether a `useSession()` error means the session READ failed, as opposed to
 * the server saying the session is gone. Better Auth 1.6.9's `/get-session`
 * answers 200 with `null` for "no session" and 500 when its lookup throws (a
 * DB outage); its only 401 is a session row deleted mid-refresh, which is a
 * real sign-out. Everything else (5xx, 429, a network throw with no status) is
 * a failed read. Exported for tests.
 */
export function isRetryableSessionReadError(error: unknown): boolean {
  if (error === null || error === undefined) return false;
  return sessionReadErrorStatus(error) !== 401;
}

/**
 * Whether a failed session read is worth re-reading on a timer: a 5xx, a 429,
 * or an error with no HTTP status (the fetch itself threw: network, CORS,
 * abort). Any other 4xx (400, 403, ...) will answer the same way next time, so
 * the retry stops; the reading stays "unknown" to the resolver all the same.
 * Exported for tests.
 */
export function isTransientSessionReadError(error: unknown): boolean {
  if (error === null || error === undefined) return false;
  const status = sessionReadErrorStatus(error);
  if (typeof status !== "number") return true;
  return status >= 500 || status === 429;
}

function sessionReadErrorStatus(error: unknown): unknown {
  return typeof error === "object" && error !== null && "status" in error
    ? (error as { status?: unknown }).status
    : undefined;
}

/** Spread of the random factor applied to each retry delay (±20%). */
const SESSION_READ_RETRY_JITTER = 0.2;

export type SessionReadRetry = {
  /**
   * Feed one `useSession()` reading. A settled reading whose read failed with
   * a transient error (`retryable`, default true) starts the retry loop (no-op
   * if it is running); any other settled reading resets the backoff and stops
   * the loop; a pending reading changes nothing.
   */
  onReading: (reading: {
    isPending: boolean;
    readFailed: boolean;
    retryable?: boolean;
  }) => void;
  /**
   * Stop the loop: clears the armed timer and the visibility listener
   * (provider unmount). Keeps the backoff step, so StrictMode's
   * cleanup-then-setup re-arms with the same delay.
   */
  cancel: () => void;
};

type VisibilityDocument = Pick<
  Document,
  "visibilityState" | "addEventListener" | "removeEventListener"
>;

/**
 * Re-read the session, with bounded exponential backoff, while the last read
 * failed with no user in the atom.
 *
 * Why: when a focus refetch of `/get-session` fails, Better Auth's
 * `session-refresh` sets the atom's `data` to null (with `error` set), and
 * nothing re-reads it until the next focus or visibility event. The navbar
 * then shows the user signed out, and with the bearer cache emptied by a
 * `/token` 401 during the same outage, every batch went out anonymous long
 * after the server recovered. Retrying the read restores the atom, so the
 * navbar, the tracker and the bearer recover together.
 *
 * Each attempt arms the NEXT one itself, right after asking for the re-read.
 * It cannot wait for the re-read's reading to re-arm it: `useAuthQuery` sets
 * the atom twice per attempt (pending, then failed), and when React batches
 * both into one render the provider effect sees the same inputs as before and
 * does not run. Only a clean settle (a user, a clean "no session", or a
 * non-transient error) stops the loop, and each of those changes an effect
 * input.
 *
 * Each delay carries ±20% jitter, so tabs that failed together do not retry
 * together. While the tab is hidden the loop pauses at the attempt that came
 * due; on `visibilitychange` back to visible it re-arms that step's delay
 * rather than fetching at once, because Better Auth's focus manager re-reads
 * the session on that same event.
 *
 * A clean signed-out reading never arms a retry: an anonymous visitor costs
 * nothing. `refetchSession` defaults to toggling `$sessionSignal`, the same
 * re-read the resolver asks for after a 401. If it throws, the throw is
 * reported (`reportError`, default `traceIgnoredError`) and the loop goes on.
 * Exported for tests.
 */
export function createSessionReadRetry(
  deps: {
    refetchSession?: () => void;
    reportError?: (err: unknown) => void;
    baseMs?: number;
    maxMs?: number;
    /** Returns [0, 1); drives the jitter. Defaults to `Math.random`. */
    random?: () => number;
    /** Visibility source; defaults to `document` (absent on the server). */
    doc?: VisibilityDocument | null;
  } = {},
): SessionReadRetry {
  const {
    refetchSession = refetchSessionFromClient,
    reportError = traceIgnoredError("auth.session-read-retry"),
    baseMs = SESSION_READ_RETRY_BASE_MS,
    maxMs = SESSION_READ_RETRY_MAX_MS,
    random = Math.random,
    doc = typeof document === "undefined" ? null : document,
  } = deps;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Set while the loop waits for the tab to become visible again.
  let onVisible: (() => void) | null = null;

  const isHidden = () => doc?.visibilityState === "hidden";

  const cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (onVisible !== null) {
      doc?.removeEventListener("visibilitychange", onVisible);
      onVisible = null;
    }
  };

  const delayFor = (step: number) => {
    const base = Math.min(baseMs * 2 ** step, maxMs);
    const factor = 1 + (random() * 2 - 1) * SESSION_READ_RETRY_JITTER;
    return Math.max(0, Math.round(base * factor));
  };

  const pauseUntilVisible = () => {
    if (doc === null || onVisible !== null) return;
    const listener = () => {
      if (isHidden()) return;
      doc.removeEventListener("visibilitychange", listener);
      onVisible = null;
      // Better Auth's focus manager re-reads on this same event; give that
      // read a full step to settle before ours.
      arm();
    };
    onVisible = listener;
    doc.addEventListener("visibilitychange", listener);
  };

  const fire = () => {
    timer = null;
    if (isHidden()) {
      pauseUntilVisible();
      return;
    }
    // Stop growing once capped; keeps `2 ** attempt` finite forever.
    if (baseMs * 2 ** attempt < maxMs) attempt += 1;
    try {
      refetchSession();
    } catch (err) {
      try {
        reportError(err);
      } catch {
        // A throwing reporter must not stop the retries.
      }
    }
    // Armed now, not on the re-read's reading (see the doc comment).
    arm();
  };

  function arm() {
    if (timer !== null || onVisible !== null) return;
    timer = setTimeout(fire, delayFor(attempt));
  }

  return {
    onReading({ isPending, readFailed, retryable = true }) {
      // A fetch is in flight; its settle decides. An armed retry stays armed,
      // so a fetch that hangs cannot strand the tab.
      if (isPending) return;
      if (readFailed && retryable) {
        arm();
        return;
      }
      attempt = 0;
      cancel();
    },
    cancel,
  };
}

/**
 * Race a promise against a bounded timer. The timeout RESOLVES (`undefined`,
 * distinguishable from the promise's own value) rather than rejects — callers
 * degrade gracefully instead of failing the request — and the timer is
 * cleared once the race settles so it can't keep a Node/test process alive.
 */
async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What a mint attempt produced: a token, `null` for a failure that may be
 * transient (network throw, 5xx, empty body), or `{ unauthorized: true }` when
 * the server answered 401. A 401 almost always means the session behind the
 * cookie is gone (banned, password reset, revoked from another device), but
 * it is strong evidence, not proof: Better Auth 1.6.9 also answers 401 when
 * its session lookup THROWS (`getSessionFromCtx` catches to null), e.g. a DB
 * blip. A sign-out in another TAB of this browser does not wait for a 401:
 * Better Auth broadcasts it, and `listenForCrossTabSignOut` turns that into
 * this tab's sign-out signal.
 */
type MintResult = string | null | { unauthorized: true };

/**
 * Ask Better Auth to refetch the session, so the atom catches up with a 401
 * the token endpoint already gave. Toggling `$sessionSignal` is what its own
 * sign-out listener does; `useAuthQuery` refetches `/get-session` on it.
 * Browser only: the session query never runs on the server.
 */
function refetchSessionFromClient(): void {
  if (typeof window === "undefined") return;
  authClient.$store.notify("$sessionSignal");
}

async function mintBearerTokenFromClient(): Promise<MintResult> {
  try {
    const { data, error } = await authClient.token();
    if (error) {
      if (error.status === 401) {
        return { unauthorized: true };
      }
      if (process.env.NODE_ENV === "development") {
        console.warn("[trpc] authClient.token() returned error", error);
      }
      return null;
    }
    const token = data?.token;
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch (error) {
    if (process.env.NODE_ENV === "development") {
      console.warn("[trpc] failed to mint Better Auth token", error);
    }
    return null;
  }
}

/**
 * Build the per-batch Authorization token resolver.
 *
 * Extracted from `TrpcProvider` (and exported) so the cold-load wait logic is
 * unit-testable; the provider wires it to its live refs and the real Better
 * Auth mint. The refs are read at call time, so the resolver itself stays
 * stable for the lifetime of the provider.
 */
export function createAuthTokenResolver(deps: {
  /** Live view of the session atom — `SessionTracker.session` in the provider. */
  session: { readonly current: AuthSessionSnapshot };
  /** Shared mint cache — the provider's `tokenCacheRef`. */
  tokenCache: { current: TokenCache | null };
  /**
   * Resolves when the session atom is (or next becomes) settled —
   * `SessionTracker.waitForSettle` in the provider.
   */
  waitForSettle: () => Promise<void>;
  /**
   * `SessionTracker.markSettleTimedOut` in the provider. Optional: without it
   * every batch in a hung stretch waits the full bound.
   */
  markSettleTimedOut?: () => void;
  /**
   * Injectable for tests; defaults to the real Better Auth mint. A plain
   * `string | null` mint still works: `null` is treated as transient.
   */
  mintToken?: () => Promise<MintResult>;
  /**
   * Injectable for tests; defaults to the real auth epoch, which every
   * successful sign-out through `authClient` bumps.
   */
  getEpoch?: () => number;
  /**
   * Called on a 401 from the mint so the session atom refetches and, if the
   * session is really gone, settles signed-out. Also called when a mint
   * succeeds while the last session read failed (the server is back).
   * Injectable for tests; defaults to toggling Better Auth's `$sessionSignal`
   * (a no-op on the server).
   */
  refetchSession?: () => void;
  /**
   * Reports a throw from the post-mint `refetchSession` call, which is
   * swallowed so the batch keeps its token. Defaults to `traceIgnoredError`.
   */
  reportError?: (err: unknown) => void;
  /**
   * Called every time the resolver hands a batch a token (fresh mint, cached
   * or stale fallback). The provider uses it to arm the sign-out query reset:
   * a cold start whose session reading never settles signed-in still mints
   * from the cookie and fills the cache with per-user data. Must not throw:
   * it runs inside `headers()`, so a throw fails the whole batch.
   */
  onTokenIssued?: () => void;
  settleTimeoutMs?: number;
  unauthorizedSuppressMs?: number;
  mintTimeoutMs?: number;
}): AuthTokenResolver {
  const {
    session,
    tokenCache,
    waitForSettle,
    markSettleTimedOut,
    mintToken = mintBearerTokenFromClient,
    getEpoch = getAuthEpoch,
    refetchSession = refetchSessionFromClient,
    reportError = traceIgnoredError("auth.session-reread-after-mint"),
    onTokenIssued,
    settleTimeoutMs = SESSION_SETTLE_TIMEOUT_MS,
    mintTimeoutMs = MINT_TIMEOUT_MS,
    unauthorizedSuppressMs = UNAUTHORIZED_SUPPRESS_MS,
  } = deps;

  // Share one in-flight mint across concurrent callers. A settle
  // releases parked cold-load batches together (navbar batch + page batch),
  // so without dedup parallel duplicate mints are the NORM on an authed cold
  // load. Cleared when the mint settles — or on timeout, so one hung attempt
  // can't leave every future mint re-awaiting a promise that never settles.
  // Tagged with the auth epoch it started in: an attempt that started before
  // a sign-out carries the signed-out session's cookie, so a caller after the
  // sign-out must start its own attempt rather than join it.
  let mintInFlight: { promise: Promise<MintResult>; epoch: number } | null =
    null;

  const reportRereadError = (err: unknown) => {
    try {
      reportError(err);
    } catch {
      // A throwing reporter must not fail the batch either.
    }
  };

  // The session reading that was current when the mint last answered 401,
  // and when. While the tracker still holds that same reading (it swaps in a
  // fresh object on every update the provider forwards) AND the window is
  // open, another mint would very likely 401 too: this stops the 207 retry of
  // the batch that just went out header-less from firing a second mint while
  // the session refetch is in flight. The tracker alone can't end it — the
  // provider only forwards a reading when `isPending` or the user reference
  // changes, which an errored refetch does neither of — so the TIME bound is
  // what makes the suppression safe. A new reading whose last settle is a
  // failed read is not news either (the 401's own session refetch usually
  // produces one within milliseconds), so it holds the window too: during an
  // outage a tab mints at most once per window. `performance.now()` because
  // the window is a duration: a wall-clock jump must not stretch or skip it.
  let unauthorizedAt: { snapshot: AuthSessionSnapshot; atMs: number } | null =
    null;
  const isSuppressingAfter401 = () =>
    unauthorizedAt !== null &&
    (unauthorizedAt.snapshot === session.current ||
      session.current.lastSettledReadFailed) &&
    performance.now() - unauthorizedAt.atMs < unauthorizedSuppressMs;

  // The reading is a clean "no session" from the server: no user, and the
  // read did not fail. Only this justifies skipping the cookie mint.
  const isKnownSignedOut = (snapshot: AuthSessionSnapshot) =>
    snapshot.hasSettled &&
    !snapshot.lastSettledAuthenticated &&
    !snapshot.lastSettledReadFailed;

  const mintSharedBounded = async (): Promise<{
    result: MintResult;
    epoch: number;
  }> => {
    if (!mintInFlight || mintInFlight.epoch !== getEpoch()) {
      const attempt: { promise: Promise<MintResult>; epoch: number } = {
        epoch: getEpoch(),
        promise: mintToken().finally(() => {
          if (mintInFlight === attempt) {
            mintInFlight = null;
          }
        }),
      };
      mintInFlight = attempt;
    }
    const shared = mintInFlight;
    const minted = await raceWithTimeout(shared.promise, mintTimeoutMs);
    if (minted === undefined) {
      // Timed out — degrade THIS batch to anonymous rather than wedge
      // `headers()`, and drop the shared handle so the next caller starts a
      // fresh attempt instead of piling onto the hung one.
      if (mintInFlight === shared) {
        mintInFlight = null;
      }
      return { result: null, epoch: shared.epoch };
    }
    return { result: minted, epoch: shared.epoch };
  };

  const resolve: AuthTokenResolver = async (options) => {
    let { isAuthenticated, isPending: authPending } = session.current;
    let hadPriorToken = tokenCache.current !== null;

    // The session atom is pending: either a cold load (never settled yet) or
    // a Better Auth refetch, which flips `isPending` back to true while it is
    // in flight. WAIT (bounded) for the next settle instead of bailing —
    // bailing on a cold load used to send the first batch of every authed
    // page with no Authorization header, so every procedure in it came back
    // UNAUTHORIZED inside an HTTP 207 and the UI stuck in an error state. A
    // refetch right after sign-in lands here too, and must wait, then mint.
    if (authPending && !hadPriorToken) {
      // A known-anonymous session whose refetch already outlived the bound
      // once in this stretch: treat first-attempt batches as anonymous rather
      // than make each one wait the full bound again. A signed-in user caught
      // here is recovered by the retry below. Never applies to a cold start that
      // has not settled yet — a signed-in one must still wait, then mint.
      // Never applies to the 207/401 retry (`bypassCache`) either: the stretch
      // may have merged in a sign-in fetch, so the retry waits (bounded).
      // A last settle that was a failed read is not known-anonymous.
      const before = session.current;
      if (
        !options?.bypassCache &&
        before.stretchTimedOut &&
        isKnownSignedOut(before)
      ) {
        return null;
      }
      const settled = await raceWithTimeout(
        waitForSettle().then(() => true),
        settleTimeoutMs,
      );
      if (settled === undefined) {
        markSettleTimedOut?.();
      }
      const snapshot = session.current;
      ({ isAuthenticated, isPending: authPending } = snapshot);
      hadPriorToken = tokenCache.current !== null;
      if (authPending && !hadPriorToken) {
        // Still pending past the bound. A refetch of a session that last
        // settled signed-OUT is no evidence of a session: don't fire a
        // doomed mint (a 401 for every anonymous visitor whose navbar
        // re-checks the session on cold start).
        if (isKnownSignedOut(snapshot)) {
          return null;
        }
        // Never settled (slow or hung session endpoint), last settled
        // signed-in, or last settle was a failed read (unknown): fall
        // through to the cookie-based mint, which can
        // succeed independently of the atom. (Better Auth cannot actually
        // produce "settled signed-in, then pending": its `onRequest` sets
        // `isPending: data === null` and data is non-null when signed in, so
        // that half of the fall-through is defensive.)
        if (process.env.NODE_ENV === "development" && !snapshot.hasSettled) {
          console.warn(
            `[trpc] session atom has not settled after waiting ${settleTimeoutMs}ms — proceeding with cookie-based mint`,
          );
        }
      }
    }

    // If the session atom clearly says "not authenticated" and we never had a
    // token before, there is genuinely no session — bail out immediately so
    // anonymous viewers never fire a doomed mint. Not when the null came from
    // a FAILED read (a DB outage, a 429): that says nothing about the cookie,
    // so mint from it (gated by the 401 window above). Without this a tab
    // whose token cache a `/token` 401 emptied during the outage sent every
    // batch anonymous until the session re-read succeeded, up to the retry cap
    // after the server came back.
    if (
      !isAuthenticated &&
      !authPending &&
      !hadPriorToken &&
      !session.current.lastSettledReadFailed
    ) {
      return null;
    }

    const cached = tokenCache.current;
    const isFresh = cached && Date.now() - cached.mintedAtMs < TOKEN_TTL_MS;
    if (isFresh && !options?.bypassCache) {
      return cached.token;
    }

    // Attempt to mint even if the session atom is temporarily stale (or, past
    // the settle timeout, still pending). `authClient.token()` uses HTTP-only
    // cookies, so it can succeed independently of the in-memory session atom
    // state.
    if (isSuppressingAfter401()) {
      return null;
    }
    const { result, epoch: mintEpoch } = await mintSharedBounded();

    // A sign-out landed while this mint was in flight. Whatever it returned
    // belongs to the signed-out session: don't cache it, don't send it, and
    // don't fall back to the pre-sign-out token captured above either. (The
    // provider already nulled the cache on the sign-out signal.)
    if (mintEpoch !== getEpoch()) {
      return null;
    }

    if (typeof result === "string" && result.length > 0) {
      tokenCache.current = { token: result, mintedAtMs: Date.now() };
      // The cookie mint worked while the session reading still says its last
      // read failed: the server is answering again. Re-read the session now
      // rather than wait out the retry backoff, so the navbar catches up with
      // the bearer. At most once per mint, and mints are cached for the TTL.
      // Guarded: this batch has a good token, and a throw here would fail it.
      const now = session.current;
      if (now.lastSettledReadFailed && !now.isPending) {
        try {
          refetchSession();
        } catch (err) {
          reportRereadError(err);
        }
      }
      return result;
    }

    // The server said 401: almost always a dead session (ban, password
    // reset, revoked elsewhere), though not certainly (see `MintResult`). The
    // cached JWT very likely names that dead session, so drop it rather than
    // resend it for 10 minutes, and have the atom refetch so a really
    // signed-out session settles and the anonymous bail above stops further
    // mints. If the 401 was a server blip, the next batch past the short
    // suppression window simply mints again. Only if the cache still holds
    // what this batch saw: a slow attempt's late 401 must not wipe a token a
    // newer attempt has cached since.
    if (result !== null && typeof result === "object" && result.unauthorized) {
      if (tokenCache.current === cached) {
        tokenCache.current = null;
        // Several callers joined to one 401 mint all land here; one session
        // refetch is enough.
        if (!isSuppressingAfter401()) {
          unauthorizedAt = {
            snapshot: session.current,
            atMs: performance.now(),
          };
          refetchSession();
        }
      }
      return null;
    }

    // Token mint failed transiently (network, 5xx, timeout) — if we had a
    // cached token whose TTL just expired, return it anyway as a best-effort
    // fallback (the JWT itself may still be valid; the 15-min server-side
    // expiry is longer than our 55-second TTL).
    if (cached && !options?.bypassCache) {
      const tokenAgeMs = Date.now() - cached.mintedAtMs;
      // Allow stale tokens up to 10 minutes old (JWT server expiry is 15 min).
      if (tokenAgeMs < 10 * 60 * 1000) {
        if (process.env.NODE_ENV === "development") {
          console.warn(
            `[trpc] token mint failed, using stale token (age: ${Math.round(tokenAgeMs / 1000)}s)`,
          );
        }
        return cached.token;
      }
    }

    return null;
  };

  return async (options) => {
    const token = await resolve(options);
    if (token !== null) onTokenIssued?.();
    return token;
  };
}

/**
 * Null the token cache on every deliberate sign-out. Returns the unsubscribe
 * function, so it slots straight into a `useEffect` (StrictMode's
 * subscribe → unsubscribe → subscribe leaves exactly one listener). Exported
 * for tests; `subscribe` is injectable for the same reason.
 */
export function bindTokenCacheToSignOut(
  tokenCache: { current: TokenCache | null },
  subscribe: (listener: () => void) => () => void = subscribeSignedOut,
): () => void {
  return subscribe(() => {
    tokenCache.current = null;
  });
}

/**
 * Drop every cached query's data on a deliberate sign-out. The provider stays
 * mounted across sign-out (every sign-out is client-side), so without this the
 * signed-out user's orders, profile and saves sat in the cache, and the next
 * user to sign in on that browser saw them until their own refetch landed.
 *
 * `resetQueries`, not `clear`: reset returns each query to its initial state
 * (no data, and errored queries lose the data they kept from before the
 * error) and refetches the active ones, while `clear` removes the Query
 * objects out from under mounted observers, which keep rendering the old data.
 * The mutation cache is left alone: in-flight flows (delete account, then
 * sign out) depend on it.
 *
 * Resets only if the provider has seen evidence of a signed-in viewer since
 * the last reset. `LoginCard` and `SignUpCard` sign out defensively before
 * every password sign-in, and `/sign-out` answers 200 with no session, so the
 * signal also fires from an anonymous state; resetting then would flash every
 * visible query to loading under the sign-in overlay and fetch it twice. The
 * provider sets the flag on every session reading with a user AND every time
 * the token resolver hands out a token (a cold start can mint from the cookie
 * without the session reading ever settling signed-in), and never clears it on
 * a null reading, so a transient null reading cannot cause a missed reset. The
 * flag clears only once a reset has started, so a reset that throws is tried
 * again on the next signal.
 *
 * Never throws: listeners run inside the auth client's fetch hook, so a throw
 * would reject the caller's `signOut()`. Returns the unsubscribe function, for
 * a `useEffect`. Exported for tests; `subscribe` and `reportError` are
 * injectable for the same reason (`reportError` defaults to
 * `traceIgnoredError`, which records the swallow in Sentry).
 */
export function bindQueryCacheToSignOut(
  queryClient: Pick<QueryClient, "resetQueries">,
  hadAuthenticatedReading: { current: boolean },
  subscribe: (listener: () => void) => () => void = subscribeSignedOut,
  reportError: (err: unknown) => void = traceIgnoredError(
    "auth.sign-out-query-reset",
  ),
): () => void {
  const report = (err: unknown) => {
    try {
      reportError(err);
    } catch {
      // A throwing reporter must never reject the caller's signOut().
    }
  };
  return subscribe(() => {
    if (!hadAuthenticatedReading.current) return;
    try {
      const reset = queryClient.resetQueries();
      hadAuthenticatedReading.current = false;
      // Refetch failures resolve (throwOnError is off); the catch is for a
      // rejection we did not foresee, so it cannot surface as unhandled.
      reset.catch(report);
    } catch (err) {
      report(err);
    }
  });
}

const TRPC_DEBUG = process.env.NEXT_PUBLIC_TRPC_DEBUG === "1";

// ─────────────────────────────────────────────────────────────────────────────
// Custom tRPC logger
//
// Replaces the default `[[ << query #7 ]embeds.list {}` line with a more
// specific format:
//
//   ▶ query  embeds.list                                #7
//   ◀ query  embeds.list                       124ms   #7 → 8 items
//   ✗ query  embeds.list                       124ms   #7  FORBIDDEN  not_member
//
// Direction arrow + type + padded path + elapsed (down only) + id +
// short result/error summary. CSS-styled in the browser, plain on server.
// ─────────────────────────────────────────────────────────────────────────────

const PATH_PAD = 44;
const TYPE_PAD = 12;

const TYPE_COLOR: Record<string, string> = {
  query: "color: #6ea0ff",
  mutation: "color: #ff7e52",
};

function summarizeResult(data: unknown): string {
  if (data == null) return "";
  if (Array.isArray(data))
    return `→ ${data.length} item${data.length === 1 ? "" : "s"}`;
  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    // tRPC envelopes a query payload in `{ data }`. Drill down once if so.
    const inner =
      "data" in obj && obj.data && typeof obj.data === "object"
        ? (obj.data as Record<string, unknown>)
        : obj;
    // Prefer common collection-shaped keys for a meaningful count.
    for (const k of ["items", "rows", "events", "results", "list"]) {
      const v = inner[k];
      if (Array.isArray(v)) return `→ ${v.length} ${k}`;
    }
    const keys = Object.keys(inner);
    return keys.length === 0
      ? "→ {}"
      : `→ {${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ", …" : ""}}`;
  }
  const str = String(data);
  return `→ ${str.length > 40 ? str.slice(0, 37) + "…" : str}`;
}

type TrpcErrorLike = {
  data?: { code?: string; appCode?: string };
  message?: string;
  shape?: { message?: string; data?: { code?: string; appCode?: string } };
};

/**
 * Procedure errors that are handled business outcomes, not faults. The link
 * logger reports them at `console.debug` instead of `console.error`, so they
 * neither trip Next.js's dev error overlay nor fail an e2e spec through the
 * console-error fixture. The React Query consumer may pass
 * `meta: { silent: true }` to skip a toast, but the link layer cannot see
 * that meta, so the outcomes are listed here.
 *
 * Match on path + tRPC code, and on the app error code (the wire's
 * `data.appCode`) when `appCode` is set. Keep entries narrow: a broader match
 * hides real failures.
 */
const EXPECTED_PROCEDURE_ERRORS: ReadonlyArray<{
  path: string;
  code: string;
  appCode?: string;
}> = [
  // Public reads that collapse "not visible to you" into NOT_FOUND, so they do
  // not leak whether a draft event exists.
  { path: "volunteer.publicRoles.list", code: "NOT_FOUND" },
  { path: "volunteer.publicRoles.waiver", code: "NOT_FOUND" },
  // The lineup invite page answers "not on this bill" with NOT_FOUND for
  // everyone, and renders its own not-found state.
  {
    path: "bookingRequests.getActInvite",
    code: "NOT_FOUND",
    appCode: "BOOKING_REQUEST_NOT_FOUND",
  },
  // The payment did not go through (declined, abandoned, or still pending).
  // The checkout reads it and shows the declined/terminal screen.
  {
    path: "orders.confirmPayment",
    code: "CONFLICT",
    appCode: "PAYMENT_NOT_SUCCEEDED",
  },
  // The embed gives back an abandoned order and the server declines: the order
  // is not this embed's (or was made before the embed binding), or its own
  // release budget is spent. The embed treats both as "unanswered".
  {
    path: "embeds.releaseGuestOrder",
    code: "CONFLICT",
    appCode: "PAYMENT_INTENT_ORDER_MISMATCH",
  },
  {
    path: "embeds.releaseGuestOrder",
    code: "TOO_MANY_REQUESTS",
    appCode: "RATE_LIMITED",
  },
  // "The deal" reads a target that has no deal to show: an event or group
  // with no terms yet, an event whose terms the booking owns, an agreement
  // made without terms. `DealEditor` / `DealSummary` draw each as its own state.
  {
    path: "deals.getTermsDeal",
    code: "NOT_FOUND",
    appCode: "PAYOUT_TERMS_NOT_FOUND",
  },
  {
    path: "deals.getTermsDeal",
    code: "FORBIDDEN",
    appCode: "AGREEMENT_FINALIZED",
  },
  {
    path: "deals.getTermsDeal",
    code: "CONFLICT",
    appCode: "AGREEMENT_MISSING_PAYOUT_TERMS",
  },
  // Reads of an ARCHIVED place: a final answer, not a fault. The event builder
  // shows its own "<place> is archived" notice for it. Only the console level
  // changes here, for every caller; whether a caller reports or toasts is its
  // own query's business. A missing place (PLACE_NOT_FOUND) still errors.
  {
    path: "places.getPlacePublic",
    code: "NOT_FOUND",
    appCode: "PLACE_ARCHIVED",
  },
  {
    path: "places.getBookingOptions",
    code: "NOT_FOUND",
    appCode: "PLACE_ARCHIVED",
  },
  // A signed-in viewer who does not own the place. `useVenueEditorLink` asks
  // this on every place page and reads the refusal as "no owner editor link".
  // A missing place (PLACE_NOT_FOUND) still errors.
  {
    path: "places.getPlaceForEdit",
    code: "FORBIDDEN",
    appCode: "NOT_RESOURCE_OWNER",
  },
];

/**
 * The B2 email gate (owner ruling 2026-10-16), the one PATH-INDEPENDENT
 * expected error. Every own-orders / tickets / listings / claims / credits /
 * reviews / coordinator procedure refuses an unverified account with FORBIDDEN
 * `email_verification_required`, and every web surface that calls one answers
 * it with the verify prompt (`EmailVerificationRequired`). Listing each path
 * would drift the moment a procedure joins the gate, so the rule matches the
 * refusal itself. It is still narrow: FORBIDDEN plus that exact message (the
 * wire `appCode` is the generic FORBIDDEN, so it cannot be the key). Every
 * other FORBIDDEN still logs at console.error.
 */
const isEmailGateRefusal = (
  code: string | undefined,
  message: string | undefined,
): boolean =>
  code === "FORBIDDEN" && isEmailVerificationRequired({ message });

/** Exported for tests. */
export function isExpectedProcedureError(
  path: string,
  code: string | undefined,
  appCode: string | undefined,
  message?: string,
): boolean {
  if (!code) return false;
  if (isEmailGateRefusal(code, message)) return true;
  return EXPECTED_PROCEDURE_ERRORS.some(
    (entry) =>
      entry.path === path &&
      entry.code === code &&
      (entry.appCode === undefined || entry.appCode === appCode),
  );
}

function summarizeError(err: TrpcErrorLike): string {
  const code = err.data?.code ?? err.shape?.data?.code ?? "ERROR";
  const msg = err.shape?.message ?? err.message ?? "";
  return msg
    ? `${code}  ${msg.length > 60 ? msg.slice(0, 57) + "…" : msg}`
    : code;
}

function padPath(path: string): string {
  if (path.length >= PATH_PAD) return path;
  return path + " ".repeat(PATH_PAD - path.length);
}

function padType(type: string): string {
  if (type.length >= TYPE_PAD) return type;
  return type + " ".repeat(TYPE_PAD - type.length);
}

/** Exported for tests. */
export const trpcLogger: NonNullable<LoggerLinkOptions<AppRouter>["logger"]> = (
  opts,
) => {
  const isBrowser = typeof window !== "undefined";
  const { direction, type, path, id } = opts;
  const css = isBrowser ? (TYPE_COLOR[type] ?? "") : "";

  if (direction === "up") {
    const head = `▶ %c${padType(type)}%c ${padPath(path)} #${id}`;
    if (isBrowser) console.log(head, css, "color: inherit");
    else console.log(head.replace(/%c/g, ""));
    return;
  }

  const elapsedMs: number | undefined = opts.elapsedMs;
  const elapsed =
    elapsedMs == null ? "" : `${String(elapsedMs).padStart(4, " ")}ms`;
  const result = opts.result;

  if (result instanceof Error) {
    // Network-level failures (fetch threw a TypeError because the API is
    // unreachable, restarting, CORS-blocked, etc.) are operational noise —
    // react-query already retries them. Surface as a warning so Next.js's
    // dev error overlay doesn't flag every API hot-reload.
    const errLike = result as TrpcErrorLike;
    const code = errLike.data?.code ?? errLike.shape?.data?.code;
    const isProcedureError = Boolean(code);

    const summary = isProcedureError
      ? summarizeError(errLike)
      : `NETWORK  ${result.message || "fetch failed"}`;
    const head = `✗ %c${padType(type)}%c ${padPath(path)} ${elapsed}  #${id}  ${summary}`;
    const appCode = errLike.data?.appCode ?? errLike.shape?.data?.appCode;
    const message = errLike.shape?.message ?? errLike.message;
    if (isExpectedProcedureError(path, code, appCode, message)) {
      console.debug(head.replace(/%c/g, ""));
      return;
    }
    const log = isProcedureError ? console.error : console.warn;
    const accent = isProcedureError
      ? "color: #ef4444; font-weight: 700"
      : "color: #f59e0b; font-weight: 700";
    if (isBrowser) log(head, accent, "color: inherit");
    else log(head.replace(/%c/g, ""));
    return;
  }

  const dataField = (result as { result?: { data?: unknown } } | undefined)
    ?.result?.data;
  const summary = summarizeResult(dataField);
  const head = `◀ %c${padType(type)}%c ${padPath(path)} ${elapsed}  #${id} ${summary}`;
  if (isBrowser) console.log(head, css, "color: inherit");
  else console.log(head.replace(/%c/g, ""));
};

/**
 * Decide whether a response is worth one retry with a freshly-minted token.
 *
 * - Plain 401: the whole request was rejected before anything executed, so a
 *   retry is safe for any method (the session/JWT simply expired mid-flight).
 *   Always retry once.
 * - Batch 207 with NO Authorization header, GET only: tRPC reports
 *   per-procedure errors inside an HTTP 207, so a batch that lost the
 *   cold-load race (session atom not settled when `headers()` ran) never
 *   trips the 401 branch. We deliberately do NOT sniff the body for
 *   UNAUTHORIZED — that would mean cloning and consuming a potentially large
 *   payload on every batch. "No auth header + 207" only occurs in the race
 *   window; genuinely-anonymous viewers can pass this check but then fail to
 *   mint a token, so they never actually retry. Restricted to GET because a
 *   207 means SOME procedures may have EXECUTED, and `httpBatchLink` groups
 *   mutations into POST batches — a cold-race POST batch containing a public
 *   mutation that already succeeded (e.g. `announcements.unsubscribe`,
 *   `placeReviews.createSession`) must never be replayed wholesale.
 */
export function shouldRetryWithFreshToken(
  status: number,
  requestHadAuthHeader: boolean,
  method: string | undefined,
): boolean {
  if (status === 401) return true;
  // An absent method means GET — fetch's default.
  const isGet = (method ?? "GET").toUpperCase() === "GET";
  return status === 207 && isGet && !requestHadAuthHeader;
}

/**
 * Fetch wrapper for `httpBatchLink` (exported for tests): sends with
 * credentials and retries at most once with a fresh token when
 * `shouldRetryWithFreshToken` flags the response as a recoverable auth
 * failure.
 */
export const createAuthRetryFetch =
  (resolveAuthToken: AuthTokenResolver) =>
  (url: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    const doFetch = (override?: { token?: string | null }) => {
      const headers = new Headers(options?.headers);
      if (override?.token) {
        headers.set("Authorization", `Bearer ${override.token}`);
      }
      return fetch(url, {
        ...options,
        credentials: "include",
        headers,
      });
    };

    return (async () => {
      // Normalize before checking — `options.headers` may be a plain object,
      // an array of tuples, or a Headers instance.
      const sentAuthHeader = new Headers(options?.headers).has("Authorization");
      // `Request#method` is already normalized (uppercase, defaults to GET);
      // an init method may be absent or lowercase.
      const method =
        options?.method ?? (url instanceof Request ? url.method : undefined);
      const response = await doFetch();
      if (
        !shouldRetryWithFreshToken(response.status, sentAuthHeader, method)
      ) {
        return response;
      }

      // Expired session (401) or the cold-load race window (unauthenticated
      // batch 207): try fetching a *fresh* token and retry once.
      const freshToken = await resolveAuthToken({ bypassCache: true });
      if (!freshToken) {
        return response;
      }

      return doFetch({ token: freshToken });
    })();
  };

const createTrpcClient = (resolveAuthToken: AuthTokenResolver) =>
  trpc.createClient({
    links: [
      loggerLink({
        logger: trpcLogger,
        enabled: (opts) => {
          if (TRPC_DEBUG && typeof window !== "undefined") return true;
          return opts.direction === "down" && opts.result instanceof Error;
        },
      }),
      // NOTE: the cold-load 207 retry in `createAuthRetryFetch` only fires for
      // GET batches. Adding `methodOverride: "POST"` here (the usual fix for
      // long superjson inputs blowing URL-length limits) would silently disable
      // that rescue and resurrect the first-batch UNAUTHORIZED bug — if you
      // need POST queries, rework `shouldRetryWithFreshToken` first.
      httpBatchLink({
        url: getTrpcHttpUrl(),
        transformer: superjson,
        headers: async () => {
          const token = await resolveAuthToken();
          if (!token) {
            return {};
          }
          return { Authorization: `Bearer ${token}` };
        },
        fetch: createAuthRetryFetch(resolveAuthToken),
      }),
    ],
  });

export const TrpcProvider: (props: { children: ReactNode }) => ReactNode = ({
  children,
}) => {
  // Better Auth manages auth state internally via the client.
  // We don't need reactive auth state here; we just need a token fetcher.
  // (Keeping this component stable avoids unnecessary re-creation of the tRPC client.)

  const tokenCacheRef = useRef<TokenCache | null>(null);
  // Session state for `resolveAuthToken`: a live snapshot plus a re-armable
  // "next settle" signal that pending batches park on instead of going out
  // unauthenticated. `useState` keeps ONE tracker for the provider's lifetime.
  const [sessionTracker] = useState(createSessionTracker);
  // Sticky: set by every reading with a user and every token the resolver
  // hands out, cleared only by a query reset on sign-out (see
  // `bindQueryCacheToSignOut`). A transient null reading leaves it alone.
  const hadAuthenticatedReadingRef = useRef(false);

  // Keep auth state in the tracker so `resolveAuthToken` can decide whether it
  // should even *attempt* to call the Better Auth token endpoint.
  const { data: session, isPending, error } = authClient.useSession();
  // A settled null that came from a failed read (DB outage, 429, network),
  // not from the server saying "no session". A boolean, so a repeated failure
  // (a fresh error object each time) does not re-run the effect by itself.
  const readFailed =
    !isPending && !session?.user && isRetryableSessionReadError(error);
  // Worth re-reading on a timer (5xx, 429, network); a 400/403 is not.
  const readRetryable = readFailed && isTransientSessionReadError(error);
  // One retry scheduler for the provider's lifetime.
  const [sessionReadRetry] = useState(() => createSessionReadRetry());
  useEffect(() => {
    const wasAuthenticated = sessionTracker.session.current.isAuthenticated;
    const isNowAuthenticated = Boolean(session?.user);
    // A settled reading releases every batch parked on the current pending
    // stretch; a pending reading (refetch) re-arms the signal for the next.
    sessionTracker.update({
      isAuthenticated: isNowAuthenticated,
      isPending,
      readFailed,
    });
    // A transient failed read starts the backoff re-reads; any clean settle
    // (or a permanent 4xx) stops them and resets the backoff.
    sessionReadRetry.onReading({
      isPending,
      readFailed,
      retryable: readRetryable,
    });
    if (isNowAuthenticated) hadAuthenticatedReadingRef.current = true;
    if (
      process.env.NODE_ENV === "development" &&
      wasAuthenticated &&
      !isNowAuthenticated &&
      !isPending
    ) {
      console.warn(
        readFailed
          ? "[trpc] session read failed: re-reading with backoff"
          : "[trpc] session dropped: isAuthenticated went from true → false while not pending",
      );
    }
  }, [
    isPending,
    session?.user,
    readFailed,
    readRetryable,
    sessionTracker,
    sessionReadRetry,
  ]);
  // Unmount stops the retries (timer and visibility listener). Under StrictMode the reading effect above runs
  // again after this cleanup and re-arms.
  useEffect(() => () => sessionReadRetry.cancel(), [sessionReadRetry]);

  // A deliberate sign-out drops the minted token at once. Without this the
  // provider (which stays mounted — every sign-out is client-side) kept
  // sending the signed-out user's bearer for the 55s TTL, then up to 10
  // minutes more through the stale fallback, every batch a 207.
  useEffect(() => bindTokenCacheToSignOut(tokenCacheRef), []);

  const [resolveAuthToken] = useState<AuthTokenResolver>(() =>
    createAuthTokenResolver({
      session: sessionTracker.session,
      tokenCache: tokenCacheRef,
      waitForSettle: sessionTracker.waitForSettle,
      markSettleTimedOut: sessionTracker.markSettleTimedOut,
      // A token out the door means per-user data can land in the cache, even
      // when the session reading never settled signed-in (cold-start mint
      // from the cookie). Arms the sign-out reset.
      onTokenIssued: () => {
        hadAuthenticatedReadingRef.current = true;
      },
    }),
  );

  const [queryClient] = useState(makeQueryClient);
  const [client] = useState(() => createTrpcClient(resolveAuthToken));

  // A deliberate sign-out drops every cached query's data, so the next person
  // to sign in on this browser never sees the last one's tickets while their
  // own refetch is in flight. The order of this effect and the token-cache one
  // does not matter: both listeners run synchronously inside
  // `notifySignedOut`, and the batch link awaits `headers()` on a later tick,
  // so the reset's refetches never see the old token either way.
  useEffect(
    () => bindQueryCacheToSignOut(queryClient, hadAuthenticatedReadingRef),
    [queryClient],
  );

  return createElement(trpc.Provider, {
    client,
    queryClient,
    children: createElement(
      QueryClientProvider,
      { client: queryClient },
      children,
    ),
  });
};
