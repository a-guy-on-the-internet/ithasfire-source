import { z } from "zod";

import { AppError, isAppError } from "@th/errors";
import type { ClockPort } from "@th/ports/clock";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { OrderItemRecord, OrderRecord } from "@th/ports/repos/orders";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos } from "@th/ports/repos";
import type { TicketRecord } from "@th/ports/repos/tickets";
import type { ReporterPort } from "@th/ports/reporter";

import { describeError, parseInput } from "../../lib/io";
import { allocateRefundItemBases } from "../../lib/orders/refund-item-base";
import { parseRefundMetadataOrderItemIds } from "./_shared/dispute-refund-guard";
import { withOrderRefundMutex } from "./_shared/refund-mutex";
import { releaseSeatsForVoidedTickets } from "./_shared/release-seats-for-voided-tickets";
import {
  leftOnRefundAuditData,
  ticketsLeavingOnRefund,
  type TicketLeavingOnRefund,
} from "./_shared/tickets-leaving-on-refund";
import {
  writeExternalAmountRefundDebitsForOrder,
  writeRefundDebitsForOrder,
} from "./_shared/write-refund-debits";
import { getMetaString } from "../../lib/orders/meta";
import { computeExpectedPaymentAmount } from "../../lib/orders/compute-expected-payment-amount";
import {
  assertResaleOrderCanBeUnwound,
  unwindResaleOrderAfterRefund,
} from "../resale/unwind-resale-order-after-refund";
import { setListedNowPointer } from "../_helpers/order-item-listing-pointer";
import { markOrderTicketsRefunded } from "./mark-order-tickets-refunded";
import { notifyClaimRefundedForOrder } from "../resale/notify-claim-refunded";
import { sendLegacyRelistNotices } from "../resale/_shared/send-legacy-relist-notices";
import type { LegacyRelistNotice } from "../resale/unwind-resale-order-after-refund";

export const reconcileStripeFullRefundInputSchema = z.object({
  paymentIntentId: z.string().min(3),
  amountRefundedCents: z.number().int().nonnegative(),
  currency: z.string().min(3).max(3).optional(),
  refundId: z.string().min(3).optional(),
  sourceEventType: z.enum(["charge.refunded", "charge.refund.updated"]),
  fullyRefundedHint: z.boolean().optional(),
});

export const reconcileStripeFullRefundOutputSchema = z.object({
  ok: z.literal(true),
  paymentIntentId: z.string().min(3),
  orderId: z.uuid().nullable(),
  orderSource: z.enum(["PRIMARY", "RESALE"]).nullable(),
  outcome: z.enum([
    "reconciled_primary",
    "reconciled_resale",
    "manual_review_required",
    "partial_refund_reconciled",
    "partial_refund_ignored",
    "already_refunded",
    "order_not_found",
    "order_not_succeeded",
  ]),
});

export type ReconcileStripeFullRefundInput = z.infer<
  typeof reconcileStripeFullRefundInputSchema
>;
export type ReconcileStripeFullRefundOutput = z.infer<
  typeof reconcileStripeFullRefundOutputSchema
>;

export type ReconcileStripeFullRefundDeps = {
  repos: Repos;
  clock: ClockPort;
  /**
   * Backs the per-order refund mutex (`refund-op:${orderId}`). Both debit
   * arms (full + partial) compute their Σ-prior-debits inside a
   * ReadCommitted transaction, so a reconcile racing an in-flight internal
   * refund (which the internal refund's own Stripe call TRIGGERS via
   * `charge.refunded` — the conflict is SELF-ARMING) could read priors
   * before the internal debit commits and over-debit — debits are
   * append-only, so that never self-heals.
   *
   * Conflict posture, honestly stated: acquisition is non-blocking with a
   * short bounded in-process retry (~250ms/750ms — the common window is
   * just the internal refund's transaction tail), which makes the typical
   * self-armed conflict resolve with zero DLQ traffic. If retries exhaust,
   * the throw (marker: `refund_mutex_conflict`) lands the event in the
   * webhook DLQ, and the DLQ is OPERATOR-REPLAY ONLY — the route answers
   * 200 to Stripe, so nothing redelivers automatically. Rare by
   * construction, but a parked event stays parked until a human replays it.
   */
  idempotency: IdempotencyPort;
  logger?: LoggerPort;
  /**
   * Reads the refund's metadata (`getRefund`) so the PARTIAL arm can flip
   * the items an interrupted internal refund named (money audit 2026-09-08
   * #10). Optional: without it the partial arm keeps its ledger-only
   * behaviour. The lookup runs OUTSIDE the transaction and is best-effort —
   * a Stripe read failure is reported and never blocks the ledger debit.
   */
  payments?: Pick<
    PaymentProcessorPort,
    "getRefund" | "listRefundsForPaymentIntent"
  > | null;
  /**
   * Best-effort Sentry reporter for the refund-debit swallow branches
   * (missing pre-cutover credits, attribution drift). Wire from the webhook
   * composition root; a throwing reporter never changes behaviour.
   */
  reportError?: ReporterPort | null;
  /**
   * With `publicAppUrl`, lets a reconcile that marks a RESALE order with an
   * APPROVED claim REFUNDED tell the buyer they have been refunded
   * (resale/notify-claim-refunded.ts: at most once per claim, never throws).
   * Unwired = no notice; the reconcile itself is unchanged.
   */
  mailer?: MailerPort | null;
  publicAppUrl?: string | null;
};

/**
 * After a reconcile marked a RESALE order REFUNDED: if the refund was for an
 * approved claim, tell the buyer. The helper swallows and reports every
 * failure itself; this extra catch is belt and braces, because a throw here
 * would DLQ a webhook whose money work has already committed.
 */
async function tellClaimBuyerRefunded(
  deps: ReconcileStripeFullRefundDeps,
  orderId: string,
  input: { refundId?: string; amountRefundedCents: number },
): Promise<void> {
  if (!deps.mailer || !deps.publicAppUrl) return;
  try {
    await notifyClaimRefundedForOrder(
      {
        repos: deps.repos,
        idempotency: deps.idempotency,
        mailer: deps.mailer,
        publicAppUrl: deps.publicAppUrl,
        payments: deps.payments ?? null,
        logger: deps.logger,
        reportError: deps.reportError,
      },
      {
        orderId,
        refundId: input.refundId ?? null,
        amountRefundedCents: input.amountRefundedCents,
      },
    );
  } catch (err) {
    reportBestEffort(
      deps,
      err,
      "claim_refunded_notice_failed",
      { orderId },
      "claimRefundedNotice",
    );
  }
}

/** True when any ticket item of the order carries an APPROVED claim. */
async function hasApprovedClaim(
  tx: Parameters<Parameters<Repos["tx"]>[0]>[0],
  items: OrderItemRecord[],
): Promise<boolean> {
  for (const item of items) {
    if (item.kind !== "ticket") continue;
    const claim = await tx.claims.getByOrderItemId(item.id);
    if (claim?.status === "approved") return true;
  }
  return false;
}

