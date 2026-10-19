/**
 * computeDealSettlement — the one deal calculator (deal-terms-and-settlement
 * FR-002). Pure: no I/O, no clock, no randomness. The agreement editor runs it
 * on a projection ("if we sell 150 tickets at $20"); the settlement page runs
 * it on actual revenue and entered off-platform money.
 *
 * ── Definitions ───────────────────────────────────────────────────────────
 * Gross (M8): ticket money only — Σ `computeAgreementBasis(order)` (the
 *   order's ticket money in full; minus the platform fee on an order sold
 *   before the 2026-10-11 ruling) over the event's ticket orders, net of refunds;
 *   the number per-order splits already divide. The caller supplies it; this
 *   module never sees, and so cannot change, the buyer's price, the platform
 *   fee or tax (M7, NFR-001: redistribution only).
 * Paid first (M9, M12): every non-remainder payee's per-order clause
 *   (PERCENT on GROSS) is paid by the platform as tickets sell,
 *   before any cost comes off. ACTUAL: what the per-order engine paid it
 *   (attributed per clause); PROJECTED: the exact percentage.
 * Available for costs = gross − paid first.
 * Waterfall: deductions in array order, each recouped only from what is
 *   available — `recouped = min(amount, available)`. The rest is "Not
 *   recovered", the credited party's loss, owed by no one. Nobody hands over
 *   money they never received (M12).
 * Pool (NET_POOL): available − Σ recouped. Never below $0.
 * Clause entitlement: FIXED = amount; PERCENT = pct of its basis;
 *   FIXED_AND_PERCENT SUM = amount + pct ("dollar one"); GREATER_OF =
 *   max(amount, pct) ("versus"). The remainder payee's OWN per-order clauses
 *   are capped at what the pool leaves after everyone else (W1). Its total
 *   is the leftover whatever its clauses say, so the cap moves no money: it
 *   lowers those clauses to fit — to $0 when costs or other claims took the
 *   pool — and records the uncapped figure as `cappedFromCents`. Without it,
 *   per-order rounding, costs recouped from money it already holds, and
 *   other payees' guarantees would each show as a shortfall it owes itself.
 * Remainder: pool − Σ entitlements of the clauses not paid first, to
 *   `remainderPayeeId`. SIGNED: negative means the pool cannot cover the
 *   clauses — the shortfall, owed by the remainder payee (M7, never fronted
 *   by the platform).
 * Off-platform money (M8, M11): listed, never split, never in the waterfall.
 *   Each row belongs to its named owner, or to the remainder payee when none
 *   is named (`offPlatformShareCents`), and is already in its holder's hands
 *   (`heldOffPlatformCents`).
 * Balances: ACTUAL — `settleDirectlyCents`, against what the platform has
 *   paid. PROJECTED — `projectedPaidPerOrderCents` (stage-1 rule: each
 *   non-remainder payee its per-order clauses, the remainder payee the rest
 *   of the gross) and `projectedSettleDirectlyCents`; no real payment is
 *   ever mixed into a projection (W4).
 *
 * ── Rounding (stated once, applied everywhere) ────────────────────────────
 * Every percentage amount is FLOORED to the cent: floor(basis × pct / 100),
 * computed in BigInt so no product ever passes through a float. The cents a
 * floor drops are not spread anywhere — they stay in the pool and fall to the
 * remainder payee, so "70% of $3,050" is exactly $2,135 on the sheet and
 * conservation is exact by construction. (The per-order engine's round-robin
 * `distributeRemainder` exists because per-order lines have no remainder
 * holder; a deal always has one, so reusing it would only make printed
 * percentages disagree with the amounts beside them.)
 * Pro-rata splits — which claims an inadequate pool covers, M9's paid amount
 * across one payee's several per-order clauses, and the W1 cap across the
 * remainder payee's own per-order clauses — use largest remainder (Hamilton),
 * ties broken by payeeId then clauseId ascending.
 *
 * ── Identities, asserted before returning ─────────────────────────────────
 *   paid first + available                       = gross
 *   Σ recouped + pool                            = available
 *   Σ entitlements of clauses not paid first
 *     + remainder share                          = pool
 *   Σ payee entitlements                         = gross
 *   ACTUAL:    Σ settleDirectly = (gross + Σ entered off-platform)
 *                                 − Σ paid through the platform
 *                                 − Σ off-platform held
 *   PROJECTED: Σ projectedPaidPerOrder = gross, and
 *              Σ projectedSettleDirectly = Σ entered − Σ held (= 0)
 *   shortfall = externalShortfall + netted + ownClaimsUncovered
 * A failure throws {@link DealSettlementInvariantError}; nothing is ever
 * silently corrected.
 */
import { parseInput } from "../io";
import { fail } from "../errors";
import {
  assertDealTermsShape,
  classifyClauseForStage1,
  dealParticipantIds,
  dealSettlementInputsSchema,
  dealTermsSchema,
  MAX_DEAL_AMOUNT_CENTS,
  type DealBasisKind,
  type DealClause,
  type DealClauseAmountType,
  type DealDeductionKind,
  type DealSettlementInputs,
  type DealSettlementInputsInput,
  type DealTerms,
  type DealTermsInput,
  type OffPlatformAmountKind,
  type Stage1Settlement,
} from "./deal-terms";

/**
 * Bump when the math changes, so a stored sheet records which rules made it.
 * 2 (2026-10-03): M8 ticket-only gross, M9 per-order entitlements, M10
 *   deposits as direct payments, netted shortfall attribution.
 * 3 (2026-10-03): M12 per-order lines paid before costs; W1 cap on the
 *   remainder payee's own per-order clauses.
 * 4 (2026-10-03, P4b): a 0% PERCENT/GROSS clause is per-order like any other
 *   (the engine pays it rounding cents), so its payee is entitled to what the
 *   platform paid it; the remainder payee's own per-order clauses are left
 *   out of the 100% claim total (they are W1-capped) and the per-order lines
 *   are bounded at 100% on their own; an off-platform holder must be a
 *   participant of the terms; clause results carry `cappedFromCents`;
 *   ledger-only payees (named in `ledgerOnlyPayeeIds`) are entitled to what
 *   the platform paid them per order and take part in "paid first".
 */
export const DEAL_SETTLEMENT_ENGINE_VERSION = 4;

/**
 * Thrown when the calculator's own output breaks an invariant. An internal
 * bug, never a user error: deliberately NOT a `{ code }` KnownError, so the
 * transport maps it to a 500 and Sentry captures it. A sheet that does not
 * balance must never render or pay as if it does.
 */
export class DealSettlementInvariantError extends Error {
  readonly invariant: string;
  readonly details: Readonly<Record<string, unknown>>;
  constructor(invariant: string, details: Record<string, unknown>) {
    super(`deal_settlement_invariant_failed: ${invariant}`);
    this.name = "DealSettlementInvariantError";
    this.invariant = invariant;
    this.details = details;
  }
}

// ── Output types ──────────────────────────────────────────────────────────

/** What a percent was taken of (NFR-003: copy always says). */
export type DealPercentOf = {
  basis: DealBasisKind;
  basisCents: number;
  /** For NET_POOL: deductions that recouped something before the split. */
  afterDeductionIds: string[];
};

/**
 * How one clause resolved. Enough for the UI to print "guarantee $800 vs 70%
 * of the pool $2,135 → greater" without redoing any math.
 */
