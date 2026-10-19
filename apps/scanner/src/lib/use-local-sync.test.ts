// @vitest-environment jsdom
/**
 * `useLocalSync`'s people retention, end to end: the REAL tRPC React client
 * (network answered by hand, `test/harness/fake-trpc-link.ts`) writing to the
 * REAL `local-db.ts`, which runs its SQL on Node's SQLite
 * (`test/harness/expo-sqlite-on-node.ts`). A desktop SQLite, not a phone.
 *
 * What is being pinned: the first confirmed event list after sync is switched
 * on is compared with what SQLite holds, so an event the operator lost while
 * the app was closed gives up its attendee rows at once instead of at the 24h
 * sweep. And only a CONFIRMED list counts: pending and errored lists drop
 * nothing.
 *
 * Each test gets its own database and its own copy of the modules under
 * test: `vi.resetModules()` makes `local-db.ts` open a new in-memory database
 * and resets `use-local-sync.ts`'s once-per-run report latch.
 *
 * No JSX: this file runs in the `unit` project (classic runtime).
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { getQueryKey } from "@trpc/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-sqlite", () => import("../../test/harness/expo-sqlite-on-node"));
vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: () => ({ remove: () => {} }),
  },
}));
// Only `useAccessRevocation` reads this (the last describe); the real module
// pulls in NetInfo.
vi.mock("../features/network/use-network-state", () => ({
  useNetworkState: () => "online",
}));
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
// `use-scanner-session.ts` pulls in the auth client and half of Expo. The
// sync hook takes one pure function from it; this is that function, restated.
vi.mock("../features/auth/use-scanner-session", () => ({
  narrowAccessibleEvents: (data: unknown) => {
    const events = (data as { events?: unknown } | null | undefined)?.events;
    return Array.isArray(events)
      ? events.filter(
          (e) =>
            typeof e?.eventId === "string" &&
            typeof e?.orgId === "string" &&
            typeof e?.eventName === "string",
        )
      : [];
  },
}));

import type { Handler, Handlers } from "../../test/harness/fake-trpc-link";

(globalThis as { __DEV__?: boolean }).__DEV__ = false;

// Loaded afresh for every test, in `beforeEach`.
let db: typeof import("./local-db");
let link: typeof import("../../test/harness/fake-trpc-link");
let sqlite: typeof import("../../test/harness/expo-sqlite-on-node");
let useLocalSync: typeof import("./use-local-sync").useLocalSync;
let useAccessRevocation: typeof import("./use-access-revocation").useAccessRevocation;
let trpc: typeof import("../trpc").trpc;
let LIST_KEY: QueryKey;
let MANIFEST_KEY: QueryKey;

const E1 = "evt-1";
const E2 = "evt-2";

const event = (eventId: string) => ({
  eventId,
  orgId: `org-of-${eventId}`,
  orgName: "Org",
  eventName: `Event ${eventId}`,
  startAt: null,
  endAt: null,
  status: "PUBLISHED",
  role: "SCANNER",
});
const list = (...eventIds: string[]) => ({ events: eventIds.map(event) });

const person = (eventId: string) => ({
  humanId: `human-${eventId}`,
  displayName: `Attendee ${eventId}`,
  email: `attendee@${eventId}.test`,
  kind: "attendee" as const,
});
/** The cached people of an event, as a previous run of the app left them. */
const cachePeople = (...eventIds: string[]) => {
  for (const eventId of eventIds) db.upsertPeople(eventId, [person(eventId)]);
};
const cachedName = (eventId: string) =>
  db.lookupPersonName(eventId, `human-${eventId}`);
const foundBySearch = (eventId: string) =>
  db.searchPeople(eventId, "attendee").map((p) => p.displayName);

let queryClient: QueryClient;
let handlers: Handlers;
let listAccessibleEvents: ReturnType<typeof vi.fn<Handler>>;

const renderSync = (enabled = true) =>
  renderHook(({ on }: { on: boolean }) => useLocalSync(on), {
    initialProps: { on: enabled },
    wrapper: link.trpcWrapper(
      () => queryClient,
      () => handlers,
    ),
  });
const refreshList = () =>
  act(() => queryClient.invalidateQueries({ queryKey: LIST_KEY }));
