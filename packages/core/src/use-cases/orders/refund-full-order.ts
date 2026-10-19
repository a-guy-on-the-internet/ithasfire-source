import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import { randomUUID } from "node:crypto";

import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type {
  PaymentProcessorPort,
  PaymentRefundStatus,
} from "@th/ports/payment-processor-port";
import type { Repos } from "@th/ports/repos";
import type { OrderItemRecord } from "@th/ports/repos/order-items";
import type { OrderRecord } from "@th/ports/repos/orders";
import type { TicketRecord } from "@th/ports/repos/tickets";
import type { ReporterPort } from "@th/ports/reporter";
import { stripeRefundReasonSchema } from "@th/schema";

import { asKnownError } from "../../lib/errors";
import { abandonClaim } from "../../lib/idempotency-claim";
import {
  callOrDependencyFailed,
  parseInput,
} from "../../lib/io";
import { getMetaString } from "../../lib/orders/meta";
import { computeExpectedPaymentAmount } from "../../lib/orders/compute-expected-payment-amount";
import { allocateProportionalCents } from "../../lib/orders/allocate-proportional-cents";
import { refundWeightCents } from "../../lib/orders/refund-weight";
import { allocateRefundFeeShares } from "../../lib/orders/refund-tax-share";
import {
  assertResaleOrderCanBeUnwound,
  unwindResaleOrderAfterRefund,
} from "../resale/unwind-resale-order-after-refund";
import {
  assertBuyerRefundWindowOpen,
  classifyRefundItem,
  refundItemIneligibleReasonSchema,
  type RefundItemIneligibleReason,
} from "./quote-item-refund";
import { reverseTransfersForItems } from "./reverse-transfers-for-items";
import {
  groupReversalsByPayee,
  writeRefundDebitsForOrder,
  writeTransferReversalCreditsForOrder,
} from "./_shared/write-refund-debits";
import { releaseSeatsForVoidedTickets } from "./_shared/release-seats-for-voided-tickets";
import {
  leftOnRefundAuditData,
  ticketsLeavingOnRefund,
  type TicketLeavingOnRefund,
} from "./_shared/tickets-leaving-on-refund";
import { buildNoChargeRefundId } from "./_shared/no-charge-refund";
import { allocateRefundPlatformFeeShares } from "./_shared/refund-platform-fee-share";
import { notifyBuyer, type NotifyFn } from "./notify-buyer";
import { fail } from "@th/errors";
import { requireTicketingEventId } from "./_shared/require-ticketing-order";
import { withOrderRefundMutex } from "./_shared/refund-mutex";
import {
  assertOrderNotDisputeBlocked,
  buildRefundMetadata,
  refundPaymentIntentOrDependencyFailed,
} from "./_shared/dispute-refund-guard";
import { findPriorRefundForItems } from "./_shared/prior-refund-preflight";
import { sendLegacyRelistNotices } from "../resale/_shared/send-legacy-relist-notices";
import type { LegacyRelistNotice } from "../resale/unwind-resale-order-after-refund";
import { reportRacedRefundItems } from "./_shared/report-raced-refund-items";
import { allocateRefundTaxSharesForOrder } from "./_shared/refund-tax-shares-for-order";

export const refundFullOrderInputSchema = z.object({
  actorHumanId: z.uuid(),
  orderId: z.uuid(),
  reason: stripeRefundReasonSchema.optional(),
});

const refundedItemSchema = z.object({
  orderItemId: z.string().uuid(),
  refundedCents: z.number().int().nonnegative(),
});

const skippedItemSchema = z.object({
  orderItemId: z.string().uuid(),
  reason: refundItemIneligibleReasonSchema,
});

export const refundFullOrderOutputSchema = z.object({
  ok: z.literal(true),
  orderId: z.uuid(),
  refundId: z.string().min(3),
  currency: z.string().min(3).max(3),
  amountPaidCents: z.number().int().nonnegative(),
  stripeFeeCents: z.number().int().nonnegative(),
  refundedCents: z.number().int().nonnegative(),
  /** Per-item breakdown of what was refunded. */
  refundedItems: z.array(refundedItemSchema),
  /**
   * Items that were not refundable: transferred, already refunded, listed for
   * resale, or (buyer-initiated) already scanned or already paid out.
   */
  skippedItems: z.array(skippedItemSchema),
  /** "REFUNDED" when all ticket items are now terminal, "PART_REFUNDED" otherwise. */
  newOrderStatus: z.enum(["REFUNDED", "PART_REFUNDED"]),
});

export type RefundFullOrderInput = z.infer<typeof refundFullOrderInputSchema>;
export type RefundFullOrderOutput = z.infer<typeof refundFullOrderOutputSchema>;

const IDEMPOTENCY_TTL_SECONDS = 300;

interface StoredRefundFullOrderRecord {
  response: RefundFullOrderOutput;
}

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