export type DealClauseResolutionDetail =
  | { kind: "FIXED"; fixedCents: number }
  | {
      kind: "PERCENT";
      percent: number;
      percentOf: DealPercentOf;
      /** The exact percentage, floored. */
      percentCents: number;
      /**
       * M9: what the per-order engine paid for this clause (ACTUAL mode,
       * PAID_PER_ORDER, non-remainder payee). When set, it IS the
       * entitlement. Null otherwise.
       */
      paidPerOrderCents: number | null;
    }
  | {
      kind: "SUM";
      fixedCents: number;
      percent: number;
      percentOf: DealPercentOf;
      percentCents: number;
    }
  | {
      kind: "GREATER_OF";
      fixedCents: number;
      percent: number;
      percentOf: DealPercentOf;
      percentCents: number;
      /** TIE pays the (equal) fixed amount. */
      picked: "FIXED" | "PERCENT" | "TIE";
    };

export type DealClauseResult = {
  clauseId: string;
  payeeId: string;
  amountType: DealClauseAmountType;
  displayLabel: string | null;
  entitlementCents: number;
  how: DealClauseResolutionDetail;
  stage1: Stage1Settlement;
  /**
   * M12: paid by the platform per order before any cost came off (a
   * non-remainder payee's per-order clause). Always fully covered.
   */
  paidBeforeCosts: boolean;
  /** Part of the entitlement covered (by the pool, or paid first). */
  coveredByPoolCents: number;
  uncoveredCents: number;
  /**
   * W1: what this clause came to BEFORE the cap lowered it to fit the pool
   * (the remainder payee's own per-order clauses only). Null when the cap
   * did not bite. The sheet shows "70% of $1,500 = $1,050, capped to $0:
   * the remainder takes what is left".
   */
  cappedFromCents: number | null;
};

export type DealWaterfallStep = {
  deductionId: string;
  kind: DealDeductionKind;
  label: string;
  creditedPayeeId: string;
  /**
   * The percent of the gross this step took. Null for a fixed amount, and
   * null once an ACTUAL replaces a percent estimate (the amount is then the
   * entered figure, not a percent of anything).
   */
  percent: number | null;
  /** The amount this step tried to recoup. */
  amountCents: number;
  /** AGREED (not estimated), ESTIMATE (no actual yet), ACTUAL (entered). */
  amountSource: "AGREED" | "ESTIMATE" | "ACTUAL";
  /** True while the amount is still an estimate (NFR-002: "Estimated"). */
  estimated: boolean;
  availableBeforeCents: number;
  recoupedCents: number;
  /** "Not recovered" — the credited payee's loss. */
  notRecoveredCents: number;
  availableAfterCents: number;
};

export type DealOffPlatformResult = {
  id: string;
  kind: OffPlatformAmountKind;
  label: string;
  heldByPayeeId: string;
  /** M11: who the money belongs to — the named owner, else the remainder payee. */
  ownerPayeeId: string;
  entered: boolean;
  /** Absent when not entered — never 0. */
  amountCents?: number;
};

export type DealCreditedDeduction = {
  deductionId: string;
  recoupedCents: number;
  notRecoveredCents: number;
};

/**
 * W3: is what the platform paid this payee plausible for the order count?
 * Each order (or refund) moves a per-order line by under a cent from its
 * exact share, so |paid − expected| ≤ lines × (orderCount + 1). A warning,
 * never a refusal.
 */
export type DealPerOrderCheck = {
  paidCents: number;
  /** Non-remainder: Σ exact per-order shares. Remainder: gross − Σ others'. */
  expectedCents: number;
  toleranceCents: number;
  plausible: boolean;
};

export type DealPayeePosition = {
  payeeId: string;
  isRemainder: boolean;
  clauseIds: string[];
  /**
   * W1: paid per order under a line the terms no longer have — named in
   * `ledgerOnlyPayeeIds`; entitled to exactly that (M9). 0 for everyone else.
   */
  ledgerOnlyCents: number;
  /** Σ this payee's clause entitlements. */
  clauseCents: number;
  /** Signed; null for everyone but the remainder payee. */
  remainderShareCents: number | null;
  creditedDeductions: DealCreditedDeduction[];
  /** Σ recouped and credited to this payee. */
  creditedDeductionsCents: number;
  /** Σ costs this payee fronted that the money could not recover. */
  notRecoveredCents: number;
  /**
   * The deal's allocation of the gross to this payee:
   * clauseCents + remainderShareCents + creditedDeductionsCents
   * + ledgerOnlyCents. Signed.
   * Σ over payees = gross.
   */
  entitlementCents: number;
  /** M8/M11: entered off-platform money that belongs to this payee. */
  offPlatformShareCents: number;
  /** Entered off-platform money this payee already holds (door cash box). */
  heldOffPlatformCents: number;
  directReceivedCents: number;
  directPaidCents: number;
  /** ACTUAL: what the platform has paid this payee. Null in PROJECTED. */
  paidThroughPlatformCents: number | null;
  /**
   * ACTUAL: balance to settle directly — + is owed TO this payee, − they owe.
   * entitlement + offPlatformShare − paidThroughPlatform − heldOffPlatform
   * − directReceived + directPaid. Excludes not-entered off-platform rows.
   * Null in PROJECTED.
   */
  settleDirectlyCents: number | null;
  /** PROJECTED: what the platform will pay this payee per order. Null in ACTUAL. */
  projectedPaidPerOrderCents: number | null;
  /**
   * PROJECTED: the rest, to be settled directly (the same formula with the
   * projected per-order pay in place of paidThroughPlatform). Null in ACTUAL.
   */
  projectedSettleDirectlyCents: number | null;
  /** W3, ACTUAL with an orderCount; null otherwise. */
  perOrderCheck: DealPerOrderCheck | null;
  /** As remainder payee: the external shortfall it owes other payees. */
  shortfallOwedCents: number;
  /** As creditor: shortfall still owed to this payee directly. */
  shortfallDueCents: number;
};

/**
 * The pool could not cover the clauses. Present whenever `cents > 0`.
 *
 * A SHORTFALL BANNER KEYS ON `externalShortfallCents > 0` — the money the
 * remainder payee must still hand another payee directly. `cents` is the
 * deal-level gap and can be non-zero with nothing owed to anyone (the
 * remainder payee short of its own clause, or a creditor already holding it).
 */
export type DealShortfall = {
  /** max(0, Σ entitlements of the clauses not paid first − pool). */
  cents: number;
  owedByPayeeId: string;
  /** Still owed directly, per creditor, after netting what they hold. */
  owedTo: Array<{ payeeId: string; cents: number }>;
  /** Σ owedTo. The number a banner shows. */
  externalShortfallCents: number;
  /**
   * Uncovered direct claims a creditor already holds the money for (a
   * direct payment, door cash in its box, an overpayment by the platform).
   */
  nettedCents: number;
  /** The remainder payee's OWN uncovered clauses: a debt to itself. */
  ownClaimsUncoveredCents: number;
};

