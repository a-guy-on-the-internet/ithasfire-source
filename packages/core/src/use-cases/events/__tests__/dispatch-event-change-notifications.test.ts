import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { EventChangeNoticeRecord } from "@th/ports/repos/event-change-notices";

import { renderNotification } from "../../comms/renderers";
import {
  dispatchEventChangeNotifications,
  MARK_NOTIFIED_CHUNK,
  MAX_RECIPIENTS_PER_NOTICE_PER_RUN,
  type DispatchEventChangeNotificationsDeps,
} from "../dispatch-event-change-notifications";

const NOW = new Date("2026-07-04T12:00:00.000Z");
const EVENT_ID = "11111111-1111-1111-1111-111111111111";

function buildNotice(
  overrides: Partial<EventChangeNoticeRecord> = {},
): EventChangeNoticeRecord {
  return {
    id: "notice-1",
    eventId: EVENT_ID,
    changeType: "CANCELLED",
    payload: {},
    createdAt: new Date("2026-07-04T11:00:00.000Z"),
    dispatchedAt: null,
    attempts: 0,
    notifiedHumanIds: [],
    ...overrides,
  };
}

/**
 * Builds a keyset `listHumanIdsForEvent` that returns every id in one page
 * (nextCursor null), which is enough to exercise the union/dedupe path.
 */
function idListPager(ids: string[]) {
  return vi.fn(async () => ({ items: ids, nextCursor: null }));
}

const EVENT_SLUG = "org-slug/us/general/sunset-sessions--ab12cd";
const APP_BASE_URL = "https://ithasfire.com";

function createDeps(args: {
  notices: EventChangeNoticeRecord[];
  saverIds?: string[];
  rsvpIds?: string[];
  notify?: DispatchEventChangeNotificationsDeps["notify"];
  /** Event returned by the link lookup; `null` = vanished. */
  event?: { slug: string | null; timezone?: string; status?: string } | null;
  /** When set, the link lookup throws this. */
  eventLookupError?: Error;
  appBaseUrl?: string | null;
  reportError?: ReturnType<typeof vi.fn>;
}) {
  // Stateful in-memory outbox so a test can run the drain TWICE against the
  // same notices and observe durable per-recipient dedup (`notifiedHumanIds`)
  // + dispatch flip across ticks. Spies still record every call.
  const outbox = args.notices;
  const eventChangeNotices = {
    create: vi.fn(),
    listUndispatched: vi.fn(async () =>
      outbox.filter((n) => n.dispatchedAt === null),
    ),
    markDispatched: vi.fn(async (ids: string[], at: Date) => {
      for (const n of outbox) if (ids.includes(n.id)) n.dispatchedAt = at;
    }),
    incrementAttempts: vi.fn(async (ids: string[]) => {
      for (const n of outbox) if (ids.includes(n.id)) n.attempts += 1;
    }),
    markNotified: vi.fn(async (id: string, humanIds: string[]) => {
      const n = outbox.find((x) => x.id === id);
      if (n) {
        n.notifiedHumanIds = [
          ...new Set([...n.notifiedHumanIds, ...humanIds]),
        ];
      }
    }),
  };
  const eventSaves = {
    listHumanIdsForEvent: idListPager(args.saverIds ?? []),
  };
  const eventRsvps = {
    listHumanIdsForEvent: idListPager(args.rsvpIds ?? []),
  };
  const events = {
    getById: vi.fn(async () => {
      if (args.eventLookupError) throw args.eventLookupError;
      return "event" in args
        ? args.event
        : { id: "e1", slug: EVENT_SLUG, status: "CANCELLED" };
    }),
  };
  const notify = args.notify ?? vi.fn(async () => ({ ok: true }));
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
      eventSaves,
      eventRsvps,
      events,
      // B2: every recipient verified, so in-app and push go out as before
      // (the unverified split is covered in the `-verified` test file).
      humans: { listEmailVerifiedIds: vi.fn(async (ids: string[]) => ids) },
    } as unknown as DispatchEventChangeNotificationsDeps["repos"],
    notify,
    clock,
    logger: logger as unknown as DispatchEventChangeNotificationsDeps["logger"],
    appBaseUrl: "appBaseUrl" in args ? args.appBaseUrl : APP_BASE_URL,
    reportError: args.reportError,
  };

  return {
    deps,
    mocks: { eventChangeNotices, eventSaves, eventRsvps, notify, events, logger },
  };
}

const BUYER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SAVER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const RSVPER = "cccccccc-cccc-cccc-cccc-cccccccccccc";

