import { describe, expect, it } from "vitest";

import {
  buildBookingDefaultsPayload,
  buildBookingRequestPayload,
  centsToFeeAmountInput,
  formatSetLength,
  mapCreateBookingRequestError,
  type BookingDefaultsFormValues,
  type BookingRequestFormValues,
} from "../request-to-play-form.helpers";

const base: BookingRequestFormValues = {
  message: "We are a four-piece surf-rock band from town.",
  preferredDates: ["2026-07-04"],
  expectedDraw: "",
  genre: "",
};

describe("buildBookingRequestPayload", () => {
  it("builds a minimal payload, trimming and dropping empties", () => {
    const result = buildBookingRequestPayload({
      ...base,
      message: `  ${base.message}  `,
      preferredDates: ["2026-07-04", "", "  "],
      linkMusic: "  ",
      linkEpk: "",
    });
    expect(result).toEqual({
      ok: true,
      payload: {
        message: base.message,
        preferredDates: ["2026-07-04"],
      },
    });
  });

  it("never emits a legacy `links` array", () => {
    const result = buildBookingRequestPayload({
      ...base,
      linkMusic: "https://example.com/music",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload).not.toHaveProperty("links");
      expect(result.payload.linkMusic).toBe("https://example.com/music");
    }
  });

  it("includes optional legacy fields when provided", () => {
    const result = buildBookingRequestPayload({
      ...base,
      expectedDraw: " 150 ",
      genre: " surf rock ",
      linkEpk: "https://example.com/epk",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.expectedDraw).toBe(150);
      expect(result.payload.genre).toBe("surf rock");
      expect(result.payload.linkEpk).toBe("https://example.com/epk");
    }
  });

  it("collects the expanded pitch fields", () => {
    const result = buildBookingRequestPayload({
      ...base,
      actName: "  The Wandering Echoes  ",
      lineupSize: " 4 ",
      setLengthMinutes: "90",
      contactPhone: " +1 (555) 123-4567 ",
      techNeeds: "  PA + backline  ",
      linkVideo: "https://example.com/video",
      linkSocial: "https://example.com/social",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.actName).toBe("The Wandering Echoes");
      expect(result.payload.lineupSize).toBe(4);
      expect(result.payload.setLengthMinutes).toBe(90);
      expect(result.payload.contactPhone).toBe("+1 (555) 123-4567");
      expect(result.payload.techNeeds).toBe("PA + backline");
      expect(result.payload.linkVideo).toBe("https://example.com/video");
      expect(result.payload.linkSocial).toBe("https://example.com/social");
    }
  });

  // ── Fee cross-field rule ───────────────────────────────────────────────
  it("converts a guarantee amount from dollars to cents", () => {
    const result = buildBookingRequestPayload({
      ...base,
      feeType: "GUARANTEE",
      feeAmountDollars: "500",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.feeType).toBe("GUARANTEE");
      expect(result.payload.feeAmountCents).toBe(50000);
    }
  });

  it("rounds fractional dollars to cents for a door split", () => {
    const result = buildBookingRequestPayload({
      ...base,
      feeType: "DOOR_SPLIT",
      feeAmountDollars: "12.34",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.feeAmountCents).toBe(1234);
    }
  });

  it("emits feeType without an amount when none is entered", () => {
    const result = buildBookingRequestPayload({
      ...base,
      feeType: "GUARANTEE",
      feeAmountDollars: "",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.feeType).toBe("GUARANTEE");
      expect(result.payload).not.toHaveProperty("feeAmountCents");
    }
  });

  it("drops the fee amount for a negotiable fee type", () => {
    const result = buildBookingRequestPayload({
      ...base,
      feeType: "NEGOTIABLE",
      feeAmountDollars: "500",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.feeType).toBe("NEGOTIABLE");
      expect(result.payload).not.toHaveProperty("feeAmountCents");
    }
  });

  it("drops the fee amount when no fee type is set", () => {
    const result = buildBookingRequestPayload({
      ...base,
      feeType: "",
      feeAmountDollars: "500",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload).not.toHaveProperty("feeType");
      expect(result.payload).not.toHaveProperty("feeAmountCents");
    }
  });

  it("rejects a non-positive or non-numeric fee amount", () => {
    expect(
      buildBookingRequestPayload({
        ...base,
        feeType: "GUARANTEE",
        feeAmountDollars: "0",
      }),
    ).toEqual({ ok: false, errorKey: "admin.bkErrFeeAmount" });
    expect(
      buildBookingRequestPayload({
        ...base,
        feeType: "GUARANTEE",
        feeAmountDollars: "abc",
      }),
    ).toEqual({ ok: false, errorKey: "admin.bkErrFeeAmount" });
  });

  it("rejects a fee amount over the cap", () => {
    expect(
      buildBookingRequestPayload({
        ...base,
        feeType: "GUARANTEE",
        // $100,000.01 → 10_000_001 cents, one over the $100k cap.
        feeAmountDollars: "100000.01",
      }),
    ).toEqual({ ok: false, errorKey: "admin.bkErrFeeAmount" });
  });

  // ── Set length preset ──────────────────────────────────────────────────
  it("rejects a set length that isn't a preset", () => {
    expect(
      buildBookingRequestPayload({ ...base, setLengthMinutes: "37" }),
    ).toEqual({ ok: false, errorKey: "admin.bkErrSetLength" });
  });

  // ── Lineup size ────────────────────────────────────────────────────────
  it("rejects a lineup size out of range", () => {
    expect(
      buildBookingRequestPayload({ ...base, lineupSize: "0" }),
    ).toEqual({ ok: false, errorKey: "admin.bkErrLineup" });
    expect(
      buildBookingRequestPayload({ ...base, lineupSize: "101" }),
    ).toEqual({ ok: false, errorKey: "admin.bkErrLineup" });
  });

  // ── Phone ──────────────────────────────────────────────────────────────
  it("accepts a valid phone and rejects an invalid one", () => {
    const ok = buildBookingRequestPayload({
      ...base,
      contactPhone: "+1 555 123 4567",
    });
    expect(ok.ok).toBe(true);
    expect(
      buildBookingRequestPayload({ ...base, contactPhone: "call me!" }),
    ).toEqual({ ok: false, errorKey: "admin.bkErrPhone" });
  });

  it("attaches includeVerifiedStats only for an eligible human sender who opts in", () => {
    const human = buildBookingRequestPayload({
      ...base,
      senderOwnerType: "human",
      senderStatsEligible: true,
      includeVerifiedStats: true,
    });
    expect(human.ok).toBe(true);
    if (human.ok) {
      expect(human.payload.includeVerifiedStats).toBe(true);
    }
  });

  it("omits includeVerifiedStats for org senders even when opted in (FR-009)", () => {
    const org = buildBookingRequestPayload({
      ...base,
      senderOwnerType: "org",
      senderStatsEligible: true,
      includeVerifiedStats: true,
    });
    expect(org.ok).toBe(true);
    if (org.ok) {
      expect(org.payload).not.toHaveProperty("includeVerifiedStats");
    }
  });

  it("omits includeVerifiedStats for an ineligible human even when opted in", () => {
    // Ineligible (<3 shows / no stats row) — the server would only snapshot
    // null, so the flag is gated out client-side too (belt-and-suspenders).
    for (const senderStatsEligible of [false, undefined]) {
      const human = buildBookingRequestPayload({
        ...base,
        senderOwnerType: "human",
        senderStatsEligible,
        includeVerifiedStats: true,
      });
      expect(human.ok).toBe(true);
      if (human.ok) {
        expect(human.payload).not.toHaveProperty("includeVerifiedStats");
      }
    }
  });

  it("omits includeVerifiedStats when a human does not opt in", () => {
    const human = buildBookingRequestPayload({
      ...base,
      senderOwnerType: "human",
      includeVerifiedStats: false,
    });
    expect(human.ok).toBe(true);
    if (human.ok) {
      expect(human.payload).not.toHaveProperty("includeVerifiedStats");
    }
  });

  it("rejects short messages", () => {
    const result = buildBookingRequestPayload({ ...base, message: "hi" });
    expect(result).toEqual({
      ok: false,
      errorKey: "admin.bkErrMessageTooShort",
    });
  });

  it("requires at least one ISO date and rejects malformed ones", () => {
    expect(buildBookingRequestPayload({ ...base, preferredDates: [] })).toEqual(
      { ok: false, errorKey: "admin.bkErrDates" },
    );
    expect(
      buildBookingRequestPayload({
        ...base,
        preferredDates: ["07/04/2026"],
      }),
    ).toEqual({ ok: false, errorKey: "admin.bkErrDates" });
  });

  it("rejects non-positive or fractional expected draw", () => {
    expect(
      buildBookingRequestPayload({ ...base, expectedDraw: "0" }),
    ).toEqual({ ok: false, errorKey: "admin.bkErrDraw" });
    expect(
      buildBookingRequestPayload({ ...base, expectedDraw: "12.5" }),
    ).toEqual({ ok: false, errorKey: "admin.bkErrDraw" });
  });

  it("rejects non-http(s) typed links", () => {
    expect(
      buildBookingRequestPayload({
        ...base,
        linkMusic: "javascript:alert(1)",
      }),
    ).toEqual({ ok: false, errorKey: "admin.bkErrLinkInvalid" });
    expect(
      buildBookingRequestPayload({ ...base, linkSocial: "not a url" }),
    ).toEqual({ ok: false, errorKey: "admin.bkErrLinkInvalid" });
  });
});

