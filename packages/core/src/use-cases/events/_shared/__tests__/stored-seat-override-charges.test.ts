import { describe, expect, it } from "vitest";
import type { SeatSectionPriceOverride } from "@th/ports/repos/seats";
import type { EventTicketTypeSummary } from "@th/types";

import {
  sectionChargesSeatOverrides,
  storedSeatOverrideCharges,
} from "../seat-price-override-rules";

// ---------------------------------------------------------------------------
// storedSeatOverrideCharges: what publish asks of the stored overrides. A
// seat override is charged only through a FIXED tier (D-004: ADJUSTABLE
// ignores it), counted with the write's tier rule (every tier on a DRAFT,
// ACTIVE tiers otherwise) and judged with checkout's amount rule.
// ---------------------------------------------------------------------------

const DRAFT = { status: "DRAFT" } as const;
const PUBLISHED = { status: "PUBLISHED" } as const;

function tier(
  overrides: Partial<EventTicketTypeSummary>,
): EventTicketTypeSummary {
  return {
    id: "tt-1",
    name: "Floor",
    priceCents: 0,
    pricingMode: "FIXED",
    minimumCents: null,
    suggestedCents: null,
    capacity: 100,
    status: "DRAFT",
    seatSectionId: "s-1",
    resaleAllowed: false,
    resaleCapCents: null,
    transferAllowed: true,
    scheduledPriceCents: null,
    scheduledPriceAt: null,
    ...overrides,
  };
}

function at(
  seatSectionId: string,
  priceOverride: SeatSectionPriceOverride["priceOverride"],
): SeatSectionPriceOverride {
  return { seatSectionId, priceOverride };
}

describe("sectionChargesSeatOverrides", () => {
  it("is true when a FIXED tier sells the section, even beside an ADJUSTABLE one", () => {
    expect(sectionChargesSeatOverrides([{ pricingMode: "FIXED" }])).toBe(true);
    expect(
      sectionChargesSeatOverrides([
        { pricingMode: "ADJUSTABLE" },
        { pricingMode: "FIXED" },
      ]),
    ).toBe(true);
  });

  it("is false for an ADJUSTABLE-only section and for an unsold one", () => {
    expect(sectionChargesSeatOverrides([{ pricingMode: "ADJUSTABLE" }])).toBe(
      false,
    );
    expect(sectionChargesSeatOverrides([])).toBe(false);
  });
});

describe("storedSeatOverrideCharges", () => {
  it("a $50 seat a FIXED tier sells is paid", () => {
    expect(
      storedSeatOverrideCharges(DRAFT, [tier({})], [
        at("s-1", { priceCents: 5000, reason: null }),
      ]),
    ).toEqual({ paid: true, paidSectionIds: ["s-1"], invalidSectionIds: [] });
  });

  it("a $0 seat is not paid", () => {
    expect(
      storedSeatOverrideCharges(DRAFT, [tier({})], [
        at("s-1", { priceCents: 0, reason: null }),
      ]),
    ).toEqual({ paid: false, paidSectionIds: [], invalidSectionIds: [] });
  });

  it("ignores an override in a section only an ADJUSTABLE tier sells (D-004)", () => {
    expect(
      storedSeatOverrideCharges(
        DRAFT,
        [tier({ pricingMode: "ADJUSTABLE" })],
        [at("s-1", { priceCents: 5000, reason: null }), at("s-1", { invalid: true })],
      ),
    ).toEqual({ paid: false, paidSectionIds: [], invalidSectionIds: [] });
  });

  it("counts an override in a section a FIXED and an ADJUSTABLE tier share", () => {
    expect(
      storedSeatOverrideCharges(
        DRAFT,
        [
          tier({ id: "tt-pwyw", pricingMode: "ADJUSTABLE" }),
          tier({ id: "tt-fixed" }),
        ],
        [at("s-1", { priceCents: 5000, reason: null })],
      ).paid,
    ).toBe(true);
  });

  it("ignores an override in a section no tier sells", () => {
    expect(
      storedSeatOverrideCharges(DRAFT, [tier({})], [
        at("s-other", { priceCents: 5000, reason: null }),
      ]),
    ).toEqual({ paid: false, paidSectionIds: [], invalidSectionIds: [] });
  });

  it("counts every tier on a DRAFT, only ACTIVE tiers otherwise", () => {
    const draftTier = tier({ status: "DRAFT" });
    const paidSeat = [at("s-1", { priceCents: 5000, reason: null })];
    expect(storedSeatOverrideCharges(DRAFT, [draftTier], paidSeat).paid).toBe(
      true,
    );
    expect(
      storedSeatOverrideCharges(PUBLISHED, [draftTier], paidSeat).paid,
    ).toBe(false);
    expect(
      storedSeatOverrideCharges(
        PUBLISHED,
        [tier({ status: "ACTIVE" })],
        paidSeat,
      ).paid,
    ).toBe(true);
  });

  it("reports the sections holding a value checkout refuses, distinct and sorted", () => {
    const tiers = [
      tier({ id: "tt-a", seatSectionId: "s-b" }),
      tier({ id: "tt-b", seatSectionId: "s-a" }),
    ];
    expect(
      storedSeatOverrideCharges(DRAFT, tiers, [
        at("s-b", { invalid: true }),
        at("s-b", { priceCents: -1, reason: null }),
        at("s-a", { priceCents: 12.5, reason: null }),
      ]),
    ).toEqual({ paid: false, paidSectionIds: [], invalidSectionIds: ["s-a", "s-b"] });
  });

  it("an unsafe integer amount is corrupt, not paid", () => {
    expect(
      storedSeatOverrideCharges(DRAFT, [tier({})], [
        at("s-1", { priceCents: Number.MAX_SAFE_INTEGER + 1, reason: null }),
      ]),
    ).toEqual({ paid: false, paidSectionIds: [], invalidSectionIds: ["s-1"] });
  });
});