export type RefundFullOrderDeps = {
  repos: Repos;
  payments: PaymentProcessorPort;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Best-effort Sentry reporter for the refund-debit swallow branches
   * (missing pre-cutover credits, attribution drift). Wire from
   * `ctx.reportError` (CLAUDE.md error-reporting convention); a throwing
   * reporter never changes behaviour.
   */
  reportError?: ReporterPort | null;
  /**
   * Multi-channel notification dispatcher. Optional — when present the buyer
   * receives a fire-and-forget in-app (+ push) refund confirmation after the
   * refund is durably committed. The buyer doesn't care who initiated the
   * refund, so this fires for self-serve AND staff-delegated full refunds.
   * A notify outage never fails the refund.
   */
  notify?: NotifyFn;
  /**
   * The web app's origin. With it, refunding a resale order whose listing
   * was priced under the removed markup split tells the seller, in-app and
   * after the commit, that the sale was refunded, the listing closed, and how
   * to list again (`sendLegacyRelistNotices`). Without it that notice is
   * reported as unsent.
   */
  publicAppUrl?: string | null;
  /**
   * When true, the buyer-ownership guard is skipped — and with it the
   * buyer-only policy gates (`nonRefundable`, refund window, scanned ticket,
   * paid-out item). Only set this from internal callers that perform their
   * own authz (e.g., staffRefundOrder which validates staff roles before
   * delegating).
   */
  _skipBuyerCheck?: boolean;
};

/**
 * Executes a full-order refund for all refundable items:
 * - Transferred, already-refunded, and listed-for-resale items are skipped;
 *   for buyer-initiated refunds so are already-scanned tickets and paid-out
 *   items (docs/decisions/buyer-refunds-stop-at-payout.md). For staff /
 *   org / cancel-event, paid-out items are refunded after their transfer is
 *   reversed.
 * - Buyer-initiated refunds are refused once the refund window has closed
 *   (`assertBuyerRefundWindowOpen`); staff/cancel-event bypass.
 * - Refund amount = each refundable item's allocated buyer-paid amount (ticket
 *   price + tax) minus its allocated Stripe processing fee. The processor
 *   retains its fee on refunds, so the Stripe fee is withheld (non-refundable);
 *   ticket price, tax, and platform fee are all refunded. This matches the
 *   item-refund path and quote-full-refund, uniform across both fee modes.
 * - Order status becomes REFUNDED when every ticket item is now in a
 *   terminal state (refunded or transferred), PART_REFUNDED otherwise.
 */
export async function refundFullOrder(
  deps: RefundFullOrderDeps,
  rawInput: unknown,
): Promise<RefundFullOrderOutput> {
  const logger = deps.logger?.child({ useCase: "refundFullOrder" });
  const input = parseInput(refundFullOrderInputSchema, rawInput);

  // Minimal safety check until proper RBAC is wired.
  const actor = await deps.repos.humans.getById(input.actorHumanId);
  if (!actor) {
    throw fail("ACTOR_NOT_FOUND");
  }

  // Per-order single-flight mutex: serializes this refund against EVERY other
  // refund-creating path on the same order (item refunds, org refunds, event
  // cancellation, resale-claim refunds), whose Stripe idempotency keys live in
  // disjoint namespaces and so dedupe nothing across paths. The order is
  // loaded INSIDE the held section so the status/item pre-checks can't act on
  // a snapshot taken before a competing refund's commit.
  // See ./_shared/refund-mutex.ts for the acquire/release semantics.
  return withOrderRefundMutex(deps, input.orderId, () =>
    executeRefundFullOrder(deps, input, logger),
  );
}

