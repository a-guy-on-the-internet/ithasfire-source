import { z } from "zod";

import { fail } from "@th/errors";
import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type {
  PayeeLedgerEntryRecord,
  PayeeLedgerUpcomingMaturity,
} from "@th/ports/repos/payee-ledger";
import type { OrderEventAttribution } from "@th/types/repos/orders";

import { parseInput } from "../../lib/io";
import {
  applyDebtNetting,
  normaliseLedgerCurrency,
  payeeCurrencyCellKey,
  type NettedMaturityRow,
} from "./_shared/maturity-netting";
import {
  nextPayoutRunFor,
  nextPayoutRunSchema,
} from "./_shared/next-payout-batch-run";
import { PAYOUT_BATCH_CYCLE_MS } from "./_shared/payout-batch-cycle";
import {
  belowPayoutMinimum,
  readPayoutMinimum,
  type PayoutMinimum,
} from "./_shared/payout-minimum";
import { trancheAttributionOptions } from "./_shared/tranche-attribution";

// ─────────────────────────────────────────────────────────────────────────────
// getOrgPayoutOverview — everything the organiser's payouts SPINE needs, in
// one call: money coming, today, money already sent.
//
// THE SAME STAFF READS, NARROWED TO ONE PAYEE. Not a second implementation of
// payout arithmetic — that is the whole design constraint. Every number here
// comes from the very methods `/platform/settlements` reads:
//
//   * `payeeLedger.getBalance`            → what is owed, matured or not
//   * `payeeLedger.listPayableBalances`   → what tonight's batch could send
//   * `payeeLedger.listUpcomingMaturities`→ WHEN the rest becomes payable
//   * `payouts/_shared/maturity-netting`  → the debt walk, shared verbatim
//     with `platform/list-upcoming-payouts.ts`
//   * `payeeLedger.listEntries` via `trancheAttributionOptions` → the credit
//     rows behind ONE tranche
//   * `payoutItems.listHistory({ payeeIds })` → what has actually been sent
//
// TWO NUMBERS, NEVER ONE — inherited from `list-payable-positions.ts` and
// `get-payee-statement.ts`, and the thing this file most exists to protect:
//
//   * `payableCents` — MATURED and unblocked. What tonight's batch would
//     plan from. SIGNED: a negative is carried-forward debt, reported as
//     such, never clamped to zero here.
//   * `balanceCents` — EVERYTHING owed, matured or not. A credit for an event
//     three weeks out is absent from the first and present in the second, and
//     it is the organiser's money either way.
//
// They are never summed, never merged, and neither is derived from the other.
// `balanceCents` is ALSO NOT `payableCents + Σ upcoming`: payouts and debits
// move the balance and never appear in the maturity feed.
//
// `expectedCents` IS NOT A PROMISE. It forecasts MATURITY net of today's
// debt, not PAYMENT. Between it and money landing, `runPayoutBatch` still
// applies the payout MINIMUM (§2), the per-run PAYEE CAP, the ELIGIBILITY
// checks (§3) and transfer-time WITHHOLDING, and a refund landing before the
// date shrinks the tranche. Every consumer must label it that way.
//
// OF THOSE FOUR GATES, EXACTLY ONE IS EVALUABLE HERE, and it is the one the
// support queue is actually about: the payout MINIMUM
// (`payoutMinimumCents` / `belowMinimum`), ported from `get-payee-statement.ts`
// through `payouts/_shared/payout-minimum.ts`. An organiser sitting on $6 while
// Friday comes and goes is not owed silence — without this block the spine
// shows real money and no reason it did not move. The cap needs a batch
// argument and the eligibility checks need Stripe, so neither is modelled: a
// flag that is wrong on some nights is worse than no flag.
//
// UNKNOWN IS NEVER ZERO. Exactly one read is load-bearing — the rollup
// balance. Without it there is no honest headline, so the use case throws and
// the UI retries. Everything else degrades with its own explicit flag and a
// NULL figure rather than a clean number that might be wrong:
//
//   `payableResolved`      the payable read (also the debt walk's input)
//   `upcomingResolved`     the maturity feed
//   `minimumResolved`      the GLOBAL fee policy behind the payout minimum
//   `attributionResolved`  order → event naming for the tranche sub-lines
//   `historyResolved`      the recent-payouts read
//   per-tranche `linesResolved`   that tranche's credit-row read
//
// WHAT GOES BLANK IS THE VERDICT, NOT THE DATA. Every one of those flags
// withholds a CONCLUSION and keeps the gross: `debtResolved` (via
// `expectedCents`) withholds the net and keeps `creditCents`; `minimumResolved`
// withholds `belowMinimum` and keeps `balanceCents` and `payableCents`. The
// money is known in every degraded state; only what we make of it is not.
//
// Every swallow logs at ERROR *and* calls the guarded `deps.reportError?.()`
// (CLAUDE.md ReporterPort convention — `logger.warn` is not captured). A
// throwing reporter can never change the result.
//
// NO PAYEE IS A NORMAL STATE. An org that has never onboarded to Stripe has
// no `Payee` row at all — the overwhelmingly common state for a new org. That
// returns an honest EMPTY overview (`payeeId: null`, every figure 0, every
// list empty, every `*Resolved` TRUE because nothing was read and nothing
// failed), never an error and never zeros dressed as facts. The ONE exception
// is `minimumResolved`, which reports a read that really was issued: the
// policy is fetched before the payee lookup so a brand-new org can still be
// told the threshold, and it carries its own outcome rather than a blanket
// true.
//
// ONE CURRENCY, AND IT SAYS SO. Every headline figure is in the payee's
// `defaultCurrency`, following `get-payee-statement.ts`, so nothing on the
// page can mix two currencies into one number. A payee holding cells in
// ANOTHER currency is not silently dropped: those currencies are listed in
// `otherCurrencies`, and a non-empty array means this overview is not the
// whole picture and the UI must say so. Payout HISTORY rows are exempt — each
// carries its own `currency` and is never summed, so filtering them would
// hide real payouts for no gain.
//
// Roles: `canFinanceOrg`, enforced HERE (the precedent is
// `get-payee-statement.ts` and `orders.getOwnerPayoutSummary`), matching how
// the platform siblings enforce their staff check in the use case rather than
// the transport.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Budget for every ledger read behind this view. Past this the adapter
 * surfaces SERVICE_UNAVAILABLE and the UI renders an inline "timed out — try
 * again" instead of hanging an interactive admin page. Same 8s as the staff
 * siblings (`UPCOMING_PAYOUTS_STATEMENT_TIMEOUT_MS`), for the same reasons.
 *
 * NOTE the port contract: a budgeted read MUST be issued on the TOP-LEVEL
 * repos, never inside `repos.tx(...)`. This use case takes no transaction at
 * all (it writes nothing), so that holds structurally.
 */
