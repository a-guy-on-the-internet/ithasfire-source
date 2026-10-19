/**
 * The scanner's sign-out sequence, kept out of `useScannerSession` so it can
 * be tested in node against a real `QueryClient`.
 *
 * The scanner is an operator device that gets handed from one person to the
 * next. Signing out has to leave nothing of the departing operator behind:
 * not in SQLite (people PII, tickets, the scan queue) and not in the React
 * Query cache, which holds their org's events, `searchForCheckIn` results with
 * attendee names and emails, ticket lookups, and so on. The cache lives as
 * long as `TrpcProvider` does, so without a purge the next operator's screens
 * render the previous operator's data under the same query keys until their
 * own refetch lands. And it must never touch the NEXT operator's state.
 *
 * Every sign-out path runs through here: the buttons (home, settings, access
 * denied) and the remote wipe (a 401 on any tRPC call, see
 * `createAuthInvalidatedHandler` below).
 *
 * ## Order, and why
 *
 * All local work happens first; the server call comes last.
 *
 *  1. Capture the session token, for the server call in step 9.
 *  2. Cancel in-flight queries, so a manifest fetch on the wire cannot write
 *     the departing operator's people back into SQLite later.
 *  3. Wipe SQLite, release audio.
 *  4. Clear the token. Any fetch from here on goes out with no bearer and
 *     gets a 401 instead of the departing operator's data.
 *  5. Mark the session signed out, so those 401s are absorbed rather than
 *     starting a second sign-out with an "expired" toast.
 *  6. Purge the query cache (see {@link purgeQueryCache}).
 *  7. Reset preferences.
 *  8. Wipe SQLite AGAIN, after one macrotask. Cancelling a query that already
 *     had data RESOLVES its fetch promise with that data (query-core
 *     `query.js`, cancel-with-revert), so `use-local-sync`'s manifest
 *     `.then` can still upsert the departing operator's people after step 3.
 *     By now every cancelled fetch has settled and its callbacks have run.
 *  9. Server sign-out, with the token captured in step 1, capped at
 *     {@link SERVER_SIGN_OUT_TIMEOUT_MS}.
 *
 * Step 9 is last because the Expo plugin nulls the session atom before the
 * `/sign-out` request goes out (`@better-auth/expo` client `init` hook), so
 * the sign-in screen appears the moment it starts. If the next operator signs
 * in while it is still waiting (no signal at the door), no step after it may
 * touch the token, the 401 guard, the cache or the preferences, or it would
 * clobber theirs. It sends the CAPTURED bearer, and `better-auth-client.ts`
 * lets an explicit Authorization header win over the current local token.
 *
 * A failed or hung server call is reported (at warning level: an offline door
 * is the expected case) and swallowed, never rethrown. A 401 is not reported:
 * the session is already gone server-side, as it always is on a remote wipe. Every caller fires
 * `signOut` and forgets it (`void onSignOut()`, the auth bus), so a rethrow
 * could only become an unhandled rejection and a duplicate Sentry event, and
 * the device is signed out locally either way.
 *
 * Every step is guarded: one failing step never stops the ones after it, and
 * a swallowed failure here can mean data left on the device, so it is
 * reported, not just logged.
 */
import type { QueryClient } from "@tanstack/react-query";

export type SignOutTeardownStep =
  | "capture_session_token"
  | "cancel_queries"
  | "clear_local_db"
  | "release_audio"
  | "clear_auth_token"
  | "mark_signed_out"
  | "purge_query_cache"
  | "reset_preferences"
  | "clear_local_db_final"
  | "server_sign_out";

export type SignOutReportLevel = "error" | "warning";

/**
 * How long sign-out waits for the server. Past this the request carries on in
 * the background (it already holds its bearer) and sign-out returns.
 */
export const SERVER_SIGN_OUT_TIMEOUT_MS = 5_000;

export type SignOutTeardownDeps = {
  queryClient: QueryClient;
  clearLocalDb: () => void;
  releaseFeedbackAudio: () => void;
  /** The current session token, captured before it is cleared. */
  getSessionToken: () => string | null;
  /**
   * Revoke the session server-side (`authClient.signOut`) using the token
   * captured before the local teardown. Better Auth resolves `{ error }` on an
   * HTTP error and rejects on a network failure; both are handled.
   */
  signOutServer: (capturedSessionToken: string | null) => Promise<unknown>;
  clearAuthToken: () => Promise<void>;
  /** Called once the token is gone; later 401s must not sign out again. */
  markSignedOut: () => void;
  resetPreferences: () => Promise<void>;
  /** Wired to Sentry by the caller. Must not throw; guarded anyway. */
  reportError?: (
    err: unknown,
    step: SignOutTeardownStep,
    level: SignOutReportLevel,
  ) => void;
  /** Defaults to {@link SERVER_SIGN_OUT_TIMEOUT_MS}. */
  serverSignOutTimeoutMs?: number;
};

