import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { EventRecord } from "@th/ports/repos/events";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { SeatStatus } from "@th/ports/repos/seats";
import type { ReporterPort } from "@th/ports/reporter";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";
import { plainTextMultilineOptional } from "../../lib/sanitize-plain-text";
import {
  ensureActorCanEditSeatPriceOverrides,
  ensureEventIsEditable,
  ensurePaidOverrideGates,
  ensureSectionsSellAtFixedPrice,
  tiersForSections,
  type SectionTiers,
} from "./_shared/seat-price-override-rules";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ceiling of an override, in cents: Postgres INT4.
 *
 * The ticket-type price input (`upsertTicketType` / `updateTicketType`
 * `priceCents`) has no schema maximum; its ceiling is the INT4 column
 * `TicketType.priceCents`, where a larger value fails the write. An override
 * is stored as JSON, which has no such ceiling, but checkout snapshots it into
 * `OrderItem.unitPriceCents`, also INT4. So this is the same bound a tier
 * price has, written down; anything above it could never be charged.
 */
export const MAX_SEAT_PRICE_OVERRIDE_CENTS = 2_147_483_647;

const priceOverrideSchema = z
  .object({
    priceCents: z.number().int().min(0).max(MAX_SEAT_PRICE_OVERRIDE_CENTS),
    reason: plainTextMultilineOptional(200).nullable().optional(),
  })
  .strict();

export const setSeatPriceOverridesInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    eventId: z.uuid(),
    seatIds: z.array(z.uuid()).min(1).max(500),
    /** Pass `null` to clear the override and revert to the ticket-type price. */
    priceOverride: priceOverrideSchema.nullable(),
  })
  .strict();

export const setSeatPriceOverridesOutputSchema = z
  .object({
    eventId: z.uuid(),
    /** Seats whose override was written (set or cleared). */
    updated: z.number().int().min(0),
    /**
     * Requested seats left untouched, by reason. `updated` plus every count
     * here equals the number of DISTINCT seat ids requested.
     *   - `sold`: already sold; they keep the price they were charged.
     *   - `held`: in a buyer's checkout; retry once it ends (minutes).
     *   - `busy`: being bought or edited at this instant (a checkout, the
     *     door, ticket minting, another override edit); retry right away.
     *   - `notFound`: not a seat of this event (deleted, or another event's).
     */
    skipped: z
      .object({
        sold: z.number().int().min(0),
        held: z.number().int().min(0),
        busy: z.number().int().min(0),
        notFound: z.number().int().min(0),
      })
      .strict(),
  })
  .strict();

export type SetSeatPriceOverridesInput = z.infer<
  typeof setSeatPriceOverridesInputSchema
