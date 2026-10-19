import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { RsvpNoticeRecord } from "@th/ports/repos/rsvp-notices";

import {
  dispatchRsvpNotifications,
  type DispatchRsvpNotificationsDeps,
} from "../dispatch-rsvp-notifications";
import { EVENT_ID, makeCommunityEvent } from "./helpers";

/**
 * The write-triggered drain loops until the outbox is empty, stops on the
 * first pass with a failed send, honours `freshOnly`, and hands off
 * (`hasMore`) when a bound stops it with work left. The fake outbox HONOURS
 * `limit` and `freshOnly` like the SQL does (oldest first).
 */

const NOW = new Date("2026-09-30T12:00:00.000Z");

function notice(i: number, over: Partial<RsvpNoticeRecord> = {}): RsvpNoticeRecord {
  return {
    id: `n-${i}`,
    eventId: EVENT_ID,
    eventDateId: null,
    humanId: `h-${i}`,
    kind: "CONFIRMATION",
    createdAt: new Date(NOW.getTime() - (100 - i) * 1000),
    dispatchedAt: null,
    attempts: 0,
    ...over,
  };
}

function makeDeps(args: {
  notices: RsvpNoticeRecord[];
  notify?: DispatchRsvpNotificationsDeps["notify"];
  clock?: ClockPort;
}) {
  const outbox = args.notices;
  const rsvpNotices = {
    listUndispatched: vi.fn(
      async (input: { limit: number; freshOnly?: boolean }) =>
        outbox
          .filter((n) => n.dispatchedAt === null)
          .filter((n) => !input.freshOnly || n.attempts === 0)
          .slice(0, input.limit)
          .map((n) => ({ ...n })),
    ),
    markDispatched: vi.fn(async (ids: string[], at: Date) => {
      for (const n of outbox) if (ids.includes(n.id)) n.dispatchedAt = at;
    }),
    incrementAttempts: vi.fn(async (ids: string[]) => {
      for (const n of outbox) if (ids.includes(n.id)) n.attempts += 1;
    }),
  };
  const notify = args.notify ?? vi.fn(async () => ({ ok: true }));
  const logger = {
    child: vi.fn(() => logger),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
    withTime: vi.fn(),
  };
  const deps: DispatchRsvpNotificationsDeps = {
    repos: {
      rsvpNotices,
      events: { getById: vi.fn(async () => makeCommunityEvent()) },
      eventRsvps: { existsForUser: vi.fn(async () => true) },
      eventDates: { getById: vi.fn(async () => null) },
      eventDateRsvps: { existsForUser: vi.fn(async () => true) },
      places: { getById: vi.fn(async () => null) },
    } as unknown as DispatchRsvpNotificationsDeps["repos"],
    notify,
    clock: args.clock ?? { now: () => NOW },
    appBaseUrl: "https://ithasfire.com",
    logger: logger as unknown as DispatchRsvpNotificationsDeps["logger"],
  };
  return { deps, rsvpNotices, notify, outbox };
}

describe("dispatchRsvpNotifications — drain loop", () => {
  it("drains a backlog bigger than one batch in ONE run", async () => {
    const { deps, outbox, rsvpNotices } = makeDeps({
      notices: Array.from({ length: 7 }, (_, i) => notice(i)),
    });

    const out = await dispatchRsvpNotifications(deps, { batchLimit: 3 });

    expect(out).toMatchObject({ processed: 7, dispatched: 7, passes: 3, hasMore: false });
    expect(outbox.every((n) => n.dispatchedAt !== null)).toBe(true);
    expect(rsvpNotices.listUndispatched).toHaveBeenCalledTimes(3);
  });

  it("stops at the first pass with a failed send and leaves the rest for the next run", async () => {
    // Pass 1 holds n-0..n-2; n-1's send fails (mail outage).
    const notify = vi.fn(async (input: { humanId: string }) => {
      if (input.humanId === "h-1") throw new Error("smtp down");
      return { ok: true };
    });
    const { deps, outbox } = makeDeps({
      notices: Array.from({ length: 7 }, (_, i) => notice(i)),
      notify,
    });

    const out = await dispatchRsvpNotifications(deps, { batchLimit: 3 });

    expect(out).toMatchObject({ passes: 1, hasMore: false, dispatched: 2 });
    // The failed one was charged an attempt, NOT retried back to back.
    expect(outbox.find((n) => n.id === "n-1")).toMatchObject({ attempts: 1, dispatchedAt: null });
    expect(notify).toHaveBeenCalledTimes(3);
    // Later notices are untouched, still queued.
    expect(outbox.filter((n) => n.dispatchedAt === null).map((n) => n.id)).toEqual([
      "n-1", "n-3", "n-4", "n-5", "n-6",
    ]);
  });

  it("freshOnly (the write-triggered run) never re-sends an already-attempted notice", async () => {
    const notify = vi.fn(async () => ({ ok: true }));
    const { deps, rsvpNotices, outbox } = makeDeps({
      notices: [notice(0, { attempts: 2 }), notice(1)],
      notify,
    });

    const out = await dispatchRsvpNotifications(deps, { freshOnly: true });

    expect(rsvpNotices.listUndispatched).toHaveBeenCalledWith({ limit: 50, freshOnly: true });
    expect(out.dispatched).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
    // The retry waits for the scheduled (retry-including) run.
    expect(outbox[0]).toMatchObject({ dispatchedAt: null, attempts: 2 });

    const scheduled = await dispatchRsvpNotifications(deps, {});
    expect(rsvpNotices.listUndispatched).toHaveBeenLastCalledWith({ limit: 50 });
    expect(scheduled.dispatched).toBe(1);
  });

  it("hands off (hasMore) when it stops on maxPasses with the queue still full", async () => {
    const { deps, outbox } = makeDeps({
      notices: Array.from({ length: 10 }, (_, i) => notice(i)),
    });

    const out = await dispatchRsvpNotifications(deps, { batchLimit: 2, maxPasses: 2 });

    expect(out).toMatchObject({ passes: 2, hasMore: true, dispatched: 4 });
    expect(outbox.filter((n) => n.dispatchedAt === null)).toHaveLength(6);
  });

  it("hands off (hasMore) when it stops on the wall-clock budget", async () => {
    let t = NOW.getTime();
    const clock: ClockPort = {
      now: vi.fn(() => {
        t += 40_000; // every clock read costs 40s of "work"
        return new Date(t);
      }),
    };
    const { deps } = makeDeps({
      notices: Array.from({ length: 10 }, (_, i) => notice(i)),
      clock,
    });

    const out = await dispatchRsvpNotifications(deps, {
      batchLimit: 2,
      timeBudgetMs: 60_000,
    });

    expect(out.hasMore).toBe(true);
    expect(out.passes).toBeLessThan(5);
  });
});

