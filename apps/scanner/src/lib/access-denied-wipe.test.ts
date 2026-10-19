import {
  MutationObserver,
  QueryClient,
  QueryObserver,
} from "@tanstack/react-query";
import { TRPCClientError } from "@trpc/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  asksAboutOneEvent,
  hasSettledRoleRefusal,
  isSettledRoleRefusal,
  refusalBaseline,
  runAccessDeniedWipe,
  settledRefusalCode,
} from "./access-denied-wipe";

(globalThis as { __DEV__?: boolean }).__DEV__ = false;

/** `getQueryKey(trpc.scanner.getSessionContext)`, and the key of its query. */
const SESSION_PREFIX = [["scanner", "getSessionContext"]] as const;
const SESSION_KEY = [
  ["scanner", "getSessionContext"],
  { input: {}, type: "query" },
] as const;
/** Attendee PII as the scanner caches it in memory. */
const SEARCH_KEY = [
  ["volunteer", "signups", "searchForCheckIn"],
  { input: { eventId: "evt-a", query: "jo" }, type: "query" },
] as const;
const MANIFEST_KEY = [
  ["scanner", "getEventManifest"],
  { input: { eventId: "evt-a" }, type: "query" },
] as const;

const refusal = (code: string, httpStatus: number, appCode?: string) =>
  TRPCClientError.from({
    error: {
      code: -32000,
      message: appCode ?? code,
      data: { code, httpStatus, ...(appCode ? { appCode } : {}) },
    },
  });
const forbidden = () => refusal("FORBIDDEN", 403);
const serverError = () => refusal("INTERNAL_SERVER_ERROR", 500);
const lostAnswer = () =>
  TRPCClientError.from(new TypeError("Network request failed"));

const newClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } });

const clients: QueryClient[] = [];
const tracked = (queryClient: QueryClient) => {
  clients.push(queryClient);
  return queryClient;
};

/** The session context query after one real fetch with this answer. */
const sessionAnswered = async (
  answer: () => Promise<unknown>,
  queryClient = tracked(newClient()),
) => {
  await queryClient
    .fetchQuery({ queryKey: SESSION_KEY, queryFn: answer })
    .catch(() => {});
  return queryClient;
};

afterEach(() => {
  for (const queryClient of clients.splice(0)) queryClient.clear();
});

