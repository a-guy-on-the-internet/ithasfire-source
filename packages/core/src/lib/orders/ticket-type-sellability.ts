/**
 * PER-TICKET-TYPE sellability — the read-side companion to the enforcement in
 * `door-pricing.ts`, and the shared shape every buyer-facing listing surface
 * returns (FR-010).
 *
 * WHY THIS MODULE EXISTS. Before Phase 2b, "can this be bought?" was answered
 * ONCE PER EVENT: `listEventTicketTypes` returned a single
 * `sellability { available, reason }` with five reasons. Sales windows
 * (FR-009 / packs FR-014) make that shape unable to say the true thing — "this
 * tier isn't on sale yet" is meaningless at event level when a sibling tier is
 * open right now. So availability moves onto the per-type entries, and this is
 * the one place the move is implemented.
 *
 * ADDITIVE, NOT REPLACING — and the per-type answer is COMPLETE.
 *
 *   * The event-level flag STAYS on every payload that had it, byte-identical
 *     for an unwindowed event. Three live consumers read it (the public page's
 *     `deriveEventDetailMode`, the web CTA gate, and mobile's
 *     `resolveCheckoutPath`); breaking them to express a per-tier fact would be
 *     a lot of blast radius for no gain, and the reasons it carries
 *     (`no_payee`, `stripe_not_connected`, event `sales_closed`) are genuinely
 *     event-WIDE — FR-010 says to retain it for exactly those.
 *
 *   * The per-type answer FOLDS THE EVENT-LEVEL REFUSAL IN rather than sitting
 *     beside it. A caller that reads only `ticketTypes[i].sellability` is
 *     CORRECT; it does not have to remember to AND in the event flag. The
 *     alternative — per-type carries only window reasons — means every consumer
 *     re-implements the composition, and the first one that forgets renders a
 *     Buy affordance on a Stripe-broken event. That is the same "two surfaces
 *     disagree" failure class the single price resolver exists to prevent, so
 *     it gets the same treatment: one function, no second opinion.
 *
 * PRECEDENCE. The event-level refusal WINS; the window is consulted only when
 * the event level permits. This is not a new rule — it is the read-side mirror
 * of the enforcement order, where `ensureEventOnSale` runs before
 * `assertTicketTypeOnSale` and both are pure refusals, so the stricter wins.
 * Concretely: an ENDED event whose tier "opens Friday" reports `sales_closed`,
 * never `not_yet_on_sale`, because "opens Friday" would be a lie.
 *
 * NFR-001 HOLDS BY CONSTRUCTION. With `salesOpenAt` and `salesCloseAt` both
 * null — every row that exists today — `resolveTicketTypeSaleState` is a
 * constant `{ onSale: true }`, so the per-type answer is exactly the
 * event-level one and nothing on any surface changes.
 *
 * LAYERING: pure functions, no repo access, no clock of their own. Callers pass
 * `deps.clock.now()`, the same instant they resolve prices at, so a payload can
 * never quote a price from one side of a flip and an availability from the
 * other.
 *
 * Spec: docs/specs/2026-08-10/completed/time-based-ticket-pricing.spec.yaml FR-010,
 * FR-009, Q-002, NFR-001.
 */
import { z } from "zod";

import {
  resolveTicketTypeSaleState,
  type SellableTicketType,
} from "./door-pricing";

// ─────────────────────────────────────────────────────────────────────────────
// Reasons
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reasons that are true of the WHOLE event. Unchanged from the pre-Phase-2b
 * `sellability.reason` enum, deliberately: this is the value existing consumers
 * already read and switch on.
 */
export const EVENT_LEVEL_SELLABILITY_REASONS = [
  "ok",
  "free",
  "no_payee",
  "stripe_not_connected",
  "sales_closed",
] as const;

export type EventLevelSellabilityReason =
  (typeof EVENT_LEVEL_SELLABILITY_REASONS)[number];

/**
 * Reasons a SINGLE tier may report. A superset of the event-level set — an
 * event-wide refusal is still the honest answer for each of its tiers — plus
 * the two window reasons FR-010 introduces.
 */
export const TICKET_TYPE_SELLABILITY_REASONS = [
  ...EVENT_LEVEL_SELLABILITY_REASONS,
  "not_yet_on_sale",
  "sales_ended",
] as const;

export type TicketTypeSellabilityReason =
  (typeof TICKET_TYPE_SELLABILITY_REASONS)[number];

export type EventLevelSellability = {
  available: boolean;
  reason: EventLevelSellabilityReason;
};

export type TicketTypeSellability = {
  /** The COMPLETE answer for this tier: event-wide gates AND its own window. */
  available: boolean;
  reason: TicketTypeSellabilityReason;
  /**
   * The instant this tier opens. Non-null IF AND ONLY IF
   * `reason === "not_yet_on_sale"` — FR-010 asks for the open time to travel
   * with that reason so the buyer gets "come back Friday" rather than a bare
   * refusal. Deliberately not the raw `salesOpenAt` column: a tier that is
   * already open has nothing to invite the buyer back for.
   */
  opensAt: Date | null;
  /**
   * The instant this tier closed. Non-null IF AND ONLY IF
   * `reason === "sales_ended"`. Named to match the `closedAt` field on
   * `TicketTypeSaleState` rather than being renamed in transit — one word, one
   * meaning, nothing to get wrong between the resolver and the wire.
   */
  closedAt: Date | null;
};

