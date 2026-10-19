import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";
import { AppError } from "@th/errors";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import {
  refreshRecurringEventDates,
  type RefreshRecurringEventDatesDeps,
} from "../refresh-recurring-event-dates";
import { NOW, makeClock, makeCommunityEvent } from "./helpers";

// FR-018 boundary: the line mechanics are pinned by the helper's own suite;
// here the job's handling of what the helper RETURNS / THROWS is pinned.
const settleHeldDatesForEvent = vi.fn();
vi.mock("../../booking-holds/settle-held-dates-for-published-event", async (importOriginal) => ({
  // Keep the module's other exports (`heldDatesOwnerOf`) real; only the settle is the boundary.
  ...(await importOriginal<typeof import("../../booking-holds/settle-held-dates-for-published-event")>()),
  settleHeldDatesForEvent: (...args: unknown[]) => settleHeldDatesForEvent(...args),
}));
const NO_HELD_DATES = { confirmed: [], released: [], intents: [], staffRecipientHint: null };

beforeEach(() => {
  settleHeldDatesForEvent.mockReset();
  settleHeldDatesForEvent.mockResolvedValue(NO_HELD_DATES);
});

const WEEKLY_SCHEDULE = {
  kind: "RRULE" as const,
  rrule: "FREQ=WEEKLY",
  dtstart: "2026-08-04T20:00:00",
};

/** A schedule whose occurrences are all in the past relative to NOW. */
const ELAPSED_SCHEDULE = {
  kind: "FIXED_DATES" as const,
  dates: ["2020-01-01T20:00:00", "2020-02-01T20:00:00"],
};

type BulkReplaceRow = {
  id: string;
  eventId: string;
  ordinal: number;
  startsAt: Date;
  endsAt: Date | null;
  status: "SCHEDULED" | "CANCELLED";
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Build deps for the refresh job. `events` is a small in-memory store keyed by
 * id; `listRecurringEventIds` returns the ids of stored recurring events (with
 * simple id-cursor pagination), and each per-event `repos.tx` loads + edits
 * that store. Optional `failEventIds` makes `getById` throw for those ids so we
 * can assert per-event error isolation.
 */
function buildDeps(opts: {
  events: EventRecord[];
  pageSize?: number;
  failEventIds?: Set<string>;
  /**
   * eventId -> the ids the reconciliation flipped SCHEDULED -> CANCELLED. Only
   * a DRIFTED listing produces any: a deterministic rule re-expanded from a
   * later `now` yields a superset of the surviving future set.
   */
  cancelledDateIdsByEventId?: Record<string, string[]>;
  reportError?: (err: unknown, ctx?: unknown) => void;
}) {
  const store = new Map(opts.events.map((e) => [e.id, { ...e }]));

  const recurringIds = () =>
    [...store.values()]
      .filter((e) => e.recurrenceSchedule && e.status === "PUBLISHED")
      .map((e) => e.id)
      .sort();

  const listRecurringEventIds = vi.fn(
    async ({ limit, cursor }: { limit: number; cursor?: string }) => {
      const all = recurringIds();
      const start = cursor
        ? all.findIndex((id) => id > cursor)
        : 0;
      const from = start < 0 ? all.length : start;
      const page = all.slice(from, from + limit);
      const nextCursor =
        page.length === limit ? page[page.length - 1] : undefined;
      return nextCursor ? { ids: page, nextCursor } : { ids: page };
    },
  );

  const getById = vi.fn(async (id: string) => {
    if (opts.failEventIds?.has(id)) {
      throw new Error(`boom:${id}`);
    }
    return store.get(id) ?? null;
  });

  const bulkReplaceForEvent = vi.fn(
    async (args: {
      eventId: string;
      now: Date;
      dates: Array<{ startsAt: Date; endsAt?: Date | null }>;
    }): Promise<{
      scheduled: BulkReplaceRow[];
      cancelledDateIds: string[];
    }> => ({
      scheduled: args.dates
        .slice()
        .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
        .map((d, i) => ({
          id: `${args.eventId}-date-${i}`,
          eventId: args.eventId,
          ordinal: i + 1,
          startsAt: d.startsAt,
          endsAt: d.endsAt ?? null,
          status: "SCHEDULED" as const,
          createdAt: NOW,
          updatedAt: NOW,
        })),
      cancelledDateIds:
        opts.cancelledDateIdsByEventId?.[args.eventId] ?? [],
    }),
  );

  // Wired so the suite can prove the job never reaches them. `listHumanIdsForDate`
  // throws rather than returning [] — a silent empty would let a regression that
  // DOES fan out from cron pass as "notified nobody".
  const listHumanIdsForDate = vi.fn(async (): Promise<string[]> => {
    throw new Error("refresh job must never read RSVP recipients");
  });
  const createDateCancelled = vi.fn(async (): Promise<number> => {
    throw new Error("refresh job must never enqueue a DATE_CANCELLED notice");
  });

  const applyCommunityEdit = vi.fn(
    async (args: {
      eventId: string;
      fields: { startsAt?: Date; endsAt?: Date };
    }) => {
      const current = store.get(args.eventId)!;
      const next = {
        ...current,
        startsAt: args.fields.startsAt ?? current.startsAt,
        endsAt: args.fields.endsAt ?? current.endsAt,
      };
      store.set(args.eventId, next);
      return next;
    },
  );

  const audit = { log: vi.fn(async () => {}) };

  // Every night writer locks the listing row first (lock order).
  const lockRows = vi.fn(async () => undefined);

  const txRepos = {
    events: { getById, applyCommunityEdit, lockRows },
    eventDates: { bulkReplaceForEvent },
    eventDateRsvps: { listHumanIdsForDate },
    rsvpNotices: { createDateCancelled },
    audit,
  };

  const deps: RefreshRecurringEventDatesDeps = {
    repos: {
      events: { listRecurringEventIds },
      tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txRepos)),
    } as unknown as RefreshRecurringEventDatesDeps["repos"],
    clock: makeClock(),
    ...(opts.reportError ? { reportError: opts.reportError } : {}),
  };

  return {
    deps,
    store,
    listRecurringEventIds,
    getById,
    lockRows,
    bulkReplaceForEvent,
    applyCommunityEdit,
    audit,
    listHumanIdsForDate,
    createDateCancelled,
  };
}

