import { describe, expect, it } from "vitest";

import type { Commitment } from "../../../../_components/my-volunteering-helpers";
import { resolveQrSubject, selectQrSubjects } from "../volunteer-qr-helpers";

/**
 * These helpers decide which shifts a volunteer can put a code on. What
 * matters is exclusion — every case here is one `mintVolunteerScanToken` would
 * refuse, so filtering has to happen before the request, not as a thrown error
 * afterwards.
 */

type Row = Record<string, unknown>;

const row = (over: Row & { signupId: string }): Commitment =>
  ({
    claimId: null,
    occurrenceId: null,
    status: "APPROVED",
    source: "EVENT_SHIFT",
    cadence: null,
    title: "SOMA Warehouse Rave",
    roleName: "Bar Staff",
    shiftLabel: "During Event",
    startsAt: new Date("2026-08-15T23:00:00Z"),
    endsAt: new Date("2026-08-16T03:00:00Z"),
    eventId: "evt-soma",
    eventSlug: "soma-warehouse-rave",
    eventTimezone: "America/Chicago",
    addressText: "SOMA Warehouse",
    askId: null,
    hoursWorked: null,
    hoursCredited: null,
    checkedInAt: null,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    smsOptIn: false,
    hasContactPhone: false,
    textRemindersOffered: false,
    reminderAnchor: null,
    ...over,
  }) as unknown as Commitment;

describe("selectQrSubjects", () => {
  it("offers a code only for APPROVED shifts", () => {
    // `mintVolunteerScanToken` answers SIGNUP_NOT_APPROVED for anything else,
    // so a PENDING row must never reach a button that would 4xx.
    const subjects = selectQrSubjects([
      row({ signupId: "s-ok", eventId: "evt-ok", status: "APPROVED" }),
      row({ signupId: "s-pending", eventId: "evt-pending", status: "PENDING" }),
      row({ signupId: "s-in", eventId: "evt-in", status: "CHECKED_IN" }),
      row({ signupId: "s-rej", eventId: "evt-rej", status: "REJECTED" }),
      row({ signupId: "s-wd", eventId: "evt-wd", status: "WITHDRAWN" }),
      row({ signupId: "s-ns", eventId: "evt-ns", status: "NO_SHOW" }),
    ]);

    expect(subjects.map((s) => s.eventId)).toEqual(["evt-ok"]);
  });

  it("drops ask-only commitments, which have no event to scope a token to", () => {
    // A scan token is an event-gate concept; the use case answers
    // SIGNUP_NOT_FOUND for a signup with no `eventId`.
    const subjects = selectQrSubjects([
      row({ signupId: "s-event", eventId: "evt-1" }),
      row({
        signupId: "s-ask",
        source: "ASK_WINDOW",
        eventId: null,
        askId: "ask-1",
      }),
    ]);

    expect(subjects.map((s) => s.eventId)).toEqual(["evt-1"]);
  });

  it("puts every approved shift at one event under ONE code", () => {
    // The token is human+event scoped, so printing a sheet per shift would
    // hand somebody two pages carrying the identical code.
    const subjects = selectQrSubjects([
      row({
        signupId: "s-late",
        roleName: "Teardown",
        startsAt: new Date("2026-08-16T05:00:00Z"),
        endsAt: new Date("2026-08-16T07:00:00Z"),
      }),
      row({
        signupId: "s-early",
        roleName: "Bar Staff",
        startsAt: new Date("2026-08-15T23:00:00Z"),
        endsAt: new Date("2026-08-16T03:00:00Z"),
      }),
    ]);

    expect(subjects).toHaveLength(1);
    // Sorted by start: the volunteer works Bar Staff before Teardown.
    expect(subjects[0].shifts.map((s) => s.roleName)).toEqual([
      "Bar Staff",
      "Teardown",
    ]);
  });

  it("picks the mint signup deterministically, not by input order", () => {
    const forward = selectQrSubjects([
      row({ signupId: "s-late", startsAt: new Date("2026-08-16T05:00:00Z") }),
      row({ signupId: "s-early", startsAt: new Date("2026-08-15T23:00:00Z") }),
    ]);
    const reversed = selectQrSubjects([
      row({ signupId: "s-early", startsAt: new Date("2026-08-15T23:00:00Z") }),
      row({ signupId: "s-late", startsAt: new Date("2026-08-16T05:00:00Z") }),
    ]);

    expect(forward[0].mintSignupId).toBe("s-early");
    expect(reversed[0].mintSignupId).toBe("s-early");
  });

  it("orders events soonest first", () => {
    const subjects = selectQrSubjects([
      row({
        signupId: "s-b",
        eventId: "evt-later",
        startsAt: new Date("2026-09-01T00:00:00Z"),
      }),
      row({
        signupId: "s-a",
        eventId: "evt-sooner",
        startsAt: new Date("2026-08-15T00:00:00Z"),
      }),
    ]);

    expect(subjects.map((s) => s.eventId)).toEqual(["evt-sooner", "evt-later"]);
  });

  it("keeps a zone or address supplied on any of an event's rows", () => {
    // A later row carrying null must not blank a value an earlier one had.
    const subjects = selectQrSubjects([
      row({ signupId: "s1", eventTimezone: null, addressText: null }),
      row({
        signupId: "s2",
        eventTimezone: "America/Chicago",
        addressText: "SOMA Warehouse",
        startsAt: new Date("2026-08-16T05:00:00Z"),
      }),
    ]);

    expect(subjects[0].timeZone).toBe("America/Chicago");
    expect(subjects[0].addressText).toBe("SOMA Warehouse");
  });
});

describe("resolveQrSubject", () => {
  const subjects = selectQrSubjects([
    row({
      signupId: "s-a",
      eventId: "evt-a",
      startsAt: new Date("2026-08-15T00:00:00Z"),
    }),
    row({
      signupId: "s-b",
      eventId: "evt-b",
      startsAt: new Date("2026-09-01T00:00:00Z"),
    }),
  ]);

  it("uses the soonest event when no event is named", () => {
    expect(resolveQrSubject(subjects, null)?.eventId).toBe("evt-a");
  });

  it("honours an explicitly named event", () => {
    expect(resolveQrSubject(subjects, "evt-b")?.eventId).toBe("evt-b");
  });

  it("answers null — never a different event — for an unmatched id", () => {
    // THE regression this guards. Falling through to the soonest event would
    // print a code that scans as `volunteer_qr_wrong_event` at the door, with
    // nothing on the paper to explain why.
    expect(resolveQrSubject(subjects, "evt-nope")).toBeNull();
  });

  it("answers null when there is nothing eligible at all", () => {
    expect(resolveQrSubject([], null)).toBeNull();
    expect(resolveQrSubject([], "evt-a")).toBeNull();
  });
});
