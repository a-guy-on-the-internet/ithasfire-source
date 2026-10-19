import { DateTime } from "luxon";
import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";
import type { EventDateRecord } from "@th/types";

import { cancelEventDate } from "../cancel-event-date";
import { restoreEventDate } from "../restore-event-date";
import {
  ADMIN_ID,
  EVENT_ID,
  MODERATOR_ID,
  USER_ID,
  makeCommunityEvent,
  makeOrgEvent,
  makeStaffAuthz,
} from "./helpers";

/**
 * A NON-UTC zone throughout (standing ruling: RRULE and every recurrence
 * instant is read on a LOCAL basis). Every fixture instant below is built from
 * a wall-clock time in this zone rather than an ISO-Z literal, so nothing here
 * accidentally asserts against UTC arithmetic.
 */
const TZ = "America/Chicago";

/** Wall-clock in TZ → instant. */
const at = (iso: string) => DateTime.fromISO(iso, { zone: TZ }).toJSDate();

/** Wednesday 2026-07-01, 12:00 local — "now" for every case here. */
const NOW = at("2026-07-01T12:00");

const DATE_1 = "d1111111-1111-4111-8111-111111111111";
const DATE_2 = "d2222222-2222-4222-8222-222222222222";
const OTHER_HUMAN = "c0ffee00-0000-4000-8000-000000000001";

function makeDate(overrides: Partial<EventDateRecord> = {}): EventDateRecord {
  return {
    id: DATE_1,
    eventId: EVENT_ID,
    ordinal: 1,
    // Next Wednesday, 20:00 local.
    startsAt: at("2026-07-08T20:00"),
    endsAt: at("2026-07-08T23:00"),
    status: "SCHEDULED",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/**
 * tx fake. `markStatusIf` mutates the in-memory date so a second call in the
 * same test sees the flipped row — which is how the idempotency cases run
 * without hand-waving the state.
 */
function buildDeps(
  opts: {
    date?: EventDateRecord | null;
    event?: EventRecord | null;
    /** Live per-date RSVPs on the date under test. */
    rsvpHumanIds?: string[];
    /** Upcoming SCHEDULED rows the re-pin read finds (excluding the flipped one). */
    remainingScheduled?: EventDateRecord[];
    /** Force the compare-and-set to lose, simulating a concurrent moderator. */
    loseRace?: boolean;
  } = {},
) {
  const date =
    opts.date === undefined ? makeDate() : opts.date ? { ...opts.date } : null;
  const event =
    opts.event === undefined
      ? makeCommunityEvent({
          timezone: TZ,
          // Pinned to the date under test — so cancelling it MUST move the pin.
          startsAt: at("2026-07-08T20:00"),
          endsAt: at("2026-07-08T23:00"),
        })
      : opts.event;

  const getDateById = vi.fn(async () => date);
  const getEventById = vi.fn(async () => event);

  const markStatusIf = vi.fn(
    async (args: {
      id: string;
      expectStatus: "SCHEDULED" | "CANCELLED";
      status: "SCHEDULED" | "CANCELLED";
    }) => {
      if (opts.loseRace) return { updated: false };
      if (!date || date.status !== args.expectStatus) return { updated: false };
      date.status = args.status;
      return { updated: true };
    },
  );

  // The re-pin's read: upcoming SCHEDULED rows, ascending, limit 1. Answered
  // from the fixture list, filtered by the CURRENT status of the flipped row
  // so a restore can put it back into the candidate set.
  const listByEvent = vi.fn(
    async (args: {
      eventId: string;
      from?: Date;
      statuses?: Array<"SCHEDULED" | "CANCELLED">;
      limit?: number;
    }) => {
      const pool = [
        ...(date ? [date] : []),
        ...(opts.remainingScheduled ?? []),
      ];
      return pool
        .filter(
          (row) =>
            (!args.from || row.startsAt.getTime() >= args.from.getTime()) &&
            (!args.statuses || args.statuses.includes(row.status)),
        )
        .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
        .slice(0, args.limit ?? 100);
    },
  );

  const listHumanIdsForDate = vi.fn(async () => opts.rsvpHumanIds ?? []);
  const createDateCancelled = vi.fn(
    async (args: { humanIds: readonly string[] }) => args.humanIds.length,
  );
  const deletePendingDateCancelledForDate = vi.fn(async () => 2);

  const applyCommunityEdit = vi.fn(
    async (args: { eventId: string; fields: { startsAt?: Date; endsAt?: Date } }) => ({
      ...(event as EventRecord),
      startsAt: args.fields.startsAt ?? (event as EventRecord).startsAt,
      endsAt: args.fields.endsAt ?? (event as EventRecord).endsAt,
    }),
  );

  const audit = { log: vi.fn() };

  // The restore locks the listing row before reading it.
  const lockRows = vi.fn(async () => undefined);

  const txRepos = {
    events: { getById: getEventById, applyCommunityEdit, lockRows },
    eventDates: { getById: getDateById, markStatusIf, listByEvent },
    eventDateRsvps: { listHumanIdsForDate },
    rsvpNotices: { createDateCancelled, deletePendingDateCancelledForDate },
    audit,
  };

  const deps = {
    repos: {
      tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txRepos)),
    },
    authz: makeStaffAuthz({
      [MODERATOR_ID]: ["COMMUNITY_MODERATOR"],
      [ADMIN_ID]: ["ADMIN"],
    }),
    clock: { now: () => NOW },
  } as unknown as Parameters<typeof cancelEventDate>[0] &
    Parameters<typeof restoreEventDate>[0];

  return {
    deps,
    date,
    markStatusIf,
    listHumanIdsForDate,
    createDateCancelled,
    deletePendingDateCancelledForDate,
    applyCommunityEdit,
    listByEvent,
    audit,
    lockRows,
    getEventById,
    event,
  };
}

