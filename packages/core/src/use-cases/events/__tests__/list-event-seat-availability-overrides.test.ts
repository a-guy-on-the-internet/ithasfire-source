import { describe, expect, it, vi } from "vitest";

import { createTestLogger } from "@th/test-utils/fakes/logger";

import {
  aggregateItems,
  computeOrderAmounts,
  type PayoutTermsContext,
  type TicketTypeSummary,
} from "../../orders/checkout-helpers";
import {
  listEventSeatAvailability,
  listEventSeatAvailabilityOutputSchema,
  type ListEventSeatAvailabilityDeps,
} from "../list-event-seat-availability";

// Per-seat overrides on the public seat map: privacy of `reason`, and quoting
// through the same per-seat resolver the charge path uses.

const TEST_NOW = new Date("2026-01-01T00:00:00.000Z");
const clock = { now: () => TEST_NOW };

const EVENT_ID = "d3f3f3f3-a1a1-4b2b-8c3c-111111111111";
const SECTION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TIER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SEAT_PAID = "11111111-1111-4111-8111-111111111111";
const SEAT_FREE = "22222222-2222-4222-8222-222222222222";
const SEAT_PLAIN = "33333333-3333-4333-8333-333333333333";

const seat = (id: string, priceOverride: unknown) => ({
  id,
  seatSectionId: SECTION,
  eventId: EVENT_ID,
  status: "AVAILABLE" as const,
  label: id.slice(0, 2),
  row: "A",
  number: 1,
  priceOverride,
});

const tier = (over: Record<string, unknown> = {}) => ({
  id: TIER,
  name: "GA",
  description: null,
  priceCents: 2000,
  pricingMode: "FIXED",
  minimumCents: null,
  suggestedCents: null,
  capacity: 10,
  status: "ACTIVE",
  seatSectionId: SECTION,
  resaleAllowed: false,
  resaleCapCents: null,
  transferAllowed: false,
  scheduledPriceCents: null,
  scheduledPriceAt: null,
  salesOpenAt: null,
  salesCloseAt: null,
  ...over,
});

function buildDeps(
  seats: unknown[],
  tiers: unknown[],
  extra: Partial<ListEventSeatAvailabilityDeps> = {},
): ListEventSeatAvailabilityDeps {
  return {
    repos: {
      events: {
        getById: vi.fn(async () => ({
          id: EVENT_ID,
          status: "PUBLISHED",
          orgId: null,
          admissionTaxRateBps: 1000,
        })),
        listTicketTypes: vi.fn(async () => tiers),
      },
      seats: { listByEvent: vi.fn(async () => seats) },
      payoutTerms: {
        listByEvent: vi.fn(async () => []),
        listLines: vi.fn(async () => []),
      },
      feePolicies: {
        getById: vi.fn(async () => null),
        resolveEffective: vi.fn(async () => null),
      },
    } as unknown as ListEventSeatAvailabilityDeps["repos"],
    clock,
    logger: createTestLogger(),
    ...extra,
  };
}

const run = (deps: ListEventSeatAvailabilityDeps) =>
  listEventSeatAvailability(deps, { eventId: EVENT_ID });

