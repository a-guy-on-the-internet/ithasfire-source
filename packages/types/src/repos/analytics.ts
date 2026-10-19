/**
 * Types for the EventDailyStats and ResalePriceSnapshot analytics models.
 */

// ── EventDailyStats ─────────────────────────────────────────────────────────

export interface TicketTypeStatsEntry {
  ticketTypeId: string;
  name: string;
  sold: number;
  refunded: number;
  capacity: number;
  sellThrough: number;
  revenueCents: number;
}

/**
 * One (event, ticketType) row of REALISED sales, aggregated from the OrderItem
 * snapshot rather than from live TicketType prices.
 *
 * `revenueCents` sums the per-tier LIST PRICE snapshotted at purchase
 * (`OrderItem.unitPriceCents`). It is deliberately NOT `soldCount *
 * priceCents`: the live price is a forward-looking policy number an organizer
 * can edit (and, since the scheduled-price work, one that flips on a timer), so
 * deriving historical revenue from it silently restates the past. Same bug
 * class as the resale face-value defect fixed by FR-001 in
 * docs/specs/2026-08-10/completed/time-based-ticket-pricing.spec.yaml.
 *
 * NOT the cash collected. Order-level `discount` and `platform_credit` lines
 * are excluded because they are not attributable to a tier, so this is
 * gross-of-discount and will EXCEED `Order.amountGrossCents` on a discounted
 * order — a 50%-off $50 ticket reports 5000 against $25 taken. That is the same
 * "list price at purchase" basis Q-004 settled on for resale face value
 * (see `resolve-purchased-unit-price.ts`), kept consistent on purpose.
 *
 * Counts are `qty` sums rather than row counts. Every ticket-line writer emits
 * qty 1 today, but the aggregate should be right by construction.
 */
export interface TicketSalesRollupRow {
  eventId: string;
  /**
   * Null when the tier was deleted: the `OrderItem.ticketTypeId` FK is
   * ON DELETE SET NULL, so its sales survive with no tier to name. Callers
   * must fold these into event totals rather than drop them.
   */
  ticketTypeId: string | null;
  /** Ticket lines not refunded (`active` + `transferred`). */
  soldCount: number;
  /** Ticket lines refunded. DISJOINT from `soldCount`. */
  refundedCount: number;
  /**
   * Sum over the `soldCount` lines only. Because the two sets are disjoint,
   * this is revenue NET of refunds — add `refundedCents` for a gross figure.
   */
  revenueCents: number;
  /**
   * Sum over the `refundedCount` lines. This is refunded FACE VALUE, not cash
   * returned: an actual refund is `buyerPaid + taxShare - stripeFeeShare`
   * (`quote-item-refund.ts`), which withholds the processing fee and includes
   * tax. Correct as a per-tier ledger figure; wrong if read as cash out.
   */
  refundedCents: number;
}

export interface EventDailyStatsRecord {
  id: string;
  eventId: string;
  date: Date;

  grossRevenueCents: number;
  netRevenueCents: number;
  refundedCents: number;

  ticketsSold: number;
  ticketsRefunded: number;
  ticketsTransferred: number;
  totalCapacity: number;
  sellThroughRate: number;

  orderCount: number;
  refundCount: number;

  ticketTypeStats: TicketTypeStatsEntry[];

  waitlistCount: number;

  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertEventDailyStatsInput {
  eventId: string;
  date: Date;

  grossRevenueCents: number;
  netRevenueCents: number;
  refundedCents: number;

  ticketsSold: number;
  ticketsRefunded: number;
  ticketsTransferred: number;
  totalCapacity: number;
  sellThroughRate: number;

  orderCount: number;
  refundCount: number;

  ticketTypeStats: TicketTypeStatsEntry[];

  waitlistCount: number;
}

// ── ResalePriceSnapshot ─────────────────────────────────────────────────────

export type DemandTier = "low" | "medium" | "high";
export type SnapshotSource = "heuristic" | "data";

export interface ResalePriceSnapshotRecord {
  id: string;
  eventId: string;
  ticketTypeId: string;
  date: Date;