>;
export type SetSeatPriceOverridesOutput = z.infer<
  typeof setSeatPriceOverridesOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type SetSeatPriceOverridesDeps = {
  repos: Repos;
  /** Fee-policy scope walk for the free→paid gate (`updateTicketType`'s). */
  clock: ClockPort;
  logger?: LoggerPort;
  /** Forwarded to the fee-policy scope walk, which reports what it swallows. */
  reportError?: ReporterPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sets (or clears) an absolute per-seat price override for a set of seats.
 *
 * ── FR-004 DECISION: a seat override REPLACES the schedule; it does not
 *    compose with it. ────────────────────────────────────────────────────────
 *
 * FR-004's site inventory flags this file, but there is NOTHING here to migrate:
 * the only `priceCents` in this module is the INPUT field of the override the
 * organizer is writing (`priceOverrideSchema.priceCents`). This use case never
 * reads `TicketType.priceCents`, so there is no price-read site to route
 * through the resolver.
 *
 * The design question the inventory is really asking — does a per-seat override
 * compose with a scheduled flip, and in what order? — is answered REPLACES:
 *
 *   - A seat override is an absolute cents amount the operator typed for ONE
 *     seat ("front row is $50", "this seat is comped at $0"), usually with a
 *     `reason` attached. It is a deliberate, seat-specific decision.
 *   - A schedule is a blanket statement about the TIER. Letting the two compose
 *     — e.g. applying the flip's delta to the override, or flipping the
 *     override by the same ratio — would silently move a number the operator
 *     wrote down by hand, at a moment they did not choose.
 *   - There is no second override field to flip to, and adding one is a
 *     seat-level rerun of the whole schedule feature. Out of scope.
 *
 * So the precedence is: seat override (if present) > scheduled price > list
 * price, on a FIXED tier; an ADJUSTABLE (pay-what-you-want) tier ignores the
 * override and charges the buyer's amount.
 *
 * WHAT A WRITE HERE DOES AT CHECKOUT (docs/specs/2026-08-12/
 * seat-price-overrides.spec.yaml). The override is CHARGED, not just shown:
 * `computeOrderAmounts` prices every seated line through
 * `resolveSeatUnitPriceCents` (lib/orders/seat-pricing.ts), and the result is
 * the seat's `OrderItem.unitPriceCents`, which refunds, resale face value and
 * the wallet pass read. Checkout reads the override before taking any seat
 * lock, then `holdSeatsForCheckout` re-reads the seat FOR UPDATE and refuses
 * the order with `seat_price_changed` if a write from here landed in between,
 * so an edit can never silently re-price a buyer mid-checkout. Overridden
 * seats are never auto-assigned (online or at the door); they sell only by
 * explicit pick.
 *
 * ── WRITE RULES (spec FR-006, D-004) ───────────────────────────────────────
 *
 *   1. SEAT STATUS: skip and report. Only AVAILABLE and BLOCKED seats are
 *      written, for a set and a clear alike. SOLD seats keep the price they
 *      were charged; HELD seats are in a buyer's checkout, which was priced
 *      with the current override. The seats are locked WITHOUT WAITING
 *      (`lockSeatsForPriceOverrideWrite`: Seat rows only, fixed order, SKIP
 *      LOCKED): a seat another transaction holds at this instant is counted
 *      `busy` and left alone. So this bulk edit never waits on a row lock and
 *      cannot deadlock with checkout, the door or mint; and because every
 *      written seat is locked first, the counts are exactly what the UPDATE
 *      (which carries the same status predicate) left alone.
 *   2. SECTION TIER, judged on the seats being WRITTEN only (a sold or busy
 *      seat is not re-priced, so its section cannot refuse the edit). Setting
 *      an override (not clearing one) is refused unless each of those
 *      sections sells through FIXED tiers only:
 *        - any ADJUSTABLE (pay-what-you-want) tier on the section →
 *          `SEAT_PRICE_OVERRIDE_ADJUSTABLE_TIER`. That buyer names the price
 *          and the override would never be charged (D-004), even when a FIXED
 *          tier shares the section;
 *        - no FIXED tier → `SEAT_PRICE_OVERRIDE_NO_FIXED_TIER`.
 *      WHICH tiers count depends on the event. PUBLISHED: ACTIVE tiers only.
 *      DRAFT: every tier, because a draft's tiers are all stored INACTIVE
 *      (read as "DRAFT") and publish activates every one of them
 *      (`activateDraftTicketTypes`). The port cannot tell an archived tier
 *      from an inactive one (both read "DRAFT"), and nothing writes an
 *      archived tier today; counting them is the safe reading: an archived
 *      ADJUSTABLE tier over-refuses, an archived FIXED tier at worst allows an
 *      override on a seat that no tier will sell.
 *      Clearing (`priceOverride: null`) is always allowed, so an organizer can
 *      remove a legacy override the read side already ignores.
 *      The authz gate, the editable-status rule, this section rule and the
 *      paid-seat gates of rule 4 live in `_shared/seat-price-override-rules.ts`,
 *      which the editor's read (`listEventSeatPriceOverridesForEdit`) uses
 *      too: its `overrideRefusal` is this rule and its `paidOverrideBlockedBy`
 *      is rule 4, from the same predicates and the same gate functions.
 *   3. CAP. `priceCents` is at most `MAX_SEAT_PRICE_OVERRIDE_CENTS`, the same
 *      INT4 ceiling a tier price has (`invalid_input`).
 *   4. PAID SEAT ON A FREE TIER. A paid override (> 0) on a seat whose section
 *      has a free FIXED tier is the same free→paid flip `updateTicketType`
 *      gates, so it passes the same two gates in the same order:
 *      `PAID_TICKETING_REQUIRES_STRIPE` (no linked Connect account) then
 *      `PAID_TICKETING_REQUIRES_FEE_POLICY`. A section whose tiers already
 *      take money passed them when the tier was priced. Like the tier gate,
 *      this asks for a linked account, not charge capability.
 */
export async function setSeatPriceOverrides(
  deps: SetSeatPriceOverridesDeps,
  rawInput: unknown,
): Promise<SetSeatPriceOverridesOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "setSeatPriceOverrides" });

  const execute = async (): Promise<SetSeatPriceOverridesOutput> => {
    const input = parseInput(setSeatPriceOverridesInputSchema, rawInput);

    const result = await deps.repos.tx(async (tx) => {
      // 1. Validate event exists
      const event = await tx.events.getById(input.eventId);
      if (!event) {
        throw fail("EVENT_NOT_FOUND");
      }

      // 2. Authz
      await ensureActorCanEditSeatPriceOverrides(
        tx,
        event,
        input.actorHumanId,
      );

      // 3. Event must be editable
      ensureEventIsEditable(event);

      // 4. Lock the requested seats of THIS event without waiting (rule 1).
      //    A locked seat cannot turn HELD or SOLD before the UPDATE; a seat
      //    another transaction holds right now comes back `busy`.
      const seatIds = Array.from(new Set(input.seatIds));
      const seats = await tx.seats.lockSeatsForPriceOverrideWrite({
        seatIds,
        eventId: event.id,
      });

      // 5. Split: write only locked, re-priceable seats; count the rest.
      const writable: Array<{ id: string; seatSectionId: string }> = [];
      const skipped = { sold: 0, held: 0, busy: 0, notFound: 0 };
      for (const seat of seats) {
        if (seat.busy) {
          skipped.busy += 1;
          continue;
        }
        if (countSkip(seat.status, skipped)) continue;
        writable.push(seat);
      }
      skipped.notFound = seatIds.length - seats.length;

      // 6. Section tier rules + the free→paid gates, on the written seats
      //    only (rules 2 and 4; setting only).
      if (input.priceOverride !== null && writable.length > 0) {
        const tiers = tiersForSections(
          event,
          await tx.events.listTicketTypes(event.id),
          new Set(writable.map((seat) => seat.seatSectionId)),
        );
        ensureSectionsSellAtFixedPrice(tiers);
        // The organizer's typed amount compared to zero; never charged here.
        if (input.priceOverride.priceCents > 0) {
          await ensurePaidSeatsCanSell(deps, tx, event, tiers, scopedLogger);
        }
      }

      const updated =
        writable.length === 0
          ? 0
          : await tx.seats.updatePriceOverrides({
              seatIds: writable.map((seat) => seat.id),
              eventId: event.id,
              priceOverride: input.priceOverride,
            });

      // 7. Audit log
      await tx.audit.log({
        entity: "event",
        entityId: event.id,
        action: "seat_price_overrides_set",
        data: {
          actorHumanId: input.actorHumanId,
          seatCount: seatIds.length,
          updated,
          skipped,
          priceOverride: input.priceOverride,
        },
      });

      return { eventId: event.id, updated, skipped };
    });

    return setSeatPriceOverridesOutputSchema.parse(result);
  };

  if (scopedLogger) {
    return scopedLogger.withTime("setSeatPriceOverrides", execute);
  }

  return execute();
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether a write must leave this seat alone, counting it if so. SOLD seats
 * keep the price they were charged; HELD seats belong to a live checkout that
 * was priced with the current override. BLOCKED seats are off sale with no
 * buyer, so the organizer may price them ahead of releasing them. The
 * adapter's UPDATE carries the same predicate (SeatsRepo.updatePriceOverrides).
 */