describe("refreshRecurringEventDates", () => {
  it("advances a lapsed listing's startsAt to the next upcoming date", async () => {
    // startsAt is BEFORE now (lapsed) — the re-pin must move it forward.
    const event = makeCommunityEvent({
      id: "eeeeeeee-1111-4111-8111-111111111111",
      timezone: "UTC",
      startsAt: new Date("2026-06-01T20:00:00.000Z"),
      endsAt: new Date("2026-06-01T23:00:00.000Z"),
      recurrenceSchedule: WEEKLY_SCHEDULE,
    } as Partial<EventRecord>);

    const { deps, store, applyCommunityEdit, bulkReplaceForEvent } = buildDeps({
      events: [event],
    });

    const summary = await refreshRecurringEventDates(deps, {});

    expect(summary).toEqual({
      processed: 1,
      updated: 1,
      skippedNoUpcoming: 0,
      skippedOpenChallenge: 0,
      skippedRsvpDrop: 0,
      failed: 0,
    });

    // Re-expanded within the rolling window.
    expect(bulkReplaceForEvent).toHaveBeenCalledTimes(1);
    // Re-pinned to the first UPCOMING occurrence (2026-08-04, first future date).
    expect(applyCommunityEdit).toHaveBeenCalledTimes(1);
    const pinned = applyCommunityEdit.mock.calls[0]![0].fields.startsAt;
    expect(pinned?.toISOString()).toBe("2026-08-04T20:00:00.000Z");
    expect(store.get(event.id)!.startsAt.toISOString()).toBe(
      "2026-08-04T20:00:00.000Z",
    );
  });

  it("counts a fully-elapsed schedule as skippedNoUpcoming without throwing or re-pinning", async () => {
    const event = makeCommunityEvent({
      id: "eeeeeeee-2222-4222-8222-222222222222",
      timezone: "UTC",
      startsAt: new Date("2020-01-01T20:00:00.000Z"),
      endsAt: new Date("2020-01-01T23:00:00.000Z"),
      recurrenceSchedule: ELAPSED_SCHEDULE,
    } as Partial<EventRecord>);

    const { deps, applyCommunityEdit, audit } = buildDeps({ events: [event] });

    const summary = await refreshRecurringEventDates(deps, {});

    expect(summary).toEqual({
      processed: 1,
      updated: 0,
      skippedNoUpcoming: 1,
      skippedOpenChallenge: 0,
      skippedRsvpDrop: 0,
      failed: 0,
    });
    expect(applyCommunityEdit).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("never touches non-recurring events (they are not enumerated)", async () => {
    const recurring = makeCommunityEvent({
      id: "eeeeeeee-3333-4333-8333-333333333333",
      timezone: "UTC",
      startsAt: new Date("2026-06-01T20:00:00.000Z"),
      endsAt: new Date("2026-06-01T23:00:00.000Z"),
      recurrenceSchedule: WEEKLY_SCHEDULE,
    } as Partial<EventRecord>);
    const single = makeCommunityEvent({
      id: "eeeeeeee-4444-4444-8444-444444444444",
      timezone: "UTC",
      recurrenceSchedule: null,
    } as Partial<EventRecord>);

    const { deps, getById } = buildDeps({
      events: [recurring, single],
    });

    const summary = await refreshRecurringEventDates(deps, {});

    // Only the recurring event was enumerated + loaded.
    expect(summary.processed).toBe(1);
    expect(getById).toHaveBeenCalledTimes(1);
    expect(getById).toHaveBeenCalledWith(recurring.id);
  });

  it("isolates a per-event failure: other events still process, failure is counted", async () => {
    const good = makeCommunityEvent({
      id: "eeeeeeee-5555-4555-8555-555555555555",
      timezone: "UTC",
      startsAt: new Date("2026-06-01T20:00:00.000Z"),
      endsAt: new Date("2026-06-01T23:00:00.000Z"),
      recurrenceSchedule: WEEKLY_SCHEDULE,
    } as Partial<EventRecord>);
    const bad = makeCommunityEvent({
      id: "eeeeeeee-6666-4666-8666-666666666666",
      timezone: "UTC",
      startsAt: new Date("2026-06-01T20:00:00.000Z"),
      endsAt: new Date("2026-06-01T23:00:00.000Z"),
      recurrenceSchedule: WEEKLY_SCHEDULE,
    } as Partial<EventRecord>);

    const { deps, store } = buildDeps({
      events: [good, bad],
      failEventIds: new Set([bad.id]),
    });

    const summary = await refreshRecurringEventDates(deps, {});

    expect(summary.processed).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.updated).toBe(1);
    // The healthy event was still re-pinned despite the sibling's failure.
    expect(store.get(good.id)!.startsAt.toISOString()).toBe(
      "2026-08-04T20:00:00.000Z",
    );
  });

  // The batch returns normally with `failed: 1`, so the run is a success
  // everywhere a run is shown; the report is the only thing that says one
  // listing is failing. `bad` sorts BEFORE `good` in both tests, so `good`
  // being re-pinned proves the loop went on after the failure.
  describe("a per-event failure is REPORTED, not only counted", () => {
    const bad = makeCommunityEvent({
      id: "eeeeeeee-1111-4111-8111-111111111111",
      timezone: "UTC",
      startsAt: new Date("2026-06-01T20:00:00.000Z"),
      endsAt: new Date("2026-06-01T23:00:00.000Z"),
      // A corrupt stored schedule: re-validation throws for this listing on
      // every run until somebody repairs the row.
      recurrenceSchedule: { kind: "NOT_A_SCHEDULE_KIND" },
    } as unknown as Partial<EventRecord>);
    const good = makeCommunityEvent({
      id: "eeeeeeee-5555-4555-8555-555555555555",
      timezone: "UTC",
      startsAt: new Date("2026-06-01T20:00:00.000Z"),
      endsAt: new Date("2026-06-01T23:00:00.000Z"),
      recurrenceSchedule: WEEKLY_SCHEDULE,
    } as Partial<EventRecord>);

    it("reports the listing's own error with its event id, and the batch continues", async () => {
      const reportError = vi.fn();
      const scoped = createTestLogger();
      const logger = { ...createTestLogger(), child: vi.fn(() => scoped) };
      const { deps, store } = buildDeps({ events: [bad, good], reportError });

      const summary = await refreshRecurringEventDates({ ...deps, logger }, {});

      expect(summary).toMatchObject({ processed: 2, failed: 1, updated: 1 });
      expect(reportError).toHaveBeenCalledTimes(1);
      const [err, context] = reportError.mock.calls[0]!;
      expect(err).toBeInstanceOf(Error);
      expect(context).toEqual({
        tags: {
          area: "community_recurrence",
          step: "refresh_recurring_dates",
        },
        extra: { eventId: bad.id },
      });
      // The log line stays.
      expect(scoped.error).toHaveBeenCalledWith(
        "refreshRecurringEventDates.eventFailed",
        expect.objectContaining({ eventId: bad.id }),
      );
      expect(store.get(good.id)!.startsAt.toISOString()).toBe(
        "2026-08-04T20:00:00.000Z",
      );
    });

    it("a THROWING reporter never turns one listing's failure into a batch failure", async () => {
      const reportError = vi.fn(() => {
        throw new Error("sentry down");
      });
      const { deps, store } = buildDeps({ events: [bad, good], reportError });

      const summary = await refreshRecurringEventDates(deps, {});

      expect(reportError).toHaveBeenCalledTimes(1);
      expect(summary).toMatchObject({ processed: 2, failed: 1, updated: 1 });
      expect(store.get(good.id)!.startsAt.toISOString()).toBe(
        "2026-08-04T20:00:00.000Z",
      );
    });
  });

  it("paginates across pages via the id cursor until exhausted", async () => {
    const events = Array.from({ length: 5 }, (_, i) =>
      makeCommunityEvent({
        id: `eeeeeeee-7777-4777-8777-00000000000${i}`,
        timezone: "UTC",
        startsAt: new Date("2026-06-01T20:00:00.000Z"),
        endsAt: new Date("2026-06-01T23:00:00.000Z"),
        recurrenceSchedule: WEEKLY_SCHEDULE,
      } as Partial<EventRecord>),
    );

    const { deps, listRecurringEventIds } = buildDeps({ events });

    const summary = await refreshRecurringEventDates(deps, { limit: 2 });

    expect(summary.processed).toBe(5);
    expect(summary.updated).toBe(5);
    // 5 ids at page size 2 → pages of [2, 2, 1]; the short last page stops it.
    expect(listRecurringEventIds).toHaveBeenCalledTimes(3);
  });

  it("respects maxEvents as a hard cap on a run", async () => {
    const events = Array.from({ length: 4 }, (_, i) =>
      makeCommunityEvent({
        id: `eeeeeeee-8888-4888-8888-00000000000${i}`,
        timezone: "UTC",
        startsAt: new Date("2026-06-01T20:00:00.000Z"),
        endsAt: new Date("2026-06-01T23:00:00.000Z"),
        recurrenceSchedule: WEEKLY_SCHEDULE,
      } as Partial<EventRecord>),
    );

    const { deps } = buildDeps({ events });

    const summary = await refreshRecurringEventDates(deps, {
      limit: 10,
      maxEvents: 2,
    });

    expect(summary.processed).toBe(2);
  });

  describe("held dates (booking-holds FR-018)", () => {
    const HOLD_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const REQUEST_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const lapsed = (id: string) =>
      makeCommunityEvent({
        id,
        timezone: "UTC",
        startsAt: new Date("2026-06-01T20:00:00.000Z"),
        endsAt: new Date("2026-06-01T23:00:00.000Z"),
        recurrenceSchedule: WEEKLY_SCHEDULE,
      } as Partial<EventRecord>);

    it("re-pins as the platform (null actor) and, having no notify channel, LOGS + REPORTS the intents it owes instead of dropping them", async () => {
      const event = lapsed("eeeeeeee-9999-4999-8999-000000000001");
      const { deps, store } = buildDeps({ events: [event] });
      // The use case logs through a scoped child; capture it.
      const scoped = createTestLogger();
      const logger = { ...createTestLogger(), child: vi.fn(() => scoped) };
      const reportError = vi.fn();
      settleHeldDatesForEvent.mockResolvedValue({
        ...NO_HELD_DATES,
        released: [{ id: HOLD_ID }],
        intents: [
          { kind: "hold.released", bookingRequestId: REQUEST_ID, holdId: HOLD_ID, audience: "act", date: "2026-08-04", reason: "EVENT_SCHEDULED" },
        ],
      });

      const summary = await refreshRecurringEventDates({ ...deps, logger, reportError }, {});

      expect(summary).toMatchObject({ processed: 1, updated: 1, skippedOpenChallenge: 0, failed: 0 });
      expect(settleHeldDatesForEvent).toHaveBeenCalledTimes(1);
      expect(settleHeldDatesForEvent.mock.calls[0]![1]).toMatchObject({
        event: expect.objectContaining({ id: event.id, startsAt: new Date("2026-08-04T20:00:00.000Z") }),
        actorHumanId: null,
        owner: { kind: "community" },
      });
      // The re-pin still committed.
      expect(store.get(event.id)!.startsAt.toISOString()).toBe("2026-08-04T20:00:00.000Z");
      expect(reportError).toHaveBeenCalledTimes(1);
      const [err, context] = reportError.mock.calls[0]!;
      expect((err as Error).message).toBe("refresh_recurring_event_dates.hold_intents_unsent");
      expect(context).toEqual({
        tags: { area: "booking_holds", step: "refresh_recurring_dates" },
        extra: { eventId: event.id, intentCount: 1, kinds: ["hold.released"] },
      });
      expect(scoped.error).toHaveBeenCalledWith(
        "refresh_recurring_event_dates.hold_intents_unsent",
        expect.objectContaining({ eventId: event.id, intentCount: 1 }),
      );
    });

    it("a THROWING reporter never fails the re-pin", async () => {
      const event = lapsed("eeeeeeee-9999-4999-8999-000000000002");
      const { deps, store } = buildDeps({ events: [event] });
      settleHeldDatesForEvent.mockResolvedValue({
        ...NO_HELD_DATES,
        intents: [{ kind: "hold.released", bookingRequestId: REQUEST_ID, holdId: HOLD_ID, audience: "act", date: "2026-08-04", reason: "EVENT_SCHEDULED" }],
      });

      const summary = await refreshRecurringEventDates(
        { ...deps, reportError: vi.fn(() => { throw new Error("sentry down"); }) },
        {},
      );

      expect(summary).toMatchObject({ updated: 1, failed: 0 });
      expect(store.get(event.id)!.startsAt.toISOString()).toBe("2026-08-04T20:00:00.000Z");
    });

    it("nothing owed → the reporter is not called", async () => {
      const { deps } = buildDeps({ events: [lapsed("eeeeeeee-9999-4999-8999-000000000003")] });
      const reportError = vi.fn();
      await refreshRecurringEventDates({ ...deps, reportError }, {});
      expect(reportError).not.toHaveBeenCalled();
    });

    it("an OPEN hold challenge refusing the take is a COUNTED SKIP, not a failure: the pin is left as-is this run and the batch continues", async () => {
      const blocked = lapsed("eeeeeeee-9999-4999-8999-000000000004");
      const fine = lapsed("eeeeeeee-9999-4999-8999-000000000005");
      const { deps, store, audit } = buildDeps({ events: [blocked, fine] });
      const reportError = vi.fn();
      settleHeldDatesForEvent.mockImplementation(async (_tx: unknown, args: { event: { id: string } }) => {
        if (args.event.id === blocked.id) {
          throw new AppError("HOLD_LINE_HAS_OPEN_CHALLENGE", { meta: { holdId: null, challengedHoldId: HOLD_ID } });
        }
        return NO_HELD_DATES;
      });

      const summary = await refreshRecurringEventDates({ ...deps, reportError }, {});

      expect(summary).toEqual({
        processed: 2,
        updated: 1,
        skippedNoUpcoming: 0,
        skippedOpenChallenge: 1,
        skippedRsvpDrop: 0,
        failed: 0,
      });
      // The tx that threw rolled back in production; here the fake store is
      // pre-commit state, so what is pinned is that the run did NOT audit the
      // blocked event as refreshed and did re-pin the other one.
      expect(audit.log).toHaveBeenCalledTimes(1);
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ entityId: fine.id }));
      expect(store.get(fine.id)!.startsAt.toISOString()).toBe("2026-08-04T20:00:00.000Z");
      // A skip is not an error: nothing reported.
      expect(reportError).not.toHaveBeenCalled();
    });

    it("any OTHER helper failure is still a per-event `failed`", async () => {
      const { deps } = buildDeps({ events: [lapsed("eeeeeeee-9999-4999-8999-000000000006")] });
      settleHeldDatesForEvent.mockRejectedValue(new AppError("HOLD_LINE_CHANGED"));

      const summary = await refreshRecurringEventDates(deps, {});

      expect(summary).toMatchObject({ processed: 1, updated: 0, skippedOpenChallenge: 0, failed: 1 });
    });
  });
});

