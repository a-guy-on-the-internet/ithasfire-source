import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { FeePolicyRecord } from "@th/ports/repos/fee-policies";
import type { PayoutTermsRecord } from "@th/ports/repos/payout-terms";
import type { EventRecord, EventTicketTypeSummary } from "@th/types";

import { estimateBuyerTicketPricingForEvent } from "../estimate-buyer-ticket-pricing";
import { resolveTaxImpositions } from "../../../../lib/pricing/tax-impositions";

// FR-003: the price resolver requires an injected instant. Frozen so these
// assertions describe a fixed moment; no fixture here carries a schedule, so
// the resolved price is the list price and every existing expectation holds.
const TEST_NOW = new Date("2026-01-01T00:00:00.000Z");
const testClock = { now: () => TEST_NOW };

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const TICKET_TYPE_ID = "33333333-3333-4333-8333-333333333333";
const AGREEMENT_ID = "44444444-4444-4444-8444-444444444444";
const FEE_POLICY_ID = "55555555-5555-4555-8555-555555555555";

const now = new Date("2025-01-01T00:00:00.000Z");

/** A $35 ticket. */
const makeTicketType = (
  overrides?: Partial<EventTicketTypeSummary>,
): EventTicketTypeSummary =>
  ({
    id: TICKET_TYPE_ID,
    name: "General Admission",
    description: null,
    priceCents: 3500,
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
  }) as EventTicketTypeSummary;

/** The imposition list an unlocated event with this stamped rate resolves to. */
const faceSales = (salesTaxRateBps: number) =>
  resolveTaxImpositions({ situs: null, salesTaxRateBps });

const makeEvent = (
  overrides?: Partial<Pick<EventRecord, "admissionTaxRateBps">>,
): Pick<EventRecord, "id" | "orgId" | "admissionTaxRateBps"> => ({
  id: EVENT_ID,
  orgId: ORG_ID,
  admissionTaxRateBps: 0,
  ...overrides,
});

function makeDeps(options?: {
  feeMode?: "ABSORB" | "PASS_THROUGH";
  /** Whether any active primary payout terms exist. */
  hasTerms?: boolean;
}) {
  const feeMode = options?.feeMode ?? "PASS_THROUGH";
  const hasTerms = options?.hasTerms ?? true;

  const agreement: PayoutTermsRecord = {
    id: AGREEMENT_ID,
    kind: "PRIMARY_SPLIT",
    status: "ACTIVE",
    feeMode,
    feePolicyId: FEE_POLICY_ID,
    payoutSchedule: "WEEK_OF_EVENT",
    isDefault: false,
    settlementCurrency: "usd",
    version: 1,
    createdAt: now,
    updatedAt: now,
  } as PayoutTermsRecord;

  // buyerFeePct 0 + platformFixedCents 50 → flat $0.50 platform fee per ticket.
  const feePolicy: FeePolicyRecord = {
    id: FEE_POLICY_ID,
    scopeType: "EVENT",
    scopeId: EVENT_ID,
    status: "ACTIVE",
    version: 1,
    effectiveFrom: now,
    effectiveTo: null,
    buyerFeePct: 0,
    maxFeeCents: null,
    minFeeCents: 0,
    platformFixedCents: 50,
    feeMode,
    processsorFeePct: 0.029,
    processorFixedCents: 30,
    payoutPct: 0.9,
    payoutFixedCents: 0,
    monthlyPayoutCents: 0,
  } as FeePolicyRecord;

  const repos = {
    payoutTerms: {
      listByEvent: vi.fn(async () => (hasTerms ? [agreement] : [])),
      listLines: vi.fn(async () => [
        {
          id: "line-1",
          agreementId: AGREEMENT_ID,
          payeeId: "payee-1",
          percent: 100,
          floorCents: 0,
          capPercent: null,
          priority: 0,
          rounding: "FLOOR",
        },
      ]),
    },
    feePolicies: {
      getById: vi.fn(async (id: string) =>
        id === FEE_POLICY_ID ? feePolicy : null,
      ),
      resolveEffective: vi.fn(async () => (hasTerms ? null : feePolicy)),
    },
    events: {},
  } as unknown as Repos;

  return { repos };
}

