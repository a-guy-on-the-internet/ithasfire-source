// @vitest-environment jsdom
/**
 * `useAccessRevocation` against the REAL tRPC React client and the app's REAL
 * React Query defaults, with the network swapped for a link the test answers
 * (`test/harness/fake-trpc-link.ts`).
 *
 * `useSession` below stands in for `useScannerSession`: the same
 * `getSessionContext` query with the same options, the same `accessDenied`
 * derivation, and the event list it keeps alongside. Where a test passes
 * `accessDenied: true` by hand, it is asking what happens when the caller is
 * WRONG: the hook must still refuse to wipe unless the query itself holds a
 * settled FORBIDDEN for this person.
 *
 * No JSX: this file runs in the `unit` project (classic runtime).
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import { getQueryKey } from "@trpc/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** `AppState` listeners, for the test to fire. */
const rn = vi.hoisted(() => ({
  listeners: [] as Array<(state: string) => void>,
}));
vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: (_event: string, listener: (state: string) => void) => {
      rn.listeners.push(listener);
      return {
        remove: () => {
          rn.listeners.splice(rn.listeners.indexOf(listener), 1);
        },
      };
    },
  },
}));
const appBecomes = (state: "active" | "background" | "inactive") => {
  act(() => {
    for (const listener of [...rn.listeners]) listener(state);
  });
};

/** The device's connectivity, for the test to change. */
const net = vi.hoisted(() => ({
  state: "online" as "online" | "degraded" | "offline",
  listeners: new Set<() => void>(),
}));
vi.mock("../features/network/use-network-state", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useNetworkState: () =>
      useSyncExternalStore(
        (onChange: () => void) => {
          net.listeners.add(onChange);
          return () => net.listeners.delete(onChange);
        },
        () => net.state,
      ),
  };
});
const networkBecomes = (state: typeof net.state) => {
  act(() => {
    net.state = state;
    for (const listener of [...net.listeners]) listener();
  });
};

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@sentry/react-native", () => ({
  captureException: sentry.captureException,
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock("../config/api", () => ({
  getTrpcHttpUrl: () => "http://scanner.test/trpc",
  getApiBaseUrl: () => "http://scanner.test",
}));
const localDb = vi.hoisted(() => ({ clearAttendeeData: vi.fn() }));
vi.mock("./local-db", () => ({ clearAttendeeData: localDb.clearAttendeeData }));

import {
  deferred,
  lostAnswer,
  refusal,
  trpcWrapper,
  type Handler,
  type Handlers,
} from "../../test/harness/fake-trpc-link";
import { createQueryClient } from "../query-client";
import { trpc } from "../trpc";
import { useAccessRevocation } from "./use-access-revocation";

(globalThis as { __DEV__?: boolean }).__DEV__ = false;

const OPERATOR = "human-1";
const NEXT_OPERATOR = "human-2";
const CONTEXT = {
  operator: { humanId: OPERATOR, displayName: "Op", email: "op@example.com" },
  orgs: [{ orgId: "org-1", orgName: "Org", role: "SCANNER" }],
};
const noRole = () => refusal("FORBIDDEN", "INSUFFICIENT_ROLE");
const wipe = localDb.clearAttendeeData;

/** Attendee PII as a screen leaves it in the query cache. */
const SEARCH_KEY = [
  ["volunteer", "signups", "searchForCheckIn"],
  { input: { eventId: "evt-a", query: "jo" }, type: "query" },
] as const;

let queryClient: QueryClient;
let handlers: Handlers;
let getSessionContext: ReturnType<typeof vi.fn<Handler>>;
let listAccessibleEvents: ReturnType<typeof vi.fn<Handler>>;
/** Every status the session context query has shown the app, in order. */
let seenStatuses: string[];

const wrapper = trpcWrapper(
  () => queryClient,
  () => handlers,
);

/** `useScannerSession`'s part in this: the two queries, and `accessDenied`. */
/** The direct ask's time limit in these tests (20 seconds in the app). */
const ASK_TIMEOUT_MS = 150;

