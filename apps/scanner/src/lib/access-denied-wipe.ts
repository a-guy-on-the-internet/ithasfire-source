/**
 * What the scanner removes when the server answers that the signed-in person
 * holds no scan role any more, kept free of React and native imports so it
 * runs in node against a real `QueryClient`.
 *
 * The device caches attendee names and emails for every event the operator
 * could scan (`docs/scanner-pii.md`). Once the role is gone that cache has no
 * reason to stay: the access-denied screen offers nothing that reads it.
 *
 * ## What goes, and what stays
 *
 * People, the search index, tickets, events and recent scans go
 * (`clearAttendeeData` in `local-db.ts`). The offline scan queue and its
 * terminal drops STAY: they are admits already made at the door, and
 * `tickets.scanTicket` accepts roles the scanner shell refuses (EDITOR). The
 * queue keeps flushing while someone is signed in, so those admits either
 * land or are refused and recorded, as they always were.
 *
 * ## Only a settled refusal counts
 *
 * The wipe takes the ticket manifest too, so the device cannot check a ticket
 * offline afterwards; it must never run on a guess.
 * {@link isSettledRoleRefusal} accepts one state only: the session context
 * query has finished, its answer is tRPC `FORBIDDEN`, and that answer arrived
 * after this person signed in on this device. A network failure, a 5xx, a
 * query still loading, a refusal that is being asked again and a refusal left
 * in the cache by the previous person all fail it.
 *
 * "After this person signed in" is counted, not timed: the caller notes each
 * query's `errorUpdateCount` at sign-in ({@link refusalBaseline}), and only a
 * refusal that raised the count since then is this person's. A device clock
 * set back between sign-in and the refusal cannot hide it.
 *
 * FORBIDDEN is the tRPC code of `INSUFFICIENT_ROLE` and of
 * `SECOND_FACTOR_REQUIRED` (platform staff with no second factor). Both wipe:
 * either way the server will not show this person the data.
 *
 * ## Only the question with no event in it
 *
 * `scanner.getSessionContext` takes an optional `eventId`. Asked WITH one, the
 * server also checks the operator's role in that event's org and answers
 * FORBIDDEN when it is missing there, whatever they hold elsewhere
 * (`get-scanner-session-context.ts`, the `if (input.eventId)` block). That is
 * "not this event", not "no scan role". The app asks without an `eventId`
 * today (`useScannerSession`), and {@link settledRefusalCode} skips any query
 * that carries one, so a caller added later cannot turn one stale event into
 * a wipe and a locked-out operator.
 *
 * ## Order
 *
 *  1. Cancel every other query, so a manifest fetch on the wire cannot write
 *     people back into SQLite afterwards.
 *  2. Wait one macrotask. Cancelling a query that already had data RESOLVES
 *     its fetch promise with that data (query-core cancel-with-revert), so
 *     `use-local-sync`'s manifest `.then` can still upsert once; by now it has.
 *  3. Wipe the attendee data from SQLite, once.
 *  4. Drop the cached queries and the finished mutations from memory.
 *
 * The session context query stays in the cache: its error is what holds the
 * app on the access-denied screen, and removing it would start a new fetch, a
 * new refusal and a new wipe, in a loop. A mutation still in flight stays too
 * (the bootstrap report `useScannerSession` sends on a refusal).
 *
 * Every step is guarded and reported: a failing step never stops the ones
 * after it, and never reaches the screen.
 */
import type { QueryClient, QueryKey } from "@tanstack/react-query";

export type AccessDeniedWipeStep =
  | "cancel_queries"
  | "clear_local_db"
  | "purge_query_cache";

type RefusableQueryState = {
  status: "pending" | "error" | "success";
  fetchStatus: "fetching" | "paused" | "idle";
  error: unknown;
  errorUpdateCount: number;
};

/**
 * How many errors each cached query (by `queryHash`) had answered at a moment,
 * for {@link settledRefusalCode}: a refusal counts once its query's count is
 * above the one noted here. A query not noted counts from zero.
 */
export type RefusalBaseline = ReadonlyMap<string, number>;

/** Note the error count of every cached query under each of `queryKeys`. */
export const refusalBaseline = (
  queryClient: QueryClient,
  queryKeys: readonly QueryKey[],
): RefusalBaseline => {
  const counts = new Map<string, number>();
  for (const queryKey of queryKeys) {
    for (const query of queryClient.getQueryCache().findAll({ queryKey })) {
      counts.set(query.queryHash, query.state.errorUpdateCount);
    }
  }
  return counts;
};

