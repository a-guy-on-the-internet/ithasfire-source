/**
 * Property tests: thousands of random deals and inputs from a small seeded
 * generator (fast-check is not a dependency of this repo; a 10-line PRNG is
 * enough and keeps every failing case reproducible from its seed).
 *
 * Each case is checked against an independent reference model written here
 * from the spec's rules (M7–M12, FR-002) — it imports nothing from the
 * implementation — down to per-payee entitlements, per-payee balances (actual
 * or projected), projected per-order pay and the shortfall's owed-to list. A
 * bug that keeps the totals right but moves money between payees (crediting
 * a deduction to the wrong party, say) is caught. Refusals (W4 projected
 * payments, W5 missing remainder figure and strangers) are generated too.
 */
import { describe, expect, it } from "vitest";

import { computeDealSettlement } from "./compute-deal-settlement";
import { MAX_DEAL_AMOUNT_CENTS } from "./deal-terms";
import type {
  DealClause,
  DealDeduction,
  DealSettlementInputs,
  DealTerms,
} from "./deal-terms";

/** mulberry32 — deterministic 32-bit PRNG. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const pick = <T,>(xs: readonly T[]): T => xs[int(0, xs.length - 1)] as T;
  const chance = (p: number) => next() < p;
  return { int, pick, chance };
}

/** Amounts skewed toward small values (odd cents) with occasional huge ones. */
function cents(r: ReturnType<typeof rng>): number {
  const scale = r.pick([0, 1, 100, 10_000, 1_000_000, 100_000_000, 1_000_000_000_000]);
  return r.int(0, scale);
}

const pct = (basis: number, p: number) =>
  basis <= 0 ? 0 : Number((BigInt(basis) * BigInt(p)) / 100n);
const isPerOrder = (c: DealClause) => c.amountType === "PERCENT" && c.basis === "GROSS";