function useSession(props: { userId: string | undefined; accessDenied?: boolean }) {
  const query = trpc.scanner.getSessionContext.useQuery(
    {},
    { enabled: !!props.userId, retry: false, staleTime: 60_000 },
  );
  const accessDenied =
    props.accessDenied ??
    !!(props.userId && query.error && query.error.data?.code === "FORBIDDEN");
  trpc.scanner.listAccessibleEvents.useQuery(
    {},
    {
      enabled: !!props.userId && !accessDenied,
      retry: false,
      staleTime: 60_000,
    },
  );
  const { deniedReason, checkAgain } = useAccessRevocation({
    userId: props.userId,
    accessDenied,
    askTimeoutMs: ASK_TIMEOUT_MS,
  });
  seenStatuses.push(query.status);
  return { status: query.status, accessDenied, deniedReason, checkAgain };
}

const renderSession = (
  initialProps: { userId: string | undefined; accessDenied?: boolean } = {
    userId: OPERATOR,
  },
) => renderHook(useSession, { initialProps, wrapper });

/** Long enough for the wipe's macrotask and anything queued behind it. */
const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 20)));

beforeEach(() => {
  wipe.mockReset();
  sentry.captureException.mockReset();
  rn.listeners.length = 0;
  net.state = "online";
  net.listeners.clear();
  seenStatuses = [];
  queryClient = createQueryClient();
  getSessionContext = vi.fn<Handler>(async () => CONTEXT);
  listAccessibleEvents = vi.fn<Handler>(async () => ({ events: [] }));
  handlers = {
    "scanner.getSessionContext": getSessionContext,
    "scanner.listAccessibleEvents": listAccessibleEvents,
  };
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe("the wipe", () => {
  it("runs once when the server says there is no scan role", async () => {
    getSessionContext.mockRejectedValue(noRole());
    queryClient.setQueryData(SEARCH_KEY, [{ name: "Jo", email: "jo@example.com" }]);
    const h = renderSession();

    await waitFor(() => expect(wipe).toHaveBeenCalledTimes(1));
    expect(h.result.current.accessDenied).toBe(true);
    expect(h.result.current.deniedReason).toBe("no_scan_role");
    await waitFor(() =>
      expect(queryClient.getQueryData(SEARCH_KEY)).toBeUndefined(),
    );

    // The same denied state again: a re-render, and unrelated cache traffic.
    h.rerender({ userId: OPERATOR });
    act(() => {
      queryClient.setQueryData(["unrelated"], 1);
    });
    await settle();
    expect(wipe).toHaveBeenCalledTimes(1);
    // The refusal is still what the app shows, and nothing asked again.
    expect(h.result.current.accessDenied).toBe(true);
    expect(getSessionContext).toHaveBeenCalledTimes(1);
  });

  it("runs for platform staff refused for a missing second factor, and says why", async () => {
    getSessionContext.mockRejectedValue(
      refusal("FORBIDDEN", "SECOND_FACTOR_REQUIRED"),
    );
    const h = renderSession();

    await waitFor(() => expect(wipe).toHaveBeenCalledTimes(1));
    expect(h.result.current.deniedReason).toBe("second_factor_required");
  });

  it("catches and reports a throwing wipe", async () => {
    getSessionContext.mockRejectedValue(noRole());
    const failure = new Error("disk I/O error");
    wipe.mockImplementation(() => {
      throw failure;
    });
    const h = renderSession();

    await waitFor(() =>
      expect(sentry.captureException).toHaveBeenCalledWith(failure, {
        tags: {
          feature: "pii_retention",
          branch: "access_denied_wipe_clear_local_db",
        },
        extra: undefined,
      }),
    );
    await settle();
    expect(h.result.current.accessDenied).toBe(true);
    expect(wipe).toHaveBeenCalledTimes(1);
  });

  it("runs again for the next denied state", async () => {
    getSessionContext.mockRejectedValue(noRole());
    const h = renderSession();
    await waitFor(() => expect(wipe).toHaveBeenCalledTimes(1));

    // Signed out, then the same person signs back in and is refused again.
    h.rerender({ userId: undefined });
    await settle();
    h.rerender({ userId: OPERATOR });
    await waitFor(() => expect(wipe).toHaveBeenCalledTimes(2));
  });

  it("does not run for the next person, who has access", async () => {
    getSessionContext.mockRejectedValue(noRole());
    const h = renderSession();
    await waitFor(() => expect(wipe).toHaveBeenCalledTimes(1));

    // The refused operator signs out; the cache keeps their refusal (sign-out
    // does not clear the query cache). The next operator on this phone is
    // granted.
    h.rerender({ userId: undefined });
    getSessionContext.mockResolvedValue(CONTEXT);
    h.rerender({ userId: NEXT_OPERATOR });

    await waitFor(() => expect(h.result.current.status).toBe("success"));
    await settle();
    expect(h.result.current.accessDenied).toBe(false);
    expect(h.result.current.deniedReason).toBeNull();
    expect(wipe).toHaveBeenCalledTimes(1);
  });

  it("the previous person's refusal never wipes the next one, whatever the caller says", async () => {
    getSessionContext.mockRejectedValue(noRole());
    const h = renderSession();
    await waitFor(() => expect(wipe).toHaveBeenCalledTimes(1));

    h.rerender({ userId: undefined });
    // The next person's own answer never comes; only the old refusal exists.
    getSessionContext.mockImplementation(() => new Promise(() => {}));
    h.rerender({ userId: NEXT_OPERATOR, accessDenied: true });

    await settle();
    expect(wipe).toHaveBeenCalledTimes(1);
    expect(h.result.current.deniedReason).toBeNull();
  });

  describe("never runs without a settled FORBIDDEN, whatever the caller says", () => {
    const cases: Array<[string, () => Promise<unknown>]> = [
      ["a network failure", () => Promise.reject(lostAnswer())],
      ["a 5xx", () => Promise.reject(refusal("INTERNAL_SERVER_ERROR", "INTERNAL"))],
      ["a query still loading", () => new Promise(() => {})],
      ["a granted session", async () => CONTEXT],
    ];
    for (const [name, answer] of cases) {
      it(name, async () => {
        getSessionContext.mockImplementation(answer);
        const h = renderSession({ userId: OPERATOR, accessDenied: true });

        await waitFor(() => expect(getSessionContext).toHaveBeenCalledTimes(1));
        await settle();
        expect(wipe).not.toHaveBeenCalled();
        // And the real derivation agrees that this is not a denial.
        h.rerender({ userId: OPERATOR });
        expect(h.result.current.accessDenied).toBe(false);
      });
    }
  });

  it("does not run while the caller says access is granted", async () => {
    getSessionContext.mockRejectedValue(noRole());
    renderSession({ userId: OPERATOR, accessDenied: false });

    await waitFor(() => expect(getSessionContext).toHaveBeenCalledTimes(1));
    await settle();
    expect(wipe).not.toHaveBeenCalled();
  });

  it("does not run with nobody signed in", async () => {
    renderSession({ userId: undefined, accessDenied: true });
    await settle();
    expect(getSessionContext).not.toHaveBeenCalled();
    expect(wipe).not.toHaveBeenCalled();
  });
});

describe("a refusal about one saved event", () => {
  // The app asks `getSessionContext` with no `eventId` (`useScannerSession`).
  // Asked WITH one, the server also checks the role in that event's org and
  // refuses someone who scans for a different org. No caller does that today;
  // `useSessionWithSavedEvent` is the caller that might be added, and these
  // pin that its refusal can never wipe or lock out an operator who still has
  // a role.
  const STALE_EVENT = "evt-stale";
  const SESSION_QUERY_KEY = getQueryKey(trpc.scanner.getSessionContext);
  const refusedFor = () =>
    queryClient
      .getQueryCache()
      .findAll({ queryKey: SESSION_QUERY_KEY })
      .filter((q) => q.state.status === "error")
      .map((q) => (q.queryKey[1] as { input?: unknown }).input);
  const askedWith = () => getSessionContext.mock.calls.map(([input]) => input);

  function useSessionWithSavedEvent(props: {
    userId: string | undefined;
    accessDenied?: boolean;
  }) {
    const forEvent = trpc.scanner.getSessionContext.useQuery(
      { eventId: STALE_EVENT },
      { enabled: !!props.userId, retry: false, staleTime: 60_000 },
    );
    return { ...useSession(props), eventStatus: forEvent.status };
  }
  const renderWithSavedEvent = (accessDenied?: boolean) =>
    renderHook(useSessionWithSavedEvent, {
      initialProps: { userId: OPERATOR, accessDenied },
      wrapper,
    });
  /** The server: a role somewhere, none in the saved event's org. */
  const refuseTheEventOnly = (appCode: string) =>
    getSessionContext.mockImplementation((input) =>
      input.eventId
        ? Promise.reject(refusal("FORBIDDEN", appCode))
        : Promise.resolve(CONTEXT),
    );

  it("a scan role elsewhere: no wipe and no access-denied screen", async () => {
    refuseTheEventOnly("INSUFFICIENT_ROLE");
    const h = renderWithSavedEvent();

    await waitFor(() => expect(h.result.current.eventStatus).toBe("error"));
    await waitFor(() => expect(h.result.current.status).toBe("success"));
    await settle();

    expect(refusedFor()).toEqual([{ eventId: STALE_EVENT }]);
    expect(wipe).not.toHaveBeenCalled();
    expect(h.result.current.accessDenied).toBe(false);
    expect(h.result.current.deniedReason).toBeNull();
  });

  it("platform staff with no second factor who also scan for their own org: no wipe", async () => {
    refuseTheEventOnly("SECOND_FACTOR_REQUIRED");
    const h = renderWithSavedEvent();

    await waitFor(() => expect(h.result.current.eventStatus).toBe("error"));
    await waitFor(() => expect(h.result.current.status).toBe("success"));
    await settle();

    expect(wipe).not.toHaveBeenCalled();
    expect(h.result.current.deniedReason).toBeNull();
  });

  it("a caller that reads the event's refusal as access denied still cannot wipe", async () => {
    refuseTheEventOnly("INSUFFICIENT_ROLE");
    // `accessDenied` forced on, as a caller deriving it from the wrong query would.
    const h = renderWithSavedEvent(true);

    await waitFor(() => expect(h.result.current.eventStatus).toBe("error"));
    await waitFor(() => expect(h.result.current.status).toBe("success"));
    await settle();

    expect(wipe).not.toHaveBeenCalled();
    expect(h.result.current.deniedReason).toBeNull();
  });

  it("no scan role anywhere: the question with no event is asked once, and its refusal wipes", async () => {
    getSessionContext.mockRejectedValue(noRole());
    const h = renderWithSavedEvent();

    await waitFor(() => expect(wipe).toHaveBeenCalledTimes(1));
    expect(h.result.current.accessDenied).toBe(true);
    expect(h.result.current.deniedReason).toBe("no_scan_role");
    await settle();
    expect(wipe).toHaveBeenCalledTimes(1);
    expect(askedWith().filter((input) => !input.eventId)).toEqual([{}]);
  });

  it("no event in the question and a refusal: the wipe runs at once, with nothing asked again", async () => {
    getSessionContext.mockRejectedValue(noRole());
    const h = renderSession();

    await waitFor(() => expect(wipe).toHaveBeenCalledTimes(1));
    expect(h.result.current.accessDenied).toBe(true);
    expect(askedWith()).toEqual([{}]);
  });

  it("the foreground re-check asks only the question with no event", async () => {
    refuseTheEventOnly("INSUFFICIENT_ROLE");
    const h = renderWithSavedEvent();
    await waitFor(() => expect(h.result.current.eventStatus).toBe("error"));
    await waitFor(() => expect(h.result.current.status).toBe("success"));
    const before = askedWith().length;

    appBecomes("active");

    await waitFor(() => expect(askedWith().length).toBe(before + 1));
    await settle();
    expect(askedWith().slice(before)).toEqual([{}]);
    expect(wipe).not.toHaveBeenCalled();
  });
});

describe("the re-check when the app returns to the foreground", () => {
  it("asks for the session context again on AppState active", async () => {
    const h = renderSession();
    await waitFor(() => expect(h.result.current.status).toBe("success"));
    expect(getSessionContext).toHaveBeenCalledTimes(1);

    appBecomes("background");
    appBecomes("inactive");
    expect(getSessionContext).toHaveBeenCalledTimes(1);

    appBecomes("active");
    await waitFor(() => expect(getSessionContext).toHaveBeenCalledTimes(2));
    await settle();
    expect(wipe).not.toHaveBeenCalled();
  });

  it("a role removed in the background is noticed, and the cache is wiped", async () => {
    const h = renderSession();
    await waitFor(() => expect(h.result.current.status).toBe("success"));
    queryClient.setQueryData(SEARCH_KEY, [{ name: "Jo", email: "jo@example.com" }]);

    const recheck = deferred<unknown>();
    getSessionContext.mockImplementation(() => recheck.promise);
    appBecomes("active");
    await waitFor(() => expect(getSessionContext).toHaveBeenCalledTimes(2));
    // Still asking: nothing is wiped on a question.
    await settle();
    expect(wipe).not.toHaveBeenCalled();

    await act(async () => {
      recheck.reject(noRole());
    });
    await waitFor(() => expect(wipe).toHaveBeenCalledTimes(1));
    expect(h.result.current.accessDenied).toBe(true);
    await waitFor(() =>
      expect(queryClient.getQueryData(SEARCH_KEY)).toBeUndefined(),
    );
  });

  it("a re-check that fails for another reason changes nothing", async () => {
    const h = renderSession();
    await waitFor(() => expect(h.result.current.status).toBe("success"));

    getSessionContext.mockRejectedValue(lostAnswer());
    appBecomes("active");
    await waitFor(() => expect(getSessionContext).toHaveBeenCalledTimes(2));
    await settle();

    expect(h.result.current.accessDenied).toBe(false);
    expect(wipe).not.toHaveBeenCalled();
  });

  it("a re-check that throws outside the request is reported, and changes nothing", async () => {
    const h = renderSession();
    await waitFor(() => expect(h.result.current.status).toBe("success"));
    const broken = new Error("refetch broke");
    const refetch = vi
      .spyOn(queryClient, "refetchQueries")
      .mockRejectedValueOnce(broken);

    appBecomes("active");
    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1));
    await settle();

    const reports = sentry.captureException.mock.calls.filter(
      ([, context]) =>
        (context as { tags?: { branch?: string } } | undefined)?.tags?.branch ===
        "access_recheck_refetch_failed",
    );
    expect(reports).toEqual([[broken, expect.anything()]]);
    expect(h.result.current.accessDenied).toBe(false);
    expect(wipe).not.toHaveBeenCalled();
  });

  it("does not ask while access is denied", async () => {
    getSessionContext.mockRejectedValue(noRole());
    renderSession();
    await waitFor(() => expect(wipe).toHaveBeenCalledTimes(1));

    appBecomes("active");
    networkBecomes("offline");
    networkBecomes("online");
    await settle();
    expect(getSessionContext).toHaveBeenCalledTimes(1);
  });

  it("stops listening on unmount and when signed out", async () => {
    const h = renderSession();
    await waitFor(() => expect(h.result.current.status).toBe("success"));
    expect(rn.listeners).toHaveLength(1);

    h.rerender({ userId: undefined });
    expect(rn.listeners).toHaveLength(0);

    h.rerender({ userId: OPERATOR });
    expect(rn.listeners).toHaveLength(1);
    h.unmount();
    expect(rn.listeners).toHaveLength(0);
  });
});

