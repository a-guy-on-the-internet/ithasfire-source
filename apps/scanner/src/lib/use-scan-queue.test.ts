// @vitest-environment jsdom
/**
 * `useScanQueue` against the REAL `local-db.ts` (on Node's SQLite) and the
 * app's real tRPC client, with the network swapped for a link the test
 * answers. Time is faked: the queue's 15 second interval, its 20 second send
 * timeout and its backoff are the subject.
 *
 * No JSX: this file runs in the `unit` project (classic runtime).
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-sqlite", () => import("../../test/harness/expo-sqlite-on-node"));

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
let sqlite: typeof import("../../test/harness/expo-sqlite-on-node");
let useScanQueue: typeof import("./use-scan-queue").useScanQueue;

const EVENT = "evt-1";
const OPERATOR = "human-1";
const INTERVAL_MS = 15_000;
const SEND_TIMEOUT_MS = 20_000;

let queryClient: QueryClient;
let handlers: Handlers;
let scanTicket: ReturnType<typeof vi.fn<Handler>>;

type Props = { enabled: boolean; userId: string | null };
const renderQueue = (initialProps: Props = { enabled: true, userId: OPERATOR }) =>
  renderHook((props: Props) => useScanQueue(props.enabled, props.userId), {
    initialProps,
    wrapper: link.trpcWrapper(
      () => queryClient,
      () => handlers,
    ),
  });

/** Let `ms` of the clock pass, with everything that wakes in it. */
const pass = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

/** Queue an admit. The clock moves 1 ms so rows keep their order. */
const enqueue = (ticketCode: string) => {
  vi.advanceTimersByTime(1);
  return db.enqueueScan({ eventId: EVENT, ticketCode, clientKey: `key-${ticketCode}` });
};
const sentCodes = () => scanTicket.mock.calls.map(([input]) => input.ticketCode);
const queuedCodes = () => db.listQueuedScans().map((q) => q.ticketCode);
const terminalDropReports = () =>
  sentry.captureException.mock.calls.filter(
    ([, context]) => context?.tags?.branch === "queue_terminal_drop",
  );
const notAuthorized = () => link.refusal("FORBIDDEN", "NOT_AUTHORIZED");
const never = () => new Promise<never>(() => {});

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-10T20:00:00Z"));
  db = await import("./local-db");
  link = await import("../../test/harness/fake-trpc-link");
  sqlite = await import("../../test/harness/expo-sqlite-on-node");
  ({ useScanQueue } = await import("./use-scan-queue"));
  const { createQueryClient } = await import("../query-client");

  sentry.captureException.mockReset();
  net.state = "online";
  net.listeners.clear();
  queryClient = createQueryClient();
  scanTicket = vi.fn<Handler>(async () => ({ outcome: "ADMITTED" }));
  handlers = { "tickets.scanTicket": scanTicket };
});

afterEach(() => {
  cleanup();
  sqlite.refuseStatements(null);
  queryClient.clear();
  vi.useRealTimers();
});

describe("a send that never gets an answer", () => {
  it("is given up after 20 seconds: the rest of the queue goes, and the row is tried again later", async () => {
    enqueue("TKT-A");
    enqueue("TKT-B");
    const signals: Array<AbortSignal | undefined> = [];
    // The first request for A leaves and nothing comes back (half-open wifi).
    scanTicket.mockImplementationOnce((_input, request) => {
      signals.push(request.signal);
      return never();
    });
    renderQueue();

    await pass(0);
    expect(sentCodes()).toEqual(["TKT-A"]);

    // The next interval finds the pass still waiting and starts nothing.
    await pass(INTERVAL_MS);
    expect(sentCodes()).toEqual(["TKT-A"]);
    expect(queuedCodes()).toEqual(["TKT-A", "TKT-B"]);

    // 20 seconds: A is given up, its request aborted, and B is sent.
    await pass(SEND_TIMEOUT_MS - INTERVAL_MS);
    expect(signals[0]?.aborted).toBe(true);
    expect(sentCodes()).toEqual(["TKT-A", "TKT-B"]);
    const [stillQueued] = db.listQueuedScans();
    expect(queuedCodes()).toEqual(["TKT-A"]);
    expect(stillQueued).toMatchObject({
      attempts: 1,
      lastError: "no answer after 20s",
    });
    // Parked, not dropped: nothing in the failed list, nothing reported.
    expect(db.countDroppedScans()).toBe(0);
    expect(terminalDropReports()).toEqual([]);

    // A later interval sends A again, under the same client key.
    await pass(INTERVAL_MS);
    expect(sentCodes()).toEqual(["TKT-A", "TKT-B", "TKT-A"]);
    expect(scanTicket.mock.calls[2]?.[0]).toMatchObject({ clientKey: "key-TKT-A" });
    expect(queuedCodes()).toEqual([]);
  });

  it("does not stop the queue for the rest of the app run", async () => {
    enqueue("TKT-A");
    scanTicket.mockImplementationOnce(never);
    const h = renderQueue();
    await pass(0);

    // Long after the hung send: a new admit is queued and goes out.
    await pass(SEND_TIMEOUT_MS + INTERVAL_MS);
    enqueue("TKT-C");
    await pass(INTERVAL_MS);

    expect(queuedCodes()).toEqual([]);
    expect(sentCodes()).toContain("TKT-C");
    expect(h.result.current.queueDepth).toBe(0);
  });
});

