import { describe, expect, it } from "vitest";

import { computeOrderSplits } from "../pricing/compute-order-splits";
import {
  assertDealSettlementInvariants,
  assertFrozenSheetIdentities,
  computeDealSettlement,
  DEAL_SETTLEMENT_ENGINE_VERSION,
  DealSettlementInvariantError,
  percentOfCents,
  type DealSettlementResult,
} from "./compute-deal-settlement";
import { buildVersusDeal } from "./deal-presets";
import {
  MAX_DEAL_AMOUNT_CENTS,
  type DealClause,
  type DealDeduction,
  type DealSettlementInputsInput,
  type DealTermsInput,
} from "./deal-terms";

// ── Fixtures: the spec's standard indie deal ──────────────────────────────
// Lowlight Collective (headliner) $800 vs 70% of the pool; Paper Moth
// (support) 10% of the pool; Marrow Hall (venue) takes the remainder and
// fronted the rental $500, sound $300, marketing $150.

const LOWLIGHT = "lowlight";
const PAPER_MOTH = "paper-moth";
const MARROW_HALL = "marrow-hall";

const deduction = (
  id: string,
  amountCents: number,
  overrides: Partial<DealDeduction> = {},
): DealDeduction => ({
  id,
  kind: id === "rental" ? "RENTAL" : "EXPENSE",
  label: id,
  amountCents,
  percent: null,
  creditedPayeeId: MARROW_HALL,
  estimated: false,
  ...overrides,
});

const percentClause = (
  id: string,
  payeeId: string,
  percent: number,
  basis: "GROSS" | "NET_POOL",
): DealClause => ({
  id,
  payeeId,
  amountType: "PERCENT",
  amountCents: null,
  percent,
  basis,
  resolution: null,
  displayLabel: null,
});

const fixedClause = (id: string, payeeId: string, amountCents: number): DealClause => ({
  id,
  payeeId,
  amountType: "FIXED",
  amountCents,
  percent: null,
  basis: "GROSS",
  resolution: null,
  displayLabel: null,
});

const indieDeductions = (): DealDeduction[] => [
  deduction("rental", 50_000),
  deduction("sound", 30_000),
  deduction("marketing", 15_000),
];

const indieDeal = (deductions: DealDeduction[] = indieDeductions()) =>
  buildVersusDeal({
    payeeId: LOWLIGHT,
    guaranteeCents: 80_000,
    percent: 70,
    remainderPayeeId: MARROW_HALL,
    deductions,
    extraClauses: [percentClause("support", PAPER_MOTH, 10, "NET_POOL")],
  });

/** ACTUAL needs a platform figure for the remainder payee (W5); default 0. */
const actual = (basisCents: number): DealSettlementInputsInput => ({
  ticketRevenue: { mode: "ACTUAL", basisCents },
  paidThroughPlatform: [{ payeeId: MARROW_HALL, amountCents: 0 }],
});
const projected = (basisCents: number): DealSettlementInputsInput => ({
  ticketRevenue: { mode: "PROJECTED", tiers: [{ tickets: 1, unitBasisCents: basisCents }] },
});

const payee = (result: DealSettlementResult, id: string) => {
  const found = result.payees.find((p) => p.payeeId === id);
  if (!found) throw new Error(`no payee ${id}`);
  return found;
};
const clause = (result: DealSettlementResult, id: string) => {
  const found = result.clauses.find((c) => c.clauseId === id);
  if (!found) throw new Error(`no clause ${id}`);
  return found;
};
const step = (result: DealSettlementResult, id: string) => {
  const found = result.waterfall.steps.find((s) => s.deductionId === id);
  if (!found) throw new Error(`no step ${id}`);
  return found;
};
const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected a throw");
};
const sumOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
/** Each payee's balance in the result's mode (actual, else projected). */
const balances = (r: DealSettlementResult): Record<string, number> =>
  Object.fromEntries(
    r.payees.map((p) => {
      const v = p.settleDirectlyCents ?? p.projectedSettleDirectlyCents;
      if (v === null) throw new Error(`no balance for ${p.payeeId}`);
      return [p.payeeId, v];
    }),
  );

const HEADLINER_CLAUSE = "lowlight:versus";

// ── Acceptance criteria (deal-terms-and-settlement.spec.yaml) ─────────────

describe("acceptance: the standard indie deal", () => {
  it("$4,000 gross → headliner $2,135 (greater), support $305, venue $610 + $950 credits = $1,560, total $4,000", () => {
    const r = computeDealSettlement(indieDeal(), actual(400_000));

    expect(r.engineVersion).toBe(DEAL_SETTLEMENT_ENGINE_VERSION);
    expect(r.waterfall.grossCents).toBe(400_000);
    expect(r.waterfall.recoupedCents).toBe(95_000);
    expect(r.waterfall.notRecoveredCents).toBe(0);
    expect(r.waterfall.netPoolCents).toBe(305_000);

    const headliner = clause(r, HEADLINER_CLAUSE);
    expect(headliner.entitlementCents).toBe(213_500);
    expect(headliner.how).toEqual({
      kind: "GREATER_OF",
      fixedCents: 80_000,
      percent: 70,
      percentOf: {
        basis: "NET_POOL",
        basisCents: 305_000,
        afterDeductionIds: ["rental", "sound", "marketing"],
      },
      percentCents: 213_500,
      picked: "PERCENT",
    });
    expect(clause(r, "support").entitlementCents).toBe(30_500);

    const venue = payee(r, MARROW_HALL);
    expect(venue.remainderShareCents).toBe(61_000);
    expect(venue.creditedDeductionsCents).toBe(95_000);
    expect(venue.entitlementCents).toBe(156_000);
    expect(payee(r, LOWLIGHT).entitlementCents).toBe(213_500);
    expect(payee(r, PAPER_MOTH).entitlementCents).toBe(30_500);

    expect(r.shortfall).toBeNull();
    expect(r.conservation.distributedCents).toBe(400_000);
    expect(sumOf(r.payees.map((p) => p.entitlementCents))).toBe(400_000);
  });

  it("75 × $20 = $1,500 → pool $550; Lowlight $800 (guarantee beats $385), Paper Moth $55, Marrow Hall −$305 shortfall; total $1,500", () => {
    const r = computeDealSettlement(indieDeal(), {
      ticketRevenue: {
        mode: "PROJECTED",
        tiers: [{ tickets: 75, unitBasisCents: 2_000 }],
      },
    });

    expect(r.revenueMode).toBe("PROJECTED");
    expect(r.waterfall.grossCents).toBe(150_000);
    expect(r.waterfall.recoupedCents).toBe(95_000);
    expect(r.waterfall.netPoolCents).toBe(55_000);

    const headliner = clause(r, HEADLINER_CLAUSE);
    expect(headliner.entitlementCents).toBe(80_000);
    expect(headliner.how).toMatchObject({
      kind: "GREATER_OF",
      fixedCents: 80_000,
      percentCents: 38_500,
      picked: "FIXED",
    });
    expect(clause(r, "support").entitlementCents).toBe(5_500);
    expect(r.remainder).toEqual({ payeeId: MARROW_HALL, shareCents: -30_500, perOrderDifferenceCents: 0 });

    // Shortfall on both sides: Marrow Hall owes it, Lowlight is owed it.
    expect(r.shortfall).toEqual({
      cents: 30_500,
      owedByPayeeId: MARROW_HALL,
      owedTo: [{ payeeId: LOWLIGHT, cents: 30_500 }],
      externalShortfallCents: 30_500,
      nettedCents: 0,
      ownClaimsUncoveredCents: 0,
    });
    expect(payee(r, MARROW_HALL).shortfallOwedCents).toBe(30_500);
    expect(payee(r, LOWLIGHT).shortfallDueCents).toBe(30_500);
    expect(clause(r, "support").uncoveredCents).toBe(0);

    // Venue: −$305 pool share + $950 credits = $645.
    expect(payee(r, MARROW_HALL).entitlementCents).toBe(64_500);
    expect(r.conservation.distributedCents).toBe(150_000);
  });

  it("$600 gross → rental $500, sound $100 of $300, pool $0, percentages $0, guarantee owed in full, $200 + $150 not recovered", () => {
    const r = computeDealSettlement(indieDeal(), actual(60_000));

    expect(step(r, "rental")).toMatchObject({ recoupedCents: 50_000, notRecoveredCents: 0 });
    expect(step(r, "sound")).toMatchObject({
      availableBeforeCents: 10_000,
      recoupedCents: 10_000,
      notRecoveredCents: 20_000,
    });
    expect(step(r, "marketing")).toMatchObject({
      availableBeforeCents: 0,
      recoupedCents: 0,
      notRecoveredCents: 15_000,
    });
    expect(r.waterfall.netPoolCents).toBe(0);

    const headliner = clause(r, HEADLINER_CLAUSE);
    expect(headliner.how).toMatchObject({ percentCents: 0, picked: "FIXED" });
    expect(headliner.entitlementCents).toBe(80_000);
    expect(clause(r, "support").entitlementCents).toBe(0);

    expect(r.shortfall).toMatchObject({
      cents: 80_000,
      owedByPayeeId: MARROW_HALL,
      owedTo: [{ payeeId: LOWLIGHT, cents: 80_000 }],
      externalShortfallCents: 80_000,
    });

    const venue = payee(r, MARROW_HALL);
    expect(venue.creditedDeductions).toEqual([
      { deductionId: "rental", recoupedCents: 50_000, notRecoveredCents: 0 },
      { deductionId: "sound", recoupedCents: 10_000, notRecoveredCents: 20_000 },
      { deductionId: "marketing", recoupedCents: 0, notRecoveredCents: 15_000 },
    ]);
    expect(venue.notRecoveredCents).toBe(35_000);
    // $600 recouped − $800 shortfall: the venue is $200 out of pocket.
    expect(venue.entitlementCents).toBe(-20_000);
    expect(r.conservation.distributedCents).toBe(60_000);
  });

  it("a costs-fronting party other than the remainder payee carries its own 'Not recovered'", () => {
    const r = computeDealSettlement(
      indieDeal([
        deduction("rental", 50_000),
        deduction("sound", 30_000),
        deduction("marketing", 15_000, { creditedPayeeId: LOWLIGHT }),
      ]),
      actual(60_000),
    );
    expect(payee(r, LOWLIGHT).notRecoveredCents).toBe(15_000);
    expect(payee(r, MARROW_HALL).notRecoveredCents).toBe(20_000);
  });

  it("door cash left blank shows as not entered (no amount, not $0) and the totals say they exclude it", () => {
    const r = computeDealSettlement(indieDeal(), {
      ...actual(400_000),
      offPlatform: [
        { id: "door", kind: "DOOR_CASH", label: "Door cash", amountCents: null, heldByPayeeId: MARROW_HALL },
      ],
    });
    const door = r.offPlatform.rows[0];
    expect(door).toEqual({
      id: "door",
      kind: "DOOR_CASH",
      label: "Door cash",
      heldByPayeeId: MARROW_HALL,
      ownerPayeeId: MARROW_HALL,
      entered: false,
    });
    expect(door && "amountCents" in door).toBe(false);
    expect(r.offPlatform).toMatchObject({ enteredCents: 0, excludesIds: ["door"], defaultOwnerPayeeId: MARROW_HALL });
    expect(r.completeness).toEqual({
      notEnteredOffPlatformIds: ["door"],
      estimatedDeductionIds: [],
      complete: false,
    });
    expect(payee(r, MARROW_HALL)).toMatchObject({ heldOffPlatformCents: 0, offPlatformShareCents: 0 });
  });
});