/**
 * Drop every query and mutation the departing operator left in memory.
 *
 * The cancel is guarded on its own: removal must happen even if it throws.
 *
 * `removeQueries`, not `resetQueries`: reset refetches every active query on
 * the spot. Removal fetches nothing. Observers that stay mounted keep a handle
 * on the removed query only until their next render, when they rebuild from
 * the (now empty) cache.
 *
 * The mutation cache goes too: finished mutations keep their variables (scan
 * inputs, sale details) in memory until garbage collection.
 */
export async function purgeQueryCache(
  queryClient: QueryClient,
  onCancelError: (err: unknown) => void = () => {},
): Promise<void> {
  try {
    await queryClient.cancelQueries();
  } catch (err) {
    onCancelError(err);
  }
  queryClient.removeQueries();
  queryClient.getMutationCache().clear();
}

/**
 * The `error` of a resolved Better Auth result, if it carries one. A 401 is
 * not a failure: the server holds no live session for the captured token,
 * which is the state sign-out wants. That is the remote wipe's normal answer
 * (it runs BECAUSE the session was revoked), so reporting it would send a
 * Sentry event for every remote wipe.
 */
const resolvedServerError = (result: unknown): Error | null => {
  if (!result || typeof result !== "object" || !("error" in result)) {
    return null;
  }
  const error = (result as { error?: unknown }).error;
  if (!error) return null;
  const rawStatus =
    typeof error === "object" && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
  if (rawStatus === 401) return null;
  const status = rawStatus === undefined ? "unknown" : String(rawStatus);
  return new Error(`server sign-out failed (${status})`);
};

/**
 * Wait for the server sign-out, at most `timeoutMs`. Never throws: a
 * rejection, an `{ error }` result and a timeout all come back as an Error.
 */
const settleServerSignOut = async (
  signOutServer: () => Promise<unknown>,
  timeoutMs: number,
): Promise<Error | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<Error>((resolve) => {
    timer = setTimeout(
      () =>
        resolve(new Error(`server sign-out timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  const settled = (async (): Promise<Error | null> => {
    try {
      return resolvedServerError(await signOutServer());
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  })();
  try {
    return await Promise.race([settled, timedOut]);
  } finally {
    clearTimeout(timer);
  }
};

/** One macrotask: lets every settled promise's callbacks run first. */
const drainCallbacks = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

export async function runSignOutTeardown(
  deps: SignOutTeardownDeps,
): Promise<void> {
  const report = (
    err: unknown,
    step: SignOutTeardownStep,
    level: SignOutReportLevel = "error",
  ) => {
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      console.warn(`[scanner] sign-out ${step} failed`, err);
    }
    try {
      deps.reportError?.(err, step, level);
    } catch {
      // A throwing reporter must not stop the teardown.
    }
  };
  const step = async (
    name: SignOutTeardownStep,
    run: () => unknown,
  ): Promise<void> => {
    try {
      await run();
    } catch (err) {
      report(err, name);
    }
  };

  let capturedSessionToken: string | null = null;
  await step("capture_session_token", () => {
    capturedSessionToken = deps.getSessionToken();
  });
  await step("cancel_queries", () => deps.queryClient.cancelQueries());
  await step("clear_local_db", () => deps.clearLocalDb());
  // Nothing should hold decoded audio for a session that has ended.
  await step("release_audio", () => deps.releaseFeedbackAudio());
  await step("clear_auth_token", () => deps.clearAuthToken());
  await step("mark_signed_out", () => deps.markSignedOut());
  await step("purge_query_cache", () =>
    purgeQueryCache(deps.queryClient, (err) => report(err, "cancel_queries")),
  );
  await step("reset_preferences", () => deps.resetPreferences());
  await drainCallbacks();
  await step("clear_local_db_final", () => deps.clearLocalDb());

  // Last, and nothing after it: see "Order, and why" above.
  const serverError = await settleServerSignOut(
    () => deps.signOutServer(capturedSessionToken),
    deps.serverSignOutTimeoutMs ?? SERVER_SIGN_OUT_TIMEOUT_MS,
  );
  if (serverError) report(serverError, "server_sign_out", "warning");
}

/**
 * The remote-wipe path: a 401 from any tRPC call means the server revoked
 * the operator's session, so the device signs out and purges. `signedOut`
 * absorbs the burst of 401s one revocation produces (and the ones the purge
 * itself provokes), so only the first one signs out. It is reset only on a
 * fresh sign-in, by {@link trackSessionUser}.
 */
export function createAuthInvalidatedHandler(deps: {
  signedOut: { current: boolean };
  notifyOperator: () => void;
  signOut: () => Promise<void>;
}): () => Promise<void> | undefined {
  return () => {
    if (deps.signedOut.current) return undefined;
    deps.signedOut.current = true;
    deps.notifyOperator();
    return deps.signOut();
  };
}

/**
 * Re-arm the remote wipe on a FRESH sign-in (no user → a user). Without this
 * the 401 guard set by one sign-out would stay set for every later operator,
 * and a server-side revocation would never wipe their device.
 */
export function trackSessionUser(
  refs: {
    signedOut: { current: boolean };
    lastHumanId: { current: string | undefined };
  },
  humanId: string | undefined,
): void {
  if (humanId && !refs.lastHumanId.current) {
    refs.signedOut.current = false;
  }
  refs.lastHumanId.current = humanId;
}
