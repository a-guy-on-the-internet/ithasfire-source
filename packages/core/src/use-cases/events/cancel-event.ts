import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type {
  PaymentProcessorPort,
  PaymentRefundStatus,
} from "@th/ports/payment-processor-port";
import type { EventRecord } from "@th/ports/repos/events";
import type { ImageRecord } from "@th/ports/repos/images";
import type { OrderItemRecord } from "@th/ports/repos/order-items";
import type { OrderRecord } from "@th/ports/repos/orders";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { EnqueuePendingObjectDeletionItem } from "@th/ports/repos/pending-object-deletions";
import type { ReporterPort } from "@th/ports/reporter";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import { abandonClaim } from "../../lib/idempotency-claim";
import { describeError, parseInput } from "../../lib/io";
import { reindexAfterMutation } from "../search/reindex-after-mutation";
import { markForSearchReindex } from "../search/search-reindex-marks";
import {
  eventSearchDocId,
  scrubSearchDocumentsOrReport,
} from "../search/privacy-scrub";
import {
  collectEventAudioDeletionTargets,
  eventStorageQuotaSubject,
  type EventAudioDeletionTargets,
} from "../storage/event-media-targets";
import { computeExpectedPaymentAmount } from "../../lib/orders/compute-expected-payment-amount";
import { getMetaString } from "../../lib/orders/meta";
import { allocateRefundTaxShares } from "../../lib/orders/refund-tax-share";
import {
  allocateRefundTaxSharesForOrder,
  type OrderRefundTaxShares,
} from "../orders/_shared/refund-tax-shares-for-order";
import {
  requireOrgMembership,
  requirePlatformStaff,
  ORG_ADMIN_ROLES,
} from "../../lib/rbac";
import { appendBookingEventCancelledEntry } from "./_shared/booking-event-ledger";
import { settleStrandedResaleOrders } from "./_shared/settle-stranded-resale-orders";
import { refundCashOrdersForCancelledEvent } from "./_shared/refund-cash-orders-for-cancelled-event";
import { voidPendingPosOrdersForCancelledEvent } from "./_shared/void-pending-pos-orders-for-cancelled-event";
import { markOrderTicketsRefunded } from "../orders/mark-order-tickets-refunded";
import { allocateFullRefundShares } from "../orders/refund-full-order";
import {
  reverseTransfersForItems,
  type TransferReversalResult,
} from "../orders/reverse-transfers-for-items";
import {
  groupReversalsByPayee,
  writeRefundDebitsForOrder,
  writeTransferReversalCreditsForOrder,
} from "../orders/_shared/write-refund-debits";
import {
  ORDER_REFUND_MUTEX_TTL_SECONDS,
  tryAcquireOrderRefundMutex,
  type HeldOrderRefundMutex,
} from "../orders/_shared/refund-mutex";
import { tryAcquireEventCancelMutex } from "./_shared/event-cancel-mutex";
import {
  buildRefundMetadata,
  refundPaymentIntentOrDependencyFailed,
} from "../orders/_shared/dispute-refund-guard";
import { buildNoChargeRefundId } from "../orders/_shared/no-charge-refund";
import { allocateRefundPlatformFeeShares } from "../orders/_shared/refund-platform-fee-share";
import { isBlockedSettlementDisputeStatus } from "../settlements/dispute-statuses";
import { incrementResourceUsage } from "../quotas/enforce-quota";
import { fail, isAppError } from "@th/errors";
import {
  assertResaleOrderCanBeUnwound,
  unwindResaleOrderAfterRefund,
} from "../resale/unwind-resale-order-after-refund";
import { ensureActorHoldsHumanEventRole } from "../../lib/event-edit-rights";
import { callOffRemainingDates } from "../community/_shared/call-off-remaining-dates";

const IDEMPOTENCY_TTL_SECONDS = 300;

export const cancelEventInputSchema = z.object({
  actorHumanId: z.uuid(),
  eventId: z.uuid(),
  clientKey: z.string().min(8),
});

export const cancelEventOutputSchema = z.object({
  eventId: z.uuid(),
  status: z.literal("CANCELLED"),
  refundedOrderCount: z.number().int().nonnegative(),
  failedRefundCount: z.number().int().nonnegative(),
  // ── The four resale-settlement fields below are `.optional()` ONLY for
  //    cross-deploy replay. The use case ALWAYS populates them. But a
  //    cancellation that ran on the previous build stored a response without
  //    them in the idempotency record (TTL 300s), and a replay inside that
  //    window returns that record straight through this schema at the tRPC
  //    `.output()` boundary — required fields would turn a successful replay
  //    into a 500. Read `undefined` as "this cancellation predates the
  //    stranded-resale phase", NOT as zero. Do not make them required, and do
  //    not give them `.default(0)` — a default would let a pre-change
  //    cancellation that genuinely stranded a buyer read as clean.
  /**
   * PENDING RESALE orders this cancellation CANCELLED because their
   * PaymentIntent was proven dead. Nobody was charged for any of them.
   * See `settleStrandedResaleOrders`.
   */
  cancelledPendingResaleOrderCount: z.number().int().nonnegative().optional(),
  /**
   * PENDING RESALE orders whose PaymentIntent had already SUCCEEDED — the
   * buyer paid for a resale ticket whose finalize this very cancellation
   * killed. Refunded in full, because there is no ticket to give them.
   */
  refundedPendingResaleOrderCount: z.number().int().nonnegative().optional(),
  /**
   * PENDING RESALE orders left UNSETTLED: the PaymentIntent is still
   * `processing`, Stripe was unreachable, or the refund failed. Each one is
   * a buyer who may be out of pocket. Every one is also reported to Sentry;
   * this count exists so a caller cannot read a cancellation as clean when
   * it is not.
   */
  strandedPendingResaleOrderCount: z.number().int().nonnegative().optional(),
  /**
   * True when the scan for PENDING resale orders failed outright, which makes
   * the three counts above meaningless rather than zero. A caller must NOT
   * read `strandedPendingResaleOrderCount === 0` as "no buyer is stuck"
   * without also reading this.
   */
  strandedPendingResaleScanFailed: z.boolean().optional(),
  // ── Door cash sales (owner ruling 2026-10-07). `.optional()` for the same
  //    cross-deploy replay reason as the resale fields above: `undefined`
  //    means "this cancellation predates the cash phase", NOT zero.
  /**
   * Door cash orders (comps included) this cancellation refunded: marked
   * REFUNDED, tickets voided, and what each sale's CASH_SALE_DEBIT claimed
   * (tax; fee + tax before 2026-10-08) no longer owed (the debit reversed). The organiser hands the cash back.
   */
  refundedCashOrderCount: z.number().int().nonnegative().optional(),
  /**
   * Door cash orders this cancellation could NOT refund: still SUCCEEDED,
   * their CASH_SALE_DEBIT still owed. Each was reported to Sentry; the door sweep
   * (`settleDoorOrdersOnCancelledEvents`, cart reaper job) retries them.
   */
  failedCashRefundCount: z.number().int().nonnegative().optional(),
  /**
   * True when the scan for the event's cash orders failed outright, which
   * makes the two cash counts meaningless rather than zero.
   */
  cashRefundScanFailed: z.boolean().optional(),
  /**
   * PENDING door card sales this cancellation voided (PaymentIntent proven
   * dead, order CANCELLED), so a tap after the cancel cannot mint tickets.
   */
  voidedPendingPosOrderCount: z.number().int().nonnegative().optional(),
  /**
   * PENDING door card sales it could NOT void — typically a tap that landed
   * as the event was cancelled. Each was reported to Sentry.
   */
  failedPendingPosVoidCount: z.number().int().nonnegative().optional(),
  /** True when the scan for PENDING door card sales failed outright. */
  pendingPosScanFailed: z.boolean().optional(),
});

export type CancelEventInput = z.infer<typeof cancelEventInputSchema>;
export type CancelEventOutput = z.infer<typeof cancelEventOutputSchema>;

export type CancelEventDeps = {
  repos: Repos;
  /** Needed for the FR-014 platform-ADMIN takedown of COMMUNITY listings. */
  authz: Pick<AuthZPort, "hasStaffRole">;
  payments: PaymentProcessorPort;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Optional search port. When provided, the just-cancelled event is REMOVED
   * from the search index (the incremental event reindex is upsert-or-delete: a
   * non-PUBLISHED event is deleted) so it stops appearing on main search + the
   * search-served embed without waiting for the nightly full reindex. Failures
   * are reported/logged but never block the cancel.
   */
  search?: MultiSearchPort;
  /**
   * Best-effort Sentry reporter for this use case's deliberate swallows: the
   * fire-and-forget reindex, the best-effort media collection, a disabled
   * gift detection, an exhausted processing-fee read (whose order lands in
   * `failedRefundCount` and is retried by nobody — `ensureEventCancellable`
   * refuses every later attempt), and a door cash order the post-commit cash
   * phase could not refund (`failedCashRefundCount`). None of them reaches a tRPC/fastify
   * backstop, and a bare `logger.warn` is NOT captured, so without this they
   * are invisible. Wire it from `ctx.reportError` (CLAUDE.md error
   * convention).
   */
  reportError?: ReporterPort;
};

interface StoredCancelEventRecord {
  payloadHash: string;
  response: CancelEventOutput;
}

export async function cancelEvent(
  deps: CancelEventDeps,
  rawInput: unknown,
): Promise<CancelEventOutput> {
  return runCancelEvent(deps, rawInput, null);
}

/**
 * Cancel booking's entry into this use case (booking-the-night FR-009, N13):
 * the SAME cancellation — refunds per the rules above, resale settling, media
 * cleanup, the change-notice outbox — with three differences, each decided
 * by the caller:
 *
 *   - ACCESS: the caller already authorized the actor as a party to the
 *     BOOKING (the venue side or the sender pair), which is the authority
 *     Cancel booking runs on (N13: "venue or sender"). The owner check
 *     (`ensureEventAccessible`) is therefore not run — the sender is not an
 *     admin of the venue's event — and the audit row says
 *     `via: "booking_cancel"`.
 *   - IDEMPOTENCY: the caller supplies the key (`idempotencyKey`), scoped to
 *     the BOOKING rather than the actor, so a retry by either side converges
 *     on the same record and the same Stripe refund keys (they derive from
 *     it) — never a second refund attempt under a new key.
 *   - `withinTx`: the booking's own writes (terms cancelled, the booked hold
 *     released, the ledger) run INSIDE this cancellation's transaction, right
 *     after the event row is cancelled — so the event's CANCELLED and the
 *     night's release commit together or not at all: a freed night never
 *     carries a live event, and a cancelled event never keeps a booked night.
 *     It runs after `events.cancel` on purpose: the event row lock first,
 *     then the booking's locks — the order publish takes them in (event row,
 *     then the line), so the two never wait on each other in a cycle. A throw
 *     from it rolls the whole cancellation back (the refunds issued before
 *     the transaction are then reconciled exactly as for any rolled-back
 *     cancel — see the refund metadata note in `refundLoadedOrder`).
 */
export type CancelEventForBookingArgs = {
  actorHumanId: string;
  eventId: string;
  /** Booking-scoped (not actor-scoped); also prefixes the Stripe keys. */
  idempotencyKey: string;
  withinTx: (tx: TxRepos, event: EventRecord) => Promise<void>;
  /**
   * What the audit row says the access was: `booking_cancel` (Cancel
   * booking) by default, `booking_exit` when an exit after accept (Withdraw
   * / Close request) cancels the request's still-DRAFT event with it.
   */
  auditVia?: "booking_cancel" | "booking_exit";
  /**
   * Read-only re-check of the booking's deterministic refusals (on the booked
   * night, still the booking's event, still cancellable), run AFTER the event
   * is loaded and BEFORE any refund is issued — so the common refusal happens
   * before money moves instead of after (a refusal in `withinTx` rolls the
   * cancellation back with the refunds already out). Runs on the root repos,
   * outside the transaction; a throw releases the idempotency claim like any
   * other failure before the first refund. `withinTx` re-checks the same
   * things under the locks — this is the cheap early exit, not the guard.
   */
  preRefundCheck?: (event: EventRecord) => Promise<void>;
};

export async function cancelEventForBooking(
  deps: CancelEventDeps,
  args: CancelEventForBookingArgs,
): Promise<CancelEventOutput> {
  return runCancelEvent(
    deps,
    {
      actorHumanId: args.actorHumanId,
      eventId: args.eventId,
      // Satisfies the input schema; the key below is what is used.
      clientKey: args.idempotencyKey,
    },
    {
      idempotencyKey: args.idempotencyKey,
      withinTx: args.withinTx,
      auditVia: args.auditVia ?? "booking_cancel",
      preRefundCheck: args.preRefundCheck,
    },
  );
}

