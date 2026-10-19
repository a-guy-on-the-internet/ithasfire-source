/**
 * P4b against what the platform already pays.
 *
 *  1. THE LEGACY MAPPING RULE — every branch, in precedence order.
 *  2. Legacy terms (PERCENT/GROSS lines summing to 100%, no remainder stored)
 *     settle at $0.00 on actual numbers: the ledger figures come from the
 *     REAL per-order engine run order by order, refunds included (M9 + W1).
 *  3. FR-005 — writing clauses never changes what the per-order engine pays:
 *     the P4b column defaults leave every legacy line set's splits identical,
 *     and a FIXED / NET_POOL / FIXED_AND_PERCENT line can never be paid per
 *     order (the engines refuse it; the stored per-order lines a deal write
 *     produces are exactly the PERCENT/GROSS clauses plus the remainder's rest).
 */
import { describe, expect, it } from "vitest";

import { computeOrderSplits } from "../../../lib/pricing/compute-order-splits";
import { computeTicketPriceForAgreement } from "../../../lib/pricing/compute-ticket-price-for-agreement";
import { computeDealSettlement } from "../../../lib/settlement";
import { resolveDealRemainder, toDealTerms } from "../_shared/deal-from-storage";
import { getEventSettlement } from "../get-event-settlement";
import { setAgreementDeal } from "../set-agreement-deal";
import {
  ACT_HUMAN,
  AGREEMENT_ID,
  SUPPORT_HUMAN,
  TERMS_ID,
  VENUE_ADMIN,
  VENUE_ORG,
  addFinalizedEvent,
  addPayee,
  clauseRecord,
  clock,
  emptyStore,
  makeRepos,
  standardStore,
} from "./deal-fakes";