describe("dispatchRsvpNotifications — a notice that throws outside the send", () => {
  it("is charged an attempt and reported, so it stops being 'fresh' and cannot head every triggered run", async () => {
    const { deps, outbox, rsvpNotices } = makeDeps({ notices: [notice(0), notice(1)] });
    const reportError = vi.fn();
    deps.reportError = reportError;
    // The first notice's event read throws — outside the send path.
    (deps.repos.events.getById as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("poisoned row"),
    );

    const out = await dispatchRsvpNotifications(deps, { freshOnly: true });

    expect(outbox[0]).toMatchObject({ attempts: 1, dispatchedAt: null });
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "poisoned row" }),
      expect.objectContaining({
        tags: { area: "rsvp-notices", reason: "notice-unhandled" },
      }),
    );
    expect(out.dispatched).toBe(1);

    // The next write-triggered run no longer sees it.
    const fresh = await rsvpNotices.listUndispatched({ limit: 50, freshOnly: true });
    expect(fresh.map((n) => n.id)).not.toContain("n-0");
  });

  it("dead-letters a notice that keeps throwing at maxAttempts", async () => {
    const { deps, outbox } = makeDeps({ notices: [notice(0, { attempts: 4 })] });
    (deps.repos.events.getById as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("still poisoned"),
    );

    const out = await dispatchRsvpNotifications(deps, { maxAttempts: 5 });

    expect(out.deadLettered).toBe(1);
    expect(outbox[0]!.dispatchedAt).not.toBeNull();
  });

  it("a failing bookkeeping write is reported and never aborts the batch", async () => {
    const { deps, rsvpNotices } = makeDeps({ notices: [notice(0), notice(1)] });
    const reportError = vi.fn();
    deps.reportError = reportError;
    let calls = 0;
    (deps.repos.events.getById as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error("read failed");
      return makeCommunityEvent();
    });
    rsvpNotices.incrementAttempts.mockRejectedValueOnce(new Error("db gone"));

    const out = await dispatchRsvpNotifications(deps, {});

    expect(out.dispatched).toBe(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "db gone" }),
      expect.objectContaining({
        tags: { area: "rsvp-notices", reason: "unhandled-bookkeeping-failed" },
      }),
    );
  });
});

describe("dispatchRsvpNotifications — time budget inside a pass", () => {
  it("stops mid-batch when the budget is spent, leaves the rest queued untouched, and hands off", async () => {
    let t = NOW.getTime();
    const notify = vi.fn(async () => {
      t += 20_000; // each send takes 20s
      return { ok: true };
    });
    const { deps, outbox } = makeDeps({
      notices: Array.from({ length: 10 }, (_, i) => notice(i)),
      notify,
      clock: { now: () => new Date(t) },
    });

    const out = await dispatchRsvpNotifications(deps, { timeBudgetMs: 60_000 });

    expect(out).toMatchObject({ passes: 1, hasMore: true, dispatched: 3 });
    expect(outbox.filter((n) => n.dispatchedAt === null)).toHaveLength(7);
    expect(outbox.every((n) => n.attempts === 0)).toBe(true);
  });
});
