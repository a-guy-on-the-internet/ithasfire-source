/**
 * Deal terms — the clause model behind `computeDealSettlement`.
 *
 * Mirrors deal-terms-and-settlement.spec.yaml FR-001 field-for-field so the
 * P4b schema (PayoutTermsLine extensions + PayoutTermsDeduction) maps onto
 * these types 1:1. Pure types and Zod schemas; no I/O.
 *
 * ── Percent representation ────────────────────────────────────────────────
 * WHOLE PERCENT, integer 0..100 — the same unit as the existing
 * `PayoutTermsLine.percent Int` column the clause extends. Basis points would
 * be finer, but a clause percent that the stored column cannot hold (12.5%)
 * would be a second unit for the same field. If finer percentages are ever
 * needed, migrate the column and this schema together.
 *
 * ── What a percent is OF (NFR-003) ────────────────────────────────────────
 * Every percent carries a `basis`:
 *  - GROSS    — ticket money only (M8): Σ order basis (order gross minus the
 *               platform fee), net of refunds — the number per-order payouts
 *               divide. Off-platform money (door cash, a bar share) is NEVER
 *               in it.
 *  - NET_POOL — the pool: the gross minus everything recouped off the top.
 *               Never below $0.
 * A deduction given as a percent is always a percent of the gross.
 *
 * ── Legacy terms ──────────────────────────────────────────────────────────
 * PayoutTerms rows written before P4b have no remainder holder: their
 * PERCENT lines sum to 100% and `distributeRemainder` spreads the odd cents
 * round-robin. The mapping rule is `resolveDealRemainder`
 * (use-cases/deals/_shared/deal-from-storage.ts): the event's organiser, else
 * the agreement's editor side, else the largest per-order line — derived at
 * read time and labelled, never stored by a read, because the remainder payee
 * is who owes every shortfall.
 */
import { z } from "zod";

import { fail } from "../errors";

/** Largest single money amount the calculator accepts: $10,000,000,000.00. */
export const MAX_DEAL_AMOUNT_CENTS = 1_000_000_000_000;
/** Largest ticket count a projection accepts per tier. */
export const MAX_PROJECTED_TICKETS = 10_000_000;
/** Bound on every list in terms and inputs. Keeps every sum a safe integer. */
export const MAX_DEAL_ITEMS = 100;

export const DEAL_CLAUSE_AMOUNT_TYPES = [
  "FIXED",
  "PERCENT",
  "FIXED_AND_PERCENT",
] as const;
export type DealClauseAmountType = (typeof DEAL_CLAUSE_AMOUNT_TYPES)[number];

export const DEAL_BASIS_KINDS = ["GROSS", "NET_POOL"] as const;
export type DealBasisKind = (typeof DEAL_BASIS_KINDS)[number];

export const DEAL_CLAUSE_RESOLUTIONS = ["SUM", "GREATER_OF"] as const;
export type DealClauseResolution = (typeof DEAL_CLAUSE_RESOLUTIONS)[number];

/**
 * Costs off the top. DEPOSIT_PAID is deliberately NOT here (M10): a deposit
 * is money that already changed hands — a `directPayments` input — and
 * never changes the split.
 */
export const DEAL_DEDUCTION_KINDS = ["RENTAL", "EXPENSE", "HOUSE_NUT"] as const;
export type DealDeductionKind = (typeof DEAL_DEDUCTION_KINDS)[number];

export const OFF_PLATFORM_AMOUNT_KINDS = [
  "DOOR_CASH",
  "BAR_SHARE",
  "OTHER",
] as const;
export type OffPlatformAmountKind = (typeof OFF_PLATFORM_AMOUNT_KINDS)[number];

const idSchema = z.string().min(1).max(200);
const labelSchema = z.string().min(1).max(200);
export const dealCentsSchema = z
  .number()
  .int()
  .nonnegative()
  .max(MAX_DEAL_AMOUNT_CENTS);
