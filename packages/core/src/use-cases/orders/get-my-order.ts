import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { Repos } from "@th/ports/repos";
import {
  orderItemRecordSchema,
  orderSourceSchema,
  orderStatusSchema,
} from "@th/schema";

import { isEventPast } from "../../lib/event-ended";
import { parseInput } from "../../lib/io";
import { isActiveHolderOrderStatus } from "../../lib/location/holder-eligibility";
import { resaleClaimWindowClosesAt } from "../../lib/resale-claim-window";
import { resolveHolderAddress } from "../../lib/location/resolve-holder-address";
import { venueConfirmationArm } from "../../lib/venue-confirmation";
import {
  buyerChargeBreakdownSchema,
  computeBuyerChargeBreakdown,
} from "../../lib/orders/buyer-charge-breakdown";
import { fail } from "@th/errors";
import { requireTicketingEventId } from "./_shared/require-ticketing-order";

export const getMyOrderInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  orderId: z.string().uuid(),
});

/**
 * Output item schema: picks only the fields relevant for buyer display.
 * Source: orderItemRecordSchema from @th/schema (mirrors Prisma OrderItem).
 */
const outputItemSchema = orderItemRecordSchema.pick({
  id: true,
  qty: true,
  unitPriceCents: true,
  amountCents: true,
  kind: true,
  ticketTypeId: true,
  resaleListingId: true,
  paidOutAt: true,
  refundedAt: true,
  transferredAt: true,
  status: true,
});

export const getMyOrderOutputSchema = z.object({
  id: z.string().uuid(),
  status: orderStatusSchema,
  amountGrossCents: z.number().int(),
  /**
   * The platform fee RECORDED on the order. Under ABSORB the organiser paid
   * it, not the buyer; buyer-facing surfaces read `charges` instead.
   */
  feesPlatformCents: z.number().int(),
  /** Total the buyer paid; equals `charges.totalCents`. */
  buyerTotalCents: z.number().int(),
  taxAmountCents: z.number().int().nonnegative(),
  /**
   * What the BUYER was charged, as display lines that always add to
   * `totalCents` (`computeBuyerChargeBreakdown`).
   */
  charges: buyerChargeBreakdownSchema,
  currency: z.string(),
  eventId: z.string().uuid(),
  eventName: z.string(),
  eventStartsAt: z.coerce.date().nullable(),
  /** How the order was placed. RESALE orders can file a resale claim. */
  source: orderSourceSchema,
  /**
   * When the resale claim window closes (ISO): `(endsAt ?? startsAt) + 3d`,
   * half-open (`now < close`). Null unless `source` is RESALE or the event's
   * start could not be read. The window opens at `eventStartsAt`.
   */
  resaleClaimWindowClosesAt: z.string().datetime().nullable(),
  /**
   * True once the event is over (`isEventPast`: its end, else its start).
   * Its tickets can no longer be transferred, so the page hides the action.
   * False when the event row, or its start, could not be read.
   */
  eventEnded: z.boolean(),
  /**
   * Where the holder goes. Unlocked: the street address (from the Place for a
   * venue that withholds its address, else the Event row). Locked: ONLY the
   * coarse area label ("Nashville, TN") or null — never a street, never a
   * venue name. Read `eventAddressLocked` before treating it as an address.
   */
  eventVenue: z.string().nullable(),
  /**
   * True while this holder may not see the street address: the event (or its
   * venue) hides it and the reveal date has not passed, the organizer chose
   * never to share it, the venue has not confirmed this event, or the order
   * no longer makes the viewer a holder (unpaid, refunded, transferred away).
   */
  eventAddressLocked: z.boolean(),
  /**
   * Why it is locked; null when unlocked. The page picks its notice from
   * this: `venueUnconfirmed` = "ask the organizer", `never` = the organizer
   * isn't sharing it, `placeUnavailable` = the venue could not be read just
   * now (NOT the venue's "no"; copy key `orderDetail.addressLocked.
   * unavailable`), `notYetRevealed` with a date = "shared on {date}",
   * anything else = the plain "not shared yet" line.
   */
  eventAddressLockReason: z
    .enum([
      "never",
      "placeUnavailable",
      "venueUnconfirmed",
      "notHolder",
      "notYetRevealed",
    ])
    .nullable(),
  /**
   * When a locked address will be shared. Null when unlocked, when the
   * organizer chose never to share it, or when no date is set.
   */
  eventAddressRevealAt: z.coerce.date().nullable(),
  /** True when the organizer chose never to share the address (NEVER). */
  eventAddressNeverShared: z.boolean(),
  /** Organising org's display name, or null for human-owned events. */
  organiserName: z.string().nullable(),
  /** Organising org's public contact email, or null when absent. */
  organiserContactEmail: z.string().nullable(),
  items: z.array(outputItemSchema),
  stripePaymentIntentId: z.string().nullable(),
  /** Ticket type names keyed by ticketTypeId, for display. */
  ticketTypeNames: z.record(z.string(), z.string()),
  /** When the order was placed. */
  occurredAt: z.coerce.date(),
});

export type GetMyOrderInput = z.infer<typeof getMyOrderInputSchema>;
export type GetMyOrderOutput = z.infer<typeof getMyOrderOutputSchema>;