// ── M8: off-platform money is held, not split ─────────────────────────────

describe("M8: off-platform money changes who holds money, not the split", () => {
  const withDoor = (heldByPayeeId: string, paid: Array<{ payeeId: string; amountCents: number }>) =>
    computeDealSettlement(indieDeal(), {
      ...actual(400_000),
      offPlatform: [
        { id: "door", kind: "DOOR_CASH", label: "Door cash", amountCents: 50_000, heldByPayeeId },
      ],
      paidThroughPlatform: paid,
    });

  it("door cash changes no percentage, no deduction and no entitlement", () => {
    const without = computeDealSettlement(indieDeal(), actual(400_000));
    const r = withDoor(MARROW_HALL, [{ payeeId: MARROW_HALL, amountCents: 0 }]);
    expect(r.waterfall).toEqual(without.waterfall);
    expect(r.clauses).toEqual(without.clauses);
    expect(r.payees.map((p) => p.entitlementCents)).toEqual(without.payees.map((p) => p.entitlementCents));
    expect(r.conservation.distributedCents).toBe(400_000);
    expect(r.offPlatform).toMatchObject({ enteredCents: 50_000, excludesIds: [], defaultOwnerPayeeId: MARROW_HALL });
  });

  it("a GROSS percentage is of ticket money only — $500 of door cash adds nothing to '20% of the gross'", () => {
    const r = computeDealSettlement(
      { clauses: [percentClause("dollar-one", LOWLIGHT, 20, "GROSS")], deductions: [], remainderPayeeId: MARROW_HALL },
      {
        ...projected(100_000),
        offPlatform: [
          { id: "door", kind: "DOOR_CASH", label: "Door cash", amountCents: 50_000, heldByPayeeId: MARROW_HALL },
        ],
      },
    );
    expect(clause(r, "dollar-one")).toMatchObject({
      entitlementCents: 20_000,
      how: { percentOf: { basis: "GROSS", basisCents: 100_000 } },
    });
    expect(payee(r, MARROW_HALL)).toMatchObject({ entitlementCents: 80_000, offPlatformShareCents: 50_000 });
  });

  it("held by the venue (the remainder payee): it holds its own money, so its balance is unchanged and the sheet nets to $0", () => {
    const r = withDoor(MARROW_HALL, [{ payeeId: MARROW_HALL, amountCents: 400_000 }]);
    expect(payee(r, MARROW_HALL)).toMatchObject({
      entitlementCents: 156_000,
      offPlatformShareCents: 50_000,
      heldOffPlatformCents: 50_000,
      settleDirectlyCents: 156_000 + 50_000 - 400_000 - 50_000,
    });
    expect(balances(r)).toEqual({ [LOWLIGHT]: 213_500, [PAPER_MOTH]: 30_500, [MARROW_HALL]: -244_000 });
    expect(sumOf(Object.values(balances(r)))).toBe(0);
  });

  it("M11: door cash owned by the remainder payee and held by it nets to 0 in its balance", () => {
    const without = computeDealSettlement(indieDeal(), actual(400_000));
    const r = computeDealSettlement(indieDeal(), {
      ...actual(400_000),
      offPlatform: [
        { id: "door", kind: "DOOR_CASH", label: "Door cash", amountCents: 50_000, heldByPayeeId: MARROW_HALL, ownerPayeeId: null },
      ],
    });
    expect(r.offPlatform.rows[0]?.ownerPayeeId).toBe(MARROW_HALL);
    expect(payee(r, MARROW_HALL)).toMatchObject({ offPlatformShareCents: 50_000, heldOffPlatformCents: 50_000 });
    expect(balances(r)).toEqual(balances(without));
  });

  it("M11: a bar share owned by an act and held by the venue — the venue owes it to the act", () => {
    const without = computeDealSettlement(indieDeal(), actual(400_000));
    const r = computeDealSettlement(indieDeal(), {
      ...actual(400_000),
      offPlatform: [
        { id: "bar", kind: "BAR_SHARE", label: "Bar share", amountCents: 20_000, heldByPayeeId: MARROW_HALL, ownerPayeeId: LOWLIGHT },
      ],
    });
    // Never split: every clause and entitlement is unchanged.
    expect(r.clauses).toEqual(without.clauses);
    expect(r.payees.map((p) => p.entitlementCents)).toEqual(without.payees.map((p) => p.entitlementCents));
    expect(r.offPlatform.rows[0]).toMatchObject({ ownerPayeeId: LOWLIGHT, heldByPayeeId: MARROW_HALL });
    expect(payee(r, LOWLIGHT)).toMatchObject({ offPlatformShareCents: 20_000, heldOffPlatformCents: 0 });
    expect(payee(r, MARROW_HALL)).toMatchObject({ offPlatformShareCents: 0, heldOffPlatformCents: 20_000 });
    expect(balances(r)[LOWLIGHT]).toBe((balances(without)[LOWLIGHT] as number) + 20_000);
    expect(balances(r)[MARROW_HALL]).toBe((balances(without)[MARROW_HALL] as number) - 20_000);
    expect(r.conservation.settleDirectlyNetCents).toBe(r.conservation.expectedSettleDirectlyNetCents);
  });

  it("M11: an owner who isn't in the deal is refused", () => {
    for (const ownerPayeeId of ["stranger", "lowlite"]) {
      expect(thrown(() =>
        computeDealSettlement(indieDeal(), {
          ...actual(400_000),
          offPlatform: [
            { id: "bar", kind: "BAR_SHARE", label: "Bar share", amountCents: 20_000, heldByPayeeId: MARROW_HALL, ownerPayeeId },
          ],
        }),
      )).toMatchObject({ code: "invalid_input", message: "deal_off_platform_unknown_owner" });
    }
  });

  it("held by an act: that act's balance goes down by it and the venue's goes up by it", () => {
    const r = withDoor(LOWLIGHT, [{ payeeId: MARROW_HALL, amountCents: 400_000 }]);
    expect(payee(r, LOWLIGHT)).toMatchObject({ heldOffPlatformCents: 50_000, settleDirectlyCents: 213_500 - 50_000 });
    expect(payee(r, MARROW_HALL).settleDirectlyCents).toBe(156_000 + 50_000 - 400_000);
    expect(sumOf(Object.values(balances(r)))).toBe(0);
    expect(r.conservation.settleDirectlyNetCents).toBe(r.conservation.expectedSettleDirectlyNetCents);
  });
});

// ── The 08-07 worked example ──────────────────────────────────────────────

