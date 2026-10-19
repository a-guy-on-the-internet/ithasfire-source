import { describe, expect, it } from "vitest";

import { holdBookingActions, type HoldBookingActionsInput } from "../hold-booking-actions";

/**
 * The venue's two actions on a hold (booking-the-night FR-003 / FR-004,
 * board W1). Each case pins one server refusal the row mirrors from the
 * server-derived row fields, so a button is never offered only to be refused
 * and a withheld one always says why. (The place-timezone half — the event's
 * night — is pinned in core: list-booking-requests-booking-fields.test.ts.)
 */

function input(over: Partial<HoldBookingActionsInput> = {}): HoldBookingActionsInput {
  return {
    hold: { date: "2026-10-17", position: 1, status: "ACTIVE", lapsed: false, calendarId: "cal-1", askedFor: true },
    hasBookedNight: false,
    requestStatus: "ACCEPTED",
    agreementId: "a1",
    agreementStatus: "DRAFT",
    bookingEvent: { state: "none" },
    termsNight: null,
    unclaimed: false,
    ...over,
  };
}
const withHold = (over: Partial<HoldBookingActionsInput["hold"]>) =>
  input({ hold: { ...input().hold, ...over } });

describe("holdBookingActions", () => {
  it("offers both on a 1st hold for an asked-for night with draft terms", () => {
    expect(holdBookingActions(input())).toEqual({ sendTerms: true, bookWithoutTerms: true, reasons: [] });
  });

  it("offers both on the challenged 1st hold too (the venue may book it early)", () => {
    const r = holdBookingActions(withHold({ status: "CHALLENGED" }));
    expect(r.sendTerms && r.bookWithoutTerms).toBe(true);
  });

  it("not asked for: Send terms only, with the reason (DATE_NOT_ASKED_FOR)", () => {
    expect(holdBookingActions(withHold({ askedFor: false }))).toEqual({
      sendTerms: true,
      bookWithoutTerms: false,
      reasons: ["not_asked"],
    });
  });

  it("an unknown askedFor withholds booking without claiming a reason", () => {
    expect(holdBookingActions(withHold({ askedFor: undefined }))).toEqual({
      sendTerms: true,
      bookWithoutTerms: false,
      reasons: [],
    });
  });

  it("behind another hold: neither, and says so (NIGHT_TAKEN)", () => {
    expect(holdBookingActions(withHold({ position: 2 }))).toEqual({
      sendTerms: false,
      bookWithoutTerms: false,
      reasons: ["behind"],
    });
  });

  it("fails closed with a reason when the stage read degraded", () => {
    expect(holdBookingActions(input({ bookingEvent: null }))).toEqual({
      sendTerms: false,
      bookWithoutTerms: false,
      reasons: ["unknown"],
    });
  });

  it("follows the server's booking event: gone, other night, other calendar", () => {
    expect(holdBookingActions(input({ bookingEvent: { state: "gone" } })).reasons).toEqual(["event_gone"]);
    expect(
      holdBookingActions(input({ bookingEvent: { state: "live", night: "2026-10-18", calendarId: "cal-1" } })).reasons,
    ).toEqual(["event_other_night"]);
    expect(
      holdBookingActions(input({ bookingEvent: { state: "live", night: "2026-10-17", calendarId: "cal-2" } })).reasons,
    ).toEqual(["event_other_calendar"]);
    expect(
      holdBookingActions(input({ bookingEvent: { state: "live", night: "2026-10-17", calendarId: "cal-1" } })),
    ).toEqual({ sendTerms: true, bookWithoutTerms: true, reasons: [] });
  });

  it("open request, no terms yet: only booking (which accepts), and says why", () => {
    expect(
      holdBookingActions(input({ requestStatus: "PENDING", agreementId: null, agreementStatus: null })),
    ).toEqual({ sendTerms: false, bookWithoutTerms: true, reasons: ["accept_first"] });
    expect(
      holdBookingActions({
        ...withHold({ askedFor: false }),
        requestStatus: "VIEWED",
        agreementId: null,
        agreementStatus: null,
      }),
    ).toEqual({ sendTerms: false, bookWithoutTerms: false, reasons: ["accept_first", "not_asked"] });
  });

  it("ACCEPTED with no agreement: neither, with a reason", () => {
    expect(holdBookingActions(input({ agreementId: null, agreementStatus: null })).reasons).toEqual(["no_terms"]);
  });

  it("terms out: no Send terms; booking only on the terms' own night", () => {
    expect(holdBookingActions(input({ agreementStatus: "PROPOSED", termsNight: "2026-10-17" }))).toEqual({
      sendTerms: false,
      bookWithoutTerms: true,
      reasons: ["terms_out"],
    });
    expect(holdBookingActions(input({ agreementStatus: "PROPOSED", termsNight: "2026-10-20" }))).toEqual({
      sendTerms: false,
      bookWithoutTerms: false,
      reasons: ["terms_out", "terms_other_night"],
    });
  });

  it("terms agreed (not finalized) for this night: booking is allowed, as the server does", () => {
    expect(holdBookingActions(input({ agreementStatus: "ACCEPTED", termsNight: "2026-10-17" }))).toEqual({
      sendTerms: false,
      bookWithoutTerms: true,
      reasons: ["terms_agreed"],
    });
    // Finalized (no terms night on the row): withheld, with a reason that
    // names the row's limit rather than a server refusal.
    expect(holdBookingActions(input({ agreementStatus: "ACCEPTED", termsNight: null })).reasons).toEqual([
      "terms_agreed",
      "terms_finalized",
    ]);
  });

  it("countered terms: no Send terms (needs DRAFT), but booking works as the server allows", () => {
    expect(holdBookingActions(input({ agreementStatus: "COUNTERED" }))).toEqual({
      sendTerms: false,
      bookWithoutTerms: true,
      reasons: ["terms_countered"],
    });
    expect(holdBookingActions({ ...withHold({ askedFor: false }), agreementStatus: "COUNTERED" })).toEqual({
      sendTerms: false,
      bookWithoutTerms: false,
      reasons: ["terms_countered", "not_asked"],
    });
  });

  it("a booked night ends both actions, with the reason (BOOKING_ALREADY_HAS_NIGHT)", () => {
    expect(holdBookingActions(input({ hasBookedNight: true }))).toEqual({
      sendTerms: false,
      bookWithoutTerms: false,
      reasons: ["booked"],
    });
    // Could not tell: fail closed.
    expect(holdBookingActions(input({ hasBookedNight: null })).reasons).toEqual(["unknown"]);
  });

  it("any other agreement status: neither, with a reason", () => {
    for (const status of ["CANCELLED", null]) {
      expect(holdBookingActions(input({ agreementStatus: status })).reasons).toEqual(["terms_in_progress"]);
    }
  });

  it("nothing (and nothing to explain) once closed, lapsed or unclaimed", () => {
    for (const over of [
      { requestStatus: "DECLINED" },
      { unclaimed: true },
    ]) {
      expect(holdBookingActions(input(over))).toEqual({ sendTerms: false, bookWithoutTerms: false, reasons: [] });
    }
    expect(holdBookingActions(withHold({ status: "CHALLENGED", lapsed: true })).reasons).toEqual([]);
  });
});