export const dealPercentSchema = z.number().int().min(0).max(100);

/**
 * One payee clause (a `PayoutTermsLine` in P4b).
 *
 * Shape rules — enforced by {@link assertDealTermsShape}, and the SQL CHECKs
 * P4b writes must say the same thing:
 *  - FIXED:             amountCents > 0; percent and resolution null.
 *  - PERCENT:           percent 0..100; amountCents and resolution null.
 *  - FIXED_AND_PERCENT: amountCents > 0, percent 1..100, resolution set.
 * `basis` is carried on every clause (the column has a default) and is read
 * only for the percent part; on a FIXED clause it is inert.
 */
export const dealClauseSchema = z
  .object({
    id: idSchema,
    payeeId: idSchema,
    amountType: z.enum(DEAL_CLAUSE_AMOUNT_TYPES),
    amountCents: dealCentsSchema.nullish(),
    percent: dealPercentSchema.nullish(),
    basis: z.enum(DEAL_BASIS_KINDS),
    resolution: z.enum(DEAL_CLAUSE_RESOLUTIONS).nullish(),
    displayLabel: z.string().max(200).nullish(),
  })
  .strict();
export type DealClause = z.infer<typeof dealClauseSchema>;

/**
 * One cost off the top (a `PayoutTermsDeduction` in P4b). The ARRAY ORDER is
 * the waterfall order — callers sort by the stored sort key before calling.
 *
 * Exactly one of `amountCents` / `percent` (percent of the gross).
 * `creditedPayeeId` is REQUIRED: whatever is recouped is paid back to
 * whoever fronted it, and money recouped to nobody would leave the pool
 * without landing anywhere — conservation cannot hold. (08-07 §6.2: an
 * unattributed expense silently enriches the remainder holder.)
 *
 * `estimated` = the amount is a guess until an actual is entered after the
 * show. A non-estimated deduction (an agreed rental) takes no actual.
 */
export const dealDeductionSchema = z
  .object({
    id: idSchema,
    kind: z.enum(DEAL_DEDUCTION_KINDS),
    label: labelSchema,
    amountCents: dealCentsSchema.nullish(),
    percent: dealPercentSchema.nullish(),
    creditedPayeeId: idSchema,
    estimated: z.boolean(),
  })
  .strict();
export type DealDeduction = z.infer<typeof dealDeductionSchema>;

/**
 * The whole deal. `remainderPayeeId` is the party the leftover pool falls to
 * — and therefore the party who owes any shortfall (FR-002, M7). Exactly one,
 * by construction: a terms-level field, not a per-clause flag, so "no
 * remainder holder" and "two remainder holders" are unrepresentable.
 */
export const dealTermsSchema = z
  .object({
    clauses: z.array(dealClauseSchema).max(MAX_DEAL_ITEMS),
    deductions: z.array(dealDeductionSchema).max(MAX_DEAL_ITEMS),
    remainderPayeeId: idSchema,
  })
  .strict();
export type DealTerms = z.infer<typeof dealTermsSchema>;
export type DealTermsInput = z.input<typeof dealTermsSchema>;

/**
 * Ticket revenue basis. "Basis" means the same per-order number
 * `computeAgreementBasis` hands `computeOrderSplits` — the order's ticket
 * money in full (on an order sold before the 2026-10-11 ruling, minus the
 * platform fee) — summed over the event's ticket orders, net of refunds. For
 * a projection, `unitBasisCents` is that number per ticket: the ticket's
 * price, since the buyer pays the fee on top.
 */