const errorDataOf = (
  error: unknown,
): { code?: unknown; appCode?: unknown } | null | undefined =>
  error && typeof error === "object"
    ? (error as { data?: { code?: unknown; appCode?: unknown } | null }).data
    : undefined;

/**
 * True when the query's last answer, not one still being asked, is FORBIDDEN,
 * and the query has answered more than `errorsBefore` errors in all.
 */
export const isSettledRoleRefusal = (
  state: RefusableQueryState | undefined,
  errorsBefore = 0,
): boolean =>
  !!state &&
  state.status === "error" &&
  state.fetchStatus === "idle" &&
  state.errorUpdateCount > errorsBefore &&
  errorDataOf(state.error)?.code === "FORBIDDEN";

/**
 * True when a tRPC query key's input names one event
 * (`[path, { input: { eventId }, type }]`). A refusal of such a question is
 * about that event's org, not about the person's scan access as a whole.
 */
export const asksAboutOneEvent = (queryKey: QueryKey): boolean => {
  const input = (queryKey[1] as { input?: unknown } | null | undefined)?.input;
  return (
    !!input &&
    typeof input === "object" &&
    (input as { eventId?: unknown }).eventId != null
  );
};

/**
 * The app code of a settled refusal on the query under `queryKey` that names
 * no event: `INSUFFICIENT_ROLE`, `SECOND_FACTOR_REQUIRED`, or `FORBIDDEN` when
 * the server sent none. Null when there is no settled refusal.
 */
export const settledRefusalCode = (
  queryClient: QueryClient,
  queryKey: QueryKey,
  baseline: RefusalBaseline = new Map(),
): string | null => {
  for (const query of queryClient.getQueryCache().findAll({ queryKey })) {
    if (asksAboutOneEvent(query.queryKey)) continue;
    const errorsBefore = baseline.get(query.queryHash) ?? 0;
    if (!isSettledRoleRefusal(query.state, errorsBefore)) continue;
    const appCode = errorDataOf(query.state.error)?.appCode;
    return typeof appCode === "string" && appCode ? appCode : "FORBIDDEN";
  }
  return null;
};

/** {@link settledRefusalCode}, as a yes or no. */
export const hasSettledRoleRefusal = (
  queryClient: QueryClient,
  queryKey: QueryKey,
  baseline?: RefusalBaseline,
): boolean => settledRefusalCode(queryClient, queryKey, baseline) !== null;

export type AccessDeniedWipeDeps = {
  queryClient: QueryClient;
  /** `getQueryKey(trpc.scanner.getSessionContext)`: the one query that stays. */
  sessionContextQueryKey: QueryKey;
  /** `clearAttendeeData` from `local-db.ts`; the scan queue is not its to take. */
  clearLocalDb: () => void;
  /** Wired to Sentry by the caller. Must not throw; guarded anyway. */
  reportError?: (err: unknown, step: AccessDeniedWipeStep) => void;
};

/** One macrotask: lets every settled promise's callbacks run first. */
const drainCallbacks = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

/** Never throws. */
export async function runAccessDeniedWipe(
  deps: AccessDeniedWipeDeps,
): Promise<void> {
  const { queryClient } = deps;
  const step = async (
    name: AccessDeniedWipeStep,
    run: () => unknown,
  ): Promise<void> => {
    try {
      await run();
    } catch (err) {
      if (typeof __DEV__ !== "undefined" && __DEV__) {
        console.warn(`[scanner] access-denied wipe ${name} failed`, err);
      }
      try {
        deps.reportError?.(err, name);
      } catch {
        // A throwing reporter must not stop the wipe.
      }
    }
  };

  const kept = () =>
    new Set(
      queryClient
        .getQueryCache()
        .findAll({ queryKey: deps.sessionContextQueryKey }),
    );

  await step("cancel_queries", () => {
    const keep = kept();
    return queryClient.cancelQueries({ predicate: (q) => !keep.has(q) });
  });
  await drainCallbacks();
  await step("clear_local_db", () => deps.clearLocalDb());
  await step("purge_query_cache", () => {
    const keep = kept();
    queryClient.removeQueries({ predicate: (q) => !keep.has(q) });
    const mutations = queryClient.getMutationCache();
    for (const mutation of mutations.getAll()) {
      if (mutation.state.status !== "pending") mutations.remove(mutation);
    }
  });
}