describe("08-07 event-settlement-report worked example", () => {
  // M10: the $250 room deposit is a direct payment, not a deduction. 08-07
  // does not name who paid it; the party who booked the room — the
  // headliner's side — is used here. Both sides are named (B1).
  const deposit = {
    id: "deposit",
    label: "Room deposit, paid at booking",
    fromPayeeId: LOWLIGHT,
    toPayeeId: MARROW_HALL,
    amountCents: 25_000,
  };

  it("reproduces the sheet to the cent: venue expects $1,560, less the $250 deposit = $1,310 still to receive", () => {
    const r = computeDealSettlement(indieDeal(), { ...actual(400_000), directPayments: [deposit] });

    expect(r.waterfall.netPoolCents).toBe(305_000);
    expect(r.waterfall.recoupedCents).toBe(95_000); // the deposit moved no waterfall figure
    expect(payee(r, LOWLIGHT).entitlementCents).toBe(213_500);
    expect(payee(r, PAPER_MOTH).entitlementCents).toBe(30_500);
    const venue = payee(r, MARROW_HALL);
    expect(venue).toMatchObject({
      remainderShareCents: 61_000,
      creditedDeductionsCents: 95_000,
      entitlementCents: 156_000,
      directReceivedCents: 25_000,
      settleDirectlyCents: 131_000,
    });
    // The deposit lowers what the payer still owes: Lowlight is owed it back.
    expect(payee(r, LOWLIGHT)).toMatchObject({ directPaidCents: 25_000, settleDirectlyCents: 238_500 });
  });

  it("with the platform having paid the venue the whole $4,000, the sheet balances: every + has a −", () => {
    const r = computeDealSettlement(indieDeal(), {
      ...actual(400_000),
      directPayments: [deposit],
      paidThroughPlatform: [{ payeeId: MARROW_HALL, amountCents: 400_000 }],
    });
    expect(balances(r)).toEqual({
      [LOWLIGHT]: 213_500 + 25_000,
      [PAPER_MOTH]: 30_500,
      [MARROW_HALL]: 156_000 - 400_000 - 25_000,
    });
    expect(r.conservation.settleDirectlyNetCents).toBe(0);
    expect(r.conservation.expectedSettleDirectlyNetCents).toBe(0);
  });

  // The 08-07 shortfall example says "same deal, show grosses $500" but then
  // prints "Net pool $500.00" — which is only true with NO costs off the top
  // (with the $950 of deductions, a $500 gross recoups the rental alone and
  // the pool is $0). Reproduced here as printed, i.e. with no deductions.
  it("shortfall example as printed: pool $500 → headliner $800, support $50, venue −$350", () => {
    const r = computeDealSettlement(indieDeal([]), actual(50_000));
    expect(r.waterfall.netPoolCents).toBe(50_000);
    expect(clause(r, HEADLINER_CLAUSE)).toMatchObject({
      entitlementCents: 80_000,
      how: { percentCents: 35_000, picked: "FIXED" },
    });
    expect(clause(r, "support").entitlementCents).toBe(5_000);
    expect(r.remainder.shareCents).toBe(-35_000);
    expect(r.shortfall?.cents).toBe(35_000);
    expect(r.conservation.distributedCents).toBe(50_000);
  });

  it("the same deal at $500 WITH its deductions: the rental takes it all and the guarantee is the shortfall", () => {
    const r = computeDealSettlement(indieDeal(), actual(50_000));
    expect(r.waterfall.netPoolCents).toBe(0);
    expect(r.shortfall?.cents).toBe(80_000);
    expect(payee(r, MARROW_HALL).entitlementCents).toBe(50_000 - 80_000);
  });
});

// ── Direct payments (B1, W6, M10) ─────────────────────────────────────────

describe("direct payments", () => {
  const pay = (fromPayeeId: unknown, toPayeeId: string) => () =>
    computeDealSettlement(indieDeal(), {
      ...actual(400_000),
      directPayments: [{ id: "x", label: "x", fromPayeeId, toPayeeId, amountCents: 1_000 } as never],
    });

  it("moves both balances by the same amount and nothing else", () => {
    const r = pay(MARROW_HALL, LOWLIGHT)() as DealSettlementResult;
    expect(payee(r, LOWLIGHT).settleDirectlyCents).toBe(213_500 - 1_000);
    expect(payee(r, MARROW_HALL).settleDirectlyCents).toBe(156_000 + 1_000);
    expect(r.payees.map((p) => p.entitlementCents)).toEqual([213_500, 30_500, 156_000]);
  });

  it("refuses a payment with a missing side (no money owed to nobody)", () => {
    expect(thrown(pay(null, MARROW_HALL))).toMatchObject({ code: "invalid_input" });
    expect(thrown(pay(undefined, MARROW_HALL))).toMatchObject({ code: "invalid_input" });
  });

  it("refuses a party who is not in the deal, a typo, and a payment to oneself", () => {
    expect(thrown(pay("lowlite", MARROW_HALL))).toMatchObject({ code: "invalid_input", message: "deal_direct_payment_unknown_party" });
    expect(thrown(pay(MARROW_HALL, "stranger"))).toMatchObject({ code: "invalid_input", message: "deal_direct_payment_unknown_party" });
    expect(thrown(pay(LOWLIGHT, LOWLIGHT))).toMatchObject({ code: "invalid_input", message: "deal_direct_payment_to_self" });
  });

  it("accepts every kind of participant: a credited party included", () => {
    const r = computeDealSettlement(
      indieDeal([deduction("sound", 1_000, { creditedPayeeId: "sound-co" })]),
      {
        ...actual(400_000),
        offPlatform: [{ id: "bar", kind: "BAR_SHARE", label: "Bar", amountCents: 500, heldByPayeeId: "sound-co" }],
        directPayments: [
          { id: "a", label: "a", fromPayeeId: "sound-co", toPayeeId: MARROW_HALL, amountCents: 1 },
        ],
      },
    );
    expect(payee(r, "sound-co").directPaidCents).toBe(1);
    expect(payee(r, "sound-co").heldOffPlatformCents).toBe(500);
  });

  it("refuses an off-platform row that would make a stranger a participant", () => {
    // Before P4b the holder of a row joined the participant set, so a typed-in
    // "Bar — held by bar-staff" put a stranger on the sheet, able to be paid
    // and owed. Participants come from the terms only.
    expect(
      thrown(() =>
        computeDealSettlement(indieDeal([]), {
          ...actual(400_000),
          offPlatform: [{ id: "bar", kind: "BAR_SHARE", label: "Bar", amountCents: 500, heldByPayeeId: "bar-staff" }],
        }),
      ),
    ).toMatchObject({ code: "invalid_input", message: "deal_off_platform_unknown_holder" });
    // A not-entered row is refused too: naming the holder is the act that matters.
    expect(
      thrown(() =>
        computeDealSettlement(indieDeal([]), {
          ...actual(400_000),
          offPlatform: [{ id: "bar", kind: "BAR_SHARE", label: "Bar", amountCents: null, heldByPayeeId: "bar-staff" }],
        }),
      ),
    ).toMatchObject({ code: "invalid_input", message: "deal_off_platform_unknown_holder" });
  });

  it("M10: DEPOSIT_PAID is not a cost off the top", () => {
    expect(thrown(() =>
      computeDealSettlement(indieDeal([deduction("deposit", 25_000, { kind: "DEPOSIT_PAID" as never })]), actual(1)),
    )).toMatchObject({ code: "invalid_input" });
  });
});

// ── M9 + stage 1: paid through Ithas Fire / settle directly ───────────────

