// @vitest-environment jsdom
/**
 * Regression: the door-scanner crash of 2026-10-13 (Pixel 7, release build
 * 90186d0c9). One admit was queued after the API stopped answering; the next
 * flush sent it, and the send itself re-rendered the queue hook. `flush` took
 * the `useMutation()` result as a dependency, that object is new on every
 * mutation state change, so each render built a new `flush` and both flush
 * effects ran it again: send → re-render → send. With the network failing the
 * row came back due at once, so nothing ever ended the loop. On the phone that
 * was three `scanTicket` sends with one clientKey ~100 ms apart, then
 * "Maximum update depth exceeded", and the whole app unmounted to a blank
 * screen with the camera off.
 *
 * Runs the hook with the app's real tRPC React client and query client
 * (`mutations.retry: 1`, as on the device); only the network and the SQLite
 * queue are swapped for in-memory stand-ins.
 *
 * No JSX: this file runs in the `unit` project (classic runtime).
 */
import { createElement, useState, type ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { AppRouter } from "@th/trpc";

/**
 * The queue, in memory. Same contract as `local-db.ts`: a row is due once
 * `nextAttemptAt <= now`, and a bump records the attempt.
 *
 * `passes` counts the reads of due rows, one per flush pass. The circuit
 * breaker is the test's, not the app's: past `ceiling` passes the read comes
 * back empty, which ends a runaway loop so a failing run finishes and prints
 * its numbers instead of filling the heap (unbounded, the old hook passed
 * 1 GB in a minute here and 4 GB in three).
 */
const queue = vi.hoisted(() => ({
  passes: 0,
  ceiling: 200,
  rows: [] as Array<{
    queueId: string;
    eventId: string;
    ticketCode: string;
    clientKey: string;
    enqueuedAt: number;
    attempts: number;
    lastError: string | null;
    nextAttemptAt: number;
  }>,
}));
vi.mock("./local-db", () => ({
  enqueueScan: vi.fn(),
  listDueQueuedScans: (now: number) => {
    queue.passes += 1;
    if (queue.passes > queue.ceiling) return [];
    return queue.rows
      .filter((r) => r.nextAttemptAt <= now)
      .map((r) => ({ ...r }));
  },
  isScanQueued: (queueId: string) =>
    queue.rows.some((r) => r.queueId === queueId),
  removeQueuedScan: (queueId: string) => {
    queue.rows = queue.rows.filter((r) => r.queueId !== queueId);
  },
  bumpQueuedScan: (queueId: string, error: string, nextAttemptAt: number) => {
    const row = queue.rows.find((r) => r.queueId === queueId);
    if (!row) return;
    row.attempts += 1;
    row.lastError = error;
    row.nextAttemptAt = nextAttemptAt;
  },
  countQueuedScans: () => queue.rows.length,
  countDroppedScans: () => 0,
  recordDroppedScan: vi.fn(),
}));

/**
 * Connected by default, as the phone believed it was while the API was
 * unreachable.
 */
const net = vi.hoisted(() => ({ state: "online" as "online" | "offline" }));
vi.mock("../features/network/use-network-state", () => ({
  useNetworkState: () => net.state,
}));

vi.mock("@sentry/react-native", () => ({
  captureException: vi.fn(),
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

(globalThis as { __DEV__?: boolean }).__DEV__ = false;

import { createQueryClient } from "../query-client";
import { trpc } from "../trpc";
import { useScanQueue } from "./use-scan-queue";

/**
 * How long a request hangs before failing. The phone's took 554–668 ms; the
 * loop does not depend on the figure, only on the send still being in flight
 * when the hook re-renders.
 */
const LATENCY_MS = 300;

/** Every `scanTicket` request fails like the phone's: no response at all. */
const unreachableApi: TRPCLink<AppRouter> =
  () =>
  ({ op }) =>
    observable((observer) => {
      if (op.path === "tickets.scanTicket") sends += 1;
      const id = setTimeout(
        () =>
          observer.error(
            TRPCClientError.from(new TypeError("Network request failed")),
          ),
        LATENCY_MS,
      );
      return () => clearTimeout(id);
    });

let sends = 0;
let queryClient: QueryClient;
const wrapper = ({ children }: { children?: ReactNode }) => {
  const [client] = useState(() =>
    trpc.createClient({ links: [unreachableApi] }),
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

let consoleError: ReturnType<typeof vi.spyOn>;
const updateDepthErrors = () =>
  consoleError.mock.calls.filter(([first]) =>
    /Maximum update depth exceeded/.test(String(first)),
  );

beforeEach(() => {
  sends = 0;
  queue.passes = 0;
  net.state = "online";
  // The admit from the incident: the screen's own send failed, so it queued.
  queue.rows = [
    {
      queueId: "q-1",
      eventId: "evt-1",
      ticketCode: "tk_door",
      clientKey: "unified-scan-evt-1-human-1",
      enqueuedAt: Date.now(),
      attempts: 0,
      lastError: null,
      nextAttemptAt: Date.now(),
    },
  ];
  queryClient = createQueryClient();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  consoleError.mockRestore();
});

/**
 * Real time, in short `act` steps so React renders between them. Fake timers
 * do not work here: the runaway loop schedules a new timer on every turn, so
 * one `advanceTimersByTimeAsync` call never reaches its end and a failing run
 * hangs instead of failing.
 */
const runFor = async (ms: number) => {
  for (let waited = 0; waited < ms; waited += 50) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }
};

it("a queued admit against an unreachable API is sent once per pass, and the app keeps rendering", async () => {
  renderHook(() => useScanQueue(true), { wrapper });

  // Well past the failed answer, and short of the 15 s interval that
  // legitimately starts the next pass.
  await runFor(LATENCY_MS * 4);

  expect(updateDepthErrors()).toEqual([]);
  expect({ passes: queue.passes, sends }).toEqual({ passes: 1, sends: 1 });
  // The pass parked the row on the network failure; the next interval tries
  // it again.
  expect(queue.rows).toHaveLength(1);
  expect(queue.rows[0]?.attempts).toBe(1);
});

it("a row queued while offline is sent once when the network comes back", async () => {
  net.state = "offline";
  const { rerender } = renderHook(() => useScanQueue(true), { wrapper });
  await runFor(LATENCY_MS);
  expect(sends).toBe(0);

  net.state = "online";
  rerender();
  await runFor(LATENCY_MS * 4);

  expect(updateDepthErrors()).toEqual([]);
  expect({ passes: queue.passes, sends }).toEqual({ passes: 1, sends: 1 });
});