describe("the re-check when the device comes back online", () => {
  it("asks again after an offline spell, and not on a first 'online'", async () => {
    const h = renderSession();
    await waitFor(() => expect(h.result.current.status).toBe("success"));

    networkBecomes("degraded");
    networkBecomes("online");
    await settle();
    expect(getSessionContext).toHaveBeenCalledTimes(1);

    networkBecomes("offline");
    await settle();
    expect(getSessionContext).toHaveBeenCalledTimes(1);
    networkBecomes("online");
    await waitFor(() => expect(getSessionContext).toHaveBeenCalledTimes(2));
  });
});

describe("the re-check when the event list is refused", () => {
  it("asks for the session context, and a refusal there wipes", async () => {
    const h = renderSession();
    await waitFor(() => expect(h.result.current.status).toBe("success"));
    await waitFor(() => expect(listAccessibleEvents).toHaveBeenCalledTimes(1));

    // The role goes while the app stays in the foreground. The next event
    // list refresh (every 10 minutes in the app) is refused.
    listAccessibleEvents.mockRejectedValue(noRole());
    getSessionContext.mockRejectedValue(noRole());
    await act(() =>
      queryClient.invalidateQueries({
        queryKey: getQueryKey(trpc.scanner.listAccessibleEvents),
      }),
    );

    await waitFor(() => expect(getSessionContext).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(wipe).toHaveBeenCalledTimes(1));
    expect(h.result.current.accessDenied).toBe(true);
  });

  it("a refused list with a session the server still grants wipes nothing", async () => {
    const h = renderSession();
    await waitFor(() => expect(h.result.current.status).toBe("success"));
    await waitFor(() => expect(listAccessibleEvents).toHaveBeenCalledTimes(1));

    listAccessibleEvents.mockRejectedValue(noRole());
    await act(() =>
      queryClient.invalidateQueries({
        queryKey: getQueryKey(trpc.scanner.listAccessibleEvents),
      }),
    );

    await waitFor(() => expect(getSessionContext).toHaveBeenCalledTimes(2));
    await settle();
    expect(h.result.current.accessDenied).toBe(false);
    expect(wipe).not.toHaveBeenCalled();
  });
});

