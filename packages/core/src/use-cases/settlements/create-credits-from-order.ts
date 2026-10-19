import { z } from "zod";

import type { Repos } from "@th/ports/repos";
import type { ClockPort } from "@th/ports/clock";
import { formatOrderCode } from "@th/types/order-identifier";
import { parseInput } from "../../lib/io";
import {
  applyAvailabilityFloor,
  computePayoutDate,
  type PayoutSchedule,
} from "../../lib/payout-scheduling";
import { fail } from "@th/errors";
import { refundFaceWeightCents } from "../../lib/orders/refund-weight";
import { resaleClaimWindowClosesAt } from "../../lib/resale-claim-window";
import { requireTicketingEventId } from "../orders/_shared/require-ticketing-order";

/**
 * Write SETTLEMENT_CREDIT ledger entries for a SUCCEEDED order — the
 * ledger-authoritative replacement for `createSettlementsFromOrder`
 * (ledger-authoritative-settlement spec §3).
 *
 * Per payee: ONE credit whose `amountCents` is the payee's summed OrderSplit,
 * matured at `availableAt` per the event's payout terms. The credit IS the
 * split, materialized; item-level attribution rides the entry's `metadata`
 * (`{ items: Record<orderItemId, contributionCents> }`) instead of an
 * `OrderItemSettlementLine` join table.
 *
 * Idempotency lives in the repo: `settlement-credit:${orderId}:${payeeId}` is
 * unique, and a replay returns the existing row without re-applying balance
 * effects — so this use case needs no IdempotencyPort and is safe to re-drive
 * (the recovery affordance behind `settlements.createFromOrder`).
 */

export const createCreditsFromOrderInputSchema = z
  .object({
    orderId: z.string().uuid(),
  })
  .strict();

export const createCreditsFromOrderOutputSchema = z
  .object({
    orderId: z.string().uuid(),
    credits: z.array(
      z.object({
        entryId: z.string().min(1),
        payeeId: z.string().uuid(),
        amountCents: z.number().int().positive(),
      }),
    ),
    /**
     * Payees whose summed split was 0 (or negative): they get NO credit — the
     * repo rejects `amountCents <= 0` by design, and a zero-amount entry would
     * be pure noise on the statement. Recorded on the audit row.
     */
    skippedZeroAmount: z.array(z.string().uuid()),
  })
  .strict();

export type CreateCreditsFromOrderInput = z.infer<
  typeof createCreditsFromOrderInputSchema
>;
export type CreateCreditsFromOrderOutput = z.infer<
  typeof createCreditsFromOrderOutputSchema
>;

export type CreateCreditsFromOrderDeps = {
  repos: Repos;
  clock: ClockPort;
  /** When true, credits mature immediately (dev/test only). */
  instantPayouts?: boolean;
};

/**
 * Distribute a payee's credit across order items proportionally by
 * `item.amountCents`, with the last item THAT WEIGHS ANYTHING taking the
 * rounding remainder. When the last item weighs more than 0 this is
 * byte-for-byte the math that populated `OrderItemSettlementLine`. Items
 * whose share rounds to 0 are omitted.
 *
 * An item that weighs 0 never gets a share, the remainder included. The
 * caller passes 0 for a ticket a discount brought down to $0
 * (`refundFaceWeightCents`); handing it the leftover cent would put it in the
 * payout plan and make its $0 refund debit the payee (the same reason
 * checkout's `feeRemainderItemIndex` skips fee-free tickets).
 *
 * Returns `{}` when there are no items or EVERY item weighs 0: there is
 * nothing to attribute against, so the credit carries no item attribution.
 * That is the behaviour this function always had for a zero item total.
 *
 * Exported for the membership-invoice path, which writes the same credit
 * shape for its single membership item.
 */
export function attributeCreditToItems(
  items: ReadonlyArray<{ id: string; amountCents: number }>,
  payeeAmountCents: number,
): Record<string, number> {
  const totalItemAmount = items.reduce((sum, item) => sum + item.amountCents, 0);
  if (items.length === 0 || totalItemAmount <= 0) return {};

  // The item that absorbs the rounding remainder: the last one with a weight
  // above 0. One exists, because the item total is above 0 here.
  let remainderIndex = items.length - 1;
  while (remainderIndex > 0 && items[remainderIndex]!.amountCents <= 0) {
    remainderIndex -= 1;
  }

  const contributions: Record<string, number> = {};
  let remainingCents = payeeAmountCents;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const isLast = i === remainderIndex;
    if (remainingCents <= 0) break;

    // For the remainder item, use the remaining amount to avoid rounding errors.
    // Non-last shares are CLAMPED to the remainder: unclamped Math.round can
    // overshoot on small amounts (e.g. items [1,1,1,1] with amount 2 rounds
    // each non-last share to 1 → Σ 3 ≠ 2), and this metadata is FROZEN on an
    // append-only ledger entry that Step C's partial-refund math reads —
    // Σ(items) === payeeAmountCents is a hard invariant, not a nicety.
    const itemShare = isLast
      ? remainingCents
      : Math.min(
          Math.round((item.amountCents / totalItemAmount) * payeeAmountCents),
          remainingCents,
        );

    if (itemShare > 0) {
      contributions[item.id] = itemShare;
      remainingCents -= itemShare;
    }
  }
  return contributions;
}