describe("M9: per-order lines are entitled to what the platform paid", () => {
  const orders = [1_999, 1_999, 1_999, 5_003];
  const basis = sumOf(orders); // 11,000
  const perOrderPaid = () => {
    const lines = [
      { id: "a", payeeId: LOWLIGHT, percent: 20, capPercent: null, priority: 0, rounding: "FLOOR" as const },
      { id: "v", payeeId: MARROW_HALL, percent: 80, capPercent: null, priority: 0, rounding: "FLOOR" as const },
    ];
    const paid = new Map<string, number>();
    for (const amountCents of orders) {
      for (const split of computeOrderSplits({ amountCents, lines }).splits) {
        paid.set(split.payeeId, (paid.get(split.payeeId) ?? 0) + split.amountCents);
      }
    }
    return [...paid].map(([payeeId, amountCents]) => ({ payeeId, amountCents }));
  };
  const straight: DealTermsInput = {
    clauses: [percentClause("dollar-one", LOWLIGHT, 20, "GROSS")],
    deductions: [],
    remainderPayeeId: MARROW_HALL,
  };

  it("each clause carries its stage-1 label; only PERCENT on GROSS is paid per order", () => {
    const r = computeDealSettlement(
      {
        clauses: [
          percentClause("dollar-one", LOWLIGHT, 20, "GROSS"),
          percentClause("door", PAPER_MOTH, 10, "NET_POOL"),
          fixedClause("guarantee", "third", 10_000),
        ],
        deductions: [],
        remainderPayeeId: MARROW_HALL,
      },
      projected(100_000),
    );
    expect(r.clauses.map((c) => [c.clauseId, c.stage1])).toEqual([
      ["dollar-one", "PAID_PER_ORDER"],
      ["door", "SETTLED_DIRECTLY"],
      ["guarantee", "SETTLED_DIRECTLY"],
    ]);
  });

  it("a deal paid entirely per order settles at $0.00, with the per-order rounding cent landing on the remainder", () => {
    const paid = perOrderPaid();
    expect(paid).toEqual([
      { payeeId: LOWLIGHT, amountCents: 2_201 },
      { payeeId: MARROW_HALL, amountCents: 8_799 },
    ]);
    const r = computeDealSettlement(straight, { ...actual(basis), paidThroughPlatform: paid });
    expect(clause(r, "dollar-one")).toMatchObject({
      entitlementCents: 2_201,
      how: { percentCents: percentOfCents(basis, 20), paidPerOrderCents: 2_201 },
    });
    expect(r.remainder).toEqual({ payeeId: MARROW_HALL, shareCents: 8_799, perOrderDifferenceCents: 1 });
    expect(balances(r)).toEqual({ [LOWLIGHT]: 0, [MARROW_HALL]: 0 });
    expect(r.shortfall).toBeNull();
  });

  it("PROJECTED keeps the exact percentage", () => {
    const r = computeDealSettlement(straight, projected(basis));
    expect(clause(r, "dollar-one")).toMatchObject({ entitlementCents: 2_200, how: { paidPerOrderCents: null } });
  });

  it("refuses ACTUAL without a platform figure for a per-order payee (unknown is not $0); an explicit 0 is accepted", () => {
    expect(thrown(() => computeDealSettlement(straight, actual(basis)))).toMatchObject({
      code: "invalid_input",
      message: "deal_paid_through_platform_missing",
    });
    const r = computeDealSettlement(straight, {
      ...actual(basis),
      paidThroughPlatform: [
        { payeeId: LOWLIGHT, amountCents: 0 },
        { payeeId: MARROW_HALL, amountCents: 0 },
      ],
    });
    expect(clause(r, "dollar-one").entitlementCents).toBe(0);
  });

  it("W5: ACTUAL requires a figure for the remainder payee too (0 is fine, missing is refused)", () => {
    const noRemainder = { ticketRevenue: { mode: "ACTUAL" as const, basisCents: 400_000 } };
    expect(thrown(() => computeDealSettlement(indieDeal(), noRemainder))).toMatchObject({
      code: "invalid_input",
      message: "deal_paid_through_platform_missing",
    });
    expect(() => computeDealSettlement(indieDeal(), actual(400_000))).not.toThrow();
  });

  it("W5: refuses a platform payee who isn't in the deal (a stranger or a typo), and payouts above the gross", () => {
    for (const payeeId of ["stray", "marrow-hal"]) {
      expect(thrown(() =>
        computeDealSettlement(indieDeal(), {
          ...actual(400_000),
          paidThroughPlatform: [
            { payeeId: MARROW_HALL, amountCents: 0 },
            { payeeId, amountCents: 1_000 },
          ],
        }),
      )).toMatchObject({ code: "invalid_input", message: "deal_paid_through_platform_unknown_payee" });
    }
    expect(thrown(() =>
      computeDealSettlement(indieDeal(), {
        ...actual(400_000),
        paidThroughPlatform: [{ payeeId: MARROW_HALL, amountCents: 400_001 }],
      }),
    )).toMatchObject({ code: "invalid_input", message: "deal_paid_exceeds_gross" });
  });

  it("W4: PROJECTED refuses real payments and splits each payee into 'Paid through Ithas Fire' and 'Settle directly'", () => {
    expect(thrown(() =>
      computeDealSettlement(straight, { ...projected(basis), paidThroughPlatform: perOrderPaid() }),
    )).toMatchObject({ code: "invalid_input", message: "deal_paid_through_platform_in_projection" });

    const r = computeDealSettlement(indieDeal(), {
      ticketRevenue: { mode: "PROJECTED", tiers: [{ tickets: 75, unitBasisCents: 2_000 }] },
    });
    // Nothing in the indie deal is per order, so the platform pays the venue
    // the whole $1,500 and everything else is settled directly.
    expect(r.payees.map((p) => [p.payeeId, p.projectedPaidPerOrderCents, p.projectedSettleDirectlyCents])).toEqual([
      [LOWLIGHT, 0, 80_000],
      [PAPER_MOTH, 0, 5_500],
      [MARROW_HALL, 150_000, 64_500 - 150_000],
    ]);
    expect(r.payees.every((p) => p.paidThroughPlatformCents === null && p.settleDirectlyCents === null)).toBe(true);

    const pct = computeDealSettlement(straight, projected(basis));
    expect(pct.payees.map((p) => [p.payeeId, p.projectedPaidPerOrderCents, p.projectedSettleDirectlyCents])).toEqual([
      [LOWLIGHT, 2_200, 0],
      [MARROW_HALL, 8_800, 0],
    ]);
    expect(sumOf(pct.payees.map((p) => p.projectedPaidPerOrderCents ?? 0))).toBe(basis);
  });

  it("W3: flags a platform payment that order-count rounding can't explain (a warning, not a refusal)", () => {
    const run = (lowlightPaid: number, orderCount: number) =>
      computeDealSettlement(straight, {
        ticketRevenue: { mode: "ACTUAL", basisCents: basis, orderCount },
        paidThroughPlatform: [
          { payeeId: LOWLIGHT, amountCents: lowlightPaid },
          { payeeId: MARROW_HALL, amountCents: basis - lowlightPaid },
        ],
      });
    // 4 orders, 1 per-order line: tolerance 1 × (4 + 1) = 5 cents either way.
    const ok = run(2_201, 4);
    expect(payee(ok, LOWLIGHT).perOrderCheck).toEqual({ paidCents: 2_201, expectedCents: 2_200, toleranceCents: 5, plausible: true });
    expect(payee(ok, MARROW_HALL).perOrderCheck).toEqual({ paidCents: 8_799, expectedCents: 8_800, toleranceCents: 5, plausible: true });
    expect(ok.warnings.implausiblePerOrderPayeeIds).toEqual([]);

    const off = run(2_300, 4);
    expect(payee(off, LOWLIGHT).perOrderCheck?.plausible).toBe(false);
    expect(off.warnings.implausiblePerOrderPayeeIds).toEqual([LOWLIGHT, MARROW_HALL]);
    expect(balances(off)).toEqual({ [LOWLIGHT]: 0, [MARROW_HALL]: 0 }); // still computed

    // No orderCount: not checked (null), never reported as plausible.
    const unchecked = computeDealSettlement(straight, {
      ...actual(basis),
      paidThroughPlatform: [
        { payeeId: LOWLIGHT, amountCents: 2_300 },
        { payeeId: MARROW_HALL, amountCents: 8_700 },
      ],
    });
    expect(unchecked.payees.map((p) => p.perOrderCheck)).toEqual([null, null]);
  });

  it("a payee's per-order and direct clauses stay separable: the platform payment is the per-order part, the guarantee is settled directly", () => {
    const r = computeDealSettlement(
      {
        clauses: [percentClause("pct", LOWLIGHT, 10, "GROSS"), fixedClause("g", LOWLIGHT, 50_000)],
        deductions: [],
        remainderPayeeId: MARROW_HALL,
      },
      {
        ...actual(100_000),
        paidThroughPlatform: [
          { payeeId: LOWLIGHT, amountCents: 10_050 },
          { payeeId: MARROW_HALL, amountCents: 0 },
        ],
      },
    );
    expect(clause(r, "pct").entitlementCents).toBe(10_050);
    expect(clause(r, "g").entitlementCents).toBe(50_000);
    expect(payee(r, LOWLIGHT)).toMatchObject({ entitlementCents: 60_050, settleDirectlyCents: 50_000 });
    expect(r.remainder.perOrderDifferenceCents).toBe(50);
  });

  it("several per-order clauses for one payee share the payment by largest remainder", () => {
    const r = computeDealSettlement(
      {
        clauses: [percentClause("p10", LOWLIGHT, 10, "GROSS"), percentClause("p5", LOWLIGHT, 5, "GROSS")],
        deductions: [],
        remainderPayeeId: MARROW_HALL,
      },
      {
        ...actual(10_000),
        paidThroughPlatform: [
          { payeeId: LOWLIGHT, amountCents: 1_501 },
          { payeeId: MARROW_HALL, amountCents: 0 },
        ],
      },
    );
    expect(r.clauses.map((c) => c.entitlementCents)).toEqual([1_001, 500]);
  });

  it("the remainder payee's own per-order clause keeps the exact percentage (its total is the same either way)", () => {
    const r = computeDealSettlement(
      {
        clauses: [percentClause("own", MARROW_HALL, 20, "GROSS"), percentClause("act", LOWLIGHT, 30, "NET_POOL")],
        deductions: [],
        remainderPayeeId: MARROW_HALL,
      },
      { ...actual(10_000), paidThroughPlatform: [{ payeeId: MARROW_HALL, amountCents: 7_000 }] },
    );
    expect(clause(r, "own")).toMatchObject({ entitlementCents: 2_000, how: { paidPerOrderCents: null } });
    expect(payee(r, MARROW_HALL)).toMatchObject({ entitlementCents: 7_000, settleDirectlyCents: 0 });
    expect(payee(r, LOWLIGHT).settleDirectlyCents).toBe(3_000);
  });

  it("door cash held by the venue counts toward its balance and nets out", () => {
    const r = computeDealSettlement(indieDeal(), {
      ...actual(370_000),
      offPlatform: [
        { id: "door", kind: "DOOR_CASH", label: "Door cash", amountCents: 30_000, heldByPayeeId: MARROW_HALL },
      ],
      paidThroughPlatform: [{ payeeId: MARROW_HALL, amountCents: 370_000 }],
    });
    expect(r.waterfall.grossCents).toBe(370_000);
    expect(r.completeness.complete).toBe(true);
    expect(r.conservation.settleDirectlyNetCents).toBe(0);
  });

  it("a participant the platform paid beyond its entitlement shows a negative balance", () => {
    // Strangers are refused (W5); a participant with nothing per order can
    // still have been paid, and its balance shows it owes the money back.
    const r = computeDealSettlement(
      { clauses: [fixedClause("g", LOWLIGHT, 1_000)], deductions: [], remainderPayeeId: MARROW_HALL },
      {
        ...actual(10_000),
        paidThroughPlatform: [
          { payeeId: MARROW_HALL, amountCents: 7_000 },
          { payeeId: LOWLIGHT, amountCents: 3_000 },
        ],
      },
    );
    expect(payee(r, LOWLIGHT)).toMatchObject({
      entitlementCents: 1_000,
      paidThroughPlatformCents: 3_000,
      settleDirectlyCents: -2_000,
    });
  });
});

// ── M12 and W1: per-order lines are paid before costs ─────────────────────