/** The full-order refund body; runs while holding the per-order refund mutex. */
async function executeRefundFullOrder(
  deps: RefundFullOrderDeps,
  input: RefundFullOrderInput,
  logger: LoggerPort | undefined,
): Promise<RefundFullOrderOutput> {
  const order = await deps.repos.orders.getById(input.orderId);
  if (!order) {
    throw fail("ORDER_NOT_FOUND");
  }

  // ── Guard: only the buyer who placed the order may request a refund ─────
  if (!deps._skipBuyerCheck && order.buyerHumanId !== input.actorHumanId) {
    throw fail("ORDER_NOT_FOUND");
  }

  // ── Non-refundable guard (adjustable-price orders) ─────────────────────
  // Buyer-initiated refunds are blocked for non-refundable orders.
  // Staff refunds (_skipBuyerCheck=true) and event-cancellation refunds bypass this.
  if (order.nonRefundable && !deps._skipBuyerCheck) {
    throw fail("ORDER_NON_REFUNDABLE");
  }

  const idempotencyKey = buildRefundFullOrderIdempotencyKey(order.id);
  const replay =
    await deps.idempotency.get<StoredRefundFullOrderRecord>(idempotencyKey);
  if (replay) {
    return refundFullOrderOutputSchema.parse(replay.response);
  }

  // ── Dispute guard ────────────────────────────────────────────────────────
  // After the replay lookup (a completed refund still replays its stored
  // result) and BEFORE the idempotency claim: a refusal is not an attempt, so
  // it must not leave a `failed:` marker that locks a retry out for the
  // marker's TTL once the dispute closes. No Stripe call, no reversal, no
  // ledger write while the charge is under dispute.
  assertOrderNotDisputeBlocked(order);

  // ── Buyer pre-flight: refund window, order state, nothing refundable ────
  // Same position, same reason as the dispute guard: a policy refusal is not
  // an attempt and must not claim the key.
  //
  //  - Refund window: the event is the display query's source for the
  //    deadline the buyer was shown; `nonRefundable` was already refused
  //    above.
  //  - Order state: the not-paid / already-refunded / not-refundable /
  //    resale-linked gates, so the buyer sees the same error precedence they
  //    would have seen inside the attempt.
  //  - Nothing refundable: a buyer whose every item is scanned, gifted,
  //    listed or paid out is REFUSED (`NO_REFUNDABLE_ITEMS`) without
  //    claiming the shared `order:refund-full:${orderId}` key, so a buyer's
  //    ask never holds that key against a staff / org whole-order refund of
  //    the same order (the claim is released on failure, but a refusal still
  //    need not take it).
  //
  // Staff / org (`_skipBuyerCheck`) never run this block: for them a paid-out
  // item is refundable via reversal, and their refusals keep claiming the key.
  //
  // The classification is computed ONCE here and reused after `begin`: the
  // order was loaded inside the per-order refund mutex, so re-reading the
  // same items and tickets after the claim would return nothing fresher.
  let buyerClassified: ClassifiedTicketItems | null = null;
  if (!deps._skipBuyerCheck) {
    const event = await deps.repos.events.getById(
      requireTicketingEventId(order),
    );
    if (!event) {
      throw fail("EVENT_NOT_FOUND");
    }
    assertBuyerRefundWindowOpen(event, deps.clock.now());

    assertOrderInRefundableState(order);
    await assertNoPendingClaimRefund(deps.repos, order);
    buyerClassified = await loadAndClassifyTicketItems(deps, order, {
      buyerInitiated: true,
    });
    if (
      buyerClassified.refundable.length +
        buyerClassified.requiresReversal.length ===
      0
    ) {
      throw fail("NO_REFUNDABLE_ITEMS");
    }
  }

  // Owner token for `abandonClaim` (lib/idempotency-claim.ts explains why).
  const claimOwnerToken = randomUUID();
  const claimed = await deps.idempotency.begin(
    idempotencyKey,
    IDEMPOTENCY_TTL_SECONDS,
    claimOwnerToken,
  );
  if (!claimed) {
    const afterWait =
      await deps.idempotency.get<StoredRefundFullOrderRecord>(idempotencyKey);
    if (afterWait) {
      return refundFullOrderOutputSchema.parse(afterWait.response);
    }
    throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
  }

  /** Built inside the attempt, parsed after it (outside the abandon path). */
  let rawRefundFullOrderOutput: unknown;
  /** Sellers to tell after the commit (a legacy listing the unwind closed). */
  let relistNotices: LegacyRelistNotice[] = [];
  try {
    // Pure re-check for the buyer path (already asserted pre-flight); the
    // staff / org path's first and only run of the gates.
    assertOrderInRefundableState(order);

    // ── Classify each ticket item ──────────────────────────────────────────
    // Buyer: the pre-flight's result. Staff / org: read + classify now, with
    // the org rules (paid-out items refundable via reversal, scanned ok).
    const { ticketItems, ticketByItemId, refundable, requiresReversal, skipped } =
      buyerClassified ??
      (await loadAndClassifyTicketItems(deps, order, {
        buyerInitiated: false,
      }));

    // Tickets this refund deliberately leaves alone. The voiding loop below is
    // NOT quote-driven — it reads every ticket on the order — so anything the
    // quote skipped has to be named here or it gets killed anyway:
    //
    //  - `already_scanned`: a buyer's used pass, item not refunded.
    //  - `listing_active`: on resale, still owned, listing still live.
    //  - `already_transferred`: GIFTED AWAY. The transfer moved only
    //    `ownerHumanId`, so the ticket still carries this order's `orderId`
    //    and still reads VALID. The sender is NOT refunded for it (that is
    //    what makes it skipped), so killing it would take the recipient's
    //    pass for free — and, now that seats come back, put a seat somebody
    //    still holds a claim on back on sale to a third buyer.
    //  - `already_paid_out`: a BUYER's item whose revenue was paid out
    //    (docs/decisions/buyer-refunds-stop-at-payout.md). The buyer is NOT
    //    refunded for it, so its ticket stays a live pass — voiding it would
    //    take the ticket AND keep the money.
    //
    // `already_refunded` is not listed: its ticket is already terminal, so the
    // VALID/SCANNED filter below never picks it up.
    const keptTicketIds = new Set<string>();
    for (const s of skipped) {
      if (
        s.reason !== "already_scanned" &&
        s.reason !== "listing_active" &&
        s.reason !== "already_transferred" &&
        s.reason !== "already_paid_out"
      ) {
        continue;
      }
      const ticket = ticketByItemId.get(s.orderItemId);
      if (ticket) keptTicketIds.add(ticket.id);
    }

    // All refundable items = direct refundable + those needing reversal first
    const allRefundable = [...refundable, ...requiresReversal];

    if (allRefundable.length === 0) {
      throw fail("NO_REFUNDABLE_ITEMS");
    }

    // ── Compute amounts ────────────────────────────────────────────────────
    const orderTotalPaidCents = computeExpectedPaymentAmount(order);
    if (orderTotalPaidCents <= 0) {
      throw fail("ORDER_NOT_PAID");
    }

    const processingFee = await callOrDependencyFailed(
      () =>
        deps.payments.getProcessingFeeForPaymentIntent({
          paymentIntentId: order.stripePaymentIntentId!,
        }),
      logger,
      {
        action: "get_processing_fee",
        orderId: order.id,
        paymentIntentId: order.stripePaymentIntentId,
      },
    );
    const orderStripeFeeCents = processingFee.feeCents;

    // The TAX PORTION of what each item is about to be refunded, split per
    // PLATFORM tax line, each by its own base. Allocated across EVERY ticket
    // item, so the stamps sum to exactly `taxAmountCents` and an item's share
    // doesn't shift with which siblings turned out refundable. The order was
    // read through `deps.repos.orders` (outside the tx) and its lines are
    // immutable after checkout, so a plain read through the same repo is
    // enough.
    const { taxByItem: allocatedTaxByItem, perLinePaidByItem } =
      allocateRefundTaxSharesForOrder({
        useCase: "refundFullOrder",
        order,
        ticketItems,
        taxLines: await deps.repos.orders.listTaxLines(order.id),
        logger,
        reportError: deps.reportError,
      });

    // Allocate buyer-paid (ticket + tax) and the Stripe fee across ALL ticket
    // items so the proportional shares are stable regardless of which items are
    // refundable. Each refundable item's net refund = its allocated buyer-paid
    // amount minus its allocated Stripe fee. The Stripe fee is withheld
    // (the processor retains it); ticket price, tax, and platform fee refunded.
    // `allocateFullRefundShares` is the one definition — `quoteFullRefund`
    // quotes from the same function so the preview can't drift from the
    // money. On the per-line path the paid amount is `base + taxShare`
    // (`perLinePaidByItem`), so the stamp above is exactly the tax term of
    // the money. Every other order keeps the buyer-paid split of the
    // tax-inclusive total, unchanged, and its stamp is the buyer-paid share
    // of the tax (same weights, rounded on its own), as before.
    const {
      stripeFeeByItem: allocatedStripeFeeByItem,
      netRefundCentsForItem,
    } = allocateFullRefundShares(
      ticketItems,
      orderTotalPaidCents,
      orderStripeFeeCents,
      perLinePaidByItem,
    );

    // The PLATFORM-FEE PORTION of what each item is about to be refunded —
    // sibling of the tax share above, over the same ticket items, so Σ over
    // every ticket item is exactly `feesPlatformCents`. Accounting only; it
    // does not enter `refundedCents` (`_shared/refund-platform-fee-share.ts`).
    const allocatedPlatformFeeByItem = allocateRefundPlatformFeeShares(
      ticketItems,
      order.feesPlatformCents,
    );

    const refundedItems = allRefundable.map((item) => ({
      orderItemId: item.id,
      refundedCents: netRefundCentsForItem(item.id),
    }));

    const totalRefundCents = refundedItems.reduce(
      (sum, i) => sum + i.refundedCents,
      0,
    );

    const refundableStripeFeeCents = allRefundable.reduce(
      (sum, item) => sum + (allocatedStripeFeeByItem.get(item.id) ?? 0),
      0,
    );

    // A refund that returns $0 still runs (owner ruling 2026-10-11: a ticket
    // that cost $0 refunds $0). It is reached when the only refundable items
    // weigh nothing, e.g. a ticket a code made free whose paid sibling this
    // refund skips. The items and tickets are marked, seats come back, the
    // order status moves and the audit row is written below, with no REFUND
    // call: Stripe rejects a refund of amount 0. See
    // `_shared/no-charge-refund.ts`.
    //
    // A RESALE order keeps the refusal: it is one paid ticket, so a $0 total
    // there is an anomaly, and its unwind moves the seller's money.
    const isNoChargeRefund = totalRefundCents <= 0;
    if (isNoChargeRefund && order.source === "RESALE") {
      throw fail("REFUND_AMOUNT_ZERO");
    }

    if (order.source === "RESALE") {
      await assertResaleOrderCanBeUnwound(deps.repos, order);
    }

    // ── Reverse transfers for paid-out items ───────────────────────────────
    // Not skipped on a $0 refund. Whether there is money to pull back depends
    // on what the PAYEE was paid for the item, not on what the buyer gets: a
    // paid-out ticket so cheap that its refund clamps to $0 still earned the
    // payee its share. A ticket a discount brought down to $0 has no share in
    // the credit attribution, is never stamped `paidOutAt`, and so is never
    // in `requiresReversal`.
    let reversalResults: Awaited<ReturnType<typeof reverseTransfersForItems>> =
      [];
    if (requiresReversal.length > 0) {
      const reversalItemAmounts = new Map(
        requiresReversal.map((item) => {
          const ri = refundedItems.find((r) => r.orderItemId === item.id);
          return [item.id, ri?.refundedCents ?? 0];
        }),
      );

      reversalResults = await reverseTransfersForItems(
        {
          repos: deps.repos,
          payments: deps.payments,
          logger,
          reportError: deps.reportError,
        },
        {
          orderItemIds: requiresReversal.map((i) => i.id),
          itemAmounts: reversalItemAmounts,
          idempotencyKeyPrefix: `${idempotencyKey}:reverse-transfer`,
        },
      );
    }

    // ── Retry pre-flight (money audit 2026-09-08 #10, second layer) ────────
    // A prior attempt whose tx below died left its refund at Stripe naming
    // exactly these items. This path's key is per-order, so a same-path
    // retry inside Stripe's 24h window dedupes — but the item path's
    // namespace never shares it, and the window expires. Find and reuse
    // the refund instead of paying again. A listing failure throws.
    // A $0 refund left nothing at Stripe to find, and asks for nothing.
    const prior = isNoChargeRefund
      ? null
      : await findPriorRefundForItems(
          { payments: deps.payments, logger, reportError: deps.reportError },
          {
            orderId: order.id,
            paymentIntentId: order.stripePaymentIntentId!,
            orderItemIds: allRefundable.map((item) => item.id),
            amountCents: totalRefundCents,
            useCase: "refundFullOrder",
          },
        );

    // ── Stripe refund — unless one already exists, or it returns $0 ────────
    // A $0 refund makes no processor call; it is named by a deterministic
    // internal id so a retry writes the same ledger keys.
    const refund = isNoChargeRefund
      ? {
          refundId: buildNoChargeRefundId(
            order.id,
            allRefundable.map((item) => item.id),
          ),
          status: "succeeded" as const,
        }
      : prior?.kind === "reuse"
        ? prior
        : await refundPaymentIntentOrDependencyFailed(
            deps.payments,
            {
              paymentIntentId: order.stripePaymentIntentId!,
              amountCents: totalRefundCents,
              reason: input.reason,
              idempotencyKey: `${idempotencyKey}:refund-payment-intent`,
              // Stripe reads a fee-withholding full refund as PARTIAL, so it
              // lands in the reconciler's partial arm — which needs these
              // ids to recover a refund whose tx below died after Stripe
              // accepted it. The pre-flight above reads the same stamp.
              metadata: buildRefundMetadata({
                useCase: "refundFullOrder",
                orderId: order.id,
                orderItemIds: allRefundable.map((item) => item.id),
                logger,
              }),
            },
            logger,
            {
              action: "refund_payment_intent",
              orderId: order.id,
              paymentIntentId: order.stripePaymentIntentId,
            },
          );
    const { refundId } = ensureSucceededRefund(refund);

    // Map each successful PRE-CUTOVER reversal's settlement → payee so the
    // ledger's TRANSFER_REVERSAL_CREDIT can be attributed inside the tx
    // below. Read OUTSIDE the tx (pure lookup, no mutation). Ledger-era
    // reversals carry `payeeId` directly (settlementId null) and need no
    // lookup.
    let reversalPayeeBySettlementId = new Map<string, string>();
    if (reversalResults.length > 0) {
      const settlementIds = [
        ...new Set(
          reversalResults
            .map((r) => r.settlementId)
            .filter((id): id is string => id !== null),
        ),
      ];
      if (settlementIds.length > 0) {
        const reversedSettlements =
          await deps.repos.settlements.getByIds(settlementIds);
        reversalPayeeBySettlementId = new Map(
          reversedSettlements.map((s) => [s.id, s.payeeId]),
        );
      }
    }

    const now = deps.clock.now();

    // Determine order status: REFUNDED if every ticket item is now terminal
    // (refunded or transferred), PART_REFUNDED if any remain active.
    const refundedIds = new Set(allRefundable.map((i) => i.id));
    const allTerminal = ticketItems.every(
      (i) =>
        refundedIds.has(i.id) ||
        i.status === "refunded" ||
        i.status === "transferred",
    );
    const newOrderStatus = allTerminal ? "REFUNDED" : "PART_REFUNDED";

    await deps.repos.tx(async (tx) => {
      /** Seats returned to the pool by this refund (audit trail). */
      let releasedSeatIds: string[] = [];
      /** Voided tickets that had admitted someone: they left (audit trail). */
      let leftOnRefund: TicketLeavingOnRefund[] = [];

      const fresh = await tx.orders.getById(order.id);
      if (!fresh) throw fail("ORDER_NOT_FOUND");
      if (fresh.status === "REFUNDED" || fresh.status === "PART_REFUNDED") {
        throw fail("ORDER_ALREADY_REFUNDED");
      }

      // `classifyRefundItem` judged these items OUTSIDE this transaction, and
      // Stripe has already moved the money. Anything that left "active" in
      // between (a gift, an email claim) raced us and won. We still mark it
      // refunded — that is what actually happened — but an operator has to
      // know somebody was handed a pass for a ticket that was simultaneously
      // refunded. Reports, never throws.
      reportRacedRefundItems({
        useCase: "refundFullOrder",
        orderId: order.id,
        refundedItemIds: allRefundable.map((item) => item.id),
        freshItems: fresh.items,
        logger,
        reportError: deps.reportError,
      });

      // Mark each refundable order item as refunded, recording the tax portion
      // of the refund it just received. Skipped items are stamped nothing —
      // their tax was not refunded.
      for (const item of allRefundable) {
        await tx.orderItems.updateStatus(
          item.id,
          "refunded",
          now,
          allocatedTaxByItem.get(item.id) ?? 0,
          // `?? null`: an item the share map does not know stays "not
          // attributed" — never a fabricated 0.
          allocatedPlatformFeeByItem.get(item.id) ?? null,
        );
      }

      await tx.orders.markRefunded(
        order.id,
        allTerminal ? undefined : totalRefundCents,
      );

      // Give the allowance back only when the whole order is gone. On a partial
      // refund the waived tickets may well be the ones the buyer kept, and we
      // have no per-ticket link from a redemption back to an order item — so
      // returning a slice would be a guess. Full refund only.
      if (allTerminal) {
        await tx.feeWaivers.release(order.id);
      }

      if (order.source === "RESALE") {
        const unwound = await unwindResaleOrderAfterRefund(tx, {
          order,
          clock: deps.clock,
          logger,
          reportError: deps.reportError,
        });
        relistNotices = unwound.relistNotices;
      } else {
        // Mark this order's tickets REFUNDED (only VALID/SCANNED), skipping
        // the tickets of items this refund kept (`keptTicketIds`): a buyer's
        // scanned or paid-out ticket whose item was NOT refunded, and a
        // gifted ticket now owned by somebody else, must not be killed. Same
        // rule as `markOrderTicketsRefunded`, plus the exclusion.
        const tickets = await tx.tickets.listByOrderId(order.id);
        const voided = tickets.filter(
          (ticket) =>
            !keptTicketIds.has(ticket.id) &&
            (ticket.status === "VALID" || ticket.status === "SCANNED"),
        );
        // Taken BEFORE the write below, which clears `scannedAt`.
        leftOnRefund = ticketsLeavingOnRefund(voided);
        await Promise.all(
          voided.map(async (ticket) => {
            await tx.tickets.setStatus(ticket.id, "REFUNDED", {
              scannedAt: null,
            });
          }),
        );

        // Reserved seats of the tickets we JUST killed go back on sale. Only
        // those: a kept ticket is still a live pass and keeps its seat.
        releasedSeatIds = await releaseSeatsForVoidedTickets(tx, voided, now);
      }

      // ── The one refund rule (spec §4): always write the REFUND_DEBIT ─────
      // The debit replaces the deleted settlement cancellation (both the old
      // resale-only `cancelForOrder` AND the non-resale gap that used to leak
      // pre-payout refunds — settlement-cancellation-granularity spec). Full
      // refund = the full credit comes back; transferred-but-kept items make
      // it partial (their revenue stays with the payee).
      const attemptedFullRefund = ticketItems.every(
        (i) =>
          refundedIds.has(i.id) ||
          i.status === "refunded" ||
          Boolean(i.refundedAt),
      );
      const refundDebits = await writeRefundDebitsForOrder(tx, {
        order: { id: order.id, currency: order.currency },
        refundedItemIds: allRefundable.map((i) => i.id),
        refundKey: refundId,
        attemptedFullRefund,
        useCase: "refundFullOrder",
        logger,
        reportError: deps.reportError,
      });

      // Spec §4.2: reversal SUCCEEDED (we're past reverseTransfersForItems)
      // → the money came back externally, so credit it back against the
      // debit; net zero. On reversal FAILURE we never get here — the throw
      // above aborts the refund, and when it is retried without the money
      // coming back the debit simply stands as debt.
      const reversalCredits = await writeTransferReversalCreditsForOrder(tx, {
        order: { id: order.id, currency: order.currency },
        refundKey: refundId,
        reversals: groupReversalsByPayee(
          reversalResults,
          reversalPayeeBySettlementId,
          {
            useCase: "refundFullOrder",
            orderId: order.id,
            logger,
            reportError: deps.reportError,
          },
        ),
        debits: refundDebits,
        useCase: "refundFullOrder",
        logger,
        reportError: deps.reportError,
      });

      // Release promo holds so the promo usage count is freed and the
      // buyer (or others) can reuse the promo code.
      await tx.promos.releaseHoldsForOrder(order.id);

      await tx.audit.log({
        entity: "order",
        entityId: order.id,
        action: "refunded",
        data: {
          refundId,
          // False when the refund returned $0: no Stripe refund exists and
          // `refundId` is an internal id (`_shared/no-charge-refund.ts`).
          moneyMoved: !isNoChargeRefund,
          paymentIntentId: order.stripePaymentIntentId,
          amountPaidCents: orderTotalPaidCents,
          stripeFeeCents: refundableStripeFeeCents,
          refundedCents: totalRefundCents,
          refundedItems,
          refundedTaxByItem: allRefundable.map((item) => ({
            orderItemId: item.id,
            refundedTaxCents: allocatedTaxByItem.get(item.id) ?? 0,
          })),
          skippedItems: skipped,
          transferReversals:
            reversalResults.length > 0 ? reversalResults : undefined,
          ledgerRefundDebits: refundDebits,
          ledgerReversalCredits:
            reversalCredits.length > 0 ? reversalCredits : undefined,
          newOrderStatus,
          reason: input.reason ?? null,
          releasedSeatIds:
            releasedSeatIds.length > 0 ? releasedSeatIds : undefined,
          // Scanned-in tickets this refund voided: the person left.
          ...leftOnRefundAuditData(leftOnRefund),
        },
        at: now,
      });
    });

    rawRefundFullOrderOutput = {
      ok: true,
      orderId: order.id,
      refundId,
      currency: order.currency,
      amountPaidCents: orderTotalPaidCents,
      stripeFeeCents: refundableStripeFeeCents,
      refundedCents: totalRefundCents,
      refundedItems,
      skippedItems: skipped,
      newOrderStatus,
    };

  } catch (error) {
    // Release, not `fail`: the adapters keep a `failed` record for 15
    // minutes and refuse `begin` while it lives, which would lock the staff /
    // buyer retry out (lib/idempotency-claim.ts). A same-key retry is safe:
    // it reuses the stable `${idempotencyKey}:refund-payment-intent` and
    // `:reverse-transfer` Stripe keys, and `findPriorRefundForItems` reuses a
    // refund an earlier attempt already made, so nothing is paid twice.
    await abandonClaim(deps.idempotency, idempotencyKey, claimOwnerToken, error, {
      useCase: "refundFullOrder",
      logger,
      reportError: deps.reportError,
    });
    throw asKnownError("refund_full_order", error);
  }

  // Outside the abandon path by construction: the refund and its tx have
  // committed. The parse keeps the error shape it had inside the attempt.
  let result: RefundFullOrderOutput;
  try {
    result = refundFullOrderOutputSchema.parse(rawRefundFullOrderOutput);
  } catch (error) {
    throw asKnownError("refund_full_order", error);
  }

  // Outside the abandon path: the refund and its tx have committed, so a
  // `commit` that throws leaves the claim standing until its TTL rather than
  // freeing the key for a retry that would redo committed work.
  await deps.idempotency.commit<StoredRefundFullOrderRecord>(idempotencyKey, {
    response: result,
  });

  // ── Buyer in-app refund confirmation (fire-and-forget) ────────────
  // Fires for self-serve AND staff-delegated full refunds (staffRefundOrder
  // delegates here, so it must NOT add its own notify call — that would
  // double-fire). The durable once-per-refund guard is the use-case
  // idempotency record (replays return early above). Keyed on the shared
  // refundId (order-refund:${refundId}) so the same refund can't notify
  // twice across the refund paths. Guest / POS_WALKUP buyers are skipped
  // inside notifyBuyer. The refund email is sent elsewhere, so this emits
  // in-app (+ push) only.
  const event = await deps.repos.events
    .getById(requireTicketingEventId(order))
    .catch(() => null);
  await notifyBuyer(
    {
      repos: deps.repos,
      notify: deps.notify,
      logger,
      reportError: deps.reportError,
    },
    {
      buyerHumanId: order.buyerHumanId,
      variant: "order.refund-processed",
      payload: {
        orderId: order.id,
        refundId: result.refundId,
        eventId: order.eventId,
        eventTitle: event?.title ?? null,
        amountCents: result.refundedCents,
        currency: order.currency,
        status: result.newOrderStatus,
        // Read by the no-money copy ("Your ticket(s) ... returned"), which
        // the renderer uses when `amountCents` is 0.
        ticketCount: result.refundedItems.length,
      },
      idempotencyKey: `order-refund:${result.refundId}`,
    },
  );

  // A seller whose listing the unwind closed (priced under the removed
  // markup split): told after the commit, best effort, never throws.
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

  return result;
}

