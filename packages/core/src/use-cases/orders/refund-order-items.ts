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
import type { TicketRecord } from "@th/ports/repos/tickets";
import type { ReporterPort } from "@th/ports/reporter";
import { stripeRefundReasonSchema } from "@th/schema";

import { asKnownError } from "../../lib/errors";
import { abandonClaim } from "../../lib/idempotency-claim";
import { parseInput } from "../../lib/io";
import {
  assertBuyerRefundWindowOpen,
  quoteItemRefund,
} from "./quote-item-refund";
import { reverseTransfersForItems } from "./reverse-transfers-for-items";
import {
  groupReversalsByPayee,
  writeRefundDebitsForOrder,
  writeTransferReversalCreditsForOrder,
} from "./_shared/write-refund-debits";
import { notifyBuyer, type NotifyFn } from "./notify-buyer";
import { fail } from "@th/errors";
import { requireTicketingEventId } from "./_shared/require-ticketing-order";
import { withOrderRefundMutex } from "./_shared/refund-mutex";
import {
  assertOrderNotDisputeBlocked,
  buildRefundMetadata,
  refundPaymentIntentOrDependencyFailed,
} from "./_shared/dispute-refund-guard";
import { buildNoChargeRefundId } from "./_shared/no-charge-refund";
import { findPriorRefundForItems } from "./_shared/prior-refund-preflight";
import { reportRacedRefundItems } from "./_shared/report-raced-refund-items";
import { refundOrderItemIdsSchema } from "./_shared/refund-item-ids";
import { allocateRefundPlatformFeeShares } from "./_shared/refund-platform-fee-share";
import { releaseSeatsForVoidedTickets } from "./_shared/release-seats-for-voided-tickets";
import {
  leftOnRefundAuditData,
  ticketsLeavingOnRefund,
  type TicketLeavingOnRefund,
} from "./_shared/tickets-leaving-on-refund";

export const refundOrderItemsInputSchema = z.object({
  actorHumanId: z.uuid(),
  orderId: z.uuid(),
  /** Specific order item IDs to refund. Each must belong to the order; no repeats. */
  orderItemIds: refundOrderItemIdsSchema,
  reason: stripeRefundReasonSchema.optional(),
});

const refundedItemSchema = z.object({
  orderItemId: z.uuid(),
  refundedCents: z.number().int().nonnegative(),
});

export const refundOrderItemsOutputSchema = z.object({
  ok: z.literal(true),
  orderId: z.uuid(),
  refundId: z.string().min(3),
  currency: z.string().min(3).max(3),
  totalRefundedCents: z.number().int().nonnegative(),
  items: z.array(refundedItemSchema),
  /** "PART_REFUNDED" when some items remain active, "REFUNDED" when all items are now refunded. */
  newOrderStatus: z.enum(["PART_REFUNDED", "REFUNDED"]),
});

export type RefundOrderItemsInput = z.infer<typeof refundOrderItemsInputSchema>;
export type RefundOrderItemsOutput = z.infer<
  typeof refundOrderItemsOutputSchema
>;

export type RefundOrderItemsDeps = {
  repos: Repos;
  payments: PaymentProcessorPort;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Best-effort Sentry reporter for the refund-debit swallow branches
   * (missing pre-cutover credits, attribution drift). Wire from
   * `ctx.reportError`; a throwing reporter never changes behaviour.
   */
  reportError?: ReporterPort | null;
  /**
   * Multi-channel notification dispatcher. Optional — when present the buyer
   * receives a fire-and-forget in-app (+ push) refund confirmation after the
   * refund is durably committed. A notify outage never fails the refund.
   */
  notify?: NotifyFn;
  /**
   * When true, the buyer-ownership guard is skipped (and forwarded to the
   * delegated quoteItemRefund). Only set this from internal callers that
   * perform their own authz (e.g., orgRefundOrderItems, which validates
   * org-finance roles + org ownership before delegating). It is intentionally
   * NOT part of the input schema so buyer-facing tRPC clients can never
   * toggle it.
   */
  _skipBuyerCheck?: boolean;
  /**
   * Optional idempotency-key override. Internal callers that authorize
   * differently (e.g., org-finance refunds) pass a DISTINCT key so their
   * refund idempotency records never collide with the buyer/staff keyspace.
   * When omitted, the default buyer key
   * (`order:refund-items:${orderId}:${actorHumanId}:...`) is used.
   */
  _idempotencyKey?: string;
};

