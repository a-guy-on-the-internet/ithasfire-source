import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { TxRepos } from "@th/ports/repos";
import type { TaxRateLookupPort } from "@th/ports/tax-rate-lookup";

import {
  newCheckoutTaxAfterCommit,
  resolveCheckoutTax,
} from "../_shared/resolve-checkout-tax-rate";

const clock: ClockPort = { now: () => new Date("2026-07-01T00:00:00.000Z") };

/** Inline-address events need no place/savedLocation reads — only the event self-heal write. */
function makeInlineTx(): {
  tx: TxRepos;
  updateEventTaxRate: ReturnType<typeof vi.fn>;
} {
  const updateEventTaxRate = vi.fn(async () => {});
  const tx = {
    events: { updateTaxRate: updateEventTaxRate },
  } as unknown as TxRepos;
  return { tx, updateEventTaxRate };
}

/** The event row's version as the checkout read it (`Event.updatedAt`). */
const EVENT_VERSION = new Date("2026-06-29T08:00:00.000Z");

const baseEvent = {
  id: "00000000-0000-4000-8000-000000000001",
  updatedAt: EVENT_VERSION,
  admissionTaxRateBps: null as number | null,
  taxRateSource: null as string | null,
  placeId: null as string | null,
  savedLocationId: null as string | null,
  postalCode: null as string | null,
  countryCode: null as string | null,
  region: null as string | null,
};

describe("resolveCheckoutTax — situs snapshot", () => {
  it("Canadian venue (Edmonton) resolves 5% GST + a CA/AB situs from the static map", async () => {
    const { tx, updateEventTaxRate } = makeInlineTx();
    const afterCommit = newCheckoutTaxAfterCommit();

    const res = await resolveCheckoutTax(
      { taxRateLookup: null, clock },
      tx,
      {
        ...baseEvent,
        postalCode: "T5J 3N9",
        countryCode: "CA",
        region: "AB",
      },
      undefined,
      afterCommit,
    );

    expect(res.rateBps).toBe(500);
    expect(res.rateSource).toBe("ca_gst_hst");
    expect(res.situs).toEqual({
      countryCode: "CA",
      region: "AB",
      postalCode: "T5J 3N9",
    });
    // Self-heals the freshly-resolved rate back onto the event — recorded for
    // the caller to write AFTER its transaction commits, never on it.
    expect(afterCommit.selfHeal).toEqual({
      eventId: baseEvent.id,
      admissionTaxRateBps: 500,
      taxRateSource: "ca_gst_hst",
      expectedUpdatedAt: EVENT_VERSION,
    });
    expect(updateEventTaxRate).not.toHaveBeenCalled();
  });

  it("US venue resolves via ZipTax and snapshots the VENUE situs (not billing)", async () => {
    const lookup: TaxRateLookupPort = {
      lookupByPostalCode: vi.fn(async () => ({ rateBps: 700, source: "ziptax" })),
    };
    const { tx } = makeInlineTx();

    const res = await resolveCheckoutTax(
      { taxRateLookup: lookup, clock },
      tx,
      {
        ...baseEvent,
        postalCode: "33901",
        countryCode: "US",
        region: "FL",
      },
      undefined,
    );

    expect(res.rateBps).toBe(700);
    expect(res.rateSource).toBe("ziptax");
    expect(res.situs).toEqual({
      countryCode: "US",
      region: "FL",
      postalCode: "33901",
    });
  });

  it("a publish-time stamp keeps its venue situs without any lookup", async () => {
    const lookup: TaxRateLookupPort = {
      lookupByPostalCode: vi.fn(async () => ({ rateBps: 999, source: "ziptax" })),
    };
    const { tx, updateEventTaxRate } = makeInlineTx();

    const res = await resolveCheckoutTax(
      { taxRateLookup: lookup, clock },
      tx,
      {
        ...baseEvent,
        admissionTaxRateBps: 650,
        taxRateSource: "ziptax",
        postalCode: "37203",
        countryCode: "US",
        region: "TN",
      },
      undefined,
    );

    expect(res.rateBps).toBe(650);
    expect(res.rateSource).toBe("ziptax");
    expect(res.situs).toEqual({
      countryCode: "US",
      region: "TN",
      postalCode: "37203",
    });
    expect(lookup.lookupByPostalCode).not.toHaveBeenCalled();
    expect(updateEventTaxRate).not.toHaveBeenCalled();
  });
});
