import { describe, expect, it, vi } from "vitest";

import {
  computeAgreementPitchSeed,
  deriveAgreementPitchProvenance,
  resolveBookingTimezone,
  resolveCalendarDefaultStartTime,
  type AgreementPitchContext,
  type AgreementPitchSource,
} from "./pitch-seed";

// The venue's zone throughout: 2026-07-10 is CDT (UTC-5), 2026-11-06 is the
// day before the fall-back so its evening is still CDT.
const CHICAGO: AgreementPitchContext = {
  timezone: "America/Chicago",
  calendarDefaultStartTime: null,
  settlementCurrency: "usd",
};

function buildPitch(
  overrides: Partial<AgreementPitchSource> = {},
): AgreementPitchSource {
  return {
    preferredDates: ["2026-07-10"],
    setLengthMinutes: null,
    lineupSize: null,
    techNeeds: null,
    feeType: null,
    feeAmountCents: null,
    feeCurrency: null,
    ...overrides,
  };
}

describe("computeAgreementPitchSeed — proposedDate", () => {
  it("anchors a DATE-ONLY preferred date at 19:00 in the venue's zone", () => {
    const seed = computeAgreementPitchSeed(buildPitch(), CHICAGO);

    // 19:00 CDT = 00:00Z the next day.
    expect(seed.proposedDate?.toISOString()).toBe("2026-07-11T00:00:00.000Z");
  });

  it("honors the ROUTED CALENDAR's defaultStartTime for a date-only pitch", () => {
    const seed = computeAgreementPitchSeed(buildPitch(), {
      ...CHICAGO,
      calendarDefaultStartTime: "20:30",
    });

    expect(seed.proposedDate?.toISOString()).toBe("2026-07-11T01:30:00.000Z");
  });

  it("keeps the pitch's OWN wall clock when it named one (calendar default loses)", () => {
    // The act picked this slot out of the venue's availability picker — the
    // template default must not overwrite a real choice.
    const seed = computeAgreementPitchSeed(
      buildPitch({ preferredDates: ["2026-07-10T21:00"] }),
      { ...CHICAGO, calendarDefaultStartTime: "20:30" },
    );

    expect(seed.proposedDate?.toISOString()).toBe("2026-07-11T02:00:00.000Z");
  });

  it("takes the FIRST preferred date, not the earliest", () => {
    const seed = computeAgreementPitchSeed(
      buildPitch({ preferredDates: ["2026-09-18", "2026-07-10"] }),
      CHICAGO,
    );

    expect(seed.proposedDate?.toISOString()).toBe("2026-09-19T00:00:00.000Z");
  });

  it("anchors across a DST boundary in the venue's zone, not UTC", () => {
    // 2026-11-08 is after the US fall-back, so 19:00 local is CST (UTC-6).
    const seed = computeAgreementPitchSeed(
      buildPitch({ preferredDates: ["2026-11-08"] }),
      CHICAGO,
    );

    expect(seed.proposedDate?.toISOString()).toBe("2026-11-09T01:00:00.000Z");
  });

  it("seeds NOTHING (and does not throw) when the pitch has no preferred dates", () => {
    const seed = computeAgreementPitchSeed(
      buildPitch({ preferredDates: [] }),
      CHICAGO,
    );

    expect(seed).toEqual({
      proposedDate: null,
      proposedEndDate: null,
      guaranteeCents: null,
      description: null,
    });
  });

  it("degrades to null on a corrupt preferred date instead of throwing", () => {
    // The regression this guards: `new Date(`${iso}T00:00:00`)` on an entry
    // that ALREADY carries a time yields "…T20:00T00:00:00" → Invalid Date.
    const seed = computeAgreementPitchSeed(
      buildPitch({ preferredDates: ["2026-09-18T20:00T00:00:00"] }),
      CHICAGO,
    );

    expect(seed.proposedDate).toBeNull();
  });
});

describe("computeAgreementPitchSeed — proposedEndDate", () => {
  it("derives the end from proposedDate + setLengthMinutes", () => {
    const seed = computeAgreementPitchSeed(
      buildPitch({ setLengthMinutes: 45 }),
      CHICAGO,
    );

    expect(seed.proposedDate?.toISOString()).toBe("2026-07-11T00:00:00.000Z");
    expect(seed.proposedEndDate?.toISOString()).toBe(
      "2026-07-11T00:45:00.000Z",
    );
  });

  it("leaves the end null when no set length was pitched", () => {
    const seed = computeAgreementPitchSeed(buildPitch(), CHICAGO);

    expect(seed.proposedEndDate).toBeNull();
  });

  it("leaves the end null when there is no start to measure from", () => {
    const seed = computeAgreementPitchSeed(
      buildPitch({ preferredDates: [], setLengthMinutes: 45 }),
      CHICAGO,
    );

    expect(seed.proposedEndDate).toBeNull();
  });
});