// ── Helpers ───────────────────────────────────────────────────────────────

type SkippedReason = RefundItemIneligibleReason;

/**
 * The order-state gates every full-order refund runs before touching money:
 * paid, not already refunded, SUCCEEDED, and no primary-order item whose
 * transfer is linked to a resale listing (manual review). Pure; the buyer
 * path runs it before the idempotency claim (a refusal is not an attempt)
 * and the staff path inside it, so both see the same precedence.
 * `quoteFullRefund` runs it too, so the preview refuses what the refund
 * would refuse.
 */
export function assertOrderInRefundableState(order: OrderRecord): void {
  if (!order.stripePaymentIntentId) {
    throw fail("ORDER_NOT_PAID");
  }

  if (order.status === "REFUNDED" || order.status === "PART_REFUNDED") {
    throw fail("ORDER_ALREADY_REFUNDED");
  }

  if (order.status !== "SUCCEEDED") {
    throw fail("ORDER_NOT_REFUNDABLE");
  }

  const resaleLinkedTransferredItemIds =
    getPrimaryResaleLinkedTransferredTicketItemIds(order);
  if (resaleLinkedTransferredItemIds.length > 0) {
    throw {
      code: "conflict",
      message: "primary_order_resale_linked_transfer_requires_manual_review",
      orderItemIds: resaleLinkedTransferredItemIds,
    } as const;
  }
}