export async function createCreditsFromOrder(
  deps: CreateCreditsFromOrderDeps,
  rawInput: unknown,
): Promise<CreateCreditsFromOrderOutput> {
  const input = parseInput(createCreditsFromOrderInputSchema, rawInput);
  const { orderId } = input;

  const result = await deps.repos.tx(async (tx) => {
    const order = await tx.orders.getById(orderId);
    if (!order)
      throw fail("ORDER_NOT_FOUND");
    if (order.status !== "SUCCEEDED")
      throw {
        code: "invalid_input",
        message: "order_not_succeeded",
        status: order.status,
      } as const;
    // NO dispute-status guard here — deliberately (review finding, Step B).
    // The legacy use case refused disputed orders because a Settlement row,
    // once written, would pay out unless the batch's guards caught it. In
    // the ledger world the payable query is the SINGLE enforcement point
    // (spec §5): an OPEN/UNDER_REVIEW order's credit is excluded (or its
    // hold subtracts), and a LOST order's credit nets against the debit /
    // persisting hold. Blocking the WRITE instead re-creates the imbalance
    // the design exists to prevent: the dispute lifecycle writes holds and
    // debits from the SPLITS (which exist independently of the credit), so
    // refusing the credit on an operator re-drive would leave the payee
    // punished for revenue they were never credited — permanently, for
    // terminal LOST.

    // Get event for maturity-date calculation
    const event = await tx.events.getById(requireTicketingEventId(order));
    if (!event)
      throw fail("EVENT_NOT_FOUND");

    // Get the payout terms to determine the payout schedule
    const payoutTermsRef = event.payoutTermsId ?? event.agreementPrimaryId;
    if (!payoutTermsRef)
      throw fail("EVENT_MISSING_PAYOUT_TERMS");
    const payoutTerms = await tx.payoutTerms.getById(payoutTermsRef);
    if (!payoutTerms)
      throw fail("AGREEMENT_NOT_FOUND");

    const splits = await tx.splits.getForOrder(order.id);
    if (!splits.length)
      throw fail("NO_SPLITS_FOUND");

    // Item-level attribution basis: ticket items only, as before.
    const orderItems = await tx.orderItems.listByOrderId(order.id);
    const ticketItems = orderItems.filter((item) => item.kind === "ticket");
    // What each ticket weighs when the payee's credit is attributed to items:
    // its face price, or 0 for a ticket a discount brought down to $0
    // (`refundFaceWeightCents`). That ticket earned the payee nothing, so
    // refunding it must debit the payee nothing and reverse no transfer
    // (owner ruling 2026-10-11: a refund of a $0 ticket returns $0); the
    // REFUND_DEBIT and the transfer reversal both read this attribution. A
    // zero-WEIGHT item is left out of the map (`attributeCreditToItems` gives
    // it no share, not even the rounding remainder), so it is never in a
    // payout plan either. A ticket with a weight whose share rounds to 0 is
    // left out too. Credits written before this rule keep the attribution
    // they were frozen with.
    const attributionItems = ticketItems.map((item) => ({
      id: item.id,
      amountCents: refundFaceWeightCents(item),
    }));

    // Maturity: when the credit starts counting toward the payable balance.
    // Use startsAt if endsAt is not set (some events have no explicit end).
    const eventEndsAt = event.endsAt ?? event.startsAt;
    // The organiser's schedule says WHEN they want paying; Stripe's balance
    // availability says the EARLIEST that is physically possible. Take the
    // later of the two. `run-batch` transfers without `source_transaction`, so
    // it spends the platform's AVAILABLE balance — scheduling a Saturday door
    // sale for Monday's batch just buys a `balance_insufficient` failure, and
    // that failure arms a per-currency circuit breaker that fails the rest of
    // the night's payouts in that currency too.
    //
    // A MAX, not a blanket delay: advance sales are already scheduled far past
    // the floor and are untouched. Only late and door sales move.
    //
    // Basis for the floor is `clock.now()`, which IS the charge time on both
    // production writers — `finalizePaymentIntent` (the
    // `payment_intent.succeeded` webhook) and `createCheckout`'s
    // credit-covered branch both call this immediately after the payment
    // resolves. The operator re-drive (`settlements.createFromOrder`) runs
    // later, which only pushes the floor further out: conservative, never
    // early. Credit-covered orders move money that arrived with an earlier
    // charge and are already available, so their floor is pure (small)
    // conservatism.
    //
    // The floor is flat for every payment method, including ACH — see
    // `computeAvailabilityFloor` for why an ACH branch would double-count
    // Stripe's T+4-from-creation window (and why reading
    // `order.paymentMethodType` here would be racy).
    const scheduledAvailableAt = deps.instantPayouts
      ? deps.clock.now() // Dev/test: immediately eligible for the batch runner
      : applyAvailabilityFloor(
          computePayoutDate(
            eventEndsAt,
            payoutTerms.payoutSchedule as PayoutSchedule,
          ),
          deps.clock.now(),
        );

    // Resale claim window. The buyer of a resold ticket can file a claim
    // until the listing's `resalePayoutReleaseAt` (stamped onto the RESALE
    // order's ticket items by `createResaleCheckout`), and EVERY payee
    // credited from the order is held until that window closes — the RESALE
    // terms lines (creator royalty and whoever else the org put on them),
    // not only a seller. An approved claim's unwind (`review-claim`) writes a
    // refund debit against all of them, so any one paid out early would need
    // a Stripe transfer reversal instead of a plain debit. So maturity is the
    // LATER of the schedule date and the claim-window close.
    //
    // Not retroactive: the credit's idempotency key returns the existing row
    // on replay, so credits minted before this gate keep their early
    // `availableAt`, and the transfer-reversal branch in `review-claim`
    // stays load-bearing for them. Do not weaken it on the strength of this.
    //
    // Why here and not in the payable query: the ledger adapter's payable
    // SQL fragment is shared by three callers and is the single dispute
    // enforcement point; folding a per-item order lookup into it would make
    // every balance read pay for a join that only RESALE credits need. The
    // credit's `availableAt` is already the one place maturity is decided,
    // so the hold is applied at MINT time and the payable query stays dumb
    // (gate-may-live-at-the-transport ruling applied at the ledger boundary).
    //
    // It applies AFTER the `instantPayouts` branch on purpose: a dev/e2e
    // stack with instant payouts must still hold a resale seller's credit
    // through the claim window, or the claim-approval unwind is only ever
    // exercised in production.
    //
    // Non-RESALE orders never carry a claim window; a stray value on a
    // PRIMARY item is ignored rather than trusted.
    //
    // The stamped release is FLOORED at the claim window's close
    // (`resaleClaimWindowClosesAt`, the same instant `create-claim` refuses
    // after). An organiser's `resalePayoutReleaseDays` used to accept 0, and
    // listings snapshotted under such a policy carry a release BEFORE the
    // window closes: without the floor the seller is paid while the buyer can
    // still file. The floor also covers a NULL stamp (legacy rows minted
    // before the field existed), which used to mean no extra hold at all.
    const resaleReleaseAt =
      order.source === "RESALE"
        ? ticketItems.reduce<Date>((latest, item) => {
            const at = item.resalePayoutReleaseAt;
            if (!at) return latest;
            return latest.getTime() >= at.getTime() ? latest : at;
          }, resaleClaimWindowClosesAt(event))
        : null;
    const availableAt =
      resaleReleaseAt &&
      resaleReleaseAt.getTime() > scheduledAvailableAt.getTime()
        ? resaleReleaseAt
        : scheduledAvailableAt;

    // Group splits by payeeId
    const byPayee = new Map<string, typeof splits>();
    for (const s of splits) {
      const arr = byPayee.get(s.payeeId) ?? [];
      arr.push(s);
      byPayee.set(s.payeeId, arr);
    }

    const credits: Array<{
      entryId: string;
      payeeId: string;
      amountCents: number;
    }> = [];
    const skippedZeroAmount: string[] = [];

    for (const [payeeId, splitRows] of byPayee.entries()) {
      const amount = splitRows.reduce((acc, r) => acc + r.amountCents, 0);

      if (amount <= 0) {
        // The repo throws on amountCents <= 0 by design; a zero split earns
        // no credit. Noted on the audit row below.
        skippedZeroAmount.push(payeeId);
        continue;
      }

      const entry = await tx.payeeLedger.settlementCredit({
        idempotencyKey: `settlement-credit:${order.id}:${payeeId}`,
        payeeId,
        amountCents: amount,
        currency: order.currency,
        orderId: order.id,
        availableAt,
        description: `Ticket revenue — order ${formatOrderCode(order.id)}`,
        metadata: { items: attributeCreditToItems(attributionItems, amount) },
        sourceKind: "order_split",
        sourceId: order.id,
      });

      credits.push({
        entryId: entry.id,
        payeeId,
        // Report what THIS order's splits sum to, not the (idempotent) row's
        // amount — a replay returns the existing row, whose amount is the same
        // by construction of the key.
        amountCents: amount,
      });
    }

    // Audit
    await tx.audit.log({
      entity: "payee_ledger",
      entityId: null,
      action: "credits_created_from_order",
      data: {
        orderId: order.id,
        credits: credits.map((c) => ({
          payeeId: c.payeeId,
          amountCents: c.amountCents,
        })),
        skippedZeroAmount,
        availableAt: availableAt.toISOString(),
        // Why a RESALE credit matured later than its schedule date, without
        // recomputing the claim window by hand.
        resaleReleaseAt: resaleReleaseAt?.toISOString() ?? null,
      },
      at: deps.clock.now(),
    });

    return { credits, skippedZeroAmount };
  });

  return createCreditsFromOrderOutputSchema.parse({
    orderId,
    credits: result.credits,
    skippedZeroAmount: result.skippedZeroAmount,
  });
}