describe("two sends in a row with no answer", () => {
  it("end the pass: the rest of the queue waits for the next interval, not 20 seconds a row", async () => {
    enqueue("TKT-A");
    enqueue("TKT-B");
    enqueue("TKT-C");
    scanTicket.mockImplementationOnce(never).mockImplementationOnce(never);
    renderQueue();
    await pass(0);

    // A gives up at 20 s and B is sent; B gives up at 40 s and the pass ends.
    await pass(SEND_TIMEOUT_MS);
    expect(sentCodes()).toEqual(["TKT-A", "TKT-B"]);
    await pass(SEND_TIMEOUT_MS);
    expect(sentCodes()).toEqual(["TKT-A", "TKT-B"]);
    const rows = Object.fromEntries(
      db.listQueuedScans().map((q) => [q.ticketCode, q]),
    );
    // B is parked with a backoff, one attempt: on half-open wifi the next
    // pass would time out on it again, so it is not due at once.
    expect(rows["TKT-B"]).toMatchObject({ attempts: 1, lastError: "no answer after 20s" });
    expect(rows["TKT-B"]!.nextAttemptAt).toBeGreaterThan(Date.now());
    expect(rows["TKT-B"]!.nextAttemptAt).toBeLessThanOrEqual(Date.now() + 5_000);
    expect(rows["TKT-C"]).toMatchObject({ attempts: 0 });

    // The next interval starts from the top, and everything answers now.
    await pass(INTERVAL_MS);
    expect(queuedCodes()).toEqual([]);
    expect(sentCodes().slice(2)).toEqual(["TKT-A", "TKT-B", "TKT-C"]);
  });

  it("one unanswered send between two that answer does not end the pass", async () => {
    enqueue("TKT-A");
    enqueue("TKT-B");
    enqueue("TKT-C");
    enqueue("TKT-D");
    scanTicket
      .mockImplementationOnce(never)
      .mockImplementationOnce(async () => ({ outcome: "ADMITTED" }))
      .mockImplementationOnce(never);
    renderQueue();
    await pass(0);

    await pass(2 * SEND_TIMEOUT_MS);
    // A timed out, B went, C timed out (one in a row again), D was sent.
    expect(sentCodes()).toEqual(["TKT-A", "TKT-B", "TKT-C", "TKT-D"]);
    expect(queuedCodes()).toEqual(["TKT-A", "TKT-C"]);
  });
});

describe("a pass that fails locally", () => {
  it("is reported, and an admit the server took is not filed as refused", async () => {
    enqueue("TKT-A");
    // The send succeeds; taking the row out of the queue fails.
    sqlite.refuseStatements(/DELETE FROM scan_queue/);
    renderQueue();
    await pass(0);

    const reports = sentry.captureException.mock.calls.filter(
      ([, context]) => context?.tags?.branch === "queue_flush_failed",
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]?.[1]?.tags?.feature).toBe("scan");
    expect(db.listDroppedScans()).toEqual([]);
    expect(terminalDropReports()).toEqual([]);
  });
});