export const dealTicketRevenueSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("PROJECTED"),
      tiers: z
        .array(
          z
            .object({
              tickets: z.number().int().nonnegative().max(MAX_PROJECTED_TICKETS),
              unitBasisCents: dealCentsSchema,
            })
            .strict(),
        )
        .min(1)
        .max(MAX_DEAL_ITEMS),
    })
    .strict(),
  z
    .object({
      mode: z.literal("ACTUAL"),
      basisCents: dealCentsSchema,
      /**
       * How many orders (and refunds) make up `basisCents` — enables the
       * per-order plausibility check (W3). Each one can move a per-order
       * line's payout by under a cent from its exact share. Optional: absent
       * means the check is not run (reported as null, never as "plausible").
       */
      orderCount: z.number().int().nonnegative().max(MAX_PROJECTED_TICKETS).optional(),
    })
    .strict(),
]);
export type DealTicketRevenue = z.infer<typeof dealTicketRevenueSchema>;

export const dealSettlementInputsSchema = z
  .object({
    ticketRevenue: dealTicketRevenueSchema,
    /**
     * Money the platform never sees (M4). `amountCents` null/absent = "Not
     * entered" — excluded from every total, flagged, never read as $0.
     *
     * M8: listed, never split by any percentage, never in the waterfall. It
     * changes who already holds money: `heldByPayeeId` has it in hand (the
     * door cash box), so their balance goes down by it.
     *
     * M11: it belongs to `ownerPayeeId` when the person entering the row names
     * one ("Bar share — belongs to Lowlight Collective"); null or absent means
     * the remainder payee, the party money the deal doesn't allocate falls to.
     * Both `heldByPayeeId` and a named owner must be participants of the
     * TERMS ({@link dealParticipantIds}): a row cannot make a stranger a party
     * to the sheet. Either way every cent has a counterparty and the balances
     * still net out.
     */
    offPlatform: z
      .array(
        z
          .object({
            id: idSchema,
            kind: z.enum(OFF_PLATFORM_AMOUNT_KINDS),
            label: labelSchema,
            amountCents: dealCentsSchema.nullish(),
            heldByPayeeId: idSchema,
            ownerPayeeId: idSchema.nullish(),
          })
          .strict(),
      )
      .max(MAX_DEAL_ITEMS)
      .default([]),
    /** Entered actuals for ESTIMATED deductions, keyed by deduction id. */
    deductionActuals: z
      .array(
        z.object({ deductionId: idSchema, amountCents: dealCentsSchema }).strict(),
      )
      .max(MAX_DEAL_ITEMS)
      .default([]),
    /**
     * What the platform has already paid each payee for this event, PER
     * PAYEE — the grain `OrderSplit` is stored at (unique per order+payee),
     * so a per-clause figure does not exist to be passed.
     *
     * SOURCING RULE (for P4b): per payee, Σ PAYOUT credits − Σ REFUND_DEBIT
     * over EXACTLY the order set `basisCents` sums, counting only splits made
     * from PERCENT/GROSS lines. Nothing else — no manual ledger entries, no
     * other events sharing a Settlement row (resolve via orderId → eventId,
     * never Settlement.eventId).
     *
     * ACTUAL mode only. In PROJECTED mode this input is REFUSED: nothing has
     * been paid in a projection, and the output's `projectedPaidPerOrderCents`
     * says what the platform will pay. ACTUAL mode requires an entry for the
     * remainder payee and for every non-remainder payee holding a per-order
     * clause (0 is fine; missing is refused), refuses any payee who is not a
     * participant, and refuses a total above `basisCents` (the per-order
     * engine distributes at most the basis).
     *
     * Stage-1 per-order rule this assumes: per order, the platform pays each
     * non-remainder payee its PERCENT/GROSS clauses and the remainder payee
     * the rest of the order's basis.
     *
     * M9, ACTUAL mode: a non-remainder payee's per-order (PAID_PER_ORDER)
     * clauses are entitled to exactly what this says they were paid. In stage
     * 1 the per-order engine pays nothing else to a non-remainder payee, so
     * the whole amount is attributed to those clauses (largest remainder
     * across them, pro rata to their exact percentage, when there are
     * several) and their direct clauses stay separable. An entry is REQUIRED
     * for every such payee in ACTUAL mode — a missing one would otherwise
     * read as $0 paid. Pass 0 when nothing was paid.
     */
    paidThroughPlatform: z
      .array(
        z.object({ payeeId: idSchema, amountCents: dealCentsSchema }).strict(),
      )
      .max(MAX_DEAL_ITEMS)
      .default([]),
    /**
     * LEDGER-ONLY payees (P4b review W1), ACTUAL mode only: payees the
     * platform paid per order under lines the terms no longer have — a split
     * edited after tickets sold. They are named here EXPLICITLY, never
     * inferred from `paidThroughPlatform`: each becomes a participant with no
     * clause, entitled to exactly what it was paid (M9), so it nets to $0 and
     * the sheet stays readable and balanced. Each must have a
     * `paidThroughPlatform` figure and must NOT be a participant of the terms
     * (then it is not ledger-only). Its payment is money paid out per order
     * before any cost, like a per-order clause (M12).
     */
    ledgerOnlyPayeeIds: z.array(idSchema).max(MAX_DEAL_ITEMS).default([]),
    /**
     * Money that already changed hands between two parties (M10: a deposit
     * already paid, promoter → venue). Moves the two balances by the same
     * amount; never the pool or the split. BOTH sides are required and must
     * be participants in the deal ({@link dealParticipantIds}: clause payees,
     * the remainder payee, credited parties) — a payment with a missing side
     * would leave money owed to nobody.
     */
    directPayments: z
      .array(
        z
          .object({
            id: idSchema,
            label: labelSchema,
            fromPayeeId: idSchema,
            toPayeeId: idSchema,
            amountCents: dealCentsSchema.min(1),
          })
          .strict(),
      )
      .max(MAX_DEAL_ITEMS)
      .default([]),
  })
  .strict();
