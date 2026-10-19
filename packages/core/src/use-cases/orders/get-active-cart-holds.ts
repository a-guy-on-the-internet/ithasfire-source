import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { PendingCartItem } from "@th/ports/repos/orders";
import { parseInput } from "../../lib/io";
import { derivePendingCartPricing } from "../../lib/orders/pending-cart-fees";

export const getActiveCartHoldsInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    limit: z.number().int().positive().max(10).optional(),
  })
  .strict();

export const getActiveCartHoldsOutputSchema = z
  .object({
    carts: z.array(
      z.object({
        id: z.string().uuid(),
        eventId: z.string().uuid(),
        eventName: z.string(),
        eventSlug: z.string().nullable(),
        eventStartsAt: z.date().nullable(),
        amountGrossCents: z.number().int(),
        feesPlatformCents: z.number().int(),
        /**
         * Σ ticket lines — the gross BEFORE any discount. `amountGrossCents`
         * is post-discount on a cart `createCheckout` re-saved; resume must
         * start from this one (see `derivePendingCartPricing`).
         */
        preDiscountGrossCents: z.number().int().nonnegative(),
        /** Typed promo codes the cart was priced with — restored on resume. */
        promoCodes: z.array(z.string()),
        /** The fee mode the hold was priced under (null if unrecorded). */
        feeMode: z.enum(["ABSORB", "PASS_THROUGH"]).nullable(),
        /**
         * The buyer-funded platform fee (PASS_THROUGH: `feesPlatformCents`;
         * ABSORB: 0) — what a resumed held step must add to its total.
         */
        buyerFeesCents: z.number().int().nonnegative(),
        currency: z.string(),
        holdExpiresAt: z.date().nullable(),
        createdAt: z.date(),
        ticketSummary: z.array(
          z.object({
            ticketTypeId: z.string().uuid(),
            ticketTypeName: z.string(),
            qty: z.number().int(),
            unitPriceCents: z.number().int(),
            seatIds: z.array(z.string().uuid()).default([]),
            /**
             * Each held seat at its own line's unit price: what a resumed
             * checkout shows per seat and quotes at Pay (seat-price-overrides
             * D-007). `unitPriceCents` is only the first line's.
             */
            seats: z
              .array(
                z.object({
                  seatId: z.string().uuid(),
                  unitPriceCents: z.number().int(),
                }),
              )
              .default([]),
          }),
        ),
      }),
    ),
  })
  .strict();

export type GetActiveCartHoldsInput = z.infer<
  typeof getActiveCartHoldsInputSchema
>;
export type GetActiveCartHoldsOutput = z.infer<
  typeof getActiveCartHoldsOutputSchema
>;

export type GetActiveCartHoldsDeps = {
  repos: Pick<Repos, "orders">;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * Retrieves active cart holds (PENDING orders with non-expired holds) for a user.
 * Used for cart recovery feature - showing users their abandoned carts when they return.
 */
export async function getActiveCartHolds(
  deps: GetActiveCartHoldsDeps,
  rawInput: unknown,
): Promise<GetActiveCartHoldsOutput> {
  const logger = deps.logger?.child({ useCase: "getActiveCartHolds" });

  const execute = async () => {
    const input = parseInput(getActiveCartHoldsInputSchema, rawInput);
    const now = deps.clock.now();

    const result = await deps.repos.orders.listPendingCarts({
      buyerHumanId: input.actorHumanId,
      holdExpiresAfter: now,
      limit: input.limit ?? 5,
    });

    const carts = result.items.map(({ lines, ...cart }: PendingCartItem) => ({
      ...cart,
      // Derived HERE, from the plain lines the adapter returns: buyer-side
      // fees, the pre-discount gross and the typed codes (see
      // `derivePendingCartPricing`).
      ...derivePendingCartPricing(lines, cart.feesPlatformCents),
    }));

    return getActiveCartHoldsOutputSchema.parse({ carts });
  };

  if (logger) {
    return logger.withTime("getActiveCartHolds", execute);
  }

  return execute();
}
