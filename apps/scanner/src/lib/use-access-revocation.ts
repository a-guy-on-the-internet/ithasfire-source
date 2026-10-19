import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { AppState } from "react-native";
import {
  notifyManager,
  partialMatchKey,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { getQueryKey } from "@trpc/react-query";

import { useNetworkState } from "../features/network/use-network-state";
import { trpc } from "../trpc";
import {
  asksAboutOneEvent,
  hasSettledRoleRefusal,
  refusalBaseline,
  runAccessDeniedWipe,
  settledRefusalCode,
  type RefusalBaseline,
} from "./access-denied-wipe";
import { clearAttendeeData } from "./local-db";
import { reportRetentionIssue } from "./report";
import { withTimeout } from "./with-timeout";

/** Why the server refused, for the access-denied screen's copy. */
export type AccessDeniedReason = "no_scan_role" | "second_factor_required";

/** What the access-denied screen's "Check again" found. */
export type CheckAgainResult = "granted" | "refused" | "unreachable";

/**
 * How long a direct ask for the session context waits. The app's fetch has no
 * timeout of its own, and a request on a half-open connection never answers:
 * without a bound, one such ask would end the re-check for the rest of the run.
 */
const ASK_TIMEOUT_MS = 20_000;

const trpcCodeOf = (err: unknown): unknown =>
  err && typeof err === "object"
    ? (err as { data?: { code?: unknown } | null }).data?.code
    : undefined;

const httpStatusOf = (err: unknown): number | null => {
  const status =
    err && typeof err === "object"
      ? (err as { data?: { httpStatus?: unknown } | null }).data?.httpStatus
      : undefined;
  return typeof status === "number" ? status : null;
};

/**
 * Notices that the signed-in person has lost their scan access, and removes
 * the attendee data cached for them. Two parts.
 *
 * **Wipe.** When `scanner.getSessionContext`, asked with no `eventId`, has
 * answered FORBIDDEN for this person, the attendee data in SQLite and the
 * cached queries go
 * (`access-denied-wipe.ts`; the offline scan queue stays). It runs once per
 * denied state: the caller's `accessDenied` and this hook's own read of the
 * query must both say so, and a re-render does not repeat it. The second read
 * is why a wrong `accessDenied` (a network failure, a 5xx, a query still
 * loading, the previous person's refusal still in the cache) cannot wipe.
 *
 * **Re-check.** The query client has no window focus on React Native and
 * `getSessionContext` is otherwise fetched once per launch, so a role removed
 * later went unnoticed. It is asked again, once each time, when:
 *
 *   - the app returns to the foreground;
 *   - the device comes back online;
 *   - the event list (refreshed every 10 minutes by `use-local-sync`) is
 *     itself refused, which is how an app that never leaves the foreground
 *     finds out.
 *
 * There is no timer of its own. While access is denied nothing is asked on
 * its own; the denied screen's "Check again" asks (`checkAgain`).
 *
 * How it asks depends on what is held. With an earlier answer in the cache the
 * query is refetched in place. With none (the app launched offline and the
 * first request failed), a refetch would put the query back to pending, which
 * `useScannerSession` shows as the splash, and that unmounts whatever is open,
 * an unfinished sale included. So the server is asked directly: a granted
 * answer is written into the query, and only a refusal triggers the refetch
 * that leads to the denied screen. A direct ask waits at most `askTimeoutMs`
 * (20 seconds), and its request is aborted then.
 */
export function useAccessRevocation(args: {
  userId: string | undefined;
  accessDenied: boolean;
  /** How long a direct ask waits for an answer. Tests shorten it. */
  askTimeoutMs?: number;
}): {
  deniedReason: AccessDeniedReason | null;
  checkAgain: () => Promise<CheckAgainResult>;
} {
  const { userId, accessDenied } = args;
  const queryClient = useQueryClient();
  const utils = trpc.useUtils();
  const sessionContextQueryKey = useMemo(
    () => getQueryKey(trpc.scanner.getSessionContext),
    [],
  );
  const eventListQueryKey = useMemo(
    () => getQueryKey(trpc.scanner.listAccessibleEvents),
    [],
  );

  // Each cached query's error count when this person appeared on this device.
  // A refusal already counted then was answered for somebody else: sign-out
  // does not clear the query cache. Counted, not timed, so a device clock set
  // back cannot hide a refusal (`access-denied-wipe.ts`).
  const noteBaseline = () =>
    refusalBaseline(queryClient, [sessionContextQueryKey, eventListQueryKey]);
  const [signedIn, setSignedIn] = useState(() => ({
    userId,
    baseline: noteBaseline(),
  }));
  if (signedIn.userId !== userId) {
    setSignedIn({ userId, baseline: noteBaseline() });
  }
  const baseline: RefusalBaseline | null =
    signedIn.userId === userId ? signedIn.baseline : null;

  const subscribe = useCallback((onChange: () => void) => {
    // Through the notify manager, as React Query's own hooks do. The cache
    // tells its subscribers synchronously, and that can be in the middle of
    // a render (`useQuery` adding its query to the cache). Telling React about
    // a store change from inside a render is an update during render.
    const notify = notifyManager.batchCalls(onChange);
    return queryClient.getQueryCache().subscribe((event) => {
      const key = event.query.queryKey;
      if (
        partialMatchKey(key, sessionContextQueryKey) ||
        partialMatchKey(key, eventListQueryKey)
      ) {
        notify();
      }
    });
  }, [queryClient, sessionContextQueryKey, eventListQueryKey]);
  const readSessionRefusal = useCallback(
    () =>
      baseline
        ? settledRefusalCode(queryClient, sessionContextQueryKey, baseline)
        : null,
    [queryClient, sessionContextQueryKey, baseline],
  );
  const sessionRefusal = useSyncExternalStore(
    subscribe,
    readSessionRefusal,
    readSessionRefusal,
  );
  const readListRefused = useCallback(
    () =>
      !!baseline && hasSettledRoleRefusal(queryClient, eventListQueryKey, baseline),
    [queryClient, eventListQueryKey, baseline],
  );
  const listRefused = useSyncExternalStore(
    subscribe,
    readListRefused,
    readListRefused,
  );

  // ── Wipe ────────────────────────────────────────────────────────────────
  const denied = !!userId && accessDenied && sessionRefusal !== null;
  const wipedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!denied || !userId) {
      wipedForRef.current = null;
      return;
    }
    if (wipedForRef.current === userId) return;
    wipedForRef.current = userId;
    void runAccessDeniedWipe({
      queryClient,
      sessionContextQueryKey,
      clearLocalDb: clearAttendeeData,
      reportError: (err, step) =>
        reportRetentionIssue(err, { branch: `access_denied_wipe_${step}` }),
    });
  }, [denied, userId, queryClient, sessionContextQueryKey]);

  // ── Re-check ────────────────────────────────────────────────────────────
  const userIdRef = useRef(userId);
  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);
  /** The direct ask in flight, if any: one at a time. */
  const askRef = useRef<Promise<CheckAgainResult | "stale"> | null>(null);
  const askTimeoutMs = args.askTimeoutMs ?? ASK_TIMEOUT_MS;

  /**
   * Ask the server directly, bounded by `askTimeoutMs`, with the request
   * aborted when the time is up. A granted answer is written into the query.
   * An answer for someone who has since signed out is dropped (`"stale"`).
   */
  const ask = useCallback((): Promise<CheckAgainResult | "stale"> => {
    if (askRef.current) return askRef.current;
    const askedFor = userIdRef.current;
    const asking = withTimeout(
      (signal) => utils.client.scanner.getSessionContext.query({}, { signal }),
      askTimeoutMs,
    )
      .then(
        (context): CheckAgainResult | "stale" => {
          if (userIdRef.current !== askedFor) return "stale";
          utils.scanner.getSessionContext.setData({}, context);
          return "granted";
        },
        (err: unknown): CheckAgainResult | "stale" => {
          const code = trpcCodeOf(err);
          const httpStatus = httpStatusOf(err);
          // The server answered, with something other than a refusal (a 5xx,
          // a rejected input): a fault to look at, not a dropped connection.
          // No connection or no answer in time carries no tRPC code and stays
          // quiet: on door wifi that is ordinary. So does UNAUTHORIZED: an
          // expired session, which the sign-in flow handles.
          if (
            code !== "FORBIDDEN" &&
            code !== "UNAUTHORIZED" &&
            (code !== undefined || (httpStatus !== null && httpStatus >= 500))
          ) {
            reportRetentionIssue(err, {
              branch: "access_recheck_failed",
              extra: {
                code: typeof code === "string" ? code : null,
                httpStatus,
              },
            });
          }
          if (userIdRef.current !== askedFor) return "stale";
          return code === "FORBIDDEN" ? "refused" : "unreachable";
        },
      )
      .finally(() => {
        askRef.current = null;
      });
    askRef.current = asking;
    return asking;
  }, [askTimeoutMs, utils]);

  const recheck = useCallback(() => {
    // The question with no event in it: the only one whose answer says
    // whether this person may use the scanner at all (`access-denied-wipe.ts`).
    const asksForAccess = {
      queryKey: sessionContextQueryKey,
      type: "active",
      predicate: (q: { queryKey: QueryKey }) => !asksAboutOneEvent(q.queryKey),
    } as const;
    const refetch = () =>
      void queryClient
        .refetchQueries(asksForAccess)
        // A failed request settles into the query's own state and changes
        // nothing; a throw here is something else, so it is reported.
        .catch((err: unknown) =>
          reportRetentionIssue(err, { branch: "access_recheck_refetch_failed" }),
        );

    const queries = queryClient.getQueryCache().findAll(asksForAccess);
    if (queries.some((q) => q.state.data !== undefined)) {
      refetch();
      return;
    }
    // No answer held. Only a request that has already failed is asked again;
    // one still loading is left to finish.
    const failed = queries.some(
      (q) => q.state.status === "error" && q.state.fetchStatus === "idle",
    );
    if (!failed || askRef.current) return;
    void ask().then((result) => {
      // Refused: now the query may go through pending, the denied screen
      // replaces everything anyway. Any other failure changes nothing.
      if (result === "refused") refetch();
    });
  }, [ask, queryClient, sessionContextQueryKey]);

  /**
   * The access-denied screen's "Check again": a role given back, or a second
   * factor added on the web, lets the person in without signing out. Asked
   * directly, so the screen never goes back through the splash. A refusal
   * leaves the screen as it is.
   */
  const checkAgain = useCallback(
    (): Promise<CheckAgainResult> =>
      ask().then((result) => (result === "stale" ? "unreachable" : result)),
    [ask],
  );

  const authed = !!userId && !accessDenied;

  useEffect(() => {
    if (!authed) return;
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") recheck();
    });
    return () => sub.remove();
  }, [authed, recheck]);

  useEffect(() => {
    if (authed && listRefused) recheck();
  }, [authed, listRefused, recheck]);

  const network = useNetworkState();
  const wasOfflineRef = useRef(false);
  useEffect(() => {
    if (network === "offline") {
      wasOfflineRef.current = true;
      return;
    }
    if (!wasOfflineRef.current) return;
    wasOfflineRef.current = false;
    if (authed) recheck();
  }, [network, authed, recheck]);

  const deniedReason: AccessDeniedReason | null = !denied
    ? null
    : sessionRefusal === "SECOND_FACTOR_REQUIRED"
      ? "second_factor_required"
      : "no_scan_role";
  return { deniedReason, checkAgain };
}
