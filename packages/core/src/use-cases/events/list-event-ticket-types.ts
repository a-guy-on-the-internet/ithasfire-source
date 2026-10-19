import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { parseInput } from "../../lib/io";
import { loadTicketTypeAvailability } from "../_helpers/load-ticket-type-availability";
import {
  isEverPaidTicketType,
  resolveUnitPriceCents,
} from "../../lib/orders/door-pricing";
import {
  EVENT_LEVEL_SELLABILITY_REASONS,
  resolveTicketTypeSellability,
  resolveUpcomingPriceChange,
  ticketTypeSellabilitySchema,
  upcomingPriceChangeSchema,
  type EventLevelSellability,
} from "../../lib/orders/ticket-type-sellability";
import { fail } from "@th/errors";

export const listEventTicketTypesInputSchema = z
  .object({
    eventId: z.uuid(),
  })
  .strict();

export const listEventTicketTypesOutputSchema = z
  .object({
    eventId: z.uuid(),
    /** Place layout ID assigned to this event. Null when GA (no assigned layout). */
    placeLayoutId: z.string().uuid().nullable(),
    ticketTypes: z.array(
      z
        .object({
          id: z.uuid(),
          name: z.string(),
          /**
           * EFFECTIVE online price at request time — resolved through
           * `resolveUnitPriceCents` (FR-004), so after a scheduled flip
           * (FR-005) this is `scheduledPriceCents`. This is the public ticket
           * list; it must show the number checkout will charge. The raw stored
           * list price is deliberately NOT exposed here — that belongs to the
           * admin edit projection (`listEventTicketTypesForEdit`).
           */
          priceCents: z.number().int(),
          pricingMode: z.enum(["FIXED", "ADJUSTABLE"]),
          minimumCents: z.number().int().nullable(),
          suggestedCents: z.number().int().nullable(),
          /**
           * The AUTHORED capacity column, retained verbatim. It is NOT an
           * availability signal — no write path decrements it — and no client
           * may derive "sold out" from it; that is `soldOut` below. Kept on the
           * wire because live consumers still read it as the tier's configured
           * size (the seat-map picker, mobile's per-tier quantity cap).
           */
          capacity: z.number().int(),
          /**
           * How many of this tier a buyer can actually take RIGHT NOW:
           * `capacity - issued - held`, clamped at 0 — the same basis the
           * pre-charge gate (`assertTicketTypeCapacity`) refuses on, resolved
           * at the same `now` as the price beside it.
           *
           * Holds ARE counted here, unlike the POS listing. See
           * `_helpers/load-ticket-type-availability.ts` for why the door and
           * the web want different answers to that question.
           */
          remainingCapacity: z.number().int().nonnegative(),
          /**
           * `remainingCapacity <= 0`. THE sold-out signal, and the only honest
           * one: clients used to test `capacity <= 0`, which is the authored
           * column and therefore essentially never true, so a sold-out tier
           * rendered a live stepper and refused the buyer at submit.
           *
           * Deliberately its own field rather than a new `sellability` reason.
           * Sold-out and the sales WINDOW are independent facts — a tier can be
           * both sold out and not yet on sale — and every client already ORs
           * the two into one "no stepper" decision. Folding them upstream would
           * have to pick a winner and would lose the other fact.
           */
          soldOut: z.boolean(),
          seatSectionId: z.string().uuid().nullable(),
          /** Layout-internal section key (e.g. "ga-floor") for matching with PlaceLayout sections. */
          layoutSectionId: z.string().nullable(),
          /**
           * PER-TIER availability (FR-010) — the COMPLETE answer for this tier,
           * not a fragment to be ANDed with the event-level flag. It already
           * folds in the event-wide verdict, so a consumer that reads only this
           * is correct. See `lib/orders/ticket-type-sellability.ts` for why the
           * event-level refusal wins and why NFR-001 holds by construction (an
           * unwindowed tier reports exactly the event-level answer).
           */
          sellability: ticketTypeSellabilitySchema,
          /**
           * Q-002: the pending scheduled price change, for "$12 until Fri 3
           * Oct" urgency copy. NULL once the flip has passed — resolved at the
           * same `now` as `priceCents`, so the moment this stops being offered
           * is the moment `priceCents` becomes the post-flip number. Clients
           * must never re-derive it from their own clock.
           */
          upcomingPriceChange: upcomingPriceChangeSchema.nullable(),
        })
        .strict(),
    ),
    /**
     * Runtime sellability — mirrors the gate inside
     * `ensureStripeConnectedForPaidCheckout` so the public detail page can
     * hide the Buy CTA when the organizer's Stripe account isn't ready,
     * instead of failing the user at checkout. Free events (no paid
     * ticket types) are always sellable: reason="free". Once the event has
     * ended, reason="sales_closed" (mirrors the checkout-time gate in
     * `ensureEventOnSale`).
     *
     * RETAINED VERBATIM through FR-010's per-type move — same five reasons,
     * same semantics, same value for an unwindowed event. Three live consumers
     * switch on it (the public page's `deriveEventDetailMode`, the web Buy-CTA
     * gate, mobile's `resolveCheckoutPath`) and the reasons it carries are
     * genuinely event-WIDE. Per-TIER state lives on each entry above.
     */
    sellability: z
      .object({
        available: z.boolean(),
        reason: z.enum(EVENT_LEVEL_SELLABILITY_REASONS),
      })
      .strict(),
  })
  .strict();