export const ORG_PAYOUT_OVERVIEW_TIMEOUT_MS = 8_000;

/**
 * Tranches carried on the spine. The maturity read does not page, so rather
 * than invent a cursor over a non-paging query this view truncates at a
 * documented limit and says so (`upcomingTruncated`).
 *
 * The truncation cannot mislead: `upcomingCreditCents` and
 * `upcomingExpectedCents` are summed over EVERY tranche the ledger returned
 * in this currency, not over the visible ones — the same rule as the staff
 * view's `currencyTotals`.
 */
export const ORG_PAYOUT_OVERVIEW_MAX_TRANCHES = 24;

/**
 * Credit sub-lines listed under ONE tranche. A tranche with more says so
 * (`linesTruncated`), because a truncated list does not sum to the heading
 * above it and the copy has to admit that rather than let a reader add the
 * rows up and find a shortfall.
 */
export const ORG_PAYOUT_OVERVIEW_LINES_PER_TRANCHE = 25;

/** Payouts already sent, newest first, shown inline under the spine. The
 * paged table beneath it is `listOrgPayoutHistory`. */
export const ORG_PAYOUT_OVERVIEW_RECENT_PAYOUTS = 5;

export type GetOrgPayoutOverviewDeps = {
  repos: Pick<
    Repos,
    "payeeLedger" | "payees" | "payoutItems" | "orders" | "feePolicies"
  >;
  authz: Pick<AuthZPort, "canFinanceOrg">;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Reports every best-effort swallow on this view. Guarded at each call site
   * — a throwing or missing reporter never changes the result.
   */
  reportError?: ReporterPort;
};

export const getOrgPayoutOverviewInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    orgId: z.string().uuid(),
  })
  .strict();

export type GetOrgPayoutOverviewInput = z.infer<
  typeof getOrgPayoutOverviewInputSchema
>;

// ── Null semantics, stated once ─────────────────────────────────────────────
// `payableCents` is null iff `payableResolved` is false.
// A tranche's `debtAppliedCents` / `expectedCents` are null iff
// `payableResolved` is false (the debt walk's only input is that read).
// `upcomingCreditCents` / `upcomingTrancheCount` are null iff
// `upcomingResolved` is false; `upcomingExpectedCents` is null iff EITHER is.
// A tranche's `lines` is empty with `linesResolved: false` iff that tranche's
// entry read failed. Nothing is ever zero because it is unknown.
// `payoutMinimumCents` is null iff `minimumResolved` is false.
// `belowMinimum` is null when the VERDICT cannot be reached at all — the
// policy read failed, OR the payable read failed (nothing to measure), OR
// there is no Payee row (nothing to measure it against). It is NEVER false
// for any of those reasons: false means "measured, and it clears". Those are
// TWO different nulls — a degradation and an empty — and the field's own doc
// says how to tell them apart. A consumer must branch, never render the null.
// `payoutOverdue` is null when ANY of its five inputs is unknown — see
// `payoutOverdueVerdict`, which owns the order they are tested in.

export const orgPayoutCreditLineSchema = z
  .object({
    /** `PayeeLedgerEntry.id` — the SETTLEMENT_CREDIT behind this line. */
    entryId: z.string(),
    /** POSITIVE integer cents, as stored. Credits only, so no sign ambiguity. */
    amountCents: z.number().int(),
    currency: z.string(),
    /** The credit's maturity date. Always inside the tranche's window. */
    availableAt: z.date().nullable(),
    createdAt: z.date(),
    /** Null when the credit carries no order (should not happen for credits). */
    orderId: z.string().nullable(),
    /** `Order.shortId`. Null when unknown, unattributed, or not resolved. */
    orderCode: z.string().nullable(),
    /**
     * The show this credit came from. NULL is a real answer — a MEMBERSHIP
     * order has no event, and a deleted event leaves the credit unattributed
     * — and it is ALSO what a failed attribution read yields. Tell them apart
     * with the overview's `attributionResolved`.
     */
    eventId: z.string().nullable(),
    eventTitle: z.string().nullable(),
    /** For `/events/<slug>`. NEVER the uuid — `/events/<uuid>` 404s. */
    eventSlug: z.string().nullable(),
    eventStartsAt: z.date().nullable(),
  })
  .strict();

export type OrgPayoutCreditLine = z.infer<typeof orgPayoutCreditLineSchema>;

export const orgPayoutTrancheSchema = z
  .object({
    /** The credits' `availableAt`. Strictly after `asOf`. */
    maturesAt: z.date(),
    currency: z.string(),
    /** GROSS: Σ unblocked SETTLEMENT_CREDIT cents maturing on that date. */
    creditCents: z.number().int(),
    /**
     * ANNOTATION ONLY. Σ ACTIVE DISPUTE_HOLD cents on the orders behind this
     * tranche, attributed once per order to the order's earliest tranche, as
     * written (unclamped). The hold is ALREADY inside today's payable and
     * reaches this row through `debtAppliedCents`; it is NEVER subtracted
     * here, and the UI must not invite a reader to subtract it either.
     */
    heldCents: z.number().int(),
    /** How many credit rows the tranche total counted. */
    creditCount: z.number().int().nonnegative(),
    /**
     * The part of this payee's carried-forward debt (negative payable today)
     * this tranche is consumed by, soonest tranche first. Null iff
     * `payableResolved` is false.
     */
    debtAppliedCents: z.number().int().nullable(),
    /**
     * `max(0, creditCents − debtAppliedCents)`. NOT A PROMISE — see the file
     * header. Null iff `payableResolved` is false; never a gross figure
     * standing in for a net.
     */
    expectedCents: z.number().int().nullable(),
    /**
     * The credit rows behind THIS tranche and no other, via
     * `trancheAttributionOptions` (half-open `(previous, this]` window).
     * Empty with `linesResolved: false` when the read failed.
     */
    lines: z.array(orgPayoutCreditLineSchema),
    /** False when this tranche's credit-row read failed. `lines` is then empty. */
    linesResolved: z.boolean(),
    /**
     * True when `lines` was cut at `ORG_PAYOUT_OVERVIEW_LINES_PER_TRANCHE`, so
     * the rows do NOT sum to `creditCents` and the copy must say so.
     */
    linesTruncated: z.boolean(),
  })
  .strict();