async function runCancelEvent(
  deps: CancelEventDeps,
  rawInput: unknown,
  booking: {
    idempotencyKey: string;
    withinTx: CancelEventForBookingArgs["withinTx"];
    auditVia: "booking_cancel" | "booking_exit";
    preRefundCheck?: CancelEventForBookingArgs["preRefundCheck"];
  } | null,
): Promise<CancelEventOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "cancelEvent" });

  const execute = async () => {
    const input = parseInput(cancelEventInputSchema, rawInput);
    const payloadHash = buildPayloadHash(input);
    const idempotencyKey =
      booking?.idempotencyKey ??
      buildIdempotencyKey(input.actorHumanId, input.clientKey);

    const replay =
      await deps.idempotency.get<StoredCancelEventRecord>(idempotencyKey);
    if (replay) {
      if (replay.payloadHash !== payloadHash) {
        throw fail("IDEMPOTENCY_KEY_CONFLICT");
      }
      return replay.response;
    }

    // Both entries claim with an owner token so a failure before the commit
    // can RELEASE the claim (owner-checked, `abandonClaim`) instead of
    // leaving a failed marker that locks the retry out for 15 minutes.
    const ownerToken = randomUUID();
    const claimed = await deps.idempotency.begin(
      idempotencyKey,
      IDEMPOTENCY_TTL_SECONDS,
      ownerToken,
    );
    if (!claimed) {
      const afterWait =
        await deps.idempotency.get<StoredCancelEventRecord>(idempotencyKey);
      if (afterWait) {
        if (afterWait.payloadHash !== payloadHash) {
          throw fail("IDEMPOTENCY_KEY_CONFLICT");
        }
        return afterWait.response;
      }
      throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
    }

    /** How far this run got — what a failure can still have left behind. */
    let stage: "pre_refunds" | "refunds" | "tx" | "after_commit" =
      "pre_refunds";
    /** Orders whose Stripe refund succeeded — what a rollback leaves out. */
    let refundedOrderIds: string[] = [];
    /**
     * The row read UNDER the lock was already CANCELLED: an earlier attempt's
     * cancellation committed (its client saw an error). Refunds this run sent
     * were replays under the same Stripe keys, not a rollback of new money.
     */
    let foundCommittedCancel = false;
    /**
     * `cancel-op:<eventId>` (./_shared/event-cancel-mutex.ts): held from
     * before the first order's refund until the marking tx has committed, so
     * no ticket of this event moves in between (owner ruling 2026-10-05).
     * Released exactly once, by whichever of the three call sites below
     * runs first; the release is owner-checked and never throws.
     */
    let eventCancelLock: HeldOrderRefundMutex | null = null;
    const releaseEventCancelLock = async (): Promise<void> => {
      const held = eventCancelLock;
      eventCancelLock = null;
      await held?.release();
    };
    try {
      const { event, via } = booking
        ? await loadEventForBookingCancel(deps, input.eventId, booking.auditVia)
        : await ensureEventAccessible(deps, input.eventId, input.actorHumanId);
      ensureEventCancellable(event);
      // Cheap early exit for the booking's deterministic refusals, before any
      // refund is issued (see `CancelEventForBookingArgs.preRefundCheck`).
      if (booking?.preRefundCheck) {
        await booking.preRefundCheck(event);
      }
      // Before the order list and every order's refund mutex: the ordering
      // the move wrapper's JSDoc relies on (_helpers/with-ticket-refund-lock).
      // Held by another cancellation of this event (concurrent run, or a
      // crashed one's key not yet lapsed): proceed WITHOUT it, exactly as a
      // concurrent cancel runs today. Its holder keeps refusing moves; the
      // marking tx's row-locked re-read still lets only one cancel commit.
      eventCancelLock = await tryAcquireEventCancelMutex(
        {
          idempotency: deps.idempotency,
          logger: scopedLogger,
          reportError: deps.reportError,
        },
        event.id,
      );
      if (!eventCancelLock) {
        // Error + report, not info: if the holder is a crashed cancel, every
        // gift, invite and listing on this event stays refused until its
        // key lapses (up to an hour), and that must be visible.
        const heldElsewhere = new Error("cancel_event_mutex_held_elsewhere");
        scopedLogger?.error("cancelEvent.event_mutex_held_elsewhere", {
          eventId: event.id,
        });
        try {
          deps.reportError?.(heldElsewhere, {
            tags: { useCase: "cancelEvent", stage: "event_mutex" },
            extra: { eventId: event.id },
          });
        } catch {
          // ignored on purpose — a throwing reporter must not change behaviour
        }
      }
      // An exit after accept (Withdraw / Close request) never moves money
      // (review round 3, W2): the DRAFT it cancels sold nothing by
      // construction, and a row that has sales (published since the exit's
      // read, with the row lock still ahead) is refused HERE, before the
      // first refund — the in-tx DRAFT pin alone would be too late. Still
      // `pre_refunds`: the claim is released, `runExitWithDraftCancel`
      // falls back to the exit alone and leaves the live event as it is.
      //
      // And it NEVER refunds (booking-the-night P2d-2, carry c): the exit's
      // refund list is the (empty) `sold` list it just checked, never a
      // second read. A sale landing between that check and a re-read would
      // otherwise be refunded by an action that must not move money — and
      // the in-tx DRAFT pin would then refuse with the refund already out.
      // Such a sale makes the event non-DRAFT, so the pin refuses it below
      // with nothing refunded.
      let refundableOrders: RefundableOrder[];
      if (booking?.auditVia === "booking_exit") {
        const sold = await collectRefundableOrders(deps, event.id);
        if (sold.length > 0) {
          throw fail("EVENT_NOT_CANCELLABLE");
        }
        stage = "refunds";
        refundableOrders = sold;
      } else {
        stage = "refunds";
        // Collect succeeded orders with payment intents that need refunding.
        refundableOrders = await collectRefundableOrders(deps, event.id);
      }

      // Process refunds outside the main transaction since they hit external services.
      const refundResults = await processRefunds(
        deps,
        refundableOrders,
        scopedLogger,
        idempotencyKey,
      );
      refundedOrderIds = refundResults.succeeded.map((r) => r.orderId);

      // Map every successful PRE-CUTOVER transfer reversal's settlement →
      // payee so the ledger's TRANSFER_REVERSAL_CREDITs can be attributed
      // inside the tx below. Read OUTSIDE the tx (pure lookup, no mutation).
      // Ledger-era reversals carry `payeeId` directly (settlementId null)
      // and need no lookup.
      const reversalSettlementIds = [
        ...new Set(
          refundResults.succeeded.flatMap((r) =>
            r.transferReversals
              .map((tr) => tr.settlementId)
              .filter((id): id is string => id !== null),
          ),
        ),
      ];
      const reversalPayeeBySettlementId = new Map<string, string>();
      if (reversalSettlementIds.length > 0) {
        const reversedSettlements = await deps.repos.settlements.getByIds(
          reversalSettlementIds,
        );
        for (const s of reversedSettlements) {
          reversalPayeeBySettlementId.set(s.id, s.payeeId);
        }
      }

      // Media cleanup targets are collected BEFORE the transaction opens, on
      // the non-transactional repo bag. This is a pure read that needs no
      // transactional consistency, and it is the only way "a transient list
      // failure must not block the cancel" can actually be true: a failed
      // statement — SELECT included — puts the Postgres session into the
      // aborted state, so a catch INSIDE the tx that continued would have
      // condemned it. With `eventChangeNotices.create` still to run, that
      // surfaced as a 25P02 on the notice write (the cancel FAILED, with
      // Sentry blaming the wrong statement) rather than the documented
      // "cancel proceeds without media cleanup". See engineering-standards
      // "Swallowing an error inside a transaction".
      const mediaTargets = await collectMediaCleanupTargetsBestEffort(
        deps,
        scopedLogger,
        event.id,
      );

      // Cancel the event and mark refunded orders within a single transaction.
      // There is NO event-level settlement cancellation anymore — the concept
      // died with the ledger cutover (spec §7): event cancellation is just
      // its orders' refunds, each writing its own REFUND_DEBITs below.
      stage = "tx";
      const txResult = await deps.repos.tx(async (tx) => {
        const now = deps.clock.now();

        /** Reserved seats returned to the pool by this cancellation (audit). */
        const releasedSeatIds: string[] = [];

        // Every entry re-reads the event UNDER its row lock, first thing in
        // the tx (event row first, then the booking's writes — the order
        // `cancelEventForBooking` documents). `events.cancel` below is an
        // unconditional update, and the load above ran outside the tx, so
        // without this pin a retry racing an attempt whose COMMIT was still
        // in flight (its client saw an error, the claim was released) would
        // read PUBLISHED, queue on the lock, then cancel again: a second
        // CANCELLED notice fan-out to buyers, a second audit row, a second
        // booking `withinTx` against terms already cancelled. Under the lock
        // the committed CANCELLED is visible and refused.
        //
        // An exit after accept (Withdraw / Close request) additionally
        // cancels the request's still-DRAFT event only: a publish that
        // committed since the load makes this a refusal (nothing is
        // cancelled or refunded), never the cancellation of a live, on-sale
        // event the exit never meant to touch.
        await tx.events.lockRows({ ids: [event.id], mode: "update" });
        const locked = await tx.events.getById(event.id);
        if (booking?.auditVia === "booking_exit") {
          if (!locked || locked.status !== "DRAFT") {
            throw fail("EVENT_NOT_CANCELLABLE");
          }
        } else {
          if (!locked) {
            throw fail("EVENT_NOT_FOUND");
          }
          foundCommittedCancel = locked.status === "CANCELLED";
          ensureEventCancellable(locked);
        }
        // Everything below reads the row as it stands UNDER the lock, never
        // the pre-tx load: the event the booking writes, the quota subject,
        // the stewardship and the buyers' notice are all this row's.
        const current = locked;

        const cancelled = await tx.events.cancel({ eventId: current.id });

        // Cancel booking (booking-the-night FR-009): the booking's writes, in
        // THIS transaction, right after the event row (see
        // `cancelEventForBooking` for the lock order and why).
        if (booking) {
          await booking.withinTx(tx, current);
        }

        // Money audit 2026-09-08 #22: every OPEN (ACTIVE | HELD) resale
        // listing of this event is cancelled HERE, before any order is
        // marked refunded, in this same tx. Otherwise a buyer's LISTED ticket
        // was refunded below while its listing stayed purchasable — the
        // resale buyer got charged and finalize DLQ'd over the refunded
        // original item. Ordering: the adapter's status-conditional update
        // takes the listing row locks for the rest of this tx, and
        // `resaleListings.commit` is itself status-conditional (HELD → SOLD),
        // so a resale finalize racing us blocks on the lock and then flips 0
        // rows — it can never commit SOLD over our CANCELLED. Event-wide
        // rather than per refunded order on purpose: a listing must not stay
        // buyable just because THAT order's Stripe refund failed.
        const { cancelledListingIds } =
          await tx.resaleListings.cancelOpenForEvent(current.id);

        // Booking timeline: a show minted from an agreement logs "cancelled"
        // on its booking thread. Silent for every other event; same tx as the
        // cancel so the entry never outlives a rolled-back cancellation.
        await appendBookingEventCancelledEntry(tx, {
          eventId: current.id,
          actorHumanId: input.actorHumanId,
        });

        // Capture the refunded buyers for the CANCELLED change-notice outbox
        // row (below). Keyed by humanId so a buyer with multiple refunded
        // orders collapses to ONE entry with summed cents. Guest/POS orders
        // (no buyerHumanId) are skipped — the drain job still fans out to
        // savers/RSVPers regardless of this list.
        const buyersByHumanId = new Map<
          string,
          { humanId: string; refundedCents: number; currency: string }
        >();

        // Mark refunded orders in the database. IN `succeeded` ORDER, which
        // is load-bearing for a ticket resold more than once: `processRefunds`
        // lists a chain's RESALE orders last buyer first and PRIMARY orders
        // after them, so each unwind below hands the ticket back to the item
        // the NEXT order's unwind (or `markOrderTicketsRefunded`) reads it
        // from, and the seller's order is not yet REFUNDED when the unwind
        // asks (`sellerPurchaseAlreadyRefunded`).
        for (const r of refundResults.succeeded) {
          const refundedOrder = await tx.orders.getById(r.orderId);
          if (!refundedOrder) {
            continue;
          }

          if (refundedOrder.buyerHumanId) {
            const existing = buyersByHumanId.get(refundedOrder.buyerHumanId);
            if (existing) {
              // Defensive multi-currency guard: today an event is single-
              // currency so all of a buyer's refunded orders share one
              // currency, and we sum cents under the first-seen currency. If
              // that invariant ever breaks (per-order currency), summing across
              // currencies would be nonsense — log at ERROR so it's alertable
              // rather than silently mis-stating the refund total.
              if (existing.currency !== refundedOrder.currency) {
                scopedLogger?.error("cancelEvent.buyer_currency_mismatch", {
                  eventId: current.id,
                  humanId: refundedOrder.buyerHumanId,
                  existingCurrency: existing.currency,
                  incomingCurrency: refundedOrder.currency,
                  orderId: r.orderId,
                });
              }
              existing.refundedCents += r.refundedCents;
            } else {
              buyersByHumanId.set(refundedOrder.buyerHumanId, {
                humanId: refundedOrder.buyerHumanId,
                refundedCents: r.refundedCents,
                currency: refundedOrder.currency,
              });
            }
          }

          const refundedResaleParentItemIds = new Set(
            r.refundedResaleParentItemIds,
          );
          const refundedGiftedOrderItemIds = new Set(
            r.refundedGiftedOrderItemIds,
          );

          // Per-item tax and platform-fee attribution — the SAME weights the
          // refund money came from (`allocateFullRefundShares` allocates over
          // EVERY ticket item), stamped exactly as `refundFullOrder` stamps
          // them, so a cancellation's accounting reads identically to a staff
          // full refund of the same order. Allocated across every ticket item
          // (not just the refunded ones) so the shares sum to the order's
          // totals and a skipped sibling cannot shift a share. A ticket item
          // the platform-fee map does not know stays "not attributed"
          // (`?? null`), never a fabricated 0; non-ticket items keep the
          // 3-arg form.
          const refundedTicketItems = refundedOrder.items.filter(
            (item) => item.kind === "ticket",
          );
          // On the per-line path the stamp is the tax term the refund MONEY
          // was planned from (`buildRefundPlan`), carried on the result —
          // never re-derived. Every other order is stamped exactly as before.
          const allocatedTaxByItem =
            r.perLineTaxByItem ??
            allocateRefundTaxShares(
              refundedTicketItems,
              refundedOrder.taxAmountCents ?? 0,
            );
          const allocatedPlatformFeeByItem = allocateRefundPlatformFeeShares(
            refundedTicketItems,
            refundedOrder.feesPlatformCents,
          );

          const refundedNowItemIds: string[] = [];
          for (const item of refundedOrder.items) {
            if (item.status === "refunded" || item.refundedAt) {
              continue;
            }

            // A `transferred` ticket item is marked refunded only when the
            // Stripe refund above actually covered it — which is exactly
            // when the plan selected it (`selectRefundableTicketItems`):
            //   - a RESALE parent whose resale order this cancellation
            //     refunded first (the resale buyer is already made whole);
            //   - a GIFTED item — refunded to the order that paid for it, on
            //     the same per-item allocation as its siblings. Decision
            //     record: docs/decisions/
            //     cancellation-refunds-gifted-tickets-to-the-payer.md.
            // A resale parent whose resale refund FAILED stays `transferred`:
            // the resale buyer still holds a paid claim on that ticket.
            if (
              item.kind === "ticket" &&
              (item.status === "transferred" || item.transferredAt) &&
              !refundedResaleParentItemIds.has(item.id) &&
              !refundedGiftedOrderItemIds.has(item.id)
            ) {
              continue;
            }

            if (item.kind === "ticket") {
              await tx.orderItems.updateStatus(
                item.id,
                "refunded",
                now,
                allocatedTaxByItem.get(item.id) ?? 0,
                allocatedPlatformFeeByItem.get(item.id) ?? null,
              );
              refundedNowItemIds.push(item.id);
            } else {
              await tx.orderItems.updateStatus(item.id, "refunded", now);
            }
          }

          await tx.orders.markRefunded(r.orderId);
          if (refundedOrder.source === "RESALE") {
            await unwindResaleOrderAfterRefund(tx, {
              order: refundedOrder,
              clock: deps.clock,
              logger: scopedLogger,
              listingDisposition: "cancel",
              reportError: deps.reportError,
            });
          } else {
            // WHOLE HOUSE, on purpose. Both flags widen what gets voided, and
            // cancellation is the one place where that is right — the show is
            // not happening, so every pass for it is dead and every seat in
            // the layout goes back to AVAILABLE for the rescheduled date.
            //
            // `includeListed`: this order's LISTED ticket has no open listing
            // any more (cancelled above, same tx) — it goes REFUNDED with its
            // order. Refund paths keep the default (LISTED = ineligible).
            //
            // `voidTransferred`: a gifted ticket still carries this order's
            // `orderId`, so it is killed here too — and, unlike every other
            // path, its payer IS refunded for it (the gifted item was
            // selected into this order's refund above; decision record:
            // docs/decisions/cancellation-refunds-gifted-tickets-to-the-payer.md).
            // Every OTHER path must leave a gifted pass alone: there the
            // sender is not refunded for it, so burning the recipient's pass
            // — and re-selling their seat — takes from a third party who was
            // paid nothing back. Here the recipient loses nothing they still
            // had (the event is gone) and the payer gets their money back.
            //
            // Before this, seats stayed SOLD forever, so a rescheduled date
            // could not sell a single reserved ticket.
            // `leftOnRefund` (the voided tickets that were SCANNED) is not
            // read here: a cancellation writes no per-order audit row to
            // carry it, only the event-level `cancelled` row below.
            const { releasedSeatIds: freed } = await markOrderTicketsRefunded(
              tx,
              r.orderId,
              {
                at: now,
                includeListed: true,
                voidTransferred: true,
              },
            );
            releasedSeatIds.push(...freed);
          }

          // ── The one refund rule (spec §4): write this ORDER's debits ────
          // Replaces the deleted event-level `settlements.cancelForEvent`:
          // event cancellation is just its orders' refunds, each debiting
          // exactly once (keyed on the order's Stripe refund id, so a
          // replayed cancel or a later charge.refunded webhook nets to a
          // no-op). Un-included transferred items keep their revenue and
          // force partial math.
          const refundedNowIds = new Set(refundedNowItemIds);
          const attemptedFullRefund = refundedOrder.items
            .filter((item) => item.kind === "ticket")
            .every(
              (item) =>
                refundedNowIds.has(item.id) ||
                item.status === "refunded" ||
                Boolean(item.refundedAt),
            );
          const refundDebits = await writeRefundDebitsForOrder(tx, {
            order: { id: refundedOrder.id, currency: refundedOrder.currency },
            refundedItemIds: refundedNowItemIds,
            refundKey: r.refundId,
            attemptedFullRefund,
            useCase: "cancelEvent",
            logger: scopedLogger,
            reportError: deps.reportError,
          });

          // Spec §4.2: reversals that SUCCEEDED for this order's paid-out
          // items net their debits to zero — the money came back externally.
          await writeTransferReversalCreditsForOrder(tx, {
            order: { id: refundedOrder.id, currency: refundedOrder.currency },
            refundKey: r.refundId,
            reversals: groupReversalsByPayee(
              r.transferReversals,
              reversalPayeeBySettlementId,
              {
                useCase: "cancelEvent",
                orderId: refundedOrder.id,
                logger: scopedLogger,
                reportError: deps.reportError,
              },
            ),
            debits: refundDebits,
            useCase: "cancelEvent",
            logger: scopedLogger,
            reportError: deps.reportError,
          });
        }

        // A recurring COMMUNITY listing's per-night RSVPers are not in the
        // event-level change notice's audience: call off every remaining
        // night here, in this marking tx, so each of them is told by the same
        // DATE_CANCELLED notice a single call-off writes, and a rollback
        // undoes the flips and the notices with the cancel. Keyed on the row
        // read under the lock. OWNED events are not touched. A saver or
        // event-level RSVPer is skipped: the CANCELLED change notice written
        // below already sends them `event.cancelled`, and one clear message
        // beats two saying the same thing.
        const communityCallOff =
          current.stewardship === "COMMUNITY"
            ? await callOffRemainingDates(tx, {
                eventId: current.id,
                now,
                skipHumansInEventAudience: true,
              })
            : null;

        await tx.audit.log({
          entity: "event",
          entityId: current.id,
          action: "cancelled",
          data: {
            actorHumanId: input.actorHumanId,
            refundedOrderCount: refundResults.succeeded.length,
            // Of those, the orders whose refund returned $0 (only tickets that
            // cost $0 were left): marked refunded with no Stripe refund.
            noChargeOrderCount: refundResults.succeeded.filter(
              (r) => r.refundedCents === 0,
            ).length,
            failedRefundCount: refundResults.failed.length,
            failedOrderIds: refundResults.failed.map((f) => f.orderId),
            // Why, for each order that was refused before its money moved
            // (see `RefundFailure.reason`). An order that failed at the
            // processor has no entry here; its error is in the log.
            failedRefundReasons: refundResults.failed.flatMap((f) =>
              f.reason ? [{ orderId: f.orderId, reason: f.reason }] : [],
            ),
            cancelledResaleListingCount: cancelledListingIds.length,
            releasedSeatCount: releasedSeatIds.length,
            // FR-014 takedown attribution: mutations via the platform-admin
            // override MUST be traceable to the platform operator (mirrors
            // the requireScannerAccessOnOrg audited-override precedent).
            // Cancel booking runs on the booking parties' authority, not the
            // event owner's — the row says so (booking-the-night FR-009).
            ...(via !== "owner" ? { via } : {}),
            // Server-side only: `notifiedCount` is a going-count (FR-004).
            ...(communityCallOff
              ? {
                  datesCalledOff: communityCallOff.datesCalledOff,
                  notifiedCount: communityCallOff.notifiedCount,
                }
              : {}),
          },
          at: now,
        });

        // Decrement the org's event count so the quota slot is reclaimed.
        if (current.orgId) {
          await incrementResourceUsage(tx, {
            subjectType: "ORG",
            subjectId: current.orgId,
            kind: "EVENTS_PER_ORG",
            delta: -1n,
          });
        }

        // Reclaim storage for the event's media (images + audio). The blob
        // deletes are routed through the deletion outbox so the intent commits
        // ATOMICALLY with this cancellation tx (same contract as deleteEvent —
        // the drain job removes the objects durably with retries).
        //
        // The target-COLLECTION reads ran best-effort BEFORE this transaction
        // opened (see `collectMediaCleanupTargetsBestEffort`); a failed list
        // leaves `mediaTargets` empty and the cancel proceeds without media
        // cleanup. The WRITES (softDelete + quota + enqueueMany) below run
        // UNGUARDED so a write failure rolls the whole cancel back — never
        // "cancel committed, intent lost".
        //
        // ── Unguarded writes: a failure here aborts the tx (PG) and rolls the
        //    cancel back, keeping the enqueue atomic with the cancellation. ──
        const { liveImages, audio } = mediaTargets;
        const deletionItems: EnqueuePendingObjectDeletionItem[] = [];

        // Quota subject (org/human that owns the event's bytes), resolved once
        // and reused for both image + audio credits. Mirrors the upload-side
        // increment so deletes give back exactly what uploads charged.
        // Ownerless COMMUNITY rows resolve to null — their image bytes were
        // charged per-UPLOADER (FR-015), so they are credited per-uploader
        // below instead.
        const quotaSubject = eventStorageQuotaSubject(current);

        // Images: soft-delete live rows + reclaim quota + enqueue blobs.
        // We filter `!deletedAt` (live only) because an already-soft-deleted
        // image already had its blob removed by the orphan sweep's detached
        // loop (blob delete precedes the soft-delete there), so re-enqueueing it
        // would target a key that's already gone. Audio differs (see below).
        if (liveImages.length > 0) {
          const imageBytes = liveImages.reduce(
            (sum, img) => sum + (img.sizeBytes ?? 0n),
            0n,
          );

          await tx.images.softDelete({
            imageIds: liveImages.map((img) => img.id),
            deletedAt: now,
          });

          for (const img of liveImages) {
            deletionItems.push({
              targetKey: img.key,
              targetKind: "KEY",
              source: "event_cancel",
              sourceId: current.id,
            });
          }

          if (imageBytes > 0n && quotaSubject) {
            await incrementResourceUsage(tx, {
              ...quotaSubject,
              delta: -imageBytes,
            });
          } else if (!quotaSubject && current.stewardship === "COMMUNITY") {
            // FR-014 takedown of an ownerless COMMUNITY listing: there is no
            // event-level quota subject, but FR-015 charged each image to its
            // UPLOADER's personal storage at request time — credit the bytes
            // back per-uploader so the takedown doesn't leak their quota.
            const bytesByUploader = new Map<string, bigint>();
            for (const img of liveImages) {
              const bytes = img.sizeBytes ?? 0n;
              if (bytes <= 0n || !img.createdByHumanId) continue;
              bytesByUploader.set(
                img.createdByHumanId,
                (bytesByUploader.get(img.createdByHumanId) ?? 0n) + bytes,
              );
            }
            for (const [uploaderHumanId, bytes] of bytesByUploader) {
              await incrementResourceUsage(tx, {
                subjectType: "HUMAN",
                subjectId: uploaderHumanId,
                kind: "STORAGE_BYTES_HUMAN",
                delta: -bytes,
              });
            }
          }
        }

        // Audio: soft-delete rows (INCLUDING already-soft-deleted) + enqueue
        // source key as KEY, HLS folder as PREFIX. Unlike images, audio is
        // collected via listByEventIdIncludingDeleted: re-enqueueing an
        // already-soft-deleted upload is harmless (the drain delete is
        // idempotent) and guarantees coverage of rows the sweep can't reclaim
        // once the event row is gone. Audio is always event-tied (eventId NOT
        // NULL), so there's no standalone-audio path to worry about.
        //
        // NOTE: while enqueue + soft-delete span the FULL
        // listByEventIdIncludingDeleted set, `audio.audioBytes` is LIVE-only
        // (collectEventAudioDeletionTargets sums `deletedAt == null` rows). An
        // already-soft-deleted row's bytes were credited when the sweep
        // soft-deleted it, so crediting them again here would double-credit.
        if (audio.audioUploadIds.length > 0) {
          await tx.audioUploads.softDelete({
            audioUploadIds: audio.audioUploadIds,
            deletedAt: now,
          });
        }
        for (const key of audio.exactKeys) {
          deletionItems.push({
            targetKey: key,
            targetKind: "KEY",
            source: "event_cancel",
            sourceId: current.id,
          });
        }
        for (const prefix of audio.prefixes) {
          deletionItems.push({
            targetKey: prefix,
            targetKind: "PREFIX",
            source: "event_cancel",
            sourceId: current.id,
          });
        }

        // Credit the audio bytes back too (was previously leaked on cancel).
        if (audio.audioBytes > 0n && quotaSubject) {
          await incrementResourceUsage(tx, {
            ...quotaSubject,
            delta: -audio.audioBytes,
          });
        }

        await tx.pendingObjectDeletions.enqueueMany(deletionItems);

        // Paid buyers whose refund FAILED (money still stuck) and who are NOT
        // also money-aware (succeeded) buyers. Captured so the drain still
        // tells them the event was cancelled — otherwise a failed-refund buyer
        // who didn't also save/RSVP would be notified by NOBODY despite their
        // money being held. Guest/POS orders (no buyerHumanId) are skipped.
        const pendingRefundBuyerHumanIds = new Set<string>();
        for (const f of refundResults.failed) {
          const failedOrder = await tx.orders.getById(f.orderId);
          if (!failedOrder?.buyerHumanId) {
            continue;
          }
          // A buyer with one succeeded + one failed order is already in the
          // money-aware `buyers` cohort — don't duplicate them here. Only when
          // money actually came back to them: a buyer whose refunded orders
          // all returned $0 (a cancellation of tickets that cost $0, see
          // `refundLoadedOrder`) still has money held on the failed order,
          // and must hear "refund in progress", not a plain cancellation.
          if (
            (buyersByHumanId.get(failedOrder.buyerHumanId)?.refundedCents ??
              0) > 0
          ) {
            continue;
          }
          pendingRefundBuyerHumanIds.add(failedOrder.buyerHumanId);
        }

        // Transactional change-notice outbox row (Unit 4). Committed atomically
        // with the cancellation + refund bookkeeping so the notification intent
        // is crash-safe: a separate drain job parses this payload and fans out
        // to refunded buyers + savers/RSVPers. Free/RSVP events yield an empty
        // `buyers` array (the job still notifies savers/RSVPers).
        await tx.eventChangeNotices.create({
          eventId: current.id,
          changeType: "CANCELLED",
          payload: {
            eventTitle: current.title,
            startsAt: current.startsAt ? current.startsAt.toISOString() : null,
            buyers: [...buyersByHumanId.values()],
            pendingRefundBuyerHumanIds: [...pendingRefundBuyerHumanIds],
          },
        });

        // Durable reindex mark (`search/search-reindex-marks.ts`): if the
        // report-only scrub below AND the post-commit reindex both fail, the
        // drain still removes the cancelled event's document.
        await markForSearchReindex(
          tx,
          [{ kind: "event", id: cancelled.id }],
          deps.clock.now(),
        );

        // Remove the event from search before commit. REPORT-ONLY, unlike
        // unpublish/delete: the Stripe refunds above were issued BEFORE this
        // transaction, so rolling it back on a search failure would leave
        // buyers refunded and the event still on sale. A failure is reported
        // and the post-commit reindex below removes the document again.
        //
        // Deliberately on the search port's OWN connection, not this
        // transaction's (`searchForTx`): a failed statement inside a Postgres
        // transaction aborts it, and COMMIT then silently rolls back — the
        // cancel would vanish after its refunds went out. Only a throwing
        // scrub may run on the transaction.
        await scrubSearchDocumentsOrReport(deps.search, {
          docIds: [eventSearchDocId(cancelled.id)],
          useCase: "cancelEvent",
          logger: scopedLogger,
          reportError: deps.reportError,
        });

        return { eventId: cancelled.id };
      });
      stage = "after_commit";
      // The marking tx committed: every refunded order is marked, its tickets
      // voided or unwound. Moves may resume (they will find those tickets
      // REFUNDED); what follows touches only PENDING resale orders.
      await releaseEventCancelLock();

      // ── Phase 2: the resale purchases this cancellation just killed ──────
      // Runs AFTER the commit above, never inside it, and never throws. Both
      // halves of that are load-bearing; the full argument lives in
      // `settleStrandedResaleOrders`, but in one line each:
      //
      //  - AFTER, because `cancelOpenForEvent` committing is what makes
      //    "this PENDING resale order can never mint a ticket" TRUE. Before
      //    the commit the verdict is a guess and a racing finalize can still
      //    win, so we would be refunding a buyer who then gets the ticket.
      //  - OUTSIDE, because settling a PaymentIntent is up to four Stripe
      //    round-trips against a 30-second transaction budget.
      //  - NEVER THROWS, because the cancellation has already committed: a
      //    throw here would report a cancel that demonstrably happened as a
      //    failure (the catch below leaves the claim standing).
      const strandedResale = await settleStrandedResaleOrders(
        {
          repos: deps.repos,
          payments: deps.payments,
          logger: scopedLogger,
          reportError: deps.reportError,
        },
        {
          eventId: event.id,
          idempotencyKey,
          now: deps.clock.now(),
        },
      );

      // ── Phase 3: the door's cash sales (owner ruling 2026-10-07) ────────
      // Every cash order of the cancelled event is refunded the way the
      // till refunds one: marked REFUNDED, tickets voided, and its
      // CASH_SALE_DEBIT reversed so the organiser who hands the cash back
      // does not also pay what the debit claimed (tax; fee + tax on a sale
      // before 2026-10-08). No platform money moves, so no
      // phase before the commit has to wait for it. AFTER the commit, one
      // transaction per order, and NEVER THROWS, for the reasons Phase 2
      // gives — a cash order's bookkeeping must not undo a cancellation
      // whose card refunds already went out, and one bad order must not stop
      // the rest. See `refundCashOrdersForCancelledEvent`.
      //
      // DURABILITY: nothing re-runs this phase or the next one from here (a
      // retry stops at EVENT_ALREADY_CANCELLED). The door sweep does:
      // `settleDoorOrdersOnCancelledEvents`, on the cart reaper's schedule,
      // finds any CANCELLED event still holding a cash sale with an
      // unreversed fee + tax debit, or a PENDING door card sale, and runs these same two phases on it. A crash
      // between the commit above and here costs minutes, not money.
      const cashRefunds = await refundCashOrdersForCancelledEvent(
        {
          repos: deps.repos,
          logger: scopedLogger,
          reportError: deps.reportError,
        },
        {
          eventId: event.id,
          actorHumanId: input.actorHumanId,
          now: deps.clock.now(),
          // Live, at cancel time: every cash order, comps included.
          scope: "all",
        },
      );

      // ── Phase 4: PENDING door card sales ────────────────────────────────
      // A card sale started at the door before the cancel is a confirmable
      // PaymentIntent on a reader; a tap after the cancel would finalize it
      // and mint tickets for an event that is not happening. Void each one
      // the way the operator's own "cancel this sale" does (PI proven dead,
      // then the order). Same placement and never-throws rule as Phase 3.
      const posVoids = await voidPendingPosOrdersForCancelledEvent(
        {
          repos: deps.repos,
          payments: deps.payments,
          clock: deps.clock,
          logger: scopedLogger,
          reportError: deps.reportError,
        },
        { eventId: event.id },
      );

      const result = cancelEventOutputSchema.parse({
        eventId: txResult.eventId,
        status: "CANCELLED",
        refundedOrderCount: refundResults.succeeded.length,
        failedRefundCount: refundResults.failed.length,
        cancelledPendingResaleOrderCount: strandedResale.cancelledCount,
        refundedPendingResaleOrderCount: strandedResale.refundedCount,
        strandedPendingResaleOrderCount: strandedResale.strandedCount,
        strandedPendingResaleScanFailed: strandedResale.scanFailed,
        refundedCashOrderCount: cashRefunds.refundedCount,
        failedCashRefundCount: cashRefunds.failedCount,
        cashRefundScanFailed: cashRefunds.scanFailed,
        voidedPendingPosOrderCount: posVoids.voidedCount,
        // Kept (paid PaymentIntent) or failed: either way not voided.
        failedPendingPosVoidCount: posVoids.failedCount + posVoids.keptCount,
        pendingPosScanFailed: posVoids.scanFailed,
      });

      await deps.idempotency.commit<StoredCancelEventRecord>(idempotencyKey, {
        payloadHash,
        response: result,
      });

      // Best-effort: promptly REMOVE the cancelled event from search (the event
      // reindex is upsert-or-delete — a non-PUBLISHED event is deleted).
      reindexAfterMutation(
        {
          repos: deps.repos,
          search: deps.search,
          clock: deps.clock,
          logger: deps.logger,
          reportError: deps.reportError,
        },
        "cancelEvent",
        { kind: "event", id: result.eventId },
      );

      return result;
    } catch (error) {
      // First, so a same-key retry released by `abandonClaim` below can take
      // the event lock itself.
      await releaseEventCancelLock();
      if (stage === "after_commit") {
        // The cancellation committed (refunds out, event CANCELLED); only
        // the bookkeeping after it threw (in practice `idempotency.commit`).
        // Leave the claim standing until its TTL: releasing it would invite
        // a retry to redo committed work, and `fail` would report a cancel
        // that happened as a failed one. The throw rides the backstops.
        throw error;
      }
      if (refundedOrderIds.length > 0) {
        // Buyers were refunded and the cancellation did not commit: the event
        // is still PUBLISHED and on sale. Nothing else surfaces that (the
        // error may be a deliberate booking refusal that no backstop sees as
        // an incident), so it is logged AND reported before the rethrow.
        reportRefundedThenRolledBack(deps, scopedLogger, {
          eventId: input.eventId,
          refundedOrderIds,
          stage,
          error,
          // A committed cancel found under the lock is not a rollback: the
          // refunds were same-key replays. Still loud, under its own tag.
          kind: foundCommittedCancel
            ? "refund_replayed_into_committed_cancel"
            : "refunded_then_rolled_back",
        });
      }
      // Nothing is known to have committed: release the claim
      // (lib/idempotency-claim.ts) so the retry, either entry's, runs at
      // once under the SAME key. That is safe at every stage before
      // `after_commit`:
      //  - refunds re-send the same `${idempotencyKey}:…` Stripe keys under
      //    the per-order refund mutex, so Stripe hands back the refunds it
      //    already made instead of a second refund;
      //  - a transaction that did reach COMMIT despite the error leaves the
      //    event CANCELLED, so the retry stops at `ensureEventCancellable`
      //    (EVENT_ALREADY_CANCELLED) before any refund.
      // The old `failed:` marker only delayed that same retry by 15 minutes
      // while the event stayed on sale.
      await abandonClaim(deps.idempotency, idempotencyKey, ownerToken, error, {
        useCase: "cancelEvent",
        logger: scopedLogger,
        reportError: deps.reportError,
      });
      throw error;
    } finally {
      // Backstop; a no-op when one of the two calls above already ran.
      await releaseEventCancelLock();
    }
  };

  if (scopedLogger) {
    return scopedLogger.withTime("cancelEvent", execute);
  }

  return execute();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface MediaCleanupTargets {
  /** Live (non-soft-deleted) event images to soft-delete + enqueue. */
  liveImages: ImageRecord[];
  /** Audio source keys / HLS prefixes / row ids to soft-delete + enqueue. */
  audio: EventAudioDeletionTargets;
}

