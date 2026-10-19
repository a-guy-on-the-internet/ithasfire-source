import { describe, expect, it, vi } from "vitest";

import { makeTicketCapacityUsageFake } from "@th/test-utils/fakes/ticket-capacity";

import type { EventTicketTypeSummary } from "@th/types";

import { ticketTiersForCard } from "../ticket-tiers-for-card";
import type { TicketTiersForCardDeps } from "../ticket-tiers-for-card";

// FR-003: the price resolver requires an injected instant. Frozen so these
// assertions describe a fixed moment; no fixture here carries a schedule, so
// the resolved price is the list price and every existing expectation holds.
const TEST_NOW = new Date("2026-01-01T00:00:00.000Z");
const testClock = { now: () => TEST_NOW };

// ── Fixture UUIDs ────────────────────────────────────────────────────────────

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const TT_GA = "33333333-3333-4333-8333-333333333333";
const TT_VIP = "44444444-4444-4444-8444-444444444444";
const TT_FREE = "55555555-5555-4555-8555-555555555555";
const FEE_POLICY_ID = "66666666-6666-4666-8666-666666666666";

const NOW = new Date("2026-05-30T00:00:00.000Z");

// ── Builders ─────────────────────────────────────────────────────────────────

function buildEvent(overrides?: Record<string, unknown>) {
  return {
    id: EVENT_ID,
    status: "PUBLISHED",
    orgId: ORG_ID,
    humanId: null,
    admissionTaxRateBps: 0, // resolved (0% == tax-free but known)
    ...overrides,
  };
}

function buildTicketType(
  id: string,
  name: string,
  priceCents: number,
  overrides?: Partial<EventTicketTypeSummary>,
): EventTicketTypeSummary {
  return {
    id,
    name,
    description: null,
    priceCents,
    pricingMode: "FIXED",
    minimumCents: null,
    suggestedCents: null,
    capacity: 100,
    status: "ACTIVE",
    seatSectionId: null,
    resaleAllowed: false,
    resaleCapCents: null,
    transferAllowed: true,
    ...overrides,
  } as EventTicketTypeSummary;
}

/**
 * Deps with a ZERO-FEE fee policy (no platform, no processing rate) resolved
 * via the scoped cascade (no primary terms). The estimator then adds tax only,
 * which keeps the arithmetic assertions simple: a paid tier's buyer total ==
 * face + round(face * taxRateBps / 10_000). (This used an ABSORB policy for
 * the zero; ABSORB is removed, docs/decisions/absorb-removed.md.)
 */