export type DealSettlementInputs = z.infer<typeof dealSettlementInputsSchema>;
export type DealSettlementInputsInput = z.input<
  typeof dealSettlementInputsSchema
>;

/**
 * Semantic checks the Zod shape can't express. Throws `invalid_input` with a
 * specific message. Over-100% percentages are REFUSED, not clamped: clamping
 * would silently rewrite agreed terms (the floorCents lesson, 08-07 §2).
 */
export function assertDealTermsShape(terms: DealTerms): void {
  assertUniqueIds(
    terms.clauses.map((c) => c.id),
    "deal_duplicate_clause_id",
  );
  assertUniqueIds(
    terms.deductions.map((d) => d.id),
    "deal_duplicate_deduction_id",
  );

  let percentTotal = 0;
  let perOrderPercentTotal = 0;
  for (const clause of terms.clauses) {
    const hasAmount = clause.amountCents !== null && clause.amountCents !== undefined;
    const hasPercent = clause.percent !== null && clause.percent !== undefined;
    const hasResolution =
      clause.resolution !== null && clause.resolution !== undefined;
    switch (clause.amountType) {
      case "FIXED":
        if (!hasAmount || (clause.amountCents ?? 0) <= 0 || hasPercent || hasResolution) {
          fail("invalid_input", "deal_clause_fixed_shape");
        }
        break;
      case "PERCENT":
        if (!hasPercent || hasAmount || hasResolution) {
          fail("invalid_input", "deal_clause_percent_shape");
        }
        break;
      case "FIXED_AND_PERCENT":
        if (
          !hasAmount ||
          (clause.amountCents ?? 0) <= 0 ||
          !hasPercent ||
          (clause.percent ?? 0) <= 0 ||
          !hasResolution
        ) {
          fail("invalid_input", "deal_clause_fixed_and_percent_shape");
        }
        break;
    }
    const perOrder = classifyClauseForStage1(clause) === "PAID_PER_ORDER";
    if (perOrder) perOrderPercentTotal += clause.percent ?? 0;
    // The remainder payee's OWN per-order clauses are left out of the claim
    // total: W1 caps them at what the pool leaves after every other claim,
    // so they can never put the remainder holder in shortfall. That is the
    // stored shape of every deal (P4b): the remainder is paid "the rest" per
    // order by a PERCENT/GROSS line of its own, beside a versus at 70% of the
    // pool — 90% + 70% of different things, not 160% of one.
    if (perOrder && clause.payeeId === terms.remainderPayeeId) continue;
    percentTotal += clause.percent ?? 0;
  }
  // Every other percent part counts, GROSS and NET_POOL alike and a
  // GREATER_OF's percent included (it is what the clause pays when it wins).
  // Over 100 the remainder holder is in shortfall at every gross > 0 — not a
  // deal.
  if (percentTotal > 100) fail("invalid_input", "deal_percent_over_100");
  // The per-order engine divides each order once: its lines, the remainder's
  // own included, can never take more than the whole order.
  if (perOrderPercentTotal > 100) {
    fail("invalid_input", "deal_per_order_percent_over_100");
  }

  for (const deduction of terms.deductions) {
    const hasAmount =
      deduction.amountCents !== null && deduction.amountCents !== undefined;
    const hasPercent =
      deduction.percent !== null && deduction.percent !== undefined;
    if (hasAmount === hasPercent) {
      fail("invalid_input", "deal_deduction_amount_or_percent");
    }
  }
}