const EMPTY_MEDIA_CLEANUP_TARGETS: MediaCleanupTargets = {
  liveImages: [],
  audio: {
    exactKeys: [],
    prefixes: [],
    audioUploadIds: [],
    audioBytes: 0n,
  },
};

/**
 * READ-only collection of the event's media cleanup targets.
 *
 * Takes the full `Repos` bag, NOT `TxRepos`. `TxRepos = Omit<Repos, "tx">`, so
 * handing this a transaction handle is a compile error rather than a
 * regression: these reads are deliberately best-effort, and a best-effort
 * read must never run inside a transaction it can condemn (a failed SELECT
 * aborts the Postgres session exactly as a failed INSERT does).
 */
async function collectMediaCleanupTargets(
  repos: Repos,
  eventId: string,
): Promise<MediaCleanupTargets> {
  const images = await repos.images.listByOwner("EVENT", eventId);
  const liveImages = images.filter((img) => !img.deletedAt);
  const audio = await collectEventAudioDeletionTargets(repos, eventId);
  return { liveImages, audio };
}

/**
 * Best-effort wrapper: a transient list failure must not block a cancel —
 * Stripe refunds have already been issued above, and the old in-tx swallow
 * turned this into "refunds out, cancel rejected with a misattributed 25P02,
 * event still PUBLISHED". A committed cancel with one event's media left
 * unreclaimed is the better failure. But be precise about the cost: it is NOT
 * self-healing. The orphan sweep is reference-based and these Image rows stay
 * live and referenced, so it will correctly keep them; and a replayed cancel
 * returns the cached response while a fresh one throws EVENT_ALREADY_CANCELLED,
 * so this collection never runs again for the event. The bytes stay charged
 * to the org's quota until someone deletes the event (deleteEvent re-collects)
 * or manually enqueues them off the `cancel_event_media_collection_failed`
 * log. Reported to Sentry — a bare log line on a swallow is invisible
 * (CLAUDE.md error convention) — and logged at `error`. Guarded so a throwing
 * reporter cannot manufacture a new failure.
 */
