import { describe, expect, it } from "vitest";

import {
  buildOrganizerBookingPayload,
  mapCreateOrganizerBookingError,
  type OrganizerBookingFormValues,
} from "../organizer-booking-form.helpers";

/**
 * Pure validation/payload rules for the organizer→performer request form
 * (organizer-booking-requests FR-009) — the send-side sibling of
 * `request-to-play-form.helpers.test.ts`.
 */

function values(
  overrides: Partial<OrganizerBookingFormValues> = {},
): OrganizerBookingFormValues {
  return {
    message: "We'd love to book you for our showcase.",
    preferredDates: ["2027-08-01"],
    setLengthMinutes: "",
    feeType: "",
    feeAmountDollars: "",
    attachedEventId: "",
    ...overrides,
  };
}

describe("buildOrganizerBookingPayload", () => {
  it("builds the minimal payload (message + dates only)", () => {
    const result = buildOrganizerBookingPayload(values());
    expect(result).toEqual({
      ok: true,
      payload: {
        message: "We'd love to book you for our showcase.",
        preferredDates: ["2027-08-01"],
      },
    });
  });

  it("rejects a message under 10 characters", () => {
    const result = buildOrganizerBookingPayload(values({ message: "hi there" }));
    expect(result).toEqual({
      ok: false,
      errorKey: "admin.bkErrMessageTooShort",
    });
  });

  it("drops empty date rows and rejects zero / malformed dates", () => {
    expect(
      buildOrganizerBookingPayload(
        values({ preferredDates: ["2027-08-01", "", " "] }),
      ),
    ).toMatchObject({ ok: true, payload: { preferredDates: ["2027-08-01"] } });

    expect(
      buildOrganizerBookingPayload(values({ preferredDates: ["", ""] })),
    ).toEqual({ ok: false, errorKey: "admin.bkErrDates" });

    expect(
      buildOrganizerBookingPayload(values({ preferredDates: ["08/01/2027"] })),
    ).toEqual({ ok: false, errorKey: "admin.bkErrDates" });
  });

  it("rejects more than 3 dates", () => {
    expect(
      buildOrganizerBookingPayload(
        values({
          preferredDates: ["2027-08-01", "2027-08-02", "2027-08-03", "2027-08-04"],
        }),
      ),
    ).toEqual({ ok: false, errorKey: "admin.bkErrDates" });
  });

  it("only accepts preset set lengths", () => {
    expect(
      buildOrganizerBookingPayload(values({ setLengthMinutes: "45" })),
    ).toMatchObject({ ok: true, payload: { setLengthMinutes: 45 } });

    expect(
      buildOrganizerBookingPayload(values({ setLengthMinutes: "44" })),
    ).toEqual({ ok: false, errorKey: "admin.bkErrSetLength" });
  });

  it("converts a fee amount to cents for a paying fee type", () => {
    expect(
      buildOrganizerBookingPayload(
        values({ feeType: "GUARANTEE", feeAmountDollars: "250" }),
      ),
    ).toMatchObject({
      ok: true,
      payload: { feeType: "GUARANTEE", feeAmountCents: 25_000 },
    });
  });

  it("never emits an amount for NEGOTIABLE (cross-field rule)", () => {
    const result = buildOrganizerBookingPayload(
      values({ feeType: "NEGOTIABLE", feeAmountDollars: "250" }),
    );
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.payload.feeType).toBe("NEGOTIABLE");
      expect(result.payload).not.toHaveProperty("feeAmountCents");
    }
  });

  it("rejects a non-positive fee amount", () => {
    expect(
      buildOrganizerBookingPayload(
        values({ feeType: "GUARANTEE", feeAmountDollars: "0" }),
      ),
    ).toEqual({ ok: false, errorKey: "admin.bkErrFeeAmount" });
  });

  it("passes a selected event attach through and omits an empty one", () => {
    expect(
      buildOrganizerBookingPayload(
        values({ attachedEventId: "3f1f9a5e-0000-4000-8000-000000000001" }),
      ),
    ).toMatchObject({
      ok: true,
      payload: { attachedEventId: "3f1f9a5e-0000-4000-8000-000000000001" },
    });

    const none = buildOrganizerBookingPayload(values());
    if (none.ok) {
      expect(none.payload).not.toHaveProperty("attachedEventId");
    }
  });
});

describe("mapCreateOrganizerBookingError", () => {
  const err = (appCode: string) => ({ data: { appCode } });

  it("maps the canonical create failures to friendly keys", () => {
    expect(mapCreateOrganizerBookingError(err("DUPLICATE_OPEN_REQUEST"))).toBe(
      "admin.bkOrgErrDuplicate",
    );
    expect(
      mapCreateOrganizerBookingError(err("PERFORMER_NOT_ACCEPTING_REQUESTS")),
    ).toBe("admin.bkOrgErrNotAccepting");
    expect(mapCreateOrganizerBookingError(err("EVENT_NOT_FOUND"))).toBe(
      "admin.bkOrgErrEventNotOwned",
    );
    expect(mapCreateOrganizerBookingError(err("NOT_RESOURCE_OWNER"))).toBe(
      "admin.bkOrgErrEventNotOwned",
    );
    expect(mapCreateOrganizerBookingError(err("CANNOT_BOOK_OWN_ACT"))).toBe(
      "admin.bkOrgErrOwnAct",
    );
  });

  it("falls back to the generic error for unknown failures", () => {
    expect(mapCreateOrganizerBookingError(new Error("boom"))).toBe(
      "admin.bkErrGeneric",
    );
  });
});