const manifestOf = (eventId: unknown) => ({
  eventId,
  tickets: [
    {
      ticketId: `ticket-${String(eventId)}`,
      code: `TKT-${String(eventId)}`,
      eventId,
      status: "VALID",
      ownerHumanId: `human-${String(eventId)}`,
      scannedAt: null,
      ticketTypeName: "GA",
      orderId: null,
    },
  ],
  people: [person(String(eventId))],
});

const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 20)));

let getEventManifest: ReturnType<typeof vi.fn<Handler>>;

beforeEach(async () => {
  vi.resetModules();
  db = await import("./local-db");
  sqlite = await import("../../test/harness/expo-sqlite-on-node");
  link = await import("../../test/harness/fake-trpc-link");
  ({ useLocalSync } = await import("./use-local-sync"));
  ({ useAccessRevocation } = await import("./use-access-revocation"));
  // Open this test's database now, so `sqlite.rawDatabase()` can never hand
  // back the one a previous test opened.
  db.lookupTicketByCode("none");
  ({ trpc } = await import("../trpc"));
  LIST_KEY = getQueryKey(trpc.scanner.listAccessibleEvents, {}, "query");
  MANIFEST_KEY = getQueryKey(trpc.scanner.getEventManifest);
  const { createQueryClient } = await import("../query-client");

  sentry.captureException.mockReset();
  queryClient = createQueryClient();
  listAccessibleEvents = vi.fn<Handler>(async () => list(E1, E2));
  // The manifest sync re-caches each listed event's people, as the app does.
  getEventManifest = vi.fn<Handler>(async (input) => manifestOf(input.eventId));
  handlers = {
    "scanner.listAccessibleEvents": listAccessibleEvents,
    "scanner.getEventManifest": getEventManifest,
  };
});

afterEach(() => {
  // Unmount first: it clears the hook's 60s manifest interval.
  cleanup();
  sqlite.refuseStatements(null);
  queryClient.clear();
});

describe("the first confirmed event list after a cold start", () => {
  it("drops the people of a cached event that is not in it, and keeps the rest", async () => {
    cachePeople(E1, E2);
    listAccessibleEvents.mockResolvedValue(list(E1));
    const h = renderSync();

    await waitFor(() => expect(h.result.current.accessibleEvents).toHaveLength(1));
    expect(cachedName(E2)).toBeNull();
    expect(foundBySearch(E2)).toEqual([]);
    expect(cachedName(E1)).toBe("Attendee evt-1");
    expect(foundBySearch(E1)).toEqual(["Attendee evt-1"]);
  });

  it("drops nothing while the list is still loading", async () => {
    cachePeople(E1, E2);
    const answer = link.deferred<unknown>();
    listAccessibleEvents.mockImplementation(() => answer.promise);
    renderSync();

    await waitFor(() => expect(listAccessibleEvents).toHaveBeenCalled());
    await settle();
    expect(cachedName(E1)).toBe("Attendee evt-1");
    expect(cachedName(E2)).toBe("Attendee evt-2");

    // And the answer, when it comes, is acted on.
    await act(async () => {
      answer.resolve(list(E1));
    });
    await waitFor(() => expect(cachedName(E2)).toBeNull());
    expect(cachedName(E1)).toBe("Attendee evt-1");
  });

  for (const [name, failure] of [
    ["the network is down", () => link.lostAnswer()],
    ["the server errors", () => link.refusal("INTERNAL_SERVER_ERROR", "INTERNAL")],
    ["the list is refused", () => link.refusal("FORBIDDEN", "INSUFFICIENT_ROLE")],
  ] as const) {
    it(`drops nothing when ${name}`, async () => {
      cachePeople(E1, E2);
      listAccessibleEvents.mockImplementation(() => Promise.reject(failure()));
      const h = renderSync();

      // The app's query client retries once, a second later.
      await waitFor(
        () => expect(listAccessibleEvents).toHaveBeenCalledTimes(2),
        { timeout: 3_000 },
      );
      await waitFor(() => expect(h.result.current.isSyncing).toBe(false));
      expect(cachedName(E1)).toBe("Attendee evt-1");
      expect(cachedName(E2)).toBe("Attendee evt-2");
    });
  }

  it("a successful EMPTY list is a real answer: every cached person goes", async () => {
    cachePeople(E1, E2);
    listAccessibleEvents.mockResolvedValue(list());
    const h = renderSync();

    await waitFor(() => expect(h.result.current.isSyncing).toBe(false));
    await waitFor(() => expect(cachedName(E1)).toBeNull());
    expect(cachedName(E2)).toBeNull();
  });

  it("drops nothing while sync is switched off", async () => {
    cachePeople(E1, E2);
    renderSync(false);

    await settle();
    expect(listAccessibleEvents).not.toHaveBeenCalled();
    expect(cachedName(E1)).toBe("Attendee evt-1");
    expect(cachedName(E2)).toBe("Attendee evt-2");
  });
});