async function collectMediaCleanupTargetsBestEffort(
  deps: Pick<CancelEventDeps, "repos" | "reportError">,
  logger: LoggerPort | undefined,
  eventId: string,
): Promise<MediaCleanupTargets> {
  try {
    return await collectMediaCleanupTargets(deps.repos, eventId);
  } catch (err) {
    try {
      deps.reportError?.(err, {
        tags: { useCase: "cancelEvent", stage: "media_collection" },
        extra: { eventId },
      });
    } catch {
      // ignored on purpose
    }
    logger?.error("cancel_event_media_collection_failed", {
      eventId,
      error: describeError(err),
    });
    return EMPTY_MEDIA_CLEANUP_TARGETS;
  }
}

type CancelAccessVia =
  | "owner"
  | "platform_admin"
  | "booking_cancel"
  | "booking_exit";

/**
 * Refunds went out and the cancellation then failed before its commit (a
 * booking refusal under the locks, a lost race, a DB error): buyers are
 * refunded while the event stays live. `logger.error` plus a guarded
 * `reportError` (CLAUDE.md error convention) so someone looks; the Stripe
 * refund metadata lets `charge.refunded` reconcile the items, and a retry
 * under the same key hands back the refunds already made.
 *
 * `kind: "refund_replayed_into_committed_cancel"` is the other case: the row
 * read under the lock was already CANCELLED (an earlier attempt committed),
 * so the refunds this run sent were same-key replays and the event is NOT
 * live. Reported apart so it never reads as buyers refunded on a live event.
 */