describe("M12: costs come out of what the platform has not already paid out", () => {
  const PROMOTER = "promoter";

  it("the reviewer's example: rental 100,000 to the promoter recoups only the 80,000 left after Lowlight's 20% — no hidden out-of-pocket", () => {
    const r = computeDealSettlement(
      {
        clauses: [percentClause("ll", LOWLIGHT, 20, "GROSS")],
        deductions: [deduction("rental", 100_000, { creditedPayeeId: PROMOTER })],
        remainderPayeeId: MARROW_HALL,
      },
      {
        ...actual(100_000),
        paidThroughPlatform: [
          { payeeId: LOWLIGHT, amountCents: 20_000 },
          { payeeId: MARROW_HALL, amountCents: 80_000 },
        ],
      },
    );
    expect(r.waterfall).toMatchObject({
      perOrderPaidFirstCents: 20_000,
      availableForCostsCents: 80_000,
      recoupedCents: 80_000,
      notRecoveredCents: 20_000,
      netPoolCents: 0,
    });
    expect(payee(r, PROMOTER)).toMatchObject({ creditedDeductionsCents: 80_000, notRecoveredCents: 20_000 });
    expect(r.remainder.shareCents).toBe(0);
    expect(r.shortfall).toBeNull();
    // The venue received 80,000 per order and hands exactly that to the
    // promoter: −80,000 to settle, 0 out of its own pocket. (Before M12 it
    // owed 100,000 having received 80,000.)
    expect(balances(r)).toEqual({ [LOWLIGHT]: 0, [MARROW_HALL]: -80_000, [PROMOTER]: 80_000 });
    expect(payee(r, MARROW_HALL).entitlementCents).toBe(0);
    expect(sumOf(r.payees.map((p) => p.entitlementCents))).toBe(100_000);
  });

  it("PROJECTED uses the exact per-order amounts, so the editor matches the night", () => {
    const terms: DealTermsInput = {
      clauses: [percentClause("ll", LOWLIGHT, 20, "GROSS")],
      deductions: [deduction("rental", 100_000, { creditedPayeeId: PROMOTER })],
      remainderPayeeId: MARROW_HALL,
    };
    const r = computeDealSettlement(terms, projected(100_000));
    expect(r.waterfall).toMatchObject({ perOrderPaidFirstCents: 20_000, recoupedCents: 80_000, notRecoveredCents: 20_000 });
    expect(r.payees.map((p) => [p.payeeId, p.projectedPaidPerOrderCents, p.projectedSettleDirectlyCents])).toEqual([
      [LOWLIGHT, 20_000, 0],
      [MARROW_HALL, 80_000, -80_000],
      [PROMOTER, 0, 80_000],
    ]);
  });

  it("W1: legacy 100%-summing terms paid per order settle at $0 with no phantom shortfall", () => {
    // Lowlight 20% + Marrow Hall (remainder) 80%, both per order; the
    // per-order engine paid Lowlight 2,201 (one rounding cent over 2,200).
    const r = computeDealSettlement(
      {
        clauses: [percentClause("ll", LOWLIGHT, 20, "GROSS"), percentClause("mh", MARROW_HALL, 80, "GROSS")],
        deductions: [],
        remainderPayeeId: MARROW_HALL,
      },
      {
        ...actual(11_000),
        paidThroughPlatform: [
          { payeeId: LOWLIGHT, amountCents: 2_201 },
          { payeeId: MARROW_HALL, amountCents: 8_799 },
        ],
      },
    );
    expect(r.remainder.shareCents).toBe(0);
    expect(r.shortfall).toBeNull();
    expect(clause(r, "mh")).toMatchObject({ entitlementCents: 8_799, how: { percentCents: 8_800 } });
    // The cap bit by one cent: the sheet can say "80% = $88.00, capped to $87.99".
    expect(clause(r, "mh").cappedFromCents).toBe(8_800);
    expect(clause(r, "ll").cappedFromCents).toBeNull();
    expect(balances(r)).toEqual({ [LOWLIGHT]: 0, [MARROW_HALL]: 0 });
  });

  it("W1: the cap lowers the remainder's own per-order clause to what a guarantee leaves, and says so", () => {
    // The P4b shape: Marrow Hall (remainder) is paid "the rest" per order
    // (90%), Paper Moth 10% per order, Lowlight an $800 guarantee settled
    // directly. At $1,000 the pool is $900 after Paper Moth; the guarantee
    // takes $800, so Marrow Hall's 90% ($900) is capped to the $100 left.
    const r = computeDealSettlement(
      {
        clauses: [
          percentClause("pm", PAPER_MOTH, 10, "GROSS"),
          fixedClause("g", LOWLIGHT, 80_000),
          percentClause("rest", MARROW_HALL, 90, "GROSS"),
        ],
        deductions: [],
        remainderPayeeId: MARROW_HALL,
      },
      {
        ...actual(100_000),
        paidThroughPlatform: [
          { payeeId: PAPER_MOTH, amountCents: 10_000 },
          { payeeId: MARROW_HALL, amountCents: 90_000 },
        ],
      },
    );
    expect(clause(r, "rest")).toMatchObject({ entitlementCents: 10_000, cappedFromCents: 90_000 });
    expect(r.shortfall).toBeNull();
    // Marrow Hall was paid $900 per order and owes Lowlight the $800.
    expect(balances(r)).toEqual({ [PAPER_MOTH]: 0, [LOWLIGHT]: 80_000, [MARROW_HALL]: -80_000 });
  });

  it("engine v4: a 0% PERCENT/GROSS clause is per-order — the engine pays it rounding cents, and those settle at $0", () => {
    // 33% + 0% + 67% on a 1,001¢ order: floors 330 + 0 + 670 = 1,000; the
    // engine's round-robin hands the dropped cent to the FIRST line — here the
    // 0% one. Classed as settled directly (v3) it was entitled to $0 while
    // paid 1¢, and a deal paid entirely per order showed 1¢ to settle.
    const zeroFirst = computeOrderSplits({
      amountCents: 1_001,
      lines: [
        { id: "z", payeeId: "a-zero", percent: 0, capPercent: null, priority: 9, rounding: "FLOOR" as const },
        { id: "l", payeeId: LOWLIGHT, percent: 33, capPercent: null, priority: 0, rounding: "FLOOR" as const },
        { id: "m", payeeId: MARROW_HALL, percent: 67, capPercent: null, priority: 0, rounding: "FLOOR" as const },
      ],
    });
    const paid = Object.fromEntries(zeroFirst.splits.map((x) => [x.payeeId, x.amountCents]));
    expect(paid["a-zero"]).toBe(1);
    const r = computeDealSettlement(
      {
        clauses: [
          percentClause("z", "a-zero", 0, "GROSS"),
          percentClause("l", LOWLIGHT, 33, "GROSS"),
          percentClause("m", MARROW_HALL, 67, "GROSS"),
        ],
        deductions: [],
        remainderPayeeId: MARROW_HALL,
      },
      {
        ...actual(1_001),
        paidThroughPlatform: zeroFirst.splits.map((x) => ({ payeeId: x.payeeId, amountCents: x.amountCents })),
      },
    );
    expect(clause(r, "z")).toMatchObject({ stage1: "PAID_PER_ORDER", paidBeforeCosts: true, entitlementCents: 1 });
    expect(balances(r)).toEqual({ "a-zero": 0, [LOWLIGHT]: 0, [MARROW_HALL]: 0 });
    // Projected, a 0% line is $0 as ever, and so is its per-order pay.
    const projectedZero = computeDealSettlement(
      { clauses: [percentClause("zero", LOWLIGHT, 0, "GROSS")], deductions: [], remainderPayeeId: MARROW_HALL },
      projected(10_000),
    );
    expect(clause(projectedZero, "zero").entitlementCents).toBe(0);
    expect(payee(projectedZero, LOWLIGHT).projectedPaidPerOrderCents).toBe(0);
    // ACTUAL needs the platform figure for it now (W5), 0 included.
    expect(
      thrown(() =>
        computeDealSettlement(
          { clauses: [percentClause("zero", LOWLIGHT, 0, "GROSS")], deductions: [], remainderPayeeId: MARROW_HALL },
          actual(10_000),
        ),
      ),
    ).toMatchObject({ code: "invalid_input", message: "deal_paid_through_platform_missing" });
  });
});

// ── Shortfall attribution (W2, W3) ────────────────────────────────────────