describe("computeAgreementPitchSeed — guaranteeCents", () => {
  it("seeds a GUARANTEE ask", () => {
    const seed = computeAgreementPitchSeed(
      buildPitch({
        feeType: "GUARANTEE",
        feeAmountCents: 50_000,
        feeCurrency: "usd",
      }),
      CHICAGO,
    );

    expect(seed.guaranteeCents).toBe(50_000);
    // Already structured — the description must not repeat it.
    expect(seed.description).toBeNull();
  });

  it("does NOT seed a DOOR_SPLIT ask", () => {
    const seed = computeAgreementPitchSeed(
      buildPitch({
        feeType: "DOOR_SPLIT",
        feeAmountCents: 50_000,
        feeCurrency: "usd",
      }),
      CHICAGO,
    );

    expect(seed.guaranteeCents).toBeNull();
    // ...but the ask is still on the record, as prose. No invented percentage.
    expect(seed.description).toContain("Fee ask: door split (asking $500.00)");
    expect(seed.description).not.toMatch(/%/);
  });

  it("does NOT seed a NEGOTIABLE ask", () => {
    const seed = computeAgreementPitchSeed(
      buildPitch({ feeType: "NEGOTIABLE" }),
      CHICAGO,
    );

    expect(seed.guaranteeCents).toBeNull();
    expect(seed.description).toContain("Fee ask: negotiable");
  });

  it("refuses a guarantee denominated in another currency (writes it as prose instead)", () => {
    const seed = computeAgreementPitchSeed(
      buildPitch({
        feeType: "GUARANTEE",
        feeAmountCents: 50_000,
        feeCurrency: "eur",
      }),
      CHICAGO,
    );

    // `guaranteeCents` carries no currency of its own — seeding it here would
    // silently re-denominate €500 as $500 on a payout floor.
    expect(seed.guaranteeCents).toBeNull();
    expect(seed.description).toContain("Fee ask: guarantee of");
  });

  it("refuses a guarantee when the settlement currency is unknown", () => {
    const seed = computeAgreementPitchSeed(
      buildPitch({
        feeType: "GUARANTEE",
        feeAmountCents: 50_000,
        feeCurrency: "usd",
      }),
      { ...CHICAGO, settlementCurrency: null },
    );

    expect(seed.guaranteeCents).toBeNull();
  });

  it("treats a legacy NULL feeCurrency as the settlement currency", () => {
    const seed = computeAgreementPitchSeed(
      buildPitch({ feeType: "GUARANTEE", feeAmountCents: 25_000 }),
      CHICAGO,
    );

    expect(seed.guaranteeCents).toBe(25_000);
  });

  it("refuses a non-positive or non-integer amount", () => {
    for (const feeAmountCents of [0, -1, 12.5]) {
      const seed = computeAgreementPitchSeed(
        buildPitch({ feeType: "GUARANTEE", feeAmountCents, feeCurrency: "usd" }),
        CHICAGO,
      );
      expect(seed.guaranteeCents).toBeNull();
    }
  });
});

describe("computeAgreementPitchSeed — description", () => {
  it("records the operational asks that have no structured home", () => {
    const seed = computeAgreementPitchSeed(
      buildPitch({
        lineupSize: 4,
        setLengthMinutes: 45,
        techNeeds: "4 DIs and a drum riser.",
      }),
      CHICAGO,
    );

    expect(seed.description).toBe(
      [
        "From the booking request:",
        "- Lineup: 4 performers\n- Set length: 45 minutes",
        "Tech needs:\n4 DIs and a drum riser.",
      ].join("\n\n"),
    );
  });

  it("is null when the pitch carried none of them", () => {
    const seed = computeAgreementPitchSeed(buildPitch(), CHICAGO);

    expect(seed.description).toBeNull();
  });

  it("sanitizes tech needs before they land on the agreement", () => {
    const seed = computeAgreementPitchSeed(
      buildPitch({ techNeeds: "<img src=x onerror=alert(1)>Two vocal mics" }),
      CHICAGO,
    );

    expect(seed.description).toContain("Two vocal mics");
    expect(seed.description).not.toContain("<img");
    expect(seed.description).not.toContain("onerror");
  });

  it("uses the singular for a solo act", () => {
    const seed = computeAgreementPitchSeed(
      buildPitch({ lineupSize: 1 }),
      CHICAGO,
    );

    expect(seed.description).toBe(
      "From the booking request:\n\n- Lineup: 1 performer",
    );
  });
});