export type OrgPayoutTranche = z.infer<typeof orgPayoutTrancheSchema>;

export const orgPayoutSentSchema = z
  .object({
    /** `PayoutItem.id`. */
    id: z.string(),
    payoutId: z.string(),
    currency: z.string(),
    /** GROSS — the payable claimed this cycle, before withholding. */
    amountCents: z.number().int(),
    /**
     * The exact cents handed to Stripe, frozen at mint time. NULL = NOT
     * RECORDED (a pre-cutover row), which is not zero: the UI renders "not
     * reported" rather than reporting money that moved as money that did not.
     */
    netCents: z.number().int().nullable(),
    /** Stripe's monthly active-account fee withheld from this transfer. */
    connectAccountFeeCents: z.number().int(),
    /** LEGACY pre-cutover debt recovery; always 0 on modern rows. */
    recoveredDebtCents: z.number().int(),
    /** Rolling-reserve cents withheld from this transfer. */
    reserveHeldCents: z.number().int(),
    /** Matured reserve ADDED back onto this transfer. */
    reserveReleasedCents: z.number().int(),
    status: z.enum(["pending", "transferred", "failed"]),
    /** `transferredAt` when the money moved, else the batch's `scheduledFor`. */
    occurredAt: z.date(),
    transferredAt: z.date().nullable(),
    scheduledFor: z.date(),
    failedAt: z.date().nullable(),
    /** The batch's own reason string, verbatim. Null when it did not fail. */
    failureReason: z.string().nullable(),
    stripeTransferId: z.string().nullable(),
  })
  .strict();

export type OrgPayoutSent = z.infer<typeof orgPayoutSentSchema>;

