import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { parseInput } from "../../lib/io";

/**
 * Seat-hold reaper: puts ORPHANED expired seat holds back on sale.
 *
 * Two reapers share the seat-hold lifecycle and the line between them is
 * "does an open order still reference the seat":
 *
 *  - The CART reaper (`orders/release-expired-carts`) owns every seat a
 *    PENDING order references through `OrderItem.meta.seatIds`. It checks the
 *    PaymentIntent FIRST and keeps a cart whose PI succeeded or is processing
 *    while `payment_intent.succeeded` lags; on a clean retirement it releases
 *    the cart's own seats.
 *  - THIS reaper owns the rest: HELD seats past the TTL that no Ticket and
 *    no open (PENDING / PROCESSING) order reference — holds whose cart was
 *    cancelled, or that never got an order at all.
 *
 * It used to be order-state-blind (money audit 2026-09-08 #16): a kept cart
 * lost its seats here at 15 minutes, and finalize then minted tickets for
 * seats another buyer had since been sold. The order-state exclusion lives in
 * `repos.seats.releaseExpiredHolds` (see the port doc), so this use case
 * stays a thin TTL + clock wrapper.
 */
const DEFAULT_HOLD_TTL_SECONDS = 900;

export const releaseExpiredSeatHoldsInputSchema = z
  .object({
    ttlSeconds: z.number().int().positive().optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();

export const releaseExpiredSeatHoldsOutputSchema = z
  .object({
    releasedCount: z.number().int().min(0),
  })
  .strict();

export type ReleaseExpiredSeatHoldsInput = z.infer<
  typeof releaseExpiredSeatHoldsInputSchema
>;
export type ReleaseExpiredSeatHoldsOutput = z.infer<
  typeof releaseExpiredSeatHoldsOutputSchema
>;

export type ReleaseExpiredSeatHoldsDeps = {
  repos: Pick<Repos, "seats">;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function releaseExpiredSeatHolds(
  deps: ReleaseExpiredSeatHoldsDeps,
  rawInput: unknown,
): Promise<ReleaseExpiredSeatHoldsOutput> {
  const logger = deps.logger?.child({ useCase: "releaseExpiredSeatHolds" });

  const execute = async () => {
    const input = parseInput(releaseExpiredSeatHoldsInputSchema, rawInput);
    const now = deps.clock.now();
    const ttlSeconds = input.ttlSeconds ?? DEFAULT_HOLD_TTL_SECONDS;
    const cutoff = new Date(now.getTime() - ttlSeconds * 1000);

    const releasedCount = await deps.repos.seats.releaseExpiredHolds({
      before: cutoff,
      releasedAt: now,
      limit: input.limit,
    });

    return releaseExpiredSeatHoldsOutputSchema.parse({ releasedCount });
  };

  if (logger) {
    return logger.withTime("releaseExpiredSeatHolds", execute);
  }

  return execute();
}