export type GetMyOrderDeps = {
  repos: Pick<
    Repos,
    "orders" | "events" | "organizations" | "places" | "tickets"
  >;
  /** Defaults to the wall clock. */
  clock?: ClockPort;
};

export async function getMyOrder(
  deps: GetMyOrderDeps,
  rawInput: unknown,
): Promise<GetMyOrderOutput> {
  const input = parseInput(getMyOrderInputSchema, rawInput);
  const order = await deps.repos.orders.getById(input.orderId);

  if (!order) {
    throw fail("ORDER_NOT_FOUND");
  }

  if (order.buyerHumanId !== input.actorHumanId) {
    // Return not found to implicitely deny access without leaking existence
    throw fail("ORDER_NOT_FOUND");
  }

  // Fetch event details for display
  const event = await deps.repos.events.getById(requireTicketingEventId(order));

  // The address this holder may see RIGHT NOW. `resolveHolderAddress` owns
  // the whole decision (mode floored by the venue, the venue's word for this
  // event, reveal date, NEVER) and, once unlocked, reads the TRUE address from
  // the right row: the Place for a venue that withholds its address, because
  // that event's own row only carries the venue's public projection.
  const place = event?.placeId
    ? await deps.repos.places.getById(event.placeId)
    : null;
  // Owning the order is not holding the event. `createCheckout` writes a
  // PENDING order before any payment, and a refunded buyer, one who
  // transferred every ticket away, or a resale buyer still at checkout owns
  // an order too. Only a paid order whose buyer STILL holds a live ticket is
  // a holder. The ticket read is skipped when the status already says no.
  const activeHolder =
    event !== null &&
    isActiveHolderOrderStatus(order.status) &&
    (await deps.repos.tickets.viewerHoldsActiveTicketForEvent(
      event.id,
      input.actorHumanId,
    ));
  const holderAddress = event
    ? resolveHolderAddress({
        event,
        place,
        venueConfirmationArm: venueConfirmationArm(event, place),
        activeHolder,
        actOnBill: false,
        now: new Date(),
      })
    : null;

  let eventVenue: string | null = null;
  if (holderAddress?.locked) {
    // Coarse label only. Never the street, and never `place.name` — a linked
    // venue's name is a de-facto exact address while the address is locked.
    eventVenue = holderAddress.label;
  } else if (holderAddress) {
    // "street, locality", the historical shape, from whichever row holds the
    // truth (for a withheld venue: the Place's street and city).
    const parts = [holderAddress.addressText, holderAddress.locality].filter(
      Boolean,
    );
    eventVenue = parts.length > 0 ? parts.join(", ") : null;
  }

  // Organiser contact enrichment (display-only). Human-owned events have no
  // orgId, and a missing org is treated as "no organiser contact" rather than
  // an error — this must never block rendering the order.
  let organiserName: string | null = null;
  let organiserContactEmail: string | null = null;
  if (event?.orgId) {
    const org = await deps.repos.organizations.getById(event.orgId);
    if (org) {
      organiserName = org.name;
      organiserContactEmail = org.contactEmail ?? null;
    }
  }

  // Resolve ticket type names for display
  const eventTicketTypes = await deps.repos.events.listTicketTypes(
    requireTicketingEventId(order),
  );
  const ticketTypeNames: Record<string, string> = {};
  for (const tt of eventTicketTypes) {
    ticketTypeNames[tt.id] = tt.name;
  }

  // What the buyer actually paid, split into lines that sum to the total.
  const charges = computeBuyerChargeBreakdown(order);

  return {
    id: order.id,
    status: order.status,
    amountGrossCents: order.amountGrossCents,
    feesPlatformCents: order.feesPlatformCents ?? 0,
    buyerTotalCents: charges.totalCents,
    taxAmountCents: order.taxAmountCents ?? 0,
    charges,
    currency: order.currency,
    eventId: requireTicketingEventId(order),
    eventName: event?.title ?? "Event",
    eventStartsAt: event?.startsAt ?? null,
    source: order.source,
    resaleClaimWindowClosesAt:
      order.source === "RESALE" && event?.startsAt
        ? resaleClaimWindowClosesAt(event).toISOString()
        : null,
    // `startsAt` is typed non-null but this read-only view already tolerates
    // rows without one (`eventStartsAt` is nullable); never crash the page.
    eventEnded: event?.startsAt
      ? isEventPast(event, deps.clock?.now() ?? new Date())
      : false,
    eventVenue,
    eventAddressLocked: holderAddress?.locked ?? false,
    eventAddressRevealAt: holderAddress?.locked ? holderAddress.revealAt : null,
    eventAddressNeverShared: holderAddress?.locked ? holderAddress.never : false,
    eventAddressLockReason: holderAddress?.locked ? holderAddress.reason : null,
    organiserName,
    organiserContactEmail,
    items: order.items.map((i) => ({
      id: i.id,
      qty: Number(i.qty),
      unitPriceCents: i.unitPriceCents,
      amountCents: i.amountCents,
      kind: i.kind,
      ticketTypeId: i.ticketTypeId,
      resaleListingId: i.resaleListingId,
      paidOutAt: i.paidOutAt,
      refundedAt: i.refundedAt,
      transferredAt: i.transferredAt,
      status: i.status,
    })),
    stripePaymentIntentId: order.stripePaymentIntentId,
    ticketTypeNames,
    occurredAt: order.occurredAt,
  };
}
