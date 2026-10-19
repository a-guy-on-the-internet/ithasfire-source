import { describe, expect, it } from "vitest";

import { createBookingRequestBaseSchema } from "../../booking-requests/create-booking-request";
import { createBookingInquiryBaseSchema } from "../../embeds/create-booking-inquiry";
import {
  BOOKING_STANDARD_FIELD_SPECS,
  BOOKING_STANDARD_FIELDS,
  fieldAppliesToIntent,
  fieldCanBeRequired,
  fieldsForIntent,
  isFieldSatisfied,
  isKnownBookingStandardField,
  type BookingStandardsPayload,
} from "../standard-fields";
import type { BookingStandardField } from "@th/types/repos/booking-standards";

/**
 * For EVERY field: a payload that satisfies it and payloads that do not. The
 * table is exhaustive over the enum (a `Record`), so a new field without a
 * case here fails the "covers every field" test below.
 */
const CASES: Record<
  BookingStandardField,
  {
    satisfied: BookingStandardsPayload[];
    unsatisfied: BookingStandardsPayload[];
  }
> = {
  MESSAGE: {
    satisfied: [{ message: "We are a three-piece from Nashville." }],
    unsatisfied: [{}, { message: "" }, { message: "   \n " }, { message: null }],
  },
  PREFERRED_DATES: {
    satisfied: [
      { preferredDates: ["2026-10-02"] },
      { preferredDates: ["", "2026-10-02T20:00"] },
    ],
    unsatisfied: [{}, { preferredDates: [] }, { preferredDates: ["  "] }],
  },
  EXPECTED_DRAW: {
    satisfied: [{ expectedDraw: 40 }],
    unsatisfied: [{}, { expectedDraw: 0 }, { expectedDraw: Number.NaN }],
  },
  GENRE: {
    satisfied: [{ genre: "folk" }],
    unsatisfied: [{}, { genre: " " }],
  },
  LINEUP_SIZE: {
    satisfied: [{ lineupSize: 1 }],
    unsatisfied: [{}, { lineupSize: 0 }, { lineupSize: null }],
  },
  SET_LENGTH: {
    satisfied: [{ setLengthMinutes: 45 }],
    unsatisfied: [{}, { setLengthMinutes: -30 }],
  },
  TECH_NEEDS: {
    satisfied: [{ techNeeds: "Two vocal mics, one DI." }],
    unsatisfied: [{}, { techNeeds: "" }],
  },
  FEE: {
    satisfied: [
      { feeType: "NEGOTIABLE" },
      { feeType: "GUARANTEE" },
      { feeType: "DOOR_SPLIT" },
    ],
    unsatisfied: [{}, { feeType: null }, { feeType: "" }],
  },
  LINK_MUSIC: {
    satisfied: [{ linkMusic: "https://example.bandcamp.com" }],
    unsatisfied: [{}, { linkMusic: "" }, { linkVideo: "https://v.example" }],
  },
  LINK_VIDEO: {
    satisfied: [{ linkVideo: "https://youtube.example/watch" }],
    unsatisfied: [{}, { linkMusic: "https://m.example" }],
  },
  LINK_SOCIAL: {
    satisfied: [{ linkSocial: "https://instagram.example/band" }],
    unsatisfied: [{}, { linkSocial: "  " }],
  },
  LINK_EPK: {
    satisfied: [{ linkEpk: "https://epk.example" }],
    unsatisfied: [{}, { linkEpk: null }],
  },
  BILL: {
    // "At least one act OTHER than the sender" (review decision 2026-09-25).
    satisfied: [
      { bill: { includeSelf: true, acts: [{ kind: "tagged", humanId: "h" }] } },
      { bill: { includeSelf: false, acts: [{ kind: "external", name: "X" }] } },
      // Anonymous embed: one act beyond the inquiry's own actName (row 0).
      { bill: { acts: [{ kind: "external", name: "Second act" }] } },
    ],
    unsatisfied: [
      // Pre-bill contract: no bill = the sender alone.
      {},
      { bill: null },
      // The sender alone, explicitly.
      { bill: { includeSelf: true, acts: [] } },
      { bill: { includeSelf: true } },
      { bill: { includeSelf: false, acts: [] } },
      // Anonymous embed with no act beyond its own actName.
      { bill: { acts: [] } },
    ],
  },
  PURPOSE: {
    satisfied: [{ purpose: "A birthday party" }],
    unsatisfied: [{}, { purpose: "" }],
  },
  EXPECTED_ATTENDANCE: {
    satisfied: [{ expectedAttendance: 50 }],
    unsatisfied: [{}, { expectedAttendance: 0 }],
  },
  REQUESTED_WINDOW: {
    satisfied: [
      // Server: coerced Dates. Web: ISO strings, pre-parse.
      {
        requestedStartsAt: new Date("2026-10-02T18:00:00Z"),
        requestedEndsAt: new Date("2026-10-02T23:00:00Z"),
      },
      {
        requestedStartsAt: "2026-10-02T18:00:00.000Z",
        requestedEndsAt: "2026-10-02T23:00:00.000Z",
      },
    ],
    unsatisfied: [
      {},
      { requestedStartsAt: new Date("2026-10-02T18:00:00Z") },
      {
        requestedStartsAt: new Date("not a date"),
        requestedEndsAt: new Date("2026-10-02T23:00:00Z"),
      },
      { requestedStartsAt: "soon", requestedEndsAt: "later" },
    ],
  },
  CUSTOM: {
    // D2a: nothing to check — always satisfied.
    satisfied: [{}, { message: "anything" }],
    unsatisfied: [],
  },
};