describe("deriveAgreementPitchProvenance", () => {
  const pitch = buildPitch({
    setLengthMinutes: 45,
    lineupSize: 4,
    feeType: "GUARANTEE",
    feeAmountCents: 50_000,
    feeCurrency: "usd",
  });
  const seed = computeAgreementPitchSeed(pitch, CHICAGO);

  it("reports every seeded field as from-the-pitch on an untouched agreement", () => {
    expect(deriveAgreementPitchProvenance(seed, pitch, CHICAGO)).toEqual({
      proposedDate: true,
      proposedEndDate: true,
      guaranteeCents: true,
      description: true,
    });
  });

  it("stops claiming a field the moment the venue edits it", () => {
    const edited = {
      ...seed,
      proposedDate: new Date("2026-07-12T01:00:00.000Z"),
      guaranteeCents: 60_000,
    };

    const provenance = deriveAgreementPitchProvenance(edited, pitch, CHICAGO);

    expect(provenance.proposedDate).toBe(false);
    expect(provenance.guaranteeCents).toBe(false);
    // Untouched fields keep their attribution.
    expect(provenance.proposedEndDate).toBe(true);
    expect(provenance.description).toBe(true);
  });

  it("stops claiming a field the venue CLEARS", () => {
    const cleared = { ...seed, description: null, guaranteeCents: null };

    const provenance = deriveAgreementPitchProvenance(cleared, pitch, CHICAGO);

    expect(provenance.description).toBe(false);
    expect(provenance.guaranteeCents).toBe(false);
  });

  it("claims nothing for a field the pitch never filled", () => {
    // A venue that types its own guarantee into an agreement whose pitch made
    // no guarantee ask must not have it labelled as the act's.
    const silent = buildPitch();
    const provenance = deriveAgreementPitchProvenance(
      {
        proposedDate: null,
        proposedEndDate: null,
        guaranteeCents: 50_000,
        description: "Venue's own terms.",
      },
      silent,
      CHICAGO,
    );

    expect(provenance).toEqual({
      proposedDate: false,
      proposedEndDate: false,
      guaranteeCents: false,
      description: false,
    });
  });
});

describe("resolveBookingTimezone", () => {
  it("uses the place's zone when it is a real IANA zone", () => {
    expect(resolveBookingTimezone("America/New_York")).toBe("America/New_York");
  });

  it("falls back to the platform default for null or garbage", () => {
    // The column is free text at the DB level — a garbage value must degrade.
    expect(resolveBookingTimezone(null)).toBe("America/Chicago");
    expect(resolveBookingTimezone("Not/AZone")).toBe("America/Chicago");
  });
});

describe("resolveCalendarDefaultStartTime", () => {
  const PLACE_ID = "33333333-3333-4333-8333-333333333333";
  const CALENDAR_ID = "44444444-4444-4444-8444-444444444444";

  it("returns the routed calendar's default", async () => {
    const listByPlace = vi.fn(async () => [
      { id: CALENDAR_ID, defaultStartTime: "20:30" },
    ]);

    const result = await resolveCalendarDefaultStartTime(
      { repos: { calendars: { listByPlace } } as never },
      { placeId: PLACE_ID, calendarId: CALENDAR_ID },
    );

    expect(result).toBe("20:30");
  });

  it("skips the read entirely for an unrouted request", async () => {
    const listByPlace = vi.fn();

    const result = await resolveCalendarDefaultStartTime(
      { repos: { calendars: { listByPlace } } as never },
      { placeId: PLACE_ID, calendarId: null },
    );

    expect(result).toBeNull();
    expect(listByPlace).not.toHaveBeenCalled();
  });

  it("returns null for a cross-place / deleted calendarId", async () => {
    const listByPlace = vi.fn(async () => [
      { id: "other-calendar", defaultStartTime: "20:30" },
    ]);

    const result = await resolveCalendarDefaultStartTime(
      { repos: { calendars: { listByPlace } } as never },
      { placeId: PLACE_ID, calendarId: CALENDAR_ID },
    );

    expect(result).toBeNull();
  });

  it("DEGRADES on a repo failure — logged at error AND reported", async () => {
    const boom = new Error("calendars down");
    const listByPlace = vi.fn(async () => {
      throw boom;
    });
    const logger = { error: vi.fn() };
    const reportError = vi.fn();

    const result = await resolveCalendarDefaultStartTime(
      {
        repos: { calendars: { listByPlace } } as never,
        logger: logger as never,
        reportError,
      },
      { placeId: PLACE_ID, calendarId: CALENDAR_ID },
    );

    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      "booking_agreements.pitch_seed.calendar_lookup_failed",
      expect.objectContaining({ err: boom }),
    );
    expect(reportError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({
        tags: { useCase: "resolveCalendarDefaultStartTime" },
      }),
    );
  });

  it("a THROWING reporter never changes the degraded outcome", async () => {
    const listByPlace = vi.fn(async () => {
      throw new Error("calendars down");
    });

    const result = await resolveCalendarDefaultStartTime(
      {
        repos: { calendars: { listByPlace } } as never,
        reportError: () => {
          throw new Error("sentry down");
        },
      },
      { placeId: PLACE_ID, calendarId: CALENDAR_ID },
    );

    expect(result).toBeNull();
  });
});
