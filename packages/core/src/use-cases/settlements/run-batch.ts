import { createHash } from "node:crypto";

import { z } from "zod";

import type { Repos } from "@th/ports/repos";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type {
  ConsumablePayeeLedgerCredit,
  PayeeLedgerPayableBalance,
} from "@th/ports/repos/payee-ledger";
import type { OrderKind } from "@th/types/repos/orders";
import { parseInput, describeError } from "../../lib/io";
import {
  computeConnectAccountFeeDeduction,
  startOfUtcMonth,
  type ConnectAccountFeeReason,
} from "./connect-account-fee";
import {
  computeMembershipReserve,
  computeReserveHoldCents,
  isReserveReleaseFrozen,
  type MembershipReserveBasis,
} from "./membership-reserve";
import { payeePayoutBlocker } from "./payee-payout-readiness";

// ── Schemas ──────────────────────────────────────────────────────────────────

export const runPayoutBatchInputSchema = z.object({
  /** Maximum payees to process per batch. Prevents runaway batches. */
  limit: z.number().int().min(1).max(500).default(100),
});

export const runPayoutBatchOutputSchema = z.object({
  payoutId: z.string().uuid().nullable(),
  /**
   * Distinct payees with a POSITIVE payable this cycle, after the `limit`
   * cap. Payees in a debt position (negative payable) are not "considered" —
   * they pay nothing and the next cycle's arithmetic recoups them.
   */
  payeesConsidered: z.number().int(),
  itemsCreated: z.number().int(),
  itemsTransferred: z.number().int(),
  itemsFailed: z.number().int(),
  /** (payee, currency) cells whose payable was under `payoutMinimumCents`. */
  itemsSkippedBelowMinimum: z.number().int(),
  /**
   * Cells skipped because the payee is not payable (missing row, no Stripe
   * account, payouts disabled). No PayoutItem is minted and no credit is
   * touched — the money simply waits for the next batch.
   */
  itemsSkippedIneligible: z.number().int(),
  /**
   * Items failed by the pre-transfer race guard: a refund / dispute landed
   * between planning and the Stripe call, dropping the payable below the
   * claim. Counted in `itemsFailed` too.
   */
  itemsSkippedPayableDropped: z.number().int(),
  /**
   * Cells another run had already claimed for this cycle (the cross-run cell
   * claim) or already transferred inside Stripe's 24h key window. Skipped, not
   * failed at the money level: nothing was sent and nothing consumed, so the
   * next batch pays them.
   */
  itemsSkippedClaimLost: z.number().int(),
  /**
   * Items the PLATFORM's own float could not fund: Stripe rejected the
   * transfer with `balance_insufficient`, or a shortfall earlier in the batch
   * had already emptied that currency's balance (see the per-currency circuit
   * breaker in step 10). Counted in `itemsFailed` too.
   *
   * A non-zero value says nothing is wrong with these payees — the fix is
   * ours: top up, or slow the platform's own Stripe payout schedule so charges
   * settle before the batch runs. The money is safe: no transfer left, no
   * credit was consumed, no PAYOUT entry was written, so the next batch
   * re-plans exactly these cells. Stripe never retries a `balance_insufficient`
   * transfer on its own and adding funds does not release it, so that re-plan
   * is the re-attempt.
   *
   * TIMING CAVEAT, and it matters operationally. Our Stripe idempotency key is
   * derived from the credit set (buildStripeTransferIdempotencyKey), so an
   * unchanged credit set re-sends the IDENTICAL key. Stripe saves the response
   * of the first request under a key — failures included — for ~24h. So a
   * re-attempt inside that window may replay the cached rejection instead of
   * reaching a now-healthy balance, which looks exactly like the top-up having
   * done nothing. Wait for the next nightly run; do not hand-trigger the batch
   * straight after topping up.
   *
   * (Considered and deliberately NOT done: salting the Stripe key on a
   * shortfall re-attempt. A salt that is unconditional — per-run, per-day —
   * would destroy the only protection covering the crash window where Stripe
   * ACCEPTED a transfer but our claim commit never landed, since that window
   * is precisely where our own `payout-transfer:` claim is absent and the
   * Stripe key is load-bearing. A safe salt therefore has to be conditional on
   * durable "nothing was sent" state, and the cost of getting that attempt
   * bookkeeping subtly wrong is paying a venue twice. Waiting out a 24h window
   * is the cheaper side of that trade.)
   */
  itemsFailedInsufficientPlatformBalance: z.number().int(),
  /**
   * Payees with a positive payable that this run's `limit` deferred. The
   * planning feed is ordered oldest-matured-money first, so a deferred payee
   * outranks tonight's winners tomorrow — but a persistently non-zero number
   * here means the cap is too low for the payee base and payouts are
   * systematically late.
   */
  payeesDeferredByLimit: z.number().int(),
  /**
   * Transferred items from PREVIOUS runs whose ledger writes were lost to a
   * crash and were replayed from their durable plan at the top of this run.
   * Non-zero means a real crash happened; it should be rare and is worth
   * looking at, but the money is correct by the time the batch plans.
   */
  itemsLedgerHealed: z.number().int(),
  /**
   * Cells HELD because they carry MEMBERSHIP revenue and the owner's
   * MembershipStanding is suspended (the payout half of the schema's
   * "suspends new signups and holds payouts" promise). Held cells never mint
   * a PayoutItem; their credits stay unconsumed and pay on a batch that runs
   * after unsuspension.
   */
  itemsHeldForSuspension: z.number().int(),
  /**
   * Items whose ENTIRE net was consumed by transfer-time withholding (the
   * rolling reserve and/or the Connect fee): they completed as "transferred"
   * without any Stripe call (there was nothing left to send).
   */
  itemsFullyWithheld: z.number().int(),
  /** Cents actually SENT to Stripe across successfully completed items. */
  totalTransferredCents: z.number().int(),
  /**
   * Cents of PAYABLE consumed from the ledger across successfully completed
   * items — the sum of the PAYOUT entries written. Differs from
   * `totalTransferredCents` by exactly the transfer-time withholdings
   * (reserve held, Connect fee) minus matured reserve riding along.
   */
  totalPayableClaimedCents: z.number().int(),
  /**
   * Rolling reserve DEFERRED across completed items (spec 2026-08-05: a
   * reserve is deferred payout, not revenue). `totalTransferredCents` is
   * already net of this.
   */
  reserveHeldCents: z.number().int(),
  /** How many completed items had reserve withheld. */
  itemsWithReserveHeld: z.number().int(),
  /**
   * Matured reserve RETURNED to payees across completed items — added on top
   * of the payable being paid out. `totalTransferredCents` already includes
   * it; `totalPayableClaimedCents` deliberately does NOT (those cents were
   * claimed by the cycle that withheld them).
   */
  reserveReleasedCents: z.number().int(),
  /** How many completed items carried a reserve release. */
  itemsWithReserveReleased: z.number().int(),
  /**
   * Stripe Connect active-account fee actually withheld across completed
   * items. `totalTransferredCents` is already net of this.
   */
  connectFeeCents: z.number().int(),
  /** How many completed items carried a non-zero Connect fee deduction. */
  itemsWithConnectAccountFee: z.number().int(),
});

export type RunPayoutBatchInput = z.infer<typeof runPayoutBatchInputSchema>;
export type RunPayoutBatchOutput = z.infer<typeof runPayoutBatchOutputSchema>;

export type RunPayoutBatchDeps = {
  repos: Repos;
  payments: PaymentProcessorPort;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Optional best-effort error reporter (wired to `Sentry.captureException` at
   * the jobs layer). Fired for per-item payout failures that are SWALLOWED so
   * the batch can continue — transfer throws, payee-ineligibility skips, and
   * every post-transfer ledger write that cannot be retried. These never
   * bubble to the job error-boundary, so without this hook they are invisible
   * in Sentry. A missing or throwing reporter must never change batch
   * behaviour.
   */
  reportError?: ReporterPort;
  /**
   * Optional best-effort callback to notify a payee that their payout item
   * completed (email + in-app). Kept as a callback so run-batch stays
   * decoupled from the comms wiring and is trivial to unit-test. A failure
   * here must NEVER fail or roll back the batch — the payout already happened.
   */
  notifyPayee?: (args: {
    payeeId: string;
    payoutId: string;
    payoutItemId: string;
    /**
     * For `kind: "payout"`, the NET cents that actually landed in the payee's
     * account. For `kind: "reserved"`, the cents deferred into the rolling
     * reserve (where "what landed" would be a confusing $0.00).
     */
    amountCents: number;
    currency: string;
    /**
     * How many ledger credits (order-level revenue rows) this payout
     * settled. Named for the pre-cutover settlement rows it replaced; the
     * notification copy renders it as "N sales".
     */
    settlementCount: number;
    /**
     * How this payout item completed. Omitted/`"payout"` = money moved to the
     * payee's bank. `"reserved"` = the rolling reserve (and/or the Connect
     * fee) consumed the whole payout: the money is theirs and comes back once
     * the holds mature; without a distinct notification the payee would just
     * see a payout silently never arrive. `"applied_to_balance"` is retained
     * in the contract for the renderer but is UNREACHABLE post-cutover — debt
     * is no longer withheld from a payout, it is a negative payable that pays
     * nothing at all.
     */
    kind?: "payout" | "applied_to_balance" | "reserved";
    /**
     * The SETTLEMENT_CREDIT rows this item consumed — the "where it came
     * from" of the payout email (one line per order). Threaded from the plan
     * cell rather than re-read: the notifier runs AFTER the credits are
     * stamped consumed, so a fresh consumable read would return nothing.
     */
    credits: Array<{
      entryId: string;
      orderId: string | null;
      amountCents: number;
    }>;
    /**
     * What was withheld from the payable before the transfer, so the email
     * can reconcile "sales − withholdings = sent". `recoveredDebtCents` is
     * always 0 post-cutover (debt is a negative payable, never a
     * withholding) and is carried only so the renderer contract stays
     * honest about the row.
     */
    recoveredDebtCents: number;
    connectAccountFeeCents: number;
    reserveHeldCents: number;
    /**
     * Matured reserve returned ON this payout. It rides the transfer (net =
     * payable − held − fee + released), so without it the statement shows
     * more money leaving than the sales explain.
     */
    reserveReleasedCents: number;
    /** ISO instant the batch ran — the date the email is headed with. */
    payoutDateIso: string;
  }) => Promise<void>;
};

// ── Constants ────────────────────────────────────────────────────────────────

const IDEMPOTENCY_KEY_TTL_SECONDS = 600;
const IDEMPOTENCY_KEEP_SECONDS = 86_400;

/**
 * Retention on the COMMITTED transfer claim (`payout-transfer:<hash>`) —
 * 3 nightly cycles, deliberately LONGER than the general 24h keep. The claim
 * is the durable "this money already left, tr_X" record, and both recovery
 * paths read it:
 *   * the claim-lost probe (same cell hash tomorrow → `begin` collides);
 *   * the stale-pending sweep (`get` on the item's stored claim key).
 * At 24h, whether the nightly cron lands before or after expiry is scheduler
 * jitter — a coin flip between "probe recovers" and "record gone, credits
 * re-plan, money re-sends" (Stripe's own idempotency key expires on the same
 * ~24h clock, so it does not backstop the loss). Three cycles guarantees the
 * record survives at least two subsequent batch runs, which is what makes
 * the stale-pending sweep reliable rather than lucky. Cell/fee/reserve claim
 * commits keep the general retention — they guard a cycle, not money.
 */
const TRANSFER_CLAIM_KEEP_SECONDS = 3 * 86_400;

/**
 * TTL on the cross-worker claim of "this payee's Connect fee for this
 * calendar month" (`connect-fee:<payee>:<YYYY-MM>`). Keyed per ACCOUNT-month,
 * never per currency: Stripe bills the $2 once per connected account per
 * month, so two concurrent runs handling the same payee's USD and CAD cells
 * must contend for ONE claim — a currency-scoped key would let each stamp its
 * own $2. The daily batch job is nominally a singleton, so this claim is
 * defence-in-depth against an overlapping manual trigger or a scheduler
 * double-fire — an hour comfortably covers any single run. After a successful
 * transfer the claim is committed; after that (and after the key eventually
 * expires) the DURABLE guard is the DB itself:
 * `payeeIdsWithTransferredPayoutInPeriod` sees the transferred row. On a
 * failed transfer the claim is released (`fail`), so a crashed worker
 * under-recovers the $2 rather than blocking it — the documented fail-safe
 * direction (see connect-account-fee.ts).
 */
const CONNECT_FEE_CLAIM_TTL_SECONDS = 3_600;

/**
 * TTL on the cross-worker claim of "this payee+currency's rolling-reserve
 * plan" (`reserve-plan:<payee>:<currency>`). Same defence-in-depth shape as
 * the Connect-fee claim, but the money at stake points a different way on
 * each half of the plan:
 *   * HOLD side: each cell's reserve is computed on its OWN membership
 *     portion, so two workers on disjoint cells withholding independently
 *     would actually be correct — the claim just keeps the accounting to one
 *     decision per payee+currency per hour.
 *   * RELEASE side: the matured holds are SHARED state. Two overlapping runs
 *     that both matured the same holds would both add the released cents to
 *     their transfers — double money out. Only the claim winner may release.
 * Losing the claim skips the whole reserve step for that cell this run
 * (no hold: under-protection, bounded; no release: money waits one more
 * batch — never lost, never doubled). Committed once the item completes;
 * released (`fail`) when the item fails before completing; an orphaned claim
 * expires after an hour.
 */
const RESERVE_CLAIM_TTL_SECONDS = 3_600;

/** Smallest transfer Stripe will accept. Mirrors connect-account-fee.ts. */
const MIN_NET_TRANSFER_CENTS = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Age gate on the stale-pending recovery feed (step 0a). NOT load-bearing
 * for safety: `get()` returns COMMITTED records only, and the payload's
 * `payoutItemId` must name the probed item, so stamping is correct at ANY
 * age — even re-stamping an item whose own run is mid-`markTransferred` is
 * an idempotent same-value write. The buffer exists only to keep a live
 * run's just-created rows (and trivial clock skew) out of the scan.
 *
 * Deliberately MINUTES, not a cycle: a one-cycle cutoff re-opens a
 * manual-rerun gap — crash at 00:05 post-commit/pre-markTransferred, a new
 * credit matures at 08:00 (cell hash drifts), operator re-triggers at 10:00:
 * the 10h-old pending item would be skipped while the drifted hash lets the
 * overstated payable re-send its money.
 */
const STALE_PENDING_MIN_AGE_MS = 15 * 60 * 1000;

/**
 * THE CELL HASH — the stable identity of the money one payout item moves:
 * the payee, the currency and the SORTED ids of the SETTLEMENT_CREDIT entries
 * being claimed. Four keys derive from it, and they derive from it for the
 * same reason: `payoutItemId` does NOT survive the failure mode they exist
 * for.
 *
 * Nothing re-processes a PayoutItem. If the process dies after Stripe accepts
 * a transfer but before the PAYOUT ledger entry lands, the payable still shows
 * the money as owed and the credits are still unconsumed, so the NEXT batch
 * mints a brand-new PayoutItem — new id, and therefore new keys — for exactly
 * the same money. Every key derived from the item id is blind to that; every
 * key derived from the credit set replays.
 *
 *   `transfer:<hash>`         Stripe-side  — a duplicate send replays instead
 *                                            of moving money twice.
 *   `payout-transfer:<hash>`  our-side     — begin/commit around the Stripe
 *                                            call; a committed key (24h, the
 *                                            same window Stripe honours) makes
 *                                            a later run refuse the cell
 *                                            rather than re-send.
 *   `payout:<hash>`           ledger       — the PAYOUT entry's idempotency
 *                                            key, so two runs that both reach
 *                                            the ledger write debit the payee
 *                                            ONCE. (Keyed on the item id, they
 *                                            would write two entries and
 *                                            halve the payee's balance for a
 *                                            single transfer.)
 *
 * (Stripe expires idempotency keys after 24 hours, so a recovery firing later
 * than that is not protected by the Stripe key alone — which is exactly why
 * the durable plan on the PayoutItem and the ledger heal sweep exist: they
 * make recovery a pure ledger replay that never needs a second Stripe call.)
 */
function buildCellHash(
  payeeId: string,
  currency: string,
  creditEntryIds: string[],
): string {
  const basis = `${payeeId}:${normalizeCurrency(currency)}:${[...creditEntryIds].sort().join(",")}`;
  return createHash("sha256").update(basis).digest("hex");
}

/** Stripe-side idempotency key. See {@link buildCellHash}. */
export function buildStripeTransferIdempotencyKey(
  payeeId: string,
  currency: string,
  creditEntryIds: string[],
): string {
  return `transfer:${buildCellHash(payeeId, currency, creditEntryIds)}`;
}

/** PAYOUT ledger-entry idempotency key. See {@link buildCellHash}. */
export function buildPayoutLedgerKey(
  payeeId: string,
  currency: string,
  creditEntryIds: string[],
): string {
  return `payout:${buildCellHash(payeeId, currency, creditEntryIds)}`;
}