describe("shortfall attribution", () => {
  it("M12: costs come only from money not already paid out per order — the rest is 'Not recovered'", () => {
    const r = computeDealSettlement(
      {
        clauses: [percentClause("p", LOWLIGHT, 20, "GROSS")],
        deductions: [deduction("rental", 90_000)],
        remainderPayeeId: MARROW_HALL,
      },
      {
        ...actual(100_000),
        paidThroughPlatform: [
          { payeeId: LOWLIGHT, amountCents: 20_000 },
          { payeeId: MARROW_HALL, amountCents: 80_000 },
        ],
      },
    );
    expect(r.waterfall).toMatchObject({
      grossCents: 100_000,
      perOrderPaidFirstCents: 20_000,
      availableForCostsCents: 80_000,
      recoupedCents: 80_000,
      notRecoveredCents: 10_000,
      netPoolCents: 0,
    });
    expect(r.shortfall).toBeNull();
    expect(clause(r, "p")).toMatchObject({ paidBeforeCosts: true, uncoveredCents: 0 });
    expect(balances(r)).toEqual({ [LOWLIGHT]: 0, [MARROW_HALL]: 0 });
  });

  it("W2/M12: per-order claims are paid first, so a guarantee beside them is the direct debt, matching the balances", () => {
    const r = computeDealSettlement(
      {
        clauses: [percentClause("p", LOWLIGHT, 20, "GROSS"), fixedClause("g", PAPER_MOTH, 5_000)],
        deductions: [deduction("rental", 90_000)],
        remainderPayeeId: MARROW_HALL,
      },
      {
        ...actual(100_000),
        paidThroughPlatform: [
          { payeeId: LOWLIGHT, amountCents: 20_000 },
          { payeeId: MARROW_HALL, amountCents: 80_000 },
        ],
      },
    );
    expect(r.waterfall).toMatchObject({ availableForCostsCents: 80_000, recoupedCents: 80_000, notRecoveredCents: 10_000 });
    expect(r.shortfall).toMatchObject({
      cents: 5_000,
      owedTo: [{ payeeId: PAPER_MOTH, cents: 5_000 }],
      externalShortfallCents: 5_000,
    });
    expect(balances(r)).toEqual({ [LOWLIGHT]: 0, [PAPER_MOTH]: 5_000, [MARROW_HALL]: -5_000 });
  });

  it("W2: a creditor who already holds part of the shortfall is owed only the rest (never more than their balance)", () => {
    const r = computeDealSettlement(indieDeal(), {
      ticketRevenue: { mode: "PROJECTED", tiers: [{ tickets: 75, unitBasisCents: 2_000 }] },
      directPayments: [
        { id: "advance", label: "Cash advance", fromPayeeId: MARROW_HALL, toPayeeId: LOWLIGHT, amountCents: 60_000 },
      ],
    });
    expect(payee(r, LOWLIGHT).projectedSettleDirectlyCents).toBe(20_000);
    expect(r.shortfall).toMatchObject({
      cents: 30_500,
      owedTo: [{ payeeId: LOWLIGHT, cents: 20_000 }],
      externalShortfallCents: 20_000,
      nettedCents: 10_500,
    });
  });

  it("W3: the remainder payee short of its own clause is a shortfall with NO external amount (no banner)", () => {
    const r = computeDealSettlement(
      {
        clauses: [percentClause("act", LOWLIGHT, 70, "NET_POOL"), fixedClause("own", MARROW_HALL, 50_000)],
        deductions: [],
        remainderPayeeId: MARROW_HALL,
      },
      actual(30_000),
    );
    expect(clause(r, "act").entitlementCents).toBe(21_000);
    expect(r.shortfall).toEqual({
      cents: 41_000,
      owedByPayeeId: MARROW_HALL,
      owedTo: [],
      externalShortfallCents: 0,
      nettedCents: 0,
      ownClaimsUncoveredCents: 41_000,
    });
    expect(payee(r, MARROW_HALL)).toMatchObject({ entitlementCents: 9_000, shortfallOwedCents: 0 });
  });

  it("two guarantees the pool can't cover share it pro rata (largest remainder, ties by payee id)", () => {
    const r = computeDealSettlement(
      {
        clauses: [fixedClause("c", "c", 1), fixedClause("a", "a", 1), fixedClause("b", "b", 1)],
        deductions: [],
        remainderPayeeId: MARROW_HALL,
      },
      actual(2),
    );
    expect(r.clauses.map((c) => [c.clauseId, c.coveredByPoolCents])).toEqual([
      ["c", 0],
      ["a", 1],
      ["b", 1],
    ]);
    expect(r.shortfall?.owedTo).toEqual([{ payeeId: "c", cents: 1 }]);

    const big = computeDealSettlement(
      {
        clauses: [fixedClause("x", "x", 80_000), fixedClause("y", "y", 20_000)],
        deductions: [],
        remainderPayeeId: MARROW_HALL,
      },
      actual(50_000),
    );
    expect(big.shortfall?.owedTo).toEqual([
      { payeeId: "x", cents: 40_000 },
      { payeeId: "y", cents: 10_000 },
    ]);
  });
});

// ── Clause semantics ──────────────────────────────────────────────────────

describe("clause semantics", () => {
  const single = (c: DealClause, basisCents: number, deductions: DealDeduction[] = []) =>
    computeDealSettlement(
      { clauses: [c], deductions, remainderPayeeId: MARROW_HALL },
      projected(basisCents),
    );

  it("SUM is guarantee + percent ('dollar one')", () => {
    const r = single(
      { ...fixedClause("g", LOWLIGHT, 40_000), amountType: "FIXED_AND_PERCENT", percent: 10, resolution: "SUM" },
      100_000,
    );
    expect(clause(r, "g").entitlementCents).toBe(50_000);
    expect(clause(r, "g").how).toMatchObject({ kind: "SUM", fixedCents: 40_000, percentCents: 10_000 });
  });

  it("GREATER_OF with equal sides reports a TIE and pays the amount once", () => {
    const r = single(
      { ...fixedClause("v", LOWLIGHT, 70_000), amountType: "FIXED_AND_PERCENT", percent: 70, resolution: "GREATER_OF", basis: "GROSS" },
      100_000,
    );
    expect(clause(r, "v")).toMatchObject({ entitlementCents: 70_000, how: { picked: "TIE" } });
  });

  it("GROSS basis ignores costs off the top; NET_POOL is after them", () => {
    const deductions = [deduction("rental", 20_000)];
    const gross = single(percentClause("p", LOWLIGHT, 50, "GROSS"), 100_000, deductions);
    const pool = single(percentClause("p", LOWLIGHT, 50, "NET_POOL"), 100_000, deductions);
    expect(clause(gross, "p").entitlementCents).toBe(50_000);
    expect(clause(gross, "p").how).toMatchObject({ percentOf: { basis: "GROSS", basisCents: 100_000, afterDeductionIds: [] } });
    expect(clause(pool, "p").entitlementCents).toBe(40_000);
    expect(clause(pool, "p").how).toMatchObject({ percentOf: { basis: "NET_POOL", basisCents: 80_000, afterDeductionIds: ["rental"] } });
  });

  it("a payee with several clauses is owed their sum", () => {
    const r = computeDealSettlement(
      {
        clauses: [fixedClause("g", LOWLIGHT, 50_000), percentClause("p", LOWLIGHT, 5, "GROSS")],
        deductions: [],
        remainderPayeeId: MARROW_HALL,
      },
      projected(200_000),
    );
    expect(payee(r, LOWLIGHT)).toMatchObject({ clauseIds: ["g", "p"], clauseCents: 60_000, entitlementCents: 60_000 });
    expect(payee(r, MARROW_HALL).entitlementCents).toBe(140_000);
  });

  it("a deal with no clauses gives the remainder payee the whole pool", () => {
    const r = computeDealSettlement(
      { clauses: [], deductions: [deduction("rental", 10_000)], remainderPayeeId: MARROW_HALL },
      actual(25_000),
    );
    expect(payee(r, MARROW_HALL)).toMatchObject({ remainderShareCents: 15_000, entitlementCents: 25_000 });
  });
});

// ── Deductions ────────────────────────────────────────────────────────────