/**
 * A buyer's full-refund request is refused while a resale claim's refund is
 * pending on the order: the claim was approved (committed BEFORE Stripe runs)
 * and the order has not reached REFUNDED. The order is SUCCEEDED here (the
 * state gate ran first), so an approved claim is exactly that case; once the
 * refund lands the order is REFUNDED and the state gate refuses instead.
 * Derived from the claim rows, never a stored flag. Only a RESALE order can
 * carry a claim.
 */
export async function assertNoPendingClaimRefund(
  repos: Pick<Repos, "claims">,
  order: Pick<OrderRecord, "source" | "items">,
): Promise<void> {
  if (await hasPendingClaimRefund(repos, order)) {
    throw fail("CLAIM_REFUND_PENDING");
  }
}

/**
 * The read behind `assertNoPendingClaimRefund`, for callers that report the
 * gate instead of throwing it (`getRefundEligibility`). Same rule: a RESALE
 * order with an approved claim on any ticket item. The caller must already
 * have established the order is not REFUNDED: `assertOrderInRefundableState`
 * in the refund and the quote, and `getRefundEligibility`'s own status
 * returns (`already_refunded` / `order_not_paid`) before it calls this.
 */
export async function hasPendingClaimRefund(
  repos: Pick<Repos, "claims">,
  order: Pick<OrderRecord, "source" | "items">,
): Promise<boolean> {
  if (order.source !== "RESALE") return false;
  for (const item of order.items) {
    if (item.kind !== "ticket") continue;
    const claim = await repos.claims.getByOrderItemId(item.id);
    if (claim?.status === "approved") return true;
  }
  return false;
}

