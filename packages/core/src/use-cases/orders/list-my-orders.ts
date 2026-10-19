import { z } from "zod";

import type { Repos } from "@th/ports/repos";
import type { ListOrdersByBuyerEventLocation } from "@th/ports/repos/orders";
import type { PlaceRecord } from "@th/ports/repos/places";
import {
  buildOffsetPaginatedResult,
  offsetPaginatedResultSchema,
  offsetPaginationInputSchema,
  sanitizeOffsetPagination,
} from "@th/ports/pagination";
import {
  orderSortSchema,
  orderSourceSchema,
  orderStatusSchema,
} from "@th/schema";

import { parseInput } from "../../lib/io";
import {
  buyerChargeBreakdownSchema,
  computeBuyerChargeBreakdown,
} from "../../lib/orders/buyer-charge-breakdown";
import { isActiveHolderOrderStatus } from "../../lib/location/holder-eligibility";
import { resolveHolderAddress } from "../../lib/location/resolve-holder-address";
import {
  venueConfirmationArm,
  type VenueConfirmationArm,
} from "../../lib/venue-confirmation";

export const listMyOrdersInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    /** Filter by order status(es) - defaults to SUCCEEDED orders */
    statuses: z.array(orderStatusSchema).optional(),
    sort: orderSortSchema.optional(),
  })
  .merge(offsetPaginationInputSchema)
  .strict();

const listMyOrdersItemSchema = z
  .object({
    id: z.string().uuid(),
    eventId: z.string().uuid(),
    /** Public event slug; null falls back to eventId for URL construction. */
    eventSlug: z.string().nullable(),
    eventName: z.string().min(1),
    eventStartsAt: z.coerce.date().nullable(),
    /**
     * The row's venue line: "venue name, city" for a place-linked event whose
     * address this holder may see, the coarse area label while it is locked,
     * null for a freeform-address event. See `holderVenueLine`.
     */
    eventVenue: z.string().nullable(),
    /**
     * 0 on a row the viewer did not buy (a transferred-in ticket), like
     * `feesPlatformCents` below. Zero rather than null keeps the int contract
     * an already-shipped client reads, so an old build renders "$0.00"
     * instead of crashing; current clients show no amount when `charges` is
     * null.
     */
    amountGrossCents: z.number().int(),
    /**
     * The RECORDED platform fee; under ABSORB the organiser paid it. A
     * buyer-facing row shows `charges.totalCents` (Total paid) instead.
     */
    feesPlatformCents: z.number().int(),
    /**
     * What the buyer was charged, as lines summing to `totalCents`. NULL on a
     * row the viewer did not buy (a transferred-in ticket): what someone else
     * paid is not theirs to see, and it is not what they paid.
     */
    charges: buyerChargeBreakdownSchema.nullable(),
    currency: z.string().min(1),
    status: orderStatusSchema,
    source: orderSourceSchema,
    occurredAt: z.coerce.date(),
    ticketCount: z.number().int(),
    /**
     * Distinct ticket-type names on the order ("GA", "VIP"). An array because
     * a wallet row is an order and an order can span tiers; empty when the
     * tickets carry no type.
     */
    tiers: z.array(z.string()),
  })
  .strict();

export const listMyOrdersOutputSchema = offsetPaginatedResultSchema(
  listMyOrdersItemSchema,
);

export type ListMyOrdersInput = z.infer<typeof listMyOrdersInputSchema>;
export type ListMyOrdersOutput = z.infer<typeof listMyOrdersOutputSchema>;

/**
 * The order statuses `/my-tickets` lists when the caller passes none (it
 * never does). Exported so the navbar next-night read derives its ticket
 * source from the same set instead of a copy.
 */
export const MY_TICKETS_DEFAULT_ORDER_STATUSES = [
  "SUCCEEDED",
  "PART_REFUNDED",
  "REFUNDED",
] as const satisfies readonly z.infer<typeof orderStatusSchema>[];

export type ListMyOrdersDeps = {
  repos: Repos;
};

/**
 * The venue line a holder may see on their my-tickets row.
 *
 * Unlocked: "venue name, city" for a place-linked event, exactly as the list
 * has always shown it; null for a freeform-address event (the list has never
 * printed a street). Locked: the coarse area label from the shared helper,
 * NOT the venue's name — a named venue is a de-facto exact address, so
 * printing it would undo the event's (or the venue's) obscurity for anyone
 * holding a ticket before the reveal, forever for a NEVER event, for any
 * event at a withheld venue that the venue has not confirmed, and for a row
 * that no longer makes the viewer a holder (unpaid, refunded, transferred
 * away).
 */