describe("a settled role refusal", () => {
  it("is a FORBIDDEN answer", async () => {
    const queryClient = await sessionAnswered(() => Promise.reject(forbidden()));
    expect(hasSettledRoleRefusal(queryClient, SESSION_PREFIX)).toBe(true);
  });

  it("is not a network failure", async () => {
    const queryClient = await sessionAnswered(() => Promise.reject(lostAnswer()));
    expect(queryClient.getQueryState(SESSION_KEY)?.status).toBe("error");
    expect(hasSettledRoleRefusal(queryClient, SESSION_PREFIX)).toBe(false);
  });

  it("is not a 5xx", async () => {
    const queryClient = await sessionAnswered(() => Promise.reject(serverError()));
    expect(queryClient.getQueryState(SESSION_KEY)?.status).toBe("error");
    expect(hasSettledRoleRefusal(queryClient, SESSION_PREFIX)).toBe(false);
  });

  it("is not a query still waiting for its first answer", () => {
    const queryClient = tracked(newClient());
    void queryClient
      .fetchQuery({ queryKey: SESSION_KEY, queryFn: () => new Promise(() => {}) })
      .catch(() => {});
    expect(queryClient.getQueryState(SESSION_KEY)?.status).toBe("pending");
    expect(hasSettledRoleRefusal(queryClient, SESSION_PREFIX)).toBe(false);
  });

  it("is not a success, and not a missing query", async () => {
    const queryClient = await sessionAnswered(async () => ({ operator: {} }));
    expect(hasSettledRoleRefusal(queryClient, SESSION_PREFIX)).toBe(false);
    expect(hasSettledRoleRefusal(tracked(newClient()), SESSION_PREFIX)).toBe(false);
  });

  it("is not a refusal that is being asked again", async () => {
    // A granted session, refused on a re-check: the old data stays, so the
    // next fetch keeps `status: "error"` while it is in flight.
    const queryClient = await sessionAnswered(async () => ({ operator: {} }));
    const observer = new QueryObserver(queryClient, {
      queryKey: SESSION_KEY,
      queryFn: () => Promise.reject(forbidden()),
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});
    await observer.refetch();
    expect(hasSettledRoleRefusal(queryClient, SESSION_PREFIX)).toBe(true);

    observer.setOptions({
      queryKey: SESSION_KEY,
      queryFn: () => new Promise(() => {}),
      staleTime: Infinity,
    });
    void observer.refetch();
    expect(queryClient.getQueryState(SESSION_KEY)).toMatchObject({
      status: "error",
      fetchStatus: "fetching",
    });
    expect(hasSettledRoleRefusal(queryClient, SESSION_PREFIX)).toBe(false);
    unsubscribe();
  });

  it("reads the tRPC code only, and survives odd errors", () => {
    const idle = {
      status: "error",
      fetchStatus: "idle",
      errorUpdateCount: 1,
    } as const;
    expect(isSettledRoleRefusal(undefined)).toBe(false);
    expect(isSettledRoleRefusal({ ...idle, error: null })).toBe(false);
    expect(isSettledRoleRefusal({ ...idle, error: "FORBIDDEN" })).toBe(false);
    expect(isSettledRoleRefusal({ ...idle, error: { data: null } })).toBe(false);
    expect(
      isSettledRoleRefusal({ ...idle, error: { data: { code: "UNAUTHORIZED" } } }),
    ).toBe(false);
    expect(
      isSettledRoleRefusal({ ...idle, error: { data: { code: "FORBIDDEN" } } }),
    ).toBe(true);
  });
});

describe("whose refusal, and why", () => {
  it("a refusal answered before this person signed in does not count", async () => {
    const queryClient = await sessionAnswered(() => Promise.reject(forbidden()));
    // This person signs in now.
    const atSignIn = refusalBaseline(queryClient, [SESSION_PREFIX]);
    expect(hasSettledRoleRefusal(queryClient, SESSION_PREFIX)).toBe(true);
    expect(hasSettledRoleRefusal(queryClient, SESSION_PREFIX, atSignIn)).toBe(false);

    // Their own refusal counts.
    await sessionAnswered(() => Promise.reject(forbidden()), queryClient);
    expect(hasSettledRoleRefusal(queryClient, SESSION_PREFIX, atSignIn)).toBe(true);
  });

  it("is counted, not timed: a clock set back between sign-in and the refusal changes nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.UTC(2026, 9, 14, 20, 0, 0));
      const queryClient = tracked(newClient());
      const atSignIn = refusalBaseline(queryClient, [SESSION_PREFIX]);
      // The phone's clock is put back an hour, then the refusal arrives.
      vi.setSystemTime(Date.UTC(2026, 9, 14, 19, 0, 0));
      await sessionAnswered(() => Promise.reject(forbidden()), queryClient);

      expect(hasSettledRoleRefusal(queryClient, SESSION_PREFIX, atSignIn)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries the server's app code", async () => {
    for (const appCode of ["INSUFFICIENT_ROLE", "SECOND_FACTOR_REQUIRED"]) {
      const queryClient = await sessionAnswered(() =>
        Promise.reject(refusal("FORBIDDEN", 403, appCode)),
      );
      expect(settledRefusalCode(queryClient, SESSION_PREFIX)).toBe(appCode);
    }
  });

  it("falls back to FORBIDDEN without one, and to null without a refusal", async () => {
    const refused = await sessionAnswered(() => Promise.reject(forbidden()));
    expect(settledRefusalCode(refused, SESSION_PREFIX)).toBe("FORBIDDEN");
    const lost = await sessionAnswered(() => Promise.reject(lostAnswer()));
    expect(settledRefusalCode(lost, SESSION_PREFIX)).toBeNull();
  });
});