/** `deps.reportError` guarded so a throwing reporter never changes behaviour. */
function reportBestEffort(
  deps: ReconcileStripeFullRefundDeps,
  err: unknown,
  reason: string,
  extra: Record<string, unknown>,
  step = "externalPartialRefund",
): void {
  try {
    deps.reportError?.(err, {
      tags: {
        useCase: "reconcileStripeFullRefund",
        step,
        reason,
      },
      extra,
    });
  } catch {
    // A throwing reporter never changes behaviour.
  }
}

/**
 * Backoff schedule for refund-mutex conflicts. The self-armed case — an
 * internal refund's own webhook landing during that refund's mutex hold —
 * usually clears within the holder's transaction tail, so two short waits
 * resolve it in-process with no DLQ traffic. No shared sleep/backoff helper
 * exists in @th/core (checked), hence the local one.
 */
const MUTEX_RETRY_DELAYS_MS = [250, 750];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRefundMutexConflict(err: unknown): boolean {
  return isAppError(err) && err.code === "IDEMPOTENCY_LOCK_IN_PROGRESS";
}

/**
 * Acquire the per-order refund mutex with a bounded in-process retry.
 *
 * Exhaustion throws `IDEMPOTENCY_LOCK_IN_PROGRESS` with the message marker
 * `refund_mutex_conflict` — the webhook DLQ stores stage-prefixed error
 * MESSAGES, so the marker makes parked rows greppable/alertable — and
 * reports once. The DLQ is operator-replay only (the route 200s to Stripe;
 * nothing redelivers automatically), so the retry doing its job is what
 * keeps this path rare rather than routine.
 */
async function withMutexRetry<T>(
  deps: ReconcileStripeFullRefundDeps,
  orderId: string,
  logger: LoggerPort | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await withOrderRefundMutex(
        {
          idempotency: deps.idempotency,
          logger,
          reportError: deps.reportError,
        },
        orderId,
        fn,
      );
    } catch (err) {
      if (!isRefundMutexConflict(err)) {
        throw err;
      }
      const delayMs = MUTEX_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined) {
        logger?.error("reconcileStripeFullRefund.refund_mutex_conflict_exhausted", {
          orderId,
          attempts: attempt + 1,
        });
        try {
          deps.reportError?.(err, {
            tags: {
              useCase: "reconcileStripeFullRefund",
              step: "refundMutex",
              reason: "refund_mutex_conflict_exhausted",
            },
            extra: { orderId, attempts: attempt + 1 },
          });
        } catch {
          // A throwing reporter never changes behaviour.
        }
        throw new AppError("IDEMPOTENCY_LOCK_IN_PROGRESS", {
          message: `refund_mutex_conflict: reconcile gave up after ${
            attempt + 1
          } attempts for order ${orderId}`,
          meta: { orderId, attempts: attempt + 1 },
          cause: err,
        });
      }
      await sleep(delayMs);
    }
  }
}