export const getOrgPayoutOverviewOutputSchema = z
  .object({
    /**
     * Null when the org has NO Payee row — it has never onboarded to Stripe.
     * A legitimate, common state reported as an empty overview, not an error.
     */
    payeeId: z.string().nullable(),
    /** The payee's `defaultCurrency`. Every figure below is in it. */
    currency: z.string(),
    /**
     * Normalised currencies this payee ALSO holds cells in, from the payable
     * and maturity reads. Non-empty means the figures above are not the whole
     * picture and the UI must say so. Never summed with anything.
     */
    otherCurrencies: z.array(z.string()),

    // ── What we owe you: two numbers, never one ───────────────────────────
    /**
     * `PayeeLedgerBalance.ledgerBalanceCents` — everything owed, matured or
     * not. NEVER derived from `payableCents`, and NOT `payableCents` plus the
     * upcoming total.
     */
    balanceCents: z.number().int(),
    /**
     * The MATURED, unblocked cell the batch plans from. SIGNED: a negative is
     * carried-forward debt, reported as such rather than clamped. Null iff
     * `payableResolved` is false.
     */
    payableCents: z.number().int().nullable(),
    /** False when the payable read failed. See the null semantics above. */
    payableResolved: z.boolean(),
    /** Cents held against open disputes. Owed to someone; not yet to anyone. */
    pendingHoldCents: z.number().int(),
    /**
     * Outstanding rolling reserve — DEFERRED payout withheld from past
     * transfers. Never part of `balanceCents` (those cents never entered it),
     * so it is reported alongside and never subtracted.
     */
    reserveCents: z.number().int(),

    // ── Does anything go out tonight? ─────────────────────────────────────
    // Ported from `get-payee-statement.ts` (via
    // `_shared/payout-minimum.ts`), reasoning intact: of the four gates
    // between the payable and money landing, this is the only one evaluable
    // without guessing, and it is the one organisers ask about.
    /**
     * The GLOBAL fee policy's `payoutMinimumCents`, or the batch's own
     * default when NO policy row exists. NULL when the policy READ FAILED —
     * a different thing entirely from "no policy exists", which has a
     * defined answer.
     */
    payoutMinimumCents: z.number().int().nonnegative().nullable(),
    /** False when the fee-policy read failed; `payoutMinimumCents` and
     * `belowMinimum` are then both null. The balance and the payable above
     * are UNAFFECTED — one line went blank, not the page. */
    minimumResolved: z.boolean(),
    /**
     * `payableCents` — THE PAYABLE IN `currency`, and only that — is below
     * the batch's minimum, so tonight's run leaves THIS CELL where it is and
     * carries it forward (`run-batch.ts` §2). TRUE IS NOT AN ERROR: it is the
     * ordinary answer for a small organiser mid-week, and the copy must read
     * as an explanation, not a fault.
     *
     * A STATEMENT ABOUT ONE CELL, NOT ABOUT THE PAYEE. The batch applies the
     * minimum PER (payee, currency) cell — `run-batch.ts` §2 loops
     * `consideredCells` and tests `cell.payableCents < payoutMinimumCents` —
     * so a payee whose default currency is below the minimum may still be
     * paid tonight out of a cell in ANOTHER currency. This flag cannot see
     * that cell and does not claim to. `otherCurrencies` is the disclosure:
     * when it is non-empty the UI must already be saying this overview is not
     * the whole picture, and `belowMinimum` inherits exactly that caveat.
     *
     * The per-cell scoping is NOT new — `payableCents` has always been the
     * default-currency cell alone. What is new here is turning that number
     * into a SENTENCE about what the batch will do, which is where a
     * single-currency figure can start to read as a claim about the payee.
     * Narrowed in the wording rather than nulled: returning null whenever
     * `otherCurrencies` is non-empty would throw away a verdict that is
     * perfectly true of the cell the rest of this page is about.
     *
     * NULL HAS TWO MEANINGS AND A CONSUMER MUST BRANCH, NEVER RENDER THE NULL:
     *
     *   1. COULD NOT CHECK — the fee-policy read failed
     *      (`minimumResolved: false`) or the payable read failed
     *      (`payableResolved: false`). This is the degraded state; "we
     *      couldn't check the minimum" is the right copy.
     *   2. NOTHING TO MEASURE — `payeeId === null`, an org that has never
     *      onboarded to Stripe. Both flags above are TRUE here; nothing
     *      failed. Showing an outage message to every brand-new org would be
     *      a bug, and it is the bug this note exists to prevent.
     *
     * So: check `payeeId` first, then the two `*Resolved` flags. The null
     * alone distinguishes nothing.
     */
    belowMinimum: z.boolean().nullable(),
    /**
     * MONEY THAT SHOULD HAVE GONE OUT AND HAS NOT. True when all four of
     * these hold at once:
     *
     *   * `payableCents > 0`               — there is money ready to send;
     *   * `belowMinimum === false`         — it cleared the batch's threshold;
     *   * `recentPayouts` is EMPTY         — and the list is capped at the
     *     {@link ORG_PAYOUT_OVERVIEW_RECENT_PAYOUTS} MOST RECENT payouts, so
     *     empty really does mean this payee has never been paid, not merely
     *     "none on this page";
     *   * it has been payable for longer than one full batch cycle
     *     ({@link PAYOUT_BATCH_CYCLE_MS}), measured from the oldest matured
     *     credit in the cell.
     *
     * TRUE IS AN INCIDENT, and that is the point. The alternative — an empty
     * "already sent" list — renders identically for a brand-new org and for an
     * org whose payouts have silently stopped, and only one of those is fine.
     *
     * THE TIME QUALIFIER IS NOT A REFINEMENT, IT IS THE SAFETY. Without it,
     * every org whose first credit matured at midnight is accused of a stuck
     * payout for the minutes between maturity and the batch running — the
     * exact false alarm this field exists to prevent, arrived at from the
     * other direction. The margin is deliberately generous and one-directional:
     * being a few hours late to raise this costs an organiser some not-knowing;
     * being early tells them their money is missing when it is on schedule.
     *
     * THIS IS COMPUTED, NEVER STORED. Same standing as `belowMinimum`: a read
     * -time verdict over reads this call already issued, with no column behind
     * it and nothing to go stale.
     *
     * NULL IS "CANNOT SAY", NEVER "FINE" — and a consumer must branch on it
     * rather than render it. It is null whenever ANY input is unknown:
     * `payableResolved === false`, `minimumResolved === false`,
     * `belowMinimum === null` (including the brand-new org with no Payee row,
     * where nothing failed), `historyResolved === false`, or the cell carries
     * no readable "payable since" timestamp to measure the wait against.
     *
     * FALSE means measured, and it is not overdue.
     *
     * IT IS SERVER-SIDE BECAUSE THE ORDER OF THE COMPARISONS IS LOAD-BEARING
     * and two of the inputs are nullable with nulls that MEAN something.
     * Re-derived in a UI it degrades safely only by accident (`null > 0` is
     * false in JS); invert or reorder one branch and a failed fee-policy read
     * renders "your money should have gone out and it hasn't" — telling an
     * organiser their money is missing because a config row would not read.
     * With four surfaces consuming this overview, a five-branch rule copied
     * per surface diverges quietly and no reviewer sees it, because every copy
     * reads perfectly sensibly.
     */
    payoutOverdue: z.boolean().nullable(),

    // ── Money coming ──────────────────────────────────────────────────────
    /** Upcoming tranches in `currency`, soonest first. Capped; see below. */
    upcoming: z.array(orgPayoutTrancheSchema),
    /** True when `upcoming` was cut at `ORG_PAYOUT_OVERVIEW_MAX_TRANCHES`. */
    upcomingTruncated: z.boolean(),
    /** Tranches the ledger returned in `currency`, before the cap. Null iff
     * `upcomingResolved` is false. */
    upcomingTrancheCount: z.number().int().nonnegative().nullable(),
    /** Σ GROSS over EVERY upcoming tranche in `currency`, cap ignored. Null
     * iff `upcomingResolved` is false. */
    upcomingCreditCents: z.number().int().nullable(),
    /** Σ `expectedCents` over EVERY upcoming tranche, cap ignored. Null iff
     * EITHER `upcomingResolved` or `payableResolved` is false. */
    upcomingExpectedCents: z.number().int().nullable(),
    /** False when the maturity read failed: `upcoming` is empty and every
     * upcoming total is null, so the UI says "could not check" rather than
     * "nothing coming". */
    upcomingResolved: z.boolean(),
    /** False when the order → event naming read failed. Every line's event
     * fields are then null because they are UNKNOWN, not because they are
     * absent. */
    attributionResolved: z.boolean(),

    // ── Money already sent ────────────────────────────────────────────────
    /** The most recent payouts, newest first, with every deduction shown. */
    recentPayouts: z.array(orgPayoutSentSchema),
    /** False when the payout-history read failed: `recentPayouts` is empty
     * because it is unknown, not because nothing was ever sent. */
    historyResolved: z.boolean(),

    /** When the payout batch next runs, from `asOf`: the instant, and the
     * Central calendar date of the evening it closes ("tonight's run").
     * Null when the batch's recorded schedule is not daily-at-midnight. */
    nextPayoutRun: nextPayoutRunSchema.nullable(),

    /** The clock every figure above was evaluated at. */
    asOf: z.date(),
  })
  .strict();

export type GetOrgPayoutOverviewOutput = z.infer<
  typeof getOrgPayoutOverviewOutputSchema
>;

/**
 * Currency an overview is reported in when there is no Payee row to ask. Only
 * ever reached on the empty "never onboarded" overview, where every figure is
 * 0 and the label is cosmetic.
 */
const FALLBACK_OVERVIEW_CURRENCY = "usd";

/** Everything `payoutOverdueVerdict` is allowed to look at. Named, so a call
 * site cannot transpose two booleans and still compile. */