export function holderVenueLine(
  location: ListOrdersByBuyerEventLocation,
  now: Date,
  viewer: {
    /** `venueConfirmationArm(event, placeRecord)` for this row's event. */
    venueConfirmationArm: VenueConfirmationArm | null;
    /** Paid order status AND the viewer still holds a live ticket. */
    activeHolder: boolean;
  },
): string | null {
  // Freeform events have never shown a venue line; locking changes nothing.
  if (!location.place) {
    return null;
  }
  const holderAddress = resolveHolderAddress({
    event: location,
    place: location.place,
    venueConfirmationArm: viewer.venueConfirmationArm,
    activeHolder: viewer.activeHolder,
    actOnBill: false,
    now,
  });
  if (holderAddress.locked) {
    return holderAddress.label;
  }
  const parts = [location.place.name, location.place.city].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

export async function listMyOrders(
  deps: ListMyOrdersDeps,
  rawInput: unknown,
): Promise<ListMyOrdersOutput> {
  const input = parseInput(listMyOrdersInputSchema, rawInput);
  const { limit, offset } = sanitizeOffsetPagination(input);

  // Default to showing completed orders (exclude pending)
  const statuses = input.statuses ?? [...MY_TICKETS_DEFAULT_ORDER_STATUSES];

  // Include orders where the actor received a ticket via transfer in addition
  // to orders they bought directly. The recipient owns the Ticket row but
  // never bought the Order, so without this lookup the transferred ticket
  // would never surface in My Tickets.
  const transferredInOrderIds =
    await deps.repos.tickets.listOrderIdsOwnedByHuman(input.actorHumanId);

  const result = await deps.repos.orders.listByBuyer({
    buyerHumanId: input.actorHumanId,
    extraOrderIds: transferredInOrderIds,
    statuses,
    sort: input.sort ?? "occurredAt_desc",
    limit,
    offset,
  });

  // What the holder gate needs beyond the row, read once per page:
  //   - the venue rows, for HOW each venue vouched (its owners and community
  //     consent live on the place, not the event) — one read per distinct
  //     venue, only for rows that have one;
  //   - which of these events the viewer still holds a live ticket for — one
  //     query for the page. A row is a holder's only when its order is paid
  //     AND the viewer still holds a ticket: a refunded order, a transferred-
  //     away ticket, or a pending checkout is not.
  const placeIds = [
    ...new Set(
      result.items
        .map((item) => item.eventLocation.placeId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
  const places = new Map<string, PlaceRecord | null>(
    await Promise.all(
      placeIds.map(
        async (placeId) =>
          [placeId, await deps.repos.places.getById(placeId)] as const,
      ),
    ),
  );
  const heldEventIds = new Set(
    result.items.length > 0
      ? await deps.repos.tickets.listEventIdsWithActiveTicket(
          input.actorHumanId,
          [...new Set(result.items.map((item) => item.eventId))],
        )
      : [],
  );

  const now = new Date();
  return buildOffsetPaginatedResult({
    // The repo hands back raw privacy inputs, never a venue string; the
    // holder-safe line is decided here and the raw inputs are dropped (the
    // output schema is strict).
    items: result.items.map(
      ({
        eventLocation,
        taxAmountCents,
        feePolicySnapshot,
        stripePaymentIntentId,
        chargeLines,
        buyerHumanId,
        ...item
      }) => {
      const place = eventLocation.placeId
        ? (places.get(eventLocation.placeId) ?? null)
        : null;
      const isBuyer = buyerHumanId === input.actorHumanId;
      return {
        ...item,
        // What someone else paid is not the transfer recipient's to see.
        ...(isBuyer ? {} : { amountGrossCents: 0, feesPlatformCents: 0 }),
        charges:
          isBuyer
            ? computeBuyerChargeBreakdown({
                stripePaymentIntentId,
                amountGrossCents: item.amountGrossCents,
                feesPlatformCents: item.feesPlatformCents,
                taxAmountCents,
                feePolicySnapshot,
                items: chargeLines,
              })
            : null,
        eventVenue: holderVenueLine(eventLocation, now, {
          venueConfirmationArm: venueConfirmationArm(eventLocation, place),
          activeHolder:
            isActiveHolderOrderStatus(item.status) &&
            heldEventIds.has(item.eventId),
        }),
      };
    },
    ),
    total: result.total,
    limit,
    offset,
  });
}
