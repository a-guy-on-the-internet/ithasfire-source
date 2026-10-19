import { describe, expect, it, vi } from "vitest";

import type { EventChangeNoticeRecord } from "@th/ports/repos/event-change-notices";

import {
  dispatchEventChangeNotifications,
  MAX_RECIPIENTS_PER_NOTICE_PER_RUN,
  type DispatchEventChangeNotificationsDeps,
} from "../dispatch-event-change-notifications";

/**
 * Drain-loop behaviour of the event-change drain: a budget-capped fan-out
 * continues in the SAME run (it used to wait five minutes per 500
 * recipients), a failed send stops the loop, and `freshOnly` reaches the repo.
 */

const NOW = new Date("2026-09-30T12:00:00.000Z");

function notice(over: Partial<EventChangeNoticeRecord> = {}): EventChangeNoticeRecord {
  return {
    id: "notice-1",
    eventId: "11111111-1111-1111-1111-111111111111",
    changeType: "RESCHEDULED",
    payload: { eventTitle: "Show", newStartsAt: null, newEndsAt: null },
    createdAt: NOW,
    dispatchedAt: null,
    attempts: 0,
    notifiedHumanIds: [],
    ...over,
  };
}

function makeDeps(args: {
  notices: EventChangeNoticeRecord[];
  saverIds: string[];
  notify?: DispatchEventChangeNotificationsDeps["notify"];
}) {
  const outbox = args.notices;
  const eventChangeNotices = {
    listUndispatched: vi.fn(
      async (input: { limit: number; freshOnly?: boolean }) =>
        outbox
          .filter((n) => n.dispatchedAt === null)
          .filter((n) => !input.freshOnly || n.attempts === 0)
          .slice(0, input.limit)
          .map((n) => ({ ...n, notifiedHumanIds: [...n.notifiedHumanIds] })),
    ),
    markDispatched: vi.fn(async (ids: string[], at: Date) => {
      for (const n of outbox) if (ids.includes(n.id)) n.dispatchedAt = at;
    }),
    incrementAttempts: vi.fn(async (ids: string[]) => {
      for (const n of outbox) if (ids.includes(n.id)) n.attempts += 1;
    }),
    markNotified: vi.fn(async (id: string, humanIds: string[]) => {
      const n = outbox.find((x) => x.id === id);
      if (n) n.notifiedHumanIds = [...new Set([...n.notifiedHumanIds, ...humanIds])];
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
  const deps: DispatchEventChangeNotificationsDeps = {
    repos: {
      eventChangeNotices,
      eventSaves: {
        listHumanIdsForEvent: vi.fn(async () => ({ items: args.saverIds, nextCursor: null })),
      },
      eventRsvps: {
        listHumanIdsForEvent: vi.fn(async () => ({ items: [], nextCursor: null })),
      },
      events: { getById: vi.fn(async () => ({ id: "e", slug: "org/us/x/show--ab" })) },
      // B2: every recipient verified, so in-app and push go out as before.
      humans: { listEmailVerifiedIds: vi.fn(async (ids: string[]) => ids) },
    } as unknown as DispatchEventChangeNotificationsDeps["repos"],
    notify,
    clock: { now: () => NOW },
    logger: logger as unknown as DispatchEventChangeNotificationsDeps["logger"],
    appBaseUrl: "https://ithasfire.com",
  };
  return { deps, eventChangeNotices, notify, outbox };
}

describe("dispatchEventChangeNotifications — drain loop", () => {
  it("continues a budget-capped fan-out in the same run and dispatches it", async () => {
    const audience = Array.from(
      { length: MAX_RECIPIENTS_PER_NOTICE_PER_RUN * 2 + 10 },
      (_, i) => `saver-${i}`,
    );
    const { deps, notify, outbox } = makeDeps({ notices: [notice()], saverIds: audience });

    const out = await dispatchEventChangeNotifications(deps, {});

    expect(out).toMatchObject({ dispatched: 1, passes: 3, hasMore: false });
    expect(outbox[0]!.dispatchedAt).toEqual(NOW);
    // Everyone exactly once across the passes.
    const ids = notify.mock.calls.map((c) => (c[0] as { humanId: string }).humanId);
    expect(ids).toHaveLength(audience.length);
    expect(new Set(ids).size).toBe(audience.length);
  });

  it("does not loop on a capped notice whose pass had failed sends (no back-to-back re-sends)", async () => {
    const audience = Array.from(
      { length: MAX_RECIPIENTS_PER_NOTICE_PER_RUN + 10 },
      (_, i) => `saver-${i}`,
    );
    const notify = vi.fn(async (input: { humanId: string }) => {
      if (input.humanId === "saver-3") throw new Error("smtp 451");
      return { ok: true };
    });
    const { deps } = makeDeps({ notices: [notice()], saverIds: audience, notify });

    const out = await dispatchEventChangeNotifications(deps, {});

    expect(out.passes).toBe(1);
    expect(out.hasMore).toBe(false);
    expect(notify).toHaveBeenCalledTimes(MAX_RECIPIENTS_PER_NOTICE_PER_RUN);
  });

  it("passes freshOnly to the outbox read on a write-triggered run", async () => {
    const { deps, eventChangeNotices } = makeDeps({
      notices: [notice({ id: "old", attempts: 3 }), notice({ id: "new" })],
      saverIds: ["s1"],
    });

    const out = await dispatchEventChangeNotifications(deps, { freshOnly: true });

    expect(eventChangeNotices.listUndispatched).toHaveBeenCalledWith({
      limit: 50,
      freshOnly: true,
    });
    expect(out.processed).toBe(1);
  });
});

describe("dispatchEventChangeNotifications — a notice that throws outside the recipient guard", () => {
  it("is charged an attempt and reported, so it stops being 'fresh'", async () => {
    const { deps, outbox, eventChangeNotices } = makeDeps({
      notices: [notice()],
      saverIds: ["s1"],
    });
    const reportError = vi.fn();
    deps.reportError = reportError;
    (
      deps.repos.eventSaves.listHumanIdsForEvent as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("audience read failed"));

    const out = await dispatchEventChangeNotifications(deps, { freshOnly: true });

    expect(out.passes).toBe(1);
    expect(outbox[0]).toMatchObject({ attempts: 1, dispatchedAt: null });
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "audience read failed" }),
      expect.objectContaining({
        tags: { area: "event-change-notices", reason: "notice-unhandled" },
      }),
    );
    const fresh = await eventChangeNotices.listUndispatched({ limit: 50, freshOnly: true });
    expect(fresh).toHaveLength(0);
  });

  it("dead-letters a notice that keeps throwing at maxAttempts", async () => {
    const { deps, outbox } = makeDeps({
      notices: [notice({ attempts: 4 })],
      saverIds: ["s1"],
    });
    (
      deps.repos.eventSaves.listHumanIdsForEvent as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error("still failing"));

    const out = await dispatchEventChangeNotifications(deps, { maxAttempts: 5 });

    expect(out.deadLettered).toBe(1);
    expect(outbox[0]!.dispatchedAt).not.toBeNull();
  });
});

describe("dispatchEventChangeNotifications — time budget inside a fan-out", () => {
  it("stops a fan-out mid-notice when the budget is spent: progress kept, no attempt charged, hands off", async () => {
    const audience = Array.from({ length: 200 }, (_, i) => `saver-${i}`);
    const { deps, notify, outbox, eventChangeNotices } = makeDeps({
      notices: [notice()],
      saverIds: audience,
    });
    // Each send costs one second of wall clock; the budget is 60s.
    let t = NOW.getTime();
    deps.clock = { now: () => new Date(t) };
    (notify as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      t += 1000;
      return { ok: true };
    });

    const out = await dispatchEventChangeNotifications(deps, { timeBudgetMs: 60_000 });

    expect(notify.mock.calls.length).toBeGreaterThanOrEqual(60);
    expect(notify.mock.calls.length).toBeLessThan(62);
    expect(out).toMatchObject({ dispatched: 0, deadLettered: 0, hasMore: true });
    expect(eventChangeNotices.incrementAttempts).not.toHaveBeenCalled();
    // Everyone actually sent to is persisted, so the next run skips them.
    expect(outbox[0]!.notifiedHumanIds).toHaveLength(notify.mock.calls.length);
  });
});