function randomCase(seed: number): { terms: DealTerms; inputs: DealSettlementInputs } {
  const r = rng(seed);
  const payees = ["p0", "p1", "p2", "p3", "p4"].slice(0, r.int(1, 5));
  const remainderPayeeId = r.pick(payees);

  let percentLeft = 100;
  const takePercent = (min: number) => {
    if (percentLeft < min) return null;
    const p = r.int(min, Math.min(percentLeft, r.pick([5, 33, 50, 100])));
    percentLeft -= p;
    return p;
  };
  const clauses: DealClause[] = [];
  for (let i = 0; i < r.int(0, 6); i += 1) {
    const payeeId = r.pick(payees);
    const basis = r.pick(["GROSS", "GROSS", "NET_POOL"] as const);
    const type = r.pick(["FIXED", "PERCENT", "PERCENT", "FIXED_AND_PERCENT"] as const);
    const base = { id: `c${i}`, payeeId, basis, displayLabel: null };
    if (type === "FIXED") {
      clauses.push({ ...base, amountType: "FIXED", amountCents: Math.max(1, cents(r)), percent: null, resolution: null });
    } else if (type === "PERCENT") {
      const percent = takePercent(0);
      if (percent === null) continue;
      clauses.push({ ...base, amountType: "PERCENT", amountCents: null, percent, resolution: null });
    } else {
      const percent = takePercent(1);
      if (percent === null) continue;
      clauses.push({
        ...base,
        amountType: "FIXED_AND_PERCENT",
        amountCents: Math.max(1, cents(r)),
        percent,
        resolution: r.pick(["SUM", "GREATER_OF"] as const),
      });
    }
  }

  const deductions: DealDeduction[] = [];
  for (let i = 0; i < r.int(0, 5); i += 1) {
    const asPercent = r.chance(0.25);
    deductions.push({
      id: `d${i}`,
      kind: r.pick(["RENTAL", "EXPENSE", "HOUSE_NUT"] as const),
      label: `d${i}`,
      amountCents: asPercent ? null : cents(r),
      percent: asPercent ? r.int(0, 100) : null,
      creditedPayeeId: r.pick(payees),
      estimated: r.chance(0.5),
    });
  }

  const ticketRevenue: DealSettlementInputs["ticketRevenue"] = r.chance(0.5)
    ? {
        mode: "ACTUAL",
        basisCents: cents(r),
        ...(r.chance(0.5) ? { orderCount: r.int(0, 500) } : {}),
      }
    : {
        mode: "PROJECTED",
        tiers: Array.from({ length: r.int(1, 3) }, () => ({
          tickets: r.int(0, 2_000),
          unitBasisCents: r.int(0, 50_000),
        })),
      };

  // Participants come from the TERMS only (P4b): a holder, an owner, a
  // direct-payment side and a platform payee are all drawn from them.
  const participants = payees.filter(
    (p) =>
      p === remainderPayeeId ||
      clauses.some((c) => c.payeeId === p) ||
      deductions.some((d) => d.creditedPayeeId === p),
  );
  const offPlatform: DealSettlementInputs["offPlatform"] = Array.from({ length: r.int(0, 3) }, (_, i) => ({
    id: `o${i}`,
    kind: r.pick(["DOOR_CASH", "BAR_SHARE", "OTHER"] as const),
    label: `o${i}`,
    amountCents: r.chance(0.3) ? null : cents(r),
    heldByPayeeId: r.pick(participants),
    // M11: sometimes a named owner, sometimes explicitly null, else absent.
    ...(r.chance(0.4) ? { ownerPayeeId: r.pick(participants) } : r.chance(0.5) ? { ownerPayeeId: null } : {}),
  }));

  // ACTUAL (M9, W5): an entry for the remainder payee and every per-order
  // payee; per-order payees near their exact share, the remainder often "the
  // rest" (the stage-1 rule); Σ never above the gross.
  let paidThroughPlatform: DealSettlementInputs["paidThroughPlatform"] = [];
  if (ticketRevenue.mode === "ACTUAL") {
    const gross = ticketRevenue.basisCents;
    const others = participants.filter((p) => p !== remainderPayeeId);
    let left = gross;
    for (const p of others) {
      const perOrder = clauses.filter((c) => c.payeeId === p && isPerOrder(c));
      if (perOrder.length === 0 && !r.chance(0.3)) continue;
      const exact = perOrder.reduce((s, c) => s + pct(gross, c.percent as number), 0);
      const want = r.chance(0.7) ? Math.max(0, exact + r.int(-3, 3)) : cents(r);
      const amountCents = Math.min(want, left);
      left -= amountCents;
      paidThroughPlatform.push({ payeeId: p, amountCents });
    }
    paidThroughPlatform.push({
      payeeId: remainderPayeeId,
      amountCents: r.chance(0.6) ? left : r.int(0, left),
    });
    paidThroughPlatform = paidThroughPlatform.reverse();
  }

  const inputs: DealSettlementInputs = {
    ticketRevenue,
    offPlatform,
    // Ledger-only payees (P4b W1) are covered by the unit tests.
    ledgerOnlyPayeeIds: [],
    deductionActuals: deductions
      .filter((d) => d.estimated && r.chance(0.5))
      .map((d) => ({ deductionId: d.id, amountCents: cents(r) })),
    paidThroughPlatform,
    directPayments:
      participants.length < 2
        ? []
        : Array.from({ length: r.int(0, 2) }, (_, i) => {
            const toPayeeId = r.pick(participants);
            return {
              id: `x${i}`,
              label: `x${i}`,
              fromPayeeId: r.pick(participants.filter((p) => p !== toPayeeId)),
              toPayeeId,
              amountCents: Math.max(1, cents(r)),
            };
          }),
  };
  return { terms: { clauses, deductions, remainderPayeeId }, inputs };
}

// ── Reference model, straight from the spec's rules ───────────────────────

/** Hamilton: amount split pro rata to weights; ties by (payee, clause) id. */
function hamilton(amount: number, keys: Array<{ payee: string; id: string; w: number }>): Map<string, number> {
  const total = keys.reduce((s, k) => s + BigInt(k.w), 0n);
  const out = new Map<string, number>();
  if (total === 0n) {
    keys.forEach((k, i) => out.set(k.id, i === 0 ? amount : 0));
    return out;
  }
  const rows = keys.map((k) => {
    const n = BigInt(amount) * BigInt(k.w);
    return { k, floor: n / total, rem: n % total };
  });
  let given = rows.reduce((s, x) => s + x.floor, 0n);
  rows
    .slice()
    .sort((x, y) =>
      x.rem !== y.rem
        ? x.rem > y.rem ? -1 : 1
        : x.k.payee !== y.k.payee
          ? x.k.payee < y.k.payee ? -1 : 1
          : x.k.id < y.k.id ? -1 : x.k.id > y.k.id ? 1 : 0,
    )
    .forEach((x) => {
      if (given < BigInt(amount)) {
        x.floor += 1n;
        given += 1n;
      }
    });
  for (const x of rows) out.set(x.k.id, Number(x.floor));
  return out;
}