describe("an app that launched offline holds no answer at all", () => {
  /** Launch with the first request lost; returns once that has settled. */
  const launchOffline = async () => {
    getSessionContext.mockRejectedValue(lostAnswer());
    const h = renderSession();
    await waitFor(() => expect(h.result.current.status).toBe("error"));
    return { h, shownAtLaunch: seenStatuses.length };
  };

  it("asks on the next foreground without ever showing the query as pending", async () => {
    const { h, shownAtLaunch } = await launchOffline();

    getSessionContext.mockResolvedValue(CONTEXT);
    appBecomes("active");

    await waitFor(() => expect(h.result.current.status).toBe("success"));
    expect(getSessionContext).toHaveBeenCalledTimes(2);
    // `pending` is what `useScannerSession` shows as the splash, and the
    // splash unmounts whatever screen is open.
    expect(seenStatuses.slice(shownAtLaunch)).not.toContain("pending");
    expect(wipe).not.toHaveBeenCalled();
  });

  it("asks when the device comes back online", async () => {
    const { h } = await launchOffline();

    networkBecomes("offline");
    getSessionContext.mockResolvedValue(CONTEXT);
    networkBecomes("online");

    await waitFor(() => expect(h.result.current.status).toBe("success"));
    expect(getSessionContext).toHaveBeenCalledTimes(2);
  });

  it("still offline: nothing changes on screen", async () => {
    const { h, shownAtLaunch } = await launchOffline();

    appBecomes("active");
    await waitFor(() => expect(getSessionContext).toHaveBeenCalledTimes(2));
    await settle();

    expect(h.result.current.status).toBe("error");
    expect(seenStatuses.slice(shownAtLaunch)).not.toContain("pending");
    expect(wipe).not.toHaveBeenCalled();
  });

  it("a refusal leads to the denied state and the wipe", async () => {
    const { h } = await launchOffline();

    getSessionContext.mockRejectedValue(noRole());
    appBecomes("active");

    await waitFor(() => expect(wipe).toHaveBeenCalledTimes(1));
    expect(h.result.current.accessDenied).toBe(true);
    expect(h.result.current.deniedReason).toBe("no_scan_role");
  });

  it("an ask that never gets an answer is given up, and the next foreground asks again", async () => {
    const { h } = await launchOffline();
    const signals: Array<AbortSignal | undefined> = [];
    getSessionContext.mockImplementation((_input, request) => {
      signals.push(request.signal);
      return new Promise(() => {});
    });

    appBecomes("active");
    await waitFor(() => expect(getSessionContext).toHaveBeenCalledTimes(2));
    // Still waiting: another foreground does not pile a second ask on it.
    appBecomes("active");
    await settle();
    expect(getSessionContext).toHaveBeenCalledTimes(2);

    // Given up, and its request aborted.
    await waitFor(() => expect(signals[0]?.aborted).toBe(true));
    expect(h.result.current.status).toBe("error");

    getSessionContext.mockResolvedValue(CONTEXT);
    appBecomes("active");
    await waitFor(() => expect(h.result.current.status).toBe("success"));
    expect(getSessionContext).toHaveBeenCalledTimes(3);
    expect(wipe).not.toHaveBeenCalled();
  });

  it("an answer for someone who has since signed out is dropped", async () => {
    const { h } = await launchOffline();

    const late = deferred<unknown>();
    getSessionContext.mockImplementation(() => late.promise);
    appBecomes("active");
    await waitFor(() => expect(getSessionContext).toHaveBeenCalledTimes(2));

    h.rerender({ userId: undefined });
    await act(async () => {
      late.resolve(CONTEXT);
    });
    await settle();

    expect(
      queryClient.getQueryData(getQueryKey(trpc.scanner.getSessionContext, {}, "query")),
    ).toBeUndefined();
  });
});

