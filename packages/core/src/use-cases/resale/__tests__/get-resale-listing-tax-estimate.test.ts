import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";

import { resaleBuyerTaxEstimate } from "../_shared/resale-listing-display";
import { getResaleListing } from "../get-resale-listing";

// The resale checkout page showed "Pay $51.75" and the card was charged
// $56.19: the listing read carried no tax, so the page's total and Pay label
// left it out. The read now carries the tax checkout adds and the total
// including it, on the same base `createResaleCheckout` taxes.
//
// Owner 2026-10-14 ("WE DO NOT ABSORB THE 2.9% PROCESSING FEE"): checkout
// grosses processing up over the whole charge, tax included, at the rate of
// the fee policy the listing froze, so the estimate does too. The listing's
// stored `processingPassThroughCents` (181 on a $50 basis) is the pre-tax
// figure; with tax the processing is higher.

const FEE_POLICY_ID = "fee-policy-1";

const LISTING_ID = "aa111111-aa11-4a11-8a11-aa1111111111";
const TICKET_ID = "bb222222-bb22-4b22-8b22-bb2222222222";
const EVENT_ID = "cc333333-cc33-4c33-8c33-cc3333333333";
const SELLER_ID = "dd444444-dd44-4d44-8d44-dd4444444444";
const TYPE_ID = "ee555555-ee55-4e55-8e55-ee5555555555";
const ITEM_ID = "bb888888-bb88-4b88-8b88-bb8888888888";
const PLACE_ID = "ff666666-ff66-4f66-8f66-ff6666666666";
const NOW = new Date("2026-03-10T12:00:00Z");
const clock = { now: () => NOW };