describe("later lists", () => {
  it("drop the people of an event that leaves the list", async () => {
    const h = renderSync();
    // Both events listed, and their manifests cached by the sync itself.
    await waitFor(() => expect(cachedName(E2)).toBe("Attendee evt-2"));
    expect(cachedName(E1)).toBe("Attendee evt-1");

    listAccessibleEvents.mockResolvedValue(list(E1));
    await refreshList();

    await waitFor(() => expect(h.result.current.accessibleEvents).toHaveLength(1));
    await waitFor(() => expect(cachedName(E2)).toBeNull());
    expect(cachedName(E1)).toBe("Attendee evt-1");
  });

  it("a manifest that lands after its event left the list is not written back", async () => {
    const lateManifest = link.deferred<unknown>();
    getEventManifest.mockImplementation((input) =>
      input.eventId === E2
        ? lateManifest.promise
        : Promise.resolve(manifestOf(input.eventId)),
    );
    const h = renderSync();
    await waitFor(() => expect(cachedName(E1)).toBe("Attendee evt-1"));
    expect(cachedName(E2)).toBeNull();

    // E2 leaves the list while its manifest is still on the wire.
    listAccessibleEvents.mockResolvedValue(list(E1));
    await refreshList();
    await waitFor(() => expect(h.result.current.accessibleEvents).toHaveLength(1));

    await act(async () => {
      lateManifest.resolve(manifestOf(E2));
    });
    await settle();
    expect(cachedName(E2)).toBeNull();
    expect(db.lookupTicketByCode("TKT-evt-2")).toBeNull();
    expect(db.lookupTicketByCode("TKT-evt-1")).not.toBeNull();
  });

  it("compare with SQLite again after sync was switched off and on", async () => {
    const h = renderSync();
    await waitFor(() => expect(cachedName(E2)).toBe("Attendee evt-2"));

    h.rerender({ on: false });
    // Rows the in-memory list knows nothing about.
    cachePeople("evt-stray");
    h.rerender({ on: true });

    await waitFor(() => expect(cachedName("evt-stray")).toBeNull());
    expect(cachedName(E1)).toBe("Attendee evt-1");
    // The list left in the cache was not taken as this stretch's answer.
    expect(listAccessibleEvents).toHaveBeenCalledTimes(2);
  });
});

describe("what does not count as a confirmed list", () => {
  it("a list the cache already held when sync was switched on", async () => {
    // A previous operator's EMPTY list, still in the query cache (sign-out
    // does not clear the query cache). Read as an answer, it would drop
    // everyone.
    cachePeople(E1, E2);
    queryClient.setQueryData(LIST_KEY, list(), {
      updatedAt: Date.now() - 60_000,
    });
    const answer = link.deferred<unknown>();
    listAccessibleEvents.mockImplementation(() => answer.promise);
    renderSync();

    // This stretch's own list is asked for at once, not in 10 minutes.
    await waitFor(() => expect(listAccessibleEvents).toHaveBeenCalledTimes(1));
    await settle();
    expect(cachedName(E1)).toBe("Attendee evt-1");
    expect(cachedName(E2)).toBe("Attendee evt-2");

    await act(async () => {
      answer.resolve(list(E1));
    });
    await waitFor(() => expect(cachedName(E2)).toBeNull());
    expect(cachedName(E1)).toBe("Attendee evt-1");
  });

  for (const [name, body] of [
    ["an answer with no events array", {}],
    ["an answer whose events is not an array", { events: "none" }],
  ] as const) {
    it(`${name} (a wrong-shape 200)`, async () => {
      cachePeople(E1, E2);
      listAccessibleEvents.mockResolvedValue(body);
      const h = renderSync();

      await waitFor(() => expect(listAccessibleEvents).toHaveBeenCalled());
      await waitFor(() => expect(h.result.current.isSyncing).toBe(false));
      await settle();
      expect(cachedName(E1)).toBe("Attendee evt-1");
      expect(cachedName(E2)).toBe("Attendee evt-2");
    });
  }

  it("a list with an entry that cannot be read: nothing is dropped, the rest still syncs", async () => {
    cachePeople(E2);
    listAccessibleEvents.mockResolvedValue({
      events: [event(E1), { eventName: "no id" }],
    });
    renderSync();

    // E1 is synced from the list...
    await waitFor(() => expect(cachedName(E1)).toBe("Attendee evt-1"));
    // ...but E2, which may be the unreadable entry, keeps its people.
    expect(cachedName(E2)).toBe("Attendee evt-2");
  });
});