const emptyDefaults: BookingDefaultsFormValues = {
  actName: "",
  lineupSize: "",
  setLengthMinutes: "",
  contactPhone: "",
  techNeeds: "",
  messageTemplate: "",
  feeType: "",
  feeAmountDollars: "",
  linkMusic: "",
  linkVideo: "",
  linkSocial: "",
  linkEpk: "",
  includeVerifiedStats: false,
};

describe("buildBookingDefaultsPayload", () => {
  it("sends null for every empty field (a save clears omitted values)", () => {
    const result = buildBookingDefaultsPayload(emptyDefaults);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload).toEqual({
        actName: null,
        lineupSize: null,
        setLengthMinutes: null,
        contactPhone: null,
        techNeeds: null,
        messageTemplate: null,
        feeType: null,
        feeAmountCents: null,
        linkMusic: null,
        linkVideo: null,
        linkSocial: null,
        linkEpk: null,
        includeVerifiedStats: false,
      });
    }
  });

  it("trims, parses, and converts populated fields", () => {
    const result = buildBookingDefaultsPayload({
      ...emptyDefaults,
      actName: "  The Wandering Echoes  ",
      lineupSize: " 4 ",
      setLengthMinutes: "90",
      contactPhone: " +1 (555) 123-4567 ",
      techNeeds: "  PA + backline  ",
      messageTemplate: "  Reusable pitch text  ",
      feeType: "GUARANTEE",
      feeAmountDollars: "500",
      linkMusic: "https://example.com/music",
      includeVerifiedStats: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload).toEqual({
        actName: "The Wandering Echoes",
        lineupSize: 4,
        setLengthMinutes: 90,
        contactPhone: "+1 (555) 123-4567",
        techNeeds: "PA + backline",
        messageTemplate: "Reusable pitch text",
        feeType: "GUARANTEE",
        feeAmountCents: 50000,
        linkMusic: "https://example.com/music",
        linkVideo: null,
        linkSocial: null,
        linkEpk: null,
        includeVerifiedStats: true,
      });
    }
  });

  it("drops the fee amount for a non-paying fee type", () => {
    const result = buildBookingDefaultsPayload({
      ...emptyDefaults,
      feeType: "NEGOTIABLE",
      feeAmountDollars: "500",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.feeType).toBe("NEGOTIABLE");
      expect(result.payload.feeAmountCents).toBeNull();
    }
  });

  it("collects per-field errors instead of a single first error", () => {
    const result = buildBookingDefaultsPayload({
      ...emptyDefaults,
      lineupSize: "0",
      contactPhone: "call me!",
      feeType: "GUARANTEE",
      feeAmountDollars: "-1",
      linkSocial: "not a url",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual({
        lineupSize: "admin.bkErrLineup",
        contactPhone: "admin.bkErrPhone",
        feeAmount: "admin.bkErrFeeAmount",
        linkSocial: "admin.bkErrLinkInvalid",
      });
    }
  });

  it("flags an over-long message template", () => {
    const result = buildBookingDefaultsPayload({
      ...emptyDefaults,
      messageTemplate: "x".repeat(2001),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.messageTemplate).toBe("account.sBkDefMsgTooLong");
    }
  });
});