describe("listEventSeatAvailability — overrides", () => {
  it("never returns the organizer's private reason", async () => {
    const result = await run(
      buildDeps(
        [
          seat(SEAT_PAID, {
            priceCents: 4000,
            reason: "VIP: friend of the band",
          }),
        ],
        [tier()],
      ),
    );
    const out = result.seats[0]!.priceOverride;
    expect(out).toEqual({ priceCents: 4000, buyerTotalCents: 4400 });
    expect(JSON.stringify(result)).not.toContain("friend of the band");
    expect(JSON.stringify(result)).not.toContain("reason");
  });

  it("the output schema rejects a reason field", () => {
    const parse = (priceOverride: Record<string, unknown>) =>
      listEventSeatAvailabilityOutputSchema.parse({
        eventId: EVENT_ID,
        seats: [
          {
            id: SEAT_PAID,
            seatSectionId: SECTION,
            status: "AVAILABLE",
            label: "A1",
            row: "A",
            number: 1,
            priceOverride,
          },
        ],
      });
    expect(() => parse({ priceCents: 1 })).not.toThrow();
    expect(() => parse({ priceCents: 1, reason: "leak" })).toThrow();
  });

  it("quotes an override seat through the resolver: the override replaces the tier price", async () => {
    const result = await run(
      buildDeps(
        [seat(SEAT_PAID, { priceCents: 4000 }), seat(SEAT_PLAIN, null)],
        [tier({ priceCents: 2000 })],
      ),
    );
    const byId = new Map(result.seats.map((s) => [s.id, s]));
    expect(byId.get(SEAT_PAID)!.priceOverride).toEqual({
      priceCents: 4000,
      buyerTotalCents: 4400,
    });
    expect(byId.get(SEAT_PLAIN)!.priceOverride).toBeNull();
  });

  it("quotes a $0 override as free, not as the tier price", async () => {
    const result = await run(
      buildDeps([seat(SEAT_FREE, { priceCents: 0 })], [tier()]),
    );
    expect(result.seats[0]!.priceOverride).toEqual({
      priceCents: 0,
      buyerTotalCents: 0,
    });
  });

  it("an ADJUSTABLE tier's seat shows no override (the buyer names the price)", async () => {
    const result = await run(
      buildDeps(
        [seat(SEAT_PAID, { priceCents: 4000, reason: "x" })],
        [tier({ pricingMode: "ADJUSTABLE", minimumCents: 500 })],
      ),
    );
    expect(result.seats[0]!.priceOverride).toBeNull();
  });

  it("a corrupt override is shown as no override, reported, and does not blank the map", async () => {
    const reportError = vi.fn();
    const result = await run(
      buildDeps(
        [
          seat(SEAT_PAID, { priceCents: -5 }),
          seat(SEAT_FREE, { priceCents: 1000 }),
          seat(SEAT_PLAIN, null),
        ],
        [tier()],
        { reportError },
      ),
    );
    const byId = new Map(result.seats.map((s) => [s.id, s]));
    expect(result.seats).toHaveLength(3);
    expect(byId.get(SEAT_PAID)!.priceOverride).toBeNull();
    expect(byId.get(SEAT_FREE)!.priceOverride).toEqual({
      priceCents: 1000,
      buyerTotalCents: 1100,
    });
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("a stored value the adapter already read as no override is no override", async () => {
    const result = await run(buildDeps([seat(SEAT_PAID, null)], [tier()]));
    expect(result.seats[0]!.priceOverride).toBeNull();
  });

  // W4(b): two FIXED tiers on one section. An override REPLACES the tier price,
  // so the charge is the same under either tier and so is the quote.
  it("a section with two FIXED tiers quotes the override (5000), which either tier charges", async () => {
    const adult = tier({ id: TIER, name: "Adult", priceCents: 3500 });
    const student = tier({
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      name: "Student",
      priceCents: 2000,
    });
    const result = await run(
      buildDeps([seat(SEAT_PAID, { priceCents: 5000 })], [adult, student]),
    );
    expect(result.seats[0]!.priceOverride?.priceCents).toBe(5000);
    for (const t of [adult, student]) {
      const out = computeOrderAmounts(
        aggregateItems([{ ticketTypeId: t.id, qty: 1, seatIds: [SEAT_PAID] }]),
        new Map([[t.id, checkoutTier(t)]]),
        payoutContext(),
        { now: TEST_NOW, seatPrices: new Map([[SEAT_PAID, 5000]]) },
      );
      expect(out.items[0]!.unitPriceCents).toBe(5000);
    }
  });

  // LEGACY ROWS (W1). `setSeatPriceOverrides` now refuses an override on any
  // section with an ACTIVE ADJUSTABLE tier (spec FR-006), so this state is
  // only reachable through a row written before that refusal, or a tier made
  // ADJUSTABLE after the override was set. The read side is unchanged: a
  // section with a FIXED and an ADJUSTABLE tier still quotes the override, as
  // the FIXED tier charges it; a buyer on the ADJUSTABLE tier names their own
  // price. Pinned so the defence for those rows does not drift.
  it("legacy row: a section with a FIXED and an ADJUSTABLE tier is quoted as the override (writes now refuse it)", async () => {
    const result = await run(
      buildDeps(
        [seat(SEAT_PAID, { priceCents: 4000 })],
        [
          tier(),
          tier({
            id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            pricingMode: "ADJUSTABLE",
            minimumCents: 500,
          }),
        ],
      ),
    );
    expect(result.seats[0]!.priceOverride?.priceCents).toBe(4000);
  });
});

// W4(a): the display quote and the charge price a seat through one resolver.
describe("listEventSeatAvailability — parity with computeOrderAmounts", () => {
  const FLIP_AT = new Date("2025-12-01T00:00:00.000Z"); // before TEST_NOW
  const scenarios = [
    { name: "plain FIXED tier", extra: {} },
    {
      name: "schedule-flipped tier",
      extra: { scheduledPriceCents: 2600, scheduledPriceAt: FLIP_AT },
    },
  ];

  for (const { name, extra } of scenarios) {
    it(`${name}: the override seat quotes what the charge prices it at; the plain seat carries no quote and charges the tier's resolved price`, async () => {
      const t = tier({ priceCents: 2000, ...extra });
      const result = await run(
        buildDeps(
          [seat(SEAT_PAID, { priceCents: 4000 }), seat(SEAT_PLAIN, null)],
          [t],
        ),
      );
      const quoted = new Map(result.seats.map((s) => [s.id, s.priceOverride]));

      const charged = computeOrderAmounts(
        aggregateItems([
          { ticketTypeId: t.id, qty: 2, seatIds: [SEAT_PAID, SEAT_PLAIN] },
        ]),
        new Map([[t.id, checkoutTier(t)]]),
        payoutContext(),
        {
          now: TEST_NOW,
          seatPrices: new Map([
            [SEAT_PAID, 4000],
            [SEAT_PLAIN, null],
          ]),
        },
      );
      const unit = new Map(
        charged.items.map((oi) => [
          (oi.meta as { seatId: string }).seatId,
          oi.unitPriceCents,
        ]),
      );

      expect(quoted.get(SEAT_PAID)?.priceCents).toBe(unit.get(SEAT_PAID));
      expect(quoted.get(SEAT_PLAIN)).toBeNull();
      expect(unit.get(SEAT_PLAIN)).toBe(
        "scheduledPriceCents" in extra ? 2600 : 2000,
      );
    });
  }
});

function checkoutTier(t: ReturnType<typeof tier>): TicketTypeSummary {
  return {
    id: t.id,
    priceCents: t.priceCents,
    pricingMode: t.pricingMode as "FIXED" | "ADJUSTABLE",
    minimumCents: t.minimumCents,
    seatSectionId: t.seatSectionId,
    scheduledPriceCents: t.scheduledPriceCents,
    scheduledPriceAt: t.scheduledPriceAt,
    salesOpenAt: null,
    salesCloseAt: null,
  };
}

function payoutContext(): PayoutTermsContext {
  return {
    agreement: {
      id: "agreement-1",
      kind: "PRIMARY",
      status: "ACTIVE",
      feeMode: null,
      feePolicyId: "policy-1",
      version: 1,
    },
    lines: [
      {
        id: "line-1",
        agreementId: "agreement-1",
        payeeId: "payee-1",
        percent: 100,
        floorCents: 0,
        capPercent: null,
        priority: 0,
        rounding: "FLOOR",
      },
    ],
    feePolicy: {
      id: "policy-1",
      version: 1,
      feeMode: "PASS_THROUGH",
      buyerFeePct: 0.05,
      maxFeeCents: null,
      minFeeCents: 0,
      maxPlatformFeeCents: null,
      platformFixedCents: 50,
      processsorFeePct: 0.029,
      processorFixedCents: 30,
      payoutPct: 0,
      payoutFixedCents: 0,
      monthlyPayoutCents: 0,
      payoutMinimumCents: 0,
    },
  } as unknown as PayoutTermsContext;
}
