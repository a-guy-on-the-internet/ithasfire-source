import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { parseInput } from "../../lib/io";
import { cancelActiveListingInTx } from "./_shared/cancel-active-listing";
import { fail } from "@th/errors";

// ── Schemas ────────────────────────────────────────────────────────────────

export const cancelResaleListingInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  listingId: z.string().uuid(),
});

export const cancelResaleListingOutputSchema = z.object({
  listingId: z.string().uuid(),
  ticketId: z.string().uuid(),
});

export type CancelResaleListingInput = z.infer<
  typeof cancelResaleListingInputSchema
>;
export type CancelResaleListingOutput = z.infer<
  typeof cancelResaleListingOutputSchema
>;

export type CancelResaleListingDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

// ── Use case ───────────────────────────────────────────────────────────────

export async function cancelResaleListing(
  deps: CancelResaleListingDeps,
  rawInput: unknown,
): Promise<CancelResaleListingOutput> {
  const input = parseInput(cancelResaleListingInputSchema, rawInput);
  const now = deps.clock.now();

  const result = await deps.repos.tx(async (tx) => {
    const listing = await tx.resaleListings.getById(input.listingId);
    if (!listing) {
      throw fail("LISTING_NOT_FOUND");
    }

    if (listing.sellerHumanId !== input.actorHumanId) {
      throw fail("FORBIDDEN");
    }

    if (listing.status !== "ACTIVE") {
      throw fail("LISTING_NOT_ACTIVE");
    }

    // Ticket lock, listing CAS, ticket LISTED → VALID, pointer cleared.
    if (!(await cancelActiveListingInTx(tx, listing))) {
      throw fail("LISTING_NOT_ACTIVE");
    }

    // Audit
    await tx.audit.log({
      entity: "resale_listing",
      entityId: listing.id,
      action: "cancelled",
      data: {
        ticketId: listing.ticketId,
        sellerHumanId: input.actorHumanId,
      },
      at: now,
    });

    return {
      listingId: listing.id,
      ticketId: listing.ticketId,
    };
  });

  deps.logger?.info("cancelResaleListing.succeeded", {
    listingId: result.listingId,
    ticketId: result.ticketId,
  });

  return result;
}