describe("booking-standard field catalogue", () => {
  it("covers every field, in enum order", () => {
    expect(BOOKING_STANDARD_FIELDS).toEqual(Object.keys(CASES));
    expect(BOOKING_STANDARD_FIELDS).toHaveLength(17);
  });

  describe.each(BOOKING_STANDARD_FIELDS)("%s", (field) => {
    it.each(CASES[field].satisfied.map((p) => [JSON.stringify(p), p]))(
      "is satisfied by %s",
      (_label, payload) => {
        expect(isFieldSatisfied(field, payload)).toBe(true);
      },
    );
    if (CASES[field].unsatisfied.length > 0) {
      it.each(CASES[field].unsatisfied.map((p) => [JSON.stringify(p), p]))(
        "is NOT satisfied by %s",
        (_label, payload) => {
          expect(isFieldSatisfied(field, payload)).toBe(false);
        },
      );
    }
  });

  it("maps fields to the intents whose form has them", () => {
    expect(fieldsForIntent("PERFORM")).toEqual([
      "MESSAGE",
      "PREFERRED_DATES",
      "EXPECTED_DRAW",
      "GENRE",
      "LINEUP_SIZE",
      "SET_LENGTH",
      "TECH_NEEDS",
      "FEE",
      "LINK_MUSIC",
      "LINK_VIDEO",
      "LINK_SOCIAL",
      "LINK_EPK",
      "BILL",
      "CUSTOM",
    ]);
    const spaceFields = [
      "PURPOSE",
      "EXPECTED_ATTENDANCE",
      "REQUESTED_WINDOW",
      "CUSTOM",
    ];
    expect(fieldsForIntent("RENT")).toEqual(spaceFields);
    expect(fieldsForIntent("USE")).toEqual(spaceFields);
    expect(fieldAppliesToIntent("LINK_MUSIC", "RENT")).toBe(false);
    expect(fieldAppliesToIntent("PURPOSE", "PERFORM")).toBe(false);
    expect(fieldAppliesToIntent("CUSTOM", "USE")).toBe(true);
  });

  it("CUSTOM (D2a) and the schema-mandatory fields cannot be REQUIRED", () => {
    expect(
      BOOKING_STANDARD_FIELDS.filter((field) => !fieldCanBeRequired(field)),
    ).toEqual([
      "MESSAGE",
      "PREFERRED_DATES",
      "PURPOSE",
      "REQUESTED_WINDOW",
      "CUSTOM",
    ]);
  });

  it("is TOTAL on an unknown field (newer API, older bundle): not applicable, satisfied, never required, no throw", () => {
    for (const raw of ["STAGE_PLOT", "constructor", "toString", "__proto__", ""]) {
      const field = raw as BookingStandardField;
      expect(isKnownBookingStandardField(raw), raw).toBe(false);
      for (const intent of ["PERFORM", "RENT", "USE"] as const) {
        expect(fieldAppliesToIntent(field, intent), raw).toBe(false);
      }
      expect(isFieldSatisfied(field, {}), raw).toBe(true);
      expect(fieldCanBeRequired(field), raw).toBe(false);
    }
    expect(isKnownBookingStandardField("LINK_MUSIC")).toBe(true);
  });

  // The drift guard: every payload key the table reads must be a real key of
  // the create schema(s) of every intent it applies to. A rename there
  // (linkMusic → musicLink) fails here instead of silently making a REQUIRED
  // standard unsatisfiable.
  it("reads only keys the signed-in create payload actually has", () => {
    const shape = createBookingRequestBaseSchema.shape as Record<string, unknown>;
    for (const field of BOOKING_STANDARD_FIELDS) {
      for (const key of BOOKING_STANDARD_FIELD_SPECS[field].payloadKeys) {
        expect(shape, `${field} → ${key}`).toHaveProperty(key);
      }
    }
  });

  it("PERFORM fields are all on the anonymous embed inquiry too", () => {
    const shape = createBookingInquiryBaseSchema.shape as Record<string, unknown>;
    for (const field of fieldsForIntent("PERFORM")) {
      for (const key of BOOKING_STANDARD_FIELD_SPECS[field].payloadKeys) {
        expect(shape, `${field} → ${key}`).toHaveProperty(key);
      }
    }
  });

  it("every non-CUSTOM field reads at least one payload key", () => {
    for (const field of BOOKING_STANDARD_FIELDS) {
      expect(
        BOOKING_STANDARD_FIELD_SPECS[field].payloadKeys.length > 0,
        field,
      ).toBe(field !== "CUSTOM");
    }
  });
});