function listing(overrides: Record<string, unknown> = {}) {
  return {
    id: LISTING_ID,
    ticketId: TICKET_ID,
    eventId: EVENT_ID,
    sellerHumanId: SELLER_ID,
    askPriceCents: 5000,
    faceValueCents: 4000,
    processingPassThroughCents: 181,
    processingFeeConfigRef: FEE_POLICY_ID,
    saleCutoffAt: null,
    payoutReleaseAt: null,
    currency: "usd",
    status: "ACTIVE",
    expiresAt: null,
    source: "internal",
    externalRef: null,
    resalePayoutTermsId: null,
    eventShareCents: 500,
    sharePayer: "SELLER",
    buyerOrderId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function place(overrides: Record<string, unknown> = {}) {
  return {
    id: PLACE_ID,
    countryCode: "US",
    region: "NY",
    postalCode: "10001",
    admissionTaxRateBps: null,
    taxRateSource: null,
    addressLine1: "1 Main St",
    city: "New York",
    ...overrides,
  };
}

function deps(opts: {
  listing?: Record<string, unknown>;
  event?: Record<string, unknown>;
  place?: Record<string, unknown> | null;
  placeThrows?: boolean;
  /** `null` = the listing's fee policy is gone. */
  feePolicy?: Record<string, unknown> | null;
  reportError?: ReturnType<typeof vi.fn>;
}) {
  const l = opts.listing ?? listing();
  return {
    clock,
    reportError: opts.reportError,
    repos: {
      resaleListings: { getById: vi.fn(async () => l) },
      tickets: {
        getById: vi.fn(async () => ({
          id: TICKET_ID, eventId: EVENT_ID, ticketTypeId: TYPE_ID, seatId: null, orderItemId: ITEM_ID,
        })),
        getTicketTypeById: vi.fn(async () => ({
          id: TYPE_ID, name: "GA", priceCents: 4000, scheduledPriceCents: null, scheduledPriceAt: null,
          pricingMode: "FIXED", minimumCents: null, seatSectionId: null,
        })),
      },
      orderItems: {
        getById: vi.fn(async () => ({
          id: ITEM_ID, orderId: "cc999999-cc99-4c99-8c99-cc9999999999",
          unitPriceCents: 4000, originalUnitPriceCents: 4000, meta: {},
        })),
      },
      events: {
        getById: vi.fn(async () => ({
          id: EVENT_ID, title: "T", slug: "t", startsAt: NOW, locationLabel: null, status: "PUBLISHED",
          placeId: PLACE_ID, savedLocationId: null, admissionTaxRateBps: 888, taxRateSource: "ziptax",
          ...opts.event,
        })),
      },
      places: {
        getById: vi.fn(async () => {
          if (opts.placeThrows) throw new Error("db down");
          return opts.place === undefined ? place() : opts.place;
        }),
      },
      savedLocations: { getById: vi.fn(async () => null) },
      feePolicies: {
        getByIds: vi.fn(async () => {
          const policy =
            opts.feePolicy === undefined
              ? { id: FEE_POLICY_ID, processsorFeePct: 0.029, processorFixedCents: 30 }
              : opts.feePolicy;
          return new Map(policy ? [[FEE_POLICY_ID, policy]] : []);
        }),
      },
      orders: { getById: vi.fn(async () => null) },
      seats: { getSectionById: vi.fn(async () => null), findLabelsByIds: vi.fn(async () => []) },
    } as unknown as Repos,
  };
}

describe("getResaleListing: the tax checkout adds, and the total including it", () => {
  it("SELLER payer at a stamped 8.88%: tax on the ask, processing over ask + tax, total = all three", async () => {
    const d = deps({});
    const out = await getResaleListing(d, { listingId: LISTING_ID });
    expect(out.buyerTotalBeforeTaxCents).toBe(5181);
    // round(5000 × 8.88%) = 444, on the basis only (NY taxes the ticket face).
    expect(out.estimatedTaxCents).toBe(444);
    // Grossed up over 5000 + 444 = 5444: 194, not the pre-tax 181.
    expect(out.estimatedProcessingCents).toBe(194);
    expect(out.estimatedTotalCents).toBe(5000 + 194 + 444);
    expect(d.repos.feePolicies.getByIds).toHaveBeenCalledWith([FEE_POLICY_ID]);
  });

  it("BUYER payer in a BUYER_TOTAL state: the share and processing are taxed too", async () => {
    const out = await getResaleListing(
      deps({
        listing: listing({ sharePayer: "BUYER", processingPassThroughCents: 196 }),
        event: { admissionTaxRateBps: 975 },
        place: place({ region: "TN", postalCode: "37203", city: "Nashville" }),
      }),
      { listingId: LISTING_ID },
    );
    // Basis 5500 (ask + share), pre-tax processing 196. Solved jointly:
    // processing 212 over 5500 + 557, tax round((5500 + 212) × 9.75%) = 557.
    expect(out.buyerTotalBeforeTaxCents).toBe(5696);
    expect(out.estimatedTaxCents).toBe(557);
    expect(out.estimatedProcessingCents).toBe(212);
    expect(out.estimatedTotalCents).toBe(5500 + 212 + 557);
  });

  it("Minneapolis 55403: no 3% entertainment line on resale (owner 2026-10-05), only MN sales tax", async () => {
    // The shipped MPLS_ENTERTAINMENT row has `appliesToResale: false`;
    // `createResaleCheckout` resolves with sale RESALE, so the estimate does too.
    const out = await getResaleListing(
      deps({
        event: { admissionTaxRateBps: 903 },
        place: place({ region: "MN", postalCode: "55403", city: "Minneapolis" }),
      }),
      { listingId: LISTING_ID },
    );
    // SELLER payer, basis 5000. MN is BUYER_TOTAL, so SALES is solved jointly
    // with processing: processing 195, SALES round((5000 + 195) × 9.03%) = 469.
    // The 3% face line would add round(5000 × 3%) = 150 on top.
    expect(out.estimatedProcessingCents).toBe(195);
    expect(out.estimatedTaxCents).toBe(Math.round(((5000 + 195) * 903) / 10_000));
    expect(out.estimatedTaxCents).toBe(469);
    expect(out.estimatedTotalCents).toBe(5000 + 195 + 469);
  });

  it("TN instruction-only admission: a stale non-zero stamp estimates 0 tax, as checkout charges", async () => {
    const out = await getResaleListing(
      deps({
        event: { admissionTaxRateBps: 975, instructionalAdmission: true },
        place: place({ region: "TN", postalCode: "37203", city: "Nashville" }),
      }),
      { listingId: LISTING_ID },
    );
    expect(out.estimatedTaxCents).toBe(0);
    expect(out.estimatedProcessingCents).toBe(181);
    expect(out.estimatedTotalCents).toBe(5181);
  });

  it("a stamp of 0 is a known rate: 0 tax and a total, not unknown", async () => {
    const out = await getResaleListing(
      deps({ event: { admissionTaxRateBps: 0, taxRateSource: "none" } }),
      { listingId: LISTING_ID },
    );
    expect(out.estimatedTaxCents).toBe(0);
    // No tax: the estimate's processing is the listing's pre-tax figure.
    expect(out.estimatedProcessingCents).toBe(181);
    expect(out.estimatedTotalCents).toBe(5181);
  });

  it("an unstamped event with a cached venue rate estimates at that rate", async () => {
    const out = await getResaleListing(
      deps({
        event: { admissionTaxRateBps: null, taxRateSource: null },
        place: place({ admissionTaxRateBps: 800, taxRateSource: "ziptax" }),
      }),
      { listingId: LISTING_ID },
    );
    expect(out.estimatedTaxCents).toBe(400);
    expect(out.estimatedProcessingCents).toBe(193);
    expect(out.estimatedTotalCents).toBe(5000 + 193 + 400);
  });

  it("a rate only the tax provider could answer is unknown: null, never a 0 tax", async () => {
    const out = await getResaleListing(
      deps({ event: { admissionTaxRateBps: null, taxRateSource: null } }),
      { listingId: LISTING_ID },
    );
    expect(out.estimatedTaxCents).toBeNull();
    expect(out.estimatedProcessingCents).toBeNull();
    expect(out.estimatedTotalCents).toBeNull();
    expect(out.buyerTotalBeforeTaxCents).toBe(5181);
  });

  it("the listing's fee policy is gone: no estimate (checkout refuses it too), reported", async () => {
    const reportError = vi.fn();
    const out = await getResaleListing(
      deps({ feePolicy: null, reportError }),
      { listingId: LISTING_ID },
    );
    expect(out.estimatedTaxCents).toBeNull();
    expect(out.estimatedProcessingCents).toBeNull();
    expect(out.estimatedTotalCents).toBeNull();
    // The page still shows the listing's pre-tax figure.
    expect(out.buyerTotalBeforeTaxCents).toBe(5181);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]?.[1]).toMatchObject({
      tags: { useCase: "getResaleListing" },
      extra: { listingIds: [LISTING_ID], stage: "listing_processing" },
    });
  });

  it("a failed venue read keeps the page: null tax, reported", async () => {
    const reportError = vi.fn();
    const out = await getResaleListing(
      deps({ placeThrows: true, reportError }),
      { listingId: LISTING_ID },
    );
    expect(out.estimatedTaxCents).toBeNull();
    expect(out.estimatedTotalCents).toBeNull();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]?.[1]).toMatchObject({
      tags: { useCase: "getResaleListing" },
      extra: { listingId: LISTING_ID, stage: "tax_estimate" },
    });
  });

  it("a throwing reporter does not break the read", async () => {
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    const out = await getResaleListing(
      deps({ placeThrows: true, reportError }),
      { listingId: LISTING_ID },
    );
    expect(out.estimatedTotalCents).toBeNull();
  });

  it("a listing priced before the share has no estimate and reads no venue", async () => {
    const d = deps({ listing: listing({ eventShareCents: null, sharePayer: null }) });
    const out = await getResaleListing(d, { listingId: LISTING_ID });
    expect(out.estimatedTaxCents).toBeNull();
    expect(out.estimatedTotalCents).toBeNull();
    expect(d.repos.places.getById).not.toHaveBeenCalled();
  });
});

describe("resaleBuyerTaxEstimate", () => {
  it("no tax lines: processing is the pre-tax gross-up of the basis", () => {
    expect(
      resaleBuyerTaxEstimate(
        { askPriceCents: 5000, eventShareCents: 500, sharePayer: "BUYER" },
        [],
        { pct: 0.029, fixedCents: 30 },
      ),
    ).toEqual({ taxCents: 0, processingCents: 196, totalCents: 5696 });
  });
});