function reportRefundedThenRolledBack(
  deps: Pick<CancelEventDeps, "reportError">,
  logger: LoggerPort | undefined,
  args: {
    eventId: string;
    refundedOrderIds: readonly string[];
    stage: string;
    error: unknown;
    kind: "refunded_then_rolled_back" | "refund_replayed_into_committed_cancel";
  },
): void {
  const errorCode = isAppError(args.error)
    ? args.error.code
    : typeof args.error === "object" && args.error !== null
      ? ((args.error as { code?: unknown }).code ?? null)
      : null;
  logger?.error(`cancel_event.${args.kind}`, {
    eventId: args.eventId,
    refundedOrderIds: args.refundedOrderIds,
    stage: args.stage,
    errorCode,
    err: args.error,
    error: describeError(args.error),
  });
  try {
    deps.reportError?.(args.error, {
      tags: { useCase: "cancelEvent", stage: args.kind },
      extra: {
        eventId: args.eventId,
        refundedOrderIds: [...args.refundedOrderIds],
        errorCode,
      },
    });
  } catch {
    // Reporting is best-effort — never replace the cancel's error.
  }
}

/**
 * Cancel booking's load (see `cancelEventForBooking`): the event must exist;
 * its access was decided on the BOOKING by the caller. An exit after accept
 * (`booking_exit`) cancels a DRAFT only: any other status is
 * EVENT_NOT_CANCELLABLE, before anything moves.
 */
async function loadEventForBookingCancel(
  deps: Pick<CancelEventDeps, "repos">,
  eventId: string,
  via: "booking_cancel" | "booking_exit",
): Promise<{ event: EventRecord; via: CancelAccessVia }> {
  const event = await deps.repos.events.getById(eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }
  if (via === "booking_exit" && event.status !== "DRAFT") {
    throw fail("EVENT_NOT_CANCELLABLE");
  }
  return { event, via };
}

/**
 * Owner check with one addition (FR-014, community-managed-event-listings
 * spec): ownerless COMMUNITY rows may be cancelled by platform staff with
 * the ADMIN role (takedown). Moderators can NOT cancel in v1. OWNED events
 * are unchanged: org events need ORG_ADMIN_ROLES membership; personal events
 * need the humanId owner. Callers must audit `via === "platform_admin"`.
 */
async function ensureEventAccessible(
  deps: Pick<CancelEventDeps, "repos" | "authz">,
  eventId: string,
  actorHumanId: string,
): Promise<{ event: EventRecord; via: CancelAccessVia }> {
  const event = await deps.repos.events.getById(eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }

  if (event.orgId) {
    await requireOrgMembership({
      repos: deps.repos,
      orgId: event.orgId,
      actorHumanId,
      roles: ORG_ADMIN_ROLES,
      errorCode: "INSUFFICIENT_ROLE",
    });
    return { event, via: "owner" };
  }

  if (event.humanId) {
    // Owner ruling 2026-09-28: the owner, or an OWNER/ADMIN delegate — the
    // org arm's role set. Refunds included (payout ROUTING is what stays
    // owner-only; see `lib/event-edit-rights.ts`).
    await ensureActorHoldsHumanEventRole(
      deps.repos.authz,
      event.humanId,
      actorHumanId,
      ORG_ADMIN_ROLES,
    );
    return { event, via: "owner" };
  }

  // Ownerless row: only COMMUNITY listings are legitimately ownerless, and
  // only platform ADMIN may take one down (FR-014). requirePlatformStaff
  // throws STAFF_ONLY for everyone else (incl. COMMUNITY_MODERATORs).
  if (event.stewardship === "COMMUNITY") {
    await requirePlatformStaff({
      authz: deps.authz,
      actorHumanId,
      roles: ["ADMIN"],
    });
    return { event, via: "platform_admin" };
  }

  // Orphaned OWNED row (e.g. deleted human) — nobody can cancel through this
  // path; preserves the pre-FR-014 behavior for that edge.
  throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "event" } });
}

function ensureEventCancellable(event: EventRecord): void {
  if (event.status === "CANCELLED") {
    throw fail("EVENT_ALREADY_CANCELLED");
  }

  const cancellableStatuses = new Set(["DRAFT", "PUBLISHED"]);
  if (!cancellableStatuses.has(event.status)) {
    throw fail("EVENT_NOT_CANCELLABLE");
  }
}

interface RefundableOrder {
  orderId: string;
  stripePaymentIntentId: string;
}

async function collectRefundableOrders(
  deps: CancelEventDeps,
  eventId: string,
): Promise<RefundableOrder[]> {
  // Use listForOrg or listAll via the orders repo to find succeeded orders.
  // We paginate through all succeeded orders for the event.
  const refundable: RefundableOrder[] = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const page = await deps.repos.orders.listAll({
      eventId,
      statuses: ["SUCCEEDED", "PART_REFUNDED"],
      limit,
      offset,
    });

    for (const order of page.items) {
      if (order.stripePaymentIntentId) {
        refundable.push({
          orderId: order.id,
          stripePaymentIntentId: order.stripePaymentIntentId,
        });
      }
    }

    if (page.items.length < limit || offset + limit >= page.total) {
      break;
    }
    offset += limit;
  }

  return refundable;
}

interface RefundSuccess {
  orderId: string;
  refundId: string;
  refundedCents: number;
  /**
   * This order's `transferred` items the refund above COVERED, split by why
   * (see `TransferredItemPolicy`). The marking tx flips exactly these to
   * `refunded`; any other transferred item on the order stays as it is.
   */
  refundedResaleParentItemIds: string[];
  refundedGiftedOrderItemIds: string[];
  /**
   * Successful Stripe transfer reversals issued for this order's paid-out
   * items — carried into the cancellation tx so each one gets its
   * TRANSFER_REVERSAL_CREDIT (spec §4.2).
   */
  transferReversals: TransferReversalResult[];
  /**
   * Per-item tax the refund money was planned with, set ONLY when the
   * order's tax is split per PLATFORM line; the marking tx stamps it as is.
   * Null → the tx stamps the buyer-paid tax share, as it always has.
   */
  perLineTaxByItem: ReadonlyMap<string, number> | null;
}

interface RefundFailure {
  orderId: string;
  error: string;
  /**
   * `disputed` when the order was never attempted: its charge is under an
   * OPEN / UNDER_REVIEW / LOST dispute, which Stripe refuses to refund. The
   * cancellation carries on; the order stays for the dispute to resolve.
   *
   * The others are RESALE orders that were not refunded (`processRefunds`),
   * the first three refused before their money moved:
   * - `later_resale_not_refunded`: the buyer sold the ticket on, and that
   *   later purchase was not refunded by this cancellation (it failed, is
   *   disputed, or was skipped), so the ticket cannot come back to be
   *   handed to this order's seller.
   * - `sold_on`: the ticket is with a later holder and no resale order of
   *   this event that the cancellation could read accounts for it.
   * - `resale_chain_unorderable`: the resale orders' parent links form a
   *   loop, so there is no last buyer to start from.
   * - `resale_hop_skipped`: the later purchase WAS refunded and unwound, and
   *   this order's own refund then came out as nothing to refund (a $0
   *   plan). Its buyer was debited for the later sale and is not refunded.
   *
   * Internal to the use case: it goes to the log line and the `cancelled`
   * audit row (`failedRefundReasons`). The response carries only the count.
   */
  reason?: RefundFailureReason;
}

type RefundFailureReason =
  | "disputed"
  | "later_resale_not_refunded"
  | "sold_on"
  | "resale_chain_unorderable"
  | "resale_hop_skipped";

interface RefundResults {
  succeeded: RefundSuccess[];
  failed: RefundFailure[];
}

interface RefundPlan {
  requiresReversal: OrderItemRecord[];
  refundableAmountsByItem: Map<string, number>;
  totalRefundCents: number;
}

interface LoadedRefundableOrder {
  summary: RefundableOrder;
  items: OrderItemRecord[];
  orderId: string;
  parentOrderId: string | null;
  /**
   * Everything the buyer paid for the order — ticket price + platform fee +
   * tax (`computeExpectedPaymentAmount`). The refund allocation basis, read
   * off the same order record and by the same function `refundFullOrder`
   * reads it with, so the two paths cannot disagree about the basis.
   */
  orderTotalPaidCents: number;
  /**
   * The order's tax split (`allocateRefundTaxSharesForOrder`) over ALL its
   * ticket items. `perLinePaidByItem` is non-null only on the per-line path,
   * where it replaces the buyer-paid split as the refund's paid amount.
   */
  taxShares: OrderRefundTaxShares;
  /** For the stranded-fee-read report; null only for a non-ticketing row. */
  eventId: string | null;
  /** RESALE orders keep the $0-plan skip (see `refundLoadedOrder`). */
  source: OrderRecord["source"];
}

type RefundAttemptResult =
  | { status: "succeeded"; result: RefundSuccess }
  | { status: "failed"; failure: RefundFailure }
  | { status: "skipped" };

function ensureSucceededRefund(refund: {
  refundId: string;
  status: PaymentRefundStatus;
}): { refundId: string } {
  if (refund.status === "succeeded") {
    return { refundId: refund.refundId };
  }

  if (refund.status === "pending" || refund.status === "requires_action") {
    throw {
      code: "transient",
      message: "refund_not_terminal",
      refundId: refund.refundId,
      refundStatus: refund.status,
    } as const;
  }

  throw {
    code: "dependency_failed",
    message: "refund_not_succeeded",
    refundId: refund.refundId,
    refundStatus: refund.status,
  } as const;
}