/**
 * THE CRON-SPAM GUARD. `updateCommunityRecurrence` now emails everyone holding
 * an RSVP on a night its rule change drops. This job runs the SAME
 * `applyRecurrenceForEvent` on a schedule, with nobody at the keyboard, so the
 * two must not share a policy: a routine top-up notifies nobody, and a listing
 * that would somehow drop an RSVP'd night is refused rather than mailed.
 *
 * Non-UTC zone throughout — RRULE is evaluated on a LOCAL basis here.
 */
describe("refreshRecurringEventDates — never notifies anyone", () => {
  const CHICAGO_SCHEDULE = {
    kind: "RRULE" as const,
    rrule: "FREQ=WEEKLY",
    // 20:00 wall-clock in America/Chicago = 01:00Z next day (CDT, UTC-5).
    dtstart: "2026-08-04T20:00:00",
  };

  function chicagoListing(id: string) {
    return makeCommunityEvent({
      id,
      timezone: "America/Chicago",
      startsAt: new Date("2026-06-02T01:00:00.000Z"),
      endsAt: new Date("2026-06-02T04:00:00.000Z"),
      recurrenceSchedule: CHICAGO_SCHEDULE,
    } as Partial<EventRecord>);
  }

  it("a routine top-up reads no RSVP recipients and enqueues no notice", async () => {
    const event = chicagoListing("eeeeeeee-7777-4777-8777-777777777777");
    const { deps, listHumanIdsForDate, createDateCancelled, applyCommunityEdit } =
      buildDeps({ events: [event] });

    const summary = await refreshRecurringEventDates(deps, {});

    expect(summary).toEqual({
      processed: 1,
      updated: 1,
      skippedNoUpcoming: 0,
      skippedOpenChallenge: 0,
      skippedRsvpDrop: 0,
      failed: 0,
    });
    // The re-pin still happened — this is a working top-up, not a no-op.
    expect(applyCommunityEdit).toHaveBeenCalledTimes(1);
    expect(
      applyCommunityEdit.mock.calls[0]![0].fields.startsAt?.toISOString(),
    ).toBe("2026-08-05T01:00:00.000Z");
    // …and nobody was addressed. Both fakes THROW if called, so a regression
    // that fans out from cron fails loudly instead of counting zero.
    expect(listHumanIdsForDate).not.toHaveBeenCalled();
    expect(createDateCancelled).not.toHaveBeenCalled();
  });

  it("refuses a drifted listing whose re-expansion would call off an RSVP'd night: nothing cancelled, nothing sent, reported", async () => {
    const event = chicagoListing("eeeeeeee-8888-4888-8888-888888888888");
    const reportError = vi.fn();
    // The use case logs through a scoped child; capture it.
    const scoped = createTestLogger();
    const logger = { ...createTestLogger(), child: vi.fn(() => scoped) };
    const { deps, applyCommunityEdit, audit, createDateCancelled } = buildDeps({
      events: [event],
      // The reconciliation reports a night it flipped SCHEDULED -> CANCELLED:
      // the drift case (timezone edited, stored schedule rewritten).
      cancelledDateIdsByEventId: { [event.id]: ["drifted-date-1"] },
      reportError,
    });

    const summary = await refreshRecurringEventDates({ ...deps, logger }, {});

    expect(summary).toEqual({
      processed: 1,
      updated: 0,
      skippedNoUpcoming: 0,
      skippedOpenChallenge: 0,
      skippedRsvpDrop: 1,
      failed: 0,
    });

    // The tx rolled back: no re-pin, no audit row, and — the point — no notice.
    expect(applyCommunityEdit).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
    expect(createDateCancelled).not.toHaveBeenCalled();

    // ReporterPort convention: a deliberate swallow-and-continue reports.
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![0]).toMatchObject({
      code: "RECURRENCE_DROP_WOULD_CANCEL_RSVPS",
    });
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      tags: { area: "community_recurrence", step: "refresh_recurring_dates" },
    });
    // logger.error (Sentry-captured via pinoIntegration), never a warn.
    expect(scoped.error).toHaveBeenCalledWith(
      "refreshRecurringEventDates.rsvpDropRefused",
      expect.objectContaining({ eventId: event.id }),
    );
    expect(scoped.warn).not.toHaveBeenCalled();
  });

  it("keeps a drifted listing isolated: its neighbours still get their top-up", async () => {
    const drifted = chicagoListing("eeeeeeee-9999-4999-8999-999999999999");
    const healthy = chicagoListing("eeeeeeee-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const { deps, store } = buildDeps({
      events: [drifted, healthy],
      cancelledDateIdsByEventId: { [drifted.id]: ["drifted-date-1"] },
    });

    const summary = await refreshRecurringEventDates(deps, {});

    expect(summary).toEqual({
      processed: 2,
      updated: 1,
      skippedNoUpcoming: 0,
      skippedOpenChallenge: 0,
      skippedRsvpDrop: 1,
      failed: 0,
    });
    expect(store.get(healthy.id)!.startsAt.toISOString()).toBe(
      "2026-08-05T01:00:00.000Z",
    );
    // The drifted listing keeps its stale pin rather than losing its dates.
    expect(store.get(drifted.id)!.startsAt.toISOString()).toBe(
      "2026-06-02T01:00:00.000Z",
    );
  });

  it("survives a throwing reporter without turning the skip into a failure", async () => {
    const event = chicagoListing("eeeeeeee-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const { deps } = buildDeps({
      events: [event],
      cancelledDateIdsByEventId: { [event.id]: ["drifted-date-1"] },
      reportError: () => {
        throw new Error("sentry is down");
      },
    });

    const summary = await refreshRecurringEventDates(deps, {});

    expect(summary).toMatchObject({ skippedRsvpDrop: 1, failed: 0 });
  });
});