describe("a refusal about one event is not a refusal of the scanner", () => {
  // `getSessionContext({ eventId })` also checks the role in THAT event's org.
  // The server refuses it for someone who scans for a different org.
  const EVENT_SESSION_KEY = [
    ["scanner", "getSessionContext"],
    { input: { eventId: "evt-stale" }, type: "query" },
  ] as const;
  const refuseTheEvent = (queryClient: QueryClient, appCode: string) =>
    queryClient
      .fetchQuery({
        queryKey: EVENT_SESSION_KEY,
        queryFn: () => Promise.reject(refusal("FORBIDDEN", 403, appCode)),
      })
      .catch(() => {});

  it("tells a question with an event in it from one without", () => {
    expect(asksAboutOneEvent(EVENT_SESSION_KEY)).toBe(true);
    expect(asksAboutOneEvent(SESSION_KEY)).toBe(false);
    expect(asksAboutOneEvent(SESSION_PREFIX)).toBe(false);
    expect(asksAboutOneEvent([["x"], { type: "query" }])).toBe(false);
    expect(asksAboutOneEvent([["x"], { input: { eventId: null } }])).toBe(false);
    expect(asksAboutOneEvent([["x"], { input: "evt" }])).toBe(false);
    expect(asksAboutOneEvent([["x"], null])).toBe(false);
  });

  for (const appCode of [
    "INSUFFICIENT_ROLE",
    "SECOND_FACTOR_REQUIRED",
    "EVENT_NOT_ORG_OWNED",
  ]) {
    it(`${appCode} for the event alone is no refusal`, async () => {
      const queryClient = tracked(newClient());
      await refuseTheEvent(queryClient, appCode);

      expect(queryClient.getQueryState(EVENT_SESSION_KEY)?.status).toBe("error");
      expect(settledRefusalCode(queryClient, SESSION_PREFIX)).toBeNull();
      expect(hasSettledRoleRefusal(queryClient, SESSION_PREFIX)).toBe(false);
    });
  }

  it("is no refusal beside a granted answer to the question with no event", async () => {
    const queryClient = await sessionAnswered(() => Promise.resolve({ orgs: [] }));
    await refuseTheEvent(queryClient, "INSUFFICIENT_ROLE");

    expect(settledRefusalCode(queryClient, SESSION_PREFIX)).toBeNull();
  });

  it("the refusal that counts is the one with no event, whichever was answered first", async () => {
    const eventFirst = tracked(newClient());
    await refuseTheEvent(eventFirst, "SECOND_FACTOR_REQUIRED");
    await sessionAnswered(
      () => Promise.reject(refusal("FORBIDDEN", 403, "INSUFFICIENT_ROLE")),
      eventFirst,
    );
    expect(settledRefusalCode(eventFirst, SESSION_PREFIX)).toBe("INSUFFICIENT_ROLE");

    const eventLast = await sessionAnswered(() =>
      Promise.reject(refusal("FORBIDDEN", 403, "INSUFFICIENT_ROLE")),
    );
    await refuseTheEvent(eventLast, "SECOND_FACTOR_REQUIRED");
    expect(settledRefusalCode(eventLast, SESSION_PREFIX)).toBe("INSUFFICIENT_ROLE");
  });
});