  /**
   * The suggested ask for a ticket of this type, NOT clamped to the resale
   * cap (rows written before 2026-10-10 were clamped to the type's cap). The
   * cap is per ticket, and this row has none: a reader must clamp with
   * `effectiveResaleCapCents` (core `lib/pricing/effective-resale-cap`) for
   * the ticket it is showing, never show this number bare.
   */
  suggestedPriceCents: number;
  facePriceCents: number;
  /** The ticket TYPE's own cap when the row was written, as context. */
  resaleCapCents: number | null;

  demandTier: DemandTier;
  sellThroughRate: number;
  sampleSize: number;

  source: SnapshotSource;

  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertResalePriceSnapshotInput {
  eventId: string;
  ticketTypeId: string;
  date: Date;

  suggestedPriceCents: number;
  facePriceCents: number;
  resaleCapCents: number | null;

  demandTier: DemandTier;
  sellThroughRate: number;
  sampleSize: number;

  source: SnapshotSource;
}

// ── Platform-wide aggregate stats ─────────────────────────────────────────

/**
 * The `/platform/overview` headline counters.
 *
 * CURRENCY CAVEAT: `totalGrossRevenueCents` and `totalPlatformFeesCents` are
 * summed ACROSS currencies, which every other money aggregate in this
 * codebase refuses to do. They are kept that way only because the overview
 * page renders one number today and the platform is effectively
 * single-currency. Anything that needs a defensible revenue figure reads
 * {@link PlatformRevenueByCurrency} instead — one row per currency, from the
 * same status set.
 */
export interface PlatformStatsResult {
  totalOrders: number;
  totalSucceededOrders: number;
  totalGrossRevenueCents: number;
  totalPlatformFeesCents: number;
  totalEvents: number;
  totalTicketsSold: number;
  totalHumans: number;
  totalOrganizations: number;
}

/**
 * One currency's worth of what the platform PROCESSED and what it CHARGED.
 *
 * THE STATUS SET is `SUCCEEDED, PART_REFUNDED, REFUNDED, DISPUTED` — every
 * status in which money was actually captured. Filtering to `SUCCEEDED`
 * alone (the original `getPlatformStats` bug) drops an order the moment one
 * ticket on it is refunded and takes its ENTIRE platform fee with it, even
 * though the fee was charged. `CANCELLED`, `PENDING` and `PROCESSING` stay
 * out: none of them represents captured money.
 *
 * GROSS, ALL TIME, NO REFUND NETTING — the same basis, and the same reasons,
 * as `CollectedTaxTotal`. Nothing here is net of anything.
 */
export interface PlatformRevenueByCurrency {
  /** Lowercase ISO-4217. */
  currency: string;
  /**
   * Σ `Order.amountGrossCents` — the ticket money that moved through the
   * platform. NOT platform income: the overwhelming majority of it is owed
   * to organisers and is paid out.
   */
  ticketVolumeCents: number;
  /**
   * Σ `Order.feesPlatformCents` — the platform fee RECORDED at checkout.
   *
   * NOT a ceiling on what the platform kept, and not a floor either. What
   * the figure means depends on `feeMode`:
   *
   *   * ABSORB — the organiser bore it: it came out of their basis, and the
   *     buyer paid the ticket price alone.
   *   * PASS_THROUGH — the buyer paid it ON TOP of the ticket price. Whether
   *     it ALSO came out of the organiser's basis depends on the credit rule
   *     the order was sold under, recorded in
   *     `feePolicySnapshot.organiserCredit` and read by
   *     `computeAgreementBasis`:
   *       - stamped `FULL_PRICE` (every sale since the 2026-10-11 change) —
   *         the organiser was credited the full ticket price, so the platform
   *         kept this figure ONCE: gross 7500, fee 50, organiser credited
   *         7500, platform kept 50.
   *       - no stamp (sold before that change) — the basis was `gross −
   *         feesPlatformCents` as well, so the platform kept UP TO twice the
   *         recorded figure — verified on a dev order: gross 7500, fee 50,
   *         organiser credited 7450, buyer charged 7550, platform kept 100.
   *
   * The two-unit take was NOT intended (owner ruling 2026-10-11,
   * `docs/specs/2026-10-11/platform-fee-charged-once.spec.yaml`): the fee is
   * taken once per paid ticket. Unstamped orders keep the amounts they were
   * credited, so this aggregate reports both populations as they were sold.
   *
   * `this + platformFeesPassThroughCents` is an UPPER BOUND on what was
   * retained, never an identity (a stamped order kept one unit, and the cap
   * bites on an unstamped order in BOTH modes). The single
   * authoritative account of why lives in
   * `packages/core/src/use-cases/platform/get-platform-revenue.ts` — read its
   * header before deriving anything from these columns. Label this one
   * "charged", never "earned".
   */
  platformFeesChargedCents: number;
  /**
   * `platformFeesChargedCents` split by the order's recorded
   * `feePolicySnapshot.feeMode`. The three always sum to the total; the
   * `Unknown` bucket holds orders whose snapshot has no recognisable mode
   * (missing key, legacy shape) and is reported rather than folded into
   * either real mode.
   */
  platformFeesPassThroughCents: number;
  platformFeesAbsorbCents: number;
  platformFeesUnknownModeCents: number;
  /**
   * Σ `Order.taxAmountCents` — A LIABILITY, NOT REVENUE. The platform is
   * merchant of record and remits this; it is excluded from the settlement
   * basis entirely and counted as a liability by `check-platform-solvency`.
   * Never add it into a revenue total.
   */
  taxCollectedCents: number;
  orderCount: number;
  /**
   * Σ `Order.processorFeeCents` over the orders ALREADY stamped by the
   * backfill sweep. PARTIAL until `processorFeeMeasuredCount` equals
   * `processorFeeEligibleCount`: NULLs contribute nothing, so this
   * understates cost and would overstate any net computed from it.
   */
  processorFeeCents: number;
  /** Orders in this currency with a measured processor fee. */
  processorFeeMeasuredCount: number;
  /**
   * Orders that COULD carry one — i.e. that have a Stripe payment intent to
   * read a balance transaction from. An order without one is not missing
   * data and must not count against coverage.
   */
  processorFeeEligibleCount: number;
  /**
   * Of the eligible-but-unmeasured orders, how many the sweep has PARKED:
   * `processorFeeReadFailures >= PROCESSOR_FEE_MAX_READ_FAILURES` with the
   * fee still NULL. These will NEVER be read without a manual reset of
   * `Order.processorFeeReadFailures` (set it to 0; the claim query picks
   * the row up on the next run). Always `<= eligible − measured`. Surfaced
   * so a partial-coverage line can say "N of these will not fill on their
   * own" instead of "not read yet" forever.
   */
  processorFeeParkedCount: number;
  /**
   * Σ `OrderItem.refundedPlatformFeeCents` over REFUNDED TICKET ITEMS
   * (`refundedAt IS NOT NULL`, `kind = 'ticket'`) on orders in the status
   * set — the platform fee actually RETURNED to buyers. Stamped at refund
   * execution by the same expression that produced the money
   * (`_shared/refund-platform-fee-share.ts`), which allocates over ticket
   * items only, so non-ticket lines are not in the denominator.
   *
   * PARTIAL until `feesReturnedMeasuredCount` equals
   * `feesReturnedEligibleCount`: refunds issued before the column existed,
   * and the bulk paths that cannot attribute per item, left NULL, which
   * contributes nothing here. A NULL read as 0 would understate what went
   * back and OVERSTATE what the platform kept.
   */
  feesReturnedCents: number;
  /** Refunded ticket items with a stamped fee share. */
  feesReturnedMeasuredCount: number;
  /** Refunded ticket items in total — the coverage denominator. */
  feesReturnedEligibleCount: number;
  /**
   * WHAT THE PLATFORM KEPT, over the ELIGIBLE SUBSET of orders only — the
   * orders where every input to the net is actually known. Integer cents,
   * SIGNED: a currency whose eligible orders were mostly refunded, or whose
   * buyers paid with platform-funded credit, legitimately nets NEGATIVE.
   *
   * Per eligible order:
   *
   *   + LEAST(feesPlatformCents, amountGrossCents)  -- basis-side unit, capped; UNSTAMPED only
   *   + feesPlatformCents                           -- buyer-side unit, PASS_THROUGH only
   *   − processorFeeCents                           -- ABSORB only
   *   − LEAST(Σ refundedPlatformFeeCents,
   *           LEAST(feesPlatformCents, amountGrossCents))  -- basis-side give-back, capped; UNSTAMPED only
   *   − Σ refundedPlatformFeeCents                  -- buyer-side give-back, PASS_THROUGH only
   *   − Σ live UserCreditRedemption.amountCents
   *
   * "UNSTAMPED only": both basis-side terms are 0 on an order whose
   * `feePolicySnapshot.organiserCredit` is `FULL_PRICE`. That order credited
   * the organiser the full price, so a PASS_THROUGH one nets the fee once
   * (`fee − Σ returned − credit`) where an unstamped one nets it twice.
   *
   * ELIGIBILITY (all eleven): the order records a `feeMode` of
   * `PASS_THROUGH` or `ABSORB`; it was never disputed (`disputeStatus` is
   * NULL, the column the dispute lifecycle writes, and its status is not
   * `DISPUTED`); under `ABSORB` its processor
   * fee is stamped or it never had a payment intent; every refunded TICKET
   * item on it carries a stamped fee share; it is not an `ABSORB` order with
   * a refund (a refund returns the processor fee to the platform and nothing
   * records how much); it is not a refunded order that spent live credit
   * (the refund recovered the credit's cost); its `source` is not `RESALE`
   * (resale records `feesPlatformCents: 0` — the cut is an `OrderSplit`
   * line — so it would net a confident, fully-covered 0); it is not a
   * PARTIAL refund on an UNSTAMPED order where the basis cap bites (the cap
   * clamps the aggregate give-back, which is exact only on a full refund; a
   * `FULL_PRICE` order has no basis-side term to cap); it is not a PARTIAL
   * refund on a `FULL_PRICE` order that carries a discount (an `OrderItem`
   * of kind `discount`: the buyer's refund is split by what each ticket's
   * buyer paid and the organiser's debit by face, so the platform's loss on
   * one ticket is not that ticket's stamped fee; a full refund is exact and
   * stays in), nor one whose `OrderSplit` rows do not sum to the ticket
   * faces or attribute to some ticket with a rounded cent (each payee's
   * split is attributed by face on its own, so a split × face that does not
   * divide by the face sum can leave a ticket debited cents off its face);
   * it is not a PARTIAL refund on an UNSTAMPED order whose
   * ticket items do not all share one face and one recorded per-ticket fee
   * summing to the order fee, that carries a discount, or whose
   * `OrderSplit` rows do not sum to the faces less the fee with every payee's
   * split divisible by the ticket count (the organiser's credit is debited
   * by face, per payee, with each payee's leftover cent on the last ticket;
   * the stamp is the ticket's own fee, so two stamps are not what one
   * ticket cost unless every share comes out even; a full refund is exact
   * and stays in); and it is not an order a Stripe-side partial refund
   * paid back without refunding a ticket item (an `AuditLog` row
   * `stripe_partial_refund_reconciled` and no refunded ticket item: the
   * buyer has money back and nothing on the items says so). "Partial" is
   * counted in ticket items, never read off the stamps. Anything else is
   * EXCLUDED from both this sum and
   * `netKeptEligibleCount` — never defaulted, never estimated.
   *
   * NOT all-time platform profit. Read it only against its coverage
   * (`netKeptEligibleCount` of `orderCount`). The Connect account fee is a
   * separate line by construction (it is per PayoutItem, not per order) and
   * is NOT subtracted here; tax is excluded entirely (a liability). The
   * single authoritative account lives in
   * `packages/core/src/use-cases/platform/get-platform-revenue.ts`.
   */
  netKeptCents: number;
  /**
   * Orders in this currency that met all eleven eligibility conditions — the
   * NUMERATOR of the net's coverage. `orderCount` is the denominator. Equal
   * means the net covers every counted order; below it, the net is a real
   * figure over a subset and must be labelled as one.
   */
  netKeptEligibleCount: number;
}

// ── Org-level dashboard summary ───────────────────────────────────────────

export interface OrgDashboardSummary {
  /** Sum of grossRevenueCents across latest daily stats for all org events. */
  totalGrossRevenueCents: number;
  /** Sum of netRevenueCents across latest daily stats for all org events. */
  totalNetRevenueCents: number;
  /** Total tickets sold across all org events. */
  totalTicketsSold: number;
  /** Weighted average sell-through rate (0-1). */
  averageSellThroughRate: number;
  /** Sum of refundedCents across latest daily stats for all org events. */
  totalRefundedCents: number;
  /** Refund rate as fraction (0-1): refundedCents / grossRevenueCents. */
  refundRate: number;
  /** Number of events owned by this org. */
  eventCount: number;
}
