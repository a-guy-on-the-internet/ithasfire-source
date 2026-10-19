import { describe, expect, it } from "vitest";

import {
  buildCatalogueEntryPreview,
  buildTemplateEntryPreview,
  hasTimeBasedConfig,
  toTicketTypeTemplateEntries,
  type CatalogueEntryPreviewLabels,
  type TicketTypeForTemplate,
} from "../ticket-type-template-helpers";

const price = (cents: number) =>
  cents === 0 ? "Free" : `$${(cents / 100).toFixed(2)}`;

const base: TicketTypeForTemplate = {
  name: "General Admission",
  priceCents: 2500,
  pricingMode: "FIXED",
  minimumCents: null,
  suggestedCents: null,
  capacity: 100,
  resaleAllowed: false,
  resaleCapCents: null,
  transferAllowed: true,
};

describe("FR-011 round-trip — absolute instants do NOT become relative offsets", () => {
  const windowed: TicketTypeForTemplate = {
    ...base,
    salesOpenAt: new Date("2026-09-01T17:00:00.000Z"),
    salesCloseAt: new Date("2026-09-28T17:00:00.000Z"),
    scheduledPriceAt: new Date("2026-09-20T17:00:00.000Z"),
  };

  it("declines to infer a relative window or schedule from a saved ticket type", () => {
    // The ANCHOR is unrecoverable from a stored instant — "3 days before the
    // show" and "the day I announced it" are the same date — so inferring one
    // would silently change what the template MEANS on every future event.
    // Declining is safe by construction: the applied tier gets no window.
    const [entry] = toTicketTypeTemplateEntries([windowed]);

    expect(entry).not.toHaveProperty("salesOpen");
    expect(entry).not.toHaveProperty("salesClose");
    expect(entry).not.toHaveProperty("scheduledPriceChange");
    expect(entry).not.toHaveProperty("salesOpenAt");
    expect(entry).not.toHaveProperty("scheduledPriceAt");
  });

  it("flags the omission so the dialog can disclose it — never a silent drop", () => {
    expect(hasTimeBasedConfig([windowed])).toBe(true);
    expect(hasTimeBasedConfig([base])).toBe(false);
    expect(hasTimeBasedConfig([base, windowed])).toBe(true);
  });

  it("reads the epoch as a real instant, not as 'unset'", () => {
    expect(hasTimeBasedConfig([{ ...base, salesCloseAt: new Date(0) }])).toBe(
      true,
    );
  });

  it("degrades to 'no note' for a caller whose rows predate the fields", () => {
    expect(hasTimeBasedConfig([base])).toBe(false);
  });
});

describe("toTicketTypeTemplateEntries", () => {
  it("carries every template field through unchanged", () => {
    const entries = toTicketTypeTemplateEntries([
      {
        ...base,
        pricingMode: "ADJUSTABLE",
        priceCents: 0,
        minimumCents: 500,
        suggestedCents: 1500,
        resaleAllowed: true,
        resaleCapCents: 4000,
        transferAllowed: false,
      },
    ]);
    expect(entries).toEqual([
      {
        name: "General Admission",
        priceCents: 0,
        pricingMode: "ADJUSTABLE",
        minimumCents: 500,
        suggestedCents: 1500,
        capacity: 100,
        resaleAllowed: true,
        resaleCapCents: 4000,
        transferAllowed: false,
      },
    ]);
  });

  it("strips event-specific fields (id, status, seating) so the strict entry schema accepts the payload", () => {
    // Extra fields mimic the full listTicketTypesForEdit row shape.
    const listRow = {
      ...base,
      id: "6f6d3f9e-0000-4000-8000-000000000001",
      status: "ACTIVE",
      seatSectionId: "6f6d3f9e-0000-4000-8000-000000000002",
      layoutSectionId: "ga-floor",
    };
    const [entry] = toTicketTypeTemplateEntries([listRow]);
    expect(entry).not.toHaveProperty("id");
    expect(entry).not.toHaveProperty("status");
    expect(entry).not.toHaveProperty("seatSectionId");
    expect(entry).not.toHaveProperty("layoutSectionId");
  });

  it("trims names and drops entries whose trimmed name is empty", () => {
    const entries = toTicketTypeTemplateEntries([
      { ...base, name: "  VIP  " },
      { ...base, name: "   " },
    ]);
    expect(entries.map((e) => e.name)).toEqual(["VIP"]);
  });

  it("dedupes names case-insensitively, keeping the first occurrence", () => {
    const entries = toTicketTypeTemplateEntries([
      { ...base, name: "VIP", priceCents: 6000 },
      { ...base, name: "vip", priceCents: 1000 },
      { ...base, name: "Balcony" },
    ]);
    expect(entries.map((e) => e.name)).toEqual(["VIP", "Balcony"]);
    expect(entries[0]!.priceCents).toBe(6000);
  });

  it("returns an empty array for no ticket types", () => {
    expect(toTicketTypeTemplateEntries([])).toEqual([]);
  });
});

describe("buildTemplateEntryPreview", () => {
  it("joins name (price) pairs with commas", () => {
    expect(
      buildTemplateEntryPreview(
        [
          { name: "GA", priceCents: 0 },
          { name: "VIP", priceCents: 6000 },
        ],
        price,
      ),
    ).toBe("GA (Free), VIP ($60.00)");
  });

  it("returns an empty string for no entries", () => {
    expect(buildTemplateEntryPreview([], price)).toBe("");
  });
});

describe("buildCatalogueEntryPreview (FR-011)", () => {
  const labels: CatalogueEntryPreviewLabels = {
    adjustable: (s) => `pay what you can · ${s} suggested`,
    capacity: (c) => `cap ${c}`,
  };

  it("shows the face price for a FIXED entry", () => {
    expect(
      buildCatalogueEntryPreview(
        {
          name: "Early bird",
          priceCents: 1200,
          pricingMode: "FIXED",
          suggestedCents: null,
          capacity: 30,
        },
        price,
        labels,
      ),
    ).toBe("Early bird — $12.00 · cap 30");
  });

  it("shows the suggested amount for an ADJUSTABLE entry", () => {
    expect(
      buildCatalogueEntryPreview(
        {
          name: "Pay what you can",
          priceCents: 0,
          pricingMode: "ADJUSTABLE",
          suggestedCents: 1000,
          capacity: 60,
        },
        price,
        labels,
      ),
    ).toBe("Pay what you can — pay what you can · $10.00 suggested · cap 60");
  });
});