describe("estimateBuyerTicketPricingForEvent", () => {
  // `taxImpositions` is a REQUIRED option (a silent TICKET_FACE default is what
  // let four money-adjacent surfaces drift). These cases are about fee/tax
  // arithmetic, not jurisdiction, so they pass the face-base SALES line the
  // event's stamped rate resolves to; the BUYER_TOTAL behaviour lives in
  // `events/__tests__/taxable-base-estimates.test.ts`.
  it("PASS_THROUGH: per-ticket processor fee uses the exact gross-up (qty=1)", async () => {
    const { repos } = makeDeps({ feeMode: "PASS_THROUGH" });

    const result = await estimateBuyerTicketPricingForEvent(
      { repos, clock: testClock },
      makeEvent(),
      [makeTicketType()],
      { taxImpositions: faceSales(0) },
    );

    expect(result.feeMode).toBe("PASS_THROUGH");
    const est = result.perTicketEstimates[0]!;
    expect(est.unitPriceCents).toBe(3500);
    expect(est.platformFeeCents).toBe(50);
    expect(est.taxEstimateCents).toBe(0);
    // Gross-up base = 3500 + 50 + 0 = 3550; Stripe 2.9% + $0.30 → fee 137 so
    // that charge 3687 nets exactly 3550 after Stripe's ceil'd deduction.
    expect(est.processorFeeCents).toBe(137);
    expect(est.buyerUnitTotalCents).toBe(3687);
  });

  it("PASS_THROUGH: gross-up base includes tax", async () => {
    const { repos } = makeDeps({ feeMode: "PASS_THROUGH" });

    // 1000 bps = 10% admission tax on the $35 face → tax 350.
    const result = await estimateBuyerTicketPricingForEvent(
      { repos, clock: testClock },
      makeEvent({ admissionTaxRateBps: 1000 }),
      [makeTicketType()],
      { taxImpositions: faceSales(1000) },
    );

    const est = result.perTicketEstimates[0]!;
    expect(est.platformFeeCents).toBe(50);
    expect(est.taxEstimateCents).toBe(350);
    // base = 3500 + 50 + 350 = 3900 → gross-up fee over the post-tax base.
    const expectedFee = 148; // solve over 3900 @ 2.9% + 30
    expect(est.processorFeeCents).toBe(expectedFee);
    expect(est.buyerUnitTotalCents).toBe(3500 + 50 + expectedFee + 350);
  });

  it("terms and policy still saying ABSORB: the buyer total carries the fees on top", async () => {
    // ABSORB is removed (docs/decisions/absorb-removed.md). This estimator
    // feeds the event page, card badges and the SEARCH INDEX, so a legacy row
    // must quote what checkout charges: 3687, not the old face-only 3500.
    const { repos } = makeDeps({ feeMode: "ABSORB" });

    const result = await estimateBuyerTicketPricingForEvent(
      { repos, clock: testClock },
      makeEvent(),
      [makeTicketType()],
      { taxImpositions: faceSales(0) },
    );

    expect(result.feeMode).toBe("PASS_THROUGH");
    expect(result.platformFeeRates).not.toBeNull();
    const est = result.perTicketEstimates[0]!;
    expect(est.platformFeeCents).toBe(50);
    expect(est.processorFeeCents).toBe(137);
    expect(est.buyerUnitTotalCents).toBe(3687);
    expect(result.minBuyerUnitTotalCents).toBe(3687);
  });

  it("free tickets (priceCents 0) carry no fees in any mode", async () => {
    const { repos } = makeDeps({ feeMode: "PASS_THROUGH" });

    const result = await estimateBuyerTicketPricingForEvent(
      { repos, clock: testClock },
      makeEvent(),
      [makeTicketType({ priceCents: 0 })],
      { taxImpositions: faceSales(0) },
    );

    const est = result.perTicketEstimates[0]!;
    expect(est.unitPriceCents).toBe(0);
    expect(est.platformFeeCents).toBe(0);
    expect(est.processorFeeCents).toBe(0);
    expect(est.buyerUnitTotalCents).toBe(0);
  });
});