describe("runAccessDeniedWipe", () => {
  const deniedClient = async () => {
    const queryClient = await sessionAnswered(() => Promise.reject(forbidden()));
    queryClient.setQueryData(SEARCH_KEY, [
      { name: "Jo Attendee", email: "jo@example.com" },
    ]);
    return queryClient;
  };

  it("wipes SQLite once and drops the cached attendee data", async () => {
    const queryClient = await deniedClient();
    const clearLocalDb = vi.fn();

    await runAccessDeniedWipe({
      queryClient,
      sessionContextQueryKey: SESSION_PREFIX,
      clearLocalDb,
    });

    expect(clearLocalDb).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(SEARCH_KEY)).toBeUndefined();
    expect(queryClient.getQueryCache().find({ queryKey: SEARCH_KEY })).toBeUndefined();
  });

  it("keeps the session context query, whose refusal holds the denied screen", async () => {
    const queryClient = await deniedClient();

    await runAccessDeniedWipe({
      queryClient,
      sessionContextQueryKey: SESSION_PREFIX,
      clearLocalDb: vi.fn(),
    });

    expect(hasSettledRoleRefusal(queryClient, SESSION_PREFIX)).toBe(true);
    expect(queryClient.getQueryCache().getAll()).toHaveLength(1);
  });

  it("wipes SQLite after a cancelled manifest fetch has written back", async () => {
    // A manifest that already has data, being refetched. Cancelling it
    // RESOLVES the fetch with the old data, so the sync's `.then` upserts the
    // people once more. The wipe has to come after that.
    const queryClient = await deniedClient();
    queryClient.setQueryData(MANIFEST_KEY, { people: [{ displayName: "Jo" }] });
    const order: string[] = [];
    void queryClient
      .fetchQuery({
        queryKey: MANIFEST_KEY,
        queryFn: () => new Promise(() => {}),
        staleTime: 0,
      })
      .then(() => order.push("manifest written back"))
      .catch(() => order.push("manifest fetch rejected"));

    await runAccessDeniedWipe({
      queryClient,
      sessionContextQueryKey: SESSION_PREFIX,
      clearLocalDb: () => {
        order.push("sqlite wiped");
      },
    });

    expect(order).toEqual(["manifest written back", "sqlite wiped"]);
    expect(queryClient.getQueryData(MANIFEST_KEY)).toBeUndefined();
  });

  it("drops finished mutations and leaves one in flight", async () => {
    const queryClient = await deniedClient();
    const finished = new MutationObserver(queryClient, {
      mutationFn: async (input: { ticketCode: string }) => input,
    });
    await finished.mutate({ ticketCode: "TKT-1" });
    const inFlight = new MutationObserver(queryClient, {
      mutationKey: ["scanner", "recordBootstrap"],
      mutationFn: () => new Promise(() => {}),
    });
    void inFlight.mutate();
    expect(queryClient.getMutationCache().getAll()).toHaveLength(2);

    await runAccessDeniedWipe({
      queryClient,
      sessionContextQueryKey: SESSION_PREFIX,
      clearLocalDb: vi.fn(),
    });

    const left = queryClient.getMutationCache().getAll();
    expect(left).toHaveLength(1);
    expect(left[0]?.state.status).toBe("pending");
  });

  it("reports a throwing SQLite wipe and still clears memory", async () => {
    const queryClient = await deniedClient();
    const failure = new Error("disk I/O error");
    const reportError = vi.fn();

    await expect(
      runAccessDeniedWipe({
        queryClient,
        sessionContextQueryKey: SESSION_PREFIX,
        clearLocalDb: () => {
          throw failure;
        },
        reportError,
      }),
    ).resolves.toBeUndefined();

    expect(reportError).toHaveBeenCalledWith(failure, "clear_local_db");
    expect(queryClient.getQueryData(SEARCH_KEY)).toBeUndefined();
  });

  it("a throwing reporter does not stop the wipe", async () => {
    const queryClient = await deniedClient();

    await expect(
      runAccessDeniedWipe({
        queryClient,
        sessionContextQueryKey: SESSION_PREFIX,
        clearLocalDb: () => {
          throw new Error("disk I/O error");
        },
        reportError: () => {
          throw new Error("sentry down");
        },
      }),
    ).resolves.toBeUndefined();

    expect(queryClient.getQueryData(SEARCH_KEY)).toBeUndefined();
  });
});