describe("cancelEventDate", () => {
  it("flips ONE date to CANCELLED without deleting the row or its RSVPs", async () => {
    const { deps, date, markStatusIf, createDateCancelled } = buildDeps({
      rsvpHumanIds: [USER_ID, OTHER_HUMAN],
    });

    const result = await cancelEventDate(deps, {
      actorHumanId: MODERATOR_ID,
      eventDateId: DATE_1,
    });

    expect(result.status).toBe("CANCELLED");
    expect(result.changed).toBe(true);
    expect(date!.status).toBe("CANCELLED");
    // The guarded transition, not a blind write.
    expect(markStatusIf).toHaveBeenCalledWith({
      id: DATE_1,
      expectStatus: "SCHEDULED",
      status: "CANCELLED",
    });
    // The whole point: the RSVPs survive, which is what makes the fan-out
    // possible AND what makes a restore possible.
    expect(createDateCancelled).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      eventDateId: DATE_1,
      humanIds: [USER_ID, OTHER_HUMAN],
    });
  });

  it("tells everyone holding a live RSVP — one outbox row each, in the flip's transaction", async () => {
    const { deps, createDateCancelled } = buildDeps({
      rsvpHumanIds: [USER_ID, OTHER_HUMAN],
    });

    const result = await cancelEventDate(deps, {
      actorHumanId: MODERATOR_ID,
      eventDateId: DATE_1,
    });

    expect(result.notifiedCount).toBe(2);
    expect(createDateCancelled).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: cancelling an already-cancelled date succeeds and re-notifies NOBODY", async () => {
    const { deps, createDateCancelled, applyCommunityEdit } = buildDeps({
      rsvpHumanIds: [USER_ID, OTHER_HUMAN],
    });

    const first = await cancelEventDate(deps, {
      actorHumanId: MODERATOR_ID,
      eventDateId: DATE_1,
    });
    // Second press against the now-CANCELLED row.
    const second = await cancelEventDate(deps, {
      actorHumanId: MODERATOR_ID,
      eventDateId: DATE_1,
    });

    expect(first.changed).toBe(true);
    // Succeeds — a double-press is not an error condition.
    expect(second.status).toBe("CANCELLED");
    expect(second.changed).toBe(false);
    expect(second.notifiedCount).toBe(0);
    // Exactly ONE fan-out and ONE re-pin across both calls.
    expect(createDateCancelled).toHaveBeenCalledTimes(1);
    expect(applyCommunityEdit).toHaveBeenCalledTimes(1);
  });

  it("a moderator who LOSES the compare-and-set race notifies nobody and re-pins nothing", async () => {
    // Both moderators read a SCHEDULED row; only one UPDATE matches. The loser
    // must not also fan out, or everyone gets told twice.
    const { deps, createDateCancelled, applyCommunityEdit, audit } = buildDeps({
      loseRace: true,
      rsvpHumanIds: [USER_ID, OTHER_HUMAN],
    });

    const result = await cancelEventDate(deps, {
      actorHumanId: MODERATOR_ID,
      eventDateId: DATE_1,
    });

    expect(result.changed).toBe(false);
    expect(result.notifiedCount).toBe(0);
    expect(createDateCancelled).not.toHaveBeenCalled();
    expect(applyCommunityEdit).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("re-pins Event.startsAt to the next SCHEDULED occurrence when the called-off night was the next one", async () => {
    const next = makeDate({
      id: DATE_2,
      ordinal: 2,
      startsAt: at("2026-07-15T20:00"),
      endsAt: at("2026-07-15T23:00"),
    });
    const { deps, applyCommunityEdit } = buildDeps({
      remainingScheduled: [next],
    });

    const result = await cancelEventDate(deps, {
      actorHumanId: MODERATOR_ID,
      eventDateId: DATE_1,
    });

    expect(result.startsAtRepinned).toBe(true);
    expect(result.drained).toBe(false);
    expect(result.eventStartsAt).toEqual(at("2026-07-15T20:00"));
    expect(applyCommunityEdit).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      fields: {
        startsAt: at("2026-07-15T20:00"),
        endsAt: at("2026-07-15T23:00"),
      },
    });
  });

  it("never re-pins onto a CANCELLED date — it skips to the next SCHEDULED one", async () => {
    // The immediate next occurrence is already off (called off last week).
    const alreadyOff = makeDate({
      id: DATE_2,
      ordinal: 2,
      startsAt: at("2026-07-15T20:00"),
      status: "CANCELLED",
    });
    const live = makeDate({
      id: "d3333333-3333-4333-8333-333333333333",
      ordinal: 3,
      startsAt: at("2026-07-22T20:00"),
      endsAt: at("2026-07-22T23:00"),
    });
    const { deps } = buildDeps({ remainingScheduled: [alreadyOff, live] });

    const result = await cancelEventDate(deps, {
      actorHumanId: MODERATOR_ID,
      eventDateId: DATE_1,
    });

    expect(result.eventStartsAt).toEqual(at("2026-07-22T20:00"));
  });

  it("does NOT touch Event.startsAt when the called-off night was not the next one", async () => {
    const sooner = makeDate({
      id: DATE_2,
      ordinal: 0,
      startsAt: at("2026-07-02T20:00"),
      endsAt: at("2026-07-02T23:00"),
    });
    const { deps, applyCommunityEdit } = buildDeps({
      // The listing is already pinned to the sooner night.
      event: makeCommunityEvent({
        timezone: TZ,
        startsAt: at("2026-07-02T20:00"),
        endsAt: at("2026-07-02T23:00"),
      }),
      remainingScheduled: [sooner],
    });

    const result = await cancelEventDate(deps, {
      actorHumanId: MODERATOR_ID,
      eventDateId: DATE_1,
    });

    expect(result.startsAtRepinned).toBe(false);
    expect(applyCommunityEdit).not.toHaveBeenCalled();
  });

  it("drains the pin off the cancelled instant when NOTHING scheduled remains, so discovery stops advertising it", async () => {
    // The bug this prevents: `startsAt` left on the called-off night means
    // every `startsAt >= now` discovery query keeps selling a night that is
    // off, while the page simultaneously shows it struck through.
    const { deps, applyCommunityEdit } = buildDeps({ remainingScheduled: [] });

    const result = await cancelEventDate(deps, {
      actorHumanId: MODERATOR_ID,
      eventDateId: DATE_1,
    });

    expect(result.drained).toBe(true);
    expect(result.startsAtRepinned).toBe(true);
    expect(result.eventStartsAt).toEqual(NOW);
    // Never still pointing at the night that is off.
    expect(result.eventStartsAt.getTime()).not.toBe(
      at("2026-07-08T20:00").getTime(),
    );
    // Duration preserved, so the top-up job's duration template survives.
    const args = applyCommunityEdit.mock.calls[0]![0];
    expect(
      args.fields.endsAt!.getTime() - args.fields.startsAt!.getTime(),
    ).toBe(3 * 60 * 60 * 1000);
  });

  it("writes an audit row naming the actor, the date and the recipient count", async () => {
    const { deps, audit } = buildDeps({ rsvpHumanIds: [USER_ID] });

    await cancelEventDate(deps, {
      actorHumanId: ADMIN_ID,
      eventDateId: DATE_1,
    });

    expect(audit.log).toHaveBeenCalledTimes(1);
    const entry = audit.log.mock.calls[0]![0];
    expect(entry.action).toBe("community_listing.date_cancelled");
    expect(entry.entityId).toBe(EVENT_ID);
    expect(entry.data.actorHumanId).toBe(ADMIN_ID);
    expect(entry.data.eventDateId).toBe(DATE_1);
    expect(entry.data.notifiedCount).toBe(1);
  });

  it("refuses a non-moderator", async () => {
    const { deps, markStatusIf } = buildDeps();

    await expect(
      cancelEventDate(deps, { actorHumanId: USER_ID, eventDateId: DATE_1 }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
    expect(markStatusIf).not.toHaveBeenCalled();
  });

  it("refuses a date whose startsAt is already past", async () => {
    const { deps, markStatusIf } = buildDeps({
      date: makeDate({ startsAt: at("2026-06-24T20:00") }),
    });

    await expect(
      cancelEventDate(deps, {
        actorHumanId: MODERATOR_ID,
        eventDateId: DATE_1,
      }),
    ).rejects.toMatchObject({ code: "EVENT_DATE_IN_PAST" });
    expect(markStatusIf).not.toHaveBeenCalled();
  });

  it("refuses a date on a non-COMMUNITY event", async () => {
    const { deps } = buildDeps({ event: makeOrgEvent({ timezone: TZ }) });

    await expect(
      cancelEventDate(deps, {
        actorHumanId: MODERATOR_ID,
        eventDateId: DATE_1,
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_COMMUNITY" });
  });

  it("404s a missing date", async () => {
    const { deps } = buildDeps({ date: null });

    await expect(
      cancelEventDate(deps, {
        actorHumanId: MODERATOR_ID,
        eventDateId: DATE_1,
      }),
    ).rejects.toMatchObject({ code: "EVENT_DATE_NOT_FOUND" });
  });

  it("keeps the recipient count OFF the wire (FR-004: no public going-count)", async () => {
    const { deps } = buildDeps({ rsvpHumanIds: [USER_ID, OTHER_HUMAN] });

    const result = await cancelEventDate(deps, {
      actorHumanId: MODERATOR_ID,
      eventDateId: DATE_1,
    });

    // The use case answers with it (audit + logs + these tests)...
    expect(result.notifiedCount).toBe(2);
    // ...and the transport's wire schema strips it.
    const { cancelEventDateWireOutputSchema } = await import(
      "../cancel-event-date"
    );
    const wire = cancelEventDateWireOutputSchema.parse(result);
    expect(wire).not.toHaveProperty("notifiedCount");
    expect(JSON.stringify(wire)).not.toMatch(/count/i);
  });
});

describe("restoreEventDate", () => {
  it("puts a called-off night back to SCHEDULED, RSVPs intact", async () => {
    const { deps, date, markStatusIf } = buildDeps({
      date: makeDate({ status: "CANCELLED" }),
    });

    const result = await restoreEventDate(deps, {
      actorHumanId: MODERATOR_ID,
      eventDateId: DATE_1,
    });

    expect(result.status).toBe("SCHEDULED");
    expect(result.changed).toBe(true);
    expect(date!.status).toBe("SCHEDULED");
    expect(markStatusIf).toHaveBeenCalledWith({
      id: DATE_1,
      expectStatus: "CANCELLED",
      status: "SCHEDULED",
    });
  });

  it("retracts UNDELIVERED cancellation notices — never mails 'it's off' for a night that is back on", async () => {
    const { deps, deletePendingDateCancelledForDate } = buildDeps({
      date: makeDate({ status: "CANCELLED" }),
    });

    const result = await restoreEventDate(deps, {
      actorHumanId: MODERATOR_ID,
      eventDateId: DATE_1,
    });

    expect(deletePendingDateCancelledForDate).toHaveBeenCalledWith(DATE_1);
    expect(result.pendingNoticesRetracted).toBe(2);
  });

  it("re-pins Event.startsAt back onto the restored night when it is the soonest", async () => {
    // A listing drained by the call-off: the pin sits on the call-off instant.
    const { deps, applyCommunityEdit } = buildDeps({
      date: makeDate({ status: "CANCELLED" }),
      event: makeCommunityEvent({
        timezone: TZ,
        startsAt: NOW,
        endsAt: new Date(NOW.getTime() + 3 * 60 * 60 * 1000),
      }),
    });

    const result = await restoreEventDate(deps, {
      actorHumanId: MODERATOR_ID,
      eventDateId: DATE_1,
    });

    expect(result.startsAtRepinned).toBe(true);
    expect(result.eventStartsAt).toEqual(at("2026-07-08T20:00"));
    expect(applyCommunityEdit).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      fields: {
        startsAt: at("2026-07-08T20:00"),
        endsAt: at("2026-07-08T23:00"),
      },
    });
  });

  it("is idempotent: restoring an already-SCHEDULED date succeeds, retracts nothing, re-pins nothing", async () => {
    const { deps, deletePendingDateCancelledForDate, applyCommunityEdit } =
      buildDeps();

    const result = await restoreEventDate(deps, {
      actorHumanId: MODERATOR_ID,
      eventDateId: DATE_1,
    });

    expect(result.status).toBe("SCHEDULED");
    expect(result.changed).toBe(false);
    expect(deletePendingDateCancelledForDate).not.toHaveBeenCalled();
    expect(applyCommunityEdit).not.toHaveBeenCalled();
  });

  it("cancel → restore → cancel notifies the room BOTH times", async () => {
    // The restore deletes the undelivered notices and frees the date to be
    // called off again, so a second genuine call-off is a second genuine
    // message — not swallowed by an over-eager "told once" guard.
    const { deps, createDateCancelled } = buildDeps({
      rsvpHumanIds: [USER_ID, OTHER_HUMAN],
    });

    await cancelEventDate(deps, {
      actorHumanId: MODERATOR_ID,
      eventDateId: DATE_1,
    });
    await restoreEventDate(deps, {
      actorHumanId: MODERATOR_ID,
      eventDateId: DATE_1,
    });
    const third = await cancelEventDate(deps, {
      actorHumanId: MODERATOR_ID,
      eventDateId: DATE_1,
    });

    expect(third.changed).toBe(true);
    expect(third.notifiedCount).toBe(2);
    expect(createDateCancelled).toHaveBeenCalledTimes(2);
  });

  it("refuses a non-moderator", async () => {
    const { deps, markStatusIf } = buildDeps({
      date: makeDate({ status: "CANCELLED" }),
    });

    await expect(
      restoreEventDate(deps, { actorHumanId: USER_ID, eventDateId: DATE_1 }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
    expect(markStatusIf).not.toHaveBeenCalled();
  });

  it("refuses a date whose startsAt is already past", async () => {
    const { deps } = buildDeps({
      date: makeDate({ status: "CANCELLED", startsAt: at("2026-06-24T20:00") }),
    });

    await expect(
      restoreEventDate(deps, {
        actorHumanId: MODERATOR_ID,
        eventDateId: DATE_1,
      }),
    ).rejects.toMatchObject({ code: "EVENT_DATE_IN_PAST" });
  });

  it.each([
    ["CANCELLED", "EVENT_ALREADY_CANCELLED"],
    ["ARCHIVED", "EVENT_ARCHIVED"],
    // Completing calls nights off the same way (owner ruling 2026-10-16, Q5).
    ["COMPLETED", "EVENT_ALREADY_COMPLETED"],
  ] as const)(
    "refuses a night on a %s listing (%s), and keeps its pending notices",
    async (status, code) => {
      // The take-down hangs each person's ONE "listing cancelled" notice on
      // their earliest night; restoring that night would retract it.
      const { deps, markStatusIf, deletePendingDateCancelledForDate } = buildDeps({
        date: makeDate({ status: "CANCELLED" }),
        event: makeCommunityEvent({ timezone: TZ, status }),
      });

      await expect(
        restoreEventDate(deps, {
          actorHumanId: MODERATOR_ID,
          eventDateId: DATE_1,
        }),
      ).rejects.toMatchObject({ code });
      expect(markStatusIf).not.toHaveBeenCalled();
      expect(deletePendingDateCancelledForDate).not.toHaveBeenCalled();
    },
  );

  it("puts a DRAFT listing's called-off night back (a draft's night can be called off, so it can come back)", async () => {
    const { deps, date } = buildDeps({
      date: makeDate({ status: "CANCELLED" }),
      event: makeCommunityEvent({ timezone: TZ, status: "DRAFT" }),
    });

    const result = await restoreEventDate(deps, {
      actorHumanId: MODERATOR_ID,
      eventDateId: DATE_1,
    });

    expect(result.changed).toBe(true);
    expect(date!.status).toBe("SCHEDULED");
  });

  it("keeps the retracted-notice count OFF the wire", async () => {
    const { deps } = buildDeps({ date: makeDate({ status: "CANCELLED" }) });

    const result = await restoreEventDate(deps, {
      actorHumanId: MODERATOR_ID,
      eventDateId: DATE_1,
    });

    const { restoreEventDateWireOutputSchema } = await import(
      "../restore-event-date"
    );
    const wire = restoreEventDateWireOutputSchema.parse(result);
    expect(wire).not.toHaveProperty("pendingNoticesRetracted");
  });

  it("locks the listing row FOR UPDATE before it reads the listing's status", async () => {
    const { deps, lockRows, getEventById } = buildDeps({
      date: makeDate({ status: "CANCELLED" }),
    });

    await restoreEventDate(deps, {
      actorHumanId: MODERATOR_ID,
      eventDateId: DATE_1,
    });

    expect(lockRows).toHaveBeenCalledWith({ ids: [EVENT_ID], mode: "update" });
    expect(lockRows.mock.invocationCallOrder[0]).toBeLessThan(
      getEventById.mock.invocationCallOrder[0]!,
    );
  });

  it.each([
    ["COMPLETED", "EVENT_ALREADY_COMPLETED"],
    ["CANCELLED", "EVENT_ALREADY_CANCELLED"],
    ["ARCHIVED", "EVENT_ARCHIVED"],
  ] as const)(
    "a take-down that commits while the restore waits on the lock (%s) is refused: no CAS, the notice stays",
    async (status, code) => {
      // The race: the listing was PUBLISHED when the restore started; a
      // whole-listing call-off held the row and committed, hanging Alice's
      // one notice on this night. The lock is where the restore waited.
      const {
        deps,
        lockRows,
        getEventById,
        event,
        markStatusIf,
        deletePendingDateCancelledForDate,
      } = buildDeps({
        date: makeDate({ status: "CANCELLED" }),
        event: makeCommunityEvent({ timezone: TZ, status: "PUBLISHED" }),
      });
      // Each read is a snapshot of the row as it stands at that moment.
      getEventById.mockImplementation(async () => ({ ...(event as EventRecord) }));
      lockRows.mockImplementationOnce(async () => {
        (event as { status: string }).status = status;
      });

      await expect(
        restoreEventDate(deps, {
          actorHumanId: MODERATOR_ID,
          eventDateId: DATE_1,
        }),
      ).rejects.toMatchObject({ code });
      expect(markStatusIf).not.toHaveBeenCalled();
      expect(deletePendingDateCancelledForDate).not.toHaveBeenCalled();
    },
  );
});

describe("cancelEventDate lock order", () => {
  it("locks the listing row FOR UPDATE before it reads the listing or flips the night", async () => {
    // Event before night, the order restore and the take-downs use: this
    // call-off re-pins Event after the flip, so the reverse would deadlock.
    const { deps, lockRows, getEventById, markStatusIf } = buildDeps();

    await cancelEventDate(deps, {
      actorHumanId: MODERATOR_ID,
      eventDateId: DATE_1,
    });

    expect(lockRows).toHaveBeenCalledWith({ ids: [EVENT_ID], mode: "update" });
    const locked = lockRows.mock.invocationCallOrder[0]!;
    expect(locked).toBeLessThan(getEventById.mock.invocationCallOrder[0]!);
    expect(locked).toBeLessThan(markStatusIf.mock.invocationCallOrder[0]!);
  });
});
