import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { EventChangeNoticeRecord } from "@th/ports/repos/event-change-notices";

import {
  dispatchEventChangeNotifications,
  type DispatchEventChangeNotificationsDeps,
} from "../dispatch-event-change-notifications";

// B2 (account squatting through guest checkout, owner ruling 2026-10-16): an
// unverified account may be someone else's, with their tickets attached by
// email. Event-change notices still go to every recipient's INBOX, but
// in-app, push and SMS go only to accounts that proved theirs.

const NOW = new Date("2026-07-04T12:00:00.000Z");
const EVENT_ID = "11111111-1111-1111-1111-111111111111";
const VERIFIED = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const UNVERIFIED = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const EMAIL_ONLY = {
  inApp: { enabled: false },
  push: { enabled: false },
  sms: { enabled: false },
};

function notice(): EventChangeNoticeRecord {
  return {
    id: "notice-1",
    eventId: EVENT_ID,
    changeType: "CANCELLED",
    payload: {
      eventTitle: "Show",
      startsAt: "2026-08-01T20:00:00.000Z",
      buyers: [],
    },
    createdAt: new Date("2026-07-04T11:00:00.000Z"),
    dispatchedAt: null,
    attempts: 0,
    notifiedHumanIds: [],
  } as EventChangeNoticeRecord;
}

function createDeps(args: {
  verifiedIds?: string[];
  verifiedLookupError?: Error;
  reportError?: ReturnType<typeof vi.fn>;
}) {
  const outbox = [notice()];
  // Lease-aware in-memory outbox: every claim and renew succeeds.
  // `listUndispatched` serves the pre-lease drain, `claimUndispatched` the
  // leased one.
  const eventChangeNotices = {
    listUndispatched: vi.fn(async () =>
      outbox.filter((n) => n.dispatchedAt === null),
    ),
    claimUndispatched: vi.fn(async () =>
      outbox.filter((n) => n.dispatchedAt === null),
    ),
    renewLease: vi.fn(
      async (id: string, _t: string, _n: Date, _u: Date, ids: string[]) => {
        const n = outbox.find((x) => x.id === id)!;
        n.notifiedHumanIds = [...new Set([...n.notifiedHumanIds, ...ids])];
        return true;
      },
    ),
    markNotified: vi.fn(async (id: string, ids: string[]) => {
      const n = outbox.find((x) => x.id === id)!;
      n.notifiedHumanIds = [...new Set([...n.notifiedHumanIds, ...ids])];
    }),
    markDispatched: vi.fn(async (ids: string[], at: Date) => {
      for (const n of outbox) if (ids.includes(n.id)) n.dispatchedAt = at;
    }),
    incrementAttempts: vi.fn(async () => {}),
    releaseLeases: vi.fn(async () => {}),
  };
  const pager = (ids: string[]) =>
    vi.fn(async () => ({ items: ids, nextCursor: null }));
  const humans = {
    listEmailVerifiedIds: vi.fn(async (ids: string[]) => {
      if (args.verifiedLookupError) throw args.verifiedLookupError;
      const verified = new Set(args.verifiedIds ?? []);
      return ids.filter((id) => verified.has(id));
    }),
  };
  const notify = vi.fn(async (_input: Record<string, unknown>) => ({
    ok: true,
  }));
  const logger = {
    child: vi.fn(() => logger),
    withTime: vi.fn(),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const clock: ClockPort = { now: vi.fn(() => NOW) };
  const deps: DispatchEventChangeNotificationsDeps = {
    repos: {
      eventChangeNotices,
      eventSaves: { listHumanIdsForEvent: pager([VERIFIED]) },
      eventRsvps: { listHumanIdsForEvent: pager([UNVERIFIED]) },
      events: {
        getById: vi.fn(async () => ({ id: EVENT_ID, slug: "o/us/g/s--ab" })),
      },
      humans,
    } as unknown as DispatchEventChangeNotificationsDeps["repos"],
    notify,
    clock,
    logger: logger as unknown as DispatchEventChangeNotificationsDeps["logger"],
    appBaseUrl: "https://ithasfire.com",
    reportError: args.reportError,
  };
  return { deps, notify, humans, logger, outbox };
}

const callFor = (notify: ReturnType<typeof vi.fn>, humanId: string) =>
  notify.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .find((c) => c.humanId === humanId);

describe("dispatchEventChangeNotifications: verified recipients only for in-app and push (B2)", () => {
  it("sends a verified recipient on every channel and an unverified one email only", async () => {
    const { deps, notify, humans, outbox } = createDeps({
      verifiedIds: [VERIFIED],
    });

    const result = await dispatchEventChangeNotifications(deps, {});

    expect(humans.listEmailVerifiedIds).toHaveBeenCalledWith(
      expect.arrayContaining([VERIFIED, UNVERIFIED]),
    );
    expect(callFor(notify, VERIFIED)).toBeDefined();
    expect(callFor(notify, VERIFIED)!.channels).toBeUndefined();
    expect(callFor(notify, UNVERIFIED)!.channels).toEqual(EMAIL_ONLY);
    // The email-only send still counts as notified: the notice settles.
    expect(result.recipientsNotified).toBe(2);
    expect(outbox[0]!.dispatchedAt).toEqual(NOW);
  });

  it("a failed verified lookup sends everyone email only, logs ERROR and reports", async () => {
    const reportError = vi.fn();
    const { deps, notify, logger, outbox } = createDeps({
      verifiedIds: [VERIFIED],
      verifiedLookupError: new Error("db down"),
      reportError,
    });

    const result = await dispatchEventChangeNotifications(deps, {});

    expect(callFor(notify, VERIFIED)!.channels).toEqual(EMAIL_ONLY);
    expect(callFor(notify, UNVERIFIED)!.channels).toEqual(EMAIL_ONLY);
    expect(logger.error).toHaveBeenCalledWith(
      "events.dispatchEventChangeNotifications.verified_lookup_failed",
      expect.objectContaining({ noticeId: "notice-1", eventId: EVENT_ID }),
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ reason: "verified-lookup-failed" }),
      }),
    );
    // The emails went out, so the notice is not charged an attempt.
    expect(result.recipientsNotified).toBe(2);
    expect(outbox[0]!.dispatchedAt).toEqual(NOW);
  });

  it("a throwing reporter does not change the outcome", async () => {
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    const { deps, notify } = createDeps({
      verifiedLookupError: new Error("db down"),
      reportError,
    });

    const result = await dispatchEventChangeNotifications(deps, {});

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(result.recipientsNotified).toBe(2);
  });
});