function assertUniqueIds(ids: readonly string[], message: string): void {
  if (new Set(ids).size !== ids.length) fail("invalid_input", message);
}

/**
 * Everyone the TERMS make a party to the sheet: the remainder payee, every
 * clause payee and every credited party. Settlement inputs may only name
 * these — as a holder or owner of off-platform money, either side of a
 * direct payment, or a platform payee (W5/W6). Inputs never widen the set:
 * a typed-in row that could add a party would let anyone be put on the sheet.
 */
export function dealParticipantIds(
  terms: Pick<DealTerms, "clauses" | "deductions" | "remainderPayeeId">,
): Set<string> {
  return new Set<string>([
    terms.remainderPayeeId,
    ...terms.clauses.map((c) => c.payeeId),
    ...terms.deductions.map((d) => d.creditedPayeeId),
  ]);
}

// ── Stage 1 classification (FR-005) ────────────────────────────────────────

/**
 * Who pays this clause in stage 1.
 *  - PAID_PER_ORDER: the platform pays it on every order, as today — a
 *    PERCENT clause on the GROSS basis. Exactly the adapter's per-order fence
 *    (`PER_ORDER_PAYOUT_LINE_WHERE`), so the calculator and the engine agree
 *    on which lines the platform paid.
 *  - SETTLED_DIRECTLY: everything else (FIXED, NET_POOL, any
 *    FIXED_AND_PERCENT). Ithas Fire shows the math; the parties settle it.
 *
 * A 0% PERCENT/GROSS clause IS per-order (changed in engine version 4). The
 * per-order engine floors every line and hands the cents it dropped out
 * round-robin to EVERY line, a 0% line included (`distributeRemainder`), so a
 * stored 0% line — a declined payee left at 0, say — can be paid a cent per
 * order. Classed as settled directly it was entitled to $0 while the ledger
 * said the platform paid it, and a legacy deal paid entirely per order showed
 * a few cents to settle instead of $0.00 (M9). Projected, it is $0 as before.
 *
 * The editor label and the calculator's per-clause `stage1` field both come
 * from here, so they cannot disagree.
 */
export type Stage1Settlement = "PAID_PER_ORDER" | "SETTLED_DIRECTLY";

export function classifyClauseForStage1(
  clause: Pick<DealClause, "amountType" | "basis" | "percent">,
): Stage1Settlement {
  return clause.amountType === "PERCENT" && clause.basis === "GROSS"
    ? "PAID_PER_ORDER"
    : "SETTLED_DIRECTLY";
}

/** Costs off the top are never paid per order. */
export function classifyDeductionForStage1(): Stage1Settlement {
  return "SETTLED_DIRECTLY";
}