describe("refreshRecurringEventDates lock order", () => {
  it("locks each listing row FOR UPDATE, in its own tx, before it reads it or tops up its nights", async () => {
    // Event before night, the order every night writer uses
    // (cancel-event-date.ts): the top-up rewrites nights and then the row.
    const a = makeCommunityEvent({
      id: "eeeeeeee-aaaa-4aaa-8aaa-000000000001",
      timezone: "UTC",
      startsAt: new Date("2026-06-01T20:00:00.000Z"),
      endsAt: new Date("2026-06-01T23:00:00.000Z"),
      recurrenceSchedule: WEEKLY_SCHEDULE,
    } as Partial<EventRecord>);
    const b = { ...a, id: "eeeeeeee-aaaa-4aaa-8aaa-000000000002" } as EventRecord;
    const { deps, lockRows, getById, bulkReplaceForEvent } = buildDeps({
      events: [a, b],
    });

    await refreshRecurringEventDates(deps, {});

    expect(deps.repos.tx).toHaveBeenCalledTimes(2);
    expect(lockRows.mock.calls).toEqual([
      [{ ids: [a.id], mode: "update" }],
      [{ ids: [b.id], mode: "update" }],
    ]);
    for (const i of [0, 1]) {
      const locked = lockRows.mock.invocationCallOrder[i]!;
      expect(locked).toBeLessThan(getById.mock.invocationCallOrder[i]!);
      expect(locked).toBeLessThan(bulkReplaceForEvent.mock.invocationCallOrder[i]!);
    }
  });
});