export async function reconcileStripeFullRefund(
  deps: ReconcileStripeFullRefundDeps,
  rawInput: unknown,
): Promise<ReconcileStripeFullRefundOutput> {
  const logger = deps.logger?.child({ useCase: "reconcileStripeFullRefund" });
  const input = parseInput(reconcileStripeFullRefundInputSchema, rawInput);

  // NOTE: `fullyRefundedHint === false` no longer early-returns here — the
  // hint marks the event KNOWN-partial, and partials now route to the
  // proportional-debit handler below (the original refund-leak door: a
  // dashboard partial refund returned the buyer's money while the payee's
  // SETTLEMENT_CREDIT stayed whole and paid out at maturity).

  const orderRef = await deps.repos.orders.findByPaymentIntent(
    input.paymentIntentId,
  );
  if (!orderRef) {
    logger?.warn("reconcileStripeFullRefund.order_not_found", {
      paymentIntentId: input.paymentIntentId,
      refundId: input.refundId,
      sourceEventType: input.sourceEventType,
    });

    return reconcileStripeFullRefundOutputSchema.parse({
      ok: true,
      paymentIntentId: input.paymentIntentId,
      orderId: null,
      orderSource: null,
      outcome: "order_not_found",
    });
  }

  if (orderRef.status === "REFUNDED") {
    return reconcileStripeFullRefundOutputSchema.parse({
      ok: true,
      paymentIntentId: input.paymentIntentId,
      orderId: orderRef.id,
      orderSource: null,
      outcome: "already_refunded",
    });
  }

  if (orderRef.status !== "SUCCEEDED" && orderRef.status !== "PART_REFUNDED") {
    return reconcileStripeFullRefundOutputSchema.parse({
      ok: true,
      paymentIntentId: input.paymentIntentId,
      orderId: orderRef.id,
      orderSource: null,
      outcome: "order_not_succeeded",
    });
  }

  const order = await deps.repos.orders.getById(orderRef.id);
  if (!order) {
    return reconcileStripeFullRefundOutputSchema.parse({
      ok: true,
      paymentIntentId: input.paymentIntentId,
      orderId: orderRef.id,
      orderSource: null,
      outcome: "order_not_found",
    });
  }

  const expectedAmountCents = computeExpectedPaymentAmount(order);
  const isPartial =
    input.fullyRefundedHint === false ||
    input.amountRefundedCents < expectedAmountCents;
  if (isPartial) {
    const outcome = await reconcileExternalPartialRefund(
      deps,
      input,
      order,
      expectedAmountCents,
      logger,
    );
    // No claim notice here: the partial arm never marks a RESALE order
    // REFUNDED (the listing unwind lives only in the full arm below).
    return reconcileStripeFullRefundOutputSchema.parse({
      ok: true,
      paymentIntentId: input.paymentIntentId,
      orderId: order.id,
      orderSource: order.source,
      outcome,
    });
  }

  const flagForManualReview = (resaleLinkedTransferredItemIds: string[]) => {
    const reviewContext = {
      orderId: order.id,
      paymentIntentId: input.paymentIntentId,
      refundId: input.refundId,
      sourceEventType: input.sourceEventType,
      orderSource: order.source,
      resaleLinkedTransferredItemIds,
    };
    logger?.warn("reconcileStripeFullRefund.manual_review_required", reviewContext);
    // The webhook is acked and nothing retries it, so a person has to hear
    // about this: warn is not captured by Sentry, the reporter is.
    reportBestEffort(
      deps,
      new Error("stripe_full_refund_needs_manual_review"),
      "manual_review_required",
      reviewContext,
      "manualReview",
    );
    return reconcileStripeFullRefundOutputSchema.parse({
      ok: true,
      paymentIntentId: input.paymentIntentId,
      orderId: order.id,
      orderSource: order.source,
      outcome: "manual_review_required",
    });
  };

  const transferredItemIds = getManualReviewTransferredTicketItemIds(order);
  if (transferredItemIds.length > 0) {
    return flagForManualReview(transferredItemIds);
  }

  if (order.source === "RESALE") {
    // The money has already moved, so nothing may be refused here that is
    // handled further down without throwing: a refund already unwound, and
    // a ticket sold on since the transferred-item check above (its buyer's
    // finalize can land in between). The transaction below reads the order
    // again under the ticket lock and sends that one to manual review; the
    // unwind's own sold-on branch is a defence behind it.
    await assertResaleOrderCanBeUnwound(deps.repos, order, {
      allowAlreadyUnwound: true,
      allowSoldOn: true,
    });
  }

  let lateTransferredItemIds: string[] = [];
  const now = deps.clock.now();
  // Refund mutex (W1): serialize against every refund-CREATING path. The
  // internal refund that raced us is often the very thing that fired this
  // webhook, so the window is self-arming — hence the bounded retry in
  // withMutexRetry (typical conflicts self-heal in-process; exhaustion
  // throws `refund_mutex_conflict` → DLQ, which an OPERATOR must replay).
  /** Sellers to tell after the commit (a legacy listing the unwind closed). */
  let relistNotices: LegacyRelistNotice[] = [];
  const outcome = await withMutexRetry(
    deps,
    order.id,
    logger,
    () =>
      deps.repos.tx(async (tx) => {
    // A retried attempt starts clean: only the attempt that commits counts.
    relistNotices = [];
    const snapshot = await tx.orders.getById(order.id);
    if (!snapshot) {
      return "order_not_found" as const;
    }

    // RESALE: lock each ticket row FIRST, before the order is read for
    // decisions and before any of its items is written.
    //
    // Ticket, then item, then listing is the order a later buyer's finalize
    // takes (`commit` writes the ticket, then the listing, then flips this
    // very item to `transferred`). The buyer being refunded may have listed
    // the ticket again (owner ruling 2026-10-11), so such a finalize can be
    // in flight. Two things follow:
    //  - writing the item first and the ticket second (in the unwind) is a
    //    40P01 cycle with it, and a deadlock here fails a refund Stripe has
    //    already paid (measured against Postgres before this lock existed);
    //  - this lock can WAIT behind that finalize, so nothing read before it
    //    may be acted on. The order is read again below, under the lock.
    if (snapshot.source === "RESALE") {
      for (const item of snapshot.items) {
        if (item.kind !== "ticket") continue;
        const held = await tx.tickets.getByOrderItemId(item.id);
        if (held) await tx.tickets.getByIdForUpdate(held.id);
      }
    }

    // The read every decision below is made on. For a RESALE order it is
    // taken with the ticket rows locked: no finalize can commit a sale of
    // those tickets from here on, and one that committed while the lock
    // waited is visible (the item reads `transferred`).
    const fresh =
      snapshot.source === "RESALE"
        ? await tx.orders.getById(order.id)
        : snapshot;
    if (!fresh) {
      return "order_not_found" as const;
    }

    if (fresh.status === "REFUNDED") {
      return "already_refunded" as const;
    }

    if (fresh.status !== "SUCCEEDED" && fresh.status !== "PART_REFUNDED") {
      return "order_not_succeeded" as const;
    }

    // Re-check on the fresh read: a gift that commits between the snapshot
    // above and this tx would otherwise be unwound out of the recipient's
    // hands. Moves now take this same order mutex (owner ruling 2026-10-05,
    // `_helpers/with-ticket-refund-lock.ts`), so none can commit while this
    // tx runs; one that committed before the acquire is caught here.
    //
    // A RESALE buyer's own onward sale does NOT take this order's mutex (it
    // is another order's checkout), which is why the read above waits for
    // the ticket lock: a ticket sold on goes to manual review whether its
    // sale committed before this transaction or while it waited. Nobody is
    // debited and nothing is written; a person settles it. Acting on the
    // earlier read instead wrote `refunded` over `transferred` and debited
    // the first seller for a ticket they never got back.
    lateTransferredItemIds = getManualReviewTransferredTicketItemIds(fresh);
    if (lateTransferredItemIds.length > 0) {
      return "manual_review_required" as const;
    }

    /** Seats returned to the pool by this reconciliation (audit trail). */
    let releasedSeatIds: string[] = [];
    /** Voided tickets that had admitted someone: they left (audit trail). */
    let leftOnRefund: TicketLeavingOnRefund[] = [];

    const refundedNowItemIds: string[] = [];
    for (const item of fresh.items) {
      if (item.kind !== "ticket") {
        continue;
      }

      if (
        item.status === "refunded" ||
        item.refundedAt ||
        item.status === "transferred" ||
        item.transferredAt
      ) {
        continue;
      }

      await tx.orderItems.updateStatus(item.id, "refunded", now);
      refundedNowItemIds.push(item.id);
    }

    await tx.orders.markRefunded(fresh.id);

    /** RESALE only: what happens to the listing the ticket goes back to. */
    let listingDisposition: "restore_active" | "cancel" | undefined;
    if (fresh.source === "RESALE") {
      // An APPROVED claim means staff ruled this ticket bad for the buyer
      // (invalid / entry denied / wrong seat): putting it back on sale would
      // sell the same bad ticket to someone else. review-claim's own success
      // tx cancels the listing; this is the same rule for a claim refund the
      // webhook finishes (pending refund, or the webhook winning the race).
      listingDisposition = (await hasApprovedClaim(tx, fresh.items))
        ? "cancel"
        : "restore_active";
      const unwound = await unwindResaleOrderAfterRefund(tx, {
        order: fresh,
        clock: deps.clock,
        logger,
        listingDisposition,
        reportError: deps.reportError,
      });
      relistNotices = unwound.relistNotices;
    } else {
      // Default flags: a LISTED ticket is ineligible upstream and a
      // TRANSFERRED item's pass belongs to somebody else — neither is this
      // reconciliation's to kill, and neither seat is its to re-sell.
      ({ releasedSeatIds, leftOnRefund } = await markOrderTicketsRefunded(
        tx,
        fresh.id,
        { at: now },
      ));
    }

    // ── The one refund rule (spec §4): always write the REFUND_DEBIT ───────
    // External (Stripe-dashboard) refunds get the SAME ledger treatment as
    // internal ones — this replaces the deleted resale-only
    // `settlements.cancelForOrder`. The refund key is the Stripe refund id
    // this webhook reconciles, so an internal path that already debited
    // under the same refund replays to a no-op (and cross-key overlaps net
    // out via the Σ-prior-debits arithmetic). Skipped transferred items keep
    // their revenue and force partial math.
    const refundedNowIds = new Set(refundedNowItemIds);
    const attemptedFullRefund = fresh.items
      .filter((item) => item.kind === "ticket")
      .every(
        (item) =>
          refundedNowIds.has(item.id) ||
          item.status === "refunded" ||
          Boolean(item.refundedAt),
      );
    const refundDebits = await writeRefundDebitsForOrder(tx, {
      order: { id: fresh.id, currency: fresh.currency },
      refundedItemIds: refundedNowItemIds,
      // Prefer the Stripe refund id (stable per refund). The fallback is
      // namespaced with the refunded amount (Step C review): a bare PI id
      // would collapse two distinct external refunds on the same PI into one
      // idempotency key, silently deduping the second debit. charge.refunded
      // does not carry a refund id; refund.updated does.
      refundKey:
        input.refundId ?? `pi:${input.paymentIntentId}:${input.amountRefundedCents}`,
      attemptedFullRefund,
      useCase: "reconcileStripeFullRefund",
      logger,
      reportError: deps.reportError,
    });

    await tx.promos.releaseHoldsForOrder(fresh.id);

    await tx.audit.log({
      entity: "order",
      entityId: fresh.id,
      action: "stripe_refund_reconciled",
      data: {
        paymentIntentId: input.paymentIntentId,
        refundId: input.refundId ?? null,
        sourceEventType: input.sourceEventType,
        amountRefundedCents: input.amountRefundedCents,
        expectedAmountCents,
        currency: input.currency ?? fresh.currency,
        orderSource: fresh.source,
        ledgerRefundDebits: refundDebits,
        // Every sibling refund path records this; without it the externally
        // triggered refund would be the one seat release with no audit trail.
        releasedSeatIds:
          releasedSeatIds.length > 0 ? releasedSeatIds : undefined,
        // Scanned-in tickets this refund voided: the person left.
        ...leftOnRefundAuditData(leftOnRefund),
        listingDisposition,
      },
      at: now,
    });

    return fresh.source === "RESALE"
      ? ("reconciled_resale" as const)
      : ("reconciled_primary" as const);
      }),
  );

  if (outcome === "manual_review_required") {
    return flagForManualReview(lateTransferredItemIds);
  }

  // Only the reconcile that flipped the order: a redelivery returns
  // `already_refunded` above. The notice keeps its own once-per-claim record
  // as well, for the race with review-claim's own success path.
  if (outcome === "reconciled_resale") {
    await tellClaimBuyerRefunded(deps, order.id, input);
    // A seller whose listing the unwind closed (priced under the removed
    // markup split): best effort, never throws.
    await sendLegacyRelistNotices(
      {
        repos: deps.repos,
        clock: deps.clock,
        publicAppUrl: deps.publicAppUrl,
        logger,
        reportError: deps.reportError,
      },
      relistNotices,
    );
  }

  return reconcileStripeFullRefundOutputSchema.parse({
    ok: true,
    paymentIntentId: input.paymentIntentId,
    orderId: order.id,
    orderSource: order.source,
    outcome,
  });
}