describe("centsToFeeAmountInput", () => {
  it("renders cents as a fixed-decimal dollars string", () => {
    expect(centsToFeeAmountInput(50000)).toBe("500.00");
    expect(centsToFeeAmountInput(1234)).toBe("12.34");
  });
});

describe("formatSetLength", () => {
  it("formats minutes and hours", () => {
    expect(formatSetLength(15)).toBe("15 min");
    expect(formatSetLength(45)).toBe("45 min");
    expect(formatSetLength(60)).toBe("1 hr");
    expect(formatSetLength(90)).toBe("1 hr 30 min");
    expect(formatSetLength(120)).toBe("2 hr");
  });
});

describe("mapCreateBookingRequestError", () => {
  it("maps known booking-request error codes from data.appCode", () => {
    expect(
      mapCreateBookingRequestError({
        data: { appCode: "DUPLICATE_OPEN_REQUEST" },
      }),
    ).toBe("admin.bkErrDuplicate");
    expect(
      mapCreateBookingRequestError({
        data: { appCode: "PERFORMER_MODE_REQUIRED" },
      }),
      // Lineup v2 D3: the mode gates the sender's own row on the bill.
    ).toBe("admin.bkErrBillPerformerMode");
    expect(
      mapCreateBookingRequestError({
        data: { appCode: "PLACE_NOT_ACCEPTING_REQUESTS" },
      }),
    ).toBe("admin.bkErrNotAccepting");
    expect(
      mapCreateBookingRequestError({
        data: { appCode: "PLACE_NOT_VERIFIED" },
      }),
    ).toBe("admin.bkErrNotAccepting");
    // P3a (amendment 2026-09-25): an unclaimed place.
    expect(
      mapCreateBookingRequestError({
        data: { appCode: "PLACE_NOT_TAKING_REQUESTS" },
      }),
    ).toBe("admin.bkErrNotAccepting");
    expect(
      mapCreateBookingRequestError({ data: { appCode: "NOT_RESOURCE_OWNER" } }),
    ).toBe("admin.bkErrForbidden");
  });

  it("maps canonical codes carried in the message (no appCode)", () => {
    expect(
      mapCreateBookingRequestError({ message: "DUPLICATE_OPEN_REQUEST" }),
    ).toBe("admin.bkErrDuplicate");
    expect(
      mapCreateBookingRequestError({ message: "PLACE_NOT_VERIFIED" }),
    ).toBe("admin.bkErrNotAccepting");
  });

  it("still maps a bare FORBIDDEN transport code", () => {
    expect(
      mapCreateBookingRequestError({ data: { code: "FORBIDDEN" } }),
    ).toBe("admin.bkErrForbidden");
  });

  it("falls back to the generic key", () => {
    expect(mapCreateBookingRequestError(new Error("boom"))).toBe(
      "admin.bkErrGeneric",
    );
    expect(mapCreateBookingRequestError(undefined)).toBe("admin.bkErrGeneric");
  });

  it("accepts a date carrying a wall-clock time from the picker", () => {
    // The picker submits `YYYY-MM-DDTHH:MM`. This gate previously only allowed
    // a bare date, so a fully-filled form failed with "Pick at least one
    // preferred date" while every server-side test passed — caught by driving
    // the real form, not by any unit test.
    const result = buildBookingRequestPayload({
      ...base,
      preferredDates: ["2026-08-22T18:00"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.preferredDates).toEqual(["2026-08-22T18:00"]);
    }
  });

  it("still rejects a malformed time", () => {
    expect(
      buildBookingRequestPayload({
        ...base,
        preferredDates: ["2026-08-22T25:00"],
      }),
    ).toEqual({ ok: false, errorKey: "admin.bkErrDates" });
    expect(
      buildBookingRequestPayload({
        ...base,
        preferredDates: ["2026-08-22T18:00:00Z"],
      }),
    ).toEqual({ ok: false, errorKey: "admin.bkErrDates" });
  });
});
