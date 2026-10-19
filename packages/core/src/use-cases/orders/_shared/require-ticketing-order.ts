import { fail } from "@th/errors";
import type { OrderKind } from "@th/types";

/**
 * Narrow an order to a ticketing order and return its event id.
 *
 * `Order.eventId` became nullable when membership invoices started being
 * materialised as Orders (they have no event). Every caller of this helper is
 * a ticket-only flow — minting, refunds, POS sales, resale, settlement — where
 * a membership order arriving is a routing bug, not a case to handle.
 *
 * Checking `kind` rather than just the null is deliberate: the discriminator is
 * the intent and the null is only its consequence, so a future order kind that
 * also lacks an event fails here loudly instead of slipping through a null
 * check that happens to pass.
 *
 * `kind` is optional and absent is treated as TICKETING, mirroring the column's
 * `@default(TICKETING)`. Orders written before the discriminator existed — and
 * the many test fixtures built without it — are ticketing orders, so demanding
 * the field would reject valid input rather than catch a real one.
 */
export function requireTicketingEventId(order: {
  id: string;
  kind?: OrderKind;
  eventId: string | null;
}): string {
  if ((order.kind ?? "TICKETING") !== "TICKETING" || !order.eventId) {
    throw fail("EXPECTED_TICKETING_ORDER", {
      meta: { orderId: order.id, kind: order.kind },
    });
  }
  return order.eventId;
}