function countSkip(
  status: SeatStatus,
  skipped: { sold: number; held: number },
): boolean {
  switch (status) {
    case "AVAILABLE":
    case "BLOCKED":
      return false;
    case "SOLD":
      skipped.sold += 1;
      return true;
    case "HELD":
      skipped.held += 1;
      return true;
    default: {
      // A new SeatStatus must decide here whether it may be re-priced.
      const unhandled: never = status;
      throw fail("INTERNAL", {
        message: "seat_status_unhandled",
        meta: { status: String(unhandled) },
      });
    }
  }
}

/**
 * A paid override on a section with a FREE tier makes that tier take money:
 * the free→paid flip `updateTicketType` gates. Same predicates, same order
 * (Stripe first, so a seat missing both reports the same code as the tier
 * editor would). Sections whose tiers already take money passed both gates
 * when they were priced.
 */
async function ensurePaidSeatsCanSell(
  deps: SetSeatPriceOverridesDeps,
  tx: TxRepos,
  event: EventRecord,
  bySection: SectionTiers,
  logger: LoggerPort | undefined,
): Promise<void> {
  await ensurePaidOverrideGates(
    tx,
    event,
    [...bySection.values()].flat(),
    deps.clock.now(),
    {
      logger,
      reportError: deps.reportError,
      source: "setSeatPriceOverrides",
    },
  );
}