export type DealSettlementResult = {
  engineVersion: number;
  revenueMode: "PROJECTED" | "ACTUAL";
  waterfall: {
    /** M8: ticket money only. */
    grossCents: number;
    /** M12: per-order clauses the platform paid before any cost came off. */
    perOrderPaidFirstCents: number;
    /** gross − perOrderPaidFirst: what costs can be recouped from. */
    availableForCostsCents: number;
    steps: DealWaterfallStep[];
    recoupedCents: number;
    notRecoveredCents: number;
    netPoolCents: number;
  };
  /** M8: listed, not split, not in the waterfall. */
  offPlatform: {
    rows: DealOffPlatformResult[];
    enteredCents: number;
    /** Not-entered rows — excluded from `enteredCents` and from every balance. */
    excludesIds: string[];
    /** M11: owner of any row that names none — the remainder payee. */
    defaultOwnerPayeeId: string;
  };
  clauses: DealClauseResult[];
  remainder: {
    payeeId: string;
    shareCents: number;
    /**
     * M9: Σ (paid per order − exact percentage) over the clauses paid first.
     * It shrinks (or grows) what is available for costs, so it lands on the
     * remainder payee — or on a cost's "Not recovered" when costs take
     * everything.
     */
    perOrderDifferenceCents: number;
  };
  payees: DealPayeePosition[];
  /** W1: ledger-only payees and what the platform paid them per order. */
  ledgerOnly: Array<{ payeeId: string; paidCents: number }>;
  shortfall: DealShortfall | null;
  warnings: {
    /** W3: payees whose platform payment is implausible for the order count. */
    implausiblePerOrderPayeeIds: string[];
  };
  completeness: {
    notEnteredOffPlatformIds: string[];
    estimatedDeductionIds: string[];
    /** ACTUAL revenue, nothing not-entered, nothing still estimated. */
    complete: boolean;
  };
  conservation: {
    grossCents: number;
    /** Σ payee entitlements (signed). Equals grossCents. */
    distributedCents: number;
    recoupedCents: number;
    /** Σ entitlements of clauses not paid first + remainder share. Equals the pool. */
    poolDistributedCents: number;
    shortfallCents: number;
    /** Σ settleDirectlyCents (ACTUAL) or Σ projectedSettleDirectlyCents (PROJECTED). */
    settleDirectlyNetCents: number;
    /**
     * From the raw inputs: ACTUAL (gross + Σ entered) − Σ paid − Σ held;
     * PROJECTED Σ entered − Σ held.
     */
    expectedSettleDirectlyNetCents: number;
  };
};

// ── Integer helpers ───────────────────────────────────────────────────────

/** floor(basis × percent / 100). BigInt so no product passes through a float. */
export function percentOfCents(basisCents: number, percent: number): number {
  if (basisCents <= 0 || percent <= 0) return 0;
  return Number((BigInt(basisCents) * BigInt(percent)) / 100n);
}

/** Locale-independent string order, so tie-breaks are identical on every runtime. */
const compareCodePoints = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

type Weighted = { payeeId: string; clauseId: string; weight: number };

/**
 * Split `amount` across `items` pro rata to `weight`, largest remainder,
 * ties by payeeId then clauseId. Requires Σ weight > 0. BigInt throughout:
 * amount × weight can pass 2^53.
 */
function largestRemainder(amount: number, items: readonly Weighted[]): number[] {
  const total = BigInt(sum(items.map((i) => i.weight)));
  const A = BigInt(amount);
  const shares = items.map((item, index) => {
    const product = A * BigInt(item.weight);
    return { item, index, cents: Number(product / total), fraction: product % total };
  });
  let leftover = amount - sum(shares.map((s) => s.cents));
  const byFraction = [...shares].sort(
    (a, b) =>
      (a.fraction < b.fraction ? 1 : a.fraction > b.fraction ? -1 : 0) ||
      compareCodePoints(a.item.payeeId, b.item.payeeId) ||
      compareCodePoints(a.item.clauseId, b.item.clauseId),
  );
  for (const share of byFraction) {
    if (leftover <= 0) break;
    share.cents += 1;
    leftover -= 1;
  }
  return shares.map((s) => s.cents);
}

/** Split `amount` pro rata to `weight` (largest remainder); all to the first when every weight is 0. */
function splitProRata(amount: number, items: readonly Weighted[]): number[] {
  return sum(items.map((i) => i.weight)) > 0
    ? largestRemainder(amount, items)
    : items.map((_, i) => (i === 0 ? amount : 0));
}

// ── The calculator ────────────────────────────────────────────────────────