export type PayoutOverdueInputs = {
  /** Null iff `payableResolved` is false. NEVER coalesced to 0. */
  payableCents: number | null;
  payableResolved: boolean;
  minimumResolved: boolean;
  /** The overview's own `belowMinimum`, with its null intact. */
  belowMinimum: boolean | null;
  historyResolved: boolean;
  /** How many payouts the (capped) history read returned. */
  recentPayoutCount: number;
  /**
   * `PayeeLedgerPayableBalance.oldestMaturedAt` for THIS currency's cell — the
   * maturity of the oldest matured, unblocked credit, i.e. "payable since
   * when". Null when the cell had none, or when the payable read failed.
   */
  oldestMaturedAt: Date | null;
  /** The overview's clock. */
  asOf: Date;
};

/**
 * Is money sitting payable that the batch should already have sent?
 *
 * THE ORDER OF THESE BRANCHES IS THE WHOLE FUNCTION. Each one is commented
 * with what moving it would break, because every rearrangement that looks
 * harmless produces a false accusation about somebody's money.
 *
 * Exported so the ordering can be tested directly and so a second consumer
 * (mobile, scanner, an embed) can never be tempted to re-derive it. If a
 * second use case ever needs it, it moves to `_shared/` — it does not get
 * copied.
 */
export function payoutOverdueVerdict(
  inputs: PayoutOverdueInputs,
): boolean | null {
  // 1. EVERY UNKNOWN FIRST, before a single comparison. A verdict this
  //    dangerous may only be reached from facts, so the degraded reads are
  //    excluded up front rather than discovered halfway down where a `false`
  //    could already have been returned.
  //
  //    `belowMinimum === null` covers the fee-policy outage AND the org with
  //    no Payee row. Both are "nothing to measure"; neither is "fine".
  if (
    !inputs.payableResolved ||
    !inputs.minimumResolved ||
    inputs.belowMinimum === null ||
    !inputs.historyResolved
  ) {
    return null;
  }

  // 2. A type narrowing, and deliberately NOT `?? 0`. `payableCents` is null
  //    iff the payable read failed, which §1 already rejected — but the
  //    coalesce that would "simplify" this line is exactly how an unread
  //    payable becomes a confident zero, so the null is refused outright.
  if (inputs.payableCents === null) return null;

  // 3. NO MONEY READY → not overdue, and this is a measured FALSE, not a
  //    null: we read the cell and it is empty (or in debt). Must come before
  //    the maturity check below, because a cell with nothing payable
  //    legitimately has no `oldestMaturedAt`, and testing maturity first
  //    would null the verdict for every org that is simply owed nothing.
  if (inputs.payableCents <= 0) return false;

  // 4. EXPLICITLY `!== false`, never a truthiness test. `belowMinimum` is a
  //    boolean by §1, so this is `true` only — but written as the identity it
  //    is, so that loosening §1 later cannot silently let a null through as
  //    "clears the minimum". Below the threshold the batch is CORRECT to hold
  //    the money: that is not overdue, it is the rule working.
  if (inputs.belowMinimum !== false) return false;

  // 5. ANY payout at all disqualifies. The history is capped at the
  //    `ORG_PAYOUT_OVERVIEW_RECENT_PAYOUTS` most recent, so a non-empty list
  //    proves payouts exist; an empty one proves none do, because a cap on
  //    the NEWEST rows cannot hide an older one.
  if (inputs.recentPayoutCount > 0) return false;

  // 6. "PAYABLE SINCE WHEN" HAS TO BE KNOWN. A positive payable with no
  //    oldest matured credit is a cell whose balance came from non-credit
  //    entries only (see the port's own note) — real, but it gives no clock
  //    to measure a wait against. Unknown duration means unknown verdict: we
  //    do not guess, in either direction. An unparseable date lands here too.
  const maturedAt = inputs.oldestMaturedAt;
  if (maturedAt === null || Number.isNaN(maturedAt.getTime())) return null;

  // 7. THE TIME QUALIFIER. STRICTLY greater: sitting exactly on the boundary
  //    is not yet overdue. Without this branch a brand-new org whose first
  //    credit matured at 00:00 is told its payout is stuck for every minute
  //    between maturity and the batch running.
  return inputs.asOf.getTime() - maturedAt.getTime() > PAYOUT_BATCH_CYCLE_MS;
}

/**
 * Guarded report — a broken reporter must never turn a degraded panel into a
 * failed one. Mirrors `get-payee-statement.ts`.
 */
function report(
  deps: GetOrgPayoutOverviewDeps,
  err: unknown,
  step: string,
  extra?: Record<string, unknown>,
): void {
  try {
    deps.reportError?.(err, {
      tags: { useCase: "getOrgPayoutOverview", step },
      extra,
    });
  } catch {
    // Reporting is fire-and-forget.
  }
}

/** The empty overview for an org with no Payee row. */
function emptyOverview(
  asOf: Date,
  minimum: PayoutMinimum,
): GetOrgPayoutOverviewOutput {
  return {
    payeeId: null,
    currency: FALLBACK_OVERVIEW_CURRENCY,
    otherCurrencies: [],
    balanceCents: 0,
    // Resolved-and-zero, not unknown: with no payee there is no read to
    // degrade, so every figure below is a FACT about an org that has never
    // been owed anything.
    payableCents: 0,
    payableResolved: true,
    pendingHoldCents: 0,
    reserveCents: 0,
    // The minimum is the ONE figure here that came from a real read — it is
    // issued before the payee lookup precisely so a brand-new org can still be
    // told the threshold it will have to clear. It therefore carries that
    // read's own resolution, not the blanket `true` the rest of this object
    // gets for having read nothing.
    payoutMinimumCents: minimum.payoutMinimumCents,
    minimumResolved: minimum.minimumResolved,
    // No payable at all, so "is it below the minimum" has no meaning here —
    // and the honest form of "no meaning" is null, never false. (Same ruling
    // as `get-payee-statement.ts`'s zeroed statement.)
    //
    // THIS NULL IS NOT A FAILURE, and the two flags above say so: both read
    // TRUE. A consumer that renders "could not check" on the null alone puts
    // an outage message in front of every org that has never onboarded. The
    // discriminator is `payeeId === null`; see the field's own doc.
    belowMinimum: null,
    // No payable, no threshold verdict, and nothing that has ever been owed —
    // so "should this have gone out by now" has no subject. Null, and for the
    // SAME reason `belowMinimum` is null here: nothing failed, there is simply
    // nothing to measure. A consumer that reads this null as an incident puts
    // "your payout is stuck" in front of every org that has never onboarded,
    // which is the loudest possible version of the bug this field prevents.
    payoutOverdue: null,
    upcoming: [],
    upcomingTruncated: false,
    upcomingTrancheCount: 0,
    upcomingCreditCents: 0,
    upcomingExpectedCents: 0,
    upcomingResolved: true,
    attributionResolved: true,
    recentPayouts: [],
    historyResolved: true,
    nextPayoutRun: nextPayoutRunFor(asOf),
    asOf,
  };
}

