import { DateTime } from "luxon";
import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";
import type { EventDateRecord, EventDateRsvpRecord } from "@th/types";

import {
  rsvpToEventDate,
  type RsvpToEventDateDeps,
} from "../rsvp-to-event-date";
import {
  cancelEventDateRsvp,
  type CancelEventDateRsvpDeps,
} from "../cancel-event-date-rsvp";
import { listEventDates, type ListEventDatesDeps } from "../list-event-dates";
import {
  EVENT_ID,
  NOW,
  USER_ID,
  makeCommunityEvent,
  makeOrgEvent,
  makeStaffAuthz,
} from "./helpers";

const DATE_ID = "dddddddd-1111-4111-8111-dddddddddddd";
const RSVP_ID = "eeeeeeee-2222-4222-8222-eeeeeeeeeeee";

/** A future SCHEDULED occurrence of EVENT_ID (after NOW = 2026-07-01). */
function makeEventDate(overrides: Partial<EventDateRecord> = {}): EventDateRecord {
  return {
    id: DATE_ID,
    eventId: EVENT_ID,
    ordinal: 1,
    startsAt: new Date("2026-08-01T20:00:00.000Z"),
    endsAt: new Date("2026-08-01T23:00:00.000Z"),
    status: "SCHEDULED",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeRsvp(
  overrides: Partial<EventDateRsvpRecord> = {},
): EventDateRsvpRecord {
  return {
    id: RSVP_ID,
    eventDateId: DATE_ID,
    humanId: USER_ID,
    createdAt: NOW,
    ...overrides,
  };
}

function buildDeps(opts: {
  date?: EventDateRecord | null;
  event?: EventRecord | null;
  rsvpedDateIds?: string[];
  /** Dates ANYONE has RSVP'd — the moderator view's presence set. */
  datesWithAnyRsvp?: string[];
  /** Staff roles by human id, for the moderator view's gate. */
  staffRoles?: Record<string, string[]>;
  upcoming?: EventDateRecord[];
  created?: boolean;
} = {}) {
  const date = opts.date === undefined ? makeEventDate() : opts.date;
  const event = opts.event === undefined ? makeCommunityEvent() : opts.event;

  const upsert = vi.fn(async () => ({
    record: makeRsvp(),
    created: opts.created ?? true,
  }));
  const del = vi.fn(async () => undefined);
  const listDateIdsForHuman = vi.fn(async () => opts.rsvpedDateIds ?? []);
  const listDateIdsWithAnyRsvp = vi.fn(async () => opts.datesWithAnyRsvp ?? []);
  const listUpcoming = vi.fn(async () => opts.upcoming ?? []);
  const getDateById = vi.fn(async () => date);
  const getEventById = vi.fn(async () => event);
  const createNotice = vi.fn(async () => ({
    id: "nnnnnnnn-1111-4111-8111-nnnnnnnnnnnn",
    eventId: EVENT_ID,
    eventDateId: DATE_ID,
    humanId: USER_ID,
    createdAt: NOW,
    dispatchedAt: null,
    attempts: 0,
  }));

  const repos = {
    events: { getById: getEventById },
    eventDates: { getById: getDateById, listUpcoming },
    eventDateRsvps: {
      upsert,
      delete: del,
      listDateIdsForHuman,
      listDateIdsWithAnyRsvp,
    },
    rsvpNotices: { create: createNotice },
  };

  const reportError = vi.fn();
  const authz = makeStaffAuthz(opts.staffRoles ?? {});

  const deps = {
    repos,
    clock: { now: () => NOW },
    authz,
    reportError,
  } as unknown as RsvpToEventDateDeps &
    CancelEventDateRsvpDeps &
    ListEventDatesDeps;

  return {
    deps,
    upsert,
    del,
    listDateIdsForHuman,
    listDateIdsWithAnyRsvp,
    listUpcoming,
    createNotice,
    getEventById,
    reportError,
    authz,
  };
}

describe("rsvpToEventDate", () => {
  it("RSVPs idempotently via upsert — confirmation enqueued ONLY for the fresh RSVP", async () => {
    const { deps, upsert, createNotice } = buildDeps();
    // First press creates the row; the re-press reads it back (created: false).
    upsert
      .mockResolvedValueOnce({ record: makeRsvp(), created: true })
      .mockResolvedValueOnce({ record: makeRsvp(), created: false });

    const first = await rsvpToEventDate(deps, {
      actorHumanId: USER_ID,
      eventDateId: DATE_ID,
    });
    const second = await rsvpToEventDate(deps, {
      actorHumanId: USER_ID,
      eventDateId: DATE_ID,
    });

    expect(first.rsvp.id).toBe(second.rsvp.id);
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenCalledWith({
      eventDateId: DATE_ID,
      humanId: USER_ID,
    });
    // Exactly ONE outbox row despite two presses — no duplicate confirmation.
    // The notice carries the DATE id so the drain confirms the occurrence.
    expect(createNotice).toHaveBeenCalledTimes(1);
    expect(createNotice).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      eventDateId: DATE_ID,
      humanId: USER_ID,
    });
  });

  it("does not enqueue a confirmation on an idempotent re-RSVP (created: false)", async () => {
    const { deps, createNotice } = buildDeps({ created: false });

    const result = await rsvpToEventDate(deps, {
      actorHumanId: USER_ID,
      eventDateId: DATE_ID,
    });

    expect(result.rsvp.id).toBe(RSVP_ID);
    expect(createNotice).not.toHaveBeenCalled();
  });

  it("a failed confirmation enqueue never fails the RSVP (best-effort)", async () => {
    const { deps, createNotice } = buildDeps();
    createNotice.mockRejectedValueOnce(new Error("outbox table on fire"));

    // The RSVP row was written; a missed confirmation beats a failed RSVP.
    const result = await rsvpToEventDate(deps, {
      actorHumanId: USER_ID,
      eventDateId: DATE_ID,
    });

    expect(result.rsvp.id).toBe(RSVP_ID);
    expect(createNotice).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing date with EVENT_DATE_NOT_FOUND", async () => {
    const { deps, upsert } = buildDeps({ date: null });

    await expect(
      rsvpToEventDate(deps, { actorHumanId: USER_ID, eventDateId: DATE_ID }),
    ).rejects.toMatchObject({ code: "EVENT_DATE_NOT_FOUND" });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejects a missing parent event with EVENT_NOT_FOUND (delete race)", async () => {
    const { deps } = buildDeps({ event: null });

    await expect(
      rsvpToEventDate(deps, { actorHumanId: USER_ID, eventDateId: DATE_ID }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("rejects a non-published event with EVENT_NOT_PUBLISHED", async () => {
    const { deps } = buildDeps({
      event: makeCommunityEvent({ status: "CANCELLED" }),
    });

    await expect(
      rsvpToEventDate(deps, { actorHumanId: USER_ID, eventDateId: DATE_ID }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_PUBLISHED" });
  });

  it("rejects a non-public event with EVENT_NOT_PUBLISHED", async () => {
    const { deps } = buildDeps({
      event: makeCommunityEvent({ visibility: "PRIVATE" }),
    });

    await expect(
      rsvpToEventDate(deps, { actorHumanId: USER_ID, eventDateId: DATE_ID }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_PUBLISHED" });
  });

  it("rejects a TICKETED event with EVENT_NOT_COMMUNITY", async () => {
    const { deps, upsert } = buildDeps({ event: makeOrgEvent() });

    await expect(
      rsvpToEventDate(deps, { actorHumanId: USER_ID, eventDateId: DATE_ID }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_COMMUNITY" });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejects a CANCELLED date with EVENT_DATE_NOT_RSVPABLE", async () => {
    const { deps, upsert } = buildDeps({
      date: makeEventDate({ status: "CANCELLED" }),
    });

    await expect(
      rsvpToEventDate(deps, { actorHumanId: USER_ID, eventDateId: DATE_ID }),
    ).rejects.toMatchObject({ code: "EVENT_DATE_NOT_RSVPABLE" });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejects a past date with EVENT_DATE_IN_PAST", async () => {
    const { deps, upsert } = buildDeps({
      date: makeEventDate({
        startsAt: new Date("2026-06-01T20:00:00.000Z"), // before NOW
      }),
    });

    await expect(
      rsvpToEventDate(deps, { actorHumanId: USER_ID, eventDateId: DATE_ID }),
    ).rejects.toMatchObject({ code: "EVENT_DATE_IN_PAST" });
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("cancelEventDateRsvp", () => {
  it("un-RSVPs idempotently with no state gating (repeat cancels are no-ops)", async () => {
    const { deps, del } = buildDeps();

    await expect(
      cancelEventDateRsvp(deps, { actorHumanId: USER_ID, eventDateId: DATE_ID }),
    ).resolves.toEqual({ ok: true });
    await expect(
      cancelEventDateRsvp(deps, { actorHumanId: USER_ID, eventDateId: DATE_ID }),
    ).resolves.toEqual({ ok: true });

    expect(del).toHaveBeenCalledTimes(2);
    expect(del).toHaveBeenCalledWith({
      eventDateId: DATE_ID,
      humanId: USER_ID,
    });
  });
});

describe("listEventDates", () => {
  const DATE_A_ID = "aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa";
  const DATE_B_ID = "bbbbbbbb-3333-4333-8333-bbbbbbbbbbbb";
  const DATE_A = makeEventDate({ id: DATE_A_ID, ordinal: 1 });
  const DATE_B = makeEventDate({
    id: DATE_B_ID,
    ordinal: 2,
    startsAt: new Date("2026-08-08T20:00:00.000Z"),
  });

  it("seeds viewerRsvped ONLY for the viewer's own dates; exposes no count", async () => {
    const { deps, listDateIdsForHuman } = buildDeps({
      upcoming: [DATE_A, DATE_B],
      rsvpedDateIds: [DATE_B_ID],
    });

    const result = await listEventDates(deps, {
      eventId: EVENT_ID,
      viewerHumanId: USER_ID,
    });

    expect(listDateIdsForHuman).toHaveBeenCalledWith({
      humanId: USER_ID,
      eventDateIds: [DATE_A_ID, DATE_B_ID],
    });
    expect(result.dates).toEqual([
      {
        eventDateId: DATE_A_ID,
        startsAt: DATE_A.startsAt,
        endsAt: DATE_A.endsAt,
        viewerRsvped: false,
        status: "SCHEDULED",
      },
      {
        eventDateId: DATE_B_ID,
        startsAt: DATE_B.startsAt,
        endsAt: DATE_B.endsAt,
        viewerRsvped: true,
        status: "SCHEDULED",
      },
    ]);
    // FR-004: no public going-count anywhere in the output.
    expect(JSON.stringify(result)).not.toMatch(/count/i);
  });

  it("returns all viewerRsvped=false for an anonymous viewer without querying RSVPs", async () => {
    const { deps, listDateIdsForHuman } = buildDeps({
      upcoming: [DATE_A, DATE_B],
    });

    const result = await listEventDates(deps, { eventId: EVENT_ID });

    expect(listDateIdsForHuman).not.toHaveBeenCalled();
    expect(result.dates.every((d) => d.viewerRsvped === false)).toBe(true);
  });

  // ── moderator view: per-date RSVP PRESENCE ──────────────────────────────
  //
  // FR-004 forbids a going-count. What a moderator gets, and only a moderator,
  // is whether ANYONE holds an RSVP on each date — the fact the reconcile acts
  // on when a rule change drops the date. Gated in this use case, not at the
  // transport, so no procedure can forward the flag ungated.
  describe("moderatorView", () => {
    const MODERATOR_ID = "cccccccc-4444-4444-8444-cccccccccccc";

    it("adds hasRsvp per date for a community moderator — a boolean, never a count", async () => {
      const { deps, listDateIdsWithAnyRsvp } = buildDeps({
        upcoming: [DATE_A, DATE_B],
        datesWithAnyRsvp: [DATE_B_ID],
        staffRoles: { [MODERATOR_ID]: ["COMMUNITY_MODERATOR"] },
      });

      const result = await listEventDates(deps, {
        eventId: EVENT_ID,
        viewerHumanId: MODERATOR_ID,
        moderatorView: true,
      });

      expect(listDateIdsWithAnyRsvp).toHaveBeenCalledWith([DATE_A_ID, DATE_B_ID]);
      expect(result.dates.map((d) => [d.eventDateId, d.hasRsvp])).toEqual([
        [DATE_A_ID, false],
        [DATE_B_ID, true],
      ]);
      // Still no going-count anywhere.
      expect(JSON.stringify(result)).not.toMatch(/count/i);
    });

    it("a platform ADMIN passes the same gate", async () => {
      const { deps } = buildDeps({
        upcoming: [DATE_A],
        staffRoles: { [MODERATOR_ID]: ["ADMIN"] },
      });

      const result = await listEventDates(deps, {
        eventId: EVENT_ID,
        viewerHumanId: MODERATOR_ID,
        moderatorView: true,
      });

      expect(result.dates[0]?.hasRsvp).toBe(false);
    });

    it("refuses a signed-in non-moderator with STAFF_ONLY before any read", async () => {
      const { deps, listDateIdsWithAnyRsvp, listUpcoming } = buildDeps({
        upcoming: [DATE_A],
        datesWithAnyRsvp: [DATE_A_ID],
        staffRoles: { [USER_ID]: ["REVIEWER"] },
      });

      await expect(
        listEventDates(deps, {
          eventId: EVENT_ID,
          viewerHumanId: USER_ID,
          moderatorView: true,
        }),
      ).rejects.toMatchObject({ code: "STAFF_ONLY" });
      expect(listDateIdsWithAnyRsvp).not.toHaveBeenCalled();
      expect(listUpcoming).not.toHaveBeenCalled();
    });

    it("refuses an anonymous caller with STAFF_ONLY — never a blank field", async () => {
      const { deps, listDateIdsWithAnyRsvp } = buildDeps({ upcoming: [DATE_A] });

      await expect(
        listEventDates(deps, { eventId: EVENT_ID, moderatorView: true }),
      ).rejects.toMatchObject({ code: "STAFF_ONLY" });
      expect(listDateIdsWithAnyRsvp).not.toHaveBeenCalled();
    });

    it("refuses the flag when no authz is wired, even for a would-be moderator", async () => {
      const { deps } = buildDeps({
        upcoming: [DATE_A],
        staffRoles: { [MODERATOR_ID]: ["ADMIN"] },
      });
      delete (deps as { authz?: unknown }).authz;

      await expect(
        listEventDates(deps, {
          eventId: EVENT_ID,
          viewerHumanId: MODERATOR_ID,
          moderatorView: true,
        }),
      ).rejects.toMatchObject({ code: "STAFF_ONLY" });
    });

    it("leaves hasRsvp ABSENT (not false) and reads no presence outside the moderator view", async () => {
      const { deps, listDateIdsWithAnyRsvp } = buildDeps({
        upcoming: [DATE_A],
        datesWithAnyRsvp: [DATE_A_ID],
        staffRoles: { [MODERATOR_ID]: ["ADMIN"] },
      });

      const result = await listEventDates(deps, {
        eventId: EVENT_ID,
        viewerHumanId: MODERATOR_ID,
      });

      expect(listDateIdsWithAnyRsvp).not.toHaveBeenCalled();
      expect("hasRsvp" in result.dates[0]!).toBe(false);
    });
  });

  // ── recurrence summary ────────────────────────────────────────────────────
  //
  // The cadence line ("Every Wednesday, 8:00 PM") the public page leads with.
  // It is DECORATION: it may never alter `dates`, and it may never throw —
  // this read is on the event page's critical path. `makeCommunityEvent`'s
  // timezone is America/Chicago, which is the point (standing ruling: RRULE is
  // evaluated on a LOCAL basis, so a UTC-only test hides real bugs).
  describe("recurrence", () => {
    /** A Wednesday 20:00 in Chicago == 01:00 Thursday in UTC. */
    const WEEKLY_WEDNESDAY = {
      kind: "RRULE" as const,
      rrule: "FREQ=WEEKLY;BYDAY=WE",
      dtstart: "2026-09-09T20:00:00-05:00",
    };

    it("summarises the stored RRULE alongside the dates", async () => {
      const { deps, getEventById } = buildDeps({
        upcoming: [DATE_A, DATE_B],
        event: makeCommunityEvent({ recurrenceSchedule: WEEKLY_WEDNESDAY }),
      });

      const result = await listEventDates(deps, { eventId: EVENT_ID });

      expect(getEventById).toHaveBeenCalledWith(EVENT_ID);
      expect(result.recurrence).toEqual({
        freq: "WEEKLY",
        interval: 1,
        // WE, not TH — the rule is read on the event's LOCAL calendar.
        byday: ["WE"],
        until: null,
      });
      // Decoration only: the dates are untouched.
      expect(result.dates.map((d) => d.eventDateId)).toEqual([
        DATE_A_ID,
        DATE_B_ID,
      ]);
    });

    it("parses UNTIL into a real instant on the event's local clock", async () => {
      const { deps } = buildDeps({
        upcoming: [DATE_A],
        event: makeCommunityEvent({
          recurrenceSchedule: {
            ...WEEKLY_WEDNESDAY,
            until: "2026-12-30T23:59:00",
          },
        }),
      });

      const result = await listEventDates(deps, { eventId: EVENT_ID });

      // 23:59 local on Dec 30 in Chicago (CST) is 05:59Z on Dec 31.
      expect(result.recurrence?.until?.toISOString()).toBe(
        "2026-12-31T05:59:00.000Z",
      );
    });

    it("carries an interval > 1 (every other week)", async () => {
      const { deps } = buildDeps({
        upcoming: [DATE_A],
        event: makeCommunityEvent({
          recurrenceSchedule: {
            ...WEEKLY_WEDNESDAY,
            rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=WE",
          },
        }),
      });

      expect((await listEventDates(deps, { eventId: EVENT_ID })).recurrence)
        .toEqual({ freq: "WEEKLY", interval: 2, byday: ["WE"], until: null });
    });

    it("summarises a monthly rule", async () => {
      const { deps } = buildDeps({
        upcoming: [DATE_A],
        event: makeCommunityEvent({
          recurrenceSchedule: {
            kind: "RRULE",
            rrule: "FREQ=MONTHLY;BYDAY=WE;BYSETPOS=2",
            dtstart: "2026-09-09T20:00:00-05:00",
          },
        }),
      });

      expect((await listEventDates(deps, { eventId: EVENT_ID })).recurrence)
        .toEqual({ freq: "MONTHLY", interval: 1, byday: ["WE"], until: null });
    });

    // ── the stored rule itself ─────────────────────────────────────────────
    //
    // The summary is lossy on purpose, and that is exactly why an EDITOR must
    // not be seeded from it: `COUNT=20` summarises as open-ended, a "second
    // Wednesday" as every Wednesday, and a widened rule drops no dates, so a
    // consequence preview built on it reads clean while Apply rewrites the
    // series. `storedRule` hands the editor the truth, verbatim.
    it("hands back the stored rule, beside the summary that lost its COUNT", async () => {
      const { deps } = buildDeps({
        upcoming: [DATE_A],
        event: makeCommunityEvent({
          recurrenceSchedule: {
            kind: "RRULE",
            rrule: "FREQ=WEEKLY;BYDAY=WE;COUNT=20",
            dtstart: "2026-09-09T20:00:00-05:00",
          },
        }),
      });

      const result = await listEventDates(deps, { eventId: EVENT_ID });

      expect(result.storedRule).toEqual({
        rrule: "FREQ=WEEKLY;BYDAY=WE;COUNT=20",
        // The anchor as a UTC instant: Wed 20:00 Central is 01:00Z Thursday.
        dtstart: "2026-09-10T01:00:00.000Z",
        until: null,
      });
      // The phrasebook still reports the bounded run as open-ended — the loss
      // the raw rule exists to get around.
      expect(result.recurrence?.until).toBeNull();
    });

    it("carries the schedule's own UNTIL bound through, as an instant on the event's clock", async () => {
      const { deps } = buildDeps({
        upcoming: [DATE_A],
        event: makeCommunityEvent({
          recurrenceSchedule: {
            kind: "RRULE",
            rrule: "FREQ=MONTHLY;BYDAY=WE;BYSETPOS=2",
            dtstart: "2026-09-09T20:00:00-05:00",
            until: "2026-12-30T23:59:00",
          },
        }),
      });

      const result = await listEventDates(deps, { eventId: EVENT_ID });

      expect(result.storedRule).toEqual({
        rrule: "FREQ=MONTHLY;BYDAY=WE;BYSETPOS=2",
        dtstart: "2026-09-10T01:00:00.000Z",
        // A bare wall clock is read in America/Chicago (CST by December), the
        // same way expansion reads it — never in the server's or browser's zone.
        until: "2026-12-31T05:59:00.000Z",
      });
      // And the summary has dropped the ordinal, as documented.
      expect(result.recurrence?.freq).toBe("MONTHLY");
    });

    it("reads a bare dtstart in the EVENT's zone and keeps seconds an API caller stored", async () => {
      const { deps } = buildDeps({
        upcoming: [DATE_A],
        event: makeCommunityEvent({
          recurrenceSchedule: {
            kind: "RRULE",
            rrule: "FREQ=WEEKLY;BYDAY=WE",
            dtstart: "2026-09-09T20:00:30",
          },
        }),
      });

      const result = await listEventDates(deps, { eventId: EVENT_ID });

      expect(result.storedRule?.dtstart).toBe("2026-09-10T01:00:30.000Z");
    });

    it("drops an unparseable UNTIL (expansion ignores it too) but keeps the rule", async () => {
      const { deps } = buildDeps({
        upcoming: [DATE_A],
        event: makeCommunityEvent({
          recurrenceSchedule: {
            kind: "RRULE",
            rrule: "FREQ=WEEKLY;BYDAY=WE",
            dtstart: "2026-09-09T20:00:00-05:00",
            until: "end of the year",
          },
        }),
      });

      const result = await listEventDates(deps, { eventId: EVENT_ID });

      expect(result.storedRule).toEqual({
        rrule: "FREQ=WEEKLY;BYDAY=WE",
        dtstart: "2026-09-10T01:00:00.000Z",
        until: null,
      });
    });

    for (const [label, recurrenceSchedule] of [
      ["no schedule at all", null],
      [
        "a FIXED_DATES schedule (nothing an editor can prefill)",
        { kind: "FIXED_DATES", dates: ["2026-09-09T20:00:00-05:00"] },
      ],
      ["an RRULE schedule missing its dtstart", { kind: "RRULE", rrule: "FREQ=WEEKLY" }],
      [
        "an RRULE schedule whose dtstart does not parse",
        { kind: "RRULE", rrule: "FREQ=WEEKLY", dtstart: "next wednesday" },
      ],
      ["an RRULE schedule with an empty rule", { kind: "RRULE", rrule: "", dtstart: "2026-09-09T20:00:00-05:00" }],
    ] as const) {
      it(`reports storedRule: null for ${label}`, async () => {
        const { deps } = buildDeps({
          upcoming: [DATE_A],
          event: makeCommunityEvent({
            recurrenceSchedule: recurrenceSchedule as never,
          }),
        });

        const result = await listEventDates(deps, { eventId: EVENT_ID });

        expect(result.storedRule).toBeNull();
      });
    }

    it("reports storedRule: null when the caller skipped the Event read", async () => {
      const { deps, getEventById } = buildDeps({
        upcoming: [DATE_A],
        event: makeCommunityEvent({
          recurrenceSchedule: {
            kind: "RRULE",
            rrule: "FREQ=WEEKLY;BYDAY=WE",
            dtstart: "2026-09-09T20:00:00-05:00",
          },
        }),
      });

      const result = await listEventDates(deps, {
        eventId: EVENT_ID,
        includeRecurrence: false,
      });

      expect(getEventById).not.toHaveBeenCalled();
      expect(result.storedRule).toBeNull();
    });

    for (const [label, recurrenceSchedule] of [
      ["no schedule at all", null],
      [
        "a FIXED_DATES schedule",
        { kind: "FIXED_DATES", dates: ["2026-09-09T20:00:00-05:00"] },
      ],
      ["an unparseable rrule", { kind: "RRULE", rrule: "FREQ=NONSENSE" }],
      ["garbage in the column", "every wednesday, probably"],
    ] as const) {
      it(`reports recurrence: null for ${label}, leaving the dates intact`, async () => {
        const { deps, reportError } = buildDeps({
          upcoming: [DATE_A],
          event: makeCommunityEvent({
            recurrenceSchedule: recurrenceSchedule as never,
          }),
        });

        const result = await listEventDates(deps, { eventId: EVENT_ID });

        expect(result.recurrence).toBeNull();
        expect(result.dates).toHaveLength(1);
        // Data we cannot phrase is not a fault — nothing to report.
        expect(reportError).not.toHaveBeenCalled();
      });
    }

    it("reports recurrence: null for a missing event without reporting a fault", async () => {
      const { deps, reportError } = buildDeps({
        upcoming: [DATE_A],
        event: null,
      });

      const result = await listEventDates(deps, { eventId: EVENT_ID });

      expect(result.recurrence).toBeNull();
      expect(result.dates).toHaveLength(1);
      expect(reportError).not.toHaveBeenCalled();
    });

    it("degrades to null AND reports when the event read throws", async () => {
      // Without the reporter this swallow would hide a broken schedule read
      // behind a page that looks fine (the Jun 2026 silent-search-outage
      // shape). The dates must still come back.
      const { deps, getEventById, reportError } = buildDeps({
        upcoming: [DATE_A],
      });
      getEventById.mockRejectedValueOnce(new Error("events table on fire"));

      const result = await listEventDates(deps, { eventId: EVENT_ID });

      expect(result.recurrence).toBeNull();
      expect(result.dates).toHaveLength(1);
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError.mock.calls[0]![0]).toBeInstanceOf(Error);
      expect(reportError.mock.calls[0]![1]).toMatchObject({
        tags: { useCase: "listEventDates", step: "recurrenceSummary" },
        extra: { eventId: EVENT_ID },
      });
    });

    it("a throwing reporter still yields the dates (reporting is best-effort)", async () => {
      const { deps, getEventById, reportError } = buildDeps({
        upcoming: [DATE_A],
      });
      getEventById.mockRejectedValueOnce(new Error("events table on fire"));
      reportError.mockImplementation(() => {
        throw new Error("sentry is down too");
      });

      const result = await listEventDates(deps, { eventId: EVENT_ID });

      expect(result.recurrence).toBeNull();
      expect(result.dates).toHaveLength(1);
    });
  });

  // ── truncated ─────────────────────────────────────────────────────────────
  //
  // Whether `dates` runs to the END of the series. The list is capped twice
  // (MAX_DATES rows, and materialisation's own 60-occurrence / 12-month
  // window), and the caller can see NEITHER cap — so without this flag a page
  // renders the server's caps as the organizer's schedule: an open-ended weekly
  // open mic came back as 52 rows covering a year and read as "52 dates through
  // Sep 2027", which the series does not do. NOW is 2026-07-01, so the
  // materialisation window ends 2027-07-01.
  describe("truncated", () => {
    /** `makeCommunityEvent`'s zone — the LOCAL basis every expansion is read on. */
    const TZ = "America/Chicago";

    /** Row i of a materialised expansion: a stable id, no endsAt. */
    function makeRow(i: number, startsAt: DateTime): EventDateRecord {
      return makeEventDate({
        id: `dddddddd-1111-4111-8111-${String(i).padStart(12, "0")}`,
        ordinal: i + 1,
        startsAt: startsAt.toUTC().toJSDate(),
        endsAt: null,
      });
    }

    /**
     * `count` consecutive Wednesdays at 20:00 America/Chicago, as
     * materialisation writes them: 20:00 LOCAL every week, so the INSTANTS step
     * by 167h across the November DST boundary, not a flat 168h. Truncation is
     * answered by re-expanding the RULE from the last row, so a fixture that
     * drifts an hour off its own rule in November asks the probe a question no
     * real row ever asks.
     */
    function makeWeeklyDates(count: number): EventDateRecord[] {
      const first = DateTime.fromISO("2026-07-08T20:00", { zone: TZ });
      return Array.from({ length: count }, (_, i) =>
        makeRow(i, first.plus({ weeks: i })),
      );
    }

    /**
     * `count` consecutive Mon–Fri occurrences at 18:00 America/Chicago from Mon
     * 2026-07-06 — the dense bounded cadence the builder emits for "Weekly,
     * every 1 week, Mon–Fri": ~145 occurrences over nine months, of which
     * materialisation writes at most MAX_DATES.
     */
    function makeBusinessDayDates(count: number): EventDateRecord[] {
      const rows: EventDateRecord[] = [];
      let day = DateTime.fromISO("2026-07-06T18:00", { zone: TZ });
      while (rows.length < count) {
        if (day.weekday <= 5) rows.push(makeRow(rows.length, day));
        day = day.plus({ days: 1 });
      }
      return rows;
    }

    const WEEKLY_WEDNESDAY = {
      kind: "RRULE" as const,
      rrule: "FREQ=WEEKLY;BYDAY=WE",
      dtstart: "2026-07-08T20:00:00-05:00",
    };

    /** The builder's "Weekly, every 1 week, Mon–Fri, until 31 Mar 2027". */
    const WEEKDAYS_UNTIL_MARCH = {
      kind: "RRULE" as const,
      rrule: "FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR",
      dtstart: "2026-07-06T18:00:00-05:00",
      until: "2027-03-31T23:59:00",
    };

    it("is TRUE for the seeded weekly open mic: 52 dates, no UNTIL", async () => {
      // The case on screen. 52 < MAX_DATES, so the row cap is NOT what flags
      // this — an unbounded rule's dates simply stop at the materialisation
      // window, a year out, and the series keeps going after them.
      const { deps } = buildDeps({
        upcoming: makeWeeklyDates(52),
        event: makeCommunityEvent({ recurrenceSchedule: WEEKLY_WEDNESDAY }),
      });

      const result = await listEventDates(deps, { eventId: EVENT_ID });

      expect(result.dates).toHaveLength(52);
      expect(result.truncated).toBe(true);
      expect(result.recurrence).toEqual({
        freq: "WEEKLY",
        interval: 1,
        byday: ["WE"],
        until: null,
      });
    });

    it("is FALSE for a weekly rule whose UNTIL lands inside the window", async () => {
      // ~26 rows, a bound six months out (well inside [now, now + 12 months]),
      // so every occurrence the rule will ever produce is already a row. This
      // is the case that must NOT be flagged, or the flag means nothing.
      const { deps } = buildDeps({
        upcoming: makeWeeklyDates(26),
        event: makeCommunityEvent({
          recurrenceSchedule: {
            ...WEEKLY_WEDNESDAY,
            until: "2026-12-30T23:59:00",
          },
        }),
      });

      const result = await listEventDates(deps, { eventId: EVENT_ID });

      expect(result.dates).toHaveLength(26);
      expect(result.truncated).toBe(false);
    });

    it("is TRUE for a weekly rule bounded BEYOND the materialisation window", async () => {
      // A real end date, three years out. The rows stop a year out, so the last
      // returned date is nowhere near the end of the series — `until != null`
      // alone would have called this complete.
      const { deps } = buildDeps({
        upcoming: makeWeeklyDates(52),
        event: makeCommunityEvent({
          recurrenceSchedule: {
            ...WEEKLY_WEDNESDAY,
            until: "2029-06-30T23:59:00",
          },
        }),
      });

      expect(
        (await listEventDates(deps, { eventId: EVENT_ID })).truncated,
      ).toBe(true);
    });

    it("is TRUE for a rule we could not summarise but that keeps running", async () => {
      // `FREQ=DAILY;BYDAY=MO,WE,FR` is outside the cadence-line contract, so
      // `recurrence` is null — but the listing still has occurrences past the
      // window. Keying truncation off the SUMMARY would call its capped list
      // complete; it is keyed off the stored rule instead.
      const { deps } = buildDeps({
        upcoming: makeWeeklyDates(40),
        event: makeCommunityEvent({
          recurrenceSchedule: {
            ...WEEKLY_WEDNESDAY,
            rrule: "FREQ=DAILY;BYDAY=MO,WE,FR",
          },
        }),
      });

      const result = await listEventDates(deps, { eventId: EVENT_ID });

      expect(result.recurrence).toBeNull();
      expect(result.truncated).toBe(true);
    });

    it("is TRUE once the upcoming-row count has DECAYED below the cap", async () => {
      // The regression round 2 caught. `rowCount >= MAX_DATES` is a property of
      // the READ, and it decays: materialisation wrote 60 occurrences of this
      // ~145-occurrence rule from ITS `now`, `listUpcoming` returns only the
      // ones still in the future, so the first time one of them starts the live
      // count is 59 — under the cap for the next ~23 hours, every day.
      //
      // With the cap silent, the ONLY other signal used to be the rule's UNTIL
      // against the materialisation window: 31 Mar 2027 sits well inside
      // [NOW, NOW + 12 months], so the list was called complete and the page
      // printed "59 dates through Sep 2026" for a series running to March.
      const upcoming = makeBusinessDayDates(59);
      const { deps } = buildDeps({
        upcoming,
        event: makeCommunityEvent({
          recurrenceSchedule: WEEKDAYS_UNTIL_MARCH,
        }),
      });

      const result = await listEventDates(deps, { eventId: EVENT_ID });

      // Both of the old predicates are quiet here, on purpose: under the cap,
      // and bounded inside the window.
      expect(result.dates).toHaveLength(59);
      expect(upcoming.at(-1)!.startsAt.toISOString()).toBe(
        "2026-09-24T23:00:00.000Z",
      );
      expect(result.recurrence?.until?.toISOString()).toBe(
        "2027-04-01T04:59:00.000Z",
      );
      expect(result.truncated).toBe(true);
    });

    it("is FALSE for a COUNT-bounded rule whose every occurrence is a row", async () => {
      // `COUNT=12` summarises with `until: null` — there is no UNTIL to read —
      // so an UNTIL-based predicate had to answer `true` and offer "Show more
      // dates" over a panel already holding all twelve. Expanding the rule
      // answers it without a special case: `rrule` honours COUNT, so nothing
      // follows row 12.
      const { deps } = buildDeps({
        upcoming: makeWeeklyDates(12),
        event: makeCommunityEvent({
          recurrenceSchedule: {
            ...WEEKLY_WEDNESDAY,
            rrule: "FREQ=WEEKLY;BYDAY=WE;COUNT=12",
          },
        }),
      });

      const result = await listEventDates(deps, { eventId: EVENT_ID });

      expect(result.dates).toHaveLength(12);
      expect(result.recurrence?.until).toBeNull();
      expect(result.truncated).toBe(false);
    });

    it("is TRUE with no rows at all while the schedule still yields dates", async () => {
      // Every materialised row cancelled, or an expansion that never ran: the
      // list shows nothing, and the schedule says there is something to show.
      const { deps } = buildDeps({
        upcoming: [],
        event: makeCommunityEvent({ recurrenceSchedule: WEEKLY_WEDNESDAY }),
      });

      const result = await listEventDates(deps, { eventId: EVENT_ID });

      expect(result.dates).toEqual([]);
      expect(result.truncated).toBe(true);
    });

    it("is FALSE with no rows and a schedule that has run out", async () => {
      // A finished listing is not a truncated one. The rule ended in June; NOW
      // is July, so there is nothing left for the list to be missing.
      const { deps } = buildDeps({
        upcoming: [],
        event: makeCommunityEvent({
          recurrenceSchedule: {
            ...WEEKLY_WEDNESDAY,
            dtstart: "2026-01-07T20:00:00-06:00",
            until: "2026-06-24T23:59:00",
          },
        }),
      });

      expect(
        (await listEventDates(deps, { eventId: EVENT_ID })).truncated,
      ).toBe(false);
    });

    it("is TRUE for a FIXED_DATES listing with a date beyond the window", async () => {
      // FIXED_DATES is NOT exempt from the materialisation window: an authored
      // date in 2028 is dropped by every expansion inside [now, now + 12
      // months], so it never becomes a row — and never will. The probe reads
      // the authored dates themselves, so it sees the one the rows are missing.
      // (API/seed callers only; the listing form emits RRULE.)
      const { deps } = buildDeps({
        upcoming: makeWeeklyDates(3),
        event: makeCommunityEvent({
          recurrenceSchedule: {
            kind: "FIXED_DATES",
            dates: ["2026-07-08T20:00:00-05:00", "2028-07-08T20:00:00-05:00"],
          } as never,
        }),
      });

      const result = await listEventDates(deps, { eventId: EVENT_ID });

      expect(result.recurrence).toBeNull();
      expect(result.truncated).toBe(true);
    });

    it("is FALSE for a FIXED_DATES listing under the row cap", async () => {
      // Authored dates, not generated ones: 10 of them is all there is.
      const { deps } = buildDeps({
        upcoming: makeWeeklyDates(10),
        event: makeCommunityEvent({
          recurrenceSchedule: {
            kind: "FIXED_DATES",
            dates: ["2026-07-08T20:00:00-05:00"],
          } as never,
        }),
      });

      const result = await listEventDates(deps, { eventId: EVENT_ID });

      expect(result.recurrence).toBeNull();
      expect(result.truncated).toBe(false);
    });

    it("is TRUE for a FIXED_DATES listing that fills the row cap", async () => {
      // 400 authored dates materialise at most 60 and the read returns at most
      // 60, so a full page means there is more behind it.
      const { deps } = buildDeps({
        upcoming: makeWeeklyDates(60),
        event: makeCommunityEvent({
          recurrenceSchedule: {
            kind: "FIXED_DATES",
            dates: ["2026-07-08T20:00:00-05:00"],
          } as never,
        }),
      });

      const result = await listEventDates(deps, { eventId: EVENT_ID });

      expect(result.dates).toHaveLength(60);
      expect(result.recurrence).toBeNull();
      expect(result.truncated).toBe(true);
    });

    it("is FALSE for a single-date listing with no schedule at all", async () => {
      const { deps } = buildDeps({
        upcoming: [DATE_A],
        event: makeCommunityEvent({ recurrenceSchedule: null as never }),
      });

      expect(
        (await listEventDates(deps, { eventId: EVENT_ID })).truncated,
      ).toBe(false);
    });

    it("is TRUE when the event read throws (no schedule to probe ⇒ uncertain)", async () => {
      // Truncation is answered by re-expanding the stored schedule, and a failed
      // read leaves us holding none of it. `false` would be a claim we cannot
      // support ("All 3 dates"); `true` only makes the page vague. A missed
      // `true` is the unsafe direction — it is what prints a horizon the series
      // does not have.
      const { deps, getEventById, reportError } = buildDeps({
        upcoming: makeWeeklyDates(3),
      });
      getEventById.mockRejectedValueOnce(new Error("events table on fire"));

      const result = await listEventDates(deps, { eventId: EVENT_ID });

      expect(result.truncated).toBe(true);
      expect(result.recurrence).toBeNull();
      expect(result.dates).toHaveLength(3);
      expect(reportError).toHaveBeenCalledTimes(1);
    });

    it("skips the Event read entirely when includeRecurrence is false", async () => {
      // The viewer-state endpoint (`private, no-store`) wants ONLY the per-date
      // flags, and used to pay for an Event row it threw away on every viewer
      // of every RSVP page. With the read skipped the series bound is unknowable
      // — `truncated` then reports the row cap alone, which is why that caller
      // reads neither field.
      const { deps, getEventById } = buildDeps({
        upcoming: makeWeeklyDates(52),
        event: makeCommunityEvent({ recurrenceSchedule: WEEKLY_WEDNESDAY }),
      });

      const result = await listEventDates(deps, {
        eventId: EVENT_ID,
        includeRecurrence: false,
      });

      expect(getEventById).not.toHaveBeenCalled();
      expect(result.dates).toHaveLength(52);
      expect(result.recurrence).toBeNull();
      expect(result.truncated).toBe(false);
    });

    it("still reports the row cap with includeRecurrence false", async () => {
      const { deps, getEventById } = buildDeps({
        upcoming: makeWeeklyDates(60),
      });

      const result = await listEventDates(deps, {
        eventId: EVENT_ID,
        includeRecurrence: false,
      });

      expect(getEventById).not.toHaveBeenCalled();
      expect(result.truncated).toBe(true);
    });

    it("reads the Event row by default (includeRecurrence omitted)", async () => {
      const { deps, getEventById } = buildDeps({
        upcoming: [DATE_A],
        event: makeCommunityEvent({ recurrenceSchedule: WEEKLY_WEDNESDAY }),
      });

      const result = await listEventDates(deps, { eventId: EVENT_ID });

      expect(getEventById).toHaveBeenCalledWith(EVENT_ID);
      expect(result.recurrence).not.toBeNull();
      expect(result.truncated).toBe(true);
    });

    // ── cancelled occurrences ───────────────────────────────────────────────
    //
    // `listUpcoming` returns CANCELLED rows now, so the three things that used
    // to be safe to read off `dates` no longer are: the lead date, "are there
    // any upcoming dates", and — the subtle one — truncation, which probes
    // from the LAST returned row.
    describe("called-off nights", () => {
      /** The same weekly fixture, with row `index` called off. */
      function weeklyWithCancelled(count: number, index: number) {
        const rows = makeWeeklyDates(count);
        rows[index] = { ...rows[index]!, status: "CANCELLED" as const };
        return rows;
      }

      it("returns a called-off night, carrying its status — it is not hidden", async () => {
        // Hiding it says "that date was never on the schedule". The page shows
        // it struck through, which is the only rendering that matches what
        // actually happened to the people who RSVP'd.
        const { deps } = buildDeps({
          upcoming: weeklyWithCancelled(3, 1),
          event: makeCommunityEvent({ recurrenceSchedule: WEEKLY_WEDNESDAY }),
        });

        const result = await listEventDates(deps, { eventId: EVENT_ID });

        expect(result.dates).toHaveLength(3);
        expect(result.dates.map((d) => d.status)).toEqual([
          "SCHEDULED",
          "CANCELLED",
          "SCHEDULED",
        ]);
      });

      it("leads with the next SCHEDULED date, never a cancelled one", async () => {
        const rows = weeklyWithCancelled(3, 0);
        const { deps } = buildDeps({
          upcoming: rows,
          event: makeCommunityEvent({ recurrenceSchedule: WEEKLY_WEDNESDAY }),
        });

        const result = await listEventDates(deps, { eventId: EVENT_ID });

        // `dates[0]` is the cancelled one; the lead date is not.
        expect(result.dates[0]!.status).toBe("CANCELLED");
        expect(result.nextScheduledEventDateId).toBe(rows[1]!.id);
      });

      it("has NO next scheduled date when every upcoming night is called off", async () => {
        const rows = makeWeeklyDates(2).map((r) => ({
          ...r,
          status: "CANCELLED" as const,
        }));
        const { deps } = buildDeps({
          upcoming: rows,
          event: makeCommunityEvent({ recurrenceSchedule: WEEKLY_WEDNESDAY }),
        });

        const result = await listEventDates(deps, { eventId: EVENT_ID });

        // Non-empty `dates`, zero upcoming dates. `dates.length > 0` is no
        // longer the "is this listing live" predicate.
        expect(result.dates).toHaveLength(2);
        expect(result.nextScheduledEventDateId).toBeNull();
      });

      it("a TRAILING cancelled night cannot make a live series look finished", async () => {
        // The probe asks the RULE what follows the last row's INSTANT, and a
        // called-off night is still an instant the rule produced — so an
        // open-ended weekly is still truncated with its last row cancelled.
        const { deps } = buildDeps({
          upcoming: weeklyWithCancelled(3, 2),
          event: makeCommunityEvent({ recurrenceSchedule: WEEKLY_WEDNESDAY }),
        });

        const result = await listEventDates(deps, { eventId: EVENT_ID });

        expect(result.dates.at(-1)!.status).toBe("CANCELLED");
        expect(result.truncated).toBe(true);
      });

      it("a trailing cancelled FINAL night cannot make a finished series look live", async () => {
        // 26 Wednesdays with an UNTIL inside the window: every occurrence the
        // rule will ever produce is already a row, and calling the last one off
        // does not invent a 27th.
        const { deps } = buildDeps({
          upcoming: weeklyWithCancelled(26, 25),
          event: makeCommunityEvent({
            recurrenceSchedule: {
              ...WEEKLY_WEDNESDAY,
              until: "2026-12-30T23:59:00",
            },
          }),
        });

        const result = await listEventDates(deps, { eventId: EVENT_ID });

        expect(result.dates.at(-1)!.status).toBe("CANCELLED");
        expect(result.truncated).toBe(false);
      });

      // ── the zero-dates ruling, from the page's side ────────────────────────
      //
      // With no upcoming SCHEDULED occurrence, a page has to choose between
      // three very different things to say. These assert that the data it needs
      // to choose is actually on the wire.
      it("DRAINED BUT LIVE is distinguishable: a rule, no scheduled dates, truncated", async () => {
        const { deps } = buildDeps({
          // The top-up job stalled: nothing materialised at all.
          upcoming: [],
          event: makeCommunityEvent({ recurrenceSchedule: WEEKLY_WEDNESDAY }),
        });

        const result = await listEventDates(deps, { eventId: EVENT_ID });

        expect(result.hasRecurrenceRule).toBe(true);
        expect(result.nextScheduledEventDateId).toBeNull();
        expect(result.truncated).toBe(true);
      });

      it("GENUINELY ENDED is distinguishable: a rule, no scheduled dates, NOT truncated", async () => {
        const { deps } = buildDeps({
          upcoming: [],
          event: makeCommunityEvent({
            // Ran out last June; NOW is 2026-07-01.
            recurrenceSchedule: {
              ...WEEKLY_WEDNESDAY,
              until: "2026-06-24T23:59:00",
            },
          }),
        });

        const result = await listEventDates(deps, { eventId: EVENT_ID });

        expect(result.hasRecurrenceRule).toBe(true);
        expect(result.nextScheduledEventDateId).toBeNull();
        expect(result.truncated).toBe(false);
      });

      it("a listing with NO rule is distinguishable from both", async () => {
        // The case that must keep its unchanged single-date rendering — and the
        // ONLY one where the event-level RSVP button is the right control.
        const { deps } = buildDeps({ upcoming: [], event: makeCommunityEvent() });

        const result = await listEventDates(deps, { eventId: EVENT_ID });

        expect(result.hasRecurrenceRule).toBe(false);
        expect(result.truncated).toBe(false);
      });

      it("reports a rule the cadence phrasebook cannot summarise as a rule anyway", async () => {
        // `recurrence` is null here, so a page keying "is this a series" off it
        // would fall back to the single-date RSVP button on a live series.
        const { deps } = buildDeps({
          upcoming: [],
          event: makeCommunityEvent({
            recurrenceSchedule: { kind: "FIXED_DATES", dates: [] },
          }),
        });

        const result = await listEventDates(deps, { eventId: EVENT_ID });

        expect(result.recurrence).toBeNull();
        expect(result.hasRecurrenceRule).toBe(true);
      });

      it("reports NO rule when the Event read was skipped or threw", async () => {
        // "We do not know" resolves toward the unchanged rendering, matching
        // how `recurrence` collapses to null on the same inputs.
        const { deps: skipped } = buildDeps({
          upcoming: [],
          event: makeCommunityEvent({ recurrenceSchedule: WEEKLY_WEDNESDAY }),
        });
        expect(
          (
            await listEventDates(skipped, {
              eventId: EVENT_ID,
              includeRecurrence: false,
            })
          ).hasRecurrenceRule,
        ).toBe(false);

        const { deps: broken, getEventById } = buildDeps({ upcoming: [] });
        getEventById.mockRejectedValueOnce(new Error("events table on fire"));
        const result = await listEventDates(broken, { eventId: EVENT_ID });
        expect(result.hasRecurrenceRule).toBe(false);
        // Still conservative about truncation on an unreadable row.
        expect(result.truncated).toBe(true);
      });
    });
  });
});
