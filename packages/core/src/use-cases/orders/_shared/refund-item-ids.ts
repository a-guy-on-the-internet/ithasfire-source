import { z } from "zod";

/**
 * The `orderItemIds` list every item-refund entry point accepts — buyer and
 * org, quote and execute.
 *
 * Uniqueness is a MONEY rule, not tidiness. `quoteItemRefund` builds one quote
 * per id in the list and sums them into `totalRefundableCents`, and
 * `refundOrderItems` sends that sum to Stripe. Without this refine, `[X, X]`
 * validated (both ids belong to the order), quoted X twice, refunded 2× X's
 * share, and then marked X refunded ONCE — nothing in the database would ever
 * have shown the buyer was paid double. The idempotency key sorts the ids but
 * does not dedupe them, so it did not block the request either.
 *
 * Rejected rather than silently deduped: a duplicate id is a client bug, and
 * the buyer should not receive a refund the client did not mean to ask for.
 */
export const refundOrderItemIdsSchema = z
  .array(z.uuid())
  .min(1)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "order_item_ids_must_be_unique",
  });