describe("deductions", () => {
  it("an estimated deduction uses its estimate, flagged, until an actual is entered", () => {
    const terms = indieDeal([deduction("rental", 50_000), deduction("sound", 30_000, { estimated: true })]);
    const est = computeDealSettlement(terms, actual(400_000));
    expect(step(est, "sound")).toMatchObject({ amountCents: 30_000, amountSource: "ESTIMATE", estimated: true });
    expect(step(est, "rental")).toMatchObject({ amountSource: "AGREED", estimated: false });
    expect(est.completeness.estimatedDeductionIds).toEqual(["sound"]);
    expect(est.completeness.complete).toBe(false);

    const act = computeDealSettlement(terms, {
      ...actual(400_000),
      deductionActuals: [{ deductionId: "sound", amountCents: 25_000 }],
    });
    expect(step(act, "sound")).toMatchObject({ amountCents: 25_000, amountSource: "ACTUAL", estimated: false, recoupedCents: 25_000 });
    expect(act.completeness).toEqual({ notEnteredOffPlatformIds: [], estimatedDeductionIds: [], complete: true });
    expect(act.waterfall.netPoolCents).toBe(400_000 - 75_000);
  });

  it("a deduction given as a percent is that percent of the gross, floored", () => {
    const r = computeDealSettlement(
      indieDeal([deduction("nut", 0, { kind: "HOUSE_NUT", amountCents: null, percent: 10 })]),
      actual(99_999),
    );
    expect(step(r, "nut")).toMatchObject({ percent: 10, amountCents: 9_999, recoupedCents: 9_999 });
  });

  it("W5: an actual replacing a percent estimate reports no percent", () => {
    const terms = indieDeal([deduction("card", 0, { amountCents: null, percent: 3, estimated: true })]);
    expect(step(computeDealSettlement(terms, actual(100_000)), "card")).toMatchObject({
      percent: 3,
      amountCents: 3_000,
      amountSource: "ESTIMATE",
    });
    const r = computeDealSettlement(terms, {
      ...actual(100_000),
      deductionActuals: [{ deductionId: "card", amountCents: 2_870 }],
    });
    expect(step(r, "card")).toMatchObject({ percent: null, amountCents: 2_870, amountSource: "ACTUAL" });
  });

  it("refuses an actual for an agreed deduction, an unknown deduction, or the same deduction twice", () => {
    expect(thrown(() =>
      computeDealSettlement(indieDeal(), { ...actual(1), deductionActuals: [{ deductionId: "rental", amountCents: 1 }] }),
    )).toMatchObject({ code: "invalid_input", message: "deal_deduction_not_estimated" });
    expect(thrown(() =>
      computeDealSettlement(indieDeal(), { ...actual(1), deductionActuals: [{ deductionId: "nope", amountCents: 1 }] }),
    )).toMatchObject({ code: "invalid_input", message: "deal_unknown_deduction_actual" });
    const est = indieDeal([deduction("sound", 1, { estimated: true })]);
    expect(thrown(() =>
      computeDealSettlement(est, {
        ...actual(1),
        deductionActuals: [
          { deductionId: "sound", amountCents: 1 },
          { deductionId: "sound", amountCents: 2 },
        ],
      }),
    )).toMatchObject({ code: "invalid_input", message: "deal_duplicate_deduction_actual" });
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("$0 gross: every deduction unrecovered, every percent $0, every fixed amount a shortfall", () => {
    const r = computeDealSettlement(indieDeal(), actual(0));
    expect(r.waterfall).toMatchObject({ grossCents: 0, recoupedCents: 0, notRecoveredCents: 95_000, netPoolCents: 0 });
    expect(clause(r, "support").entitlementCents).toBe(0);
    expect(r.shortfall?.cents).toBe(80_000);
    expect(r.conservation.distributedCents).toBe(0);
  });

  it("refuses percentages that total over 100%, and accepts exactly 100%", () => {
    const over: DealTermsInput = {
      clauses: [percentClause("a", "a", 60, "GROSS"), percentClause("b", "b", 41, "NET_POOL")],
      deductions: [],
      remainderPayeeId: MARROW_HALL,
    };
    expect(thrown(() => computeDealSettlement(over, projected(100)))).toMatchObject({
      code: "invalid_input",
      message: "deal_percent_over_100",
    });
    const exact: DealTermsInput = {
      clauses: [percentClause("a", "a", 60, "GROSS"), percentClause("b", "b", 40, "NET_POOL")],
      deductions: [],
      remainderPayeeId: MARROW_HALL,
    };
    const r = computeDealSettlement(exact, projected(1_001));
    expect(r.remainder.shareCents).toBeGreaterThanOrEqual(0);
  });

  it("P4b: the remainder's own per-order 'rest' line is left out of the 100% claim total — and still bounded per order", () => {
    // The stored shape of a versus deal: Marrow Hall (remainder) is paid the
    // rest per order (90%), Paper Moth 10% per order, Lowlight $800 vs 70% of
    // the pool. 70 + 10 = 80% of claims; the 90% is W1-capped, never a claim.
    const stored: DealTermsInput = {
      clauses: [
        {
          id: "v",
          payeeId: LOWLIGHT,
          amountType: "FIXED_AND_PERCENT",
          amountCents: 80_000,
          percent: 70,
          basis: "NET_POOL",
          resolution: "GREATER_OF",
          displayLabel: null,
        },
        percentClause("pm", PAPER_MOTH, 10, "GROSS"),
        percentClause("rest", MARROW_HALL, 90, "GROSS"),
      ],
      deductions: indieDeductions(),
      remainderPayeeId: MARROW_HALL,
    };
    const r = computeDealSettlement(stored, projected(400_000));
    // Same answer as the 08-07 worked example's shape, the rest line notwithstanding.
    expect(clause(r, "v").entitlementCents).toBe(
      Math.max(80_000, Math.floor(((400_000 - 40_000 - 95_000) * 70) / 100)),
    );
    expect(r.conservation.distributedCents).toBe(400_000);
    // Per order the lines may not pass 100% of an order, the remainder's included.
    expect(
      thrown(() =>
        computeDealSettlement(
          { ...stored, clauses: [percentClause("pm", PAPER_MOTH, 20, "GROSS"), percentClause("rest", MARROW_HALL, 90, "GROSS")] },
          projected(100),
        ),
      ),
    ).toMatchObject({ code: "invalid_input", message: "deal_per_order_percent_over_100" });
    // A NON-remainder clause set over 100% is still refused, a rest line or not.
    expect(
      thrown(() =>
        computeDealSettlement(
          {
            ...stored,
            clauses: [
              percentClause("a", LOWLIGHT, 60, "NET_POOL"),
              percentClause("b", PAPER_MOTH, 41, "GROSS"),
              percentClause("rest", MARROW_HALL, 59, "GROSS"),
            ],
          },
          projected(100),
        ),
      ),
    ).toMatchObject({ code: "invalid_input", message: "deal_percent_over_100" });
  });

  it("odd cents: 3 × 33% floors each share and the remainder payee keeps the dropped cents", () => {
    const terms: DealTermsInput = {
      clauses: ["a", "b", "c"].map((id) => percentClause(id, id, 33, "NET_POOL")),
      deductions: [],
      remainderPayeeId: MARROW_HALL,
    };
    for (const [gross, each, rest] of [
      [100, 33, 1],
      [1_001, 330, 11],
      [2, 0, 2],
      [99_999, 32_999, 1_002],
    ] as const) {
      const r = computeDealSettlement(terms, actual(gross));
      expect(r.clauses.map((c) => c.entitlementCents)).toEqual([each, each, each]);
      expect(r.remainder.shareCents).toBe(rest);
      expect(r.conservation.distributedCents).toBe(gross);
    }
  });

  it("very large amounts stay exact (BigInt percent and pro-rata math, safe-integer output)", () => {
    const gross = MAX_DEAL_AMOUNT_CENTS - 1; // 999,999,999,999
    const rental = 123_456_789_011;
    const r = computeDealSettlement(
      {
        clauses: [
          percentClause("a", "a", 33, "NET_POOL"),
          { ...fixedClause("v", "v", MAX_DEAL_AMOUNT_CENTS), amountType: "FIXED_AND_PERCENT", percent: 67, resolution: "GREATER_OF" },
        ],
        deductions: [deduction("rental", rental)],
        remainderPayeeId: MARROW_HALL,
      },
      actual(gross),
    );
    const pool = gross - rental; // 876,543,210,988
    const a = (BigInt(pool) * 33n) / 100n; // 289,259,259,626
    const vPct = (BigInt(gross) * 67n) / 100n; // 669,999,999,999
    expect(clause(r, "a").entitlementCents).toBe(Number(a));
    expect(clause(r, "v").entitlementCents).toBe(MAX_DEAL_AMOUNT_CENTS);
    expect(r.conservation.distributedCents).toBe(gross);

    // The pool can't cover the two percentage parts (a + vPct > pool), so it
    // is split pro rata. pool × claim is ~2.5e23 and ~5.9e23 here, far past
    // 2^53 (~9.0e15): a float product would lose the low digits. The sum of
    // the shares can't show that (the leftover pass forces it to the pool
    // whatever the shares are), so pin each share against a BigInt reference.
    const T = a + vPct;
    const P = BigInt(pool);
    let aShare = (P * a) / T;
    let vShare = (P * vPct) / T;
    const left = P - aShare - vShare;
    expect(left === 0n || left === 1n).toBe(true);
    if (left === 1n) {
      if ((P * a) % T >= (P * vPct) % T) aShare += 1n;
      else vShare += 1n;
    }
    expect(clause(r, "a").coveredByPoolCents).toBe(Number(aShare));
    expect(clause(r, "v").coveredByPoolCents).toBe(Number(vShare));
  });

  it("refuses an amount above the bound and a projection whose product passes it", () => {
    expect(thrown(() => computeDealSettlement(indieDeal(), actual(MAX_DEAL_AMOUNT_CENTS + 1)))).toMatchObject({ code: "invalid_input" });
    expect(thrown(() =>
      computeDealSettlement(indieDeal(), {
        ticketRevenue: { mode: "PROJECTED", tiers: [{ tickets: 10_000_000, unitBasisCents: 1_000_000 }] },
      }),
    )).toMatchObject({ code: "invalid_input", message: "deal_revenue_too_large" });
  });

  it("refuses negative and fractional inputs everywhere", () => {
    const bad: Array<() => unknown> = [
      () => computeDealSettlement(indieDeal(), actual(-1)),
      () => computeDealSettlement(indieDeal(), actual(10.5)),
      () => computeDealSettlement(indieDeal(), { ticketRevenue: { mode: "PROJECTED", tiers: [{ tickets: -1, unitBasisCents: 100 }] } }),
      () => computeDealSettlement(indieDeal(), { ...actual(1), paidThroughPlatform: [{ payeeId: LOWLIGHT, amountCents: -5 }] }),
      () => computeDealSettlement(indieDeal(), { ...actual(1), offPlatform: [{ id: "d", kind: "DOOR_CASH", label: "Door", amountCents: -1, heldByPayeeId: MARROW_HALL }] }),
      () => computeDealSettlement({ clauses: [fixedClause("g", LOWLIGHT, -100)], deductions: [], remainderPayeeId: MARROW_HALL }, actual(1)),
      () => computeDealSettlement({ clauses: [percentClause("p", LOWLIGHT, -10, "GROSS")], deductions: [], remainderPayeeId: MARROW_HALL }, actual(1)),
      () => computeDealSettlement(indieDeal([deduction("x", -1)]), actual(1)),
      () => computeDealSettlement(indieDeal(), { ...actual(1), directPayments: [{ id: "x", label: "x", fromPayeeId: LOWLIGHT, toPayeeId: MARROW_HALL, amountCents: -1 }] }),
    ];
    for (const fn of bad) expect(thrown(fn)).toMatchObject({ code: "invalid_input" });
  });

  it("refuses malformed clause shapes, mirroring the SQL CHECKs P4b will write", () => {
    const run = (c: DealClause) =>
      thrown(() => computeDealSettlement({ clauses: [c], deductions: [], remainderPayeeId: MARROW_HALL }, actual(1)));
    expect(run({ ...fixedClause("g", LOWLIGHT, 100), percent: 10 })).toMatchObject({ message: "deal_clause_fixed_shape" });
    expect(run(fixedClause("g", LOWLIGHT, 0))).toMatchObject({ message: "deal_clause_fixed_shape" });
    expect(run({ ...percentClause("p", LOWLIGHT, 10, "GROSS"), amountCents: 5 })).toMatchObject({ message: "deal_clause_percent_shape" });
    expect(run({ ...percentClause("p", LOWLIGHT, 10, "GROSS"), resolution: "SUM" })).toMatchObject({ message: "deal_clause_percent_shape" });
    expect(run({ ...fixedClause("v", LOWLIGHT, 100), amountType: "FIXED_AND_PERCENT", percent: 10 })).toMatchObject({ message: "deal_clause_fixed_and_percent_shape" });
    expect(run({ ...fixedClause("v", LOWLIGHT, 100), amountType: "FIXED_AND_PERCENT", percent: 0, resolution: "GREATER_OF" })).toMatchObject({ message: "deal_clause_fixed_and_percent_shape" });
    expect(run({ ...fixedClause("v", LOWLIGHT, 100), unknown: 1 } as unknown as DealClause)).toMatchObject({ code: "invalid_input" });
  });

  it("refuses a deduction with both or neither of amount and percent", () => {
    expect(thrown(() => computeDealSettlement(indieDeal([deduction("x", 100, { percent: 5 })]), actual(1)))).toMatchObject({ message: "deal_deduction_amount_or_percent" });
    expect(thrown(() => computeDealSettlement(indieDeal([deduction("x", 0, { amountCents: null })]), actual(1)))).toMatchObject({ message: "deal_deduction_amount_or_percent" });
  });

  it("refuses duplicate ids and a duplicate paid-through-platform payee", () => {
    expect(thrown(() =>
      computeDealSettlement({ clauses: [fixedClause("g", "a", 1), fixedClause("g", "b", 1)], deductions: [], remainderPayeeId: MARROW_HALL }, actual(1)),
    )).toMatchObject({ message: "deal_duplicate_clause_id" });
    expect(thrown(() => computeDealSettlement(indieDeal([deduction("x", 1), deduction("x", 2)]), actual(1)))).toMatchObject({ message: "deal_duplicate_deduction_id" });
    expect(thrown(() =>
      computeDealSettlement(indieDeal(), {
        ...actual(1),
        paidThroughPlatform: [
          { payeeId: LOWLIGHT, amountCents: 1 },
          { payeeId: LOWLIGHT, amountCents: 2 },
        ],
      }),
    )).toMatchObject({ message: "deal_duplicate_paid_through_platform_payee" });
  });
});

// ── Determinism and the invariant guard ───────────────────────────────────

describe("determinism and invariants", () => {
  it("the same input gives byte-identical output and never mutates its input", () => {
    const terms = indieDeal([deduction("rental", 50_000), deduction("sound", 30_000, { estimated: true })]);
    const inputs: DealSettlementInputsInput = {
      ticketRevenue: { mode: "PROJECTED", tiers: [{ tickets: 75, unitBasisCents: 2_000 }, { tickets: 10, unitBasisCents: 3_333 }] },
      offPlatform: [
        { id: "door", kind: "DOOR_CASH", label: "Door cash", amountCents: null, heldByPayeeId: MARROW_HALL },
        { id: "bar", kind: "BAR_SHARE", label: "Bar share", amountCents: 12_345, heldByPayeeId: MARROW_HALL },
      ],
    };
    const termsSnapshot = JSON.stringify(terms);
    const inputsSnapshot = JSON.stringify(inputs);
    const a = JSON.stringify(computeDealSettlement(terms, inputs));
    const b = JSON.stringify(computeDealSettlement(structuredClone(terms), structuredClone(inputs)));
    expect(a).toBe(b);
    expect(JSON.stringify(terms)).toBe(termsSnapshot);
    expect(JSON.stringify(inputs)).toBe(inputsSnapshot);
  });

  it("a result that does not balance throws DealSettlementInvariantError instead of being corrected", () => {
    const r = computeDealSettlement(indieDeal(), actual(400_000));
    expect(() => assertDealSettlementInvariants(r)).not.toThrow();

    const tampered = structuredClone(r);
    tampered.conservation.distributedCents += 1;
    const err = thrown(() => assertDealSettlementInvariants(tampered));
    expect(err).toBeInstanceOf(DealSettlementInvariantError);
    expect(err).toMatchObject({ invariant: "distribution_not_conserved" });
    // Not a KnownError: the transport must map it to a 500, not a 4xx.
    expect((err as Record<string, unknown>).code).toBeUndefined();

    const negativePool = structuredClone(r);
    negativePool.waterfall.netPoolCents = -1;
    expect(thrown(() => assertDealSettlementInvariants(negativePool))).toMatchObject({ invariant: "pool_negative" });

    const unbalanced = structuredClone(r);
    (unbalanced.payees[0] as { settleDirectlyCents: number }).settleDirectlyCents -= 25_000;
    unbalanced.conservation.settleDirectlyNetCents -= 25_000;
    expect(thrown(() => assertDealSettlementInvariants(unbalanced))).toMatchObject({ invariant: "balances_not_conserved" });

    const wrongGrossBasis = structuredClone(r);
    const support = wrongGrossBasis.clauses[1];
    if (support && support.how.kind === "PERCENT") {
      support.how.percentOf = { basis: "GROSS", basisCents: 1, afterDeductionIds: [] };
    }
    expect(thrown(() => assertDealSettlementInvariants(wrongGrossBasis))).toMatchObject({ invariant: "percent_basis_mismatch" });
  });
});

// ── P4b review W1: ledger-only payees ─────────────────────────────────────

describe("ledger-only payees (paid per order under a line the terms no longer have)", () => {
  // The support act's 10% line was removed after tickets sold; the platform
  // had already paid it $100 per order. The deal now: Lowlight $800 FIXED,
  // Marrow Hall the rest.
  const terms: DealTermsInput = {
    clauses: [fixedClause("g", LOWLIGHT, 80_000)],
    deductions: [],
    remainderPayeeId: MARROW_HALL,
  };
  const inputs = (overrides: Partial<DealSettlementInputsInput> = {}): DealSettlementInputsInput => ({
    ticketRevenue: { mode: "ACTUAL", basisCents: 100_000, orderCount: 10 },
    paidThroughPlatform: [
      { payeeId: PAPER_MOTH, amountCents: 10_000 },
      { payeeId: MARROW_HALL, amountCents: 90_000 },
      { payeeId: LOWLIGHT, amountCents: 0 },
    ],
    ledgerOnlyPayeeIds: [PAPER_MOTH],
    ...overrides,
  });

  it("is a participant with no clause, entitled to what it was paid — so it nets to $0 and the sheet still balances", () => {
    const r = computeDealSettlement(terms, inputs());
    expect(r.ledgerOnly).toEqual([{ payeeId: PAPER_MOTH, paidCents: 10_000 }]);
    expect(payee(r, PAPER_MOTH)).toMatchObject({
      ledgerOnlyCents: 10_000,
      clauseIds: [],
      entitlementCents: 10_000,
      settleDirectlyCents: 0,
      perOrderCheck: expect.objectContaining({ plausible: true }),
    });
    // Its money left per order before any cost: the pool is $900.
    expect(r.waterfall).toMatchObject({ perOrderPaidFirstCents: 10_000, netPoolCents: 90_000 });
    expect(balances(r)).toEqual({ [LOWLIGHT]: 80_000, [MARROW_HALL]: -80_000, [PAPER_MOTH]: 0 });
    expect(payee(r, MARROW_HALL).perOrderCheck?.plausible).toBe(true);
    expect(r.conservation.distributedCents).toBe(100_000);
  });

  it("without the explicit input it is a stranger, refused as before", () => {
    expect(thrown(() => computeDealSettlement(terms, inputs({ ledgerOnlyPayeeIds: [] })))).toMatchObject({
      code: "invalid_input",
      message: "deal_paid_through_platform_unknown_payee",
    });
  });

  it("refuses a ledger-only payee the terms already name, one with no figure, and any in a projection", () => {
    expect(thrown(() => computeDealSettlement(terms, inputs({ ledgerOnlyPayeeIds: [PAPER_MOTH, LOWLIGHT] })))).toMatchObject({
      message: "deal_ledger_only_is_a_participant",
    });
    expect(
      thrown(() =>
        computeDealSettlement(
          terms,
          inputs({ paidThroughPlatform: [{ payeeId: MARROW_HALL, amountCents: 90_000 }, { payeeId: LOWLIGHT, amountCents: 0 }] }),
        ),
      ),
    ).toMatchObject({ message: "deal_paid_through_platform_missing" });
    expect(
      thrown(() => computeDealSettlement(terms, { ...projected(100), ledgerOnlyPayeeIds: [PAPER_MOTH] })),
    ).toMatchObject({ message: "deal_ledger_only_in_projection" });
  });
});

describe("P4b review W5: frozen sheets of older engines", () => {
  it("the version-stable identities hold for every result, and catch an unbalanced one", () => {
    const r = computeDealSettlement(indieDeal(), actual(400_000));
    expect(() => assertFrozenSheetIdentities(r)).not.toThrow();
    const broken = structuredClone(r);
    broken.payees[0]!.entitlementCents += 1;
    expect(() => assertFrozenSheetIdentities(broken)).toThrow(DealSettlementInvariantError);
    const unbalanced = structuredClone(r);
    unbalanced.payees[0]!.settleDirectlyCents! += 1;
    expect(() => assertFrozenSheetIdentities(unbalanced)).toThrow(DealSettlementInvariantError);
  });
});