async function processRefunds(
  deps: CancelEventDeps,
  orders: RefundableOrder[],
  logger: LoggerPort | undefined,
  providerIdempotencyKey: string,
): Promise<RefundResults> {
  const succeeded: RefundSuccess[] = [];
  const failed: RefundFailure[] = [];
  const refundedResaleParentItemsByOrderId = new Map<string, Set<string>>();
  const resaleOrders: LoadedResaleOrder[] = [];
  const nonResaleOrders: LoadedRefundableOrder[] = [];

  // ── Gift vs resale: which transferred PRIMARY items have a counter-party ──
  // Every original (parent) item that ANY RESALE order of this event points
  // at — refunded, failed, disputed or un-unwindable alike (read BEFORE the
  // dispute guard's `continue`). A `transferred` item NOT in this set has no
  // resale order behind it: it was GIFTED, and the payer is refunded for it
  // (decision record:
  // docs/decisions/cancellation-refunds-gifted-tickets-to-the-payer.md).
  //
  // The linkage is read off the RESALE side (`resaleOriginalOrderItemId` in
  // the resale item's meta, written by `createResaleCheckout`), NOT off the
  // parent's `resaleListingId`. `finalizeResalePurchase` flips the parent to
  // `transferred`, and what the column then says depends on the parent's
  // order (`../_helpers/order-item-listing-pointer.ts`): on a PRIMARY item
  // it is the "listed now" pointer and is CLEARED, so a sold parent and a
  // gift look identical from the parent alone; on a RESALE item (a ticket
  // sold on again) it is the listing that item was BOUGHT through and is
  // never rewritten, so it says nothing about the later sale either.
  //
  // A parent can itself be a RESALE order's item: every hop of a chain is
  // in this set except the last buyer's. `selectRefundableTicketItems` only
  // consults it for an order with gift detection on, which a RESALE order
  // never has; for a RESALE order it answers "did this buyer sell on?".
  //
  // `listAll` only returns SUCCEEDED / PART_REFUNDED orders, which is the
  // right population: a resale order in any other status never finalized,
  // and finalize is what flips the parent to `transferred` in the first
  // place. But the set is only trustworthy if the linkage is COMPLETE:
  //   - an order that failed to LOAD may have been the resale order behind
  //     any transferred item on the event → linkage incomplete globally;
  //   - a RESALE order with a ticket item whose parent link cannot be
  //     resolved (`createResaleCheckout` writes the meta conditionally)
  //     may point at any transferred item of its parent → linkage
  //     incomplete for THAT parent (`parentOrderId`), or globally when the
  //     resale order does not even name its parent.
  // Where the linkage is incomplete, a PRIMARY order's transferred item of
  // unknown origin makes the ORDER fail closed (below) — never a short
  // refund stamped REFUNDED, which the payer could never recover from.
  const resaleLinkedParentItemIds = new Set<string>();
  const unloadedOrderIds: string[] = [];
  const unlinkedResaleOrderIds: string[] = [];
  const linkageIncompleteParentOrderIds = new Set<string>();

  // Every order's tax lines in ONE query, before any money moves (a failed
  // read fails the cancellation with nothing refunded). Lines are immutable
  // after checkout. They decide the per-item refund money on orders whose tax
  // is split per PLATFORM line, and that same split is what gets stamped.
  const taxLinesByOrderId =
    orders.length > 0
      ? await deps.repos.orders.listTaxLinesByOrderIds(
          orders.map((order) => order.orderId),
        )
      : new Map<string, never[]>();

  for (const order of orders) {
    let fullOrderLoaded = false;
    try {
      const fullOrder = await deps.repos.orders.getById(order.orderId);
      if (!fullOrder) {
        throw fail("ORDER_NOT_FOUND");
      }
      fullOrderLoaded = true;

      if (fullOrder.source === "RESALE") {
        let unresolvedLink = false;
        for (const link of resaleParentLinksOf(fullOrder)) {
          // The parent ITEM id is what gift detection needs; the parent
          // ORDER id only matters to `recordRefundedResaleParentItems`.
          if (link.originalOrderItemId) {
            resaleLinkedParentItemIds.add(link.originalOrderItemId);
          } else {
            unresolvedLink = true;
          }
        }
        if (unresolvedLink) {
          unlinkedResaleOrderIds.push(fullOrder.id);
          if (fullOrder.parentOrderId) {
            linkageIncompleteParentOrderIds.add(fullOrder.parentOrderId);
          } else {
            // Cannot even say WHICH parent — treat as a load failure would.
            unloadedOrderIds.push(fullOrder.id);
          }
        }
      }

      // Dispute guard — BEFORE the mutex, the transfer reversal and the
      // Stripe refund: a disputed charge is recorded as a failed refund with
      // reason "disputed" and never attempted. Stripe would refuse it
      // (`charge_disputed`) after the reversal had already moved money.
      if (isBlockedSettlementDisputeStatus(fullOrder.disputeStatus)) {
        logger?.warn("cancel_event_refund_skip_disputed", {
          orderId: order.orderId,
          disputeStatus: fullOrder.disputeStatus,
        });
        failed.push({
          orderId: order.orderId,
          error: "ORDER_DISPUTED_REFUND_BLOCKED",
          reason: "disputed",
        });
        continue;
      }

      const loaded: LoadedRefundableOrder = {
        summary: order,
        items: fullOrder.items,
        orderId: fullOrder.id,
        parentOrderId: fullOrder.parentOrderId,
        orderTotalPaidCents: computeExpectedPaymentAmount(fullOrder),
        // Reported here, once per order; the marking tx reuses the result.
        taxShares: allocateRefundTaxSharesForOrder({
          useCase: "cancelEvent",
          order: fullOrder,
          ticketItems: fullOrder.items.filter((item) => item.kind === "ticket"),
          taxLines: taxLinesByOrderId.get(fullOrder.id) ?? [],
          logger,
          reportError: deps.reportError,
        }),
        eventId: fullOrder.eventId,
        source: fullOrder.source,
      };
      if (fullOrder.source === "RESALE") {
        // The unwind pre-check runs at this order's turn in the loop below,
        // still before its money moves: for a ticket sold on again it can
        // only be answered once the later purchase's refund is known.
        resaleOrders.push({ loaded, record: fullOrder });
      } else {
        nonResaleOrders.push(loaded);
      }
    } catch (error) {
      if (!fullOrderLoaded) {
        unloadedOrderIds.push(order.orderId);
      }
      logger?.error("cancel_event_refund_failed", {
        orderId: order.orderId,
        error: describeError(error),
      });
      failed.push({ orderId: order.orderId, error: describeError(error) });
    }
  }

  // ── RESALE orders first, LAST BUYER FIRST ─────────────────────────────
  // A ticket can be resold any number of times (owner ruling 2026-10-11):
  // A bought from the organiser, B bought A's listing, C bought B's. The
  // one-hop rule (the resale buyer is refunded on the resale order, the
  // seller's proceeds are unwound, and the item it was bought from is
  // refunded only once that refund succeeded) is applied to every hop,
  // starting from whoever holds the ticket: C's order, then B's, then A's
  // PRIMARY item in the loop after this one. `succeeded` keeps this order,
  // and the marking tx walks it in the same order, so C's unwind has put
  // the ticket back on B's item before B's unwind looks for it there.
  //
  // An order whose buyer sold the ticket on is refunded ONLY when that later
  // purchase's refund succeeded in this run: its item is then in
  // `refundedResaleParentItemsByOrderId`, exactly as a PRIMARY parent's is,
  // and is admitted to the plan by the same rule. Otherwise the order is
  // FAILED before its money moves, with the reason, and so (having recorded
  // nothing) is every hop before it; the PRIMARY item stays `transferred`.
  //
  // No gift allowance: a resale buyer who GIFTED the ticket onward is not
  // refunded here (the item is `transferred`, the ticket still hangs off it
  // so the pre-check passes, the plan comes out empty and the order is
  // SKIPPED, not failed). The gift ruling covers the PAYER of a PRIMARY
  // item; that question is deliberately left as it was.
  const { ordered: resaleOrdersLastBuyerFirst, unorderable } =
    orderResaleOrdersLastBuyerFirst(resaleOrders);

  // Links that loop are links that cannot be trusted, for gift detection as
  // much as for ordering: a parent item one of them should have named would
  // otherwise read as a gift and be refunded. Treated as an unread order is.
  const linkageIncompleteGlobally =
    unloadedOrderIds.length > 0 || unorderable.length > 0;

  for (const { loaded: order } of unorderable) {
    // A loop in the parent links, or anything waiting on one: no hop is
    // "last". Never refunded, never retried in a different order. Reported:
    // nothing else surfaces it.
    const context = {
      orderId: order.orderId,
      parentOrderId: order.parentOrderId,
      eventId: order.eventId,
    };
    logger?.error("cancel_event_resale_chain_unorderable", context);
    try {
      deps.reportError?.(new Error("cancel_event_resale_chain_unorderable"), {
        tags: { useCase: "cancelEvent", stage: "resale_chain_order" },
        extra: context,
      });
    } catch {
      // ignored on purpose — a throwing reporter must not change behaviour
    }
    failed.push({
      orderId: order.orderId,
      error: "RESALE_CHAIN_UNORDERABLE",
      reason: "resale_chain_unorderable",
    });
    // Named in the gift-detection report beside the orders with no link.
    unlinkedResaleOrderIds.push(order.orderId);
  }

  for (const { loaded: order, record } of resaleOrdersLastBuyerFirst) {
    // This order's items whose later purchase was refunded just above.
    const itemsUnwoundFirst =
      refundedResaleParentItemsByOrderId.get(order.orderId) ??
      NO_ORDER_ITEM_IDS;

    // The unwind pre-check, before this order's money moves. A ticket that
    // is still on this order's item passes as it always did. One that was
    // sold on passes only for an item whose later purchase was refunded: the
    // marking tx unwinds that purchase first, so the ticket is back on the
    // item by the time this order's unwind runs.
    try {
      await assertResaleOrderCanBeUnwound(deps.repos, record, {
        soldOnItemIdsUnwoundFirst: itemsUnwoundFirst,
      });
    } catch (error) {
      const reason = resaleUnwindRefusalReason(error, record, {
        resaleLinkedParentItemIds,
        itemsUnwoundFirst,
      });
      logger?.error("cancel_event_refund_failed", {
        orderId: order.orderId,
        error: describeError(error),
        ...(reason ? { reason } : {}),
      });
      // Reported: the order is left unrefunded, nothing retries it, and the
      // log line alone is not a signal anyone is sent.
      try {
        deps.reportError?.(error, {
          tags: {
            useCase: "cancelEvent",
            stage: "resale_unwind_precheck",
            reason: reason ?? "other",
          },
          extra: {
            orderId: order.orderId,
            parentOrderId: order.parentOrderId,
            eventId: order.eventId,
          },
        });
      } catch {
        // ignored on purpose — a throwing reporter must not change behaviour
      }
      failed.push({
        orderId: order.orderId,
        error: describeError(error),
        ...(reason ? { reason } : {}),
      });
      continue;
    }

    const result = await refundLoadedOrder(
      deps,
      order,
      logger,
      itemsUnwoundFirst.size > 0
        ? {
            refundedResaleParentItemIds: itemsUnwoundFirst,
            resaleLinkedParentItemIds: null,
          }
        : NO_TRANSFERRED_ITEMS_REFUNDABLE,
      buildOrderProviderIdempotencyKey(providerIdempotencyKey, order.orderId),
    );
    if (result.status === "failed") {
      failed.push(result.failure);
      continue;
    }
    if (result.status === "skipped") {
      if (itemsUnwoundFirst.size > 0) {
        // A middle hop that refunds nothing AFTER the purchase behind it was
        // refunded: that buyer has their money, this order's buyer was
        // debited for it and holds the ticket again, and this order's own
        // refund did not happen. A skip is otherwise silent, so this one is
        // recorded as a failure and reported; nothing retries it.
        const context = {
          orderId: order.orderId,
          parentOrderId: order.parentOrderId,
          eventId: order.eventId,
        };
        logger?.error("cancel_event_resale_hop_skipped", context);
        try {
          deps.reportError?.(new Error("cancel_event_resale_hop_skipped"), {
            tags: { useCase: "cancelEvent", stage: "resale_hop_skipped" },
            extra: context,
          });
        } catch {
          // ignored on purpose — a throwing reporter must not change behaviour
        }
        failed.push({
          orderId: order.orderId,
          error: "RESALE_HOP_SKIPPED",
          reason: "resale_hop_skipped",
        });
      }
      continue;
    }

    succeeded.push(result.result);
    recordRefundedResaleParentItems(refundedResaleParentItemsByOrderId, order);
  }

  for (const order of nonResaleOrders) {
    const refundedResaleParentItemIds =
      refundedResaleParentItemsByOrderId.get(order.orderId) ??
      new Set<string>();
    const giftDetectionEnabled =
      !linkageIncompleteGlobally &&
      !linkageIncompleteParentOrderIds.has(order.orderId);

    // Fail closed. This cancellation cannot re-run for the event, and no
    // other refund path ever pays a transferred item, so refunding this
    // order SHORT and stamping it REFUNDED would strand its payer for good.
    // The order stays SUCCEEDED, its buyer lands in the pending-refund set
    // and `failedRefundCount` surfaces it for a human. Orders with no
    // transferred item of unknown origin are unaffected by degraded mode.
    //
    // Judged on the order as re-read INSIDE its refund mutex
    // (`refundLoadedOrder` runs this gate), never on the snapshot above: a
    // gift that committed between the two would otherwise pass this check
    // on the snapshot and then be kept by the degraded policy on the
    // re-read, so the payer is never refunded and the order lands on
    // neither list.
    const giftDetectionGate = (
      current: LoadedRefundableOrder,
    ): RefundFailure | null => {
      if (
        giftDetectionEnabled ||
        !hasTransferredItemOfUnknownOrigin(current.items, {
          refundedResaleParentItemIds,
          resaleLinkedParentItemIds,
        })
      ) {
        return null;
      }
      const context = {
        orderId: current.orderId,
        unloadedOrderIds,
        unlinkedResaleOrderIds,
      };
      try {
        deps.reportError?.(new Error("cancel_event_gift_detection_disabled"), {
          tags: { useCase: "cancelEvent", stage: "gift_detection" },
          extra: context,
        });
      } catch {
        // ignored on purpose — a throwing reporter must not change behaviour
      }
      logger?.error("cancel_event_gift_detection_disabled", context);
      return { orderId: current.orderId, error: "GIFT_DETECTION_DISABLED" };
    };

    const transferredItemPolicy: TransferredItemPolicy = {
      refundedResaleParentItemIds,
      resaleLinkedParentItemIds: giftDetectionEnabled
        ? resaleLinkedParentItemIds
        : null,
    };
    const result = await refundLoadedOrder(
      deps,
      order,
      logger,
      transferredItemPolicy,
      buildOrderProviderIdempotencyKey(providerIdempotencyKey, order.orderId),
      giftDetectionGate,
    );
    if (result.status === "failed") {
      failed.push(result.failure);
      continue;
    }
    if (result.status === "skipped") {
      continue;
    }

    succeeded.push(result.result);
  }

  return { succeeded, failed };
}

