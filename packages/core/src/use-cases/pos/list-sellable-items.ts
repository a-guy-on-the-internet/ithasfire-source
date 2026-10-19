import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { resolveUnitPriceCents } from "../../lib/orders/door-pricing";
import {
  resolveTicketTypeSellability,
  ticketTypeSellabilitySchema,
} from "../../lib/orders/ticket-type-sellability";
import { loadTicketTypeAvailability } from "../_helpers/load-ticket-type-availability";
import { parseInput } from "../../lib/io";
import { ORG_SCAN_ROLES, requireScannerAccessOnOrg } from "../../lib/rbac";
import { fail } from "@th/errors";

// ── Schema ───────────────────────────────────────────────────────────────────

export const listSellableItemsInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  eventId: z.string().uuid(),
});

export type ListSellableItemsInput = z.infer<
  typeof listSellableItemsInputSchema
>;

const sellableItemSchema = z.object({
  ticketTypeId: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  /**
   * For FIXED pricing this is the amount charged per ticket — the same
   * resolved price online checkout charges. For ADJUSTABLE pricing
   * the buyer-entered amount governs — this field is informational only
   * (carries the configured base price) and clients should rely on
   * `pricingMode` + `suggestedCents` / `minimumCents` for input UX.
   */
  unitPriceCents: z.number().int().nonnegative(),
  pricingMode: z.enum(["FIXED", "ADJUSTABLE"]),
  /** ADJUSTABLE only — server enforces operator-entered amount >= this. */
  minimumCents: z.number().int().nonnegative().nullable(),
  /** ADJUSTABLE only — UI prefill default. */
  suggestedCents: z.number().int().nonnegative().nullable(),
  capacityRemaining: z.number().int().nonnegative(),
  /**
   * PER-TIER availability (FR-010). Phase 2a armed the till to REFUSE a
   * windowed tier at the point of sale (`assertTicketTypeOnSale` inside
   * `startPosSale` / `recordCashSale`) but left this listing time-blind, so an
   * operator could build a cart and only discover the refusal after taking the
   * customer's card out. Fail-closed, but a bad door experience. This is the
   * same shape the public list and the embed return.
   *
   * The event level here is deliberately a PERMIT (`ok`): the POS has no
   * event-wide close — door sales legitimately happen after the event has
   * started — and cash needs no connected payee. So the only reasons reachable
   * on this surface are `ok`, `not_yet_on_sale` and `sales_ended`.
   *
   * SURFACING ONLY. Windowed tiers are still LISTED, not filtered out: the
   * operator needs to see that "VIP opens at 8pm" exists, and hiding a row is
   * how a door team concludes the tier was never configured.
   */
  sellability: ticketTypeSellabilitySchema,
});

export const listSellableItemsOutputSchema = z.object({
  eventId: z.string().uuid(),
  currency: z.string().min(3).max(3),
  /**
   * IANA timezone of the EVENT, so the till renders "opens 8:00 PM CDT" on the
   * venue's clock rather than the device's. A door tablet is almost always in
   * the venue's zone — "almost always" is not a correctness argument, and a
   * touring operator's iPad is the case that breaks it.
   */
  timezone: z.string(),
  ticketTypes: z.array(sellableItemSchema),
});

export type ListSellableItemsOutput = z.infer<
  typeof listSellableItemsOutputSchema
>;

// ── Deps ─────────────────────────────────────────────────────────────────────

export type ListSellableItemsDeps = {
  repos: Repos;
  authz: AuthZPort;
  /**
   * REQUIRED. The Sell screen QUOTES the price that `recordCashSale` /
   * `startPosSale` then CHARGE. With scheduled pricing (FR-005) those two
   * numbers only agree if both resolve against a real clock — a time-blind
   * quote here is exactly the "quote one price, charge another" failure the
   * shared resolver exists to prevent.
   */
  clock: ClockPort;
  logger?: LoggerPort;
};

// ── Use case ─────────────────────────────────────────────────────────────────