describe("the denied screen's Check again", () => {
  const deny = async () => {
    getSessionContext.mockRejectedValue(noRole());
    const h = renderSession();
    await waitFor(() => expect(wipe).toHaveBeenCalledTimes(1));
    expect(h.result.current.accessDenied).toBe(true);
    return { h, shownWhenDenied: seenStatuses.length };
  };

  it("a role given back: the person is let in, without the splash", async () => {
    const { h, shownWhenDenied } = await deny();
    getSessionContext.mockResolvedValue(CONTEXT);

    let result: string | undefined;
    await act(async () => {
      result = await h.result.current.checkAgain();
    });

    expect(result).toBe("granted");
    // The cache tells the query's observers on the next tick.
    await waitFor(() => expect(h.result.current.accessDenied).toBe(false));
    expect(h.result.current.status).toBe("success");
    expect(h.result.current.deniedReason).toBeNull();
    expect(seenStatuses.slice(shownWhenDenied)).not.toContain("pending");
    expect(wipe).toHaveBeenCalledTimes(1);
  });

  it("still refused: the screen stays as it is, and nothing is wiped again", async () => {
    const { h, shownWhenDenied } = await deny();

    let result: string | undefined;
    await act(async () => {
      result = await h.result.current.checkAgain();
    });
    await settle();

    expect(result).toBe("refused");
    expect(h.result.current.accessDenied).toBe(true);
    expect(seenStatuses.slice(shownWhenDenied)).not.toContain("pending");
    expect(wipe).toHaveBeenCalledTimes(1);
  });

  it("no answer: says the server could not be reached, within the time limit", async () => {
    const { h } = await deny();
    getSessionContext.mockImplementation(() => new Promise(() => {}));

    let result: string | undefined;
    await act(async () => {
      result = await h.result.current.checkAgain();
    });

    expect(result).toBe("unreachable");
    expect(h.result.current.accessDenied).toBe(true);
  });

  it("a server fault: says unreachable, and is reported", async () => {
    const { h } = await deny();
    sentry.captureException.mockReset();
    const fault = refusal("INTERNAL_SERVER_ERROR", "INTERNAL");
    getSessionContext.mockRejectedValue(fault);

    let result: string | undefined;
    await act(async () => {
      result = await h.result.current.checkAgain();
    });

    expect(result).toBe("unreachable");
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tags: { feature: "pii_retention", branch: "access_recheck_failed" },
        extra: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
      }),
    );
  });

  it("no connection, no answer in time, or an expired session: not reported", async () => {
    const { h } = await deny();
    sentry.captureException.mockReset();

    getSessionContext.mockRejectedValue(refusal("UNAUTHORIZED", "UNAUTHORIZED"));
    await act(async () => {
      await h.result.current.checkAgain();
    });

    getSessionContext.mockRejectedValue(lostAnswer());
    await act(async () => {
      await h.result.current.checkAgain();
    });
    getSessionContext.mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      await h.result.current.checkAgain();
    });

    expect(sentry.captureException).not.toHaveBeenCalled();
  });
});

describe("whose refusal: counted, not timed", () => {
  it("a phone clock put back after sign-in still wipes on the refusal", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.UTC(2026, 9, 14, 20, 0, 0));
      const answer = deferred<unknown>();
      getSessionContext.mockImplementation(() => answer.promise);
      const h = renderSession();
      await waitFor(() => expect(getSessionContext).toHaveBeenCalledTimes(1));

      // The clock goes back an hour; then the refusal arrives.
      vi.setSystemTime(Date.UTC(2026, 9, 14, 19, 0, 0));
      await act(async () => {
        answer.reject(noRole());
      });

      await waitFor(() => expect(wipe).toHaveBeenCalledTimes(1));
      expect(h.result.current.deniedReason).toBe("no_scan_role");
    } finally {
      vi.useRealTimers();
    }
  });
});