function buildDeps(overrides?: {
  event?: Record<string, unknown> | null;
  ticketTypes?: EventTicketTypeSummary[];
  /** Map of ticketTypeId → issued count (defaults to 0). */
  issued?: Record<string, number>;
}): TicketTiersForCardDeps {
  const event = overrides?.event === undefined ? buildEvent() : overrides.event;
  const ticketTypes = overrides?.ticketTypes ?? [
    buildTicketType(TT_VIP, "VIP", 5000),
    buildTicketType(TT_GA, "GA", 2500),
  ];
  const issued = overrides?.issued ?? {};

  const feePolicy = {
    id: FEE_POLICY_ID,
    scopeType: "ORG",
    scopeId: ORG_ID,
    status: "ACTIVE",
    version: 1,
    effectiveFrom: NOW,
    effectiveTo: null,
    buyerFeePct: 0,
    maxFeeCents: null,
    minFeeCents: 0,
    platformFixedCents: 0,
    feeMode: "PASS_THROUGH",
    processsorFeePct: 0,
    processorFixedCents: 0,
    payoutPct: 0.9,
    payoutFixedCents: 0,
    monthlyPayoutCents: 0,
  };

  return {
    repos: {
      events: {
        getById: vi.fn(async () => event),
        listTicketTypes: vi.fn(async () => ticketTypes),
      },
      // The card now reads the SAME lock-free batch counter the event page and
      // the pre-charge gate use, so its sold-out verdict cannot disagree with
      // the page a buyer clicks through to.
      ...makeTicketCapacityUsageFake(
        Object.fromEntries(
          Object.entries(issued).map(([id, count]) => [id, { issued: count }]),
        ),
      ),
      payoutTerms: {
        // No primary terms → estimator falls to the scoped fee-policy cascade.
        listByEvent: vi.fn(async () => []),
        listLines: vi.fn(async () => []),
      },
      feePolicies: {
        getById: vi.fn(async (id: string) =>
          id === FEE_POLICY_ID ? feePolicy : null,
        ),
        resolveEffective: vi.fn(async (args: { scopeType: string }) =>
          args.scopeType === "ORG" ? feePolicy : null,
        ),
      },
    } as unknown as TicketTiersForCardDeps["repos"],
    clock: testClock,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ticketTiersForCard", () => {
  it("orders tiers cheapest-first by buyer total", async () => {
    const deps = buildDeps({
      event: buildEvent({ admissionTaxRateBps: 1000 }), // 10%
      ticketTypes: [
        buildTicketType(TT_VIP, "VIP", 5000),
        buildTicketType(TT_GA, "GA", 2500),
      ],
    });

    const result = await ticketTiersForCard(deps, { eventId: EVENT_ID });

    expect(result.tiers.map((t) => t.id)).toEqual([TT_GA, TT_VIP]);
    // Zero-fee policy → buyer total = face + 10% tax.
    expect(result.tiers[0]).toMatchObject({
      id: TT_GA,
      faceCents: 2500,
      buyerTotalCents: 2750,
      soldOut: false,
    });
    expect(result.tiers[1]).toMatchObject({
      id: TT_VIP,
      faceCents: 5000,
      buyerTotalCents: 5500,
    });
  });

  it("nulls every paid tier's buyerTotalCents when tax is unresolved, but keeps face", async () => {
    const deps = buildDeps({
      event: buildEvent({ admissionTaxRateBps: null }),
      ticketTypes: [
        buildTicketType(TT_GA, "GA", 2500),
        buildTicketType(TT_VIP, "VIP", 5000),
      ],
    });

    const result = await ticketTiersForCard(deps, { eventId: EVENT_ID });

    // Cheapest-first still holds, falling back to face for ordering.
    expect(result.tiers.map((t) => t.id)).toEqual([TT_GA, TT_VIP]);
    for (const tier of result.tiers) {
      expect(tier.buyerTotalCents).toBeNull();
    }
    expect(result.tiers[0]!.faceCents).toBe(2500);
    expect(result.tiers[1]!.faceCents).toBe(5000);
  });

  it("keeps a free tier's buyerTotalCents at 0 even when tax is unresolved", async () => {
    const deps = buildDeps({
      event: buildEvent({ admissionTaxRateBps: null }),
      ticketTypes: [
        buildTicketType(TT_FREE, "Free", 0),
        buildTicketType(TT_GA, "GA", 2500),
      ],
    });

    const result = await ticketTiersForCard(deps, { eventId: EVENT_ID });

    const free = result.tiers.find((t) => t.id === TT_FREE)!;
    expect(free.faceCents).toBe(0);
    expect(free.buyerTotalCents).toBe(0); // not nulled — no fee/tax on $0
    // Free sorts ahead of the (null-tax) paid tier.
    expect(result.tiers[0]!.id).toBe(TT_FREE);

    const ga = result.tiers.find((t) => t.id === TT_GA)!;
    expect(ga.buyerTotalCents).toBeNull();
    expect(ga.faceCents).toBe(2500);
  });

  it("flags a tier sold out when issued reaches capacity", async () => {
    const deps = buildDeps({
      ticketTypes: [
        buildTicketType(TT_GA, "GA", 2500, { capacity: 50 }),
        buildTicketType(TT_VIP, "VIP", 5000, { capacity: 10 }),
      ],
      issued: { [TT_VIP]: 10, [TT_GA]: 49 },
    });

    const result = await ticketTiersForCard(deps, { eventId: EVENT_ID });

    const ga = result.tiers.find((t) => t.id === TT_GA)!;
    const vip = result.tiers.find((t) => t.id === TT_VIP)!;
    expect(ga.soldOut).toBe(false); // 49 < 50
    expect(vip.soldOut).toBe(true); // 10 >= 10
  });

  // THE POINT OF THE BATCH READ. Before this, the card counted ISSUED ONLY —
  // a third sold-out basis. Once the event page started telling the truth, a
  // card could render a tier un-struck while the page it links to said
  // "Sold out": capacity 10, 7 issued, 3 in another buyer's live cart. Two of
  // our own surfaces disagreeing in front of a buyer.
  it("counts HELD units, so the card cannot contradict the page it links to", async () => {
    const deps = buildDeps({
      ticketTypes: [buildTicketType(TT_VIP, "VIP", 5000, { capacity: 10 })],
    });
    // 7 issued + 3 held = 10 of 10. Issued-only would call this available.
    const tickets = deps.repos.tickets as unknown as {
      countCapacityUsageForTicketTypes: ReturnType<typeof vi.fn>;
    };
    tickets.countCapacityUsageForTicketTypes.mockResolvedValueOnce([
      { ticketTypeId: TT_VIP, issued: 7, held: 3 },
    ]);

    const result = await ticketTiersForCard(deps, { eventId: EVENT_ID });

    expect(result.tiers.find((t) => t.id === TT_VIP)!.soldOut).toBe(true);
  });

  it("reads inventory in ONE batched call, not one per tier", async () => {
    const deps = buildDeps({
      ticketTypes: [
        buildTicketType(TT_GA, "GA", 2500, { capacity: 50 }),
        buildTicketType(TT_VIP, "VIP", 5000, { capacity: 10 }),
      ],
    });

    await ticketTiersForCard(deps, { eventId: EVENT_ID });

    const tickets = deps.repos.tickets as unknown as {
      countCapacityUsageForTicketTypes: ReturnType<typeof vi.fn>;
    };
    // A per-tier fan-out on the hottest hover path is what this replaced.
    expect(tickets.countCapacityUsageForTicketTypes).toHaveBeenCalledTimes(1);
    expect(tickets.countCapacityUsageForTicketTypes).toHaveBeenCalledWith(
      expect.objectContaining({ ticketTypeIds: [TT_GA, TT_VIP] }),
    );
  });

  it("handles a single-tier event", async () => {
    const deps = buildDeps({
      event: buildEvent({ admissionTaxRateBps: 0 }),
      ticketTypes: [buildTicketType(TT_GA, "GA", 2500)],
    });

    const result = await ticketTiersForCard(deps, { eventId: EVENT_ID });

    expect(result.tiers).toHaveLength(1);
    expect(result.tiers[0]).toMatchObject({
      id: TT_GA,
      faceCents: 2500,
      buyerTotalCents: 2500, // 0% resolved tax → face == buyer total
      soldOut: false,
    });
  });

  // ── FR-010: the panel must agree with the badge behind it ─────────────────

  it("stamps onSale=true for every unwindowed tier (NFR-001)", async () => {
    const deps = buildDeps({
      event: buildEvent({ admissionTaxRateBps: 0 }),
      ticketTypes: [
        buildTicketType(TT_GA, "GA", 2500),
        buildTicketType(TT_VIP, "VIP", 5000),
      ],
    });

    const result = await ticketTiersForCard(deps, { eventId: EVENT_ID });

    expect(result.tiers.map((t) => t.onSale)).toEqual([true, true]);
    // Order is untouched by the new sort clause when nothing is windowed.
    expect(result.tiers.map((t) => t.id)).toEqual([TT_GA, TT_VIP]);
  });

  it("marks a not-yet-open tier onSale=false and sorts it AFTER the buyable ones", async () => {
    // The exact card the badge filter created: a cheap tier the buyer cannot
    // pay for yet. Before this, the panel put it FIRST — "Late release $5"
    // heading a panel whose badge reads "from $25".
    const deps = buildDeps({
      event: buildEvent({ admissionTaxRateBps: 0 }),
      ticketTypes: [
        buildTicketType(TT_VIP, "Late release", 500, {
          salesOpenAt: new Date("2026-06-01T00:00:00.000Z"), // after TEST_NOW
        }),
        buildTicketType(TT_GA, "GA", 2500),
      ],
    });

    const result = await ticketTiersForCard(deps, { eventId: EVENT_ID });

    // Cheapest ($5) is NOT first — `tiers[0]` must match the badge, which now
    // skips out-of-window tiers.
    expect(result.tiers.map((t) => t.id)).toEqual([TT_GA, TT_VIP]);
    expect(result.tiers[0]).toMatchObject({ id: TT_GA, onSale: true });
    expect(result.tiers[1]).toMatchObject({ id: TT_VIP, onSale: false });
  });

  it("marks an ELAPSED tier onSale=false but still returns it (dim, don't hide)", async () => {
    const deps = buildDeps({
      event: buildEvent({ admissionTaxRateBps: 0 }),
      ticketTypes: [
        buildTicketType(TT_VIP, "Early bird", 500, {
          salesCloseAt: new Date("2025-12-01T00:00:00.000Z"), // before TEST_NOW
        }),
        buildTicketType(TT_GA, "GA", 3000),
      ],
    });

    const result = await ticketTiersForCard(deps, { eventId: EVENT_ID });

    expect(result.tiers).toHaveLength(2);
    expect(result.tiers.map((t) => t.id)).toEqual([TT_GA, TT_VIP]);
    // Still carries its real face value — the panel shows what the event
    // offered, it just cannot be bought.
    expect(result.tiers[1]).toMatchObject({
      id: TT_VIP,
      faceCents: 500,
      onSale: false,
    });
  });

  it("returns no tiers when the event has no purchasable (active) tiers", async () => {
    const deps = buildDeps({
      ticketTypes: [
        buildTicketType(TT_GA, "GA (draft)", 2500, { status: "DRAFT" }),
      ],
    });

    const result = await ticketTiersForCard(deps, { eventId: EVENT_ID });
    expect(result.tiers).toEqual([]);

    // Never touches the estimator or inventory when nothing is active.
    const ticketsMock = deps.repos.tickets as unknown as {
      countCapacityUsageForTicketTypes: ReturnType<typeof vi.fn>;
    };
    expect(ticketsMock.countCapacityUsageForTicketTypes).not.toHaveBeenCalled();
  });

  it("throws EVENT_NOT_FOUND for a missing event", async () => {
    const deps = buildDeps({ event: null });
    await expect(
      ticketTiersForCard(deps, { eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("throws EVENT_NOT_ON_SALE for a non-published event", async () => {
    const deps = buildDeps({ event: buildEvent({ status: "DRAFT" }) });
    await expect(
      ticketTiersForCard(deps, { eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_ON_SALE" });
  });

  it("rejects an invalid eventId", async () => {
    const deps = buildDeps();
    await expect(
      ticketTiersForCard(deps, { eventId: "not-a-uuid" }),
    ).rejects.toThrow();
  });
});