/** Our-side transfer claim key. See {@link buildCellHash}. */
export function buildTransferClaimKey(
  payeeId: string,
  currency: string,
  creditEntryIds: string[],
): string {
  return `payout-transfer:${buildCellHash(payeeId, currency, creditEntryIds)}`;
}

/**
 * Derive an item's transfer-claim key from its STORED `payoutLedgerKey`.
 * The two are the SAME cell hash under different prefixes (see
 * {@link buildCellHash}), and the stale-pending recovery sweep (step 0a)
 * relies on this mapping to probe a crashed item's claim from its durable
 * plan. The mapping lives HERE, next to the builders it must stay in sync
 * with: a prefix rename with a stray hand-rolled regex elsewhere would make
 * the sweep's `get()` silently miss forever.
 */
export function transferClaimKeyFromLedgerKey(payoutLedgerKey: string): string {
  return payoutLedgerKey.replace(/^payout:/, "payout-transfer:");
}

/**
 * TTL on the cross-RUN claim of "this payee+currency is being paid this cycle"
 * (spec §6.1, `payout:<payee>:<currency>:<cycleDate>`).
 *
 * This is the guard the per-item keys structurally cannot be: the daily cron
 * and a manual `POST /jobs/settlements.run-batch` are not mutually exclusive,
 * and two runs 200ms apart both read the same payable, both plan the same
 * credits, and both reach the ledger. Stripe dedupes the TRANSFER (identical
 * key and amount), so without this claim the visible symptom is not a double
 * payment — it is a payee debited TWICE for one transfer. Only the claim
 * winner may plan the cell; the loser skips it and the next batch pays it.
 *
 * Committed on completion, released on failure, and scoped to the UTC cycle
 * date so a genuinely new day always re-plans.
 */
const CELL_CLAIM_TTL_SECONDS = 3_600;

/**
 * Default minimum payout if no FeePolicy is found (1000 cents = $10).
 *
 * EXPORTED so the staff "Payouts owed" view
 * (`platform/list-payable-positions.ts`) marks the same rows this batch will
 * skip. Retyping the number there would let the page and the batch drift into
 * disagreeing about which payees get paid tonight, which is the one thing
 * that view exists to prevent.
 */
export const DEFAULT_PAYOUT_MINIMUM_CENTS = 1000;

/**
 * Default Stripe Connect active-account fee if no FeePolicy is found.
 *
 * ZERO, not 200, on purpose: recovery is an opt-in the platform switches on by
 * setting `connectAccountFeeCents` on the GLOBAL policy. A missing policy must
 * never cause us to start quietly withholding money from payees.
 */
const DEFAULT_CONNECT_ACCOUNT_FEE_CENTS = 0;

/**
 * Mirrors the payee-ledger adapter's `normalizeCurrency`. Every cross-worker
 * claim key derived from a cell's currency MUST go through this: the ledger
 * stores lowercase, so a raw-cased key ("USD" vs "usd") would let two runs
 * claim "different" scopes for the SAME ledger bucket.
 */
const normalizeCurrency = (c: string) => c.trim().toLowerCase();

/**
 * The order-item ids a set of credits attributes revenue to, read from the
 * credit's `metadata.items` (`{ [orderItemId]: contributionCents }`) — the
 * item-level breakdown written at credit time. There is no join table; this
 * is the whole mechanism behind stamping `paidOutAt`.
 */
function orderItemIdsFromCredits(
  credits: readonly ConsumablePayeeLedgerCredit[],
): string[] {
  const ids = new Set<string>();
  for (const credit of credits) {
    const metadata = credit.metadata;
    if (!metadata || typeof metadata !== "object") continue;
    const items = (metadata as { items?: unknown }).items;
    if (!items || typeof items !== "object") continue;
    for (const orderItemId of Object.keys(items as Record<string, unknown>)) {
      ids.add(orderItemId);
    }
  }
  return [...ids];
}

// ── Failure cleanup ─────────────────────────────────────────────────────
//
// Every call is independent — if markFailed throws, the idempotency release
// still runs. There is NO settlement state to unwind any more: a failed item
// simply leaves its credits unconsumed and its payable intact, so the next
// batch re-plans the same money from the ledger.

type PayoutItemRef = {
  payoutItemId: string;
  payeeId: string;
  currency: string;
  /**
   * Set when this item carries a CLAIMED Connect-fee deduction (see
   * CONNECT_FEE_CLAIM_TTL_SECONDS). Released on failure so the fee can be
   * legitimately taken by a later payout this month — the item that failed
   * never activated the account, so Stripe never billed for it.
   */
  connectFeeIdempotencyKey?: string | null;
  /**
   * The cross-run cell claim (spec §6.1) this item holds. Released on failure
   * so the NEXT run may re-plan the cell — without that, a failed item would
   * lock its own payee out for the rest of the claim TTL.
   */
  cellClaimKey?: string | null;
  /**
   * Set when this item carries a CLAIMED reserve plan (hold and/or release —
   * see RESERVE_CLAIM_TTL_SECONDS). Released on failure so the next run can
   * re-plan: the failed item deferred nothing and released nothing (both
   * ledger writes happen only after a successful completion).
   */
  reserveIdempotencyKey?: string | null;
};

/**
 * Duck-typed check for the payment adapter's "the PLATFORM's balance can't
 * fund this transfer" marker (Stripe: `balance_insufficient`). Structural, not
 * `instanceof`, because core must not import the adapter — same shape as the
 * POS pairing flow's `isRegistrationCodeError`.
 */
function isInsufficientPlatformBalanceError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { isInsufficientPlatformBalanceError?: unknown })
      .isInsufficientPlatformBalanceError === true
  );
}

/**
 * `idempotencyKey` is NULLABLE on purpose. The transfer claim is keyed on the
 * CELL HASH and shared across runs, so a run that LOST it must never call
 * `fail` on it — `fail` overwrites a committed record, which would delete the
 * very guard that says "this money already left". Pass null in that case.
 */
async function failItem(
  deps: RunPayoutBatchDeps,
  item: PayoutItemRef,
  idempotencyKey: string | null,
  reason: string,
): Promise<void> {
  const safeRun = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (inner) {
      deps.logger?.error("runPayoutBatch.failItem_cleanup_error", {
        payoutItemId: item.payoutItemId,
        payeeId: item.payeeId,
        step: label,
        error: describeError(inner),
      });
    }
  };

  await safeRun("markPayoutItemFailed", () =>
    deps.repos.payoutItems.markFailed(
      item.payoutItemId,
      deps.clock.now(),
      reason,
    ),
  );
  if (idempotencyKey) {
    await safeRun("idempotencyFail", () =>
      deps.idempotency.fail(idempotencyKey, reason),
    );
  }
  if (item.connectFeeIdempotencyKey) {
    await safeRun("connectFeeClaimRelease", () =>
      deps.idempotency.fail(item.connectFeeIdempotencyKey!, reason),
    );
  }
  if (item.reserveIdempotencyKey) {
    await safeRun("reserveClaimRelease", () =>
      deps.idempotency.fail(item.reserveIdempotencyKey!, reason),
    );
  }
  if (item.cellClaimKey) {
    await safeRun("cellClaimRelease", () =>
      deps.idempotency.fail(item.cellClaimKey!, reason),
    );
  }
}

// ── Implementation ───────────────────────────────────────────────────────────

/**
 * Runs a payout batch off the LEDGER (spec 2026-08-10,
 * ledger-authoritative-settlement §6).
 *
 * One rule: per `(payee, currency)`, pay `max(0, payable)`.
 *
 * - `payable` comes from `payeeLedger.listPayableBalances(now)`: matured,
 *   unblocked SETTLEMENT_CREDITs minus refund debits, dispute debits, prior
 *   payouts and active holds. Credits WAIT for maturity; debits never do —
 *   that asymmetry is the whole P0 fix (a refund inside the pending window
 *   reduces the next transfer the instant it is written, because there is no
 *   second place anyone has to remember to update).
 * - A NEGATIVE payable is a debt position: pay nothing, carry forward. There
 *   is no recovery step, no squaring entry and no crash sweep — the next
 *   cycle's arithmetic recoups it.
 * - Cells below `payoutMinimumCents` (GROSS payable, before any withholding)
 *   are skipped and simply wait for the next batch.
 * - Transfer-time withholding is unchanged from the pre-cutover model: the
 *   rolling reserve on the payout's MEMBERSHIP portion (seasoning curve in
 *   membership-reserve.ts; matured reserve rides back on the same transfer)
 *   then the Stripe Connect active-account fee. Both are stamped on the
 *   PayoutItem and never recomputed. They may consume the whole payout —
 *   that item completes with no Stripe call.
 * - After a successful transfer: a PAYOUT entry for the PAYABLE CLAIMED (not
 *   the transfer amount), FIFO consumption stamped on the covered credits,
 *   and `paidOutAt` on their order items.
 * - On transfer failure, the PayoutItem is marked failed and the batch
 *   continues; nothing was consumed, so the money re-plans next cycle.
 * - One transfer failure is special-cased: Stripe's `balance_insufficient`
 *   means the PLATFORM's float, not the payee, came up short. It is counted
 *   apart from the ordinary failures and trips a per-currency breaker for the
 *   rest of the run (see `itemsFailedInsufficientPlatformBalance`).
 */