describe("dispatchEventChangeNotifications", () => {
  it("no-ops on an empty outbox", async () => {
    const { deps, mocks } = createDeps({ notices: [] });

    const result = await dispatchEventChangeNotifications(deps, {});

    expect(result).toEqual({
      processed: 0,
      dispatched: 0,
      deadLettered: 0,
      recipientsNotified: 0,
      passes: 1,
      hasMore: false,
    });
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(mocks.eventChangeNotices.markDispatched).not.toHaveBeenCalled();
  });

  it("CANCELLED: money-aware payload to buyers, refund:null to savers/RSVPers, no double-notify", async () => {
    const notice = buildNotice({
      id: "notice-cancel",
      changeType: "CANCELLED",
      payload: {
        eventTitle: "Doomed Show",
        startsAt: "2026-08-01T20:00:00.000Z",
        buyers: [{ humanId: BUYER, refundedCents: 4500, currency: "usd" }],
      },
    });
    // BUYER is ALSO a saver — must not be notified twice.
    const { deps, mocks } = createDeps({
      notices: [notice],
      saverIds: [SAVER, BUYER],
      rsvpIds: [RSVPER],
    });

    const result = await dispatchEventChangeNotifications(deps, {});

    // 1 buyer + 2 non-buyer watchers (SAVER, RSVPER). BUYER-as-saver deduped.
    expect(result.recipientsNotified).toBe(3);
    expect(result.dispatched).toBe(1);
    expect(mocks.notify).toHaveBeenCalledTimes(3);

    const calls = mocks.notify.mock.calls.map((c) => c[0]);
    const buyerCall = calls.find((c) => c.humanId === BUYER);
    expect(buyerCall).toMatchObject({
      variant: "event.cancelled",
      idempotencyKey: "event-change:notice-cancel:" + BUYER,
      payload: {
        eventId: EVENT_ID,
        eventTitle: "Doomed Show",
        startsAt: "2026-08-01T20:00:00.000Z",
        refund: { status: "refunded", amountCents: 4500, currency: "usd" },
      },
    });

    const saverCall = calls.find((c) => c.humanId === SAVER);
    expect(saverCall).toMatchObject({
      variant: "event.cancelled",
      payload: { eventId: EVENT_ID, refund: null },
    });

    // BUYER notified exactly once (money-aware), never with refund:null.
    const buyerCalls = calls.filter((c) => c.humanId === BUYER);
    expect(buyerCalls).toHaveLength(1);

    expect(mocks.eventChangeNotices.markDispatched).toHaveBeenCalledWith(
      ["notice-cancel"],
      NOW,
    );
    expect(mocks.eventChangeNotices.incrementAttempts).not.toHaveBeenCalled();
  });

  // Owner ruling 2026-10-11: a ticket that cost $0 refunds $0. A cancellation
  // returns such a ticket with no money moved, and its buyer is listed with
  // `refundedCents: 0`. "You've been refunded $0.00" would be false, so they
  // get the plain cancellation, once.
  it("CANCELLED: a buyer whose refunds total $0 gets the plain cancellation, not a refund notice", async () => {
    const notice = buildNotice({
      id: "notice-cancel-zero",
      changeType: "CANCELLED",
      payload: {
        eventTitle: "Doomed Show",
        startsAt: "2026-08-01T20:00:00.000Z",
        buyers: [{ humanId: BUYER, refundedCents: 0, currency: "usd" }],
      },
    });
    // BUYER is ALSO a saver: still exactly one notification.
    const { deps, mocks } = createDeps({
      notices: [notice],
      saverIds: [BUYER],
      rsvpIds: [],
    });

    const result = await dispatchEventChangeNotifications(deps, {});

    expect(result.recipientsNotified).toBe(1);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    const call = mocks.notify.mock.calls[0]![0];
    expect(call).toMatchObject({
      humanId: BUYER,
      variant: "event.cancelled",
      idempotencyKey: "event-change:notice-cancel-zero:" + BUYER,
    });
    expect(call.payload.refund).toBeNull();
  });

  // Review round 2 (BLOCKING): a $0 entry must not hide a failed paid refund.
  it("CANCELLED: a $0 buyer whose other refund FAILED gets 'refund in progress', once", async () => {
    const notice = buildNotice({
      id: "notice-cancel-zero-pending",
      changeType: "CANCELLED",
      payload: {
        eventTitle: "Doomed Show",
        startsAt: "2026-08-01T20:00:00.000Z",
        buyers: [{ humanId: BUYER, refundedCents: 0, currency: "usd" }],
        pendingRefundBuyerHumanIds: [BUYER],
      },
    });
    const { deps, mocks } = createDeps({
      notices: [notice],
      saverIds: [BUYER],
      rsvpIds: [],
    });

    const result = await dispatchEventChangeNotifications(deps, {});

    expect(result.recipientsNotified).toBe(1);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify.mock.calls[0]![0]).toMatchObject({
      humanId: BUYER,
      variant: "event.cancelled",
      payload: { refund: { status: "pending" } },
    });
  });

  it("CANCELLED: a buyer with a $0 order and a refunded paid order gets the refund notice for the paid amount", async () => {
    // cancel-event sums a buyer's orders into one entry: 0 + 4205.
    const notice = buildNotice({
      id: "notice-cancel-zero-plus-paid",
      changeType: "CANCELLED",
      payload: {
        eventTitle: "Doomed Show",
        startsAt: "2026-08-01T20:00:00.000Z",
        buyers: [{ humanId: BUYER, refundedCents: 4_205, currency: "usd" }],
        pendingRefundBuyerHumanIds: [],
      },
    });
    const { deps, mocks } = createDeps({
      notices: [notice],
      saverIds: [],
      rsvpIds: [],
    });

    await dispatchEventChangeNotifications(deps, {});

    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify.mock.calls[0]![0]).toMatchObject({
      humanId: BUYER,
      payload: {
        refund: { status: "refunded", amountCents: 4_205, currency: "usd" },
      },
    });
  });

  it("RESCHEDULED: event.changed to the union of savers and RSVPers (deduped)", async () => {
    const notice = buildNotice({
      id: "notice-resch",
      changeType: "RESCHEDULED",
      payload: {
        eventTitle: "Moved Show",
        newStartsAt: "2026-09-01T20:00:00.000Z",
        newEndsAt: "2026-09-01T23:00:00.000Z",
      },
    });
    // SAVER appears in BOTH lists — union must dedupe to 2 recipients.
    const { deps, mocks } = createDeps({
      notices: [notice],
      saverIds: [SAVER, RSVPER],
      rsvpIds: [SAVER],
    });

    const result = await dispatchEventChangeNotifications(deps, {});

    expect(result.recipientsNotified).toBe(2);
    expect(result.dispatched).toBe(1);

    const calls = mocks.notify.mock.calls.map((c) => c[0]);
    expect(calls.every((c) => c.variant === "event.changed")).toBe(true);
    expect(calls[0].payload).toMatchObject({
      eventId: EVENT_ID,
      eventTitle: "Moved Show",
      changeType: "RESCHEDULED",
      newStartsAt: "2026-09-01T20:00:00.000Z",
      newEndsAt: "2026-09-01T23:00:00.000Z",
    });
    expect(mocks.eventChangeNotices.markDispatched).toHaveBeenCalledWith(
      ["notice-resch"],
      NOW,
    );
  });

  it("ARCHIVED: event.unlisted to the union of savers and RSVPers (deduped), marked dispatched", async () => {
    const notice = buildNotice({
      id: "notice-arch",
      changeType: "ARCHIVED",
      payload: { eventTitle: "Shelved Show" },
    });
    // SAVER appears in BOTH lists — union must dedupe to 2 recipients. BUYER is
    // in neither: archive never fans out to buyers.
    const { deps, mocks } = createDeps({
      notices: [notice],
      saverIds: [SAVER, RSVPER],
      rsvpIds: [SAVER],
    });

    const result = await dispatchEventChangeNotifications(deps, {});

    expect(result.recipientsNotified).toBe(2);
    expect(result.dispatched).toBe(1);

    const calls = mocks.notify.mock.calls.map((c) => c[0]);
    expect(calls.every((c) => c.variant === "event.unlisted")).toBe(true);
    expect(calls.every((c) => c.humanId !== BUYER)).toBe(true);
    expect(calls[0].payload).toEqual({
      eventId: EVENT_ID,
      eventTitle: "Shelved Show",
    });
    expect(calls[0].idempotencyKey).toBe(
      `event-change:notice-arch:${calls[0].humanId}`,
    );
    expect(mocks.eventChangeNotices.markDispatched).toHaveBeenCalledWith(
      ["notice-arch"],
      NOW,
    );
  });

  it("UNPUBLISHED: event.unlisted to savers ∪ RSVPers, marked dispatched", async () => {
    const notice = buildNotice({
      id: "notice-unpub",
      changeType: "UNPUBLISHED",
      payload: { eventTitle: "Hidden Show" },
    });
    const { deps, mocks } = createDeps({
      notices: [notice],
      saverIds: [SAVER],
      rsvpIds: [RSVPER],
    });

    const result = await dispatchEventChangeNotifications(deps, {});

    expect(result.recipientsNotified).toBe(2);
    expect(result.dispatched).toBe(1);
    const calls = mocks.notify.mock.calls.map((c) => c[0]);
    expect(calls.every((c) => c.variant === "event.unlisted")).toBe(true);
    expect(mocks.eventChangeNotices.markDispatched).toHaveBeenCalledWith(
      ["notice-unpub"],
      NOW,
    );
  });

  it("one recipient throw does not abort the rest, but the notice is retried not dispatched", async () => {
    const notice = buildNotice({
      id: "notice-partial",
      changeType: "RESCHEDULED",
      payload: {
        eventTitle: "Flaky Show",
        newStartsAt: null,
        newEndsAt: null,
      },
    });
    const notify = vi.fn(async (input: { humanId: string }) => {
      if (input.humanId === SAVER) throw new Error("mailer exploded");
      return { ok: true };
    });
    const { deps, mocks } = createDeps({
      notices: [notice],
      saverIds: [SAVER],
      rsvpIds: [RSVPER],
      notify,
    });

    const result = await dispatchEventChangeNotifications(deps, {});

    // RSVPER still got notified despite SAVER blowing up.
    expect(result.recipientsNotified).toBe(1);
    expect(mocks.notify).toHaveBeenCalledTimes(2);
    // A partial fan-out is retried, NOT marked dispatched (re-run next tick).
    expect(result.dispatched).toBe(0);
    expect(result.deadLettered).toBe(0);
    expect(mocks.eventChangeNotices.incrementAttempts).toHaveBeenCalledWith([
      "notice-partial",
    ]);
    expect(mocks.eventChangeNotices.markDispatched).not.toHaveBeenCalled();
  });

  it("all recipients succeed → notice is marked dispatched", async () => {
    const notice = buildNotice({
      id: "notice-ok",
      changeType: "RESCHEDULED",
      payload: { eventTitle: "Good Show", newStartsAt: null, newEndsAt: null },
    });
    const { deps, mocks } = createDeps({
      notices: [notice],
      saverIds: [SAVER, RSVPER],
    });

    const result = await dispatchEventChangeNotifications(deps, {});

    expect(result.dispatched).toBe(1);
    expect(result.recipientsNotified).toBe(2);
    expect(mocks.eventChangeNotices.markDispatched).toHaveBeenCalledWith(
      ["notice-ok"],
      NOW,
    );
  });

  it("poisoned payload dead-letters at maxAttempts without throwing", async () => {
    // attempts already at 4; a parse failure bumps to 5 === maxAttempts → dead-letter.
    const notice = buildNotice({
      id: "notice-poison",
      changeType: "CANCELLED",
      attempts: 4,
      payload: { eventTitle: "Bad", startsAt: null, buyers: "not-an-array" },
    });
    const { deps, mocks } = createDeps({ notices: [notice] });

    const result = await dispatchEventChangeNotifications(deps, {
      maxAttempts: 5,
    });

    expect(result.processed).toBe(1);
    expect(result.deadLettered).toBe(1);
    expect(result.dispatched).toBe(0);
    expect(result.recipientsNotified).toBe(0);
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(mocks.eventChangeNotices.incrementAttempts).toHaveBeenCalledWith([
      "notice-poison",
    ]);
    expect(mocks.eventChangeNotices.markDispatched).toHaveBeenCalledWith(
      ["notice-poison"],
      NOW,
    );
  });

  it("partial failure retry: already-notified recipient is NOT re-notified; dispatched only after all succeed", async () => {
    // Two recipients (SAVER via saves, RSVPER via rsvps). On the FIRST run
    // RSVPER's notify throws once; on the SECOND run it succeeds.
    const notice = buildNotice({
      id: "notice-retry",
      changeType: "RESCHEDULED",
      payload: { eventTitle: "Retry Show", newStartsAt: null, newEndsAt: null },
    });
    let rsvperAttempts = 0;
    const notify = vi.fn(async (input: { humanId: string }) => {
      if (input.humanId === RSVPER) {
        rsvperAttempts += 1;
        if (rsvperAttempts === 1) throw new Error("mailer exploded");
      }
      return { ok: true };
    });
    const { deps, mocks } = createDeps({
      notices: [notice],
      saverIds: [SAVER],
      rsvpIds: [RSVPER],
      notify,
    });

    // ── Run 1: SAVER notified, RSVPER throws → NOT dispatched, retried ──
    const run1 = await dispatchEventChangeNotifications(deps, {});
    expect(run1.recipientsNotified).toBe(1); // SAVER only
    expect(run1.dispatched).toBe(0);
    expect(mocks.eventChangeNotices.markNotified).toHaveBeenCalledWith(
      "notice-retry",
      [SAVER],
    );
    expect(mocks.eventChangeNotices.markDispatched).not.toHaveBeenCalled();
    expect(mocks.eventChangeNotices.incrementAttempts).toHaveBeenCalledWith([
      "notice-retry",
    ]);

    // ── Run 2: only the previously-failing RSVPER is retried ──
    const run2 = await dispatchEventChangeNotifications(deps, {});
    expect(run2.recipientsNotified).toBe(1); // RSVPER only
    expect(run2.dispatched).toBe(1);

    // The second run's notify calls target RSVPER ONLY (SAVER not re-notified).
    const run2Calls = mocks.notify.mock.calls.slice(2).map((c) => c[0]);
    expect(run2Calls).toHaveLength(1);
    expect(run2Calls[0].humanId).toBe(RSVPER);
    expect(mocks.eventChangeNotices.markNotified).toHaveBeenCalledWith(
      "notice-retry",
      [RSVPER],
    );

    // SAVER notified EXACTLY once across both runs (durable dedup held).
    const saverCalls = mocks.notify.mock.calls.filter(
      (c) => c[0].humanId === SAVER,
    );
    expect(saverCalls).toHaveLength(1);

    // Dispatched only after the full audience is covered.
    expect(mocks.eventChangeNotices.markDispatched).toHaveBeenCalledWith(
      ["notice-retry"],
      NOW,
    );
  });

  it("CANCELLED: pendingRefundBuyerHumanIds get refund:pending copy, deduped against buyers/savers, savers get refund:null", async () => {
    const PENDING = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const notice = buildNotice({
      id: "notice-pending",
      changeType: "CANCELLED",
      payload: {
        eventTitle: "Stuck Show",
        startsAt: null,
        buyers: [{ humanId: BUYER, refundedCents: 1000, currency: "usd" }],
        // A failed-refund buyer who is ALSO a saver — must be notified once,
        // with the pending copy (buyer precedence over saver membership).
        pendingRefundBuyerHumanIds: [PENDING],
      },
    });
    const { deps, mocks } = createDeps({
      notices: [notice],
      saverIds: [SAVER, PENDING],
    });

    const result = await dispatchEventChangeNotifications(deps, {});

    // BUYER (refunded) + PENDING (refund:pending, deduped) + SAVER (refund:null) = 3.
    expect(result.recipientsNotified).toBe(3);
    const calls = mocks.notify.mock.calls.map((c) => c[0]);

    // Failed-refund buyer gets the distinct "refund in progress" payload.
    const pendingCall = calls.find((c) => c.humanId === PENDING);
    expect(pendingCall).toMatchObject({
      variant: "event.cancelled",
      payload: { eventId: EVENT_ID, refund: { status: "pending" } },
    });
    // Notified exactly once despite being both a pending-refund buyer + saver.
    expect(calls.filter((c) => c.humanId === PENDING)).toHaveLength(1);

    // Refunded buyer gets the money-aware payload.
    const buyerCall = calls.find((c) => c.humanId === BUYER);
    expect(buyerCall?.payload).toMatchObject({
      refund: { status: "refunded", amountCents: 1000, currency: "usd" },
    });

    // Plain saver still gets refund:null.
    const saverCall = calls.find((c) => c.humanId === SAVER);
    expect(saverCall).toMatchObject({
      variant: "event.cancelled",
      payload: { eventId: EVENT_ID, refund: null },
    });

    expect(result.dispatched).toBe(1);
  });

  it("budget cap: >MAX recipients partially processed, markNotified persisted incrementally, resumes next tick with no double-notify", async () => {
    const OVERFLOW = 100;
    const audience = Array.from(
      { length: MAX_RECIPIENTS_PER_NOTICE_PER_RUN + OVERFLOW },
      (_, i) => `saver-${i}`,
    );
    const notice = buildNotice({
      id: "notice-huge",
      changeType: "RESCHEDULED",
      payload: { eventTitle: "Huge Show", newStartsAt: null, newEndsAt: null },
    });
    const notify = vi.fn(async () => ({ ok: true }));
    const { deps, mocks } = createDeps({
      notices: [notice],
      saverIds: audience,
      notify,
    });

    // ── Run 1: only the per-run budget is processed; NOT dispatched, and the
    // budget cap is NOT treated as a failure. `maxPasses: 1` pins ONE pass —
    // by default the drain loop would resume the fan-out in its next pass
    // (see "continues a budget-capped fan-out in the same run" below). ──
    const run1 = await dispatchEventChangeNotifications(deps, { maxPasses: 1 });
    expect(run1.recipientsNotified).toBe(MAX_RECIPIENTS_PER_NOTICE_PER_RUN);
    expect(run1.dispatched).toBe(0);
    expect(run1.deadLettered).toBe(0);
    expect(mocks.eventChangeNotices.markDispatched).not.toHaveBeenCalled();
    expect(mocks.eventChangeNotices.incrementAttempts).not.toHaveBeenCalled();

    // Progress persisted incrementally in MARK_NOTIFIED_CHUNK-sized flushes,
    // NOT a single end-of-run write — so a killed run keeps its progress.
    const markCalls = mocks.eventChangeNotices.markNotified.mock.calls;
    expect(markCalls.length).toBe(
      MAX_RECIPIENTS_PER_NOTICE_PER_RUN / MARK_NOTIFIED_CHUNK,
    );
    expect(markCalls.every((c) => c[1].length === MARK_NOTIFIED_CHUNK)).toBe(
      true,
    );

    // Stopped on the pass bound with the fan-out unfinished → hand off.
    expect(run1.hasMore).toBe(true);

    // ── Run 2: resumes on the remaining OVERFLOW only, then dispatches. ──
    const run2 = await dispatchEventChangeNotifications(deps, {});
    expect(run2.recipientsNotified).toBe(OVERFLOW);
    expect(run2.dispatched).toBe(1);
    expect(mocks.eventChangeNotices.markDispatched).toHaveBeenCalledWith(
      ["notice-huge"],
      NOW,
    );

    // No recipient notified twice across the two runs; full audience covered.
    const notifiedIds = notify.mock.calls.map((c) => c[0].humanId);
    expect(notifiedIds.length).toBe(audience.length);
    expect(new Set(notifiedIds).size).toBe(audience.length);
  });

  it("budget-capped non-coverage does not increment attempts toward dead-letter", async () => {
    const audience = Array.from(
      { length: MAX_RECIPIENTS_PER_NOTICE_PER_RUN + 1 },
      (_, i) => `saver-${i}`,
    );
    // attempts already at 4 with maxAttempts 5: if a budget-capped run wrongly
    // bumped attempts it would dead-letter here. It must not.
    const notice = buildNotice({
      id: "notice-huge-old",
      changeType: "RESCHEDULED",
      attempts: 4,
      payload: {
        eventTitle: "Old Huge Show",
        newStartsAt: null,
        newEndsAt: null,
      },
    });
    const { deps, mocks } = createDeps({ notices: [notice], saverIds: audience });

    const result = await dispatchEventChangeNotifications(deps, {
      maxAttempts: 5,
      maxPasses: 1,
    });

    expect(result.recipientsNotified).toBe(MAX_RECIPIENTS_PER_NOTICE_PER_RUN);
    expect(result.deadLettered).toBe(0);
    expect(result.dispatched).toBe(0);
    expect(mocks.eventChangeNotices.incrementAttempts).not.toHaveBeenCalled();
    expect(mocks.eventChangeNotices.markDispatched).not.toHaveBeenCalled();
  });

  it("poisoned payload below maxAttempts is retried, not dead-lettered", async () => {
    const notice = buildNotice({
      id: "notice-poison-early",
      changeType: "CANCELLED",
      attempts: 0,
      payload: { nope: true },
    });
    const { deps, mocks } = createDeps({ notices: [notice] });

    const result = await dispatchEventChangeNotifications(deps, {
      maxAttempts: 5,
    });

    expect(result.deadLettered).toBe(0);
    expect(result.dispatched).toBe(0);
    expect(mocks.eventChangeNotices.incrementAttempts).toHaveBeenCalledWith([
      "notice-poison-early",
    ]);
    expect(mocks.eventChangeNotices.markDispatched).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Producer ↔ strict-schema alignment
//
// The three stored-payload schemas are `.strict()`, so the EXACT field set each
// producer writes must parse, and any extra/unknown field must be REJECTED
// (→ resolveRecipients returns null → the notice retries/dead-letters rather
// than fanning out). These tests pin the contract so a future producer drift
// fails HERE, not in production. Each "exact" payload mirrors, verbatim, what
// its producer writes:
//   - CANCELLED  → cancel-event.ts, and archive-event.ts for a PUBLISHED
//     COMMUNITY listing (owner ruling 2026-10-16) (cancelledPayloadSchema)
//   - RESCHEDULED/VENUE_CHANGED → review-event-edit-suggestion.ts and
//     update-community-listing.ts (both via community-edit-applied.ts), and
//     RESCHEDULED only → save-event-shared.ts (the owned save)
//     (changedPayloadSchema)
//   - ARCHIVED/UNPUBLISHED → archive-event.ts / unpublish-event.ts (unlistedPayloadSchema)
// ─────────────────────────────────────────────────────────────────────────────

describe("dispatchEventChangeNotifications – producer↔strict-schema alignment", () => {
  // CANCELLED — exact producer payload (cancel-event.ts:431-435).
  it("CANCELLED: the exact producer payload passes the strict schema and dispatches", async () => {
    const notice = buildNotice({
      id: "cancelled-exact",
      changeType: "CANCELLED",
      payload: {
        eventTitle: "Doomed Show",
        startsAt: "2026-08-01T20:00:00.000Z",
        buyers: [{ humanId: BUYER, refundedCents: 4500, currency: "usd" }],
        pendingRefundBuyerHumanIds: [],
      },
    });
    const { deps, mocks } = createDeps({ notices: [notice] });

    const result = await dispatchEventChangeNotifications(deps, {});

    expect(result.dispatched).toBe(1);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.eventChangeNotices.incrementAttempts).not.toHaveBeenCalled();
  });

  // CANCELLED — archive-event.ts's payload for a live COMMUNITY listing
  // archived without a cancel first: no buyers (RSVP-only, no money moves).
  // The event is ARCHIVED by the time the drain runs; nothing here gates on
  // status, so savers ∪ RSVPers get event.cancelled linking to its page.
  // Archive of a PUBLISHED community listing writes this CANCELLED notice in
  // the same transaction that flips the listing to ARCHIVED, so by dispatch
  // the page says "No longer available": the message goes, with no link.
  it("CANCELLED: archive-event's community payload sends event.cancelled to savers and RSVPers, no refund, no link", async () => {
    const notice = buildNotice({
      id: "cancelled-by-archive",
      changeType: "CANCELLED",
      payload: {
        eventTitle: "Weekly Open Mic",
        startsAt: "2026-08-01T20:00:00.000Z",
        buyers: [],
        pendingRefundBuyerHumanIds: [],
      },
    });
    const { deps, mocks } = createDeps({
      notices: [notice],
      saverIds: [SAVER],
      rsvpIds: [RSVPER],
      event: { slug: EVENT_SLUG, status: "ARCHIVED" },
    });

    const result = await dispatchEventChangeNotifications(deps, {});

    expect(result.dispatched).toBe(1);
    expect(result.recipientsNotified).toBe(2);
    const calls = mocks.notify.mock.calls.map((c) => c[0]);
    for (const humanId of [SAVER, RSVPER]) {
      expect(calls).toContainEqual(
        expect.objectContaining({
          humanId,
          variant: "event.cancelled",
          payload: expect.objectContaining({
            eventTitle: "Weekly Open Mic",
            eventUrl: null,
            refund: null,
          }),
        }),
      );
    }
  });

  it("CANCELLED: an extra unknown payload field is rejected (retried, not sent)", async () => {
    const notice = buildNotice({
      id: "cancelled-extra",
      changeType: "CANCELLED",
      payload: {
        eventTitle: "Doomed Show",
        startsAt: "2026-08-01T20:00:00.000Z",
        buyers: [{ humanId: BUYER, refundedCents: 4500, currency: "usd" }],
        pendingRefundBuyerHumanIds: [],
        // Drift: a field the strict schema does not allow.
        surpriseField: "unexpected",
      },
    });
    const { deps, mocks } = createDeps({ notices: [notice] });

    const result = await dispatchEventChangeNotifications(deps, {});

    expect(result.dispatched).toBe(0);
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(mocks.eventChangeNotices.incrementAttempts).toHaveBeenCalledWith([
      "cancelled-extra",
    ]);
  });

  it("CANCELLED: an extra unknown field on a buyer is rejected", async () => {
    const notice = buildNotice({
      id: "cancelled-buyer-extra",
      changeType: "CANCELLED",
      payload: {
        eventTitle: "Doomed Show",
        startsAt: null,
        buyers: [
          {
            humanId: BUYER,
            refundedCents: 4500,
            currency: "usd",
            // Drift on the inner buyer object.
            note: "nope",
          },
        ],
        pendingRefundBuyerHumanIds: [],
      },
    });
    const { deps, mocks } = createDeps({ notices: [notice] });

    const result = await dispatchEventChangeNotifications(deps, {});

    expect(result.dispatched).toBe(0);
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(mocks.eventChangeNotices.incrementAttempts).toHaveBeenCalledWith([
      "cancelled-buyer-extra",
    ]);
  });

  // RESCHEDULED / VENUE_CHANGED — exact producer payload
  // (review-event-edit-suggestion.ts:326-330).
  it.each(["RESCHEDULED", "VENUE_CHANGED"] as const)(
    "%s: the exact producer payload passes the strict schema and dispatches",
    async (changeType) => {
      const notice = buildNotice({
        id: `changed-exact-${changeType}`,
        changeType,
        payload: {
          eventTitle: "Moved Show",
          newStartsAt: "2026-09-01T20:00:00.000Z",
          newEndsAt: "2026-09-01T23:00:00.000Z",
        },
      });
      const { deps, mocks } = createDeps({
        notices: [notice],
        saverIds: [SAVER],
      });

      const result = await dispatchEventChangeNotifications(deps, {});

      expect(result.dispatched).toBe(1);
      expect(mocks.notify).toHaveBeenCalledTimes(1);
      expect(mocks.eventChangeNotices.incrementAttempts).not.toHaveBeenCalled();
    },
  );

  it("RESCHEDULED: an extra unknown payload field is rejected (retried, not sent)", async () => {
    const notice = buildNotice({
      id: "changed-extra",
      changeType: "RESCHEDULED",
      payload: {
        eventTitle: "Moved Show",
        newStartsAt: "2026-09-01T20:00:00.000Z",
        newEndsAt: "2026-09-01T23:00:00.000Z",
        // Drift: a field the strict schema does not allow.
        oldStartsAt: "2026-08-01T20:00:00.000Z",
      },
    });
    const { deps, mocks } = createDeps({
      notices: [notice],
      saverIds: [SAVER],
    });

    const result = await dispatchEventChangeNotifications(deps, {});

    expect(result.dispatched).toBe(0);
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(mocks.eventChangeNotices.incrementAttempts).toHaveBeenCalledWith([
      "changed-extra",
    ]);
  });

  // ARCHIVED / UNPUBLISHED — exact producer payload
  // (archive-event.ts:91 / unpublish-event.ts:90).
  it.each(["ARCHIVED", "UNPUBLISHED"] as const)(
    "%s: the exact producer payload passes the strict schema and dispatches",
    async (changeType) => {
      const notice = buildNotice({
        id: `unlisted-exact-${changeType}`,
        changeType,
        payload: { eventTitle: "Hidden Show" },
      });
      const { deps, mocks } = createDeps({
        notices: [notice],
        saverIds: [SAVER],
      });

      const result = await dispatchEventChangeNotifications(deps, {});

      expect(result.dispatched).toBe(1);
      expect(mocks.notify).toHaveBeenCalledTimes(1);
      expect(mocks.eventChangeNotices.incrementAttempts).not.toHaveBeenCalled();
    },
  );

  it("ARCHIVED: an extra unknown payload field is rejected (retried, not sent)", async () => {
    const notice = buildNotice({
      id: "unlisted-extra",
      changeType: "ARCHIVED",
      payload: {
        eventTitle: "Hidden Show",
        // Drift: a field the strict schema does not allow.
        reason: "cleanup",
      },
    });
    const { deps, mocks } = createDeps({
      notices: [notice],
      saverIds: [SAVER],
    });

    const result = await dispatchEventChangeNotifications(deps, {});

    expect(result.dispatched).toBe(0);
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(mocks.eventChangeNotices.incrementAttempts).toHaveBeenCalledWith([
      "unlisted-extra",
    ]);
  });

  describe("event link", () => {
    const EVENT_URL = `${APP_BASE_URL}/events/${EVENT_SLUG}`;

    // The shared EVENT_ID fixture isn't a schema-valid UUID (wrong variant
    // nibble) and the other tests never render, so use a real one here.
    const RENDERABLE_EVENT_ID = "40000000-0000-4000-8000-000000000004";

    const cancelledNotice = () =>
      buildNotice({
        id: "notice-link-cancel",
        eventId: RENDERABLE_EVENT_ID,
        changeType: "CANCELLED",
        payload: {
          eventTitle: "Doomed Show",
          startsAt: "2026-08-01T20:00:00.000Z",
          buyers: [],
        },
      });

    const changedNotice = () =>
      buildNotice({
        id: "notice-link-changed",
        eventId: RENDERABLE_EVENT_ID,
        changeType: "RESCHEDULED",
        payload: {
          eventTitle: "Moved Show",
          newStartsAt: "2026-09-01T20:00:00.000Z",
          newEndsAt: null,
        },
      });

    it("carries the SLUG-based event URL on cancellations", async () => {
      const { deps, mocks } = createDeps({
        notices: [cancelledNotice()],
        saverIds: ["saver-1"],
      });

      await dispatchEventChangeNotifications(deps, {});

      expect(mocks.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: "event.cancelled",
          payload: expect.objectContaining({ eventUrl: EVENT_URL }),
        }),
      );
      // The renderer turns that into the in-app route — never an id route.
      const { variant, payload } = (mocks.notify.mock.calls[0] as any[])[0];
      const rendered = renderNotification(variant, payload, { now: NOW });
      expect(rendered.inApp?.action?.route).toBe(`/events/${EVENT_SLUG}`);
    });

    it("carries it on reschedules too", async () => {
      const { deps, mocks } = createDeps({
        notices: [changedNotice()],
        saverIds: ["saver-1"],
      });

      await dispatchEventChangeNotifications(deps, {});

      expect(mocks.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: "event.changed",
          payload: expect.objectContaining({ eventUrl: EVENT_URL }),
        }),
      );
    });

    // The link matches the page it opens: the page says "Event cancelled"
    // only while the event is CANCELLED.
    it.each(["ARCHIVED", "COMPLETED", "PUBLISHED"])(
      "a cancellation sends NO link once the event is %s at dispatch",
      async (status) => {
        const { deps, mocks } = createDeps({
          notices: [cancelledNotice()],
          saverIds: ["saver-1"],
          event: { slug: EVENT_SLUG, status },
        });

        const result = await dispatchEventChangeNotifications(deps, {});

        expect(result.recipientsNotified).toBe(1);
        const { variant, payload } = (mocks.notify.mock.calls[0] as any[])[0];
        expect(variant).toBe("event.cancelled");
        expect(payload.eventUrl).toBeNull();
        expect(
          renderNotification(variant, payload, { now: NOW }).inApp?.action,
        ).toBeNull();
      },
    );

    it("a reschedule keeps its link whatever the status (the bound is cancellation-only)", async () => {
      const { deps, mocks } = createDeps({
        notices: [changedNotice()],
        saverIds: ["saver-1"],
        event: { slug: EVENT_SLUG, status: "PUBLISHED" },
      });

      await dispatchEventChangeNotifications(deps, {});

      expect(
        (mocks.notify.mock.calls[0] as any[])[0].payload.eventUrl,
      ).toBe(EVENT_URL);
    });

    it("looks the event up ONCE per notice, not once per recipient", async () => {
      const { deps, mocks } = createDeps({
        notices: [cancelledNotice()],
        saverIds: ["s1", "s2", "s3"],
        rsvpIds: ["r1", "r2"],
      });

      await dispatchEventChangeNotifications(deps, {});

      expect(mocks.notify.mock.calls.length).toBeGreaterThan(1);
      expect(mocks.events.getById).toHaveBeenCalledTimes(1);
    });

    it("still notifies (with no link) when the event has no slug", async () => {
      const { deps, mocks } = createDeps({
        notices: [cancelledNotice()],
        saverIds: ["saver-1"],
        event: { slug: null, status: "CANCELLED" },
      });

      await dispatchEventChangeNotifications(deps, {});

      const { variant, payload } = (mocks.notify.mock.calls[0] as any[])[0];
      expect(payload.eventUrl).toBeNull();
      // No URL → no labelled button to nowhere.
      expect(
        renderNotification(variant, payload, { now: NOW }).inApp?.action,
      ).toBeNull();
    });

    it("still notifies (with no link) when the base URL is malformed", async () => {
      const { deps, mocks } = createDeps({
        notices: [cancelledNotice()],
        saverIds: ["saver-1"],
        appBaseUrl: "ithasfire.com",
      });

      await dispatchEventChangeNotifications(deps, {});

      const { variant, payload } = (mocks.notify.mock.calls[0] as any[])[0];
      expect(payload.eventUrl).toBeNull();
      // Must not throw the strict `.url()` and sink a cancellation notice.
      expect(() =>
        renderNotification(variant, payload, { now: NOW }),
      ).not.toThrow();
    });

    it("reports the lookup failure to Sentry and still fans out", async () => {
      const reportError = vi.fn();
      const { deps, mocks } = createDeps({
        notices: [cancelledNotice()],
        saverIds: ["saver-1"],
        eventLookupError: new Error("db down"),
        reportError,
      });

      const result = await dispatchEventChangeNotifications(deps, {});

      expect(result.recipientsNotified).toBe(1);
      expect(
        (mocks.notify.mock.calls[0] as any[])[0].payload.eventUrl,
      ).toBeNull();
      expect(mocks.logger.error).toHaveBeenCalledWith(
        "events.dispatchEventChangeNotifications.event_url_failed",
        expect.objectContaining({ error: expect.any(String) }),
      );
      expect(reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: {
            area: "event-change-notices",
            reason: "event-url-failed",
          },
        }),
      );
    });
  });

  describe("event.changed timezone", () => {
    const rescheduled = () =>
      buildNotice({
        id: "notice-tz",
        changeType: "RESCHEDULED",
        payload: {
          eventTitle: "Moved Show",
          newStartsAt: "2026-11-14T01:30:00.000Z",
          newEndsAt: null,
        },
      });

    it("carries the event's timezone, so the new start reads in local time", async () => {
      const { deps, mocks } = createDeps({
        notices: [rescheduled()],
        saverIds: [SAVER],
        event: { slug: EVENT_SLUG, timezone: "America/Chicago" },
      });

      await dispatchEventChangeNotifications(deps, {});

      const { variant, payload } = (mocks.notify.mock.calls[0] as any[])[0];
      expect(payload.timezone).toBe("America/Chicago");
      expect(
        // The fixture's eventId is not a UUID; only the zone matters here.
        renderNotification(
          variant,
          { ...payload, eventId: "3f1c8d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f" },
          { now: NOW },
        ).inApp?.body.replace(/[\u00a0\u202f]/gu, " "),
      ).toBe("Moved Show has a new date. It now starts Fri, Nov 13, 2026, 7:30 PM CST.");
    });

    it("omits the timezone when the event lookup fails (renders in UTC, still sends)", async () => {
      const { deps, mocks } = createDeps({
        notices: [rescheduled()],
        saverIds: [SAVER],
        eventLookupError: new Error("db down"),
        reportError: vi.fn(),
      });

      const result = await dispatchEventChangeNotifications(deps, {});

      expect(result.recipientsNotified).toBe(1);
      const { payload } = (mocks.notify.mock.calls[0] as any[])[0];
      expect("timezone" in payload).toBe(false);
    });

    it("omits a zone longer than the renderer's max(100) and still sends", async () => {
      const { deps, mocks } = createDeps({
        notices: [rescheduled()],
        saverIds: [SAVER],
        event: { slug: EVENT_SLUG, timezone: "A".repeat(101) },
      });

      const result = await dispatchEventChangeNotifications(deps, {});

      expect(result.recipientsNotified).toBe(1);
      const { variant, payload } = (mocks.notify.mock.calls[0] as any[])[0];
      expect("timezone" in payload).toBe(false);
      // The stored payload passes the strict renderer schema.
      expect(() =>
        renderNotification(
          variant,
          { ...payload, eventId: "3f1c8d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f" },
          { now: NOW },
        ),
      ).not.toThrow();
    });
  });
});