function reference({ terms, inputs }: { terms: DealTerms; inputs: DealSettlementInputs }) {
  const rem = terms.remainderPayeeId;
  const t = inputs.ticketRevenue;
  const actualMode = t.mode === "ACTUAL";
  const gross =
    t.mode === "ACTUAL" ? t.basisCents : t.tiers.reduce((s, x) => s + x.tickets * x.unitBasisCents, 0);
  const paidOf = (p: string) => inputs.paidThroughPlatform.find((x) => x.payeeId === p)?.amountCents ?? 0;

  // M12: other payees' per-order clauses are paid before any cost.
  const firstClauses = terms.clauses.filter((c) => isPerOrder(c) && c.payeeId !== rem);
  const first = new Map<string, number>();
  if (actualMode) {
    const byPayee = new Map<string, DealClause[]>();
    for (const c of firstClauses) byPayee.set(c.payeeId, [...(byPayee.get(c.payeeId) ?? []), c]);
    for (const [p, cs] of byPayee) {
      for (const [id, v] of hamilton(paidOf(p), cs.map((c) => ({ payee: p, id: c.id, w: pct(gross, c.percent as number) })))) {
        first.set(id, v);
      }
    }
  } else {
    for (const c of firstClauses) first.set(c.id, pct(gross, c.percent as number));
  }
  const paidFirst = [...first.values()].reduce((s, v) => s + v, 0);

  // Waterfall over what is left (M8: ticket money only).
  let left = gross - paidFirst;
  const recoup = new Map<string, number>();
  for (const d of terms.deductions) {
    const a = inputs.deductionActuals.find((x) => x.deductionId === d.id);
    const want = a ? a.amountCents : d.percent != null ? pct(gross, d.percent) : (d.amountCents as number);
    const got = Math.min(want, left);
    recoup.set(d.id, got);
    left -= got;
  }
  const pool = left;

  const exact = (c: DealClause) => pct(c.basis === "GROSS" ? gross : pool, c.percent as number);
  const ent = new Map<string, number>();
  const pctPart = new Map<string, number>();
  for (const c of terms.clauses) {
    if (first.has(c.id)) {
      ent.set(c.id, first.get(c.id) as number);
      pctPart.set(c.id, first.get(c.id) as number);
    } else if (c.amountType === "FIXED") {
      ent.set(c.id, c.amountCents as number);
      pctPart.set(c.id, 0);
    } else if (c.amountType === "PERCENT") {
      ent.set(c.id, exact(c));
      pctPart.set(c.id, exact(c));
    } else {
      const fixed = c.amountCents as number;
      ent.set(c.id, c.resolution === "SUM" ? fixed + exact(c) : Math.max(fixed, exact(c)));
      pctPart.set(c.id, exact(c));
    }
  }
  // W1: the remainder's own per-order clauses fit inside what is left.
  const cappedFrom = new Map<string, number>();
  const ownPO = terms.clauses.filter((c) => c.payeeId === rem && isPerOrder(c));
  if (ownPO.length > 0) {
    const others = terms.clauses
      .filter((c) => !first.has(c.id) && !ownPO.includes(c))
      .reduce((s, c) => s + (ent.get(c.id) as number), 0);
    const room = Math.max(0, pool - others);
    const want = ownPO.reduce((s, c) => s + (ent.get(c.id) as number), 0);
    if (want > room) {
      for (const [id, v] of hamilton(room, ownPO.map((c) => ({ payee: rem, id: c.id, w: ent.get(c.id) as number })))) {
        if (v !== ent.get(id)) cappedFrom.set(id, ent.get(id) as number);
        ent.set(id, v);
        pctPart.set(id, v);
      }
    }
  }
  const remainder =
    pool - terms.clauses.filter((c) => !first.has(c.id)).reduce((s, c) => s + (ent.get(c.id) as number), 0);

  // Cover: paid-first in full; then others' % parts, fixed parts, own other, own per-order.
  const covered = new Map<string, number>();
  for (const [id, v] of first) covered.set(id, v);
  let avail = pool;
  const direct = terms.clauses.filter((c) => !first.has(c.id) && c.payeeId !== rem);
  const own = terms.clauses.filter((c) => c.payeeId === rem);
  const tiers = [
    direct.map((c) => ({ c, w: pctPart.get(c.id) as number })),
    direct.map((c) => ({ c, w: (ent.get(c.id) as number) - (pctPart.get(c.id) as number) })),
    own.filter((c) => !isPerOrder(c)).map((c) => ({ c, w: ent.get(c.id) as number })),
    own.filter(isPerOrder).map((c) => ({ c, w: ent.get(c.id) as number })),
  ];
  for (const tier of tiers) {
    const live = tier.filter((x) => x.w > 0);
    const need = live.reduce((s, x) => s + x.w, 0);
    const give =
      need <= avail
        ? new Map(live.map((x) => [x.c.id, x.w]))
        : hamilton(avail, live.map((x) => ({ payee: x.c.payeeId, id: x.c.id, w: x.w })));
    for (const x of live) covered.set(x.c.id, (covered.get(x.c.id) ?? 0) + (give.get(x.c.id) ?? 0));
    avail = Math.max(0, avail - need);
  }

  // Per-payee positions.
  const ids = new Set<string>([
    ...terms.clauses.map((c) => c.payeeId),
    rem,
    ...terms.deductions.map((d) => d.creditedPayeeId),
    ...inputs.offPlatform.map((o) => o.heldByPayeeId),
    ...inputs.paidThroughPlatform.map((p) => p.payeeId),
    ...inputs.directPayments.flatMap((d) => [d.toPayeeId, d.fromPayeeId]),
  ]);
  const entitlement: Record<string, number> = {};
  const balance: Record<string, number> = {};
  const projectedPaid: Record<string, number | null> = {};
  for (const id of ids) {
    let e = 0;
    for (const c of terms.clauses) if (c.payeeId === id) e += ent.get(c.id) as number;
    if (id === rem) e += remainder;
    for (const d of terms.deductions) if (d.creditedPayeeId === id) e += recoup.get(d.id) as number;
    entitlement[id] = e;
    let b = e;
    for (const o of inputs.offPlatform) {
      if ((o.ownerPayeeId ?? rem) === id) b += o.amountCents ?? 0;
      if (o.heldByPayeeId === id) b -= o.amountCents ?? 0;
    }
    for (const d of inputs.directPayments) {
      if (d.toPayeeId === id) b -= d.amountCents;
      if (d.fromPayeeId === id) b += d.amountCents;
    }
    if (actualMode) {
      b -= paidOf(id);
      projectedPaid[id] = null;
    } else {
      const pp =
        id === rem
          ? gross - paidFirst
          : firstClauses.filter((c) => c.payeeId === id).reduce((s, c) => s + (first.get(c.id) as number), 0);
      b -= pp;
      projectedPaid[id] = pp;
    }
    balance[id] = b;
  }

  // Owed to: others' uncovered claims, capped at what they're still owed.
  const owedTo: Record<string, number> = {};
  const uncoveredDirect: Record<string, number> = {};
  for (const c of direct) {
    const u = (ent.get(c.id) as number) - (covered.get(c.id) ?? 0);
    if (u > 0) uncoveredDirect[c.payeeId] = (uncoveredDirect[c.payeeId] ?? 0) + u;
  }
  for (const [p, u] of Object.entries(uncoveredDirect)) {
    const v = Math.min(u, Math.max(0, balance[p] as number));
    if (v > 0) owedTo[p] = v;
  }

  return { gross, paidFirst, pool, remainder, ent, cappedFrom, entitlement, balance, projectedPaid, owedTo, shortfall: Math.max(0, -remainder) };
}