describe("a pass that outlives the sign-in it started under", () => {
  /** Rows as a pass holds them in memory: one being sent, one at its last attempt. */
  const seedInFlightAndExhausted = () => {
    enqueue("TKT-A");
    const exhausted = enqueue("TKT-B");
    for (let i = 0; i < 8; i++) db.bumpQueuedScan(exhausted.queueId, "HTTP 503", 0);
  };

  it("writes nothing back after the sign-out purge, whatever the server then answers", async () => {
    seedInFlightAndExhausted();
    const answer = link.deferred<unknown>();
    scanTicket.mockImplementationOnce(() => answer.promise);
    renderQueue();
    await pass(0);
    expect(sentCodes()).toEqual(["TKT-A"]);

    // Sign-out wipes the database first; React has not re-rendered yet.
    db.clearAll();
    // A is refused (a drop, were its row still there), and B is at its last
    // attempt (a drop from memory, were the pass to carry on).
    await act(async () => {
      answer.reject(notAuthorized());
    });
    await pass(0);

    expect(db.listDroppedScans()).toEqual([]);
    expect(db.listQueuedScans()).toEqual([]);
    expect(terminalDropReports()).toEqual([]);
    expect(sentCodes()).toEqual(["TKT-A"]);
  });

  it("stops when the person signs out: no more sends, no local writes", async () => {
    enqueue("TKT-A");
    enqueue("TKT-B");
    const answer = link.deferred<unknown>();
    scanTicket.mockImplementationOnce(() => answer.promise);
    const h = renderQueue();
    await pass(0);

    h.rerender({ enabled: false, userId: null });
    await act(async () => {
      answer.reject(notAuthorized());
    });
    await pass(INTERVAL_MS);

    expect(sentCodes()).toEqual(["TKT-A"]);
    expect(db.listDroppedScans()).toEqual([]);
    expect(db.listQueuedScans().map((q) => [q.ticketCode, q.attempts])).toEqual([
      ["TKT-A", 0],
      ["TKT-B", 0],
    ]);
    expect(terminalDropReports()).toEqual([]);
  });

  it("the next person's queue does not wait behind it, and it never writes into their database", async () => {
    seedInFlightAndExhausted();
    scanTicket.mockImplementationOnce(never);
    const h = renderQueue();
    await pass(0);

    // Sign-out purge, then someone else signs in and admits a ticket offline.
    db.clearAll();
    h.rerender({ enabled: false, userId: null });
    enqueue("TKT-C");
    h.rerender({ enabled: true, userId: "human-2" });
    await pass(0);

    // C went out at once, although the first person's send is still hanging.
    expect(sentCodes()).toEqual(["TKT-A", "TKT-C"]);
    expect(queuedCodes()).toEqual([]);

    // The old send times out: nothing of the first person's comes back.
    await pass(SEND_TIMEOUT_MS + INTERVAL_MS);
    expect(db.listDroppedScans()).toEqual([]);
    expect(db.listQueuedScans()).toEqual([]);
    expect(sentCodes()).toEqual(["TKT-A", "TKT-C"]);
  });

  it("an admit undone while it was being sent leaves no failed-sync row", async () => {
    const queued = enqueue("TKT-A");
    const answer = link.deferred<unknown>();
    scanTicket.mockImplementationOnce(() => answer.promise);
    renderQueue();
    await pass(0);

    db.removeQueuedScan(queued.queueId);
    await act(async () => {
      answer.reject(notAuthorized());
    });
    await pass(0);

    expect(db.listDroppedScans()).toEqual([]);
    expect(terminalDropReports()).toEqual([]);
  });
});

describe("the flush is set up once, not on every render", () => {
  // `flush` used to depend on the whole `useMutation()` result, a new object
  // on each render, so every render tore the interval down, set a new one and
  // started another pass. The single-flight guard hides the extra sends; this
  // pins the cause.
  const intervalsSet = (spy: { mock: { calls: ReadonlyArray<readonly unknown[]> } }) =>
    spy.mock.calls.filter(([, delay]) => delay === INTERVAL_MS).length;

  it("keeps one interval and one `flush` across re-renders and sends", async () => {
    enqueue("TKT-A");
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const h = renderQueue();
    await pass(0);
    const flush = h.result.current.flush;
    expect(intervalsSet(setIntervalSpy)).toBe(1);

    for (let i = 0; i < 3; i++) {
      h.rerender({ enabled: true, userId: OPERATOR });
      enqueue(`TKT-${i}`);
      await pass(INTERVAL_MS);
    }

    expect(queuedCodes()).toEqual([]);
    expect(h.result.current.flush).toBe(flush);
    expect(intervalsSet(setIntervalSpy)).toBe(1);
    expect(sentCodes()).toEqual(["TKT-A", "TKT-0", "TKT-1", "TKT-2"]);
  });

  it("sets a new one only when the network or the person changes", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const h = renderQueue();
    await pass(0);
    expect(intervalsSet(setIntervalSpy)).toBe(1);

    act(() => {
      net.state = "offline";
      for (const listener of [...net.listeners]) listener();
    });
    expect(intervalsSet(setIntervalSpy)).toBe(2);

    h.rerender({ enabled: true, userId: "human-2" });
    expect(intervalsSet(setIntervalSpy)).toBe(3);
  });
});