/**
 * Returns the TicketTypes a scanner-role operator may sell at the door
 * for this event (FR-002). One row per active TicketType with capacity
 * remaining. Price is resolved through the shared resolver, the same price
 * online checkout charges (there is no separate door price, FR-012).
 *
 * Auth: ORG_SCAN_ROLES on the event's org.
 *
 * Note: the Sell tab itself (FR-001) is hidden client-side when this
 * returns an empty `ticketTypes` array. Cash sales (FR-015) work even
 * without `card_present` capability, so this query does NOT gate on
 * Payee.chargesEnabled — that gate lives at `pos.startSale` time.
 */
export async function listSellableItems(
  deps: ListSellableItemsDeps,
  rawInput: unknown,
): Promise<ListSellableItemsOutput> {
  const input = parseInput(listSellableItemsInputSchema, rawInput);

  const event = await deps.repos.events.getById(input.eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }
  if (!event.orgId) {
    throw fail("EVENT_NOT_ORG_OWNED");
  }

  await requireScannerAccessOnOrg({
    repos: deps.repos,
    authz: deps.authz,
    orgId: event.orgId,
    actorHumanId: input.actorHumanId,
    roles: ORG_SCAN_ROLES,
    errorCode: "INSUFFICIENT_ROLE",
  });

  // The door sells published events only (owner ruling 2026-10-07): an
  // unpublished or cancelled event lists nothing, which hides the Sell tab
  // (web and scanner both hide it on an empty list).
  if (event.status !== "PUBLISHED") {
    return listSellableItemsOutputSchema.parse({
      eventId: input.eventId,
      currency: event.currency ?? "usd",
      timezone: event.timezone || "UTC",
      ticketTypes: [],
    });
  }

  // One instant for the whole listing so two tiers can't be quoted from
  // different sides of a flip.
  const now = deps.clock.now();
  const types = await deps.repos.events.listTicketTypes(event.id);

  const activeTypes = types.filter((tt) => tt.status === "ACTIVE");

  // SAME basis as the pre-charge gate: capacity - issued - held.
  //
  // This used to be issued-only, on the reasoning that a door operator wants
  // the truer "what's left to sell". That was wrong once the gate started
  // counting holds: the screen said "1 remaining", the operator tapped, and
  // `assertTicketTypeCapacity` refused with TICKET_TYPE_TEMPORARILY_HELD — a
  // listing and a gate disagreeing about the same tier, in front of a queue.
  // One definition of available, shared with the public sold-out badge.
  const availability = await loadTicketTypeAvailability(deps.repos, {
    ticketTypes: activeTypes,
    now,
  });

  const sellable = await Promise.all(
    activeTypes
      .map(async (tt) => {
        const capacityRemaining =
          availability.get(tt.id)?.remainingCapacity ?? 0;
        return {
          ticketTypeId: tt.id,
          name: tt.name,
          description: tt.description,
          unitPriceCents: resolveUnitPriceCents(tt, { now }),
          pricingMode: tt.pricingMode,
          minimumCents: tt.minimumCents,
          suggestedCents: tt.suggestedCents,
          capacityRemaining,
          // Event level is a permit on this surface — see the schema note.
          sellability: resolveTicketTypeSellability(tt, now, {
            available: true,
            reason: "ok",
          }),
        };
      }),
  );

  // Hide sold-out tiers. Empty result → Sell tab hides itself.
  const visible = sellable.filter((s) => s.capacityRemaining > 0);

  deps.logger?.info("pos.list_sellable_items", {
    eventId: input.eventId,
    actorHumanId: input.actorHumanId,
    count: visible.length,
  });

  return listSellableItemsOutputSchema.parse({
    eventId: input.eventId,
    currency: event.currency ?? "usd",
    // `EventRecord.timezone` is non-nullable, but the fallback keeps a bad
    // stored value from taking the whole Sell tab down over a display string.
    timezone: event.timezone || "UTC",
    ticketTypes: visible,
  });
}