const CASES = 3_000;

describe("computeDealSettlement — properties over random deals", () => {
  it(`matches the independent reference per payee and holds every invariant (${CASES} seeded cases)`, () => {
    let shortfalls = 0;
    let owedCases = 0;
    let unrecovered = 0;
    let zeroPools = 0;
    let paidFirstCases = 0;
    let withOffPlatform = 0;
    let namedOwners = 0;
    let projected = 0;
    let ownPerOrder = 0;
    let capped = 0;
    for (let seed = 1; seed <= CASES; seed += 1) {
      const c = randomCase(seed);
      let out;
      try {
        out = computeDealSettlement(c.terms, c.inputs);
      } catch (err) {
        throw new Error(`seed ${seed} threw: ${JSON.stringify(err)} ${String(err)}`);
      }
      const ref = reference(c);
      const ctx = `seed ${seed}`;

      // M8 + M12: the gross is ticket money, untouched; paid-first comes off
      // before costs; the pool never below $0.
      expect(out.waterfall.grossCents, ctx).toBe(ref.gross);
      expect(out.waterfall.perOrderPaidFirstCents, ctx).toBe(ref.paidFirst);
      expect(out.waterfall.netPoolCents, ctx).toBeGreaterThanOrEqual(0);
      expect(out.waterfall.netPoolCents, ctx).toBe(ref.pool);
      // Clause math (M9, W1) and the remainder.
      expect(out.clauses.map((x) => x.entitlementCents), ctx).toEqual(c.terms.clauses.map((x) => ref.ent.get(x.id)));
      expect(out.remainder.shareCents, ctx).toBe(ref.remainder);
      // W1: the uncapped figure is reported exactly where the cap bit.
      expect(out.clauses.map((x) => x.cappedFromCents), ctx).toEqual(
        c.terms.clauses.map((x) => ref.cappedFrom.get(x.id) ?? null),
      );
      if (ref.cappedFrom.size > 0) capped += 1;
      // Per payee: entitlement, balance (actual or projected), projected pay.
      expect(Object.fromEntries(out.payees.map((p) => [p.payeeId, p.entitlementCents])), ctx).toEqual(ref.entitlement);
      expect(
        Object.fromEntries(out.payees.map((p) => [p.payeeId, p.settleDirectlyCents ?? p.projectedSettleDirectlyCents])),
        ctx,
      ).toEqual(ref.balance);
      expect(Object.fromEntries(out.payees.map((p) => [p.payeeId, p.projectedPaidPerOrderCents])), ctx).toEqual(ref.projectedPaid);
      // Conservation: the deal distributes exactly the gross.
      expect(Object.values(ref.entitlement).reduce((s, v) => s + v, 0), ctx).toBe(ref.gross);
      // Balances net out — no money owed to nobody.
      const paid = c.inputs.paidThroughPlatform.reduce((s, p) => s + p.amountCents, 0);
      const net = Object.values(ref.balance).reduce((s, v) => s + v, 0);
      expect(net, ctx).toBe(c.inputs.ticketRevenue.mode === "ACTUAL" ? ref.gross - paid : 0);
      // Shortfall: the total and who is owed it.
      expect(out.shortfall?.cents ?? 0, ctx).toBe(ref.shortfall);
      expect(Object.fromEntries((out.shortfall?.owedTo ?? []).map((o) => [o.payeeId, o.cents])), ctx).toEqual(ref.owedTo);
      for (const o of out.shortfall?.owedTo ?? []) {
        expect(o.cents, ctx).toBeLessThanOrEqual(ref.balance[o.payeeId] as number);
      }
      // A percentage of a $0 pool is $0.
      if (ref.pool === 0) {
        zeroPools += 1;
        for (const x of out.clauses) {
          if (x.how.kind !== "FIXED" && x.how.percentOf.basis === "NET_POOL") {
            expect(x.how.percentCents, ctx).toBe(0);
          }
        }
      }
      if (ref.shortfall > 0) shortfalls += 1;
      if (Object.keys(ref.owedTo).length > 0) owedCases += 1;
      if (out.waterfall.notRecoveredCents > 0) unrecovered += 1;
      if (ref.paidFirst > 0) paidFirstCases += 1;
      if (out.offPlatform.enteredCents > 0) withOffPlatform += 1;
      if (out.offPlatform.rows.some((o) => o.entered && o.ownerPayeeId !== c.terms.remainderPayeeId)) namedOwners += 1;
      if (c.inputs.ticketRevenue.mode === "PROJECTED") projected += 1;
      if (c.terms.clauses.some((x) => x.payeeId === c.terms.remainderPayeeId && isPerOrder(x))) ownPerOrder += 1;
    }
    // The generator must actually reach the interesting regions.
    expect(shortfalls).toBeGreaterThan(CASES / 20);
    expect(owedCases).toBeGreaterThan(CASES / 50);
    expect(unrecovered).toBeGreaterThan(CASES / 20);
    expect(zeroPools).toBeGreaterThan(CASES / 50);
    expect(paidFirstCases).toBeGreaterThan(CASES / 10);
    expect(withOffPlatform).toBeGreaterThan(CASES / 5);
    expect(namedOwners).toBeGreaterThan(CASES / 20);
    expect(projected).toBeGreaterThan(CASES / 4);
    expect(ownPerOrder).toBeGreaterThan(CASES / 20);
    expect(capped).toBeGreaterThan(CASES / 50);
    // 3,000 cases take ~2s alone and can pass vitest's 5s default on a
    // loaded shared machine — a timeout there is not a finding.
  }, 60_000);

  it("refuses what the rules forbid: payments in a projection, a missing remainder figure, a stranger, an overpayment (W4, W5)", () => {
    let projections = 0;
    let actuals = 0;
    let overpaid = 0;
    for (let seed = 1; seed <= 600; seed += 1) {
      const c = randomCase(seed);
      const ctx = `seed ${seed}`;
      const refuse = (inputs: DealSettlementInputs, message: string) => {
        let err: unknown;
        try {
          computeDealSettlement(c.terms, inputs);
        } catch (e) {
          err = e;
        }
        expect(err, ctx).toMatchObject({ code: "invalid_input", message });
      };
      if (c.inputs.ticketRevenue.mode === "PROJECTED") {
        projections += 1;
        refuse(
          { ...c.inputs, paidThroughPlatform: [{ payeeId: c.terms.remainderPayeeId, amountCents: 0 }] },
          "deal_paid_through_platform_in_projection",
        );
      } else {
        actuals += 1;
        refuse(
          {
            ...c.inputs,
            paidThroughPlatform: c.inputs.paidThroughPlatform.filter((p) => p.payeeId !== c.terms.remainderPayeeId),
          },
          "deal_paid_through_platform_missing",
        );
        refuse(
          { ...c.inputs, paidThroughPlatform: [...c.inputs.paidThroughPlatform, { payeeId: "zz-stranger", amountCents: 0 }] },
          "deal_paid_through_platform_unknown_payee",
        );
        // The platform never pays out more than the basis: one cent over
        // the gross, on the remainder payee's figure, is refused.
        const gross = c.inputs.ticketRevenue.basisCents;
        const paidOthers = c.inputs.paidThroughPlatform
          .filter((p) => p.payeeId !== c.terms.remainderPayeeId)
          .reduce((s, p) => s + p.amountCents, 0);
        const over = gross - paidOthers + 1;
        if (over <= MAX_DEAL_AMOUNT_CENTS) {
          overpaid += 1;
          refuse(
            {
              ...c.inputs,
              paidThroughPlatform: c.inputs.paidThroughPlatform.map((p) =>
                p.payeeId === c.terms.remainderPayeeId ? { ...p, amountCents: over } : p,
              ),
            },
            "deal_paid_exceeds_gross",
          );
        }
      }
      // A row held by a stranger never makes them a participant, in either mode.
      refuse(
        {
          ...c.inputs,
          offPlatform: [
            ...c.inputs.offPlatform,
            { id: "zz-row", kind: "DOOR_CASH", label: "x", amountCents: null, heldByPayeeId: "zz-stranger" },
          ],
        },
        "deal_off_platform_unknown_holder",
      );
    }
    expect(projections).toBeGreaterThan(100);
    expect(actuals).toBeGreaterThan(100);
    expect(overpaid).toBeGreaterThan(100);
  });

  it("is deterministic: the same case twice gives byte-identical output", () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const a = randomCase(seed);
      const b = randomCase(seed);
      expect(JSON.stringify(computeDealSettlement(b.terms, b.inputs)), `seed ${seed}`).toBe(
        JSON.stringify(computeDealSettlement(a.terms, a.inputs)),
      );
    }
  });
});