export function computeDealSettlement(
  rawTerms: DealTermsInput,
  rawInputs: DealSettlementInputsInput,
): DealSettlementResult {
  const terms: DealTerms = parseInput(dealTermsSchema, rawTerms);
  const inputs: DealSettlementInputs = parseInput(
    dealSettlementInputsSchema,
    rawInputs,
  );
  assertDealTermsShape(terms);
  const grossCents = ticketRevenueOf(inputs);
  assertInputsShape(terms, inputs, grossCents);

  const remainderPayeeId = terms.remainderPayeeId;
  const isActual = inputs.ticketRevenue.mode === "ACTUAL";
  const isPaidFirst = (c: DealClause) =>
    c.payeeId !== remainderPayeeId && classifyClauseForStage1(c) === "PAID_PER_ORDER";
  const isOwnPerOrder = (c: DealClause) =>
    c.payeeId === remainderPayeeId && classifyClauseForStage1(c) === "PAID_PER_ORDER";

  // Off-platform money: listed, held, owned (M11). Not split.
  const offPlatformRows: DealOffPlatformResult[] = inputs.offPlatform.map((row) => {
    const entered = row.amountCents !== null && row.amountCents !== undefined;
    const out: DealOffPlatformResult = {
      id: row.id,
      kind: row.kind,
      label: row.label,
      heldByPayeeId: row.heldByPayeeId,
      ownerPayeeId: row.ownerPayeeId ?? remainderPayeeId,
      entered,
    };
    if (entered) out.amountCents = row.amountCents as number;
    return out;
  });
  const offPlatformEnteredCents = sum(offPlatformRows.map((r) => r.amountCents ?? 0));
  const notEnteredOffPlatformIds = offPlatformRows
    .filter((r) => !r.entered)
    .map((r) => r.id);

  // 1. Paid first (M9, M12): non-remainder per-order clauses.
  const paid = new Map(
    inputs.paidThroughPlatform.map((p) => [p.payeeId, p.amountCents]),
  );
  const paidFirst = isActual
    ? attributePerOrderPayments(terms, paid, grossCents)
    : new Map(
        terms.clauses
          .filter(isPaidFirst)
          .map((c) => [c.id, percentOfCents(grossCents, c.percent as number)]),
      );
  // W1 (P4b review): ledger-only payees were paid per order too, under lines
  // the terms no longer have — that money left before any cost, like a
  // per-order clause's, and is theirs (M9).
  const ledgerOnly = inputs.ledgerOnlyPayeeIds.map((payeeId) => ({
    payeeId,
    paidCents: paid.get(payeeId) ?? 0,
  }));
  const ledgerOnlyCents = new Map(ledgerOnly.map((l) => [l.payeeId, l.paidCents]));
  const perOrderPaidFirstCents =
    sum([...paidFirst.values()]) + sum(ledgerOnly.map((l) => l.paidCents));
  const availableForCostsCents = grossCents - perOrderPaidFirstCents;

  // 2. Waterfall: recoup in order, only from money still available.
  const actuals = new Map(
    inputs.deductionActuals.map((a) => [a.deductionId, a.amountCents]),
  );
  let available = availableForCostsCents;
  const steps: DealWaterfallStep[] = terms.deductions.map((deduction) => {
    const actual = actuals.get(deduction.id);
    const isPercent = deduction.percent !== null && deduction.percent !== undefined;
    const planned = isPercent
      ? percentOfCents(grossCents, deduction.percent as number)
      : (deduction.amountCents as number);
    const amountCents = actual ?? planned;
    const amountSource: DealWaterfallStep["amountSource"] = !deduction.estimated
      ? "AGREED"
      : actual === undefined
        ? "ESTIMATE"
        : "ACTUAL";
    const availableBeforeCents = available;
    const recoupedCents = Math.min(amountCents, available);
    available -= recoupedCents;
    return {
      deductionId: deduction.id,
      kind: deduction.kind,
      label: deduction.label,
      creditedPayeeId: deduction.creditedPayeeId,
      percent: isPercent && amountSource !== "ACTUAL" ? (deduction.percent as number) : null,
      amountCents,
      amountSource,
      estimated: amountSource === "ESTIMATE",
      availableBeforeCents,
      recoupedCents,
      notRecoveredCents: amountCents - recoupedCents,
      availableAfterCents: available,
    };
  });
  const recoupedCents = sum(steps.map((s) => s.recoupedCents));
  const notRecoveredCents = sum(steps.map((s) => s.notRecoveredCents));
  const netPoolCents = availableForCostsCents - recoupedCents;
  const afterDeductionIds = steps
    .filter((s) => s.recoupedCents > 0)
    .map((s) => s.deductionId);

  // 3. Clause entitlements.
  const percentOfFor = (basis: DealBasisKind): DealPercentOf =>
    basis === "GROSS"
      ? { basis, basisCents: grossCents, afterDeductionIds: [] }
      : { basis, basisCents: netPoolCents, afterDeductionIds };
  const resolved = terms.clauses.map((clause) =>
    resolveClause(
      clause,
      percentOfFor,
      isPaidFirst(clause) ? (paidFirst.get(clause.id) as number) : null,
      isActual && isPaidFirst(clause),
    ),
  );
  capOwnPerOrderClauses(resolved, isOwnPerOrder, isPaidFirst, netPoolCents);

  const poolClaimsCents = sum(
    resolved.filter((r) => !r.paidFirst).map((r) => r.entitlementCents),
  );
  const remainderShareCents = netPoolCents - poolClaimsCents;
  const perOrderDifferenceCents = sum(
    resolved.map((r) =>
      r.how.kind === "PERCENT" && r.how.paidPerOrderCents !== null
        ? r.how.paidPerOrderCents - r.how.percentCents
        : 0,
    ),
  );

  // 4. Which claims the pool covers.
  const coverage = coverClaims(resolved, remainderPayeeId, netPoolCents);
  const clauses: DealClauseResult[] = resolved.map((r) => {
    const covered = coverage.get(r.clause.id) ?? 0;
    return {
      clauseId: r.clause.id,
      payeeId: r.clause.payeeId,
      amountType: r.clause.amountType,
      displayLabel: r.clause.displayLabel ?? null,
      entitlementCents: r.entitlementCents,
      how: r.how,
      stage1: r.stage1,
      paidBeforeCosts: r.paidFirst,
      coveredByPoolCents: covered,
      uncoveredCents: r.entitlementCents - covered,
      cappedFromCents: r.cappedFromCents,
    };
  });

  // 5. Per-payee positions (balances do not depend on the shortfall).
  const positions = buildPayeePositions({
    terms,
    inputs,
    clauses,
    steps,
    offPlatformRows,
    remainderShareCents,
    grossCents,
    perOrderPaidFirstCents,
  });

  // 6. Shortfall: who still owes whom, after netting.
  const shortfall = buildShortfall({
    clauses,
    positions,
    remainderPayeeId,
    shortfallCents: Math.max(0, -remainderShareCents),
  });
  const payees: DealPayeePosition[] = positions.map((p) => ({
    ...p,
    shortfallOwedCents:
      p.isRemainder && shortfall ? shortfall.externalShortfallCents : 0,
    shortfallDueCents:
      shortfall?.owedTo.find((o) => o.payeeId === p.payeeId)?.cents ?? 0,
  }));

  const result: DealSettlementResult = {
    engineVersion: DEAL_SETTLEMENT_ENGINE_VERSION,
    revenueMode: inputs.ticketRevenue.mode,
    waterfall: {
      grossCents,
      perOrderPaidFirstCents,
      availableForCostsCents,
      steps,
      recoupedCents,
      notRecoveredCents,
      netPoolCents,
    },
    offPlatform: {
      rows: offPlatformRows,
      enteredCents: offPlatformEnteredCents,
      excludesIds: notEnteredOffPlatformIds,
      defaultOwnerPayeeId: remainderPayeeId,
    },
    clauses,
    remainder: {
      payeeId: remainderPayeeId,
      shareCents: remainderShareCents,
      perOrderDifferenceCents,
    },
    payees,
    ledgerOnly,
    shortfall,
    warnings: {
      implausiblePerOrderPayeeIds: payees
        .filter((p) => p.perOrderCheck !== null && !p.perOrderCheck.plausible)
        .map((p) => p.payeeId),
    },
    completeness: {
      notEnteredOffPlatformIds,
      estimatedDeductionIds: steps.filter((s) => s.estimated).map((s) => s.deductionId),
      complete:
        isActual &&
        notEnteredOffPlatformIds.length === 0 &&
        steps.every((s) => !s.estimated),
    },
    conservation: {
      grossCents,
      distributedCents: sum(payees.map((p) => p.entitlementCents)),
      recoupedCents,
      poolDistributedCents: poolClaimsCents + remainderShareCents,
      shortfallCents: Math.max(0, -remainderShareCents),
      settleDirectlyNetCents: sum(
        payees.map((p) => (isActual ? p.settleDirectlyCents : p.projectedSettleDirectlyCents) ?? 0),
      ),
      expectedSettleDirectlyNetCents: expectedBalancesNet(grossCents, inputs),
    },
  };

  assertDealSettlementInvariants(result);
  return result;
}

// ── Stages ────────────────────────────────────────────────────────────────

/**
 * The balance identity, from the raw inputs alone (never from the per-payee
 * math it checks). ACTUAL: (gross + Σ entered off-platform) − Σ paid through
 * the platform − Σ off-platform held. PROJECTED: the platform will pay out
 * the whole gross per order, so it is Σ entered − Σ held. Every entered row
 * names its holder, so held = entered; the terms are spelled out so a change
 * that splits, drops or double-counts off-platform money cannot hide.
 */
function expectedBalancesNet(grossCents: number, inputs: DealSettlementInputs): number {
  const entered = sum(inputs.offPlatform.map((o) => o.amountCents ?? 0));
  // The schema requires `heldByPayeeId` on every row, so every entered cent
  // is held by someone.
  const held = entered;
  if (inputs.ticketRevenue.mode === "PROJECTED") return entered - held;
  const paid = sum(inputs.paidThroughPlatform.map((p) => p.amountCents));
  return grossCents + entered - paid - held;
}

function ticketRevenueOf(inputs: DealSettlementInputs): number {
  const revenue = inputs.ticketRevenue;
  if (revenue.mode === "ACTUAL") return revenue.basisCents;
  let total = 0n;
  for (const tier of revenue.tiers) {
    total += BigInt(tier.tickets) * BigInt(tier.unitBasisCents);
  }
  if (total > BigInt(MAX_DEAL_AMOUNT_CENTS)) {
    fail("invalid_input", "deal_revenue_too_large");
  }
  return Number(total);
}