/**
 * External PARTIAL refund reconciliation — ledger debits only.
 *
 * A Stripe-side partial refund (dashboard admin refund, or an async
 * payment-method refund that settled after an internal attempt failed)
 * carries a bare buyer-side amount and NO item granularity, so:
 *
 *  - **Money**: proportional REFUND_DEBITs via
 *    `writeExternalAmountRefundDebitsForOrder` (cumulative-target math —
 *    see its doc for the formula and spec §4.1 cite).
 *  - **Statuses: only what the refund NAMES** (money audit 2026-09-08
 *    #10). Internal refunds stamp the refunded item ids on the Stripe
 *    refund (`buildRefundMetadata`). When `deps.payments` is wired and the
 *    refund carries that identity for THIS order, exactly those items flip
 *    to `refunded` (3-arg `updateStatus`: tax attribution stays NULL — the
 *    quote that computed the share died with the failed tx, and a guessed
 *    share must not read as a measured one), their VALID/SCANNED tickets go
 *    REFUNDED — a LISTED one too, with ITS OWN listing cancelled in the same
 *    transaction (never the event's) so no voided pass is left buyable —
 *    their seats come back, and the order status follows the
 *    STAMPING use case: `refundFullOrder` uses its all-terminal rule
 *    (refunded OR transferred → REFUNDED), everything else the item path's
 *    rule (transferred is NOT terminal → PART_REFUNDED). On REFUNDED the
 *    fee-waiver allowance and promo holds are released, as both internal
 *    paths do. Three gates before any flip, each degrading to ledger-only
 *    with a report: the refund must be `succeeded` (a PENDING async refund
 *    — ACH, bank, Cash App — has moved no money yet; its
 *    `charge.refund.updated` arrives with the same refund id once it does,
 *    and the flip happens then); its amount must cover the named live
 *    items' refundable BASES within max(10 %, 100¢) (internal refunds
 *    withhold the processor fee share) so a $1 dashboard refund carrying a
 *    full item list cannot void tickets; and the order must be PRIMARY
 *    (a RESALE refund needs the listing unwind only the full arm does).
 *    Anything else — a dashboard refund with no metadata, a mismatched
 *    order or PaymentIntent, an unreadable list — leaves statuses
 *    UNTOUCHED: guessing item statuses would corrupt attribution (tickets,
 *    scan validity, resale links). Replays are inert: an already-refunded
 *    named item is skipped.
 *  - **No transfer reversal**: if the order was already paid out, internal
 *    paths would reverse transfers per item — but the reversal machinery
 *    expects item granularity this refund doesn't have. The debit stands
 *    (debt-carry: the next payout cycle recoups by arithmetic, spec §4.3)
 *    and a distinct `external_partial_refund_after_payout` report lets an
 *    operator decide on a manual reversal.
 *  - **Idempotency**: refundKey is `${refundId}:${cumulativeAmount}` —
 *    refund id required (no id → report and skip rather than guess; the
 *    amount-only PI fallback the full arm uses would collapse two
 *    equal-amount partials). The cumulative-amount suffix exists because
 *    the refund id itself can be a BEST-EFFORT guess: `charge.refunded` on
 *    newer API versions embeds no refund list, and the `refunds.list`
 *    fetcher can hand back a NEWER refund's id for a delayed earlier event.
 *    Under a plain-refundId key that stale-id collision would key-replay
 *    (repo returns the first row, second amount silently ignored →
 *    persistent under-debit); with the amount suffix, distinct cumulatives
 *    never share a key, and the Σ-prior-debits recompute in the writer
 *    spans ALL prior REFUND_DEBIT rows regardless of key shape, so a
 *    wrong-id row still subtracts correctly from the next event's target.
 *    Retry-stable: the same event carries the same cumulative → same key.
 */