export type ListEventTicketTypesInput = z.infer<
  typeof listEventTicketTypesInputSchema
>;
export type ListEventTicketTypesOutput = z.infer<
  typeof listEventTicketTypesOutputSchema
>;

export type ListEventTicketTypesDeps = {
  /**
   * `tickets` is here for the per-tier availability count only, through the
   * LOCK-FREE batch read. Nothing on this path may call
   * `lockAndCountCapacityForTicketType` — a public page view must never queue
   * behind a live checkout.
   */
  repos: Pick<Repos, "events" | "seats" | "payees" | "tickets">;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function listEventTicketTypes(
  deps: ListEventTicketTypesDeps,
  rawInput: unknown,
): Promise<ListEventTicketTypesOutput> {
  const logger = deps.logger?.child({ useCase: "listEventTicketTypes" });

  const execute = async () => {
    const input = parseInput(listEventTicketTypesInputSchema, rawInput);

    const event = await deps.repos.events.getById(input.eventId);
    if (!event) {
      throw fail("EVENT_NOT_FOUND");
    }

    if (event.status !== "PUBLISHED") {
      throw fail("EVENT_NOT_ON_SALE");
    }

    // FR-003 (community-managed-event-listings): RSVP events have no ticket
    // types and nothing to sell — return an empty, unsellable list instead
    // of falling through to the owner/payee resolution below. COMMUNITY RSVP
    // rows are ownerless, so there is genuinely no payee to resolve
    // ("no_payee" is literal, and keeps the output schema unchanged); the
    // public page hides the Buy CTA exactly as it does for a broken Stripe
    // setup. Sellability reasons are advisory-only downstream (no fee/split
    // math keys off them).
    if (event.attendanceMode === "RSVP") {
      return listEventTicketTypesOutputSchema.parse({
        eventId: event.id,
        placeLayoutId: event.placeLayoutId ?? null,
        sellability: { available: false, reason: "no_payee" },
        ticketTypes: [],
      });
    }

    const ticketTypes = await deps.repos.events.listTicketTypes(event.id);
    const activeTicketTypes = ticketTypes.filter(
      (ticketType) => ticketType.status === "ACTIVE",
    );

    // Build a quick lookup of seatSectionId → layoutSectionId so the client
    // can join ticket types to PlaceLayout sections without fragile name matching.
    const sectionIds = activeTicketTypes
      .map((tt) => tt.seatSectionId)
      .filter((id): id is string => id != null);

    const sectionLookup = new Map<string, string | null>();
    for (const secId of sectionIds) {
      if (!sectionLookup.has(secId)) {
        const sec = await deps.repos.seats.getSectionById(secId);
        sectionLookup.set(secId, sec?.layoutSectionId ?? null);
      }
    }

    // ── Sellability ────────────────────────────────────────────────────
    // Mirror the gate enforced server-side at checkout
    // (`ensureStripeConnectedForPaidCheckout` in create-checkout.ts) so
    // the public event page can suppress the Buy CTA when the organizer's
    // Stripe account isn't ready. Free events (no paid ticket types) are
    // always sellable.
    // ONE instant for the whole response: the sellability gate, the paid-tier
    // test and every tier's price are read against the same moment, so a flip
    // landing mid-request can't produce a payload that contradicts itself.
    const now = deps.clock.now();
    const effectivePriceById = new Map(
      activeTicketTypes.map((tt) => [
        tt.id,
        resolveUnitPriceCents(tt, { now }),
      ]),
    );

    // Per-tier stock, resolved against that SAME instant so a payload can
    // never pair a price with an availability from the other side of a hold
    // expiry. ONE batched, LOCK-FREE query for every tier — see the helper for
    // why the locking counter must not be reached from a public read.
    const availabilityById = await loadTicketTypeAvailability(deps.repos, {
      ticketTypes: activeTicketTypes,
      now,
    });

    // A tier that will EVER take money — now, after a scheduled flip (FR-005),
    // or at the door — arms this gate from the start, not at T. Reading the
    // effective price at `now` would report `{ available: true, reason: "free" }`
    // for a $0-now / $20-at-T tier right up until the flip, which is both
    // dishonest to the buyer and useless to the organizer: the moment it
    // stopped saying "free" would be the moment checkout started failing.
    // The tier half of what publish-event enforces, so a published event with
    // such a tier has already been required to have a ready payee. Publish
    // also counts a paid seat override on a free FIXED tier
    // (`storedSeatOverridesTakeMoney`); this read does not, on purpose: the
    // verdict here is for the whole event, and the free seats of such an event
    // stay claimable without Stripe. Only the overridden seat fails, at
    // checkout (`STRIPE_NOT_CONNECTED`), when the payee is not ready then.
    const hasPaidTickets = activeTicketTypes.some(isEverPaidTicketType);
    let sellability: EventLevelSellability;
    // Sales close at the event's end (fall back to start if end is missing).
    // This takes precedence over every other reason — an ended event can't
    // be bought regardless of Stripe state or price.
    const salesCloseAt = event.endsAt ?? event.startsAt;
    if (salesCloseAt && now.getTime() >= salesCloseAt.getTime()) {
      sellability = { available: false, reason: "sales_closed" };
    } else if (!hasPaidTickets) {
      sellability = { available: true, reason: "free" };
    } else {
      const subject =
        event.orgId != null
          ? ({ type: "ORGANIZATION", id: event.orgId } as const)
          : event.humanId != null
            ? ({ type: "HUMAN", id: event.humanId } as const)
            : null;
      if (!subject) {
        sellability = { available: false, reason: "no_payee" };
      } else {
        const payeeRef = await deps.repos.payees.getBySubject(subject);
        const payee = payeeRef
          ? await deps.repos.payees.getById(payeeRef.id)
          : null;
        if (
          !payee ||
          payee.status !== "ACTIVE" ||
          !payee.chargesEnabled ||
          !payee.payoutsEnabled
        ) {
          sellability = { available: false, reason: "stripe_not_connected" };
        } else {
          sellability = { available: true, reason: "ok" };
        }
      }
    }

    return listEventTicketTypesOutputSchema.parse({
      eventId: event.id,
      placeLayoutId: event.placeLayoutId ?? null,
      sellability,
      ticketTypes: activeTicketTypes.map((ticketType) => {
        // The helper fills an entry for every tier it was handed, so the
        // fallback is unreachable. It fails CLOSED anyway: on a money path, an
        // unknown stock level must not become an offer.
        const availability = availabilityById.get(ticketType.id);
        return {
          id: ticketType.id,
          name: ticketType.name,
          priceCents: effectivePriceById.get(ticketType.id) ?? 0,
          pricingMode: ticketType.pricingMode ?? "FIXED",
          minimumCents: ticketType.minimumCents ?? null,
          suggestedCents: ticketType.suggestedCents ?? null,
          capacity: ticketType.capacity,
          remainingCapacity: availability?.remainingCapacity ?? 0,
          soldOut: availability?.soldOut ?? true,
          seatSectionId: ticketType.seatSectionId ?? null,
          layoutSectionId: ticketType.seatSectionId
            ? (sectionLookup.get(ticketType.seatSectionId) ?? null)
            : null,
          // Same `now` as the price above: a payload can never quote a price
          // from one side of a flip and an availability from the other.
          sellability: resolveTicketTypeSellability(
            ticketType,
            now,
            sellability,
          ),
          upcomingPriceChange: resolveUpcomingPriceChange(ticketType, now),
        };
      }),
    });
  };

  if (logger) {
    return logger.withTime("listEventTicketTypes", execute);
  }

  return execute();
}