/** Non-remainder payees' per-order clauses: paid first, M9's paid amount. */
const perOrderClausesByPayee = (terms: DealTerms): Map<string, DealClause[]> => {
  const byPayee = new Map<string, DealClause[]>();
  for (const clause of terms.clauses) {
    if (clause.payeeId === terms.remainderPayeeId) continue;
    if (classifyClauseForStage1(clause) !== "PAID_PER_ORDER") continue;
    byPayee.set(clause.payeeId, [...(byPayee.get(clause.payeeId) ?? []), clause]);
  }
  return byPayee;
};

function assertInputsShape(
  terms: DealTerms,
  inputs: DealSettlementInputs,
  grossCents: number,
) {
  const unique = (ids: string[], message: string) => {
    if (new Set(ids).size !== ids.length) fail("invalid_input", message);
  };
  unique(inputs.offPlatform.map((o) => o.id), "deal_duplicate_off_platform_id");
  unique(
    inputs.deductionActuals.map((a) => a.deductionId),
    "deal_duplicate_deduction_actual",
  );
  unique(
    inputs.paidThroughPlatform.map((p) => p.payeeId),
    "deal_duplicate_paid_through_platform_payee",
  );
  unique(inputs.directPayments.map((d) => d.id), "deal_duplicate_direct_payment_id");

  const deductions = new Map(terms.deductions.map((d) => [d.id, d]));
  for (const actual of inputs.deductionActuals) {
    const deduction = deductions.get(actual.deductionId);
    if (!deduction) fail("invalid_input", "deal_unknown_deduction_actual");
    // An agreed amount (a rental struck in the booking) is not re-typed after
    // the show; only an estimate takes an actual (08-07 §5 provenance).
    if (!deduction.estimated) fail("invalid_input", "deal_deduction_not_estimated");
  }

  // Direct payments move money between two named participants (B1, W6); a
  // named off-platform owner (M11), the holder of off-platform money and a
  // platform payee (W5) must be one too. Participants come from the TERMS,
  // plus the ledger-only payees named explicitly (W1): an input row can never
  // make a stranger a party to the sheet.
  unique(inputs.ledgerOnlyPayeeIds, "deal_duplicate_ledger_only_payee");
  const termsParticipants = dealParticipantIds(terms);
  for (const payeeId of inputs.ledgerOnlyPayeeIds) {
    if (termsParticipants.has(payeeId)) fail("invalid_input", "deal_ledger_only_is_a_participant");
  }
  const participants = new Set([...termsParticipants, ...inputs.ledgerOnlyPayeeIds]);
  for (const row of inputs.offPlatform) {
    if (!participants.has(row.heldByPayeeId)) {
      fail("invalid_input", "deal_off_platform_unknown_holder");
    }
  }
  for (const payment of inputs.directPayments) {
    if (payment.fromPayeeId === payment.toPayeeId) {
      fail("invalid_input", "deal_direct_payment_to_self");
    }
    if (!participants.has(payment.fromPayeeId) || !participants.has(payment.toPayeeId)) {
      fail("invalid_input", "deal_direct_payment_unknown_party");
    }
  }
  for (const row of inputs.offPlatform) {
    const owner = row.ownerPayeeId;
    if (owner !== null && owner !== undefined && !participants.has(owner)) {
      fail("invalid_input", "deal_off_platform_unknown_owner");
    }
  }

  if (inputs.ticketRevenue.mode === "PROJECTED") {
    // W4: a projection never mixes in real payments.
    if (inputs.paidThroughPlatform.length > 0) {
      fail("invalid_input", "deal_paid_through_platform_in_projection");
    }
    if (inputs.ledgerOnlyPayeeIds.length > 0) {
      fail("invalid_input", "deal_ledger_only_in_projection");
    }
    return;
  }

  // ACTUAL (M9, W5): unknown is never $0 paid; no strangers; no overpayment.
  for (const p of inputs.paidThroughPlatform) {
    if (!participants.has(p.payeeId)) {
      fail("invalid_input", "deal_paid_through_platform_unknown_payee");
    }
  }
  const paidPayees = new Set(inputs.paidThroughPlatform.map((p) => p.payeeId));
  const required = [
    terms.remainderPayeeId,
    ...perOrderClausesByPayee(terms).keys(),
    // A ledger-only payee IS its platform figure; it can't be missing.
    ...inputs.ledgerOnlyPayeeIds,
  ];
  for (const payeeId of required) {
    if (!paidPayees.has(payeeId)) {
      fail("invalid_input", "deal_paid_through_platform_missing");
    }
  }
  if (sum(inputs.paidThroughPlatform.map((p) => p.amountCents)) > grossCents) {
    fail("invalid_input", "deal_paid_exceeds_gross");
  }
}

/**
 * M9: clause id → what the per-order engine paid for it. A non-remainder
 * payee's whole platform payment belongs to its per-order clauses (the only
 * thing the stage-1 engine pays it for); across several, largest remainder
 * pro rata to each clause's exact percentage (all to the first when every
 * exact amount is 0).
 */
function attributePerOrderPayments(
  terms: DealTerms,
  paid: ReadonlyMap<string, number>,
  grossCents: number,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [payeeId, clauses] of perOrderClausesByPayee(terms)) {
    const shares = splitProRata(
      paid.get(payeeId) ?? 0,
      clauses.map((c) => ({
        payeeId,
        clauseId: c.id,
        weight: percentOfCents(grossCents, c.percent as number),
      })),
    );
    clauses.forEach((c, i) => out.set(c.id, shares[i] as number));
  }
  return out;
}

type ResolvedClause = {
  clause: DealClause;
  stage1: Stage1Settlement;
  /** M12: paid per order before any cost (a non-remainder per-order clause). */
  paidFirst: boolean;
  entitlementCents: number;
  how: DealClauseResolutionDetail;
  /** Part of the entitlement that is a percentage. */
  percentPartCents: number;
  /** Part that is fixed, including a winning guarantee's top-up. */
  fixedPartCents: number;
  /** W1: the entitlement before the cap lowered it; null when it did not. */
  cappedFromCents: number | null;
};

function resolveClause(
  clause: DealClause,
  percentOfFor: (basis: DealBasisKind) => DealPercentOf,
  paidFirstCents: number | null,
  reportPaidPerOrder: boolean,
): ResolvedClause {
  const stage1 = classifyClauseForStage1(clause);
  const paidFirst = paidFirstCents !== null;
  if (clause.amountType === "FIXED") {
    const fixedCents = clause.amountCents as number;
    return {
      clause,
      stage1,
      paidFirst,
      entitlementCents: fixedCents,
      how: { kind: "FIXED", fixedCents },
      percentPartCents: 0,
      fixedPartCents: fixedCents,
      cappedFromCents: null,
    };
  }

  const percent = clause.percent as number;
  const percentOf = percentOfFor(clause.basis);
  const percentCents = percentOfCents(percentOf.basisCents, percent);

  if (clause.amountType === "PERCENT") {
    const entitlementCents = paidFirstCents ?? percentCents;
    return {
      clause,
      stage1,
      paidFirst,
      entitlementCents,
      how: {
        kind: "PERCENT",
        percent,
        percentOf,
        percentCents,
        paidPerOrderCents: reportPaidPerOrder ? entitlementCents : null,
      },
      percentPartCents: entitlementCents,
      fixedPartCents: 0,
      cappedFromCents: null,
    };
  }

  const fixedCents = clause.amountCents as number;
  if (clause.resolution === "SUM") {
    return {
      clause,
      stage1,
      paidFirst,
      entitlementCents: fixedCents + percentCents,
      how: { kind: "SUM", fixedCents, percent, percentOf, percentCents },
      percentPartCents: percentCents,
      fixedPartCents: fixedCents,
      cappedFromCents: null,
    };
  }

  // GREATER_OF ("versus").
  const picked: "FIXED" | "PERCENT" | "TIE" =
    percentCents > fixedCents ? "PERCENT" : percentCents < fixedCents ? "FIXED" : "TIE";
  const entitlementCents = Math.max(fixedCents, percentCents);
  return {
    clause,
    stage1,
    paidFirst,
    entitlementCents,
    how: { kind: "GREATER_OF", fixedCents, percent, percentOf, percentCents, picked },
    percentPartCents: percentCents,
    fixedPartCents: entitlementCents - percentCents,
    cappedFromCents: null,
  };
}