async function reconcileExternalPartialRefund(
  deps: ReconcileStripeFullRefundDeps,
  input: ReconcileStripeFullRefundInput,
  order: OrderRecord,
  expectedAmountCents: number,
  logger: LoggerPort | undefined,
): Promise<"partial_refund_reconciled" | "partial_refund_ignored"> {
  if (input.amountRefundedCents === 0) {
    // Genuinely zero-amount event: no money moved, nothing to debit —
    // silence is correct here (not a leak, not drift).
    return "partial_refund_ignored";
  }

  if (!input.refundId) {
    // charge.refunded payloads don't reliably carry a refund id (the
    // handler tries the embedded refund list, then a refunds.list fetch).
    // Without one there is no safe idempotency key — report and skip so an
    // operator can re-drive, never guess.
    logger?.error("reconcileStripeFullRefund.partial_missing_refund_id", {
      orderId: order.id,
      paymentIntentId: input.paymentIntentId,
      sourceEventType: input.sourceEventType,
      amountRefundedCents: input.amountRefundedCents,
    });
    try {
      deps.reportError?.(
        new Error("external_partial_refund_missing_refund_id"),
        {
          tags: {
            useCase: "reconcileStripeFullRefund",
            step: "externalPartialRefund",
            reason: "missing_refund_id",
          },
          extra: {
            orderId: order.id,
            paymentIntentId: input.paymentIntentId,
            sourceEventType: input.sourceEventType,
            amountRefundedCents: input.amountRefundedCents,
          },
        },
      );
    } catch {
      // A throwing reporter never changes behaviour.
    }
    return "partial_refund_ignored";
  }

  const refundId = input.refundId;
  // See the doc block above: `${refundId}:${cumulative}` so a stale
  // best-effort refund id can never key-replay away a later, larger
  // cumulative recompute. Raw input amount (not the writer's clamped value)
  // so the key is a pure function of the delivered event.
  const refundKey = `${refundId}:${input.amountRefundedCents}`;
  const now = deps.clock.now();

  // Which items did this refund pay back? Read BEFORE the mutex/tx — a
  // third-party HTTP call never sits inside an open transaction.
  const named = await resolveNamedOrderItemIds(
    deps,
    input,
    refundId,
    order,
    logger,
  );
  const namedItemIds = named?.orderItemIds ?? null;

  // Refund mutex (W1) — same posture as the full arm: the partial writer
  // reads Σ-prior-debits inside its own ReadCommitted tx, so racing an
  // in-flight internal refund (whose Stripe call fired this very webhook)
  // could read stale priors and over-debit append-only rows. Bounded retry
  // absorbs the typical self-armed conflict; exhaustion throws
  // `refund_mutex_conflict` → DLQ (operator replay only).
  return withMutexRetry(
    deps,
    order.id,
    logger,
    () =>
      deps.repos.tx(async (tx) => {
    const fresh = await tx.orders.getById(order.id);
    if (!fresh) {
      return "partial_refund_ignored" as const;
    }

    // A fully-REFUNDED order already carries full debits — the cumulative
    // target can add nothing; skip the write entirely.
    if (fresh.status !== "SUCCEEDED" && fresh.status !== "PART_REFUNDED") {
      return "partial_refund_ignored" as const;
    }

    const refundDebits = await writeExternalAmountRefundDebitsForOrder(tx, {
      order: { id: fresh.id, currency: fresh.currency },
      refundKey,
      cumulativeRefundedCents: input.amountRefundedCents,
      expectedBuyerTotalCents: expectedAmountCents,
      useCase: "reconcileStripeFullRefund",
      logger,
      reportError: deps.reportError,
    });

    // Debt-carry visibility: money already left Stripe-side but this
    // payee's revenue was ALREADY paid out — no automatic reversal from
    // this path (item-less), so an operator must decide.
    const paidOutItemIds = fresh.items
      .filter((item) => item.paidOutAt)
      .map((item) => item.id);
    if (refundDebits.length > 0 && (fresh.paidOutAt || paidOutItemIds.length > 0)) {
      logger?.error("reconcileStripeFullRefund.external_partial_refund_after_payout", {
        orderId: fresh.id,
        paymentIntentId: input.paymentIntentId,
        refundId,
        paidOutItemIds,
        refundDebits,
      });
      try {
        deps.reportError?.(new Error("external_partial_refund_after_payout"), {
          tags: {
            useCase: "reconcileStripeFullRefund",
            step: "externalPartialRefund",
            reason: "after_payout",
          },
          extra: {
            orderId: fresh.id,
            paymentIntentId: input.paymentIntentId,
            refundId,
            paidOutItemIds,
            refundDebits,
          },
        });
      } catch {
        // A throwing reporter never changes behaviour.
      }
    }

    // ── Flip the items the refund NAMED (money audit 2026-09-08 #10) ────
    const flippedItemIds: string[] = [];
    /**
     * The flipped items that were TRANSFERRED — i.e. the ones whose void
     * lands on a THIRD PARTY (the gift recipient, who never bought the
     * ticket and never sees the refund). Reported below; carried out here
     * because the audit row is written outside the naming branch.
     */
    const flippedTransferredItemIds: string[] = [];
    /**
     * The flipped items whose ticket was LISTED — sitting under an OPEN
     * resale listing. Voiding such a ticket is only HALF the heal (see the
     * loop): the listing has to die in this same transaction, or the pass is
     * dead while the listing is still buyable. Reported below for the same
     * reason the transferred set is — it kills a live listing out from under
     * a seller and an in-flight resale buyer.
     */
    const flippedListedItemIds: string[] = [];
    /** Open resale listings this heal cancelled (audit + report). */
    const cancelledListingIds: string[] = [];
    /**
     * Voided LISTED passes whose listing this arm could NOT close — a HELD
     * one (an in-flight resale checkout; `resaleListings.cancel` is
     * ACTIVE-gated), a SOLD one, or none at all. Each is a paid resale order
     * that will strand rather than a double-pay that executes, which is the
     * trade this arm deliberately takes; every one is reported so an operator
     * can settle it.
     */
    const unclosedResaleListings: Array<{
      orderItemId: string;
      listingId: string | null;
      listingStatus: string | null;
    }> = [];
    let releasedSeatIds: string[] = [];
    /** Voided tickets that had admitted someone: they left (audit trail). */
    const leftOnRefund: TicketLeavingOnRefund[] = [];
    let newOrderStatus: "PART_REFUNDED" | "REFUNDED" | null = null;
    if (namedItemIds && namedItemIds.length > 0) {
      if (fresh.source !== "PRIMARY") {
        // A resale order's refund must unwind the listing (restore the
        // seller's ticket) — only the full arm does that. Flipping the item
        // alone would strand the ticket, so report and leave it.
        logger?.error("reconcileStripeFullRefund.named_items_on_resale_order", {
          orderId: fresh.id,
          refundId,
          namedItemIds,
        });
        reportBestEffort(
          deps,
          new Error("external_partial_refund_named_items_on_resale_order"),
          "refund_metadata_resale_order",
          { orderId: fresh.id, refundId, namedItemIds },
        );
      } else {
        const itemsById = new Map(fresh.items.map((item) => [item.id, item]));
        // Live named ticket items — a replay / an item the internal tx did
        // reconcile is skipped.
        const toFlip = namedItemIds.flatMap((itemId) => {
          const item = itemsById.get(itemId);
          if (!item || item.kind !== "ticket") {
            return [];
          }
          if (item.status === "refunded" || item.refundedAt) {
            return [];
          }
          // A `transferred` item is normally none of this arm's business: the
          // pass belongs to whoever it was given to, and no refund path pays
          // the sender back for it — so a metadata list naming one would be
          // naming something Stripe never refunded.
          //
          // `cancelEvent` is the ONE exception, and only because it is the
          // one path that deliberately refunds transferred items: a gifted
          // ticket with no resale order behind it is refunded to whoever
          // paid, and every refunded item id is stamped into the refund's
          // metadata. That stamp is the proof this refund paid for THIS item,
          // so skipping it after a cancellation whose marking tx died would
          // leave the item unrecorded and its ticket a live pass for a
          // cancelled show. Every other stamping use case excludes
          // transferred items upstream, so the door opens for cancelEvent
          // alone; the amount gate below still bounds the flipped set.
          //
          // Do NOT "harden" this with an "event must be CANCELLED" gate: the
          // case this exists for is precisely the one where cancelEvent's
          // transaction died, so the event is still PUBLISHED. Such a gate
          // would close the exact door this opens.
          //
          // `named?.` and not `named.`: `named` cannot actually be null in
          // this branch (`namedItemIds` is derived from it), but TypeScript
          // does not narrow one const through another, so the non-optional
          // form is a TS18047. Same form as its siblings below.
          if (
            (item.status === "transferred" || item.transferredAt) &&
            named?.useCase !== "cancelEvent"
          ) {
            return [];
          }
          return [item];
        });

        // Amount gate: the flipped set is bounded by what the refund
        // actually PAID, not just by what its metadata claims. Internal
        // refunds withhold the processor-fee share, so allow max(10 %,
        // 100¢) under the named items' refundable basis; a $1 dashboard
        // refund carrying a full item list must not void the tickets.
        //
        // BASIS, not `computeItemBuyerPaid`: a discount is a separate
        // NEGATIVE line item, so the per-item buyer-paid figures are
        // PRE-discount and sum to more than the buyer was charged. Bounding
        // with them made a legitimate refund of a discounted order look
        // short whenever the discount exceeded ~10 %, which zeroed `toFlip`,
        // refused the heal and fired a FALSE `amount_mismatch` report — the
        // gate defeating the thing it guards. `allocateRefundItemBases` is
        // the shared definition (`lib/orders/refund-item-base.ts`): the
        // order's post-discount, pre-tax total allocated across every ticket
        // item by buyer-paid WEIGHT, so it collapses to the old number on an
        // undiscounted order and is exact on a discounted one.
        //
        // Deliberately pre-TAX while the refund amount includes tax: that
        // only makes the floor more generous on a taxed order, which is the
        // safe direction for a heal (a missed heal leaves a live pass; the
        // forgery defences are the PI / order / succeeded checks upstream).
        const itemBases = allocateRefundItemBases(
          fresh.items.filter((item) => item.kind === "ticket"),
          fresh,
        );
        const namedBuyerPaidCents = toFlip.reduce(
          (sum, item) => sum + (itemBases.get(item.id) ?? 0),
          0,
        );
        const minimumCents = Math.max(
          0,
          namedBuyerPaidCents -
            Math.max(Math.ceil(namedBuyerPaidCents * 0.1), 100),
        );
        const refundAmountCents = named?.refundAmountCents ?? 0;
        if (toFlip.length > 0 && refundAmountCents < minimumCents) {
          logger?.error("reconcileStripeFullRefund.refund_metadata_amount_mismatch", {
            orderId: fresh.id,
            refundId,
            refundAmountCents,
            namedBuyerPaidCents,
            minimumCents,
            namedItemIds,
          });
          reportBestEffort(
            deps,
            new Error("external_partial_refund_metadata_amount_mismatch"),
            "refund_metadata_amount_mismatch",
            {
              orderId: fresh.id,
              refundId,
              refundAmountCents,
              namedBuyerPaidCents,
              minimumCents,
              namedItemIds,
            },
          );
          toFlip.length = 0;
        }

        const voidedTickets: TicketRecord[] = [];
        for (const item of toFlip) {
          // Ticket read FIRST (it used to follow the status write): a LISTED
          // pass needs its listing closed right after the void, so the
          // answer cannot arrive afterwards.
          const ticket = await tx.tickets.getByOrderItemId(item.id);
          const ticketIsListed = ticket?.status === "LISTED";
          const voidTicket =
            ticket != null &&
            (ticket.status === "VALID" ||
              ticket.status === "SCANNED" ||
              ticketIsListed);

          // Void the pass BEFORE flipping its item: ticket row, then item
          // row, then listing row. `releaseHold`'s closing branches and
          // `expireStaleListings` lock ticket → listing → item, and the
          // resale checkout's link locks the ticket before it reads this
          // item; writing the item first made a 40P01 cycle with the first
          // two. Nothing between here and the item write reads the item.
          if (voidTicket && ticket) {
            // Taken BEFORE the write below, which clears `scannedAt`.
            leftOnRefund.push(...ticketsLeavingOnRefund([ticket]));
            await tx.tickets.setStatus(ticket.id, "REFUNDED", {
              scannedAt: null,
            });
            voidedTickets.push(ticket);
          }

          // A LISTED item is FLIPPED like any other, and that is the whole
          // point — do not be tempted to skip it. `item.status === "refunded"`
          // is the only field `finalizeResalePurchase` has to stop a seller
          // collecting the refund AND the resale proceeds on one ticket: its
          // guard throws `RESALE_ORIGINAL_ITEM_REFUNDED` and sends the paid
          // resale order to manual review. Leaving the item `active` because
          // the pass is listed DELETES that defence, and the double-pay then
          // executes silently — strictly worse than the state it was trying
          // to avoid. (Reachable without a cancellation: an internal refund's
          // marking tx dies after Stripe succeeded, the buyer lists the
          // still-VALID pass — `create-resale-listing` gates on ticket status
          // only — and this webhook arrives naming an item that is LISTED
          // now.)
          //
          // 3-arg form on purpose: `refundedTaxCents` stays NULL ("not
          // attributed") — the quote that measured this item's tax share
          // died with the failed transaction, and the reporting rollup
          // treats NULL as unknown rather than as a measured zero.
          await tx.orderItems.updateStatus(item.id, "refunded", now);
          flippedItemIds.push(item.id);
          if (item.status === "transferred" || item.transferredAt) {
            flippedTransferredItemIds.push(item.id);
          }

          if (voidTicket && ticket) {
            // ── The other half of a LISTED heal: close the listing ───────
            // A voided pass under an OPEN listing is its own broken state —
            // `resaleListings.commit` never looks at ticket status, so the
            // listing would sell a dead pass. And the pass must not be left
            // LISTED either: `expireStaleListings` resets LISTED → VALID and
            // would hand a refunded buyer a scannable ticket. So: void, then
            // close.
            //
            // THIS listing only — `getByTicketId` + `cancel` + clear the
            // item's pointer, the sequence `cancel-resale-listing.ts` uses.
            // NOT `cancelOpenForEvent`: this arm's invariant is only "no
            // voided pass under an open listing", which the narrow close
            // satisfies exactly, and the event-wide close is `cancelEvent`'s
            // own job (every other order's webhook heals its own listing).
            // One hand-typed metadata string on a $50 dashboard refund must
            // not terminally cancel every listing of a LIVE event, delete
            // their holds and DLQ every in-flight resale checkout.
            //
            // Ticket, then item (above), then listing: the order `commit`,
            // `cancelOpenListingsForEvent`, `expireStaleListings` and
            // `releaseHold` take.
            if (ticketIsListed) {
              flippedListedItemIds.push(item.id);
              const listing = await tx.resaleListings.getByTicketId(ticket.id);
              let closed = false;
              if (listing?.status === "ACTIVE") {
                await tx.resaleListings.cancel(
                  listing.id,
                  // The listing's OWN seller: `cancel` is seller-scoped for
                  // the buyer-facing use case, and there is no actor here.
                  listing.sellerHumanId,
                );
                // `cancel` is a status-conditional `updateMany` (ACTIVE
                // only), so a hold that landed between the read and the
                // write flips ZERO rows. It returns `Promise<boolean>` (true
                // when it flipped an ACTIVE listing); this site ignores that
                // on purpose and re-reads the listing instead. Confirm
                // rather than assume — an unclosed listing must be reported,
                // not silently counted as cancelled.
                const after = await tx.resaleListings.getById(listing.id);
                closed = after?.status === "CANCELLED";
                if (closed) {
                  // This arm only runs on a PRIMARY order (checked above);
                  // routed through the one pointer rule all the same, which
                  // never writes an item of a RESALE order.
                  await setListedNowPointer(tx, {
                    orderItemId: item.id,
                    listingId: null,
                    orderSource: fresh.source,
                  });
                  cancelledListingIds.push(listing.id);
                }
              }
              if (!closed) {
                // HELD (an in-flight resale checkout), SOLD, or gone. The
                // item is still flipped and the pass still voided: a
                // stranded PAID resale order is documented and recoverable
                // (`settleStrandedResaleOrders`), an executed double-pay is
                // not. Reported below.
                unclosedResaleListings.push({
                  orderItemId: item.id,
                  listingId: listing?.id ?? null,
                  listingStatus: listing?.status ?? null,
                });
              }
            }
          }
        }

        // Visible, not silent: this heal just voided passes that were UP FOR
        // SALE and cancelled their sellers' listings off the back of a
        // webhook. Rare by construction, so it is an alert rather than noise,
        // and it is what turns a FORGED metadata list into something an
        // operator sees instead of an invisible void.
        if (flippedListedItemIds.length > 0) {
          logger?.error("reconcileStripeFullRefund.flipped_listed_items", {
            orderId: fresh.id,
            refundId,
            metadataUseCase: named?.useCase ?? null,
            flippedListedItemIds,
            cancelledListingIds,
          });
          reportBestEffort(
            deps,
            new Error("external_partial_refund_flipped_listed_items"),
            "flipped_listed_items",
            {
              orderId: fresh.id,
              refundId,
              metadataUseCase: named?.useCase ?? null,
              flippedListedItemIds,
              cancelledListingIds,
            },
          );
        }

        // A voided pass whose listing is still open. The item IS flipped, so
        // `finalizeResalePurchase`'s guard now fires and the resale buyer's
        // order lands in manual review rather than paying the seller twice —
        // but somebody has to settle that order, so it cannot be silent.
        if (unclosedResaleListings.length > 0) {
          logger?.error(
            "reconcileStripeFullRefund.listed_item_listing_not_closed",
            {
              orderId: fresh.id,
              refundId,
              metadataUseCase: named?.useCase ?? null,
              unclosedResaleListings,
            },
          );
          reportBestEffort(
            deps,
            new Error("external_partial_refund_listing_not_closed"),
            "listed_item_listing_not_closed",
            {
              orderId: fresh.id,
              refundId,
              metadataUseCase: named?.useCase ?? null,
              unclosedResaleListings,
            },
          );
        }

        // Operator visibility for the one branch here whose effect lands on
        // somebody OUTSIDE the order: voiding a transferred item kills the
        // gift recipient's pass, and they neither bought it nor receive the
        // refund. Rare by construction — only `cancelEvent` metadata gets
        // past the filter above — so this is an alert, not noise, and it is
        // what turns a FORGED metadata list into something an operator sees
        // instead of a silent void.
        if (flippedTransferredItemIds.length > 0) {
          logger?.error(
            "reconcileStripeFullRefund.flipped_transferred_items",
            {
              orderId: fresh.id,
              refundId,
              metadataUseCase: named?.useCase ?? null,
              flippedTransferredItemIds,
            },
          );
          reportBestEffort(
            deps,
            new Error("external_partial_refund_flipped_transferred_items"),
            "flipped_transferred_items",
            {
              orderId: fresh.id,
              refundId,
              metadataUseCase: named?.useCase ?? null,
              flippedTransferredItemIds,
            },
          );
        }

        if (flippedItemIds.length > 0) {
          releasedSeatIds = await releaseSeatsForVoidedTickets(
            tx,
            voidedTickets,
            now,
          );
          // Order status by the STAMPING use case's own rule:
          //   refundFullOrder — all-terminal: refunded OR transferred count.
          //   cancelEvent — a transferred item this heal did NOT flip is
          //     still terminal. Since the filter above admits every
          //     transferred item cancelEvent NAMED, a named one is already in
          //     `flipped`; the only item this clause can still be reaching is
          //     a transferred item cancelEvent deliberately left out of the
          //     refund — i.e. a RESALE PARENT whose resale refund FAILED,
          //     which cancel classifies `"keep"` and never puts in
          //     `refundableAmountsByItem`, so it is never named. cancelEvent
          //     itself closes such an order with an unconditional
          //     `markRefunded(orderId)` — no partial amount — so counting it
          //     terminal here reproduces what the cancellation would have
          //     written.
          //   everything else — refund-order-items: only refunded counts, a
          //   transferred item keeps the order PART_REFUNDED.
          //
          // CONSEQUENCE, stated here because this is where someone will look
          // for it: REFUNDED closes the door on any later REFUND_DEBIT for
          // that kept item. A redelivery of this refund hits the
          // `already_refunded` early return at the top of this use case,
          // which returns before writing any debit at all.
          //
          // `markRefunded`'s second argument is a partial FLAG, so the
          // event's cumulative amount is fine here.
          const flipped = new Set(flippedItemIds);
          const transferredIsTerminal =
            named?.useCase === "refundFullOrder" ||
            named?.useCase === "cancelEvent";
          const allTerminal = fresh.items
            .filter((item) => item.kind === "ticket")
            .every(
              (item) =>
                item.status === "refunded" ||
                flipped.has(item.id) ||
                (transferredIsTerminal && item.status === "transferred"),
            );
          newOrderStatus = allTerminal ? "REFUNDED" : "PART_REFUNDED";
          await tx.orders.markRefunded(
            fresh.id,
            allTerminal ? undefined : input.amountRefundedCents,
          );
          // Whole order gone → give the fee-waiver allowance and the promo
          // holds back, exactly as both internal paths do on REFUNDED.
          if (allTerminal) {
            await tx.feeWaivers.release(fresh.id);
            await tx.promos.releaseHoldsForOrder(fresh.id);
          }
        }
      }
    }

    await tx.audit.log({
      entity: "order",
      entityId: fresh.id,
      action: "stripe_partial_refund_reconciled",
      data: {
        paymentIntentId: input.paymentIntentId,
        refundId,
        refundKey,
        sourceEventType: input.sourceEventType,
        amountRefundedCents: input.amountRefundedCents,
        expectedAmountCents,
        currency: input.currency ?? fresh.currency,
        orderSource: fresh.source,
        ledgerRefundDebits: refundDebits,
        paidOutItemIds,
        namedOrderItemIds: namedItemIds ?? undefined,
        flippedOrderItemIds:
          flippedItemIds.length > 0 ? flippedItemIds : undefined,
        // The subset whose void took a third party's pass (see the report
        // above) — an operator reading this row should not have to re-derive
        // which flip was a gift recipient's.
        flippedTransferredOrderItemIds:
          flippedTransferredItemIds.length > 0
            ? flippedTransferredItemIds
            : undefined,
        // The subset whose pass was up for RESALE, plus the listings this
        // heal cancelled to make that void safe. Same reason as above: an
        // operator reading this row should not have to re-derive which flip
        // took a live listing off the market.
        flippedListedOrderItemIds:
          flippedListedItemIds.length > 0 ? flippedListedItemIds : undefined,
        cancelledResaleListingIds:
          cancelledListingIds.length > 0 ? cancelledListingIds : undefined,
        // Voided passes whose listing is still open — the resale orders a
        // human has to settle.
        unclosedResaleListings:
          unclosedResaleListings.length > 0 ? unclosedResaleListings : undefined,
        newOrderStatus: newOrderStatus ?? undefined,
        releasedSeatIds:
          releasedSeatIds.length > 0 ? releasedSeatIds : undefined,
        // Scanned-in tickets this refund voided: the person left.
        ...leftOnRefundAuditData(leftOnRefund),
      },
      at: now,
    });

    return "partial_refund_reconciled" as const;
      }),
  );
}