/**
 * Zod shape for the per-type sellability object, shared by every payload that
 * carries it so the public page, the embed and the POS till cannot drift into
 * three dialects of the same fact.
 *
 * `.strict()` on purpose: the FR-004 grep invariant explicitly names strict
 * output schemas as the durable defence against a stray spread leaking fields
 * a regex can never see.
 */
export const ticketTypeSellabilitySchema = z
  .object({
    available: z.boolean(),
    reason: z.enum(TICKET_TYPE_SELLABILITY_REASONS),
    opensAt: z.date().nullable(),
    closedAt: z.date().nullable(),
  })
  .strict();

// ─────────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The complete "can this tier be bought at `now`?" answer.
 *
 * @param ticketType the row's sales window (both bounds nullable)
 * @param now        the caller's single evaluation instant, from `ClockPort`
 * @param eventLevel the already-computed event-wide verdict. Pass
 *                   `{ available: true, reason: "ok" }` on surfaces that have
 *                   no event-wide gate — the POS, deliberately, because door
 *                   sales legitimately happen after the event has started and
 *                   cash needs no connected payee.
 */
export function resolveTicketTypeSellability(
  ticketType: SellableTicketType,
  now: Date,
  eventLevel: EventLevelSellability,
): TicketTypeSellability {
  // Event-wide refusal wins — read-side mirror of the enforcement order.
  if (!eventLevel.available) {
    return {
      available: false,
      reason: eventLevel.reason,
      opensAt: null,
      closedAt: null,
    };
  }

  const state = resolveTicketTypeSaleState(ticketType, now);

  if (state.onSale) {
    // No window, or inside it: the tier inherits the event's own verdict, so a
    // free event still reports "free" and an unwindowed tier is byte-identical
    // to today's event-level answer (NFR-001).
    return {
      available: true,
      reason: eventLevel.reason,
      opensAt: null,
      closedAt: null,
    };
  }

  if (state.reason === "not_yet_on_sale") {
    return {
      available: false,
      reason: "not_yet_on_sale",
      opensAt: state.opensAt,
      closedAt: null,
    };
  }

  return {
    available: false,
    reason: "sales_ended",
    opensAt: null,
    closedAt: state.closedAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Upcoming price change (Q-002)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The forward-looking half of a scheduled price change, for buyer-facing
 * urgency copy — "$12 until Fri 3 Oct".
 *
 * Q-002 (RESOLVED) deferred this copy from Phase 1 to Phase 2b precisely so it
 * would land next to the availability states it reads alongside, rather than
 * being bolted onto the ticket list twice.
 *
 * ONLY EVER FORWARD-LOOKING, and that is enforced HERE rather than trusted to
 * each client. `null` once `now >= scheduledPriceAt`, using the same `>=`
 * boundary as `resolveUnitPriceCents`, so the instant the resolver
 * starts returning the post-flip price is the same instant this stops offering
 * "until" copy. A client comparing timestamps against its own clock would get
 * this wrong for exactly the buyers whose clocks are wrong — and would keep
 * advertising "$12 until Friday" beside a $20 price tag.
 *
 * A half-configured row (one field set — rejected at the write boundary, but
 * possible on a legacy row) and an unparseable instant are both INERT, matching
 * how the price resolver treats them. No copy is better than copy derived from
 * a configuration the resolver itself is ignoring.
 */
export type UpcomingPriceChange = {
  /** What an online buyer will pay at or after `at`. */
  toPriceCents: number;
  /** Absolute UTC instant of the flip. Always strictly in the future. */
  at: Date;
};

export function resolveUpcomingPriceChange(
  ticketType: {
    scheduledPriceCents?: number | null;
    scheduledPriceAt?: Date | string | null;
  },
  now: Date,
): UpcomingPriceChange | null {
  const { scheduledPriceCents, scheduledPriceAt } = ticketType;

  // `== null`, never falsy: `scheduledPriceCents: 0` is a real "free after T".
  if (scheduledPriceCents == null || scheduledPriceAt == null) return null;

  const atMs =
    scheduledPriceAt instanceof Date
      ? scheduledPriceAt.getTime()
      : new Date(scheduledPriceAt).getTime();
  if (Number.isNaN(atMs)) return null;

  // At exactly T the new price is already live, so there is nothing "until".
  if (now.getTime() >= atMs) return null;

  return { toPriceCents: scheduledPriceCents, at: new Date(atMs) };
}

/** Zod shape for {@link UpcomingPriceChange}, nullable at every call site. */
export const upcomingPriceChangeSchema = z
  .object({
    toPriceCents: z.number().int(),
    at: z.date(),
  })
  .strict();