export type ClassifiedTicketItems = {
  /** Every ticket item on the order, in order — the allocation basis. */
  ticketItems: OrderItemRecord[];
  /** Each ticket item's ticket row (null when it has none). */
  ticketByItemId: ReadonlyMap<string, TicketRecord | null>;
  refundable: OrderItemRecord[];
  /** Items that require a transfer reversal before the refund (funds already paid out). */
  requiresReversal: OrderItemRecord[];
  skipped: Array<{ orderItemId: string; reason: SkippedReason }>;
};

/**
 * Reads each ticket item's ticket (LISTED and SCANNED live on the ticket
 * row — one read per ticket item on the order) and splits the items into
 * refundable / needs-reversal / skipped using the SAME rule as
 * `quoteItemRefund` (`classifyRefundItem`), so no refund path can disagree
 * about what a buyer may take back. `refundFullOrder` executes from this;
 * `quoteFullRefund` previews from it.
 */
export async function loadAndClassifyTicketItems(
  deps: { repos: Pick<Repos, "tickets"> },
  order: Pick<OrderRecord, "items" | "source">,
  ctx: { buyerInitiated: boolean },
): Promise<ClassifiedTicketItems> {
  const ticketItems = order.items.filter((i) => i.kind === "ticket");
  const ticketByItemId = new Map<string, TicketRecord | null>();
  for (const item of ticketItems) {
    ticketByItemId.set(
      item.id,
      await deps.repos.tickets.getByOrderItemId(item.id),
    );
  }

  const refundable: OrderItemRecord[] = [];
  const requiresReversal: OrderItemRecord[] = [];
  const skipped: Array<{ orderItemId: string; reason: SkippedReason }> = [];

  for (const item of ticketItems) {
    const verdict = classifyRefundItem({
      item,
      ticket: ticketByItemId.get(item.id) ?? null,
      orderSource: order.source,
      buyerInitiated: ctx.buyerInitiated,
    });
    if (verdict.ineligibleReason) {
      skipped.push({ orderItemId: item.id, reason: verdict.ineligibleReason });
    } else if (verdict.requiresTransferReversal) {
      // Paid-out items are refundable but require a transfer reversal first
      requiresReversal.push(item);
    } else {
      refundable.push(item);
    }
  }

  return { ticketItems, ticketByItemId, refundable, requiresReversal, skipped };
}

