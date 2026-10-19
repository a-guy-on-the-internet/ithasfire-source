import { describe, expect, it } from "vitest";

import { computeDealSettlement } from "./compute-deal-settlement";
import {
  buildDoorSplitDeal,
  buildGuaranteeDeal,
  buildGuaranteePlusPercentDeal,
  buildRoomRentalDeal,
  buildStraightPercentDeal,
  buildVersusDeal,
  DEAL_PRESETS,
} from "./deal-presets";
import { classifyClauseForStage1, type DealDeduction } from "./deal-terms";

const ACT = "act";
const VENUE = "venue";
/** ACTUAL needs a platform figure for the remainder payee (W5); default 0. */
const actual = (basisCents: number, remainderPayeeId: string = VENUE) => ({
  ticketRevenue: { mode: "ACTUAL" as const, basisCents },
  paidThroughPlatform: [{ payeeId: remainderPayeeId, amountCents: 0 }],
});
const sound: DealDeduction = {
  id: "sound",
  kind: "EXPENSE",
  label: "Sound",
  amountCents: 20_000,
  percent: null,
  creditedPayeeId: VENUE,
  estimated: true,
};
const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected a throw");
};

describe("deal presets", () => {
  it("lists the six FR-003a presets", () => {
    expect(DEAL_PRESETS).toEqual([
      "GUARANTEE",
      "DOOR_SPLIT",
      "GUARANTEE_PLUS_PERCENT",
      "VERSUS",
      "STRAIGHT_PERCENT",
      "ROOM_RENTAL",
    ]);
  });

  it("Guarantee: a FIXED clause, settled directly, owed in full on a thin night", () => {
    const terms = buildGuaranteeDeal({ payeeId: ACT, guaranteeCents: 50_000, remainderPayeeId: VENUE });
    expect(terms).toEqual({
      clauses: [
        {
          id: "act:guarantee",
          payeeId: ACT,
          amountType: "FIXED",
          amountCents: 50_000,
          percent: null,
          basis: "GROSS",
          resolution: null,
          displayLabel: null,
        },
      ],
      deductions: [],
      remainderPayeeId: VENUE,
    });
    expect(classifyClauseForStage1(terms.clauses[0]!)).toBe("SETTLED_DIRECTLY");
    const r = computeDealSettlement(terms, actual(30_000));
    expect(r.clauses[0]?.entitlementCents).toBe(50_000);
    expect(r.shortfall).toMatchObject({ cents: 20_000, owedByPayeeId: VENUE });
  });

  it("Door split: a percent of the pool, after costs off the top", () => {
    const terms = buildDoorSplitDeal({ payeeId: ACT, percent: 80, remainderPayeeId: VENUE, deductions: [sound] });
    expect(terms.clauses[0]).toMatchObject({ amountType: "PERCENT", percent: 80, basis: "NET_POOL", resolution: null });
    expect(terms.deductions).toEqual([sound]);
    const r = computeDealSettlement(terms, actual(100_000));
    expect(r.clauses[0]?.entitlementCents).toBe(64_000); // 80% of $800
    expect(r.payees.find((p) => p.payeeId === VENUE)?.entitlementCents).toBe(36_000);
  });

  it("Guarantee + %: SUM, 'dollar one' on the gross by default, overridable to the pool", () => {
    const terms = buildGuaranteePlusPercentDeal({
      payeeId: ACT,
      guaranteeCents: 40_000,
      percent: 10,
      remainderPayeeId: VENUE,
      deductions: [sound],
    });
    expect(terms.clauses[0]).toMatchObject({ amountType: "FIXED_AND_PERCENT", basis: "GROSS", resolution: "SUM" });
    expect(computeDealSettlement(terms, actual(100_000)).clauses[0]?.entitlementCents).toBe(50_000);

    const afterCosts = buildGuaranteePlusPercentDeal({
      payeeId: ACT,
      guaranteeCents: 40_000,
      percent: 10,
      basis: "NET_POOL",
      remainderPayeeId: VENUE,
      deductions: [sound],
    });
    expect(computeDealSettlement(afterCosts, actual(100_000)).clauses[0]?.entitlementCents).toBe(48_000);
  });

  it("Versus: GREATER_OF on the pool by default", () => {
    const terms = buildVersusDeal({ payeeId: ACT, guaranteeCents: 80_000, percent: 70, remainderPayeeId: VENUE });
    expect(terms.clauses[0]).toMatchObject({
      id: "act:versus",
      amountType: "FIXED_AND_PERCENT",
      basis: "NET_POOL",
      resolution: "GREATER_OF",
    });
    expect(computeDealSettlement(terms, actual(200_000)).clauses[0]).toMatchObject({
      entitlementCents: 140_000,
      how: { picked: "PERCENT", percentCents: 140_000 },
    });
    expect(computeDealSettlement(terms, actual(100_000)).clauses[0]).toMatchObject({
      entitlementCents: 80_000,
      how: { picked: "FIXED", percentCents: 70_000 },
    });
  });

  it("Straight %: PERCENT on the gross — the one shape paid per order in stage 1", () => {
    const terms = buildStraightPercentDeal({ payeeId: ACT, percent: 85, remainderPayeeId: VENUE });
    expect(terms.clauses[0]).toMatchObject({ amountType: "PERCENT", percent: 85, basis: "GROSS" });
    expect(classifyClauseForStage1(terms.clauses[0]!)).toBe("PAID_PER_ORDER");
    const projection = computeDealSettlement(terms, {
      ticketRevenue: { mode: "PROJECTED", tiers: [{ tickets: 1, unitBasisCents: 100_001 }] },
    });
    expect(projection.clauses[0]?.entitlementCents).toBe(85_000);
    expect(projection.remainder.shareCents).toBe(15_001);
    // M9: on actual numbers it is what the per-order engine paid, and a deal
    // paid entirely per order leaves nothing to settle.
    const settled = computeDealSettlement(terms, {
      ...actual(100_001),
      paidThroughPlatform: [
        { payeeId: ACT, amountCents: 85_001 },
        { payeeId: VENUE, amountCents: 15_000 },
      ],
    });
    expect(settled.clauses[0]?.entitlementCents).toBe(85_001);
    expect(settled.payees.map((p) => p.settleDirectlyCents)).toEqual([0, 0]);
  });

  it("Room rental, fixed fee: the renter keeps the door and owes the rental even when the door is short", () => {
    const terms = buildRoomRentalDeal({
      venuePayeeId: VENUE,
      renterPayeeId: ACT,
      rentalCents: 50_000,
      mode: "FIXED_FEE",
    });
    expect(terms).toMatchObject({
      clauses: [{ id: "venue:room_rental", payeeId: VENUE, amountType: "FIXED", amountCents: 50_000 }],
      deductions: [],
      remainderPayeeId: ACT,
    });
    const r = computeDealSettlement(terms, actual(30_000, ACT));
    expect(r.shortfall).toEqual({
      cents: 20_000,
      owedByPayeeId: ACT,
      owedTo: [{ payeeId: VENUE, cents: 20_000 }],
      externalShortfallCents: 20_000,
      nettedCents: 0,
      ownClaimsUncoveredCents: 0,
    });
  });

  it("Room rental, recouped from the door: what the door can't cover is the venue's loss, not a debt", () => {
    const terms = buildRoomRentalDeal({
      venuePayeeId: VENUE,
      renterPayeeId: ACT,
      rentalCents: 50_000,
      mode: "RECOUPED_FROM_DOOR",
      deductions: [sound],
    });
    expect(terms.clauses).toEqual([]);
    expect(terms.deductions.map((d) => [d.id, d.kind, d.creditedPayeeId, d.estimated])).toEqual([
      ["venue:room_rental", "RENTAL", VENUE, false],
      ["sound", "EXPENSE", VENUE, true],
    ]);
    const r = computeDealSettlement(terms, actual(30_000, ACT));
    expect(r.waterfall.steps[0]).toMatchObject({ recoupedCents: 30_000, notRecoveredCents: 20_000 });
    expect(r.shortfall).toBeNull();
    expect(r.payees.find((p) => p.payeeId === ACT)?.entitlementCents).toBe(0);
  });

  it("appends extra clauses after the preset's own, and refuses a preset whose result is invalid", () => {
    const terms = buildVersusDeal({
      payeeId: ACT,
      guaranteeCents: 80_000,
      percent: 70,
      remainderPayeeId: VENUE,
      extraClauses: [
        { id: "support", payeeId: "support", amountType: "PERCENT", amountCents: null, percent: 10, basis: "NET_POOL", resolution: null, displayLabel: "Support" },
      ],
    });
    expect(terms.clauses.map((c) => c.id)).toEqual(["act:versus", "support"]);

    expect(thrown(() => buildStraightPercentDeal({ payeeId: ACT, percent: 101, remainderPayeeId: VENUE }))).toMatchObject({ code: "invalid_input" });
    expect(thrown(() => buildGuaranteeDeal({ payeeId: ACT, guaranteeCents: 0, remainderPayeeId: VENUE }))).toMatchObject({ code: "invalid_input" });
    expect(thrown(() =>
      buildVersusDeal({
        payeeId: ACT,
        guaranteeCents: 1,
        percent: 95,
        remainderPayeeId: VENUE,
        extraClauses: [
          { id: "s", payeeId: "s", amountType: "PERCENT", amountCents: null, percent: 10, basis: "NET_POOL", resolution: null, displayLabel: null },
        ],
      }),
    )).toMatchObject({ code: "invalid_input", message: "deal_percent_over_100" });
  });
});