/**
 * W1: cap the remainder payee's own per-order clauses at what the pool
 * leaves after every other claim. Its total entitlement is the leftover
 * whatever these say, so the cap changes no total — it only stops per-order
 * rounding (or costs it holds the money for) showing as a shortfall the
 * remainder payee owes itself. Mutates `resolved` in place.
 */
function capOwnPerOrderClauses(
  resolved: ResolvedClause[],
  isOwnPerOrder: (c: DealClause) => boolean,
  isPaidFirst: (c: DealClause) => boolean,
  poolCents: number,
): void {
  const own = resolved.filter((r) => isOwnPerOrder(r.clause));
  if (own.length === 0) return;
  const otherClaims = sum(
    resolved
      .filter((r) => !isPaidFirst(r.clause) && !isOwnPerOrder(r.clause))
      .map((r) => r.entitlementCents),
  );
  const room = Math.max(0, poolCents - otherClaims);
  const wanted = sum(own.map((r) => r.entitlementCents));
  if (wanted <= room) return;
  const shares = largestRemainder(
    room,
    own.map((r) => ({
      payeeId: r.clause.payeeId,
      clauseId: r.clause.id,
      weight: r.entitlementCents,
    })),
  );
  own.forEach((r, i) => {
    const capped = shares[i] as number;
    // Record the uncapped figure only where the cap actually lowered THIS
    // clause (a pro-rata share can equal its own entitlement).
    if (capped !== r.entitlementCents) r.cappedFromCents = r.entitlementCents;
    r.entitlementCents = capped;
    r.percentPartCents = capped;
  });
}

/**
 * Which part of each clause is covered. Clauses paid first (M12) are
 * covered in full — the platform paid them out of the gross before any cost.
 * The pool then covers, in order:
 *  1. other payees' percentage parts;
 *  2. other payees' fixed parts (a guarantee, a versus top-up);
 *  3. the remainder payee's own non-per-order clauses — since an uncovered
 *     claim of its own is a debt to itself;
 *  4. the remainder payee's own per-order clauses (capped to fit, W1).
 * Within a tier the pool can't fully cover: largest remainder, pro rata.
 * Returns covered cents per clause id.
 */
function coverClaims(
  resolved: readonly ResolvedClause[],
  remainderPayeeId: string,
  poolCents: number,
): Map<string, number> {
  const covered = new Map<string, number>();
  for (const r of resolved) {
    if (r.paidFirst) covered.set(r.clause.id, r.entitlementCents);
  }
  const direct = resolved.filter(
    (r) => !r.paidFirst && r.clause.payeeId !== remainderPayeeId,
  );
  const own = resolved.filter((r) => r.clause.payeeId === remainderPayeeId);
  const ownPerOrder = own.filter((r) => r.stage1 === "PAID_PER_ORDER");
  const ownOther = own.filter((r) => r.stage1 !== "PAID_PER_ORDER");
  const claim = (r: ResolvedClause, cents: number): Weighted => ({
    payeeId: r.clause.payeeId,
    clauseId: r.clause.id,
    weight: cents,
  });
  const tiers: Weighted[][] = [
    direct.map((r) => claim(r, r.percentPartCents)),
    direct.map((r) => claim(r, r.fixedPartCents)),
    ownOther.map((r) => claim(r, r.entitlementCents)),
    ownPerOrder.map((r) => claim(r, r.entitlementCents)),
  ];

  const add = (clauseId: string, cents: number) =>
    covered.set(clauseId, (covered.get(clauseId) ?? 0) + cents);

  let available = poolCents;
  for (const tier of tiers) {
    const claims = tier.filter((c) => c.weight > 0);
    const tierTotal = sum(claims.map((c) => c.weight));
    if (tierTotal <= available) {
      for (const c of claims) add(c.clauseId, c.weight);
      available -= tierTotal;
      continue;
    }
    largestRemainder(available, claims).forEach((cents, i) =>
      add((claims[i] as Weighted).clauseId, cents),
    );
    available = 0;
  }
  return covered;
}

type PositionWithoutShortfall = Omit<
  DealPayeePosition,
  "shortfallOwedCents" | "shortfallDueCents"
>;