type NamedRefundItems = {
  orderItemIds: string[];
  /** The stamping use case (drives the order-status predicate). */
  useCase: string | null;
  /** This refund's OWN amount (not the charge's cumulative) — the amount gate. */
  refundAmountCents: number;
};

/**
 * The item ids an internal refund stamped on the Stripe refund, filtered to
 * this order's items — or `null` when there is nothing trustworthy to act
 * on. Every failure mode degrades to `null` (= today's ledger-only
 * behaviour) and is reported; none of them may block the ledger debit.
 */
async function resolveNamedOrderItemIds(
  deps: ReconcileStripeFullRefundDeps,
  input: ReconcileStripeFullRefundInput,
  refundId: string,
  order: OrderRecord,
  logger: LoggerPort | undefined,
): Promise<NamedRefundItems | null> {
  // `getRefund` is optional on the port (the not-configured / e2e stubs
  // omit it); no reader means no recoverable identity — ledger-only.
  const payments = deps.payments;
  if (!payments?.getRefund) {
    return null;
  }

  let refund: Awaited<ReturnType<NonNullable<PaymentProcessorPort["getRefund"]>>>;
  try {
    refund = await payments.getRefund({ refundId });
  } catch (err) {
    logger?.error("reconcileStripeFullRefund.refund_metadata_lookup_failed", {
      orderId: order.id,
      refundId,
      error: describeError(err),
    });
    reportBestEffort(deps, err, "refund_metadata_lookup_failed", {
      orderId: order.id,
      refundId,
    });
    return null;
  }

  // The refund id is a BEST-EFFORT guess upstream (`refunds.list` nearest
  // `created`); a refund on another PI is not this order's.
  if (
    refund.paymentIntentId !== null &&
    refund.paymentIntentId !== input.paymentIntentId
  ) {
    logger?.error("reconcileStripeFullRefund.refund_metadata_pi_mismatch", {
      orderId: order.id,
      refundId,
      paymentIntentId: input.paymentIntentId,
      refundPaymentIntentId: refund.paymentIntentId,
    });
    reportBestEffort(
      deps,
      new Error("external_partial_refund_metadata_pi_mismatch"),
      "refund_metadata_pi_mismatch",
      {
        orderId: order.id,
        refundId,
        paymentIntentId: input.paymentIntentId,
        refundPaymentIntentId: refund.paymentIntentId,
      },
    );
    return null;
  }

  // Only money that has MOVED may void a ticket. Stripe bumps the charge's
  // `amount_refunded` when an async refund (ACH / bank / Cash App) is
  // CREATED, so a pending refund reaches this arm; flipping now and having
  // the refund fail later would leave the buyer with neither ticket nor
  // money. `charge.refund.updated` re-enters with this refund id once it
  // succeeds, and the flip happens then.
  if (refund.status !== "succeeded") {
    // `pending` / `requires_action` is the HEALTHY shape of an async refund
    // (ACH, bank, Cash App): the internal path issued it and deliberately
    // left the items alone; the flip lands when `charge.refund.updated`
    // re-enters with this refund id. Not a Sentry event — it would fire on
    // every working async refund. `failed` / `canceled` reaching a
    // `charge.refunded` reconcile IS an anomaly and is reported.
    const inFlight =
      refund.status === "pending" || refund.status === "requires_action";
    if (inFlight) {
      logger?.warn("reconcileStripeFullRefund.refund_metadata_in_flight", {
        orderId: order.id,
        refundId,
        status: refund.status,
      });
      return null;
    }
    logger?.error("reconcileStripeFullRefund.refund_metadata_not_succeeded", {
      orderId: order.id,
      refundId,
      status: refund.status,
    });
    reportBestEffort(
      deps,
      new Error("external_partial_refund_metadata_not_succeeded"),
      "refund_metadata_not_succeeded",
      { orderId: order.id, refundId, status: refund.status },
    );
    return null;
  }

  const parsed = parseRefundMetadataOrderItemIds(refund.metadata);
  if (parsed.kind === "absent") {
    return null;
  }
  if (parsed.kind === "unusable") {
    logger?.error("reconcileStripeFullRefund.refund_metadata_unusable", {
      orderId: order.id,
      refundId,
      reason: parsed.reason,
    });
    reportBestEffort(
      deps,
      new Error("external_partial_refund_metadata_unusable"),
      "refund_metadata_unusable",
      { orderId: order.id, refundId, reason: parsed.reason },
    );
    return null;
  }
  if (parsed.orderId !== null && parsed.orderId !== order.id) {
    logger?.error("reconcileStripeFullRefund.refund_metadata_order_mismatch", {
      orderId: order.id,
      refundId,
      metadataOrderId: parsed.orderId,
    });
    reportBestEffort(
      deps,
      new Error("external_partial_refund_metadata_order_mismatch"),
      "refund_metadata_order_mismatch",
      { orderId: order.id, refundId, metadataOrderId: parsed.orderId },
    );
    return null;
  }

  const known = new Set(order.items.map((item) => item.id));
  const unknownIds = parsed.orderItemIds.filter((id) => !known.has(id));
  if (unknownIds.length > 0) {
    // Same order, ids we do not have: act on the ones we know, surface the rest.
    logger?.error("reconcileStripeFullRefund.refund_metadata_unknown_items", {
      orderId: order.id,
      refundId,
      unknownIds,
    });
    reportBestEffort(
      deps,
      new Error("external_partial_refund_metadata_unknown_items"),
      "refund_metadata_unknown_items",
      { orderId: order.id, refundId, unknownIds },
    );
  }
  return {
    orderItemIds: parsed.orderItemIds.filter((id) => known.has(id)),
    useCase: parsed.useCase,
    refundAmountCents: refund.amountCents,
  };
}

/**
 * Ticket items whose pass now belongs to someone else, so an external full
 * refund can't settle them automatically and goes to manual review.
 *
 * - PRIMARY: a transferred item that was sold on through a resale listing.
 * - RESALE (owner ruling 2026-10-05): any transferred ticket item. The buyer
 *   gifted or resold the ticket, and the unwind finds it by this order item
 *   and would take it from whoever holds it now.
 */
function getManualReviewTransferredTicketItemIds(order: {
  source: string;
  items: OrderItemRecord[];
}): string[] {
  if (order.source !== "PRIMARY" && order.source !== "RESALE") {
    return [];
  }

  return order.items
    .filter((item) => {
      if (item.kind !== "ticket") {
        return false;
      }

      if (item.status !== "transferred" && !item.transferredAt) {
        return false;
      }

      if (order.source === "RESALE") {
        return true;
      }

      return Boolean(
        item.resaleListingId ?? getMetaString(item.meta, "resaleListingId"),
      );
    })
    .map((item) => item.id);
}