describe("a manifest that cannot be written to SQLite", () => {
  it("is reported, once per app run, however many events fail", async () => {
    // Both manifests arrive; neither can be written.
    sqlite.refuseStatements(/INSERT OR REPLACE INTO tickets/);
    const h = renderSync();

    await waitFor(() => expect(getEventManifest).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error), {
        tags: { feature: "pii_retention", branch: "manifest_local_write" },
        extra: undefined,
      }),
    );
    // A second pass over both events, as the next minute's tick would make.
    // (Marked stale first: a manifest under 30 seconds old is served from the
    // query cache without asking the server.)
    await act(() => queryClient.invalidateQueries({ queryKey: MANIFEST_KEY }));
    act(() => h.result.current.refresh());
    await waitFor(() => expect(getEventManifest).toHaveBeenCalledTimes(4));
    await settle();

    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(h.result.current.accessibleEvents).toHaveLength(2);
  });

  it("a manifest that cannot be FETCHED is not reported from here", async () => {
    getEventManifest.mockImplementation(() => Promise.reject(link.lostAnswer()));
    renderSync();

    await waitFor(() => expect(getEventManifest).toHaveBeenCalled());
    await settle();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });
});

describe("a drop that fails", () => {
  it("is reported and does not take the hook down", async () => {
    cachePeople(E1, E2);
    listAccessibleEvents.mockResolvedValue(list(E1));
    // The rows go, then the index rebuild finds no table and throws.
    sqlite.rawDatabase().exec("ALTER TABLE people_fts RENAME TO people_fts_away;");
    const h = renderSync();

    await waitFor(() =>
      expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error), {
        tags: { feature: "pii_retention", branch: "event_list_people_drop" },
        extra: { listedEvents: 1, firstAnswer: true },
      }),
    );
    expect(h.result.current.accessibleEvents).toHaveLength(1);
    expect(cachedName(E2)).toBeNull();
  });
});