function buildPayeePositions(args: {
  terms: DealTerms;
  inputs: DealSettlementInputs;
  clauses: DealClauseResult[];
  steps: DealWaterfallStep[];
  offPlatformRows: DealOffPlatformResult[];
  remainderShareCents: number;
  grossCents: number;
  perOrderPaidFirstCents: number;
}): PositionWithoutShortfall[] {
  const { terms, inputs, clauses, steps, offPlatformRows, grossCents } = args;
  const isActual = inputs.ticketRevenue.mode === "ACTUAL";
  const orderCount =
    inputs.ticketRevenue.mode === "ACTUAL" ? inputs.ticketRevenue.orderCount : undefined;

  // Deterministic order: first appearance across terms, then inputs.
  const order: string[] = [];
  const seen = new Set<string>();
  const note = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    order.push(id);
  };
  for (const c of terms.clauses) note(c.payeeId);
  note(terms.remainderPayeeId);
  for (const d of terms.deductions) note(d.creditedPayeeId);
  for (const o of offPlatformRows) {
    note(o.heldByPayeeId);
    note(o.ownerPayeeId);
  }
  for (const p of inputs.paidThroughPlatform) note(p.payeeId);
  for (const d of inputs.directPayments) {
    note(d.toPayeeId);
    note(d.fromPayeeId);
  }

  // Exact per-order shares, for the projection and the W3 check.
  const perOrderByPayee = perOrderClausesByPayee(terms);
  const exactPerOrder = (payeeId: string) =>
    sum(
      (perOrderByPayee.get(payeeId) ?? []).map((c) =>
        percentOfCents(grossCents, c.percent as number),
      ),
    );
  const paid = new Map(
    inputs.paidThroughPlatform.map((p) => [p.payeeId, p.amountCents]),
  );
  // W1: a ledger-only payee's per-order pay is a fact, not a share to check.
  const ledgerOnly = new Set(inputs.ledgerOnlyPayeeIds);
  const ledgerOnlyTotal = sum(inputs.ledgerOnlyPayeeIds.map((id) => paid.get(id) ?? 0));
  const othersExactTotal =
    sum([...perOrderByPayee.keys()].map(exactPerOrder)) + ledgerOnlyTotal;
  const othersLineCount =
    sum([...perOrderByPayee.values()].map((cs) => cs.length)) + ledgerOnly.size;
  return order.map((payeeId) => {
    const isRemainder = payeeId === terms.remainderPayeeId;
    const own = clauses.filter((c) => c.payeeId === payeeId);
    const clauseCents = sum(own.map((c) => c.entitlementCents));
    const credited = steps
      .filter((s) => s.creditedPayeeId === payeeId)
      .map((s) => ({
        deductionId: s.deductionId,
        recoupedCents: s.recoupedCents,
        notRecoveredCents: s.notRecoveredCents,
      }));
    const creditedDeductionsCents = sum(credited.map((c) => c.recoupedCents));
    const remainderShareCents = isRemainder ? args.remainderShareCents : null;
    // W1: what the platform paid a ledger-only payee is its entitlement (M9).
    const ledgerOnlyCents = ledgerOnly.has(payeeId) ? (paid.get(payeeId) ?? 0) : 0;
    const entitlementCents =
      clauseCents + (remainderShareCents ?? 0) + creditedDeductionsCents + ledgerOnlyCents;
    const offPlatformShareCents = sum(
      offPlatformRows
        .filter((o) => o.ownerPayeeId === payeeId)
        .map((o) => o.amountCents ?? 0),
    );
    const heldOffPlatformCents = sum(
      offPlatformRows
        .filter((o) => o.heldByPayeeId === payeeId)
        .map((o) => o.amountCents ?? 0),
    );
    const directReceivedCents = sum(
      inputs.directPayments
        .filter((d) => d.toPayeeId === payeeId)
        .map((d) => d.amountCents),
    );
    const directPaidCents = sum(
      inputs.directPayments
        .filter((d) => d.fromPayeeId === payeeId)
        .map((d) => d.amountCents),
    );
    const owedBeforePlatform =
      entitlementCents +
      offPlatformShareCents -
      heldOffPlatformCents -
      directReceivedCents +
      directPaidCents;

    // What the stage-1 per-order engine pays (or should have paid) this payee.
    const expectedPerOrder = isRemainder
      ? grossCents - othersExactTotal
      : ledgerOnly.has(payeeId)
        ? ledgerOnlyCents
        : exactPerOrder(payeeId);
    const projectedPaidPerOrderCents = isActual
      ? null
      : isRemainder
        ? grossCents - args.perOrderPaidFirstCents
        : sum(
            own.filter((c) => c.paidBeforeCosts).map((c) => c.entitlementCents),
          );
    const paidThroughPlatformCents = isActual ? (paid.get(payeeId) ?? 0) : null;

    let perOrderCheck: DealPerOrderCheck | null = null;
    if (isActual && orderCount !== undefined) {
      const lines = isRemainder ? othersLineCount : (perOrderByPayee.get(payeeId)?.length ?? 0);
      const toleranceCents = lines * (orderCount + 1);
      const paidCents = paidThroughPlatformCents ?? 0;
      perOrderCheck = {
        paidCents,
        expectedCents: expectedPerOrder,
        toleranceCents,
        plausible: Math.abs(paidCents - expectedPerOrder) <= toleranceCents,
      };
    }

    return {
      payeeId,
      isRemainder,
      ledgerOnlyCents,
      clauseIds: own.map((c) => c.clauseId),
      clauseCents,
      remainderShareCents,
      creditedDeductions: credited,
      creditedDeductionsCents,
      notRecoveredCents: sum(credited.map((c) => c.notRecoveredCents)),
      entitlementCents,
      offPlatformShareCents,
      heldOffPlatformCents,
      directReceivedCents,
      directPaidCents,
      paidThroughPlatformCents,
      settleDirectlyCents:
        paidThroughPlatformCents === null ? null : owedBeforePlatform - paidThroughPlatformCents,
      projectedPaidPerOrderCents,
      projectedSettleDirectlyCents:
        projectedPaidPerOrderCents === null
          ? null
          : owedBeforePlatform - projectedPaidPerOrderCents,
      perOrderCheck,
    };
  });
}

/** The balance that counts in this mode: actual, or projected. */
const balanceOf = (p: PositionWithoutShortfall): number =>
  p.settleDirectlyCents ?? p.projectedSettleDirectlyCents ?? 0;

/**
 * Attribute the shortfall. The remainder payee's own uncovered clauses are a
 * debt to itself; another payee's uncovered claims are owed to them — capped
 * at what their balance says they are still owed, so the sheet never shows
 * "X owes Y $100" next to Y's "settle directly $0". What the cap removes is
 * `nettedCents`. (Clauses paid first are never uncovered: M12.)
 */
function buildShortfall(args: {
  clauses: DealClauseResult[];
  positions: PositionWithoutShortfall[];
  remainderPayeeId: string;
  shortfallCents: number;
}): DealShortfall | null {
  const { clauses, positions, remainderPayeeId, shortfallCents } = args;
  if (shortfallCents <= 0) return null;

  let ownClaimsUncoveredCents = 0;
  const uncoveredDirect = new Map<string, number>();
  for (const c of clauses) {
    if (c.uncoveredCents <= 0) continue;
    if (c.payeeId === remainderPayeeId) ownClaimsUncoveredCents += c.uncoveredCents;
    else {
      uncoveredDirect.set(
        c.payeeId,
        (uncoveredDirect.get(c.payeeId) ?? 0) + c.uncoveredCents,
      );
    }
  }

  const balance = new Map(positions.map((p) => [p.payeeId, balanceOf(p)]));
  const owedTo: DealShortfall["owedTo"] = [];
  let nettedCents = 0;
  for (const [payeeId, uncovered] of uncoveredDirect) {
    const stillOwed = Math.max(0, balance.get(payeeId) ?? 0);
    const cents = Math.min(uncovered, stillOwed);
    nettedCents += uncovered - cents;
    if (cents > 0) owedTo.push({ payeeId, cents });
  }

  return {
    cents: shortfallCents,
    owedByPayeeId: remainderPayeeId,
    owedTo,
    externalShortfallCents: sum(owedTo.map((o) => o.cents)),
    nettedCents,
    ownClaimsUncoveredCents,
  };
}

// ── Invariants ────────────────────────────────────────────────────────────

/**
 * Every identity the sheet depends on. Exported so tests (and P4b's sheet
 * snapshotting) can re-check a stored result. Throws, never corrects.
 */
