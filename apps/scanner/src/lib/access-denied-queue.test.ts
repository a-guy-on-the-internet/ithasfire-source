// @vitest-environment jsdom
/**
 * The access-denied wipe and the offline scan queue, together.
 *
 * The scanner's own gate (`scanner.getSessionContext`) admits OWNER, ADMIN and
 * SCANNER. The admit itself (`tickets.scanTicket`) also admits EDITOR. So an
 * operator moved from SCANNER to EDITOR mid-shift is refused at the gate while
 * the admits still queued on their device are ones the server WILL take. The
 * wipe therefore removes the attendee data and leaves the queue, and the queue
 * keeps flushing for as long as someone is signed in.
 *
 * Real pieces: `local-db.ts` on Node's SQLite, the app's tRPC React client and
 * React Query defaults, `useAccessRevocation`, `useScanQueue`. Stand-ins: the
 * network link (answered by the test), connectivity, `AppState`, Sentry.
 *
 * No JSX: this file runs in the `unit` project (classic runtime).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-sqlite", () => import("../../test/harness/expo-sqlite-on-node"));
vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: () => ({ remove: () => {} }),
  },
}));

/** The device's connectivity, for the test to change. */
const net = vi.hoisted(() => ({
  state: "offline" as "online" | "degraded" | "offline",
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

import type { Handler, Handlers } from "../../test/harness/fake-trpc-link";

(globalThis as { __DEV__?: boolean }).__DEV__ = false;

// Loaded afresh for every test (own database, own module state).
let db: typeof import("./local-db");
let link: typeof import("../../test/harness/fake-trpc-link");
let trpc: typeof import("../trpc").trpc;
let useAccessRevocation: typeof import("./use-access-revocation").useAccessRevocation;
let useScanQueue: typeof import("./use-scan-queue").useScanQueue;

const OPERATOR = "human-1";
const EVENT = "evt-1";

let queryClient: QueryClient;
let handlers: Handlers;
let scanTicket: ReturnType<typeof vi.fn<Handler>>;
let renders: number;

/**
 * The part of `scanner-app.tsx` under test: the session query as
 * `useScannerSession` runs it, the wipe hook, and the queue gated on "someone
 * is signed in" (`useScanQueue(!!user, user?.id ?? null)`), not on scan
 * access.
 */
function useSignedInApp(props: { userId: string | undefined }) {
  // A render loop fails the test here instead of running the worker out of
  // memory (which is how the queue's old re-send loop first showed up).
  if (++renders > 500) throw new Error(`render loop: ${renders} renders`);
  const query = trpc.scanner.getSessionContext.useQuery(
    {},
    { enabled: !!props.userId, retry: false, staleTime: 60_000 },
  );
  const accessDenied = !!(
    props.userId &&
    query.error &&
    query.error.data?.code === "FORBIDDEN"
  );
  useAccessRevocation({ userId: props.userId, accessDenied });
  const queue = useScanQueue(!!props.userId, props.userId ?? null);
  return { accessDenied, queue };
}

const renderApp = () =>
  renderHook(useSignedInApp, {
    initialProps: { userId: OPERATOR },
    wrapper: link.trpcWrapper(
      () => queryClient,
      () => handlers,
    ),
  });

const cachedName = () => db.lookupPersonName(EVENT, "human-sam");

/** What a shift leaves on the device: the door list and two unsent admits. */
const seedShift = () => {
  db.upsertPeople(EVENT, [
    {
      humanId: "human-sam",
      displayName: "Sam Keeper",
      email: "sam@example.test",
      kind: "attendee",
    },
  ]);
  db.enqueueScan({ eventId: EVENT, ticketCode: "TKT-1", clientKey: "key-1" });
  db.enqueueScan({ eventId: EVENT, ticketCode: "TKT-2", clientKey: "key-2" });
};

beforeEach(async () => {
  vi.resetModules();
  db = await import("./local-db");
  link = await import("../../test/harness/fake-trpc-link");
  ({ trpc } = await import("../trpc"));
  ({ useAccessRevocation } = await import("./use-access-revocation"));
  ({ useScanQueue } = await import("./use-scan-queue"));
  const { createQueryClient } = await import("../query-client");

  sentry.captureException.mockReset();
  renders = 0;
  // Offline to start with, as at a door with no signal: nothing is flushed
  // before the wipe has run.
  net.state = "offline";
  net.listeners.clear();
  queryClient = createQueryClient();
  scanTicket = vi.fn<Handler>(async () => ({ outcome: "ADMITTED" }));
  handlers = {
    // The scanner's gate refuses this operator: no scan role any more.
    "scanner.getSessionContext": vi.fn<Handler>(() =>
      Promise.reject(link.refusal("FORBIDDEN", "INSUFFICIENT_ROLE")),
    ),
    "tickets.scanTicket": scanTicket,
  };
  seedShift();
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe("an operator who loses scanner access with admits still queued", () => {
  it("SCANNER to EDITOR: the attendee data goes, the queue stays, and the next flush sends it", async () => {
    const h = renderApp();

    await waitFor(() => expect(h.result.current.accessDenied).toBe(true));
    await waitFor(() => expect(cachedName()).toBeNull());
    expect(db.searchPeople(EVENT, "sam")).toEqual([]);

    // Both admits are still on the device, untouched.
    expect(db.listQueuedScans().map((q) => q.clientKey).sort()).toEqual([
      "key-1",
      "key-2",
    ]);
    expect(scanTicket).not.toHaveBeenCalled();

    // Signal comes back while the access-denied screen is up. An EDITOR may
    // record an admit, so the server takes both, once each.
    networkBecomes("online");

    await waitFor(() => expect(db.countQueuedScans()).toBe(0));
    expect(scanTicket.mock.calls.map(([input]) => input)).toEqual([
      { eventId: EVENT, ticketCode: "TKT-1", clientKey: "key-1" },
      { eventId: EVENT, ticketCode: "TKT-2", clientKey: "key-2" },
    ]);
    expect(db.countDroppedScans()).toBe(0);
    expect(cachedName()).toBeNull();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("removed from the org: the server refuses each admit, and each one is kept as a failed sync and reported", async () => {
    // `tickets.scanTicket` refuses a missing role with NOT_AUTHORIZED
    // (`scan-ticket.ts`, `ensureActorCanScan`).
    scanTicket.mockImplementation(() =>
      Promise.reject(link.refusal("FORBIDDEN", "NOT_AUTHORIZED")),
    );
    const h = renderApp();

    await waitFor(() => expect(h.result.current.accessDenied).toBe(true));
    await waitFor(() => expect(cachedName()).toBeNull());
    expect(db.countQueuedScans()).toBe(2);

    networkBecomes("online");

    // Out of the queue and into the failed-sync list, AFTER the wipe: these
    // rows are meant to exist, they are the only record of two door admits.
    await waitFor(() => expect(db.countDroppedScans()).toBe(2));
    expect(db.countQueuedScans()).toBe(0);
    // One request per admit: the queue sends through the plain client, so the
    // query client's `mutations.retry: 1` does not double each one.
    expect(scanTicket).toHaveBeenCalledTimes(2);
    expect(
      db
        .listDroppedScans()
        .map((d) => [d.clientKey, d.reason])
        .sort(),
    ).toEqual([
      ["key-1", "permanent_error"],
      ["key-2", "permanent_error"],
    ]);

    const drops = sentry.captureException.mock.calls.filter(
      ([, context]) => context?.tags?.branch === "queue_terminal_drop",
    );
    expect(drops).toHaveLength(2);
    for (const [, context] of drops) {
      expect(context.tags).toMatchObject({
        feature: "scan",
        eventId: EVENT,
        dropReason: "permanent_error",
      });
      // The ticket code is a bearer credential: never in a report.
      expect(JSON.stringify(context)).not.toContain("TKT-");
    }
    // The wipe itself had nothing to report.
    expect(
      sentry.captureException.mock.calls.filter(
        ([, context]) => context?.tags?.feature === "pii_retention",
      ),
    ).toEqual([]);
  });

  it("a queue that was flushing before the refusal is not stopped by it", async () => {
    // Online throughout: the queue's own flush and the wipe overlap.
    net.state = "online";
    const h = renderApp();

    await waitFor(() => expect(h.result.current.accessDenied).toBe(true));
    await waitFor(() => expect(cachedName()).toBeNull());
    await waitFor(() => expect(db.countQueuedScans()).toBe(0));
    expect(scanTicket).toHaveBeenCalledTimes(2);
    expect(db.countDroppedScans()).toBe(0);
  });

  it("each queued admit is sent once, however long the server takes to answer", async () => {
    // Every send re-renders the hook. A flush that restarts on each render
    // sends the same row again and again until the first answer lands: at this
    // latency, two admits used to make several thousand requests.
    scanTicket.mockImplementation(
      () =>
        new Promise((answer) =>
          setTimeout(() => answer({ outcome: "ADMITTED" }), 30),
        ),
    );
    net.state = "online";
    renderApp();

    await waitFor(() => expect(db.countQueuedScans()).toBe(0));
    await act(() => new Promise<void>((r) => setTimeout(r, 100)));
    expect(scanTicket.mock.calls.map(([input]) => input.clientKey)).toEqual([
      "key-1",
      "key-2",
    ]);
  });
});

describe("scanner-app.tsx wiring (source guard)", () => {
  // The hooks above are composed by hand; this pins the line in the app that
  // the composition copies. Gating the queue on scan access (`authed`) would
  // strand every queued admit behind the access-denied screen.
  it("runs the scan queue for any signed-in user, not only one with scan access", () => {
    const source = readFileSync(
      resolve(__dirname, "../scanner-app.tsx"),
      "utf8",
    );
    expect(source).toMatch(
      /useScanQueue\(\s*!!user,\s*user\?\.id \?\? null,?\s*\)/,
    );
    expect(source).not.toMatch(/useScanQueue\(\s*authed\s*\)/);
  });
});
