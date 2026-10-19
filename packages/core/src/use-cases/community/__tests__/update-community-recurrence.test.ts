import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";

import {
  updateCommunityRecurrence,
  type UpdateCommunityRecurrenceDeps,
} from "../update-community-recurrence";
import {
  ADMIN_ID,
  EVENT_ID,
  MODERATOR_ID,
  NOW,
  USER_ID,
  makeClock,
  makeCommunityEvent,
  makeOrgEvent,
  makeStaffAuthz,
} from "./helpers";

const WEEKLY_SCHEDULE = {
  kind: "RRULE" as const,
  rrule: "FREQ=WEEKLY",
  dtstart: "2026-08-04T20:00:00",
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
 * tx fake for the recurrence-update path: `events.getById` returns the listing
 * under test, `eventDates.bulkReplaceForEvent` echoes the desired dates back as
 * SCHEDULED rows, and `events.applyCommunityEdit` captures the pinned
 * startsAt/endsAt + persisted schedule.
 */
function buildDeps(
  opts: {
    event?: EventRecord | null;
    bulkReplaceReturn?: (args: {
      eventId: string;
      dates: Array<{ startsAt: Date; endsAt?: Date | null }>;
    }) => BulkReplaceRow[];
    /** Ids the reconciliation flipped SCHEDULED -> CANCELLED in this tx. */
    cancelledDateIds?: string[];
    /** eventDateId -> the humans holding a live RSVP on it. */
    rsvpsByDateId?: Record<string, string[]>;
  } = {},
) {
  // Pin the listing to UTC so the RRULE dtstart (a wall-clock time expanded in
  // the event's timezone) maps 1:1 to the asserted UTC instants.
  const event =
    opts.event === undefined
      ? makeCommunityEvent({ timezone: "UTC" })
      : opts.event;

  const getById = vi.fn(async () => event);

  const bulkReplaceForEvent = vi.fn(
    async (args: {
      eventId: string;
      now: Date;
      dates: Array<{ startsAt: Date; endsAt?: Date | null }>;
    }) => {
      const scheduled = opts.bulkReplaceReturn
        ? opts.bulkReplaceReturn(args)
        : args.dates
            .slice()
            .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
            .map((d, i) => ({
              id: `date-${i}`,
              eventId: args.eventId,
              ordinal: i + 1,
              startsAt: d.startsAt,
              endsAt: d.endsAt ?? null,
              status: "SCHEDULED" as const,
              createdAt: NOW,
              updatedAt: NOW,
            }));
      return { scheduled, cancelledDateIds: opts.cancelledDateIds ?? [] };
    },
  );

  const applyCommunityEdit = vi.fn(
    async (args: {
      eventId: string;
      fields: { startsAt?: Date; endsAt?: Date };
      recurrenceSchedule?: unknown;
    }) => ({
      ...(event as EventRecord),
      startsAt: args.fields.startsAt ?? (event as EventRecord).startsAt,
      endsAt: args.fields.endsAt ?? (event as EventRecord).endsAt,
    }),
  );

  const audit = { log: vi.fn() };

  const listHumanIdsForDate = vi.fn(
    async (eventDateId: string) => opts.rsvpsByDateId?.[eventDateId] ?? [],
  );
  const createDateCancelled = vi.fn(
    async (args: {
      eventId: string;
      eventDateId: string;
      humanIds: readonly string[];
    }) => args.humanIds.length,
  );

  // Every night writer locks the listing row first (lock order).
  const lockRows = vi.fn(async () => undefined);

  const txRepos = {
    events: { getById, applyCommunityEdit, lockRows },
    eventDates: { bulkReplaceForEvent },
    eventDateRsvps: { listHumanIdsForDate },
    rsvpNotices: { createDateCancelled },
    audit,
  };

  const deps: UpdateCommunityRecurrenceDeps = {
    repos: {
      tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txRepos)),
    } as unknown as UpdateCommunityRecurrenceDeps["repos"],
    authz: makeStaffAuthz({
      [MODERATOR_ID]: ["COMMUNITY_MODERATOR"],
      [ADMIN_ID]: ["ADMIN"],
    }),
    clock: makeClock(),
  };

  return {
    deps,
    getById,
    lockRows,
    bulkReplaceForEvent,
    applyCommunityEdit,
    audit,
    listHumanIdsForDate,
    createDateCancelled,
  };
}