export async function runPayoutBatch(
  deps: RunPayoutBatchDeps,
  rawInput: unknown,
): Promise<RunPayoutBatchOutput> {
  const input = parseInput(runPayoutBatchInputSchema, rawInput);
  const now = deps.clock.now();

  // Best-effort error reporting: a missing OR throwing reporter must never
  // change batch behaviour (abort / double-count / mask a graceful failure).
  // Mirrors how `logAndReport` guards `captureException` in the adapters.
  const safeReport = (
    error: unknown,
    context?: Parameters<NonNullable<RunPayoutBatchDeps["reportError"]>>[1],
  ): void => {
    try {
      deps.reportError?.(error, context);
    } catch {
      // Swallow — reporting is fire-and-forget.
    }
  };

  deps.logger?.info("runPayoutBatch.start", {
    limit: input.limit,
    asOf: now.toISOString(),
  });

  let itemsSkippedBelowMinimum = 0;
  let itemsSkippedIneligible = 0;
  let itemsHeldForSuspension = 0;
  let itemsSkippedClaimLost = 0;
  let payeesDeferredByLimit = 0;
  let itemsLedgerHealed = 0;

  const emptyResult = (): RunPayoutBatchOutput => ({
    payoutId: null,
    payeesConsidered: 0,
    itemsCreated: 0,
    itemsTransferred: 0,
    itemsFailed: 0,
    itemsSkippedBelowMinimum,
    itemsSkippedIneligible,
    itemsSkippedPayableDropped: 0,
    itemsSkippedClaimLost,
    itemsFailedInsufficientPlatformBalance: 0,
    payeesDeferredByLimit,
    itemsLedgerHealed,
    itemsHeldForSuspension,
    itemsFullyWithheld: 0,
    totalTransferredCents: 0,
    totalPayableClaimedCents: 0,
    reserveHeldCents: 0,
    itemsWithReserveHeld: 0,
    reserveReleasedCents: 0,
    itemsWithReserveReleased: 0,
    connectFeeCents: 0,
    itemsWithConnectAccountFee: 0,
  });

  /**
   * The ledger side of a payout item whose money has ALREADY moved, applied
   * from a frozen plan. Shared verbatim by the live transfer path and the
   * crash-heal sweep, so the two can never drift:
   *   (a) the PAYOUT entry for the PAYABLE CLAIMED, under the CREDIT-SET key
   *       (`payout:<hash>`) — two runs planning the same credits debit once;
   *   (b) FIFO consumption stamped on exactly those credits;
   *   (c) `paidOutAt` on the order items they attribute to.
   *
   * Returns whether (a) landed. Callers gate the reserve writes on it: if the
   * payable claim did not land, the item is not settled, and burning its
   * reserve releases would leave the heal with nothing to reconstruct.
   *
   * Best-effort by necessity — the money has already moved, so a ledger
   * failure must not fail the item — but reported LOUDLY, because an unwritten
   * PAYOUT entry leaves the payable intact. The durable plan is what makes
   * that recoverable: the next run's sweep replays this exact call.
   */
  const applyPayoutLedgerEffects = async (plan: {
    payoutItemId: string;
    payeeId: string;
    currency: string;
    payableClaimedCents: number;
    payoutLedgerKey: string;
    creditEntryIds: string[];
    orderItemIds: string[];
    netAmountCents: number;
    reserveHeldCents: number;
    reserveReleasedCents: number;
    connectAccountFeeCents: number;
    payoutId: string;
    stripeTransferId: string | null;
  }): Promise<boolean> => {
    let payoutEntryId: string | null = null;
    try {
      const entry = await deps.repos.payeeLedger.payoutDebit({
        idempotencyKey: plan.payoutLedgerKey,
        payeeId: plan.payeeId,
        // THE PAYABLE CLAIMED, never the transfer amount.
        amountCents: plan.payableClaimedCents,
        currency: plan.currency,
        sourceKind: "payout_item",
        sourceId: plan.payoutItemId,
        description: `Payout ${plan.payoutId}`,
        metadata: {
          consumedCreditEntryIds: plan.creditEntryIds,
          payoutId: plan.payoutId,
          stripeTransferId: plan.stripeTransferId,
          transferredCents: plan.netAmountCents,
          reserveHeldCents: plan.reserveHeldCents,
          reserveReleasedCents: plan.reserveReleasedCents,
          connectAccountFeeCents: plan.connectAccountFeeCents,
        },
      });
      payoutEntryId = entry.id;
    } catch (ledgerErr) {
      deps.logger?.error("runPayoutBatch.payout_debit_failed", {
        payoutItemId: plan.payoutItemId,
        payeeId: plan.payeeId,
        payableClaimedCents: plan.payableClaimedCents,
        error: describeError(ledgerErr),
      });
      safeReport(
        ledgerErr instanceof Error
          ? ledgerErr
          : new Error(describeError(ledgerErr)),
        {
          tags: {
            job: "settlements.run-batch",
            step: "payout_debit",
            payeeId: plan.payeeId,
            payoutItemId: plan.payoutItemId,
          },
          extra: {
            payableClaimedCents: plan.payableClaimedCents,
            stripeTransferId: plan.stripeTransferId,
            remediation:
              "PAYOUT entry NOT written — the payable still shows this money as owed. The NEXT run's ledger heal sweep replays it from the item's stored plan (no Stripe call); if it keeps failing, apply a MANUAL_ADJUSTMENT of -payableClaimedCents.",
          },
        },
      );
      return false;
    }

    // Attribution, not arithmetic: consumption records WHICH credits this
    // payout settled so refunds know whether to attempt a transfer reversal
    // and "which orders did this payout cover" stays answerable. ALL of the
    // cell's planned credits are consumed — including any whose cash was
    // absorbed by a debit elsewhere in the balance — because the amount is
    // the payable sum's job, not theirs.
    if (plan.creditEntryIds.length > 0) {
      try {
        const stamped = await deps.repos.payeeLedger.markCreditsConsumed(
          plan.creditEntryIds,
          payoutEntryId,
        );
        if (stamped !== plan.creditEntryIds.length) {
          // Expected on a HEAL replay (the original run already stamped
          // some), a fault on the live path. Reported either way with both
          // counts, never thrown — the transfer already happened.
          const msg = `payout_credit_consumption_mismatch: item ${plan.payoutItemId} expected ${plan.creditEntryIds.length}, stamped ${stamped}`;
          deps.logger?.warn("runPayoutBatch.credit_consumption_mismatch", {
            payoutItemId: plan.payoutItemId,
            payeeId: plan.payeeId,
            expected: plan.creditEntryIds.length,
            stamped,
          });
          safeReport(new Error(msg), {
            tags: {
              job: "settlements.run-batch",
              step: "mark_credits_consumed",
              payeeId: plan.payeeId,
              payoutItemId: plan.payoutItemId,
            },
            extra: {
              creditEntryIds: plan.creditEntryIds,
              remediation:
                "expected on a crash-heal replay (already stamped); on a live payout it means another payout claimed a credit — reconcile the payee's SETTLEMENT_CREDIT consumedByEntryId stamps",
            },
          });
        }
      } catch (consumeErr) {
        deps.logger?.error("runPayoutBatch.mark_credits_consumed_failed", {
          payoutItemId: plan.payoutItemId,
          payeeId: plan.payeeId,
          error: describeError(consumeErr),
        });
        safeReport(
          consumeErr instanceof Error
            ? consumeErr
            : new Error(describeError(consumeErr)),
          {
            tags: {
              job: "settlements.run-batch",
              step: "mark_credits_consumed",
              payeeId: plan.payeeId,
              payoutItemId: plan.payoutItemId,
            },
            extra: { creditEntryIds: plan.creditEntryIds },
          },
        );
      }
    }

    if (plan.orderItemIds.length > 0) {
      try {
        await deps.repos.orderItems.markItemsPaidOut(
          plan.orderItemIds,
          deps.clock.now(),
        );
      } catch (paidOutErr) {
        deps.logger?.error("runPayoutBatch.mark_items_paid_out_failed", {
          payoutItemId: plan.payoutItemId,
          payeeId: plan.payeeId,
          orderItemCount: plan.orderItemIds.length,
          error: describeError(paidOutErr),
        });
        safeReport(
          paidOutErr instanceof Error
            ? paidOutErr
            : new Error(describeError(paidOutErr)),
          {
            tags: {
              job: "settlements.run-batch",
              step: "mark_items_paid_out",
              payeeId: plan.payeeId,
              payoutItemId: plan.payoutItemId,
            },
            extra: {
              remediation:
                "order items not stamped paidOutAt — a later refund will not attempt a transfer reversal for them",
            },
          },
        );
      }
    }
    return true;
  };

  // ── 0. Ledger heal sweep: money that LEFT but the ledger never recorded ───
  //
  // The PAYOUT entry, the credit consumption and the `paidOutAt` stamps all
  // happen AFTER `markTransferred`. A process death in that window leaves a
  // payee who HAS been paid whose payable still says they are owed — and the
  // next batch would pay it again. (The same window also covers a ledger write
  // that simply threw: the live path reports it and moves on, and THIS is the
  // durable retry.)
  //
  // Runs FIRST, before the payable is read, and replays the three writes off
  // the item's frozen plan: no Stripe call, nothing recomputed. Every write is
  // idempotent (`payout:<cell-hash>`, consumed-once, write-once paidOutAt),
  // and the adapter feed returns ONLY items still needing one of its heals —
  // PAYOUT entry missing, or entry present with unstamped `paidOutAt` on a
  // planned order item (a lost stamp makes a later refund skip its transfer
  // reversal). Fully-squared history never replays, which is what keeps
  // `itemsLedgerHealed`'s "non-zero means a real crash" contract true.
  //
  // Bounded by the payees the ledger knows about rather than a time window: an
  // orphan that ages out of a window is a payable that pays twice, which is
  // the exact bug this closes.
  //
  // Failure posture: SWALLOWED and reported. Skipping the heal means the
  // payable may overstate what is owed, so — deliberately — the batch then
  // pays nothing at all this run rather than risk paying twice.
  let healSweepFailed = false;
  {
    // ── 0a. Stale-pending recovery: transfers whose markTransferred was lost
    //
    // A run that dies between committing its transfer claim and
    // `markTransferred` leaves a REAL Stripe transfer on an item still
    // "pending" — invisible to the transferred-only feed below, and the
    // claim-lost probe in the transfer loop only fires when tonight's cell
    // hash COLLIDES with the crashed one. If a new credit matured overnight
    // the hash differs, `begin` succeeds on the new key, and the same money
    // re-sends once both 24h-ish windows expire — active payees whose credit
    // sets change nightly would get the LEAST protection. So recovery here
    // keys on each stale item's own STORED plan, not on a hash collision:
    // probe the item's transfer-claim key (same cell hash as its
    // payoutLedgerKey — `payout:<hash>` → `payout-transfer:<hash>`, see
    // buildCellHash) and re-stamp the item transferred when the committed
    // record names it.
    //
    // Concurrency safety: `get` returns COMMITTED records only (in-progress
    // claims read as null), and a committed record whose payload names THIS
    // item means THIS item's money already left (or its zero-net completion
    // durably committed) — stamping is always safe. A concurrently running
    // same-cell transfer cannot be fought here: that worker owns a DIFFERENT
    // item id, so neither its in-progress claim nor its own committed record
    // can ever name this one. The age cutoff is minutes, not a cycle, and is
    // NOT load-bearing for safety (see STALE_PENDING_MIN_AGE_MS) — it only
    // keeps a live run's just-created rows out of the scan.
    //
    // Failure posture: same as the heal sweep below — an unprobed stale item
    // means the payable may overstate what is owed, so the batch pays
    // NOTHING this run rather than risk paying twice.
    try {
      const staleCutoff = new Date(now.getTime() - STALE_PENDING_MIN_AGE_MS);
      const stalePending =
        await deps.repos.payoutItems.listPendingWithPlanOlderThan(staleCutoff);
      for (const stale of stalePending) {
        const staleClaimKey = transferClaimKeyFromLedgerKey(
          stale.payoutLedgerKey,
        );
        const record = await deps.idempotency.get<{
          stripeTransferId: string | null;
          payoutItemId?: string;
        }>(staleClaimKey);
        // Old-format records (no payoutItemId) and records naming another
        // item both fall out here — no record, no recovery, and the item
        // simply stays pending (it never moved money it can prove).
        if (
          !record ||
          typeof record !== "object" ||
          record.payoutItemId !== stale.id
        ) {
          if (
            record &&
            typeof record === "object" &&
            typeof record.payoutItemId === "string" &&
            record.payoutItemId !== stale.id
          ) {
            // A committed record for this cell that names ANOTHER item: a
            // later same-hash run committed over whatever this item's run
            // did, so the stale item's own send-state is unknowable — and if
            // its run had reached Stripe outside the idempotency-key window,
            // that is a historical double-send. Nothing safe to write here
            // (stamping this item against another item's transfer would
            // fabricate a payout), so surface it for manual reconciliation
            // and move on.
            deps.logger?.error(
              "runPayoutBatch.stale_pending_claim_names_other_item",
              {
                payoutItemId: stale.id,
                otherPayoutItemId: record.payoutItemId,
                payeeId: stale.payeeId,
                currency: stale.currency,
                claimKey: staleClaimKey,
              },
            );
            safeReport(
              new Error(
                `stale_pending_claim_names_other_item: ${stale.id} (record names ${record.payoutItemId})`,
              ),
              {
                tags: {
                  job: "settlements.run-batch",
                  step: "stale_pending_claim_mismatch",
                  payeeId: stale.payeeId,
                  payoutItemId: stale.id,
                },
                extra: {
                  otherPayoutItemId: record.payoutItemId,
                  claimKey: staleClaimKey,
                  currency: stale.currency,
                  remediation:
                    "reconcile manually: check whether this pending item's run reached Stripe before dying — a transfer outside the idempotency window is a double-send",
                },
              },
            );
          }
          continue;
        }
        await deps.repos.payoutItems.markTransferred(
          stale.id,
          record.stripeTransferId ?? null,
          deps.clock.now(),
        );
        deps.logger?.error("runPayoutBatch.stale_pending_recovered", {
          payoutItemId: stale.id,
          payeeId: stale.payeeId,
          currency: stale.currency,
          stripeTransferId: record.stripeTransferId ?? null,
        });
        // A real crash signature, recovered silently otherwise — Sentry
        // must see it (the heal feed below completes the ledger writes).
        safeReport(
          new Error(`stale_pending_transfer_recovered: ${stale.id}`),
          {
            tags: {
              job: "settlements.run-batch",
              step: "stale_pending_recovery",
              payeeId: stale.payeeId,
              payoutItemId: stale.id,
            },
            extra: {
              currency: stale.currency,
              stripeTransferId: record.stripeTransferId ?? null,
            },
          },
        );
      }
    } catch (staleErr) {
      healSweepFailed = true;
      deps.logger?.error("runPayoutBatch.stale_pending_recovery_failed", {
        error: describeError(staleErr),
      });
      safeReport(
        staleErr instanceof Error
          ? staleErr
          : new Error(describeError(staleErr)),
        {
          tags: { job: "settlements.run-batch", step: "stale_pending_recovery" },
          extra: {
            consequence:
              "batch paid NOTHING this run — an unrecovered stale pending item may hide a transfer the payable still counts as owed",
          },
        },
      );
    }

    // ── 0b. Ledger heal feed, bounded by the payees the ledger knows ─────────
    const knownPayeeIds = [
      ...new Set((await deps.repos.payeeLedger.listPayableBalances(now)).map(
        (cell) => cell.payeeId,
      )),
    ];
    if (!healSweepFailed && knownPayeeIds.length > 0) {
      try {
        const needingHeal =
          await deps.repos.payoutItems.listTransferredNeedingLedgerHeal({
            payeeIds: knownPayeeIds,
          });
        for (const item of needingHeal) {
          const healed = await applyPayoutLedgerEffects({
            payoutItemId: item.id,
            payeeId: item.payeeId,
            currency: item.currency,
            payableClaimedCents: item.amountCents,
            payoutLedgerKey: item.payoutLedgerKey,
            creditEntryIds: item.plannedCreditEntryIds,
            orderItemIds: item.plannedOrderItemIds,
            netAmountCents: item.plannedNetCents,
            reserveHeldCents: 0,
            reserveReleasedCents: 0,
            connectAccountFeeCents: 0,
            payoutId: item.payoutId,
            stripeTransferId: item.stripeTransferId,
          });
          if (healed) itemsLedgerHealed++;
        }
      } catch (healErr) {
        healSweepFailed = true;
        deps.logger?.error("runPayoutBatch.ledger_heal_sweep_failed", {
          error: describeError(healErr),
        });
        safeReport(
          healErr instanceof Error ? healErr : new Error(describeError(healErr)),
          {
            tags: { job: "settlements.run-batch", step: "ledger_heal_sweep" },
            extra: {
              consequence:
                "batch paid NOTHING this run — an unhealed payout entry means the payable may overstate what is owed",
            },
          },
        );
      }
    }
  }
  if (healSweepFailed) return emptyResult();

  // ── 1. Plan: what does the ledger say we owe, right now? ──────────────────
  //
  // THE money read. Not the cached rollup (`PayeeLedgerBalance`), which
  // ignores maturity — this is the dated, dispute-aware, claim-aware sum.
  // Negative cells come back as-is and are dropped here: `max(0, payable)`.
  const payables = await deps.repos.payeeLedger.listPayableBalances(now);
  const positivePayables = payables.filter((cell) => cell.payableCents > 0);
  if (positivePayables.length === 0) {
    deps.logger?.info("runPayoutBatch.no_payable_balances", {
      cellsRead: payables.length,
      debtCells: payables.filter((cell) => cell.payableCents < 0).length,
    });
    return emptyResult();
  }

  // `limit` caps PAYEES, not cells: a payee owed money in two currencies is
  // one payee with two transfers, and splitting them across batches would be
  // arbitrary.
  //
  // ORDER MATTERS. The feed arrives oldest-matured-money first (the adapter
  // sorts on `oldestMaturedAt`), so the cap defers the payees who have waited
  // LEAST — and a deferred payee's money is older tomorrow, which is what
  // makes the queue fair instead of a fixed low-id prefix winning every night
  // forever. `payeesDeferredByLimit` surfaces the pressure: persistently
  // non-zero means the cap is too low for the payee base.
  const orderedPayeeIds: string[] = [];
  for (const cell of positivePayables) {
    if (!orderedPayeeIds.includes(cell.payeeId)) orderedPayeeIds.push(cell.payeeId);
  }
  const allowedPayeeIds = new Set(orderedPayeeIds.slice(0, input.limit));
  payeesDeferredByLimit = Math.max(
    0,
    orderedPayeeIds.length - allowedPayeeIds.size,
  );
  const consideredCells = positivePayables.filter((cell) =>
    allowedPayeeIds.has(cell.payeeId),
  );
  const payeesConsidered = allowedPayeeIds.size;

  deps.logger?.info("runPayoutBatch.planned", {
    payableCells: positivePayables.length,
    payeesConsidered,
    consideredCells: consideredCells.length,
  });

  // ── 2. Policy: minimum + Connect fee ──────────────────────────────────────
  // The GLOBAL fee policy. In the future, per-org or per-event overrides could
  // be applied.
  const globalPolicy = await deps.repos.feePolicies.resolveEffective({
    scopeType: "GLOBAL",
    scopeId: null,
    at: now,
  });
  const payoutMinimumCents =
    globalPolicy?.payoutMinimumCents ?? DEFAULT_PAYOUT_MINIMUM_CENTS;
  const connectAccountFeeCents =
    globalPolicy?.connectAccountFeeCents ?? DEFAULT_CONNECT_ACCOUNT_FEE_CENTS;

  // The minimum gates the GROSS payable, before any withholding — the same
  // question the pre-cutover gate asked of the gross settlement total. "Is
  // this balance worth moving at all" is a question about the balance, not
  // about the reserve or the fee riding on it (see connect-account-fee.ts).
  const aboveMinimumCells: PayeeLedgerPayableBalance[] = [];
  for (const cell of consideredCells) {
    if (cell.payableCents < payoutMinimumCents) {
      itemsSkippedBelowMinimum++;
      deps.logger?.info("runPayoutBatch.below_minimum", {
        payeeId: cell.payeeId,
        currency: cell.currency,
        payableCents: cell.payableCents,
        minimum: payoutMinimumCents,
      });
      continue;
    }
    aboveMinimumCells.push(cell);
  }
  if (aboveMinimumCells.length === 0) {
    deps.logger?.info("runPayoutBatch.no_cells_above_minimum", {
      payeesConsidered,
      itemsSkippedBelowMinimum,
    });
    return { ...emptyResult(), payeesConsidered };
  }

  // ── 3. Eligibility: can this payee actually receive money? ────────────────
  //
  // Same three guards as the pre-cutover batch, moved EARLIER: they now skip
  // the cell instead of minting a PayoutItem and failing it. Nothing has been
  // claimed at this point, so a skip leaves the credits untouched and the
  // money simply waits for a batch that runs after the account is fixed.
  //
  // (`Payee.status` is deliberately NOT gated here — it never was, and adding
  // a new gate that withholds money is not a change the ledger cutover should
  // smuggle in. `payoutsEnabled` is the flag the Connect sync maintains.)
  const eligiblePayeeIds = [...new Set(aboveMinimumCells.map((c) => c.payeeId))];
  const payeeRecords = await deps.repos.payees.getByIds(eligiblePayeeIds);
  const payeeMap = new Map(payeeRecords.map((p) => [p.id, p]));

  const eligibleCells: PayeeLedgerPayableBalance[] = [];
  for (const cell of aboveMinimumCells) {
    const payee = payeeMap.get(cell.payeeId) ?? null;
    const reason = payeePayoutBlocker(payee);
    if (reason) {
      itemsSkippedIneligible++;
      const msg = `${reason}: ${cell.payeeId}`;
      deps.logger?.error("runPayoutBatch.payee_ineligible", {
        payeeId: cell.payeeId,
        currency: cell.currency,
        payableCents: cell.payableCents,
        reason,
      });
      // Deliberate swallow (the batch continues) — so it must be reported:
      // this branch never reaches the job error-boundary, and a payee who
      // silently stops being paid is exactly the thing nobody notices.
      safeReport(new Error(msg), {
        tags: {
          job: "settlements.run-batch",
          step: "payee_eligibility",
          payeeId: cell.payeeId,
        },
        extra: { currency: cell.currency, payableCents: cell.payableCents },
      });
      continue;
    }
    eligibleCells.push(cell);
  }
  if (eligibleCells.length === 0) {
    deps.logger?.info("runPayoutBatch.no_eligible_cells", {
      payeesConsidered,
      itemsSkippedBelowMinimum,
      itemsSkippedIneligible,
    });
    return { ...emptyResult(), payeesConsidered };
  }

  // ── 4. Attribution feed: which credits does each cell's payout cover? ─────
  //
  // FIFO by maturity, filtered by the SAME dispute/claim exclusions as the
  // payable sum (one shared SQL fragment in the adapter — the guarantee that
  // the sum and the feed cannot drift is structural, not reviewer
  // discipline). Attribution only: the AMOUNT is always the payable sum,
  // never a sum over these rows. Deliberately NOT swallowed on failure —
  // without the feed there is no honest way to record what a payout covered,
  // so a read failure crashes the run into the job error-boundary rather than
  // paying money we cannot attribute.
  type PlanCell = {
    payeeId: string;
    currency: string;
    payableCents: number;
    credits: ConsumablePayeeLedgerCredit[];
    creditEntryIds: string[];
    orderItemIds: string[];
    hasTicketingRevenue: boolean;
    hasMembershipRevenue: boolean;
    membershipPortionCents: number;
    /** Set once the cross-run cell claim (spec §6.1) is held. */
    cellClaimKey: string | null;
  };

  const planCells: PlanCell[] = [];
  for (const cell of eligibleCells) {
    const credits = await deps.repos.payeeLedger.listConsumableCredits(
      cell.payeeId,
      cell.currency,
      now,
    );
    planCells.push({
      payeeId: cell.payeeId,
      currency: cell.currency,
      payableCents: cell.payableCents,
      credits,
      creditEntryIds: credits.map((c) => c.id),
      orderItemIds: orderItemIdsFromCredits(credits),
      hasTicketingRevenue: false,
      hasMembershipRevenue: false,
      membershipPortionCents: 0,
      cellClaimKey: null,
    });
  }

  // ── 4b. Revenue classification, from the credits' ORDERS ──────────────────
  //
  // Replaces the settlement-line join (`settlementIdsWithOrderKinds`) the
  // ledger model deleted — same question ("does this payout carry ticketing
  // / membership revenue?"), one hop shorter. Feeds three consumers: the
  // suspension circuit breaker, the reserve's membership portion, and the
  // Connect fee.
  //
  // Failure posture: SWALLOWED, with an empty map. Every consumer then reads
  // "neither kind", which is the fail-safe direction for all three — no
  // suspension hold (money owed is never held up by a broken lookup), no new
  // reserve (bounded under-protection), and no fee deduction (the platform
  // absorbs the $2 rather than taking cents it cannot justify).
  const orderKindByOrderId = new Map<string, OrderKind>();
  const allOrderIds = [
    ...new Set(
      planCells.flatMap((cell) =>
        cell.credits
          .map((c) => c.orderId)
          .filter((id): id is string => id != null),
      ),
    ),
  ];
  if (allOrderIds.length > 0) {
    try {
      const kinds = await deps.repos.orders.getKindsByIds(allOrderIds);
      for (const [orderId, kind] of kinds) orderKindByOrderId.set(orderId, kind);
    } catch (kindErr) {
      deps.logger?.error("runPayoutBatch.order_kind_lookup_failed", {
        orderCount: allOrderIds.length,
        error: describeError(kindErr),
      });
      safeReport(
        kindErr instanceof Error ? kindErr : new Error(describeError(kindErr)),
        {
          tags: { job: "settlements.run-batch", step: "order_kind_lookup" },
          extra: {
            orderCount: allOrderIds.length,
            consequence:
              "revenue unclassified this run — no suspension hold, no new reserve, no Connect fee",
          },
        },
      );
    }
  }
  for (const cell of planCells) {
    for (const credit of cell.credits) {
      const kind = credit.orderId
        ? orderKindByOrderId.get(credit.orderId)
        : undefined;
      if (kind === "TICKETING") cell.hasTicketingRevenue = true;
      if (kind === "MEMBERSHIP") cell.hasMembershipRevenue = true;
    }
  }

  // ── 5. Membership suspension circuit breaker ──────────────────────────────
  //
  // MembershipStanding.suspended promises (membership.prisma): "suspends new
  // signups and holds payouts". This is the payout half. Scope, deliberately
  // narrow: a cell is held ONLY when it carries MEMBERSHIP revenue AND the
  // payee's owner is suspended — suspension is a membership circuit breaker
  // (self-dealing cash-out, the same abuse shape the reserve exists for), not
  // a business-wide freeze, so a suspended owner's pure-ticketing cells pay
  // out normally. (Matured reserve releases riding those ticketing cells are
  // likewise NOT frozen here — gating releases is the lost-dispute freeze's
  // job, see isReserveReleaseFrozen.)
  //
  // Runs HERE — before ANY money planning (reserve, fee) and before the
  // Payout/PayoutItem rows are minted — so the unwind is NOTHING at all: the
  // held cell's credits were never consumed, so it simply waits for a batch
  // that runs after unsuspension, at which point it pays normally. (Under the
  // settlement model this step had to release a claim; the ledger model has
  // no claim to release, which is the deletion working as intended.)
  //
  // Read order is cheapest-first: the standings table is tiny by construction
  // (rows exist only where someone intervened — see
  // MembershipStandingsRepo.listAll).
  //
  // Failure posture: a lookup failure is SWALLOWED and every cell pays
  // normally this run — the file-wide one-directional fail-safe (money owed
  // is never held up by a broken lookup). Reported loudly, because paying a
  // suspended owner is exactly what this step exists to prevent; the standing
  // is re-read next run.
  let unheldCells = planCells;
  try {
    const membershipCells = planCells.filter((c) => c.hasMembershipRevenue);
    if (membershipCells.length > 0) {
      const allStandings = await deps.repos.membershipStandings.listAll();
      const suspendedOwnerKeys = new Set(
        allStandings
          .filter((s) => s.suspended)
          .map((s) =>
            s.ownerOrgId ? `ORG:${s.ownerOrgId}` : `HUMAN:${s.ownerHumanId}`,
          ),
      );
      if (suspendedOwnerKeys.size > 0) {
        const ownerKeyByPayee = new Map(
          payeeRecords.map((payee) => [
            payee.id,
            payee.subjectType === "ORGANIZATION"
              ? `ORG:${payee.subjectId}`
              : `HUMAN:${payee.subjectId}`,
          ]),
        );
        const kept: PlanCell[] = [];
        for (const cell of planCells) {
          const ownerKey = ownerKeyByPayee.get(cell.payeeId);
          if (
            cell.hasMembershipRevenue &&
            ownerKey &&
            suspendedOwnerKeys.has(ownerKey)
          ) {
            itemsHeldForSuspension++;
            deps.logger?.warn("runPayoutBatch.held_for_suspended_standing", {
              payeeId: cell.payeeId,
              currency: cell.currency,
              payableCents: cell.payableCents,
            });
            continue;
          }
          kept.push(cell);
        }
        unheldCells = kept;
      }
    }
  } catch (suspensionErr) {
    unheldCells = planCells;
    itemsHeldForSuspension = 0;
    deps.logger?.error("runPayoutBatch.suspension_hold_lookup_failed", {
      payeeIds: planCells.map((c) => c.payeeId),
      error: describeError(suspensionErr),
    });
    safeReport(
      suspensionErr instanceof Error
        ? suspensionErr
        : new Error(describeError(suspensionErr)),
      {
        tags: {
          job: "settlements.run-batch",
          step: "membership_suspension_hold",
        },
        extra: {
          payeeIds: planCells.map((c) => c.payeeId),
          consequence:
            "suspension hold skipped this run — membership payouts proceed",
        },
      },
    );
  }

  // ── 5b. Cross-RUN cell claim (spec §6.1) ──────────────────────────────────
  //
  // THE guard the per-item keys structurally cannot be. Every other key in
  // this batch derives from identifiers minted fresh per run, so two
  // overlapping runs (the daily cron and a manual
  // `POST /jobs/settlements.run-batch` are not mutually exclusive) both read
  // the same payable, both plan the same credits, and both reach the ledger.
  // Stripe dedupes the TRANSFER on the credit-set key, so the visible damage
  // is not a double payment — it is the payee debited TWICE for one transfer.
  //
  // Claimed BEFORE any money planning (reserve, fee) and before the
  // Payout/PayoutItem rows exist, so a loser's unwind is nothing at all: no
  // row, no claim, no consumed credit. Committed when the item completes,
  // released on failure, scoped to the UTC cycle date so a genuinely new day
  // always re-plans. A cell we cannot claim is DEFERRED, never paid late by
  // guessing.
  //
  // Also refuses a cell with NO consumable credits: the cell hash would
  // collapse to a per-payee constant (the empty id list), silently aliasing
  // this transfer with any other empty-credit transfer for the same payee.
  // A positive payable with nothing to attribute it to is an integrity
  // question, not something to pay out.
  const cycleDate = now.toISOString().slice(0, 10);
  const batch: PlanCell[] = [];
  for (const cell of unheldCells) {
    if (cell.creditEntryIds.length === 0) {
      itemsSkippedClaimLost++;
      const msg = `payable_without_consumable_credits: ${cell.payeeId}:${cell.currency}`;
      deps.logger?.error("runPayoutBatch.payable_without_credits", {
        payeeId: cell.payeeId,
        currency: cell.currency,
        payableCents: cell.payableCents,
      });
      safeReport(new Error(msg), {
        tags: {
          job: "settlements.run-batch",
          step: "empty_credit_set",
          payeeId: cell.payeeId,
        },
        extra: {
          payableCents: cell.payableCents,
          consequence: "cell skipped — a payable with no credits to attribute",
        },
      });
      continue;
    }
    const cellClaimKey = `payout:${cell.payeeId}:${normalizeCurrency(cell.currency)}:${cycleDate}`;
    const cellClaimed = await deps.idempotency.begin(
      cellClaimKey,
      CELL_CLAIM_TTL_SECONDS,
    );
    if (!cellClaimed) {
      itemsSkippedClaimLost++;
      deps.logger?.warn("runPayoutBatch.cell_claim_lost", {
        payeeId: cell.payeeId,
        currency: cell.currency,
        cellClaimKey,
        payableCents: cell.payableCents,
      });
      continue;
    }
    cell.cellClaimKey = cellClaimKey;
    batch.push(cell);
  }
  if (batch.length === 0) {
    deps.logger?.info("runPayoutBatch.no_qualifying_cells", {
      payeesConsidered,
      itemsSkippedBelowMinimum,
      itemsSkippedIneligible,
      itemsHeldForSuspension,
    });
    return { ...emptyResult(), payeesConsidered };
  }

  const batchPayeeIds = [...new Set(batch.map((c) => c.payeeId))];

  // ── 6. Rolling reserve on membership revenue ──────────────────────────────
  //
  // Spec 2026-08-05 ("Dispute policy"): hold a percentage of MEMBERSHIP
  // payout revenue, released after `releaseDays` if no dispute lands. A
  // reserve is DEFERRED PAYOUT, not revenue and not debt — the cents stay on
  // the platform balance (tracked on `reserveBalanceCents` via RESERVE_HOLD
  // entries) and ride back to the payee on a later payout once matured. The
  // rate comes from the seasoning curve (membership-reserve.ts): manual
  // standing override > recent lost dispute > payout track record. It applies
  // from a payee's FIRST membership payout — a brand-new payee has no dispute
  // history, and that is precisely when self-dealing cash-out risk peaks.
  //
  // UNCHANGED from the pre-cutover batch except for where the membership
  // portion comes from: the credits' orders instead of the settlement lines'.
  // Reserves deliberately do NOT enter the payable query — whether they
  // should is a separate product question, and behaviour must not drift
  // during a rearchitecture (spec §5).
  //
  //   * Decided on the planned payable.
  //   * Stamped onto the PayoutItem at creation (`reserveHeldCents`,
  //     `reserveReleasedCents`); the transfer reads the persisted row and
  //     never recomputes.
  //   * Ledger entries written only after the item actually completes, with
  //     the pre-batch sweep (6a) as the crash heal.
  //   * Guarded by a cross-worker claim (`reserve-plan:<payee>:<ccy>`, see
  //     RESERVE_CLAIM_TTL_SECONDS). Losing the claim holds AND releases
  //     nothing this run — the fail-safe direction on both sides.
  //
  // Deduction order is reserve → fee: the reserve is the payee's own money
  // deferred, the fee is a convenience recovery. The reserve is clamped to
  // the payable (it may consume the whole thing — full deferral is correct
  // for a reserve; that zero-net case completes without a Stripe call).
  //
  // RELEASE mechanics: matured holds are added to the SAME payout's transfer
  // (`transfer = payable − reserve − fee + released`). Selection is the
  // MAXIMAL ELIGIBLE PREFIX of the payee+currency's unreleased holds, oldest
  // first — never skip-a-hold-and-release-a-later-one. That prefix rule is
  // load-bearing for the crash sweep: it makes the released set
  // reconstructible later as "oldest unreleased holds summing to the stamped
  // amount". A recent LOST membership dispute freezes ALL releases for the
  // owner until the lost-dispute window clears (see isReserveReleaseFrozen
  // for the exact — deliberately owner-level — rule). A payee with matured
  // reserve but no current payable is not in any batch: their money simply
  // waits for their next payout.
  type ReservePlan = {
    heldCents: number;
    releasedCents: number;
    reserveBps: number;
    releaseDays: number;
    basis: MembershipReserveBasis;
    membershipPortionCents: number;
    /** Matured hold entry ids whose amounts sum to `releasedCents`. */
    releasedHoldEntryIds: string[];
    claimKey: string;
  };
  const reserveByCellIndex = new Map<number, ReservePlan>();

  // ── 6a. Crash sweep: heal reserve ledger writes lost mid-run ──────────────
  //
  // Both reserve ledger writes happen AFTER markTransferred, so a process
  // death in that window leaves a transferred item whose stamped reserve the
  // ledger never heard of:
  //   * missing RESERVE_HOLD  → the payee's deferred cents never mature —
  //     money silently lost to them;
  //   * missing RESERVE_RELEASE → the hold still looks outstanding, and the
  //     next batch would mature it AGAIN — money released (and paid) twice.
  // Holds replay on their per-item key (`reserve-hold:<id>`, idempotent).
  // Releases are reconstructed per item: stamped `reserveReleasedCents`
  // minus what is already written (summed by sourceId), then the oldest
  // unreleased holds are taken until the remainder is exactly consumed —
  // valid because the release decision only ever takes oldest-first
  // prefixes. A remainder that cannot be matched exactly is an integrity
  // violation: reported loudly, nothing written (the money already moved;
  // guessing could double-release) — AND the whole reserve step is skipped
  // this run (`reserveSweepFailed`), because the unmatched holds would
  // otherwise still look releasable to the planner below and could be
  // released again onto a fresh transfer.
  //
  // Failure posture: if the sweep fails we cannot trust hold state, so the
  // ENTIRE reserve step is skipped this run — no new holds (bounded
  // under-protection) and no releases (money waits a batch). Reported.
  let reserveSweepFailed = false;
  try {
    const reserveActivity =
      await deps.repos.payoutItems.listTransferredWithReserveActivity({
        payeeIds: batchPayeeIds,
      });

    for (const swept of reserveActivity) {
      if (swept.reserveHeldCents <= 0) continue;
      await deps.repos.payeeLedger.reserveHold({
        idempotencyKey: `reserve-hold:${swept.id}`,
        payeeId: swept.payeeId,
        amountCents: swept.reserveHeldCents,
        currency: swept.currency,
        payoutItemId: swept.id,
        description: `Rolling reserve withheld from payout ${swept.payoutId}`,
        metadata: { payoutId: swept.payoutId, source: "crash_sweep" },
      });
    }

    const sweptWithReleases = reserveActivity.filter(
      (r) => r.reserveReleasedCents > 0,
    );
    if (sweptWithReleases.length > 0) {
      const releasedSums =
        await deps.repos.payeeLedger.sumReserveReleasedByPayoutItem(
          sweptWithReleases.map((r) => r.id),
        );
      // Items in createdAt order (the repo guarantees it): earlier items
      // released earlier prefixes, so healing in order consumes the hold
      // list front-to-back exactly as the original decisions did.
      //
      // Once ONE item in a payee+currency scope fails to reconstruct, every
      // LATER item in that scope reads a hold list still fronted by the
      // unhealed prefix — its own reconstruction could then release the
      // WRONG holds. So a mismatch poisons its whole scope for this sweep:
      // later same-scope items are skipped (their heal waits for the manual
      // reconciliation the report asks for). Other payees' heals continue.
      const mismatchedReleaseScopes = new Set<string>();
      for (const swept of sweptWithReleases) {
        const sweptScopeKey = `${swept.payeeId}::${normalizeCurrency(swept.currency)}`;
        if (mismatchedReleaseScopes.has(sweptScopeKey)) continue;
        const alreadyCents = releasedSums.get(swept.id) ?? 0;
        const remainderCents = swept.reserveReleasedCents - alreadyCents;
        if (remainderCents <= 0) continue;

        const holds = (
          await deps.repos.payeeLedger.listUnreleasedReserveHolds([
            swept.payeeId,
          ])
        ).filter(
          // Both sides normalised — same hazard as the hold map above.
          (h) =>
            normalizeCurrency(h.currency) === normalizeCurrency(swept.currency),
        );

        let remaining = remainderCents;
        const toRelease: string[] = [];
        for (const hold of holds) {
          if (remaining <= 0) break;
          if (hold.amountCents > remaining) break;
          toRelease.push(hold.id);
          remaining -= hold.amountCents;
        }
        if (remaining !== 0) {
          // Integrity violation — engage the SAME fail-safe as a sweep
          // failure: the unmatched holds still look outstanding, so if the
          // planning step (6b) ran it could mature them AGAIN onto a fresh
          // transfer — the exact double-release this reconstruction exists
          // to prevent. Setting the flag skips the whole reserve step this
          // run (no new holds, no releases); the money already moved, so
          // nothing is written here either.
          reserveSweepFailed = true;
          mismatchedReleaseScopes.add(sweptScopeKey);
          const msg = `reserve_release_sweep_mismatch: item ${swept.id} stamped ${swept.reserveReleasedCents}, written ${alreadyCents}, unmatchable remainder ${remaining}`;
          deps.logger?.error("runPayoutBatch.reserve_release_sweep_mismatch", {
            payoutItemId: swept.id,
            payeeId: swept.payeeId,
            currency: swept.currency,
            stampedReleasedCents: swept.reserveReleasedCents,
            alreadyWrittenCents: alreadyCents,
            unmatchedCents: remaining,
          });
          safeReport(new Error(msg), {
            tags: {
              job: "settlements.run-batch",
              step: "reserve_release_sweep",
              payeeId: swept.payeeId,
              payoutItemId: swept.id,
            },
            extra: {
              remediation:
                "release entries for this transferred item could not be reconstructed — reconcile the payee's RESERVE_HOLD entries manually",
            },
          });
          continue;
        }
        for (const holdId of toRelease) {
          await deps.repos.payeeLedger.reserveRelease({
            idempotencyKey: `reserve-release:${holdId}`,
            holdEntryId: holdId,
            payoutItemId: swept.id,
            description: `Rolling reserve released by payout ${swept.payoutId}`,
            metadata: { payoutId: swept.payoutId, source: "crash_sweep" },
          });
        }
      }
    }
  } catch (sweepErr) {
    reserveSweepFailed = true;
    deps.logger?.error("runPayoutBatch.reserve_sweep_failed", {
      payeeIds: batchPayeeIds,
      error: describeError(sweepErr),
    });
    safeReport(
      sweepErr instanceof Error ? sweepErr : new Error(describeError(sweepErr)),
      {
        tags: { job: "settlements.run-batch", step: "reserve_sweep" },
        extra: {
          payeeIds: batchPayeeIds,
          consequence:
            "reserve step skipped this run — hold state could not be trusted",
        },
      },
    );
  }

  // ── 6b. Plan holds and releases per cell ──────────────────────────────────
  if (!reserveSweepFailed) {
    try {
      const unreleasedHolds =
        await deps.repos.payeeLedger.listUnreleasedReserveHolds(batchPayeeIds);
      const holdsByPayeeCurrency = new Map<string, typeof unreleasedHolds>();
      for (const hold of unreleasedHolds) {
        // Normalised to match BOTH reads of this map below. Built raw and
        // read normalised, a hold whose stored currency is not already
        // lowercase hashes to a key nothing looks up — so no RESERVE_RELEASE
        // is planned and the payee's deferred cents are never returned.
        const key = `${hold.payeeId}::${normalizeCurrency(hold.currency)}`;
        const list = holdsByPayeeCurrency.get(key);
        if (list) list.push(hold);
        else holdsByPayeeCurrency.set(key, [hold]);
      }

      const anyReserveWork = batch.some(
        (cell) =>
          cell.hasMembershipRevenue ||
          (holdsByPayeeCurrency.get(
            `${cell.payeeId}::${normalizeCurrency(cell.currency)}`,
          )?.length ?? 0) > 0,
      );

      if (anyReserveWork) {
        // The MEMBERSHIP portion of each cell's payout, computed from the
        // credits it consumes: per membership order, the credit's amount
        // NET of that order's refund debits (plus any transfer-reversal
        // credits, which only exist post-payout but are netted anyway so the
        // arithmetic is right by construction rather than by timing luck).
        // Floored at zero per order — an over-refunded order contributes
        // nothing to the reserve basis rather than a negative.
        //
        // Only MEMBERSHIP orders are read: the reserve applies to nothing
        // else, and ticketing volume is where the row count lives.
        // ONE read for every membership order in the run — never per credit.
        // (Ticketing orders are deliberately not fetched: the reserve applies
        // to nothing else, and ticketing is where the row count lives.)
        const membershipOrderIds = [
          ...new Set(
            batch
              .filter((cell) => cell.hasMembershipRevenue)
              .flatMap((cell) =>
                cell.credits
                  .map((credit) => credit.orderId)
                  .filter(
                    (orderId): orderId is string =>
                      orderId != null &&
                      orderKindByOrderId.get(orderId) === "MEMBERSHIP",
                  ),
              ),
          ),
        ];
        const entriesByOrderId =
          membershipOrderIds.length > 0
            ? await deps.repos.payeeLedger.listOrderEntriesForOrders(
                membershipOrderIds,
              )
            : new Map();
        const netContributionCents = (
          cell: PlanCell,
          credit: ConsumablePayeeLedgerCredit,
        ): number => {
          if (!credit.orderId) return 0;
          const entries = entriesByOrderId.get(credit.orderId) ?? [];
          let net = credit.amountCents;
          for (const entry of entries) {
            if (
              entry.payeeId !== cell.payeeId ||
              // Both sides normalised: a legacy 'USD' refund must still net
              // out of a 'usd' cell's reserve basis.
              normalizeCurrency(entry.currency) !==
                normalizeCurrency(cell.currency)
            ) {
              continue;
            }
            if (entry.type === "REFUND_DEBIT") net -= entry.amountCents;
            if (entry.type === "TRANSFER_REVERSAL_CREDIT") {
              net += entry.amountCents;
            }
          }
          return Math.max(0, net);
        };

        for (const cell of batch) {
          if (!cell.hasMembershipRevenue) continue;
          let portion = 0;
          for (const credit of cell.credits) {
            const kind = credit.orderId
              ? orderKindByOrderId.get(credit.orderId)
              : undefined;
            if (kind !== "MEMBERSHIP") continue;
            portion += netContributionCents(cell, credit);
          }
          // Never let the basis exceed what is actually payable: refunds and
          // dispute debits that the payable already absorbed must not inflate
          // the reserve basis.
          cell.membershipPortionCents = Math.min(portion, cell.payableCents);
        }

        // Owner resolution + curve inputs, all batched — never per-payee.
        // Standings and lost-dispute recency are keyed by OWNER (org/human),
        // reached through the payee's subject; track record is keyed by
        // PAYEE directly.
        const ownerKeyByPayeeId = new Map(
          payeeRecords.map((payee) => [
            payee.id,
            payee.subjectType === "ORGANIZATION"
              ? `ORG:${payee.subjectId}`
              : `HUMAN:${payee.subjectId}`,
          ]),
        );
        const ownerKeyOf = (
          ownerOrgId: string | null,
          ownerHumanId: string | null,
        ) => (ownerOrgId ? `ORG:${ownerOrgId}` : `HUMAN:${ownerHumanId}`);

        const [
          standings,
          lostRows,
          firstMembershipByPayee,
          firstTicketingByPayee,
        ] = await Promise.all([
          deps.repos.membershipStandings.listAll(),
          deps.repos.disputes.latestLostMembershipDisputeAtByOwner(),
          deps.repos.payoutItems.earliestTransferredPayoutAtByPayee({
            payeeIds: batchPayeeIds,
            orderKind: "MEMBERSHIP",
          }),
          deps.repos.payoutItems.earliestTransferredPayoutAtByPayee({
            payeeIds: batchPayeeIds,
            orderKind: "TICKETING",
          }),
        ]);
        const standingByOwner = new Map(
          standings.map((s) => [ownerKeyOf(s.ownerOrgId, s.ownerHumanId), s]),
        );
        const latestLostByOwner = new Map(
          lostRows.map((r) => [
            ownerKeyOf(r.ownerOrgId, r.ownerHumanId),
            r.latestLostAt,
          ]),
        );

        for (const [index, cell] of batch.entries()) {
          const membershipPortionCents = cell.membershipPortionCents;
          const holds =
            holdsByPayeeCurrency.get(
              `${cell.payeeId}::${normalizeCurrency(cell.currency)}`,
            ) ?? [];
          if (membershipPortionCents <= 0 && holds.length === 0) continue;

          const ownerKey = ownerKeyByPayeeId.get(cell.payeeId) ?? null;
          const standing = ownerKey
            ? (standingByOwner.get(ownerKey) ?? null)
            : null;
          const latestLostAt = ownerKey
            ? (latestLostByOwner.get(ownerKey) ?? null)
            : null;

          const curve = computeMembershipReserve({
            now,
            standing: standing
              ? {
                  reserveBps: standing.reserveBps,
                  reserveReleaseDays: standing.reserveReleaseDays,
                  overriddenBy: standing.overriddenBy,
                }
              : null,
            latestLostDisputeAt: latestLostAt,
            firstMembershipPayoutAt:
              firstMembershipByPayee.get(cell.payeeId) ?? null,
            firstTicketingPayoutAt:
              firstTicketingByPayee.get(cell.payeeId) ?? null,
          });

          const heldCents = computeReserveHoldCents({
            membershipPortionCents,
            reserveBps: curve.reserveBps,
            headroomCents: cell.payableCents,
          });

          // Maximal eligible PREFIX, oldest first (see the step comment for
          // why the prefix rule — never skip-and-take-later — is what keeps
          // the crash sweep able to reconstruct this selection).
          let releasedCents = 0;
          const releasedHoldEntryIds: string[] = [];
          const frozen = isReserveReleaseFrozen(latestLostAt, now);
          if (!frozen) {
            for (const hold of holds) {
              const matured =
                now.getTime() - hold.createdAt.getTime() >=
                curve.releaseDays * DAY_MS;
              if (!matured) break;
              releasedCents += hold.amountCents;
              releasedHoldEntryIds.push(hold.id);
            }
          } else if (holds.length > 0) {
            deps.logger?.info("runPayoutBatch.reserve_release_frozen", {
              payeeId: cell.payeeId,
              currency: cell.currency,
              unreleasedHoldCount: holds.length,
              latestLostDisputeAt: latestLostAt?.toISOString() ?? null,
            });
          }

          if (heldCents <= 0 && releasedCents <= 0) continue;

          // Cross-worker plan claim (see RESERVE_CLAIM_TTL_SECONDS for the
          // full lifecycle — the release side is the one that MUST be
          // single-writer). NORMALIZED currency: the holds this plan may
          // release live in a lowercase-currency ledger bucket, so the
          // single-writer scope must match it.
          const reserveClaimKey = `reserve-plan:${cell.payeeId}:${normalizeCurrency(cell.currency)}`;
          const reserveClaimed = await deps.idempotency.begin(
            reserveClaimKey,
            RESERVE_CLAIM_TTL_SECONDS,
          );
          if (!reserveClaimed) {
            deps.logger?.warn("runPayoutBatch.reserve_claim_lost", {
              payeeId: cell.payeeId,
              currency: cell.currency,
              reserveClaimKey,
              heldCentsForgone: heldCents,
              releasedCentsDeferred: releasedCents,
            });
            continue;
          }

          reserveByCellIndex.set(index, {
            heldCents,
            releasedCents,
            reserveBps: curve.reserveBps,
            releaseDays: curve.releaseDays,
            basis: curve.basis,
            membershipPortionCents,
            releasedHoldEntryIds,
            claimKey: reserveClaimKey,
          });
          deps.logger?.info("runPayoutBatch.reserve_planned", {
            payeeId: cell.payeeId,
            currency: cell.currency,
            payableCents: cell.payableCents,
            membershipPortionCents,
            reserveBps: curve.reserveBps,
            releaseDays: curve.releaseDays,
            basis: curve.basis,
            heldCents,
            releasedCents,
            releasedHoldEntryIds,
          });
        }
      }
    } catch (reserveErr) {
      // Same one-directional posture as the fee lookup below: hold nothing,
      // release nothing this run. Any plan claims begun before the throw are
      // left to expire (an hour of forgone reserve work). Reported — this
      // branch never reaches the job error-boundary.
      reserveByCellIndex.clear();
      deps.logger?.error("runPayoutBatch.reserve_planning_failed", {
        payeeIds: batchPayeeIds,
        error: describeError(reserveErr),
      });
      safeReport(
        reserveErr instanceof Error
          ? reserveErr
          : new Error(describeError(reserveErr)),
        {
          tags: { job: "settlements.run-batch", step: "reserve_planning" },
          extra: { payeeIds: batchPayeeIds },
        },
      );
    }
  }

  // ── 7. Connect active-account fee: decide the deduction per cell ──────────
  //
  // Stripe bills the PLATFORM $2 per Express connected account, but only for
  // calendar months in which that account RECEIVES a payout. So the fee is
  // triggered by the payout, and we recover it by withholding from that same
  // payout — never by charging separately (collecting $2 costs ~$0.36 in
  // processing, an 18% loss on the recovery).
  //
  // Computed HERE — after the payable is settled, before the Payout/PayoutItem
  // rows exist — for three reasons:
  //   * The minimum gate (step 2) has already run on the GROSS payable, so the
  //     spec's guarantee holds: a balance below the minimum does not pay out
  //     and is therefore never charged the $2.
  //   * `batch` is the final set of cells that will actually transfer.
  //     Deciding on anything earlier would price cells we then drop for
  //     ineligibility or a suspended standing.
  //   * Nothing from this run exists in the DB yet, so the "has this payee
  //     already been paid this month?" lookup cannot see this very payout and
  //     mistake it for its own evidence.
  // The result is stamped onto the PayoutItem at creation and never recomputed,
  // so a re-run reads the stored value and cannot double-deduct.
  const connectFeeByCellIndex = new Map<
    number,
    {
      deductionCents: number;
      reason: ConnectAccountFeeReason;
      /** Set only when a deduction was stamped under a cross-worker claim. */
      idempotencyKey: string | null;
    }
  >();
  let connectFeeLookupFailed = false;

  if (connectAccountFeeCents > 0) {
    const monthStart = startOfUtcMonth(now);
    // "2026-03" — the UTC calendar month the claim is scoped to.
    const feeMonthLabel = monthStart.toISOString().slice(0, 7);

    try {
      const activePayeeIds =
        await deps.repos.payoutItems.payeeIdsWithTransferredPayoutInPeriod({
          payeeIds: batchPayeeIds,
          from: monthStart,
          to: now,
        });

      // A payee with payable in two currencies produces two cells and two
      // transfers, but Stripe still bills the account ONCE for the month. Mark
      // the payee active as soon as its first cell is queued for transfer so
      // the sibling cell is never charged again. (If that first transfer then
      // fails the account may not actually go active — we accept under-
      // recovering there rather than risk taking $2 twice.)
      const willBeActiveThisRun = new Set<string>();

      for (const [index, cell] of batch.entries()) {
        const reservePlan = reserveByCellIndex.get(index);
        const deduction = computeConnectAccountFeeDeduction({
          groupTotalCents: cell.payableCents,
          feeCents: connectAccountFeeCents,
          payoutMinimumCents,
          hasTicketingRevenueInPayout: cell.hasTicketingRevenue,
          hasMembershipRevenueInPayout: cell.hasMembershipRevenue,
          accountAlreadyActiveThisMonth:
            activePayeeIds.has(cell.payeeId) ||
            willBeActiveThisRun.has(cell.payeeId),
          // The rolling reserve runs first and shrinks what the fee may take
          // (deduction order: reserve → fee).
          priorWithholdingCents: reservePlan?.heldCents ?? 0,
        });
        // "Will be active" requires an actual Stripe payout: a cell whose
        // entire net is consumed by withholding makes NO transfer, so it does
        // not activate the account and must not shield a sibling currency
        // cell from a legitimate deduction. Matured reserve releases count
        // TOWARD a transfer — they are sent.
        const willTransfer =
          cell.payableCents -
            (reservePlan?.heldCents ?? 0) +
            (reservePlan?.releasedCents ?? 0) >=
          MIN_NET_TRANSFER_CENTS;
        if (willTransfer) willBeActiveThisRun.add(cell.payeeId);

        if (deduction.deductionCents <= 0) {
          connectFeeByCellIndex.set(index, {
            ...deduction,
            idempotencyKey: null,
          });
          continue;
        }

        // Cross-worker double-deduction guard. The in-run set above cannot
        // span workers: two concurrent batch runs could both observe the
        // payee as not-yet-active and both stamp a $2 deduction. Claiming
        // (payee, month) through the shared IdempotencyPort closes that: only
        // the claim winner deducts. Deliberately NO currency in the key —
        // Stripe bills the $2 per ACCOUNT-month, so a payee's USD and CAD
        // cells (split across two concurrent runs) must contend for the same
        // claim or each would stamp its own $2. The daily job is nominally a
        // singleton — this is defence-in-depth, and losing the claim errs
        // toward under-recovery (see CONNECT_FEE_CLAIM_TTL_SECONDS for the
        // release/commit lifecycle).
        const feeKey = `connect-fee:${cell.payeeId}:${feeMonthLabel}`;
        const feeClaimed = await deps.idempotency.begin(
          feeKey,
          CONNECT_FEE_CLAIM_TTL_SECONDS,
        );
        if (!feeClaimed) {
          deps.logger?.warn("runPayoutBatch.connect_fee_claim_lost", {
            payeeId: cell.payeeId,
            currency: cell.currency,
            feeKey,
          });
          connectFeeByCellIndex.set(index, {
            deductionCents: 0,
            reason: "fee_already_claimed_this_month",
            idempotencyKey: null,
          });
          continue;
        }
        connectFeeByCellIndex.set(index, {
          ...deduction,
          idempotencyKey: feeKey,
        });
      }
    } catch (feeErr) {
      // SWALLOWED so a lookup failure can never hold up money that is already
      // owed. The consequence is bounded and one-directional: we deduct nothing
      // this run and the platform absorbs the $2, which is strictly safer than
      // guessing a withholding. (Any month-claims begun before the throw are
      // simply left to expire — an hour of possible under-recovery, same
      // direction.) Reported because this branch is otherwise invisible — it
      // never reaches the job error-boundary.
      connectFeeLookupFailed = true;
      connectFeeByCellIndex.clear();
      deps.logger?.error("runPayoutBatch.connect_fee_lookup_failed", {
        payeeIds: batchPayeeIds,
        error: describeError(feeErr),
      });
      safeReport(
        feeErr instanceof Error ? feeErr : new Error(describeError(feeErr)),
        {
          tags: { job: "settlements.run-batch", step: "connect_account_fee" },
          extra: { payeeIds: batchPayeeIds, connectAccountFeeCents },
        },
      );
    }
  }

  // ── 8. Create the Payout record ───────────────────────────────────────────
  const payout = await deps.repos.payouts.create({ scheduledFor: now });
  await deps.repos.payouts.markRunning(payout.id, now);

  deps.logger?.info("runPayoutBatch.payout_created", {
    payoutId: payout.id,
    itemCount: batch.length,
  });

  // ── 9. Create PayoutItems ─────────────────────────────────────────────────
  // Payout + PayoutItem STAY (spec §6.5): they are the record of batch runs
  // and real Stripe transfers. What they no longer carry is settlement
  // linkage — "which orders did this payout cover" is answered by the PAYOUT
  // ledger entry's `metadata.consumedCreditEntryIds` and the credits'
  // `consumedByEntryId` stamp.
  const payoutItemRecords = await deps.repos.payoutItems.createMany(
    batch.map((cell, index) => {
      const reserveHeldCents = reserveByCellIndex.get(index)?.heldCents ?? 0;
      const reserveReleasedCents =
        reserveByCellIndex.get(index)?.releasedCents ?? 0;
      const connectAccountFeeCents =
        connectFeeByCellIndex.get(index)?.deductionCents ?? 0;
      return {
        payoutId: payout.id,
        payeeId: cell.payeeId,
        currency: cell.currency,
        // The PAYABLE CLAIMED — gross, before any transfer-time withholding.
        // Identical to the amount the PAYOUT ledger entry will record.
        amountCents: cell.payableCents,
        reserveHeldCents,
        reserveReleasedCents,
        connectAccountFeeCents,
        // THE DURABLE PLAN. Frozen here, before a single cent moves, because
        // every input to it drifts the moment a transfer lands: the Connect
        // fee sees the account go active, the reserve sees its releases
        // written. A recovery that RECOMPUTED the plan would compute a
        // different amount and a different Stripe key — which is how a
        // crashed run turns into a second real transfer. Recovery replays
        // THIS instead, as a pure ledger write.
        plannedCreditEntryIds: cell.creditEntryIds,
        plannedOrderItemIds: cell.orderItemIds,
        plannedNetCents:
          cell.payableCents -
          reserveHeldCents -
          connectAccountFeeCents +
          reserveReleasedCents,
        payoutLedgerKey: buildPayoutLedgerKey(
          cell.payeeId,
          cell.currency,
          cell.creditEntryIds,
        ),
      };
    }),
  );

  const payoutItems = payoutItemRecords.map((record, i) => {
    const cell = batch[i]!;
    const fee = connectFeeByCellIndex.get(i);
    const reservePlan = reserveByCellIndex.get(i);
    // Read the deductions back off the PERSISTED row, not off the in-memory
    // maps: the stored values are what a re-run would see, so sourcing the
    // transfer amount from them makes "computed once, never recomputed"
    // literal rather than merely intended.
    const connectFeeCents = record.connectAccountFeeCents;
    const reserveHeldCents = record.reserveHeldCents;
    const reserveReleasedCents = record.reserveReleasedCents;
    return {
      payoutItemId: record.id,
      payeeId: cell.payeeId,
      currency: cell.currency,
      /**
       * The PAYABLE this item claims — what the PAYOUT ledger entry records.
       * NEVER the transfer amount: every withholding you forget to add back
       * becomes phantom payable that pays again next cycle (see
       * PayoutDebitPayeeLedgerInput.amountCents for the worked examples).
       */
      payableClaimedCents: record.amountCents,
      /**
       * What Stripe is actually asked to move. May be ≤ 0 when withholding
       * (reserve and/or fee) consumed the whole payout — that item completes
       * WITHOUT a Stripe call (see the transfer loop).
       */
      netAmountCents:
        record.amountCents -
        reserveHeldCents -
        connectFeeCents +
        reserveReleasedCents,
      reserveHeldCents,
      reserveReleasedCents,
      // Curve context for the audit trail (in-memory only — the cents above
      // are the stamped source of truth; these say WHY they are what they
      // are).
      reserveBps: reservePlan?.reserveBps ?? 0,
      reserveBasis: reservePlan?.basis ?? null,
      reserveMembershipPortionCents: reservePlan?.membershipPortionCents ?? 0,
      releasedHoldEntryIds: reservePlan?.releasedHoldEntryIds ?? [],
      reserveIdempotencyKey: reservePlan?.claimKey ?? null,
      connectAccountFeeCents: connectFeeCents,
      connectAccountFeeReason: fee?.reason ?? null,
      connectFeeIdempotencyKey: fee?.idempotencyKey ?? null,
      creditEntryIds: cell.creditEntryIds,
      // The same rows, with the fields the payee notification needs to name
      // what was paid. Kept alongside the ids (not instead of them) so every
      // key/stamp path below stays byte-identical.
      credits: cell.credits.map((c) => ({
        entryId: c.id,
        orderId: c.orderId,
        amountCents: c.amountCents,
      })),
      orderItemIds: cell.orderItemIds,
      cellClaimKey: cell.cellClaimKey,
      // All three keys derive from the CELL HASH — never from payoutItemId,
      // which the next batch re-mints for the same money. See buildCellHash.
      payoutLedgerKey: record.payoutLedgerKey ?? buildPayoutLedgerKey(
        cell.payeeId,
        cell.currency,
        cell.creditEntryIds,
      ),
      transferClaimKey: buildTransferClaimKey(
        cell.payeeId,
        cell.currency,
        cell.creditEntryIds,
      ),
      stripeIdempotencyKey: buildStripeTransferIdempotencyKey(
        cell.payeeId,
        cell.currency,
        cell.creditEntryIds,
      ),
    };
  });

  // ── 10. Execute transfers per PayoutItem ──────────────────────────────────
  let transferred = 0;
  let failed = 0;
  let itemsSkippedPayableDropped = 0;
  let itemsFailedInsufficientPlatformBalance = 0;
  /**
   * Per-CURRENCY circuit breaker for platform float exhaustion, armed the
   * first time Stripe answers `balance_insufficient`.
   *
   * Keyed on the NORMALIZED currency, like every other currency-derived key in
   * this file. The value doubles as the per-currency tally the post-loop
   * aggregate report needs — the arming event fires from the FIRST failing
   * item and so can never know how many followed it.
   *
   * Scoped to the currency because Stripe balances are per-currency: a dry USD
   * balance says nothing about CAD, and short-circuiting a whole batch on one
   * currency's shortfall would defer money we could actually send. Within a
   * currency, though, the pool does not refill mid-batch, so every remaining
   * transfer that actually needs the float is a doomed round-trip — and one
   * that fans ONE operator-side incident into N Sentry events. It cannot mask
   * a per-payee failure either: only a real `balance_insufficient` from Stripe
   * arms it, and the skipped items are failed cleanly (claims released,
   * credits untouched) so tomorrow's batch attempts them for real and surfaces
   * any genuine per-payee problem then.
   */
  const floatExhaustedCurrencies = new Map<
    string,
    { items: number; unfundedCents: number }
  >();
  /** Tally one unfunded item against its currency, arming the breaker. */
  const tallyFloatShortfall = (item: {
    currency: string;
    netAmountCents: number;
  }): void => {
    const key = normalizeCurrency(item.currency);
    const prior = floatExhaustedCurrencies.get(key);
    floatExhaustedCurrencies.set(key, {
      items: (prior?.items ?? 0) + 1,
      unfundedCents:
        (prior?.unfundedCents ?? 0) + Math.max(0, item.netAmountCents),
    });
  };
  let totalTransferredCents = 0;
  let totalPayableClaimedCents = 0;
  let itemsFullyWithheld = 0;
  let connectFeeCentsTotal = 0;
  let itemsWithConnectAccountFee = 0;
  let reserveHeldCentsTotal = 0;
  let itemsWithReserveHeld = 0;
  let reserveReleasedCentsTotal = 0;
  let itemsWithReserveReleased = 0;

  type BatchPayoutItem = (typeof payoutItems)[number];

  /**
   * Settle the cross-run cell claim once the item has completed. Swallowed on
   * failure — the claim expires within the hour and the ledger's PAYOUT entry
   * guards from then on — but reported, because a swallow here is invisible.
   */
  const settleCellClaim = async (item: BatchPayoutItem): Promise<void> => {
    if (!item.cellClaimKey) return;
    try {
      await deps.idempotency.commit(
        item.cellClaimKey,
        { payoutItemId: item.payoutItemId },
        IDEMPOTENCY_KEEP_SECONDS,
      );
    } catch (claimCommitErr) {
      deps.logger?.error("runPayoutBatch.cell_claim_commit_failed", {
        payoutItemId: item.payoutItemId,
        payeeId: item.payeeId,
        cellClaimKey: item.cellClaimKey,
        error: describeError(claimCommitErr),
      });
      safeReport(
        claimCommitErr instanceof Error
          ? claimCommitErr
          : new Error(describeError(claimCommitErr)),
        {
          tags: {
            job: "settlements.run-batch",
            step: "cell_claim_commit",
            payeeId: item.payeeId,
            payoutItemId: item.payoutItemId,
          },
        },
      );
    }
  };

  /** Bind a payout item to the shared ledger applier. */
  const applyLedgerForItem = (
    item: BatchPayoutItem,
    stripeTransferId: string | null,
  ) =>
    applyPayoutLedgerEffects({
      payoutItemId: item.payoutItemId,
      payeeId: item.payeeId,
      currency: item.currency,
      payableClaimedCents: item.payableClaimedCents,
      payoutLedgerKey: item.payoutLedgerKey,
      creditEntryIds: item.creditEntryIds,
      orderItemIds: item.orderItemIds,
      netAmountCents: item.netAmountCents,
      reserveHeldCents: item.reserveHeldCents,
      reserveReleasedCents: item.reserveReleasedCents,
      connectAccountFeeCents: item.connectAccountFeeCents,
      payoutId: payout.id,
      stripeTransferId,
    });

  // Write the reserve's ledger entries once the item has ACTUALLY completed
  // (transferred, or zero-net). Same best-effort-with-loud-reporting posture
  // as applyPayoutLedgerEffects above, and the same durable heal: the
  // pre-batch sweep (6a) replays both writes off the transferred row.
  //   * HOLD (`reserve-hold:<payoutItemId>`): the deferred cents enter
  //     `reserveBalanceCents`. A missing write here means the payee's money
  //     never matures — which is exactly what the sweep exists to heal.
  //   * RELEASES (`reserve-release:<holdEntryId>`, sourceId = this item):
  //     mark the matured holds as returned. Written ONLY after the transfer
  //     carried the money — a failed transfer must leave the holds
  //     untouched (failItem releases the plan claim; the stamped
  //     reserveReleasedCents on a FAILED item is dead data the sweep
  //     ignores, because it only reads transferred rows).
  const applyReserveLedgerEffects = async (
    item: BatchPayoutItem,
    stripeTransferId: string | null,
  ): Promise<void> => {
    if (item.reserveHeldCents > 0) {
      try {
        await deps.repos.payeeLedger.reserveHold({
          idempotencyKey: `reserve-hold:${item.payoutItemId}`,
          payeeId: item.payeeId,
          amountCents: item.reserveHeldCents,
          currency: item.currency,
          payoutItemId: item.payoutItemId,
          description: `Rolling reserve withheld from payout ${payout.id}`,
          metadata: {
            payoutId: payout.id,
            stripeTransferId,
            reserveBps: item.reserveBps,
            basis: item.reserveBasis,
            membershipPortionCents: item.reserveMembershipPortionCents,
            payableClaimedCents: item.payableClaimedCents,
          },
        });
      } catch (ledgerErr) {
        deps.logger?.error("runPayoutBatch.reserve_hold_ledger_write_failed", {
          payoutItemId: item.payoutItemId,
          payeeId: item.payeeId,
          reserveHeldCents: item.reserveHeldCents,
          error: describeError(ledgerErr),
        });
        safeReport(
          ledgerErr instanceof Error
            ? ledgerErr
            : new Error(describeError(ledgerErr)),
          {
            tags: {
              job: "settlements.run-batch",
              step: "reserve_hold_ledger",
              payeeId: item.payeeId,
              payoutItemId: item.payoutItemId,
            },
            extra: {
              reserveHeldCents: item.reserveHeldCents,
              remediation:
                "RESERVE_HOLD not written — the next batch's reserve sweep heals it from the transferred row",
            },
          },
        );
      }
    }

    for (const holdEntryId of item.releasedHoldEntryIds) {
      try {
        await deps.repos.payeeLedger.reserveRelease({
          idempotencyKey: `reserve-release:${holdEntryId}`,
          holdEntryId,
          payoutItemId: item.payoutItemId,
          description: `Rolling reserve released by payout ${payout.id}`,
          metadata: { payoutId: payout.id, stripeTransferId },
        });
      } catch (ledgerErr) {
        deps.logger?.error(
          "runPayoutBatch.reserve_release_ledger_write_failed",
          {
            payoutItemId: item.payoutItemId,
            payeeId: item.payeeId,
            holdEntryId,
            error: describeError(ledgerErr),
          },
        );
        safeReport(
          ledgerErr instanceof Error
            ? ledgerErr
            : new Error(describeError(ledgerErr)),
          {
            tags: {
              job: "settlements.run-batch",
              step: "reserve_release_ledger",
              payeeId: item.payeeId,
              payoutItemId: item.payoutItemId,
            },
            extra: {
              holdEntryId,
              remediation:
                "RESERVE_RELEASE not written — the money already moved; the next batch's reserve sweep reconstructs it (or reports a mismatch)",
            },
          },
        );
      }
    }

    // Audit record of the reserve action, mirroring the fee audit: written
    // only after the item completed, best-effort, reported.
    if (item.reserveHeldCents > 0 || item.reserveReleasedCents > 0) {
      try {
        await deps.repos.audit.log({
          entity: "payout_item",
          entityId: item.payoutItemId,
          action: "payout_reserve_applied",
          at: deps.clock.now(),
          data: {
            payoutId: payout.id,
            payeeId: item.payeeId,
            currency: item.currency,
            payableClaimedCents: item.payableClaimedCents,
            membershipPortionCents: item.reserveMembershipPortionCents,
            reserveHeldCents: item.reserveHeldCents,
            reserveReleasedCents: item.reserveReleasedCents,
            reserveBps: item.reserveBps,
            basis: item.reserveBasis,
            releasedHoldEntryIds: item.releasedHoldEntryIds,
            netTransferredCents: item.netAmountCents,
            stripeTransferId,
          },
        });
      } catch (auditErr) {
        deps.logger?.error("runPayoutBatch.reserve_audit_failed", {
          payoutItemId: item.payoutItemId,
          payeeId: item.payeeId,
          reserveHeldCents: item.reserveHeldCents,
          reserveReleasedCents: item.reserveReleasedCents,
          error: describeError(auditErr),
        });
        safeReport(
          auditErr instanceof Error
            ? auditErr
            : new Error(describeError(auditErr)),
          {
            tags: {
              job: "settlements.run-batch",
              step: "reserve_audit",
              payeeId: item.payeeId,
              payoutItemId: item.payoutItemId,
            },
            extra: {
              reserveHeldCents: item.reserveHeldCents,
              reserveReleasedCents: item.reserveReleasedCents,
            },
          },
        );
      }
    }
  };

  // Settle the cross-worker reserve claim once the plan is backed by a
  // completed item. A throwing commit is swallowed — the claim expires in an
  // hour and the written ledger entries guard from then on — but reported,
  // since a swallow here is otherwise invisible.
  const settleReserveClaim = async (item: BatchPayoutItem): Promise<void> => {
    if (
      !(
        (item.reserveHeldCents > 0 || item.reserveReleasedCents > 0) &&
        item.reserveIdempotencyKey
      )
    ) {
      return;
    }
    try {
      await deps.idempotency.commit(
        item.reserveIdempotencyKey,
        { payoutItemId: item.payoutItemId },
        IDEMPOTENCY_KEEP_SECONDS,
      );
    } catch (claimCommitErr) {
      deps.logger?.error("runPayoutBatch.reserve_claim_commit_failed", {
        payoutItemId: item.payoutItemId,
        payeeId: item.payeeId,
        reserveClaimKey: item.reserveIdempotencyKey,
        error: describeError(claimCommitErr),
      });
      safeReport(
        claimCommitErr instanceof Error
          ? claimCommitErr
          : new Error(describeError(claimCommitErr)),
        {
          tags: {
            job: "settlements.run-batch",
            step: "reserve_claim_commit",
            payeeId: item.payeeId,
            payoutItemId: item.payoutItemId,
          },
        },
      );
    }
  };

  // Counter bump shared by all completion paths (cached, zero-net, fresh
  // transfer) so the run summary can never drift between them.
  const countCompletedItem = (item: BatchPayoutItem): void => {
    transferred++;
    totalTransferredCents += Math.max(0, item.netAmountCents);
    totalPayableClaimedCents += item.payableClaimedCents;
    if (item.netAmountCents < MIN_NET_TRANSFER_CENTS) itemsFullyWithheld++;
    if (item.connectAccountFeeCents > 0) {
      connectFeeCentsTotal += item.connectAccountFeeCents;
      itemsWithConnectAccountFee++;
    }
    if (item.reserveHeldCents > 0) {
      reserveHeldCentsTotal += item.reserveHeldCents;
      itemsWithReserveHeld++;
    }
    if (item.reserveReleasedCents > 0) {
      reserveReleasedCentsTotal += item.reserveReleasedCents;
      itemsWithReserveReleased++;
    }
  };

  for (const item of payoutItems) {
    // Circuit breaker: an earlier item in this currency already proved the
    // platform balance is dry, so skip the Stripe call entirely. This is a
    // clean pre-transfer failure — no claim is BEGUN (hence the null key: see
    // failItem, where `fail` on an unbegun key would write a spurious record),
    // the planning-time cell/fee/reserve claims are released, no credit is
    // consumed and no PAYOUT entry is written. The next batch re-plans this
    // exact cell.
    //
    // The `netAmountCents` guard is load-bearing, not defensive: a FULLY
    // WITHHELD item (reserve + Connect fee ate the whole payable) completes
    // further down with NO Stripe call at all, so the platform's balance is
    // irrelevant to it. Failing those would overstate the incident to the
    // operator and, worse, defer their reserve seasoning by a night for every
    // night the outage lasts. They must sail straight past the breaker.
    //
    // Skipping here also bypasses the in-run claim-lost probe below (this item
    // never calls `idempotency.begin`). That is fine and deliberate: the probe
    // exists to recover an item whose money may already have moved, and
    // nothing moved here. Step 0a's stale-pending sweep remains the durable
    // net if one ever did.
    if (
      item.netAmountCents >= MIN_NET_TRANSFER_CENTS &&
      floatExhaustedCurrencies.has(normalizeCurrency(item.currency))
    ) {
      const reason = "platform_balance_insufficient";
      // `warn`, not `error`, and deliberately so: the incident is ALREADY in
      // Sentry from the arming failure below (step
      // "transfer_balance_insufficient"), and this line can repeat once per
      // remaining payee. Nothing is being hidden — the count rides out in
      // `itemsFailedInsufficientPlatformBalance`, the post-loop aggregate
      // report, and the run summary.
      deps.logger?.warn("runPayoutBatch.transfer_skipped_platform_balance", {
        payoutItemId: item.payoutItemId,
        payeeId: item.payeeId,
        currency: item.currency,
        netAmountCents: item.netAmountCents,
        payableClaimedCents: item.payableClaimedCents,
      });
      await failItem(deps, item, null, reason);
      failed++;
      itemsFailedInsufficientPlatformBalance++;
      tallyFloatShortfall(item);
      continue;
    }

    // Keyed on the CELL HASH, not the item id — see buildCellHash. That makes
    // this claim mean something a per-item key never could: `begin` returns
    // false either because another worker is mid-transfer for these exact
    // credits, or because a PREVIOUS run already committed a transfer for them
    // inside the 24h keep window. Both are "do not send this money again".
    //
    // (There is deliberately no ledger-replay branch here. A committed key
    // means the money already left, and the writes that follow a transfer are
    // healed from the ORIGINAL item's durable plan by the sweep at step 0 —
    // replaying them against THIS run's freshly-minted item would stamp a
    // phantom reserve hold against a transfer that never happened. The
    // recovery probe below only ever re-stamps the ORIGINAL item's status so
    // the sweep can see it; it never applies money effects from this run's
    // plan.)
    const idempotencyKey = item.transferClaimKey;

    // Crash-safety state for the catch below. Set the instant each external
    // fact becomes true, so the catch can tell "nothing moved" (fail the
    // item, release the claim) from "the money — or the durably committed
    // zero-net completion — is already real" (never release the claim, never
    // mark the item failed).
    let stripeTransferSent = false;
    let transferClaimCommitted = false;
    let committedStripeTransferId: string | null = null;

    try {
      const claimed = await deps.idempotency.begin(
        idempotencyKey,
        IDEMPOTENCY_KEY_TTL_SECONDS,
      );
      if (!claimed) {
        const reason = "transfer_already_claimed_for_these_credits";
        deps.logger?.warn("runPayoutBatch.transfer_claim_lost", {
          payoutItemId: item.payoutItemId,
          payeeId: item.payeeId,
          currency: item.currency,
          creditEntryIds: item.creditEntryIds,
        });
        // A lost claim has two shapes:
        //   * another live worker is mid-transfer (in-progress record —
        //     `get` returns null): skip, exactly as always;
        //   * a PREVIOUS run COMMITTED a transfer for these credits and died
        //     before its `markTransferred` landed. That is a REAL Stripe
        //     transfer riding an item still `pending` — invisible to the
        //     step-0 sweep, which keys on status "transferred". Once the
        //     claim (24h) and Stripe's idempotency key (~24h) expire, the
        //     next run would re-plan the same credits and send the money
        //     AGAIN. The committed payload carries
        //     `{stripeTransferId, payoutItemId}` (records written since the
        //     payload gained `payoutItemId`), so re-stamp the ORIGINAL item
        //     transferred and let the sweep heal its ledger writes from ITS
        //     OWN frozen plan — this run or the next, and never a second
        //     Stripe call. Old-format records (no `payoutItemId`) fall
        //     through to today's behavior.
        // This probe only fires when tonight's cell hash COLLIDES with the
        // crashed run's; the general recovery (credit set drifted overnight,
        // so the hash differs and `begin` succeeds) is the stale-pending
        // sweep at step 0a, which keys on the stored plan instead. This one
        // stays as the in-run fast path: it recovers items younger than 0a's
        // minutes-scale cutoff (a crash moments before this very run) and
        // heals same-run instead of waiting for the next sweep.
        try {
          const committedRecord = await deps.idempotency.get<{
            stripeTransferId: string | null;
            payoutItemId?: string;
          }>(idempotencyKey);
          const originalItemId =
            committedRecord &&
            typeof committedRecord === "object" &&
            typeof committedRecord.payoutItemId === "string"
              ? committedRecord.payoutItemId
              : null;
          if (originalItemId && originalItemId !== item.payoutItemId) {
            const original =
              await deps.repos.payoutItems.getById(originalItemId);
            // Identity guards before touching the original row: the claim
            // key derives from the cell hash, so the original item MUST
            // name the same payee and the same credit set (payoutLedgerKey
            // derives from the identical hash). Anything else means a
            // corrupt record — leave it alone.
            if (
              original &&
              original.status !== "transferred" &&
              original.payeeId === item.payeeId &&
              original.payoutLedgerKey === item.payoutLedgerKey
            ) {
              await deps.repos.payoutItems.markTransferred(
                originalItemId,
                committedRecord!.stripeTransferId ?? null,
                deps.clock.now(),
              );
              deps.logger?.error(
                "runPayoutBatch.transfer_claim_lost_recovered",
                {
                  originalPayoutItemId: originalItemId,
                  freshPayoutItemId: item.payoutItemId,
                  payeeId: item.payeeId,
                  stripeTransferId: committedRecord!.stripeTransferId ?? null,
                },
              );
              // A real crash signature, swallowed by design — Sentry must
              // see it (the next sweep's `itemsLedgerHealed` confirms the
              // heal, but the crash itself would otherwise be invisible).
              safeReport(
                new Error(
                  `transfer_claim_lost_unmarked_item_recovered: ${originalItemId}`,
                ),
                {
                  tags: {
                    job: "settlements.run-batch",
                    step: "transfer_claim_lost_recovery",
                    payeeId: item.payeeId,
                    payoutItemId: originalItemId,
                  },
                  extra: {
                    freshPayoutItemId: item.payoutItemId,
                    stripeTransferId:
                      committedRecord!.stripeTransferId ?? null,
                  },
                },
              );
            }
          }
        } catch (recoverErr) {
          // Best-effort: the committed claim still blocks a re-send for its
          // 24h keep, and the probe re-runs on every later claim-lost
          // collision for the same credits. Reported — a failing probe is a
          // shrinking recovery window.
          deps.logger?.error(
            "runPayoutBatch.transfer_claim_lost_recovery_failed",
            {
              payoutItemId: item.payoutItemId,
              payeeId: item.payeeId,
              error: describeError(recoverErr),
            },
          );
          safeReport(
            recoverErr instanceof Error
              ? recoverErr
              : new Error(describeError(recoverErr)),
            {
              tags: {
                job: "settlements.run-batch",
                step: "transfer_claim_lost_recovery",
                payeeId: item.payeeId,
                payoutItemId: item.payoutItemId,
              },
            },
          );
        }
        // NULL key: the claim belongs to whoever holds it. Releasing it here
        // would erase another run's "already sent" record.
        await failItem(deps, item, null, reason);
        itemsSkippedClaimLost++;
        failed++;
        continue;
      }

      // ── Race guard: re-read the payable immediately before moving money ──
      //
      // The plan was computed at batch start; a refund, a dispute or a
      // concurrent payout can land in the window between then and this
      // transfer. Re-running the payable for THIS (payee, currency) and
      // refusing to send more than it now allows is the ledger-model
      // replacement for the pre-cutover claim-time FOR-UPDATE dispute
      // re-check. Strictly one-directional: we never transfer MORE than the
      // current payable, and a payable that GREW since planning is simply
      // paid next cycle.
      const recheck = await deps.repos.payeeLedger.listPayableBalances(
        deps.clock.now(),
        [item.payeeId],
      );
      const currentPayableCents =
        recheck.find(
          (row) =>
            row.payeeId === item.payeeId && row.currency === item.currency,
        )?.payableCents ?? 0;
      if (currentPayableCents < item.payableClaimedCents) {
        const reason = "payable_dropped_before_transfer";
        deps.logger?.warn("runPayoutBatch.payable_dropped_before_transfer", {
          payoutItemId: item.payoutItemId,
          payeeId: item.payeeId,
          currency: item.currency,
          plannedPayableCents: item.payableClaimedCents,
          currentPayableCents,
        });
        await failItem(deps, item, idempotencyKey, reason);
        itemsSkippedPayableDropped++;
        failed++;
        continue;
      }

      // ── Fully withheld: withholding consumed the entire payout ───────────
      //
      // Stripe cannot transfer 0, and for the ROLLING RESERVE (unlike the $2
      // convenience fee, which never takes the last cent) withholding the
      // whole payout is CORRECT — a reserve is the payee's own money
      // deferred, not lost. Terminal state, chosen as the least-invasive
      // honest representation: the item completes as `transferred` with a
      // NULL stripeTransferId and `reserveHeldCents + connectAccountFeeCents
      // == amountCents` explaining where every cent went; the PAYOUT entry
      // and credit consumption are written exactly as on the transfer path,
      // so the money can never pay out twice. Note a reserve RELEASE can
      // never land here: released cents ADD to the net, so any item carrying
      // one has at least that much to transfer. Because no Stripe payout
      // happened, the account did NOT go active this month —
      // `payeeIdsWithTransferredPayoutInPeriod` excludes null-transfer rows
      // for exactly this reason.
      if (item.netAmountCents < MIN_NET_TRANSFER_CENTS) {
        // Same commit-first discipline as the transfer path: nothing external
        // happened yet, but committing here makes a crash between these DB
        // writes recoverable — the next run's claim-lost probe reads the
        // committed `payoutItemId` and re-stamps THIS item transferred so
        // the sweep replays its ledger writes from its frozen plan.
        await deps.idempotency.commit(
          idempotencyKey,
          { stripeTransferId: null, payoutItemId: item.payoutItemId },
          TRANSFER_CLAIM_KEEP_SECONDS,
        );
        transferClaimCommitted = true;
        await deps.repos.payoutItems.markTransferred(
          item.payoutItemId,
          null,
          deps.clock.now(),
        );
        // Reserve writes are GATED on the payable claim landing. If the
        // PAYOUT entry did not land, this item is not settled — the sweep at
        // step 0 will replay it next run, and burning the reserve releases
        // now would leave that heal (and the reserve sweep's
        // reconstruction) with nothing to work from.
        const zeroNetClaimed = await applyLedgerForItem(item, null);
        if (zeroNetClaimed) {
          await applyReserveLedgerEffects(item, null);
          await settleReserveClaim(item);
        }
        await settleCellClaim(item);
        countCompletedItem(item);

        deps.logger?.info("runPayoutBatch.fully_withheld", {
          payoutItemId: item.payoutItemId,
          payeeId: item.payeeId,
          currency: item.currency,
          payableClaimedCents: item.payableClaimedCents,
          reserveHeldCents: item.reserveHeldCents,
          connectAccountFeeCents: item.connectAccountFeeCents,
        });

        // Distinct notification, NOT the ordinary "you've been paid": nothing
        // landed in the payee's account, and silence here means the payee
        // just watches a payout never arrive. Same best-effort posture as the
        // transfer-path notify: the withholding already happened, so a
        // failure is swallowed, warned and reported — never allowed to fail
        // the item.
        if (deps.notifyPayee) {
          try {
            await deps.notifyPayee({
              payeeId: item.payeeId,
              payoutId: payout.id,
              payoutItemId: item.payoutItemId,
              // The RESERVED amount — "what was deferred", not the
              // meaningless $0.00 that landed.
              amountCents: item.reserveHeldCents,
              currency: item.currency,
              settlementCount: item.creditEntryIds.length,
              kind: "reserved",
              credits: item.credits,
              recoveredDebtCents: 0,
              connectAccountFeeCents: item.connectAccountFeeCents,
              reserveHeldCents: item.reserveHeldCents,
              reserveReleasedCents: item.reserveReleasedCents,
              payoutDateIso: now.toISOString(),
            });
          } catch (notifyErr) {
            deps.logger?.error("runPayoutBatch.withheld_notify_failed", {
              payoutItemId: item.payoutItemId,
              payeeId: item.payeeId,
              error: describeError(notifyErr),
            });
            safeReport(
              notifyErr instanceof Error
                ? notifyErr
                : new Error(describeError(notifyErr)),
              {
                tags: {
                  job: "settlements.run-batch",
                  step: "notify_payee_withheld",
                  payeeId: item.payeeId,
                  payoutItemId: item.payoutItemId,
                },
              },
            );
          }
        }
        continue;
      }

      // Execute the transfer (single transfer per payee+currency per batch).
      //
      // POST-deduction amount. The withheld cents are simply not sent — they
      // stay on the platform balance, which is why the rolling reserve and
      // Stripe's active-account fee need no second API call, no charge and no
      // reconciling transfer.
      const payee = payeeMap.get(item.payeeId)!;
      const transfer = await deps.payments.createTransfer({
        amountCents: item.netAmountCents,
        currency: item.currency,
        destinationAccountId: payee.stripeAccountId!,
        metadata: {
          payoutId: payout.id,
          payoutItemId: item.payoutItemId,
          payeeId: item.payeeId,
          creditCount: String(item.creditEntryIds.length),
          payableClaimedCents: String(item.payableClaimedCents),
          reserveHeldCents: String(item.reserveHeldCents),
          reserveReleasedCents: String(item.reserveReleasedCents),
          connectAccountFeeCents: String(item.connectAccountFeeCents),
        },
        // Stripe-side idempotency (credit-derived, NOT payoutItemId — see
        // buildStripeTransferIdempotencyKey): closes the crash window where
        // Stripe accepted the transfer but the PAYOUT entry never landed, so
        // the next batch re-plans the SAME credits into a fresh PayoutItem
        // (fresh our-side key) that would otherwise re-send the money.
        idempotencyKey: item.stripeIdempotencyKey,
      });
      stripeTransferSent = true;
      committedStripeTransferId = transfer.id;

      // CRITICAL: Commit idempotency IMMEDIATELY after Stripe returns the
      // transfer ID — before any DB updates. The payload carries the ITEM ID
      // alongside the transfer id: if the process crashes between here and
      // `markTransferred`, the item is a real Stripe transfer still marked
      // "pending" — invisible to the step-0 sweep — and the next run's
      // claim-lost probe uses the committed `payoutItemId` to re-stamp it
      // transferred so the sweep heals from its frozen plan instead of the
      // credits re-planning (and re-sending) after both 24h windows expire.
      await deps.idempotency.commit(
        idempotencyKey,
        { stripeTransferId: transfer.id, payoutItemId: item.payoutItemId },
        TRANSFER_CLAIM_KEEP_SECONDS,
      );
      transferClaimCommitted = true;

      // Mark the PayoutItem as transferred. `transferredAt` is the month-
      // attribution timestamp for Stripe's active-account fee — the fee is
      // billed for the month the payout LANDS, which is now, not createdAt.
      await deps.repos.payoutItems.markTransferred(
        item.payoutItemId,
        transfer.id,
        deps.clock.now(),
      );

      // Same gate as the zero-net path: no payable claim, no reserve writes.
      const claimLanded = await applyLedgerForItem(item, transfer.id);
      if (claimLanded) {
        await applyReserveLedgerEffects(item, transfer.id);
        await settleReserveClaim(item);
      }
      await settleCellClaim(item);
      countCompletedItem(item);

      // Settle the cross-worker fee claim: the deduction is now backed by a
      // real transferred row, which becomes the durable month guard. A
      // throwing commit is swallowed — the claim simply expires in an hour
      // and the DB row guards from then on — but reported, since a swallow
      // here is otherwise invisible.
      if (item.connectAccountFeeCents > 0 && item.connectFeeIdempotencyKey) {
        try {
          await deps.idempotency.commit(
            item.connectFeeIdempotencyKey,
            { payoutItemId: item.payoutItemId },
            IDEMPOTENCY_KEEP_SECONDS,
          );
        } catch (feeCommitErr) {
          deps.logger?.error("runPayoutBatch.connect_fee_claim_commit_failed", {
            payoutItemId: item.payoutItemId,
            payeeId: item.payeeId,
            feeKey: item.connectFeeIdempotencyKey,
            error: describeError(feeCommitErr),
          });
          safeReport(
            feeCommitErr instanceof Error
              ? feeCommitErr
              : new Error(describeError(feeCommitErr)),
            {
              tags: {
                job: "settlements.run-batch",
                step: "connect_fee_claim_commit",
                payeeId: item.payeeId,
                payoutItemId: item.payoutItemId,
              },
            },
          );
        }
      }

      deps.logger?.info("runPayoutBatch.transfer_success", {
        payoutItemId: item.payoutItemId,
        payeeId: item.payeeId,
        stripeTransferId: transfer.id,
        amountCents: item.netAmountCents,
        payableClaimedCents: item.payableClaimedCents,
        creditCount: item.creditEntryIds.length,
        reserveHeldCents: item.reserveHeldCents,
        reserveReleasedCents: item.reserveReleasedCents,
        reserveBasis: item.reserveBasis,
        connectAccountFeeCents: item.connectAccountFeeCents,
        connectAccountFeeReason: item.connectAccountFeeReason,
        currency: item.currency,
      });

      // Auditable record of money withheld from a payee. Written only after
      // the transfer actually executed, so the log never claims a deduction
      // that didn't happen. Best-effort: the money has already moved, so an
      // audit-write failure must not fail or roll back the batch — but it is
      // reported, because a silent gap in the money trail is exactly the thing
      // a venue will later ask us to explain.
      if (item.connectAccountFeeCents > 0) {
        try {
          await deps.repos.audit.log({
            entity: "payout_item",
            entityId: item.payoutItemId,
            action: "connect_account_fee_deducted",
            at: deps.clock.now(),
            data: {
              payoutId: payout.id,
              payeeId: item.payeeId,
              currency: item.currency,
              payableClaimedCents: item.payableClaimedCents,
              connectAccountFeeCents: item.connectAccountFeeCents,
              netTransferredCents: item.netAmountCents,
              reason: item.connectAccountFeeReason,
              stripeTransferId: transfer.id,
            },
          });
        } catch (auditErr) {
          deps.logger?.error("runPayoutBatch.connect_fee_audit_failed", {
            payoutItemId: item.payoutItemId,
            payeeId: item.payeeId,
            connectAccountFeeCents: item.connectAccountFeeCents,
            error: describeError(auditErr),
          });
          safeReport(
            auditErr instanceof Error
              ? auditErr
              : new Error(describeError(auditErr)),
            {
              tags: {
                job: "settlements.run-batch",
                step: "connect_account_fee_audit",
                payeeId: item.payeeId,
                payoutItemId: item.payoutItemId,
              },
              extra: {
                connectAccountFeeCents: item.connectAccountFeeCents,
                stripeTransferId: transfer.id,
              },
            },
          );
        }
      }

      // Best-effort "you've been paid out" notification. The transfer + DB
      // writes already committed, so a notification failure must never fail
      // or roll back the batch — swallow and warn. Not invoked on the cached
      // path above: that means a prior run already processed (and notified
      // for) this transfer.
      if (deps.notifyPayee) {
        try {
          await deps.notifyPayee({
            payeeId: item.payeeId,
            payoutId: payout.id,
            payoutItemId: item.payoutItemId,
            // NET — the payee is told what actually landed in their account,
            // not the pre-deduction payable.
            amountCents: item.netAmountCents,
            currency: item.currency,
            settlementCount: item.creditEntryIds.length,
            credits: item.credits,
            recoveredDebtCents: 0,
            connectAccountFeeCents: item.connectAccountFeeCents,
            reserveHeldCents: item.reserveHeldCents,
            reserveReleasedCents: item.reserveReleasedCents,
            payoutDateIso: now.toISOString(),
          });
        } catch (notifyErr) {
          deps.logger?.error("runPayoutBatch.payout_notify_failed", {
            payoutItemId: item.payoutItemId,
            payeeId: item.payeeId,
            error: describeError(notifyErr),
          });
          // Deliberate swallow (the payout already happened) — so it must be
          // reported explicitly: `warn` is not captured by Sentry, and this
          // branch never reaches the job error-boundary.
          safeReport(
            notifyErr instanceof Error
              ? notifyErr
              : new Error(describeError(notifyErr)),
            {
              tags: {
                job: "settlements.run-batch",
                step: "notify_payee",
                payeeId: item.payeeId,
                payoutItemId: item.payoutItemId,
              },
            },
          );
        }
      }
    } catch (err) {
      const errorMsg = describeError(err);
      // Platform float exhaustion is unambiguously PRE-completion: Stripe
      // rejected the call, so no money moved. The `!stripeTransferSent &&
      // !transferClaimCommitted` guard is belt-and-braces — only
      // `createTransfer` can raise this marker, and it does so before either
      // flag is set — so that a surprising throw site can never route money
      // that HAS moved into the pre-transfer arm.
      const platformFloatExhausted =
        !stripeTransferSent &&
        !transferClaimCommitted &&
        isInsufficientPlatformBalanceError(err);

      if (platformFloatExhausted) {
        // Distinct message: "our float ran out" and "this payee is broken"
        // must never be the same log line to grep for.
        deps.logger?.error("runPayoutBatch.platform_balance_insufficient", {
          payoutItemId: item.payoutItemId,
          payeeId: item.payeeId,
          currency: item.currency,
          netAmountCents: item.netAmountCents,
          payableClaimedCents: item.payableClaimedCents,
          error: errorMsg,
        });
      } else {
        deps.logger?.error("runPayoutBatch.transfer_failed", {
          payoutItemId: item.payoutItemId,
          payeeId: item.payeeId,
          payableClaimedCents: item.payableClaimedCents,
          stripeTransferSent,
          transferClaimCommitted,
          error: errorMsg,
        });
      }

      if (stripeTransferSent || transferClaimCommitted) {
        // ── POST-COMPLETION arm: the money already left ────────────────────
        //
        // Stripe accepted the transfer (or the zero-net completion was
        // durably committed) before the throw — in practice this is
        // `markTransferred` failing on a DB blip, or the claim commit itself
        // throwing right after Stripe returned. Two things must NEVER happen
        // here:
        //   * `idempotency.fail` on the transfer claim — `fail` is an
        //     unconditional overwrite in both adapters, so it would DELETE
        //     the committed "this money already left, tr_X" guard and put
        //     the cell back on 900s retention (see the failItem docstring);
        //   * `markFailed` on the item — a "failed" item with a real
        //     transfer is a lie the sweep cannot see through.
        // Instead, self-heal: (re)commit the claim if the commit was what
        // threw, then best-effort `markTransferred` so the step-0 sweep
        // replays the ledger writes from this item's frozen plan on the very
        // next run. If even that fails, the claim-lost probe repairs the
        // status from the committed payload on the next collision. The
        // reserve/fee claims are left to expire (1h TTL) — the documented
        // fail-safe direction on both.
        if (!transferClaimCommitted) {
          try {
            await deps.idempotency.commit(
              idempotencyKey,
              {
                stripeTransferId: committedStripeTransferId,
                payoutItemId: item.payoutItemId,
              },
              TRANSFER_CLAIM_KEEP_SECONDS,
            );
            transferClaimCommitted = true;
          } catch (commitErr) {
            deps.logger?.error(
              "runPayoutBatch.post_transfer_commit_retry_failed",
              {
                payoutItemId: item.payoutItemId,
                payeeId: item.payeeId,
                stripeTransferId: committedStripeTransferId,
                error: describeError(commitErr),
              },
            );
            safeReport(
              commitErr instanceof Error
                ? commitErr
                : new Error(describeError(commitErr)),
              {
                tags: {
                  job: "settlements.run-batch",
                  step: "post_transfer_commit_retry",
                  payeeId: item.payeeId,
                  payoutItemId: item.payoutItemId,
                },
                extra: { stripeTransferId: committedStripeTransferId },
              },
            );
          }
        }
        try {
          await deps.repos.payoutItems.markTransferred(
            item.payoutItemId,
            committedStripeTransferId,
            deps.clock.now(),
          );
        } catch (markErr) {
          deps.logger?.error(
            "runPayoutBatch.post_transfer_mark_transferred_failed",
            {
              payoutItemId: item.payoutItemId,
              payeeId: item.payeeId,
              stripeTransferId: committedStripeTransferId,
              error: describeError(markErr),
            },
          );
          safeReport(
            markErr instanceof Error
              ? markErr
              : new Error(describeError(markErr)),
            {
              tags: {
                job: "settlements.run-batch",
                step: "post_transfer_mark_transferred",
                payeeId: item.payeeId,
                payoutItemId: item.payoutItemId,
              },
              extra: {
                stripeTransferId: committedStripeTransferId,
                remediation:
                  "item left pending with a committed transfer claim — the next run's claim-lost probe re-stamps it transferred from the committed payload",
              },
            },
          );
        }
        // The cell IS paid this cycle: commit its claim like the success
        // path (swallow-safe inside).
        await settleCellClaim(item);
        // Counted as transferred — the money moved; only the ledger writes
        // are pending, and the sweep's `itemsLedgerHealed` will account for
        // them.
        countCompletedItem(item);
        safeReport(err instanceof Error ? err : new Error(errorMsg), {
          tags: {
            job: "settlements.run-batch",
            step: "post_transfer_completion",
            payeeId: item.payeeId,
            payoutItemId: item.payoutItemId,
          },
          extra: {
            payableClaimedCents: item.payableClaimedCents,
            stripeTransferId: committedStripeTransferId,
            remediation:
              "money moved; ledger writes deferred to the step-0 heal sweep — verify itemsLedgerHealed goes non-zero on the next run",
          },
        });
      } else {
        // ── PRE-TRANSFER arm: nothing external happened ────────────────────
        //
        // Nothing to release: no Stripe call succeeded and the claim was
        // never committed, so the credits were never consumed, the payable
        // is untouched, and the next batch re-plans this money from the
        // ledger. Releasing the (begun, uncommitted) claim here is safe —
        // there is no committed record to erase.
        await failItem(deps, item, idempotencyKey, errorMsg);
        failed++;
        if (platformFloatExhausted) {
          // Counted BOTH ways on purpose. It is a genuine failure — the payee
          // was not paid, and step 11 must still see a batch that paid nobody
          // as a failed Payout rather than a completed one — so existing
          // alerting on `itemsFailed` keeps firing. The dedicated counter is
          // what tells the operator the cause is our float, not their account.
          itemsFailedInsufficientPlatformBalance++;
          // Arm the breaker so the rest of this currency's items skip the
          // doomed Stripe round-trip (see the top of the loop). Normalized for
          // the same reason every other currency-derived key is (see
          // normalizeCurrency): a raw-cased mismatch here fails SILENTLY —
          // the breaker simply never fires and we make N doomed calls.
          tallyFloatShortfall(item);
        }
        // Report AFTER cleanup so a throwing reporter can never skip
        // failItem / failed++. Swallowed so the batch continues — this never
        // reaches the job error-boundary, so report it explicitly. Prefer
        // the real thrown error (stack + grouping) when it's an Error; fall
        // back to a synthesized one.
        safeReport(err instanceof Error ? err : new Error(errorMsg), {
          tags: {
            job: "settlements.run-batch",
            // Distinct step so this groups as its own Sentry issue: it is an
            // operator-side float problem, not the generic transfer failure.
            // Fired ONCE per currency — the breaker skips the rest — so one
            // dry-balance night is one issue, not one per payee.
            ...(platformFloatExhausted
              ? { step: "transfer_balance_insufficient" }
              : {}),
            payeeId: item.payeeId,
            payoutItemId: item.payoutItemId,
          },
          extra: {
            payableClaimedCents: item.payableClaimedCents,
            ...(platformFloatExhausted
              ? {
                  currency: item.currency,
                  netAmountCents: item.netAmountCents,
                  remediation:
                    "the PLATFORM's available balance could not fund this transfer — no payee is at fault, and no money moved. Top up, or slow the platform's own Stripe payout schedule so charges settle before the batch runs. The credits were not consumed, so the NEXT NIGHTLY BATCH re-plans and re-attempts them. Do NOT hand-trigger the batch straight after topping up: the retry re-sends the same credit-derived Stripe idempotency key, and Stripe may replay its cached rejection for ~24h, which looks identical to the top-up not working.",
                }
              : {}),
          },
        });
      }
      // Continue processing other items -- one failure shouldn't block the batch
    }
  }

  // ── 10b. Aggregate the float outage into ONE closing report ───────────────
  //
  // The per-item event above fires from the FIRST item to fail, so it can only
  // ever say "one payee wasn't paid" — it does not yet know the breaker is
  // about to skip forty more. The skip lines are `warn` (not Sentry-captured,
  // deliberately) and the totals otherwise only reach an `info` summary, so
  // without this the blast radius of a float outage is invisible in Sentry.
  // Gated on > 1 because a lone shortfall is already fully described by its
  // own event; this is strictly the "and here is how big it got" follow-up.
  if (itemsFailedInsufficientPlatformBalance > 1) {
    const byCurrency = Object.fromEntries(floatExhaustedCurrencies);
    deps.logger?.error("runPayoutBatch.platform_float_exhausted_summary", {
      payoutId: payout.id,
      itemsFailedInsufficientPlatformBalance,
      byCurrency,
    });
    safeReport(
      new Error(
        `platform_float_exhausted: ${itemsFailedInsufficientPlatformBalance} payout items unfunded across ${floatExhaustedCurrencies.size} currency/currencies`,
      ),
      {
        tags: {
          job: "settlements.run-batch",
          step: "platform_float_exhausted_summary",
        },
        extra: {
          payoutId: payout.id,
          itemsFailedInsufficientPlatformBalance,
          // { usd: { items, unfundedCents } } — `unfundedCents` is the NET
          // that would have been sent, so it is a floor on the top-up needed,
          // not an exact figure (later cells never got planned against a
          // balance that was already dry).
          byCurrency,
          remediation:
            "the PLATFORM ran out of available balance mid-batch; no payee is at fault and no money moved. Top up at least the unfunded total per currency, then let the NEXT NIGHTLY BATCH re-plan — a hand-triggered retry inside ~24h may replay Stripe's cached rejection against the same credit-derived idempotency key.",
        },
      },
    );
  }

  // ── 11. Finalize the Payout ───────────────────────────────────────────────
  if (failed === 0) {
    await deps.repos.payouts.markCompleted(payout.id, deps.clock.now());
  } else if (transferred === 0) {
    await deps.repos.payouts.markFailed(
      payout.id,
      deps.clock.now(),
      `all ${failed} items failed`,
    );
  } else {
    // Mixed results: still mark completed (individual items track their own status)
    await deps.repos.payouts.markCompleted(payout.id, deps.clock.now());
  }

  const result: RunPayoutBatchOutput = {
    payoutId: payout.id,
    payeesConsidered,
    itemsCreated: payoutItems.length,
    itemsTransferred: transferred,
    itemsFailed: failed,
    itemsSkippedBelowMinimum,
    itemsSkippedIneligible,
    itemsSkippedPayableDropped,
    itemsSkippedClaimLost,
    itemsFailedInsufficientPlatformBalance,
    payeesDeferredByLimit,
    itemsLedgerHealed,
    itemsHeldForSuspension,
    itemsFullyWithheld,
    totalTransferredCents,
    totalPayableClaimedCents,
    reserveHeldCents: reserveHeldCentsTotal,
    itemsWithReserveHeld,
    reserveReleasedCents: reserveReleasedCentsTotal,
    itemsWithReserveReleased,
    connectFeeCents: connectFeeCentsTotal,
    itemsWithConnectAccountFee,
  };

  deps.logger?.info("runPayoutBatch.complete", {
    ...result,
    connectAccountFeeCents,
    connectFeeLookupFailed,
    reserveSweepFailed,
  });

  return result;
}
