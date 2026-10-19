import { z } from "zod";

import { fail } from "@th/errors";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { effectiveResaleCapCents } from "../../lib/pricing/effective-resale-cap";
import { RESALE_LISTING_MAX_ASK_CENTS } from "../../lib/pricing/resale-pricing";
import {
  priceResaleAsk,
  resolveResaleTicketTerms,
} from "./_shared/resale-ticket-terms";

// ── The seller form's numbers (organiser-resale-share NFR-002) ─────────────
//
// What a listing at this ask would pay the people who put on the night and
// the seller, priced by the SAME functions `createResaleListing` charges with
// (`resolveResaleTicketTerms`, `priceResaleAsk`, `computeResaleShare`), so the
// form never recomputes money on the client. Read-only: a ticket with no
// resale record yet (sold before the record existed) is priced under the
// event's clause as it stands, which is what its first listing would write
// (FR-004); nothing is written here.

export const estimateResaleListingInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    ticketId: z.string().uuid(),
    askPriceCents: z.number().int().positive().max(RESALE_LISTING_MAX_ASK_CENTS),
  })
  .strict();

export const estimateResaleListingOutputSchema = z.object({
  ticketId: z.string().uuid(),
  currency: z.string(),
  askPriceCents: z.number().int().positive(),
  /** To the people who put on the night (FR-008). */
  shareCents: z.number().int().nonnegative(),
  /** A FLAT amount was held to 10% of this ask (FR-002). */
  shareHeld: z.boolean(),
  /** The clause's FLAT amount before the limit when `shareHeld`, else null. */
  heldFromCents: z.number().int().positive().nullable(),
  /** "You receive": the ask less the share when the seller pays it. */
  sellerReceivesCents: z.number().int().nonnegative(),
  /** What the buyer pays before processing and tax. */
  basisCents: z.number().int().positive(),
  payer: z.enum(["SELLER", "BUYER"]),
  /** "Original price" (FR-007): the organiser's price at the first sale. */
  originalPriceCents: z.number().int().nonnegative(),
  /** The ticket's resale cap, null when uncapped. */
  capCents: z.number().int().nonnegative().nullable(),
  /** False when `basisCents` is over the cap: the listing would be refused. */
  withinCap: z.boolean(),
  /** The highest ask that fits the cap (FR-002), null when uncapped. */
  highestFittingAskCents: z.number().int().nonnegative().nullable(),
});

export type EstimateResaleListingInput = z.infer<
  typeof estimateResaleListingInputSchema
>;
export type EstimateResaleListingOutput = z.infer<
  typeof estimateResaleListingOutputSchema
>;

export type EstimateResaleListingDeps = {
  repos: Pick<
    Repos,
    "tickets" | "events" | "orderItems" | "orders" | "payoutTerms"
  >;
};

/**
 * Refuses what `createResaleListing` would refuse about the ticket and its
 * terms (not the ticket's status or the seller's payout setup, which the
 * listing checks when it is made): NOT_RESOURCE_OWNER for someone else's
 * ticket, RESALE_NOT_ENABLED / RESALE_NOT_ALLOWED_FOR_TYPE, RESALE_TERMS_MISSING
 * when neither the ticket nor the event carries a clause, and
 * RESALE_PURCHASE_PRICE_UNKNOWN when the original price cannot be found. An
 * ask over the cap is NOT refused: it answers `withinCap: false` with the
 * highest ask that fits, for the form to offer.
 */
export async function estimateResaleListing(
  deps: EstimateResaleListingDeps,
  rawInput: unknown,
): Promise<EstimateResaleListingOutput> {
  const input = parseInput(estimateResaleListingInputSchema, rawInput);
  const { repos } = deps;

  const ticket = await repos.tickets.getById(input.ticketId);
  if (!ticket) throw fail("TICKET_NOT_FOUND");
  if (ticket.ownerHumanId !== input.actorHumanId) {
    throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "ticket" } });
  }

  const event = await repos.events.getById(ticket.eventId);
  if (!event) throw fail("EVENT_NOT_FOUND");
  if (!event.resalePayoutTermsId) throw fail("RESALE_NOT_ENABLED");

  let resaleCapCents: number | null = null;
  if (ticket.ticketTypeId) {
    const ticketType = await repos.tickets.getTicketTypeById(
      ticket.ticketTypeId,
    );
    if (ticketType) {
      if (!ticketType.resaleAllowed) throw fail("RESALE_NOT_ALLOWED_FOR_TYPE");
      resaleCapCents = ticketType.resaleCapCents;
    }
  }

  const purchaseItem = ticket.orderItemId
    ? await repos.orderItems.getById(ticket.orderItemId)
    : null;
  const purchaseOrder = purchaseItem
    ? await repos.orders.getById(purchaseItem.orderId)
    : null;
  if (!purchaseItem || !purchaseOrder) {
    throw fail("RESALE_PURCHASE_PRICE_UNKNOWN", {
      meta: { ticketId: ticket.id },
    });
  }

  const terms = await resolveResaleTicketTerms(repos, {
    event,
    purchaseItem,
    purchaseOrder,
  });
  const priced = priceResaleAsk({
    askCents: input.askPriceCents,
    clause: terms.clause,
    // FR-007: floored at the ORIGINAL price, passed explicitly.
    capCents: effectiveResaleCapCents({
      ticketTypeResaleCapCents: resaleCapCents,
      ticketUnitPriceCents: purchaseItem.unitPriceCents,
      originalUnitPriceCents: terms.originalUnitPriceCents,
    }),
  });

  return {
    ticketId: ticket.id,
    currency: event.currency ?? "usd",
    askPriceCents: input.askPriceCents,
    shareCents: priced.share.shareCents,
    shareHeld: priced.share.shareHeld,
    heldFromCents: priced.share.heldFromCents,
    sellerReceivesCents: priced.share.sellerReceivesCents,
    basisCents: priced.share.basisCents,
    payer: priced.share.payer,
    originalPriceCents: terms.originalUnitPriceCents,
    capCents: priced.capCents,
    withinCap: priced.withinCap,
    highestFittingAskCents: priced.highestFittingAskCents,
  };
}