export function assertDealSettlementInvariants(
  result: DealSettlementResult,
): void {
  const breach = (invariant: string, details: Record<string, unknown>): never => {
    throw new DealSettlementInvariantError(invariant, details);
  };
  const w = result.waterfall;
  const c = result.conservation;
  const isActual = result.revenueMode === "ACTUAL";

  if (w.netPoolCents < 0) breach("pool_negative", { netPool: w.netPoolCents });
  if (w.availableForCostsCents < 0) breach("available_negative", { ...w, steps: undefined });
  if (w.perOrderPaidFirstCents + w.availableForCostsCents !== w.grossCents) {
    breach("paid_first_not_conserved", { ...w, steps: undefined });
  }
  const paidFirstClauses = sum(
    result.clauses.filter((cl) => cl.paidBeforeCosts).map((cl) => cl.entitlementCents),
  );
  const paidFirstLedgerOnly = sum(result.ledgerOnly.map((l) => l.paidCents));
  if (paidFirstClauses + paidFirstLedgerOnly !== w.perOrderPaidFirstCents) {
    breach("paid_first_mismatch", {
      paidFirstClauses,
      paidFirstLedgerOnly,
      paidFirst: w.perOrderPaidFirstCents,
    });
  }
  if (w.recoupedCents + w.netPoolCents !== w.availableForCostsCents) {
    breach("waterfall_not_conserved", { ...w, steps: undefined });
  }
  if (c.grossCents !== w.grossCents) breach("gross_mismatch", { ...c });
  let running = w.availableForCostsCents;
  for (const step of w.steps) {
    if (
      step.recoupedCents < 0 ||
      step.notRecoveredCents < 0 ||
      step.recoupedCents + step.notRecoveredCents !== step.amountCents ||
      step.availableBeforeCents !== running ||
      step.recoupedCents > step.availableBeforeCents ||
      step.availableAfterCents !== running - step.recoupedCents
    ) {
      breach("waterfall_step", { step, running });
    }
    running = step.availableAfterCents;
  }
  if (running !== w.netPoolCents) {
    breach("waterfall_end", { running, netPool: w.netPoolCents });
  }
  const poolClaims = sum(
    result.clauses.filter((cl) => !cl.paidBeforeCosts).map((cl) => cl.entitlementCents),
  );
  if (
    c.poolDistributedCents !== w.netPoolCents ||
    poolClaims + result.remainder.shareCents !== w.netPoolCents
  ) {
    breach("pool_not_fully_distributed", { ...c, poolClaims, netPool: w.netPoolCents });
  }
  if (c.distributedCents !== c.grossCents) {
    breach("distribution_not_conserved", { ...c });
  }
  const offPlatformOwned = sum(result.payees.map((p) => p.offPlatformShareCents));
  const offPlatformHeld = sum(result.payees.map((p) => p.heldOffPlatformCents));
  if (
    offPlatformOwned !== result.offPlatform.enteredCents ||
    offPlatformHeld !== result.offPlatform.enteredCents
  ) {
    breach("off_platform_not_conserved", {
      offPlatformOwned,
      offPlatformHeld,
      entered: result.offPlatform.enteredCents,
    });
  }
  if (c.shortfallCents !== Math.max(0, -result.remainder.shareCents)) {
    breach("shortfall_mismatch", { ...c, remainder: result.remainder });
  }
  const s = result.shortfall;
  if ((s === null) !== (c.shortfallCents === 0)) {
    breach("shortfall_presence", { shortfall: s, cents: c.shortfallCents });
  }
  if (s) {
    const owed = sum(s.owedTo.map((o) => o.cents));
    if (
      owed !== s.externalShortfallCents ||
      s.externalShortfallCents + s.nettedCents + s.ownClaimsUncoveredCents !== s.cents ||
      s.owedTo.some((o) => o.cents <= 0) ||
      s.nettedCents < 0 ||
      s.ownClaimsUncoveredCents < 0
    ) {
      breach("shortfall_attribution", { shortfall: s });
    }
    for (const o of s.owedTo) {
      const p = result.payees.find((x) => x.payeeId === o.payeeId);
      if (!p || o.cents > balanceOf(p)) {
        breach("shortfall_exceeds_balance", { owed: o, payee: p });
      }
    }
  }
  const uncovered = sum(result.clauses.map((cl) => cl.uncoveredCents));
  if (
    uncovered !== c.shortfallCents ||
    result.clauses.some(
      (cl) =>
        cl.uncoveredCents < 0 ||
        cl.coveredByPoolCents < 0 ||
        (cl.paidBeforeCosts && cl.uncoveredCents !== 0),
    )
  ) {
    breach("coverage_mismatch", { uncovered, shortfall: c.shortfallCents });
  }
  // Mode separation (W4): real payments and projections never mix.
  for (const p of result.payees) {
    const actualSet = p.paidThroughPlatformCents !== null && p.settleDirectlyCents !== null;
    const projectedSet =
      p.projectedPaidPerOrderCents !== null && p.projectedSettleDirectlyCents !== null;
    if (actualSet !== isActual || projectedSet === isActual) {
      breach("mode_mixed", { payee: p, mode: result.revenueMode });
    }
  }
  if (!isActual) {
    const projectedPaid = sum(result.payees.map((p) => p.projectedPaidPerOrderCents ?? 0));
    if (projectedPaid !== w.grossCents) {
      breach("projected_paid_not_gross", { projectedPaid, gross: w.grossCents });
    }
  }
  if (c.settleDirectlyNetCents !== c.expectedSettleDirectlyNetCents) {
    breach("balances_not_conserved", { ...c });
  }
  // Every position is a named party. A phantom position (a null or empty
  // id) could absorb a one-sided payment and keep the sums above balanced.
  for (const p of result.payees) {
    if (typeof p.payeeId !== "string" || p.payeeId.length === 0) {
      breach("payee_unnamed", { payee: p });
    }
  }
  const directIn = sum(result.payees.map((p) => p.directReceivedCents));
  const directOut = sum(result.payees.map((p) => p.directPaidCents));
  if (directIn !== directOut) {
    breach("direct_payments_not_conserved", { directIn, directOut });
  }
  for (const clause of result.clauses) {
    if (clause.entitlementCents < 0) breach("clause_negative", { clause });
    // W1: a cap only ever LOWERS the remainder payee's own per-order clause.
    if (
      clause.cappedFromCents !== null &&
      (clause.cappedFromCents <= clause.entitlementCents ||
        clause.payeeId !== result.remainder.payeeId ||
        clause.stage1 !== "PAID_PER_ORDER")
    ) {
      breach("cap_not_a_reduction", { clause });
    }
    if (clause.how.kind === "FIXED") continue;
    const expectedBasis =
      clause.how.percentOf.basis === "NET_POOL" ? w.netPoolCents : w.grossCents;
    if (clause.how.percentOf.basisCents !== expectedBasis) {
      breach("percent_basis_mismatch", { clause });
    }
  }
  assertSafeIntegers(result, breach);
}

/**
 * The identities a sheet frozen by ANY engine version must still satisfy
 * (P4b review W5). A settled sheet is read from its frozen copy, never
 * recomputed; a newer engine's full invariant set may test fields an older
 * engine never wrote (`cappedFromCents` arrived in v4), so an older copy is
 * held only to what every version has promised since v2, using only fields
 * every version has written:
 *   - Σ payee entitlements = the gross (the deal distributes exactly the
 *     ticket money);
 *   - ACTUAL: Σ balances to settle directly = gross + Σ entered off-platform
 *     − Σ paid through the platform − Σ off-platform held;
 *   - every number is a safe integer.
 * The current version's copies get the full set ({@link
 * assertDealSettlementInvariants}).
 */
export function assertFrozenSheetIdentities(result: DealSettlementResult): void {
  const breach = (invariant: string, details: Record<string, unknown>): never => {
    throw new DealSettlementInvariantError(invariant, details);
  };
  const gross = result.waterfall.grossCents;
  const distributed = sum(result.payees.map((p) => p.entitlementCents));
  if (distributed !== gross) breach("frozen_distribution_not_conserved", { gross, distributed });
  if (result.revenueMode === "ACTUAL") {
    const settle = sum(result.payees.map((p) => p.settleDirectlyCents ?? 0));
    const expected =
      gross +
      result.offPlatform.enteredCents -
      sum(result.payees.map((p) => p.paidThroughPlatformCents ?? 0)) -
      sum(result.payees.map((p) => p.heldOffPlatformCents));
    if (settle !== expected) breach("frozen_balances_not_conserved", { settle, expected });
  }
  assertSafeIntegers(result, breach);
}

function assertSafeIntegers(
  value: unknown,
  breach: (invariant: string, details: Record<string, unknown>) => never,
  path = "result",
): void {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) breach("unsafe_integer", { path, value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertSafeIntegers(item, breach, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assertSafeIntegers(item, breach, `${path}.${key}`);
    }
  }
}