const IDEMPOTENCY_TTL_SECONDS = 300;

interface StoredRefundOrderItemsRecord {
  response: RefundOrderItemsOutput;
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

/**
 * Refunds specific order items (individual tickets) within an order.
 *
 * Flow:
 * 1. Quote the refund for the requested items (validates everything).
 * 2. Reverse the transfer of any paid-out item, then issue a partial Stripe
 *    refund for the total refundable amount. When that amount is $0 (a
 *    ticket that cost $0), no refund call is made and the rest of the flow
 *    runs unchanged, the reversal included.
 * 3. Within a transaction:
 *    a. Mark each item as "refunded" with refundedAt timestamp.
 *    b. Mark associated tickets as REFUNDED.
 *    c. Update order status: REFUNDED if all ticket items are now refunded,
 *       otherwise PART_REFUNDED.
 *    d. Write audit log.
 */
export async function refundOrderItems(
  deps: RefundOrderItemsDeps,
  rawInput: unknown,
): Promise<RefundOrderItemsOutput> {
  const logger = deps.logger?.child({ useCase: "refundOrderItems" });
  const input = parseInput(refundOrderItemsInputSchema, rawInput);

  const actor = await deps.repos.humans.getById(input.actorHumanId);
  if (!actor) {
    throw fail("ACTOR_NOT_FOUND");
  }

  // Per-order single-flight mutex: serializes this item refund against EVERY
  // other refund-creating path on the same order (full-order refunds, org
  // refunds via _idempotencyKey, event cancellation, resale-claim refunds),
  // whose Stripe idempotency keys live in disjoint namespaces and so dedupe
  // nothing across paths. The order (and, via quoteItemRefund, item
  // eligibility) is loaded INSIDE the held section so pre-checks can't act on
  // a snapshot taken before a competing refund's commit.
  // See ./_shared/refund-mutex.ts for the acquire/release semantics.
  return withOrderRefundMutex(deps, input.orderId, () =>
    executeRefundOrderItems(deps, input, logger),
  );
}

/** The item-refund body; runs while holding the per-order refund mutex. */
async function executeRefundOrderItems(
  deps: RefundOrderItemsDeps,
  input: RefundOrderItemsInput,
  logger: LoggerPort | undefined,
): Promise<RefundOrderItemsOutput> {
  const order = await deps.repos.orders.getById(input.orderId);
  if (!order) {
    throw fail("ORDER_NOT_FOUND");
  }

  // Internal callers (org-finance flows) bypass this after their own authz.
  if (!deps._skipBuyerCheck && order.buyerHumanId !== input.actorHumanId) {
    throw fail("ORDER_NOT_FOUND");
  }

  const idempotencyKey =
    deps._idempotencyKey ??
    buildRefundOrderItemsIdempotencyKey({
      actorHumanId: input.actorHumanId,
      orderId: order.id,
      orderItemIds: input.orderItemIds,
    });
  const replay =
    await deps.idempotency.get<StoredRefundOrderItemsRecord>(idempotencyKey);
  if (replay) {
    return refundOrderItemsOutputSchema.parse(replay.response);
  }

  // ── Dispute guard ────────────────────────────────────────────────────────
  // After the replay lookup and BEFORE the idempotency claim (a refusal is
  // not an attempt and must not leave a `failed:` marker that blocks a retry
  // once the dispute closes), and before the quote — which already reaches
  // Stripe for the processing fee. No external call, no ledger write.
  assertOrderNotDisputeBlocked(order);

  // ── Wrong entry point: resale orders refund WHOLE ────────────────────────
  // A resale order is single-item and its refund must unwind the listing
  // (restore the seller's ticket, reverse the seller credit) — which only
  // `refundFullOrder` does. Refusing here, before `begin`, means no
  // `failed:` marker is left on the item-refund key. `quoteItemRefund`
  // refuses too (it is also a standalone tRPC query); this one lands first.
  if (order.source === "RESALE") {
    throw fail("RESALE_ORDER_USE_FULL_REFUND");
  }

  // ── Buyer-only policy gates ──────────────────────────────────────────────
  // Same position and for the same reason as the dispute guard: a policy
  // refusal is not an attempt. `quoteItemRefund` re-checks both below (it is
  // also a standalone tRPC query), but by then the key is claimed, so the
  // refusal must land here first. Staff/org callers bypass via
  // `_skipBuyerCheck`, exactly as in refund-full-order.
  if (!deps._skipBuyerCheck) {
    if (order.nonRefundable) {
      throw fail("ORDER_NON_REFUNDABLE");
    }
    const event = await deps.repos.events.getById(
      requireTicketingEventId(order),
    );
    if (!event) {
      throw fail("EVENT_NOT_FOUND");
    }
    assertBuyerRefundWindowOpen(event, deps.clock.now());
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
      await deps.idempotency.get<StoredRefundOrderItemsRecord>(idempotencyKey);
    if (afterWait) {
      return refundOrderItemsOutputSchema.parse(afterWait.response);
    }

    throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
  }

  /** Built inside the attempt, parsed after it (outside the abandon path). */
  let rawRefundOrderItemsOutput: unknown;
  try {
    // 1. Get the quote (validates order, items, eligibility, computes amounts)
    const quote = await quoteItemRefund(
      {
        repos: deps.repos,
        payments: deps.payments,
        clock: deps.clock,
        logger,
        reportError: deps.reportError,
        _skipBuyerCheck: deps._skipBuyerCheck,
      },
      {
        actorHumanId: input.actorHumanId,
        orderId: input.orderId,
        orderItemIds: input.orderItemIds,
      },
    );

    // Check that all requested items are eligible
    const ineligible = quote.items.filter((q) => !q.isEligible);
    if (ineligible.length > 0) {
      throw {
        code: "conflict",
        message: "items_not_refundable",
        ineligibleItems: ineligible.map((q) => ({
          orderItemId: q.orderItemId,
          reason: q.ineligibleReason,
        })),
      } as const;
    }

    // A refund that returns $0 (a ticket that cost $0: owner ruling
    // 2026-10-11) still runs: the items and tickets are marked, seats come
    // back, the order status moves and the audit row is written below. It
    // makes no REFUND call: Stripe rejects a refund of amount 0. See
    // `_shared/no-charge-refund.ts`.
    const isNoChargeRefund = quote.totalRefundableCents <= 0;

    // 2. Reverse transfers for any paid-out items before issuing the buyer refund.
    //    This pulls funds back from the connected account to the platform so the
    //    platform isn't subsidizing the refund.
    //
    //    Not skipped on a $0 refund. Whether there is money to pull back
    //    depends on what the PAYEE was paid for the item, not on what the
    //    buyer gets: a paid-out ticket so cheap that its refund clamps to $0
    //    still earned the payee its share, and that comes back whether the
    //    ticket is refunded alone or beside a sibling. A ticket a discount
    //    brought down to $0 has no share in the credit attribution
    //    (`createCreditsFromOrder`), is never in a payout plan, is never
    //    stamped `paidOutAt`, and so never reaches this list.
    const paidOutItemIds = quote.items
      .filter((q) => q.isEligible && q.requiresTransferReversal)
      .map((q) => q.orderItemId);

    let reversalResults: Awaited<ReturnType<typeof reverseTransfersForItems>> =
      [];
    if (paidOutItemIds.length > 0) {
      reversalResults = await reverseTransfersForItems(
        {
          repos: deps.repos,
          payments: deps.payments,
          logger,
          reportError: deps.reportError,
        },
        {
          orderItemIds: paidOutItemIds,
          // Each item's reversal amount is its refundable portion
          itemAmounts: new Map(
            quote.items
              .filter((q) => q.isEligible && q.requiresTransferReversal)
              .map((q) => [q.orderItemId, q.refundableCents]),
          ),
          idempotencyKeyPrefix: `${idempotencyKey}:reverse-transfer`,
        },
      );
    }

    // 3. Retry pre-flight (money audit 2026-09-08 #10, second layer): a
    //    prior attempt whose tx below died left its refund at Stripe naming
    //    exactly these items. Under THIS key Stripe would dedupe the call;
    //    under a different one (org namespace, new client request) it would
    //    pay them again — so find and reuse it. A listing failure throws.
    //    A $0 refund left nothing at Stripe to find, and asks for nothing.
    const prior = isNoChargeRefund
      ? null
      : await findPriorRefundForItems(
          { payments: deps.payments, logger, reportError: deps.reportError },
          {
            orderId: order.id,
            paymentIntentId: order.stripePaymentIntentId!,
            orderItemIds: quote.items.map((q) => q.orderItemId),
            amountCents: quote.totalRefundableCents,
            useCase: "refundOrderItems",
          },
        );

    // 4. Issue the Stripe refund (partial) — unless one already exists, or
    //    the refund returns $0 (no processor call; the refund is named by a
    //    deterministic internal id so a retry writes the same ledger keys).
    const refund = isNoChargeRefund
      ? {
          refundId: buildNoChargeRefundId(
            order.id,
            quote.items.map((q) => q.orderItemId),
          ),
          status: "succeeded" as const,
        }
      : prior?.kind === "reuse"
        ? prior
        : await refundPaymentIntentOrDependencyFailed(
            deps.payments,
            {
              paymentIntentId: order.stripePaymentIntentId!,
              amountCents: quote.totalRefundableCents,
              reason: input.reason,
              idempotencyKey: `${idempotencyKey}:refund-payment-intent`,
              // Name the items on the refund itself: if the tx below dies
              // after Stripe accepted this, the charge.refunded reconciler
              // flips exactly these items so no later key can quote them
              // `active` again — and the pre-flight above finds it first.
              metadata: buildRefundMetadata({
                useCase: "refundOrderItems",
                orderId: order.id,
                orderItemIds: quote.items.map((q) => q.orderItemId),
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
    // below. Ledger-era reversals carry `payeeId` directly (settlementId
    // null) and need no lookup.
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

    // The PLATFORM-FEE portion of each item's refund, stamped beside the tax
    // portion below. Allocated over EVERY ticket item on the order, not only
    // the ones refunded now, so stamps across separate partial refunds sum to
    // `feesPlatformCents` exactly once (`_shared/refund-platform-fee-share.ts`).
    const platformFeeShareByItem = allocateRefundPlatformFeeShares(
      order.items.filter((item) => item.kind === "ticket"),
      order.feesPlatformCents,
    );

    // 3. Transaction: mark items refunded, update tickets, update order status
    const result = await deps.repos.tx(async (tx) => {
      // Re-read order inside tx for freshness
      const fresh = await tx.orders.getById(order.id);
      if (!fresh) throw fail("ORDER_NOT_FOUND");

      // The quote classified these items as refundable OUTSIDE this
      // transaction, and Stripe has already moved the money. Anything that
      // left "active" in between (a gift, an email claim) raced us and won.
      // We still mark it refunded — that is what actually happened — but an
      // operator has to know somebody was handed a pass for a ticket that was
      // simultaneously refunded. Reports, never throws.
      reportRacedRefundItems({
        useCase: "refundOrderItems",
        orderId: order.id,
        refundedItemIds: quote.items.map((q) => q.orderItemId),
        freshItems: fresh.items,
        logger,
        reportError: deps.reportError,
      });

      // Mark each item as refunded, recording the TAX PORTION of the refund
      // that was just issued. `taxShareCents` comes straight off the quote
      // whose `totalRefundableCents` was the amount sent to Stripe above, so
      // what we record and what the buyer received cannot drift: there is one
      // computation, not two. NULL would mean "not attributed", so a
      // zero-tax order stamps 0 — a measured zero.
      for (const itemQuote of quote.items) {
        await tx.orderItems.updateStatus(
          itemQuote.orderItemId,
          "refunded",
          now,
          itemQuote.taxShareCents,
          // `?? null`: an item the share map does not know stays "not
          // attributed" — never a fabricated 0.
          platformFeeShareByItem.get(itemQuote.orderItemId) ?? null,
        );
      }

      // Mark associated tickets as REFUNDED.
      // Each OrderItem is 1:1 linked to a Ticket via orderItemId FK. SCANNED
      // is flipped too: only org/staff reach here with a scanned ticket (the
      // quote marks it `already_scanned` for buyers), and their refund of a
      // used ticket is deliberate.
      const refundedItemIds = new Set(quote.items.map((q) => q.orderItemId));

      const voidedTickets: TicketRecord[] = [];
      /** Voided tickets that had admitted someone: they left (audit trail). */
      const leftOnRefund: TicketLeavingOnRefund[] = [];
      for (const itemQuote of quote.items) {
        const ticket = await tx.tickets.getByOrderItemId(itemQuote.orderItemId);
        if (
          ticket &&
          (ticket.status === "VALID" || ticket.status === "SCANNED")
        ) {
          // Taken BEFORE the write below, which clears `scannedAt`.
          leftOnRefund.push(...ticketsLeavingOnRefund([ticket]));
          await tx.tickets.setStatus(ticket.id, "REFUNDED", {
            scannedAt: null,
          });
          voidedTickets.push(ticket);
        }
      }

      // Reserved seats of the tickets this refund just killed go back on
      // sale. This is a PARTIAL refund path, so it is scoped to the quoted
      // items only — a ticket the buyer kept is untouched above and keeps its
      // seat here.
      const releasedSeatIds = await releaseSeatsForVoidedTickets(
        tx,
        voidedTickets,
        now,
      );

      // Determine new order status: are all ticket items now refunded?
      const allOrderItems = await tx.orderItems.listByOrderId(order.id);
      const ticketItems = allOrderItems.filter((i) => i.kind === "ticket");
      const allTicketItemsRefunded = ticketItems.every(
        (i) => i.status === "refunded" || refundedItemIds.has(i.id),
      );

      const newOrderStatus = allTicketItemsRefunded
        ? "REFUNDED"
        : "PART_REFUNDED";
      // The second argument only selects PART_REFUNDED vs REFUNDED. A partial
      // refund of $0 passes 0, which the repo reads as partial (it tests for
      // `undefined`, not truthiness).
      await tx.orders.markRefunded(
        order.id,
        allTicketItemsRefunded ? undefined : quote.totalRefundableCents,
      );

      // Same rule as refund-full-order: allowance comes back only once every
      // ticket on the order is refunded. A redemption records a COUNT, not
      // which specific tickets were waived, so a partial release would be a
      // guess about tickets the buyer may still hold.
      if (allTicketItemsRefunded) {
        await tx.feeWaivers.release(order.id);
      }

      // ── The one refund rule (spec §4): always write the REFUND_DEBIT ─────
      // `allTicketItemsRefunded` is exactly the attempted-full-refund
      // predicate: transferred items keep their revenue and make it false.
      const refundDebits = await writeRefundDebitsForOrder(tx, {
        order: { id: order.id, currency: order.currency },
        refundedItemIds: quote.items.map((q) => q.orderItemId),
        refundKey: refundId,
        attemptedFullRefund: allTicketItemsRefunded,
        useCase: "refundOrderItems",
        logger,
        reportError: deps.reportError,
      });

      // Spec §4.2: successful reversals net the debit to zero — the money
      // came back externally. A failed reversal throws before the Stripe
      // refund above, so no debit exists to compensate in that case.
      const reversalCredits = await writeTransferReversalCreditsForOrder(tx, {
        order: { id: order.id, currency: order.currency },
        refundKey: refundId,
        reversals: groupReversalsByPayee(
          reversalResults,
          reversalPayeeBySettlementId,
          {
            useCase: "refundOrderItems",
            orderId: order.id,
            logger,
            reportError: deps.reportError,
          },
        ),
        debits: refundDebits,
        useCase: "refundOrderItems",
        logger,
        reportError: deps.reportError,
      });

      await tx.audit.log({
        entity: "order",
        entityId: order.id,
        action: "items_refunded",
        data: {
          refundId,
          // False when the refund returned $0: no Stripe refund exists and
          // `refundId` is an internal id (`_shared/no-charge-refund.ts`).
          moneyMoved: !isNoChargeRefund,
          paymentIntentId: order.stripePaymentIntentId,
          orderItemIds: input.orderItemIds,
          totalRefundedCents: quote.totalRefundableCents,
          itemBreakdown: quote.items.map((q) => ({
            orderItemId: q.orderItemId,
            buyerPaidCents: q.buyerPaidCents,
            stripeFeeShareCents: q.stripeFeeShareCents,
            taxShareCents: q.taxShareCents,
            refundedCents: q.refundableCents,
            requiresTransferReversal: q.requiresTransferReversal,
          })),
          transferReversals:
            reversalResults.length > 0 ? reversalResults : undefined,
          ledgerRefundDebits: refundDebits,
          ledgerReversalCredits:
            reversalCredits.length > 0 ? reversalCredits : undefined,
          reason: input.reason ?? null,
          newOrderStatus,
          releasedSeatIds:
            releasedSeatIds.length > 0 ? releasedSeatIds : undefined,
          // Scanned-in tickets this refund voided: the person left.
          ...leftOnRefundAuditData(leftOnRefund),
        },
        at: now,
      });

      return { newOrderStatus };
    });

    rawRefundOrderItemsOutput = {
      ok: true,
      orderId: order.id,
      refundId,
      currency: order.currency,
      totalRefundedCents: quote.totalRefundableCents,
      items: quote.items.map((q) => ({
        orderItemId: q.orderItemId,
        refundedCents: q.refundableCents,
      })),
      newOrderStatus: result.newOrderStatus,
    };

  } catch (error) {
    // Release, not `fail`: a `failed` record locks the same-key retry out for
    // 15 minutes (lib/idempotency-claim.ts). A same-key retry is safe: it
    // reuses the stable `:refund-payment-intent` / `:reverse-transfer` Stripe
    // keys, and `findPriorRefundForItems` reuses a refund an earlier attempt
    // already made, so nothing is paid twice.
    await abandonClaim(deps.idempotency, idempotencyKey, claimOwnerToken, error, {
      useCase: "refundOrderItems",
      logger,
      reportError: deps.reportError,
    });
    throw asKnownError("refund_order_items", error);
  }

  // Outside the abandon path by construction: the refund and its tx have
  // committed. The parse keeps the error shape it had inside the attempt.
  let output: RefundOrderItemsOutput;
  try {
    output = refundOrderItemsOutputSchema.parse(rawRefundOrderItemsOutput);
  } catch (error) {
    throw asKnownError("refund_order_items", error);
  }

  // Outside the abandon path: the refund and its tx have committed, so a
  // `commit` that throws leaves the claim standing until its TTL rather than
  // freeing the key for a retry that would redo committed work.
  await deps.idempotency.commit<StoredRefundOrderItemsRecord>(
    idempotencyKey,
    {
      response: output,
    },
  );

  // ── Buyer in-app refund confirmation (fire-and-forget) ────────────
  // The durable once-per-refund guard is the use-case idempotency record:
  // replays return early above before reaching here. The notify idempotency
  // key (order-refund:${refundId}) is only a best-effort backstop — its
  // Redis TTL is short (60s), so it can't be relied on across the three
  // refund paths for delivery separated by more than that; the shared
  // refundId keying is what actually prevents cross-path double-fire. Guest /
  // POS_WALKUP buyers are skipped inside notifyBuyer. A confirmation email is
  // handled elsewhere, so this emits in-app (+ push) only.
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
        refundId: output.refundId,
        eventId: order.eventId,
        eventTitle: event?.title ?? null,
        amountCents: output.totalRefundedCents,
        currency: order.currency,
        status: output.newOrderStatus,
        // Read by the no-money copy ("Your ticket(s) ... returned"), which
        // the renderer uses when `amountCents` is 0.
        ticketCount: output.items.length,
      },
      idempotencyKey: `order-refund:${output.refundId}`,
    },
  );

  return output;
}

function buildRefundOrderItemsIdempotencyKey(input: {
  actorHumanId: string;
  orderId: string;
  orderItemIds: string[];
}): string {
  return [
    "order:refund-items",
    input.orderId,
    input.actorHumanId,
    "items",
    ...[...input.orderItemIds].sort(),
  ].join(":");
}