async function refundLoadedOrder(
  deps: CancelEventDeps,
  order: LoadedRefundableOrder,
  logger: LoggerPort | undefined,
  transferredItemPolicy: TransferredItemPolicy,
  providerIdempotencyKey: string,
  /**
   * A refusal judged on the order as re-read inside its mutex (the
   * degraded-mode gift-detection guard). Null = go ahead.
   */
  inLockGate?: (current: LoadedRefundableOrder) => RefundFailure | null,
): Promise<RefundAttemptResult> {
  try {
    // Per-order refund mutex: a concurrent buyer/org/staff/claim refund on
    // this order conflicts here and sends THIS order to the failed list (the
    // catch below), matching the existing per-order failure posture — the
    // cancellation continues with the other orders. Acquired/released per
    // order around the external calls; the later marking tx runs after
    // release, which is safe because any refund path acquiring in that gap
    // re-refunds against a PI Stripe already fully refunded and fails before
    // committing. Ticket moves cannot use that gap: the event's
    // `cancel-op:` lock (held by `runCancelEvent` until the marking tx
    // commits) refuses them. See ../orders/_shared/refund-mutex.ts.
    return await withOrderRefundMutexForCancel(
      deps,
      order.orderId,
      async (): Promise<RefundAttemptResult> => {
        // Re-load INSIDE the held mutex: `processRefunds` loaded `order`
        // before it, so a gift or a refund that committed in between would
        // otherwise be selected off a stale snapshot. Selection, the paid
        // total and the stamped item ids all come from this read.
        const { current, disputeStatus } = await reloadLoadedOrder(deps, order);

        // The dispute guard in `processRefunds` read the snapshot; a dispute
        // opened since is refused the same way, before any money moves.
        if (isBlockedSettlementDisputeStatus(disputeStatus)) {
          logger?.warn("cancel_event_refund_skip_disputed", {
            orderId: current.orderId,
            disputeStatus,
          });
          return {
            status: "failed",
            failure: {
              orderId: current.orderId,
              error: "ORDER_DISPUTED_REFUND_BLOCKED",
              reason: "disputed",
            },
          };
        }

        const gateFailure = inLockGate?.(current) ?? null;
        if (gateFailure) {
          return { status: "failed", failure: gateFailure };
        }

        // ── Refund amount: what the buyer paid MINUS the Stripe fee ────────
        // Same order of operations as `refundFullOrder` (the source of truth
        // for the rule — see `buildRefundPlan`): select first, and an order
        // with nothing selected or nothing paid is SKIPPED here, BEFORE the
        // fee lookup, so a fully-refunded, all-transferred or zero-total
        // order never costs a Stripe read and never throws. Then read the
        // order's ACTUAL processing fee off the PaymentIntent's balance
        // transaction and net it out per item. A failed fee read is a
        // `dependency_failed` for THIS order (the catch below sends it to the
        // failed list, no Stripe refund issued) — never a gross refund by
        // default.
        const selection = selectRefundableTicketItems(
          current.items,
          transferredItemPolicy,
        );
        if (
          current.orderTotalPaidCents <= 0 ||
          selection.refundable.length + selection.requiresReversal.length === 0
        ) {
          logger?.warn("cancel_event_refund_skip_zero", {
            orderId: current.orderId,
          });
          return { status: "skipped" };
        }

        const processingFee = await readProcessingFeeOrDependencyFailed(
          deps,
          current,
          logger,
        );

        const refundPlan = buildRefundPlan(
          selection,
          current.orderTotalPaidCents,
          processingFee.feeCents,
          order.taxShares.perLinePaidByItem,
        );
        // A plan that returns $0 on a paid order (owner ruling 2026-10-11: a
        // ticket that cost $0 refunds $0). Reached when the only items left
        // to refund weigh nothing, e.g. a ticket a code made free whose paid
        // sibling was refunded before the cancellation. The order is NOT
        // skipped: it goes through the same marking tx as every refunded
        // order (items refunded, tickets REFUNDED, seats released, order
        // REFUNDED), so the buyer is not left holding a live pass on a
        // PART_REFUNDED order for a cancelled show. Only the Stripe refund is
        // left out (Stripe rejects amount 0); a paid-out item's transfer is
        // still reversed below, as in the two refund use cases
        // (`../orders/_shared/no-charge-refund.ts`).
        //
        // A RESALE order keeps the skip, as `refundFullOrder` keeps its
        // refusal: it is one paid ticket, so a $0 plan there is an anomaly,
        // and its unwind moves the seller's money.
        const isNoChargeRefund = refundPlan.totalRefundCents <= 0;
        if (isNoChargeRefund && current.source === "RESALE") {
          logger?.warn("cancel_event_refund_skip_zero", {
            orderId: current.orderId,
          });
          return { status: "skipped" };
        }

        let transferReversals: TransferReversalResult[] = [];
        const requiresReversalIds = refundPlan.requiresReversal
          .map((item) => item.id)
          .sort();
        if (refundPlan.requiresReversal.length > 0) {
          try {
            transferReversals = await reverseTransfersForItems(
              {
                repos: deps.repos,
                payments: deps.payments,
                logger,
                reportError: deps.reportError,
              },
              {
                // Sorted: a retry's reversal params must be byte-stable
                // whatever order the plan listed the items in.
                orderItemIds: requiresReversalIds,
                // NET of the withheld Stripe fee — the same per-item figure
                // `refundFullOrder` passes (its `refundedCents`). These nets
                // only bind on the PRE-CUTOVER legacy junction arm of
                // `reverse-transfers-for-items.ts`; the ledger era ignores
                // `itemAmounts` and reverses the SETTLEMENT_CREDIT
                // attribution instead (see its input doc).
                itemAmounts: new Map(
                  requiresReversalIds.map((id) => [
                    id,
                    refundPlan.refundableAmountsByItem.get(id) ?? 0,
                  ]),
                ),
                idempotencyKeyPrefix: `${providerIdempotencyKey}:reverse-transfer`,
              },
            );
          } catch (reversalError) {
            logger?.error("cancel_event_transfer_reversal_failed", {
              orderId: current.orderId,
              paidOutItemIds: refundPlan.requiresReversal.map(
                (item) => item.id,
              ),
              error: describeError(reversalError),
            });
            throw reversalError;
          }
        }

        const refund = isNoChargeRefund
          ? {
              // No processor call; a deterministic internal id, so a replayed
              // cancellation writes the same ledger keys.
              refundId: buildNoChargeRefundId(current.orderId, [
                ...refundPlan.refundableAmountsByItem.keys(),
              ]),
              status: "succeeded" as const,
            }
          : await refundPaymentIntentOrDependencyFailed(
          deps.payments,
          {
            paymentIntentId: current.summary.stripePaymentIntentId,
            amountCents: refundPlan.totalRefundCents,
            reason: "requested_by_customer",
            idempotencyKey: `${providerIdempotencyKey}:refund-payment-intent`,
            // The refund withholds the Stripe fee, so Stripe reads it as
            // PARTIAL and `charge.refunded` lands in the reconciler's partial
            // arm — which flips ONLY the items the refund NAMES. Without
            // these ids a cancellation whose marking tx below dies would
            // leave the buyer refunded and every ticket VALID, seat SOLD,
            // event PUBLISHED, with nothing able to heal it. Same stamp as
            // `refundFullOrder`.
            metadata: buildRefundMetadata({
              useCase: "cancelEvent",
              orderId: current.orderId,
              orderItemIds: [...refundPlan.refundableAmountsByItem.keys()],
              logger,
            }),
          },
          logger,
          {
            action: "refund_payment_intent",
            orderId: current.orderId,
            paymentIntentId: current.summary.stripePaymentIntentId,
          },
        );
        const { refundId } = ensureSucceededRefund(refund);

        return {
          status: "succeeded",
          result: {
            orderId: current.orderId,
            refundId,
            refundedCents: refundPlan.totalRefundCents,
            refundedResaleParentItemIds: selection.refundedResaleParentItemIds,
            refundedGiftedOrderItemIds: selection.refundedGiftedOrderItemIds,
            transferReversals,
            perLineTaxByItem: order.taxShares.perLinePaidByItem
              ? order.taxShares.taxByItem
              : null,
          },
        };
      },
    );
  } catch (error) {
    logger?.error("cancel_event_refund_failed", {
      orderId: order.orderId,
      error: describeError(error),
    });

    return {
      status: "failed",
      failure: { orderId: order.orderId, error: describeError(error) },
    };
  }
}

/**
 * Re-reads the order inside its refund mutex (see `refundLoadedOrder`). The
 * summary (PaymentIntent) and parent link do not change; the items, the
 * paid total and the dispute status are taken fresh.
 */
async function reloadLoadedOrder(
  deps: Pick<CancelEventDeps, "repos">,
  order: LoadedRefundableOrder,
): Promise<{
  current: LoadedRefundableOrder;
  disputeStatus: OrderRecord["disputeStatus"];
}> {
  const fresh = await deps.repos.orders.getById(order.orderId);
  if (!fresh) {
    throw fail("ORDER_NOT_FOUND");
  }
  return {
    current: {
      ...order,
      items: fresh.items,
      orderTotalPaidCents: computeExpectedPaymentAmount(fresh),
    },
    disputeStatus: fresh.disputeStatus,
  };
}

/**
 * Waits before giving an order up as busy. A ticket move holds an order's
 * refund mutex for one short transaction (`_helpers/with-ticket-refund-lock`)
 * and a cancellation never re-runs for an event, so failing the order on
 * that brief hold would strand its payer. A real concurrent refund holds it
 * for seconds and still ends on the failed list, as before.
 */
const CANCEL_ORDER_MUTEX_RETRY_DELAYS_MS = [250, 750];

/**
 * `withOrderRefundMutex` with a bounded wait on a busy order. Exhaustion
 * throws the same `IDEMPOTENCY_LOCK_IN_PROGRESS` / `order_refund_in_progress`
 * error `withOrderRefundMutex` does, so the failed-list entry is unchanged.
 */
async function withOrderRefundMutexForCancel<T>(
  deps: Pick<CancelEventDeps, "idempotency" | "logger" | "reportError">,
  orderId: string,
  fn: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const held = await tryAcquireOrderRefundMutex(
      deps,
      orderId,
      ORDER_REFUND_MUTEX_TTL_SECONDS,
    );
    if (held) {
      try {
        return await fn();
      } finally {
        await held.release();
      }
    }
    const delayMs = CANCEL_ORDER_MUTEX_RETRY_DELAYS_MS[attempt];
    if (delayMs === undefined) {
      throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS", {
        message: "order_refund_in_progress",
        meta: { orderId },
      });
    }
    await sleep(delayMs);
  }
}

/**
 * Backoff for the processing-fee read: three attempts. A cancellation
 * commits even when one order's refund fails, and `ensureEventCancellable`
 * refuses every later attempt (EVENT_ALREADY_CANCELLED), so an order that
 * fails here is NOT retried by anyone — a transient Stripe blip must not be
 * enough to strand it. Same shape as the reconciler's mutex retry.
 */
const PROCESSING_FEE_RETRY_DELAYS_MS = [250, 750];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The order's ACTUAL Stripe fee, read off the PaymentIntent's balance
 * transaction with a short bounded retry. Exhaustion is a `dependency_failed`
 * for this order (same error shape and `dependency_failed` log line as
 * `callOrDependencyFailed`, action `get_processing_fee`) AND a Sentry report:
 * the caller swallows it into the failed list, and a swallowed failure that
 * nothing retries must be visible (CLAUDE.md error convention). The reporter
 * is guarded so a throwing reporter never changes the outcome.
 */
async function readProcessingFeeOrDependencyFailed(
  deps: Pick<CancelEventDeps, "payments" | "reportError">,
  order: LoadedRefundableOrder,
  logger: LoggerPort | undefined,
): Promise<{ feeCents: number }> {
  const paymentIntentId = order.summary.stripePaymentIntentId;
  const attempts = PROCESSING_FEE_RETRY_DELAYS_MS.length + 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) {
      await sleep(PROCESSING_FEE_RETRY_DELAYS_MS[attempt - 2]!);
    }
    try {
      return await deps.payments.getProcessingFeeForPaymentIntent({
        paymentIntentId,
      });
    } catch (error) {
      lastError = error;
      logger?.warn("cancel_event_processing_fee_read_retry", {
        orderId: order.orderId,
        paymentIntentId,
        attempt,
        attempts,
        error: describeError(error),
      });
    }
  }

  logger?.error("dependency_failed", {
    action: "get_processing_fee",
    orderId: order.orderId,
    paymentIntentId,
    attempts,
    error: describeError(lastError),
  });
  try {
    deps.reportError?.(lastError, {
      tags: { useCase: "cancelEvent", stage: "get_processing_fee" },
      extra: {
        orderId: order.orderId,
        eventId: order.eventId,
        paymentIntentId,
        attempts,
      },
    });
  } catch {
    // ignored on purpose — a throwing reporter never changes behaviour
  }
  throw { code: "dependency_failed", message: "get_processing_fee" } as const;
}

interface ResaleParentLink {
  /** The parent order, when the resale order names it (`parentOrderId` or meta). */
  originalOrderId: string | null;
  /** The parent item, when the resale item's meta carries it. */
  originalOrderItemId: string | null;
}

/**
 * The parent items a RESALE order's ticket items point back at (the item the
 * ticket was bought FROM: a PRIMARY item, or another RESALE order's item when
 * the ticket had already been resold), one link per ticket item. A link with
 * a `null` half is one that could not be resolved. This is the ONE place the
 * gift-vs-resale question, and the order of a resale chain, are answered
 * from: the linkage lives on the resale item (`resaleOriginalOrderItemId` in
 * its meta, written by `createResaleCheckout`; the order's `parentOrderId`
 * names the parent order). The parent's own `resaleListingId` cannot answer
 * it: on a PRIMARY parent it is the "listed now" pointer, cleared when the
 * sale completes, and on a RESALE parent it is the listing that item was
 * bought through, which the later sale never rewrites
 * (`../_helpers/order-item-listing-pointer.ts`).
 */
function resaleParentLinksOf(order: {
  parentOrderId: string | null;
  items: OrderItemRecord[];
}): ResaleParentLink[] {
  const links: ResaleParentLink[] = [];
  for (const item of order.items) {
    if (item.kind !== "ticket") {
      continue;
    }

    links.push({
      originalOrderId:
        order.parentOrderId ??
        getMetaString(item.meta, "resaleOriginalOrderId") ??
        null,
      originalOrderItemId:
        getMetaString(item.meta, "resaleOriginalOrderItemId") ?? null,
    });
  }
  return links;
}

/** A RESALE order as loaded, with the record its unwind pre-check reads. */
interface LoadedResaleOrder {
  loaded: LoadedRefundableOrder;
  record: OrderRecord;
}

const NO_ORDER_ITEM_IDS: ReadonlySet<string> = new Set<string>();

/**
 * The event's RESALE orders in the order a cancellation refunds them: an
 * order comes only after EVERY resale order that bought one of its items
 * (`resaleParentLinksOf`), so each chain is walked from its last buyer back
 * towards the primary order. Independent chains keep the order they were
 * loaded in. Pure, and independent of the order `listAll` returned.
 *
 * `unorderable` is a loop, or anything waiting on one: the orders in a loop
 * of links (one that names its own item, or two that name each other's) and
 * every earlier hop that can only come after them. A loop cannot come from
 * a real sale; such orders are failed closed by the caller, never looped on.
 *
 * Only LOADED resale orders are nodes. A later purchase that is disputed or
 * could not be read is not waited for here; the order it bought from is
 * refused at its turn because that purchase was never refunded.
 */