describe("a saved event the operator can no longer scan, with a role elsewhere", () => {
  // Removed from the org that ran E2, still a SCANNER for the org running E1.
  // The session context (asked with no event) is granted and the event list
  // no longer holds E2. A session question that names E2 is refused, which is
  // about E2's org only. Together: E2's people go, and nothing else does.
  function useScannerShell() {
    const session = trpc.scanner.getSessionContext.useQuery(
      {},
      { retry: false, staleTime: 60_000 },
    );
    const forSavedEvent = trpc.scanner.getSessionContext.useQuery(
      { eventId: E2 },
      { retry: false, staleTime: 60_000 },
    );
    const accessDenied = session.error?.data?.code === "FORBIDDEN";
    const { deniedReason } = useAccessRevocation({
      userId: "human-1",
      accessDenied,
    });
    const sync = useLocalSync(session.isSuccess && !accessDenied);
    return {
      accessDenied,
      deniedReason,
      savedEventStatus: forSavedEvent.status,
      listed: sync.accessibleEvents.map((e) => e.eventId),
    };
  }

  it("drops the departed event's people and keeps everything else on the device", async () => {
    cachePeople(E1, E2);
    // No sync writes recent scans back: what is left of them shows what went.
    for (const eventId of [E1, E2]) {
      db.recordRecentScan({
        eventId,
        ticketCode: `TKT-${eventId}`,
        ticketId: `ticket-${eventId}`,
        holderDisplay: `Attendee ${eventId}`,
        kind: "ticket",
      });
    }
    handlers["scanner.getSessionContext"] = vi.fn<Handler>((input) =>
      input.eventId
        ? Promise.reject(link.refusal("FORBIDDEN", "INSUFFICIENT_ROLE"))
        : Promise.resolve({
            operator: { humanId: "human-1", displayName: "Op", email: "op@example.test" },
            orgs: [{ orgId: "org-1", orgName: "Org", role: "SCANNER" }],
          }),
    );
    listAccessibleEvents.mockResolvedValue(list(E1));

    const h = renderHook(useScannerShell, {
      wrapper: link.trpcWrapper(
        () => queryClient,
        () => handlers,
      ),
    });

    await waitFor(() => expect(h.result.current.savedEventStatus).toBe("error"));
    await waitFor(() => expect(h.result.current.listed).toEqual([E1]));
    await waitFor(() => expect(cachedName(E2)).toBeNull());
    await settle();

    expect(foundBySearch(E2)).toEqual([]);
    expect(cachedName(E1)).toBe("Attendee evt-1");
    expect(h.result.current.accessDenied).toBe(false);
    expect(h.result.current.deniedReason).toBeNull();
    // No wipe: the listed event's recent scan and synced ticket are still
    // there. The departed event's recent scan, with its holder's name, went.
    expect(db.listRecentScans().map((r) => r.eventId)).toEqual([E1]);
    expect(db.lookupTicketByCode("TKT-evt-1")).not.toBeNull();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });
});

describe("the 24 hour sweep", () => {
  const DAY_AND_AN_HOUR = 25 * 60 * 60_000;
  /** As if the last manifest sync was more than a day ago. */
  const ageCachedPeople = () =>
    sqlite
      .rawDatabase()
      .prepare("UPDATE people SET synced_at = ?")
      .run(Date.now() - DAY_AND_AN_HOUR);

  it("does not run before a list is confirmed: an offline start the next day keeps the people", async () => {
    cachePeople(E1, E2);
    ageCachedPeople();
    listAccessibleEvents.mockImplementation(() => Promise.reject(link.lostAnswer()));
    const h = renderSync();

    // Home's refresh at mount, then a few more, all before any list.
    act(() => h.result.current.refresh());
    await waitFor(() => expect(listAccessibleEvents).toHaveBeenCalled());
    act(() => h.result.current.refresh());
    await settle();

    expect(cachedName(E1)).toBe("Attendee evt-1");
    expect(cachedName(E2)).toBe("Attendee evt-2");
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("a sweep that fails is reported once per app run, not on every tick", async () => {
    const h = renderSync();
    await waitFor(() => expect(cachedName(E1)).toBe("Attendee evt-1"));
    // The sweep reads the people table first; take it away.
    sqlite.rawDatabase().exec("ALTER TABLE people RENAME TO people_away;");

    for (let tick = 0; tick < 3; tick++) act(() => h.result.current.refresh());
    await settle();

    const sweeps = sentry.captureException.mock.calls.filter(
      ([, context]) => context?.tags?.branch === "stale_people_sweep",
    );
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0]?.[1]?.tags?.feature).toBe("pii_retention");
  });

  it("a drop for an ended event that fails is reported once per app run", async () => {
    const ended = new Date(Date.now() - DAY_AND_AN_HOUR).toISOString();
    listAccessibleEvents.mockResolvedValue({
      events: [{ ...event(E1), endAt: ended }],
    });
    const h = renderSync();
    await waitFor(() => expect(h.result.current.accessibleEvents).toHaveLength(1));
    sqlite.rawDatabase().exec("ALTER TABLE people RENAME TO people_away;");

    for (let tick = 0; tick < 3; tick++) act(() => h.result.current.refresh());
    await settle();

    const drops = sentry.captureException.mock.calls.filter(
      ([, context]) => context?.tags?.branch === "ended_event_people_drop",
    );
    expect(drops).toHaveLength(1);
  });
});