describe("updateCommunityRecurrence", () => {
  it("re-expands the schedule into EventDate rows and re-pins Event.startsAt to the first upcoming date", async () => {
    const { deps, bulkReplaceForEvent, applyCommunityEdit } = buildDeps();

    const result = await updateCommunityRecurrence(deps, {
      actorHumanId: MODERATOR_ID,
      eventId: EVENT_ID,
      recurrenceSchedule: WEEKLY_SCHEDULE,
    });

    // Occurrences were reconciled.
    expect(bulkReplaceForEvent).toHaveBeenCalledTimes(1);
    const bulkArgs = bulkReplaceForEvent.mock.calls[0]![0];
    expect(bulkArgs.eventId).toBe(EVENT_ID);
    expect(bulkArgs.now).toEqual(NOW);
    expect(bulkArgs.dates.length).toBeGreaterThanOrEqual(4);
    expect(bulkArgs.dates[0]!.startsAt.toISOString()).toBe(
      "2026-08-04T20:00:00.000Z",
    );
    // Duration preserved (3h template from the listing's startsAt/endsAt).
    expect(bulkArgs.dates[0]!.endsAt?.toISOString()).toBe(
      "2026-08-04T23:00:00.000Z",
    );

    // A single applyCommunityEdit persists the schedule AND re-pins startsAt.
    expect(applyCommunityEdit).toHaveBeenCalledTimes(1);
    const editArgs = applyCommunityEdit.mock.calls[0]![0];
    expect(editArgs.fields.startsAt?.toISOString()).toBe(
      "2026-08-04T20:00:00.000Z",
    );
    expect(editArgs.recurrenceSchedule).toMatchObject({
      kind: "RRULE",
      rrule: "FREQ=WEEKLY",
    });

    expect(result.event.startsAt.toISOString()).toBe(
      "2026-08-04T20:00:00.000Z",
    );
    expect(result.scheduledCount).toBeGreaterThanOrEqual(4);
  });

  it("writes an audit entry with the actor + resulting occurrence count", async () => {
    const { deps, audit } = buildDeps();

    await updateCommunityRecurrence(deps, {
      actorHumanId: ADMIN_ID,
      eventId: EVENT_ID,
      recurrenceSchedule: WEEKLY_SCHEDULE,
    });

    expect(audit.log).toHaveBeenCalledTimes(1);
    const entry = audit.log.mock.calls[0]![0];
    expect(entry.action).toBe("community_listing.recurrence_updated");
    expect(entry.entityId).toBe(EVENT_ID);
    expect(entry.data.actorHumanId).toBe(ADMIN_ID);
    expect(entry.data.scheduledCount).toBeGreaterThanOrEqual(4);
  });

  it("pins Event.startsAt to the first UPCOMING date, never a past SCHEDULED row", async () => {
    const pastStart = new Date("2026-06-01T20:00:00.000Z");
    const firstFutureStart = new Date("2026-08-04T20:00:00.000Z");
    const { deps, applyCommunityEdit } = buildDeps({
      bulkReplaceReturn: ({ eventId }) => [
        {
          id: "past",
          eventId,
          ordinal: 1,
          startsAt: pastStart,
          endsAt: new Date("2026-06-01T22:00:00.000Z"),
          status: "SCHEDULED",
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          id: "future-1",
          eventId,
          ordinal: 2,
          startsAt: firstFutureStart,
          endsAt: new Date("2026-08-04T23:00:00.000Z"),
          status: "SCHEDULED",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    });

    const result = await updateCommunityRecurrence(deps, {
      actorHumanId: MODERATOR_ID,
      eventId: EVENT_ID,
      recurrenceSchedule: WEEKLY_SCHEDULE,
    });

    expect(applyCommunityEdit.mock.calls[0]![0].fields.startsAt?.toISOString()).toBe(
      firstFutureStart.toISOString(),
    );
    expect(result.event.startsAt.getTime()).toBeGreaterThan(pastStart.getTime());
  });

  it("rejects a non-COMMUNITY event with EVENT_NOT_COMMUNITY", async () => {
    const { deps, bulkReplaceForEvent } = buildDeps({ event: makeOrgEvent() });

    await expect(
      updateCommunityRecurrence(deps, {
        actorHumanId: MODERATOR_ID,
        eventId: EVENT_ID,
        recurrenceSchedule: WEEKLY_SCHEDULE,
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_COMMUNITY" });

    expect(bulkReplaceForEvent).not.toHaveBeenCalled();
  });

  // A new rule on a listing that is over would expand fresh SCHEDULED nights
  // onto a page that says it is cancelled, gone or ended.
  it.each([
    ["CANCELLED", "EVENT_ALREADY_CANCELLED"],
    ["ARCHIVED", "EVENT_ARCHIVED"],
    ["COMPLETED", "EVENT_ALREADY_COMPLETED"],
  ] as const)(
    "refuses a %s listing with %s and writes nothing",
    async (status, code) => {
      const { deps, bulkReplaceForEvent, applyCommunityEdit } = buildDeps({
        event: makeCommunityEvent({ timezone: "UTC", status }),
      });

      await expect(
        updateCommunityRecurrence(deps, {
          actorHumanId: MODERATOR_ID,
          eventId: EVENT_ID,
          recurrenceSchedule: WEEKLY_SCHEDULE,
        }),
      ).rejects.toMatchObject({ code });

      expect(bulkReplaceForEvent).not.toHaveBeenCalled();
      expect(applyCommunityEdit).not.toHaveBeenCalled();
    },
  );

  it("a non-moderator on a CANCELLED listing gets STAFF_ONLY, not the status error", async () => {
    const { deps, getById } = buildDeps({
      event: makeCommunityEvent({ timezone: "UTC", status: "CANCELLED" }),
    });

    await expect(
      updateCommunityRecurrence(deps, {
        actorHumanId: USER_ID,
        eventId: EVENT_ID,
        recurrenceSchedule: WEEKLY_SCHEDULE,
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
    expect(getById).not.toHaveBeenCalled();
  });

  it("a throwing post-commit reindex is reported and the edit still succeeds", async () => {
    const { deps } = buildDeps();
    const reportError = vi.fn();
    const boom = new Error("index down");
    // The tx-only repos double has no top-level `events`, and the search port
    // throws: the reindex fails whichever it reaches first.
    const search = {
      ensureIndexes: vi.fn(async () => {
        throw boom;
      }),
      upsertDocuments: vi.fn(async () => {
        throw boom;
      }),
      deleteDocuments: vi.fn(async () => {
        throw boom;
      }),
    } as unknown as NonNullable<UpdateCommunityRecurrenceDeps["search"]>;

    await expect(
      updateCommunityRecurrence(
        { ...deps, search, reportError },
        {
          actorHumanId: MODERATOR_ID,
          eventId: EVENT_ID,
          recurrenceSchedule: WEEKLY_SCHEDULE,
        },
      ),
    ).resolves.toBeTruthy();

    await vi.waitFor(() => expect(reportError).toHaveBeenCalled());
    expect(reportError.mock.calls[0]?.[1]).toMatchObject({
      tags: expect.objectContaining({ useCase: "updateCommunityRecurrence" }),
    });
  });

  it("rejects a missing event with EVENT_NOT_FOUND", async () => {
    const { deps } = buildDeps({ event: null });

    await expect(
      updateCommunityRecurrence(deps, {
        actorHumanId: MODERATOR_ID,
        eventId: EVENT_ID,
        recurrenceSchedule: WEEKLY_SCHEDULE,
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("rejects a non-moderator actor (STAFF_ONLY) before touching the tx", async () => {
    const { deps, getById } = buildDeps();

    await expect(
      updateCommunityRecurrence(deps, {
        actorHumanId: USER_ID,
        eventId: EVENT_ID,
        recurrenceSchedule: WEEKLY_SCHEDULE,
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });

    expect(getById).not.toHaveBeenCalled();
  });

  it("rejects a schedule that yields zero upcoming dates with a typed error", async () => {
    const { deps } = buildDeps();

    await expect(
      updateCommunityRecurrence(deps, {
        actorHumanId: MODERATOR_ID,
        eventId: EVENT_ID,
        recurrenceSchedule: {
          kind: "FIXED_DATES",
          dates: ["2020-01-01T20:00:00", "2020-02-01T20:00:00"],
        },
      }),
    ).rejects.toMatchObject({ code: "RECURRENCE_HAS_NO_UPCOMING_DATES" });
  });

  /**
   * THE NOTIFICATION GAP THIS SUITE EXISTS TO PIN. The moderator confirm
   * dialog promises: "A date that drops off is called off if anyone has
   * RSVP'd — and everyone who did is emailed." A rule change that drops an
   * RSVP'd night must therefore enqueue the SAME `DATE_CANCELLED` outbox row
   * `cancelEventDate` does, in the SAME transaction as the status flip.
   */
  it("enqueues a DATE_CANCELLED notice for everyone holding a live RSVP on a date the rule change dropped", async () => {
    const { deps, createDateCancelled, listHumanIdsForDate } = buildDeps({
      cancelledDateIds: ["dropped-date-1"],
      rsvpsByDateId: { "dropped-date-1": [USER_ID] },
    });

    await updateCommunityRecurrence(deps, {
      actorHumanId: MODERATOR_ID,
      eventId: EVENT_ID,
      recurrenceSchedule: WEEKLY_SCHEDULE,
    });

    expect(listHumanIdsForDate).toHaveBeenCalledWith("dropped-date-1");
    expect(createDateCancelled).toHaveBeenCalledTimes(1);
    expect(createDateCancelled.mock.calls[0]![0]).toEqual({
      eventId: EVENT_ID,
      eventDateId: "dropped-date-1",
      humanIds: [USER_ID],
    });
  });

  it("enqueues nothing when the rule change dropped no RSVP-bearing date", async () => {
    const { deps, createDateCancelled, listHumanIdsForDate } = buildDeps();

    await updateCommunityRecurrence(deps, {
      actorHumanId: MODERATOR_ID,
      eventId: EVENT_ID,
      recurrenceSchedule: WEEKLY_SCHEDULE,
    });

    expect(listHumanIdsForDate).not.toHaveBeenCalled();
    expect(createDateCancelled).not.toHaveBeenCalled();
  });
});

describe("updateCommunityRecurrence lock order", () => {
  it("locks the listing row FOR UPDATE before it reads the listing or rewrites any night", async () => {
    // Event before night, the order every night writer uses
    // (cancel-event-date.ts): this edit rewrites nights and then the row.
    const { deps, lockRows, getById, bulkReplaceForEvent } = buildDeps();

    await updateCommunityRecurrence(deps, {
      actorHumanId: MODERATOR_ID,
      eventId: EVENT_ID,
      recurrenceSchedule: WEEKLY_SCHEDULE,
    });

    expect(lockRows).toHaveBeenCalledWith({ ids: [EVENT_ID], mode: "update" });
    const locked = lockRows.mock.invocationCallOrder[0]!;
    expect(locked).toBeLessThan(getById.mock.invocationCallOrder[0]!);
    expect(locked).toBeLessThan(bulkReplaceForEvent.mock.invocationCallOrder[0]!);
  });
});