function orderResaleOrdersLastBuyerFirst(orders: LoadedResaleOrder[]): {
  ordered: LoadedResaleOrder[];
  unorderable: LoadedResaleOrder[];
} {
  const orderIdByItemId = new Map<string, string>();
  for (const { loaded } of orders) {
    for (const item of loaded.items) {
      orderIdByItemId.set(item.id, loaded.orderId);
    }
  }

  // sellerOrderId → the loaded resale orders that bought one of its items.
  const waitingOn = new Map<string, Set<string>>();
  const soldBy = new Map<string, Set<string>>();
  for (const { loaded } of orders) {
    for (const link of resaleParentLinksOf(loaded)) {
      const sellerOrderId = link.originalOrderItemId
        ? orderIdByItemId.get(link.originalOrderItemId)
        : undefined;
      if (!sellerOrderId) {
        continue;
      }
      getOrCreateSet(waitingOn, sellerOrderId).add(loaded.orderId);
      getOrCreateSet(soldBy, loaded.orderId).add(sellerOrderId);
    }
  }

  const byId = new Map(orders.map((order) => [order.loaded.orderId, order]));
  const ordered: LoadedResaleOrder[] = [];
  const ready = orders.filter(
    ({ loaded }) => (waitingOn.get(loaded.orderId)?.size ?? 0) === 0,
  );
  for (let next = ready.shift(); next; next = ready.shift()) {
    ordered.push(next);
    const buyerOrderId = next.loaded.orderId;
    for (const sellerOrderId of soldBy.get(buyerOrderId) ?? []) {
      const stillWaitingOn = waitingOn.get(sellerOrderId);
      if (!stillWaitingOn?.delete(buyerOrderId)) {
        continue;
      }
      const seller = byId.get(sellerOrderId);
      if (stillWaitingOn.size === 0 && seller) {
        ready.push(seller);
      }
    }
  }

  const placed = new Set(ordered.map((order) => order.loaded.orderId));
  return {
    ordered,
    unorderable: orders.filter(({ loaded }) => !placed.has(loaded.orderId)),
  };
}

function getOrCreateSet<K, V>(map: Map<K, Set<V>>, key: K): Set<V> {
  let set = map.get(key);
  if (!set) {
    set = new Set<V>();
    map.set(key, set);
  }
  return set;
}

/**
 * Why a RESALE order's unwind pre-check refused it, when the refusal is that
 * its ticket was sold on (`TICKET_NOT_FOUND`, `meta.reason: "sold_on"`).
 * `later_resale_not_refunded` when a resale order of this event bought one
 * of this order's items and was not refunded in this run; plain `sold_on`
 * when no such order was read. Undefined for every other refusal: the entry
 * then carries the error alone, as before.
 *
 * The reason is what was true when the order was refused (decision time),
 * read from the links and the refunds recorded so far in this run. It is
 * not revised by what a later order's unwind goes on to resolve.
 */
function resaleUnwindRefusalReason(
  error: unknown,
  order: OrderRecord,
  known: {
    resaleLinkedParentItemIds: ReadonlySet<string>;
    itemsUnwoundFirst: ReadonlySet<string>;
  },
): RefundFailureReason | undefined {
  if (
    !isAppError(error) ||
    error.code !== "TICKET_NOT_FOUND" ||
    error.meta?.reason !== "sold_on"
  ) {
    return undefined;
  }
  const laterPurchaseNotRefunded = order.items.some(
    (item) =>
      item.kind === "ticket" &&
      known.resaleLinkedParentItemIds.has(item.id) &&
      !known.itemsUnwoundFirst.has(item.id),
  );
  return laterPurchaseNotRefunded ? "later_resale_not_refunded" : "sold_on";
}

/**
 * After a RESALE order's refund SUCCEEDED: remember its parent items, keyed
 * by parent order, so the parent order's plan can refund them too. The
 * parent is a PRIMARY order, or the RESALE order one hop back in a chain.
 */
function recordRefundedResaleParentItems(
  refundedResaleParentItemsByOrderId: Map<string, Set<string>>,
  order: LoadedRefundableOrder,
): void {
  for (const link of resaleParentLinksOf(order)) {
    if (!link.originalOrderId || !link.originalOrderItemId) {
      continue;
    }

    let linkedItems = refundedResaleParentItemsByOrderId.get(
      link.originalOrderId,
    );
    if (!linkedItems) {
      linkedItems = new Set<string>();
      refundedResaleParentItemsByOrderId.set(link.originalOrderId, linkedItems);
    }
    linkedItems.add(link.originalOrderItemId);
  }
}

/**
 * How a cancellation treats an order's `transferred` ticket items. Two sets,
 * named for what they are, because "transferred" alone does not say who is
 * out of pocket (decision record:
 * docs/decisions/cancellation-refunds-gifted-tickets-to-the-payer.md).
 */
interface TransferredItemPolicy {
  /**
   * Parent items whose RESALE order this cancellation already refunded —
   * refundable: the resale buyer has been made whole, so the payer of the
   * item it was bought from gets theirs back too. That payer is the original
   * buyer on a PRIMARY order, or the previous resale buyer in a chain.
   */
  refundedResaleParentItemIds: ReadonlySet<string>;
  /**
   * EVERY parent item some RESALE order of this event points at, whether that
   * resale refund succeeded, failed or was never attempted. A transferred
   * item NOT in here was GIFTED — refundable to its payer. `null` means gift
   * detection is off for this order (RESALE orders always; a PRIMARY order
   * whose linkage is incomplete — `processRefunds` has already failed it
   * closed if any transferred item was of unknown origin), in which case no
   * transferred item is treated as a gift.
   */
  resaleLinkedParentItemIds: ReadonlySet<string> | null;
}

/**
 * No transferred item is refundable — the pre-ruling rule, kept for a RESALE
 * order none of whose items was sold on and refunded (`processRefunds`).
 */
const NO_TRANSFERRED_ITEMS_REFUNDABLE: TransferredItemPolicy = {
  refundedResaleParentItemIds: new Set<string>(),
  resaleLinkedParentItemIds: null,
};

type TransferredItemDisposition =
  /** Its RESALE order was refunded by this cancellation: refund the parent too. */
  | "refund_as_resale_parent"
  /** No RESALE order points at it: a gift, refunded to the payer. */
  | "refund_as_gift"
  /** A resale parent whose resale refund did not succeed, or a policy that admits none. */
  | "keep";

/**
 * Which rule, if any, admits a `transferred` ticket item into the refund.
 * Pure; cancellation-specific (it is NOT `classifyRefundItem`).
 */
function classifyTransferredTicketItem(
  item: OrderItemRecord,
  policy: TransferredItemPolicy,
): TransferredItemDisposition {
  if (policy.refundedResaleParentItemIds.has(item.id)) {
    return "refund_as_resale_parent";
  }
  if (
    policy.resaleLinkedParentItemIds !== null &&
    !policy.resaleLinkedParentItemIds.has(item.id)
  ) {
    return "refund_as_gift";
  }
  return "keep";
}

/**
 * Degraded-mode gate: does this order carry a live `transferred` ticket item
 * that is neither a refunded resale parent nor positively linked from some
 * RESALE order? With the linkage incomplete such an item cannot be told from
 * a gift, so the ORDER must fail closed rather than refund short. An item
 * that IS linked is positively a resale parent and keeps today's handling
 * regardless of degraded mode.
 */
function hasTransferredItemOfUnknownOrigin(
  items: OrderItemRecord[],
  known: {
    refundedResaleParentItemIds: ReadonlySet<string>;
    resaleLinkedParentItemIds: ReadonlySet<string>;
  },
): boolean {
  return items.some(
    (item) =>
      item.kind === "ticket" &&
      item.status !== "refunded" &&
      !item.refundedAt &&
      (item.status === "transferred" || item.transferredAt) &&
      !known.refundedResaleParentItemIds.has(item.id) &&
      !known.resaleLinkedParentItemIds.has(item.id),
  );
}

interface RefundableTicketItemSelection {
  /** EVERY ticket item on the order — the allocation universe (all of them). */
  ticketItems: OrderItemRecord[];
  /** Items refunded straight off the PaymentIntent. */
  refundable: OrderItemRecord[];
  /** Paid-out items: refunded after their transfer is reversed. */
  requiresReversal: OrderItemRecord[];
  /** The `transferred` items selected above, by the rule that admitted them. */
  refundedResaleParentItemIds: string[];
  refundedGiftedOrderItemIds: string[];
}

/**
 * WHICH of an order's ticket items this cancellation refunds — the selection
 * half of the plan, split out from the money half (`buildRefundPlan`) because
 * the two answer different questions and only the money is shared with
 * `refundFullOrder`. Pure, and cancellation-specific (it is NOT
 * `classifyRefundItem`): already-refunded items are skipped, a `transferred`
 * item is admitted only by `classifyTransferredTicketItem`, and a paid-out
 * item is refundable after a transfer reversal — cancel-event, like staff /
 * org, is never bound by the buyer's stop-at-payout rule. A gifted item that
 * was paid out goes the same way.
 */
function selectRefundableTicketItems(
  items: OrderItemRecord[],
  policy: TransferredItemPolicy,
): RefundableTicketItemSelection {
  const ticketItems = items.filter((item) => item.kind === "ticket");
  const refundable: OrderItemRecord[] = [];
  const requiresReversal: OrderItemRecord[] = [];
  const refundedResaleParentItemIds: string[] = [];
  const refundedGiftedOrderItemIds: string[] = [];

  for (const item of ticketItems) {
    if (item.status === "refunded" || item.refundedAt) {
      continue;
    }

    // A transferred item is admitted when EITHER its resale order was
    // refunded by this same cancellation OR no resale order points at it
    // at all (a gift). A resale parent whose resale refund failed is
    // neither and stays skipped. A gifted item that was paid out goes
    // through the reversal path below like any other item.
    if (item.status === "transferred" || item.transferredAt) {
      const disposition = classifyTransferredTicketItem(item, policy);
      if (disposition === "keep") {
        continue;
      }
      if (disposition === "refund_as_resale_parent") {
        refundedResaleParentItemIds.push(item.id);
      } else {
        refundedGiftedOrderItemIds.push(item.id);
      }
    }

    if (item.paidOutAt) {
      requiresReversal.push(item);
      continue;
    }

    refundable.push(item);
  }

  return {
    ticketItems,
    refundable,
    requiresReversal,
    refundedResaleParentItemIds,
    refundedGiftedOrderItemIds,
  };
}

/**
 * The per-order MONEY of a cancellation refund.
 *
 * THE RULE — one rule for every refund path, and `refundFullOrder`
 * (`../orders/refund-full-order.ts`) is its source of truth: a refund returns
 * everything the buyer paid (ticket price, platform fee AND tax —
 * `orderTotalPaidCents` = `computeExpectedPaymentAmount(order)`) EXCEPT the
 * Stripe processing fee. Stripe keeps its fee on a refund, so refunding it
 * would mean the platform eats it; the organiser-facing cancel confirmation
 * already promises "refunded (minus payment processing fees)". Uniform across
 * ABSORB and PASS_THROUGH fee modes.
 *
 * Both amounts are allocated across ALL ticket items (never just the ones
 * being refunded, so a skipped sibling cannot shift a share) by
 * `allocateFullRefundShares` — the same function, imported, not a copy — and
 * each refunded item gets `max(0, buyerPaidShare − stripeFeeShare)`. On an
 * order whose tax is split per PLATFORM line, `buyerPaidShare` is `base +
 * per-line tax share` (`perLinePaidByItem`), exactly as `refundFullOrder`
 * and the item path pay it. A
 * cancelled order therefore refunds the identical cents a staff full refund of
 * it would, for every order shape BOTH paths accept; the parity test pins that
 * through the two use cases' public entry points. The item SELECTION is where
 * they legitimately differ (`selectRefundableTicketItems`): a cancellation
 * includes LISTED and gifted items — the show is gone — while
 * `refundFullOrder` skips a live listing and refuses a resale-linked
 * transferred leg outright. `orderStripeFeeCents` is the order's ACTUAL fee,
 * read off Stripe by the caller — never estimated.
 *
 * Until 2026-09 this path refunded `buyerPaid + taxShare` GROSS, i.e. it
 * handed back the Stripe fee too and disagreed with every other refund path.
 */
function buildRefundPlan(
  selection: RefundableTicketItemSelection,
  orderTotalPaidCents: number,
  orderStripeFeeCents: number,
  perLinePaidByItem: ReadonlyMap<string, number> | null,
): RefundPlan {
  const { ticketItems, refundable, requiresReversal } = selection;

  const { netRefundCentsForItem } = allocateFullRefundShares(
    ticketItems,
    orderTotalPaidCents,
    orderStripeFeeCents,
    perLinePaidByItem,
  );

  const refundableAmountsByItem = new Map<string, number>();
  for (const item of [...refundable, ...requiresReversal]) {
    refundableAmountsByItem.set(item.id, netRefundCentsForItem(item.id));
  }

  const totalRefundCents = [...refundableAmountsByItem.values()].reduce(
    (sum, amountCents) => sum + amountCents,
    0,
  );

  return {
    requiresReversal,
    refundableAmountsByItem,
    totalRefundCents,
  };
}

function buildPayloadHash(input: CancelEventInput): string {
  return JSON.stringify({ eventId: input.eventId });
}

// NOTE (Step C review): this key feeds the Stripe refund idempotency key and
// therefore the refund-debit `refundKey` chain — its stability is per
// CLIENT-SUPPLIED clientKey, not per event. A retry with a fresh clientKey
// after a rolled-back tx would take a different Stripe refund path. Not
// exploitable today (ensureEventCancellable rejects an already-CANCELLED
// event, and a second full refund on the same PI fails at Stripe), but the
// money-key chain depends on client input — keep that in mind before
// loosening either guard.
function buildIdempotencyKey(actorHumanId: string, clientKey: string): string {
  return `event:cancel:${actorHumanId}:${clientKey}`;
}

function buildOrderProviderIdempotencyKey(
  baseIdempotencyKey: string,
  orderId: string,
): string {
  return `${baseIdempotencyKey}:order:${orderId}`;
}