/** mulberry32 — deterministic, so every case is reproducible from its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return (min: number, max: number) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return min + Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * (max - min + 1));
  };
}

describe("the legacy mapping rule (remainderPayeeId IS NULL)", () => {
  const deal = (clauses: ReturnType<typeof clauseRecord>[], remainderPayeeId: string | null = null) => ({
    payoutTermsId: TERMS_ID,
    remainderPayeeId,
    clauses,
    deductions: [],
  });

  it("a stored remainder wins over every rule", async () => {
    const s = standardStore();
    const r = await resolveDealRemainder(makeRepos(s), {
      deal: deal([], s.supportPayee),
      event: { orgId: VENUE_ORG, humanId: null },
    });
    expect(r).toEqual({ payeeId: s.supportPayee, source: "STORED" });
  });

  it("1. the event's organiser — its org, else its human owner", async () => {
    const s = standardStore();
    const repos = makeRepos(s);
    const lines = [clauseRecord({ payeeId: s.actPayee, percent: 90 })];
    expect(await resolveDealRemainder(repos, { deal: deal(lines), event: { orgId: VENUE_ORG, humanId: null } })).toEqual({
      payeeId: s.venuePayee,
      source: "LEGACY_EVENT_ORGANISER",
    });
    expect(await resolveDealRemainder(repos, { deal: deal(lines), event: { orgId: null, humanId: ACT_HUMAN } })).toEqual({
      payeeId: s.actPayee,
      source: "LEGACY_EVENT_ORGANISER",
    });
  });

  it("2. no event yet: the agreement's editor side (the venue), never the act", async () => {
    const s = standardStore();
    const repos = makeRepos(s);
    const r = await resolveDealRemainder(repos, {
      deal: deal([clauseRecord({ payeeId: s.actPayee, percent: 90 })]),
      event: null,
      agreement: s.agreements.get(AGREEMENT_ID)!,
      bookingRequest: s.requests.get(AGREEMENT_ID)!,
    });
    expect(r).toEqual({ payeeId: s.venuePayee, source: "LEGACY_AGREEMENT_EDITOR" });
  });

  it("an organiser with no payee row falls through to the next rule (a read never mints one)", async () => {
    const s = standardStore();
    s.payees.delete(s.venuePayee);
    const repos = makeRepos(s);
    const r = await resolveDealRemainder(repos, {
      deal: deal([
        clauseRecord({ payeeId: s.actPayee, percent: 70 }),
        clauseRecord({ payeeId: s.supportPayee, percent: 30 }),
      ]),
      event: { orgId: VENUE_ORG, humanId: null },
      agreement: s.agreements.get(AGREEMENT_ID)!,
      bookingRequest: s.requests.get(AGREEMENT_ID)!,
    });
    expect(r).toEqual({ payeeId: s.actPayee, source: "LEGACY_LARGEST_LINE" });
    expect(s.payees.size).toBe(3);
  });

  it("3. otherwise the largest per-order line — ties by priority, then payee id; a FIXED clause never counts", async () => {
    const store = emptyStore();
    const p1 = addPayee(store, "HUMAN", "h1", "10000000-0000-4000-8000-000000000001");
    const p2 = addPayee(store, "HUMAN", "h2", "20000000-0000-4000-8000-000000000002");
    const p3 = addPayee(store, "HUMAN", "h3", "30000000-0000-4000-8000-000000000003");
    const repos = makeRepos(store);
    const tie = deal([clauseRecord({ payeeId: p2, percent: 50 }), clauseRecord({ payeeId: p1, percent: 50 })]);
    expect((await resolveDealRemainder(repos, { deal: tie }))?.payeeId).toBe(p1);
    const byPriority = deal([
      clauseRecord({ payeeId: p1, percent: 50 }),
      clauseRecord({ payeeId: p2, percent: 50, priority: 5 }),
    ]);
    expect((await resolveDealRemainder(repos, { deal: byPriority }))?.payeeId).toBe(p2);
    const fixedIgnored = deal([
      clauseRecord({ payeeId: p3, amountType: "FIXED", percent: null, amountCents: 999_999 }),
      clauseRecord({ payeeId: p1, percent: 10 }),
    ]);
    expect(await resolveDealRemainder(repos, { deal: fixedIgnored })).toEqual({ payeeId: p1, source: "LEGACY_LARGEST_LINE" });
    expect(await resolveDealRemainder(repos, { deal: deal([]) })).toBeNull();
  });
});

describe("legacy 100% PERCENT/GROSS terms settle at $0.00 on actual numbers (M9 + W1)", () => {
  it("on the real per-order engine's payments, refunds included, across 300 random histories", async () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const int = rng(seed);
      const s = standardStore();
      // A legacy line set: 1–3 lines over act / venue / support, Σ = 100,
      // sometimes with a cap and a priority (what the old editors wrote).
      const payees = [s.actPayee, s.venuePayee, s.supportPayee].slice(0, int(1, 3));
      let left = 100;
      const lines = payees.map((payeeId, i) => {
        const percent = i === payees.length - 1 ? left : int(0, left);
        left -= percent;
        return clauseRecord({ payeeId, percent, priority: int(0, 2) });
      });
      s.terms.get(TERMS_ID)!.deal = { payoutTermsId: TERMS_ID, remainderPayeeId: null, clauses: lines, deductions: [] };
      addFinalizedEvent(s);

      // Orders through the real per-order engine; refunds debit a share.
      const orders = Array.from({ length: int(1, 12) }, (_, i) => ({
        orderId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        gross: int(0, 20_000),
        fee: int(0, 300),
      }));
      const perPayee = new Map<string, { creditCents: number; refundDebitCents: number }>();
      let refundCount = 0;
      for (const o of orders) {
        // Unmarked (pre-ruling) orders.
        const basis = Math.max(o.gross - o.fee, 0);
        const { splits } = computeOrderSplits({
          amountCents: basis,
          lines: lines.map((l) => ({ id: l.id, payeeId: l.payeeId, percent: l.percent!, capPercent: l.capPercent, priority: l.priority, rounding: l.rounding })),
        });
        const refunded = int(0, 3) === 0;
        if (refunded) refundCount += 1;
        for (const split of splits) {
          const agg = perPayee.get(split.payeeId) ?? { creditCents: 0, refundDebitCents: 0 };
          agg.creditCents += split.amountCents;
          // A partial refund debits each payee a part of its credit.
          if (refunded) agg.refundDebitCents += Math.floor(split.amountCents / int(1, 3));
          perPayee.set(split.payeeId, agg);
        }
      }
      s.ledger.set(s.events.values().next().value!.id, {
        orders: orders.map((o) => ({ orderId: o.orderId, status: "SUCCEEDED", amountGrossCents: o.gross, feesPlatformCents: o.fee, credited: true })),
        refundCount,
        perPayee: [...perPayee].map(([payeeId, v]) => ({ payeeId, ...v })),
        currencies: ["usd"],
      });

      const out = await getEventSettlement({ repos: makeRepos(s), clock }, { actorHumanId: VENUE_ADMIN, eventId: s.events.values().next().value!.id });
      const ctx = `seed ${seed}`;
      expect(out.sheet.visibility, ctx).toBe("FULL");
      if (out.sheet.visibility !== "FULL") continue;
      const r = out.sheet.result;
      expect(r.shortfall, ctx).toBeNull();
      for (const p of r.payees) {
        expect(p.settleDirectlyCents, `${ctx} ${p.payeeId}`).toBe(0);
      }
      // The remainder holder (W5) always has its own position.
      expect(r.payees.some((p) => p.payeeId === r.remainder.payeeId), ctx).toBe(true);
    }
  });
});

describe("FR-005: writing clauses never changes what the per-order engine pays", () => {
  it("the P4b defaults (PERCENT, GROSS) leave every legacy line set's splits identical", () => {
    for (let seed = 1; seed <= 500; seed += 1) {
      const int = rng(seed);
      let left = 100;
      const lines = Array.from({ length: int(1, 5) }, (_, i) => {
        const percent = int(0, left);
        left -= percent;
        return {
          id: `l${i}`,
          payeeId: `p${int(0, 9)}${i}`,
          percent,
          capPercent: int(0, 4) === 0 ? int(1, 100) : null,
          priority: int(0, 3),
          rounding: int(0, 1) === 0 ? ("FLOOR" as const) : ("NEAREST" as const),
        };
      });
      const amountCents = int(0, 1_000_000);
      const before = computeOrderSplits({ amountCents, lines });
      const after = computeOrderSplits({
        amountCents,
        lines: lines.map((l) => ({ ...l, amountType: "PERCENT" as const, basis: "GROSS" as const })),
      });
      expect(after, `seed ${seed}`).toEqual(before);
    }
  });

  it.each([
    ["FIXED", { amountType: "FIXED", basis: "GROSS" }],
    ["NET_POOL", { amountType: "PERCENT", basis: "NET_POOL" }],
    ["GREATER_OF", { amountType: "FIXED_AND_PERCENT", basis: "NET_POOL" }],
  ])("a %s line is never paid per order — both split engines refuse it", (_name, shape) => {
    const lines = [
      { id: "venue", payeeId: "venue", percent: 30 },
      { id: "act", payeeId: "act", percent: 70, ...shape },
    ];
    expect(() => computeOrderSplits({ amountCents: 10_000, lines } as never)).toThrow();
    expect(() =>
      computeTicketPriceForAgreement({
        qty: 1,
        unitPriceCents: 10_000,
        agreement: {
          id: "t",
          feeMode: null,
          lines,
          policy: {
            id: "fp",
            version: 1,
            feeMode: "PASS_THROUGH",
            processsorFeePct: 0,
            processorFixedCents: 0,
            payoutPct: 0,
            payoutFixedCents: 0,
            monthlyPayoutCents: 0,
            buyerFeePct: 0,
            maxFeeCents: null,
            minFeeCents: 0,
            platformFixedCents: 0,
          },
        },
      } as never),
    ).toThrow();
  });

  it("a versus deal stores per-order lines the engine pays exactly as before: support 10%, the venue the rest", async () => {
    const s = standardStore();
    const repos = makeRepos(s);
    await setAgreementDeal(
      { repos, clock },
      {
        actorHumanId: VENUE_ADMIN,
        agreementId: AGREEMENT_ID,
        deal: {
          source: "PRESET",
          preset: { preset: "VERSUS", act: { kind: "human", id: ACT_HUMAN }, guaranteeCents: 80_000, percent: 70 },
          remainder: { kind: "org", id: VENUE_ORG },
          extraClauses: [
            { payee: { kind: "human", id: SUPPORT_HUMAN }, amountType: "PERCENT", percent: 10, basis: "GROSS" },
          ],
          deductions: [],
        },
      },
    );
    // What the per-order engine is handed (the port's fenced listLines) …
    const perOrderLines = await repos.payoutTerms.listLines(TERMS_ID);
    expect(perOrderLines.map((l) => [l.payeeId, l.percent]).sort()).toEqual(
      [
        [s.supportPayee, 10],
        [s.venuePayee, 90],
      ].sort(),
    );
    // … never includes the act's versus clause, which is stored all the same.
    const stored = s.terms.get(TERMS_ID)!.deal;
    expect(stored.clauses.some((c) => c.payeeId === s.actPayee && c.amountType === "FIXED_AND_PERCENT")).toBe(true);
    expect(perOrderLines.some((l) => l.payeeId === s.actPayee)).toBe(false);
    // And per order the engine divides the whole basis, nothing to the act.
    const { splits, totalCents, unallocatedCents } = computeOrderSplits({ amountCents: 2_499, lines: perOrderLines });
    expect(totalCents).toBe(2_499);
    expect(unallocatedCents).toBe(0);
    // floor(10%) = 249, floor(90%) = 2,249; the engine hands the dropped
    // cent to its first line (priority, then payee id) — the support act.
    expect(splits.find((x) => x.payeeId === s.supportPayee)?.amountCents).toBe(250);
    expect(splits.find((x) => x.payeeId === s.venuePayee)?.amountCents).toBe(2_249);
    // The calculator, on the same stored deal, agrees what the platform pays.
    const projected = computeDealSettlement(toDealTerms(stored, s.venuePayee), {
      ticketRevenue: { mode: "PROJECTED", tiers: [{ tickets: 1, unitBasisCents: 2_499 }] },
    });
    expect(projected.payees.find((p) => p.payeeId === s.actPayee)?.projectedPaidPerOrderCents).toBe(0);
  });
});