export async function getOrgPayoutOverview(
  deps: GetOrgPayoutOverviewDeps,
  rawInput: unknown,
): Promise<GetOrgPayoutOverviewOutput> {
  const logger = deps.logger?.child({ useCase: "getOrgPayoutOverview" });
  const input = parseInput(getOrgPayoutOverviewInputSchema, rawInput);

  // ── RBAC FIRST, before a single ledger read ──────────────────────────────
  // `canFinanceOrg`, not a staff role: this is the organiser's own money.
  // Same gate as `getPayeeStatement` and `orders.getOwnerPayoutSummary`, and
  // enforced HERE rather than at the transport, matching the platform
  // siblings. (Prior art for getting this wrong: the claims desk shipped with
  // list/get/review all ungated.)
  const permission = await deps.authz.canFinanceOrg({
    actorHumanId: input.actorHumanId,
    orgId: input.orgId,
  });
  if (!permission.allowed) {
    throw fail("FORBIDDEN");
  }

  const asOf = deps.clock.now();
  const budget = { statementTimeoutMs: ORG_PAYOUT_OVERVIEW_TIMEOUT_MS };

  // ── The payout minimum: BEST-EFFORT, and read BEFORE the payee lookup ─────
  // Before, so even the empty overview can name the threshold a brand-new org
  // will have to clear. Best-effort, because a fee-policy outage must not
  // blank a page that already knows the balance: a failed read yields
  // `payoutMinimumCents: null` + `minimumResolved: false` and NEVER the batch
  // default — see `_shared/payout-minimum.ts`, which owns the argument. The
  // helper never throws (the failure path is inside its own try), so this
  // await cannot take the overview down.
  const minimum = await readPayoutMinimum(
    // The CHILD logger, so the helper's swallow carries this use case's
    // context exactly as the local `report()` sites do.
    { repos: deps.repos, logger, reportError: deps.reportError },
    {
      asOf,
      telemetry: {
        logEvent: "org_payout_overview_fee_policy_lookup_failed",
        useCase: "getOrgPayoutOverview",
        step: "resolveFeePolicy",
      },
    },
  );

  const payeeRef = await deps.repos.payees.getBySubject({
    type: "ORGANIZATION",
    id: input.orgId,
  });
  // NOT an error. An org with no Payee row has never onboarded to Stripe —
  // the overwhelmingly common state for a new org — and an organiser opening
  // their payouts page deserves an honest empty, not a 404.
  if (!payeeRef) return emptyOverview(asOf, minimum);

  const payee = await deps.repos.payees.getById(payeeRef.id);
  if (!payee) {
    // The row vanished between the two reads. Treated as "no payee" rather
    // than thrown: the overview is still true (nothing is owed that we can
    // see), and a race must not 500 an organiser's money page.
    logger?.error("org_payout_overview_payee_row_missing", {
      payeeId: payeeRef.id,
    });
    return emptyOverview(asOf, minimum);
  }

  const payeeId = payeeRef.id;
  const currency = normaliseLedgerCurrency(payee.defaultCurrency);

  // THE ONE LOAD-BEARING READ. Without the rollup balance there is no honest
  // headline, so a failure here fails the whole view and the UI retries.
  const balance = await deps.repos.payeeLedger.getBalance(payeeId, currency);

  // Currencies observed anywhere in this payee's ledger reads, so a cell in a
  // currency other than the default is DISCLOSED rather than dropped.
  const seenCurrencies = new Set<string>();

  // ── The payable: BEST-EFFORT, and the debt walk's only input ─────────────
  // Read ONCE and used twice — the headline `payableCents` and the netting —
  // so the number on the page and the number the tranches were netted
  // against can never disagree.
  let payableResolved = true;
  let payableCents: number | null = null;
  /**
   * "Payable since when" for THIS currency's cell, carried out of the SAME
   * read that produced `payableCents` — `payoutOverdue` needs it and the port
   * already returns it, so nothing here issues a second query for it. Null
   * when the read failed, when no cell exists, or when the cell's positive
   * balance came from non-credit entries only.
   */
  let oldestMaturedAt: Date | null = null;
  const debtByCell = new Map<string, number>();
  try {
    const cells = await deps.repos.payeeLedger.listPayableBalances(
      asOf,
      [payeeId],
      budget,
    );
    // Fold per NORMALISED currency BEFORE testing the sign: two raw casings
    // of one currency (+5,000 'USD', −3,000 'usd') are one +2,000 cell with
    // no debt, not a 3,000 debt. Same rule as the shared walk's own read.
    const signed = new Map<string, number>();
    // Folded per NORMALISED currency alongside the cents, and by MINIMUM: two
    // raw casings of one currency are one cell, and that cell has been waiting
    // since the earlier of the two dates. Taking the last one seen instead
    // would shorten the wait by however long the other casing has sat there.
    const oldestByCurrency = new Map<string, Date>();
    for (const cell of cells) {
      // FILTER ON THE ROW'S OWN PAYEE, exactly as `readDebtPositions` keys on
      // `cell.payeeId` rather than on what it asked for. The request above
      // narrows to `[payeeId]` in SQL, so this skips nothing today — it is
      // here so the arithmetic stays correct WITHOUT that guarantee. Trusting
      // the narrowing would make a superset-returning adapter fold another
      // payee's money into this org's headline and net the debt walk against
      // it, and no fake in the suite returns multi-payee rows to catch it.
      // Same drift class as a hand-rolled cell key, and the same fix: read
      // the datum, do not infer it.
      if (cell.payeeId !== payeeId) continue;
      const key = normaliseLedgerCurrency(cell.currency);
      // AFTER the filter: `otherCurrencies` discloses what THIS payee holds.
      // A foreign row leaking in here would announce another org's currency.
      seenCurrencies.add(key);
      signed.set(key, (signed.get(key) ?? 0) + cell.payableCents);
      const maturedAt = cell.oldestMaturedAt;
      if (maturedAt) {
        const seen = oldestByCurrency.get(key);
        if (!seen || maturedAt.getTime() < seen.getTime()) {
          oldestByCurrency.set(key, maturedAt);
        }
      }
    }
    // An ABSENT cell is a TRUE ZERO: the payable is an aggregate over
    // entries, so no cell means no matured, unblocked entries — not unknown.
    payableCents = signed.get(currency) ?? 0;
    // Only the currency this whole overview is denominated in. Another cell's
    // wait says nothing about this one's.
    oldestMaturedAt = oldestByCurrency.get(currency) ?? null;
    for (const [cur, total] of signed) {
      // The SHARED key builder, not a second copy of its format: the walk
      // below looks these cells up with it, and a drifting template here
      // would silently apply no debt at all.
      if (total < 0) debtByCell.set(payeeCurrencyCellKey(payeeId, cur), -total);
    }
  } catch (err) {
    payableResolved = false;
    payableCents = null;
    oldestMaturedAt = null;
    logger?.error("org_payout_overview_payable_lookup_failed", {
      err,
      payeeId,
    });
    report(deps, err, "listPayableBalances", { payeeId });
  }

  // ── The maturity feed: BEST-EFFORT ───────────────────────────────────────
  // An EMPTY `upcoming` is a real answer ("nothing coming"), so a failed read
  // must never be able to produce it silently: it degrades to
  // `upcomingResolved: false` with every total null.
  let upcomingResolved = true;
  let maturities: PayeeLedgerUpcomingMaturity[] = [];
  try {
    // Same rule as the payable fold above: keep the ROW'S OWN payee, do not
    // trust the request's narrowing to have done it. A foreign tranche here
    // would be summed into `upcomingCreditCents` and listed on the spine as
    // this org's money.
    maturities = (
      await deps.repos.payeeLedger.listUpcomingMaturities(
        asOf,
        [payeeId],
        budget,
      )
    ).filter((row) => row.payeeId === payeeId);
    for (const row of maturities) {
      seenCurrencies.add(normaliseLedgerCurrency(row.currency));
    }
  } catch (err) {
    upcomingResolved = false;
    maturities = [];
    logger?.error("org_payout_overview_maturity_lookup_failed", {
      err,
      payeeId,
    });
    report(deps, err, "listUpcomingMaturities", { payeeId });
  }

  // ── Debt netting: THE shared walk, byte-for-byte the staff view's ────────
  // Fed the payable we already read rather than re-reading it, so the
  // headline and the tranches are netted against one number. `heldCents` is
  // never an operand — the hold is already inside that payable.
  const netted = applyDebtNetting(
    // Only this currency's tranches: every figure on the spine is in
    // `currency`, and a tranche in another one would put two currencies'
    // cents under one heading. Others are disclosed via `otherCurrencies`.
    maturities.filter(
      (row) => normaliseLedgerCurrency(row.currency) === currency,
    ),
    payableResolved ? { resolved: true, debtByCell } : { resolved: false },
  );
  // The adapter orders `maturesAt` ASC, but the sort is EXPLICIT so a
  // contract change underneath cannot silently reorder the spine — and the
  // half-open attribution window below is only correct in ascending order.
  const ascending = [...netted].sort(
    (a, b) => a.maturesAt.getTime() - b.maturesAt.getTime(),
  );

  // Totals over EVERY tranche, computed BEFORE the display cap: truncating
  // first would make a long horizon silently understate what is coming.
  const upcomingCreditCents = upcomingResolved
    ? ascending.reduce((sum, row) => sum + row.creditCents, 0)
    : null;
  // NULL iff EITHER read degraded — stated as the condition rather than
  // discovered by null-propagation, so an EMPTY horizon under a failed
  // payable reads "could not check" instead of a confident 0.
  const upcomingExpectedCents =
    upcomingResolved && payableResolved
      ? // Inside this branch every row's `expectedCents` is a number by
        // construction (the walk only nulls them when the payable failed), so
        // the coalesce is a type narrowing, never a silent zero.
        ascending.reduce((sum, row) => sum + (row.expectedCents ?? 0), 0)
      : null;

  const upcomingTruncated = ascending.length > ORG_PAYOUT_OVERVIEW_MAX_TRANCHES;
  const visible = upcomingTruncated
    ? ascending.slice(0, ORG_PAYOUT_OVERVIEW_MAX_TRANCHES)
    : ascending;

  // ── Sub-lines: the credit rows behind ONE tranche ────────────────────────
  // `trancheAttributionOptions` builds the four-part options bundle; NOTHING
  // here assembles it by hand. The `previousTranche` is the tranche BEFORE
  // this one for the SAME payee and SAME currency — which `visible` is, since
  // it is one payee, one currency, ascending. Handing it the previous ROW of
  // a mixed-currency feed would move the window's lower bound to an unrelated
  // date and itemise every future tranche under one heading.
  const lineReads = await Promise.all(
    visible.map(async (tranche, index) => {
      const previousTranche = index > 0 ? visible[index - 1]! : null;
      try {
        const rows = await deps.repos.payeeLedger.listEntries(
          payeeId,
          trancheAttributionOptions({
            tranche: {
              payeeId,
              currency: tranche.currency,
              maturesAt: tranche.maturesAt,
            },
            previousTranche: previousTranche
              ? {
                  payeeId,
                  currency: previousTranche.currency,
                  maturesAt: previousTranche.maturesAt,
                }
              : null,
            asOf,
            // One row OVER the cap, purely to MEASURE truncation exactly
            // rather than infer it from `creditCount`, which counts the same
            // rows but is produced by a different query.
            limit: ORG_PAYOUT_OVERVIEW_LINES_PER_TRANCHE + 1,
          }),
        );
        return { ok: true as const, rows };
      } catch (err) {
        logger?.error("org_payout_overview_tranche_lines_failed", {
          err,
          payeeId,
          maturesAt: tranche.maturesAt,
        });
        report(deps, err, "listTrancheEntries", {
          payeeId,
          maturesAt: tranche.maturesAt.toISOString(),
        });
        return { ok: false as const, rows: [] as PayeeLedgerEntryRecord[] };
      }
    }),
  );

  // ── Naming the show: BEST-EFFORT, one batched read for the whole page ────
  // A naming outage must never hide money, so it degrades to
  // `attributionResolved: false` with the event fields null — never to a
  // dropped line, which would stop the sub-lines summing to their heading.
  const orderIds = [
    ...new Set(
      lineReads
        .flatMap((read) => read.rows)
        .map((row) => row.orderId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  let attributionResolved = true;
  let attribution = new Map<string, OrderEventAttribution>();
  if (orderIds.length > 0) {
    try {
      attribution = await deps.repos.orders.getEventAttributionByIds(orderIds);
    } catch (err) {
      attributionResolved = false;
      attribution = new Map();
      logger?.error("org_payout_overview_attribution_failed", {
        err,
        orderCount: orderIds.length,
      });
      report(deps, err, "getEventAttribution", {
        orderCount: orderIds.length,
      });
    }
  }

  const toLine = (row: PayeeLedgerEntryRecord): OrgPayoutCreditLine => {
    const named = row.orderId ? attribution.get(row.orderId) : undefined;
    return {
      entryId: row.id,
      amountCents: row.amountCents,
      currency: row.currency,
      // EFFECTIVE maturity when the read supplies it (the tranche-attribution
      // path always does): the date this line is bucketed under, so it sits
      // inside its tranche's window even for a rescheduled RESALE credit.
      availableAt:
        row.effectiveAvailableAt !== undefined
          ? row.effectiveAvailableAt
          : row.availableAt,
      createdAt: row.createdAt,
      orderId: row.orderId,
      orderCode: named?.orderCode ?? null,
      eventId: named?.eventId ?? null,
      eventTitle: named?.eventTitle ?? null,
      eventSlug: named?.eventSlug ?? null,
      eventStartsAt: named?.eventStartsAt ?? null,
    };
  };

  const upcoming: OrgPayoutTranche[] = visible.map(
    (tranche: NettedMaturityRow<PayeeLedgerUpcomingMaturity>, index) => {
      const read = lineReads[index]!;
      const linesTruncated =
        read.rows.length > ORG_PAYOUT_OVERVIEW_LINES_PER_TRANCHE;
      const pageRows = linesTruncated
        ? read.rows.slice(0, ORG_PAYOUT_OVERVIEW_LINES_PER_TRANCHE)
        : read.rows;
      return {
        maturesAt: tranche.maturesAt,
        currency: tranche.currency,
        creditCents: tranche.creditCents,
        heldCents: tranche.heldCents,
        creditCount: tranche.creditCount,
        debtAppliedCents: tranche.debtAppliedCents,
        expectedCents: tranche.expectedCents,
        lines: read.ok ? pageRows.map(toLine) : [],
        linesResolved: read.ok,
        linesTruncated: read.ok && linesTruncated,
      };
    },
  );

  // ── Money already sent: BEST-EFFORT ──────────────────────────────────────
  // The SAME staff statement narrowed to this payee — an explicit one-element
  // array, never a post-filter over every payee's payouts.
  let historyResolved = true;
  let recentPayouts: OrgPayoutSent[] = [];
  try {
    const page = await deps.repos.payoutItems.listHistory({
      status: "all",
      payeeIds: [payeeId],
      limit: ORG_PAYOUT_OVERVIEW_RECENT_PAYOUTS,
      cursor: null,
      statementTimeoutMs: ORG_PAYOUT_OVERVIEW_TIMEOUT_MS,
    });
    recentPayouts = page.items.map((item) => ({
      id: item.id,
      payoutId: item.payoutId,
      currency: item.currency,
      amountCents: item.amountCents,
      netCents: item.netCents,
      connectAccountFeeCents: item.connectAccountFeeCents,
      recoveredDebtCents: item.recoveredDebtCents,
      reserveHeldCents: item.reserveHeldCents,
      reserveReleasedCents: item.reserveReleasedCents,
      status: item.status,
      occurredAt: item.occurredAt,
      transferredAt: item.transferredAt,
      scheduledFor: item.scheduledFor,
      failedAt: item.failedAt,
      failureReason: item.failureReason,
      stripeTransferId: item.stripeTransferId,
    }));
  } catch (err) {
    historyResolved = false;
    recentPayouts = [];
    logger?.error("org_payout_overview_history_failed", { err, payeeId });
    report(deps, err, "listPayoutHistory", { payeeId });
  }

  // Computed ONCE, from the values this object is about to report, so the
  // verdict and the figures beside it can never describe different reads.
  const belowMinimum = belowPayoutMinimum(
    payableCents,
    minimum.payoutMinimumCents,
  );

  return {
    payeeId,
    currency,
    otherCurrencies: [...seenCurrencies]
      .filter((cur) => cur !== currency)
      .sort((a, b) => a.localeCompare(b)),
    balanceCents: balance.ledgerBalanceCents,
    payableCents,
    payableResolved,
    pendingHoldCents: balance.pendingHoldCents,
    reserveCents: balance.reserveCents,
    payoutMinimumCents: minimum.payoutMinimumCents,
    minimumResolved: minimum.minimumResolved,
    // Null when EITHER side is unknown — an unread policy or an unread
    // payable. The helper owns that rule so no caller can reinvent it as a
    // `?? false`, which is how a blank verdict turns into "it clears".
    belowMinimum,
    // Fed the SAME `belowMinimum` the line above reports, null and all: the
    // two verdicts are about one payable and must never be computed from two.
    payoutOverdue: payoutOverdueVerdict({
      payableCents,
      payableResolved,
      minimumResolved: minimum.minimumResolved,
      belowMinimum,
      historyResolved,
      recentPayoutCount: recentPayouts.length,
      oldestMaturedAt,
      asOf,
    }),
    upcoming,
    upcomingTruncated,
    upcomingTrancheCount: upcomingResolved ? ascending.length : null,
    upcomingCreditCents,
    upcomingExpectedCents,
    upcomingResolved,
    attributionResolved,
    recentPayouts,
    historyResolved,
    nextPayoutRun: nextPayoutRunFor(asOf),
    asOf,
  };
}