/**
 * The full-order refund's per-item money: the tax-inclusive buyer-paid total
 * and the order's actual Stripe fee, each allocated across ALL ticket items
 * (`allocateProportionalCents`, weights = `refundWeightCents`: buyer-paid, 0
 * for a ticket a discount brought down to $0, so shares are stable regardless
 * of which items turn out refundable). An item's net
 * refund is `max(0, buyerPaid − stripeFee)`. The whole-order refund is Σ of
 * that over the refundable items — `refundFullOrder` pays it and
 * `quoteFullRefund` previews it from this same function.
 *
 * `perLinePaidByItem`: on an order whose tax is split per PLATFORM line
 * (`allocateRefundTaxSharesForOrder(...).perLinePaidByItem`, non-null only
 * there), the tax-inclusive paid amount per item is `base + per-line tax
 * share` instead of the buyer-paid split, so this path pays exactly what the
 * item path pays and the tax stamp is the tax term of that money. Null or
 * absent → the buyer-paid split, unchanged.
 */
export function allocateFullRefundShares(
  ticketItems: OrderItemRecord[],
  orderTotalPaidCents: number,
  orderStripeFeeCents: number,
  perLinePaidByItem?: ReadonlyMap<string, number> | null,
): {
  buyerPaidByItem: ReadonlyMap<string, number>;
  stripeFeeByItem: ReadonlyMap<string, number>;
  netRefundCentsForItem: (orderItemId: string) => number;
} {
  const buyerPaidByItem =
    perLinePaidByItem ??
    allocateProportionalCents(ticketItems, orderTotalPaidCents, (item) =>
      refundWeightCents(item),
    );
  const stripeFeeByItem = allocateRefundFeeShares(
    ticketItems,
    orderStripeFeeCents,
  );
  return {
    buyerPaidByItem,
    stripeFeeByItem,
    netRefundCentsForItem: (orderItemId) =>
      Math.max(
        0,
        (buyerPaidByItem.get(orderItemId) ?? 0) -
          (stripeFeeByItem.get(orderItemId) ?? 0),
      ),
  };
}

function getPrimaryResaleLinkedTransferredTicketItemIds(order: {
  source: string;
  items: OrderItemRecord[];
}): string[] {
  if (order.source !== "PRIMARY") {
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

      return Boolean(
        item.resaleListingId ?? getMetaString(item.meta, "resaleListingId"),
      );
    })
    .map((item) => item.id);
}

function buildRefundFullOrderIdempotencyKey(orderId: string): string {
  return `order:refund-full:${orderId}`;
}
