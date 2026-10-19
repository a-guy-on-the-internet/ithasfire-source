import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";
import { parseInput } from "../../lib/io";
import { quoteSeatPriceOverrides } from "./_shared/quote-seat-price-overrides";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const listEventSeatAvailabilityInputSchema = z
  .object({
    eventId: z.uuid(),
  })
  .strict();

export const listEventSeatAvailabilityOutputSchema = z
  .object({
    eventId: z.uuid(),
    seats: z.array(
      z
        .object({
          id: z.string().uuid(),
          seatSectionId: z.string().uuid(),
          status: z.enum(["AVAILABLE", "HELD", "SOLD", "BLOCKED"]),
          label: z.string(),
          row: z.string().nullable(),
          number: z.number().int().nullable(),
          priceOverride: z
            .object({
              priceCents: z.number().int(),
              buyerTotalCents: z
                .number()
                .int()
                .nonnegative()
                .nullable()
                .optional(),
            })
            .strict()
            .nullable()
            .optional(),
        })
        .strict(),
    ),
  })
  .strict();

export type ListEventSeatAvailabilityInput = z.infer<
  typeof listEventSeatAvailabilityInputSchema
>;
export type ListEventSeatAvailabilityOutput = z.infer<
  typeof listEventSeatAvailabilityOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type ListEventSeatAvailabilityDeps = {
  repos: Pick<
    Repos,
    // `places` / `savedLocations`: a per-seat price OVERRIDE is quoted ALL-IN
    // here, and the venue situs decides the taxable base that all-in number is
    // built from. The same map takes its non-override seat prices from
    // `getCheckoutFeeRates`, which IS base-aware — leaving this side on the
    // default put two identical $25 seats on one map at $29.09 and $29.25, with
    // the override one under the charge (and ~$4 under on a $500 override seat).
    | "events"
    | "seats"
    | "payoutTerms"
    | "feePolicies"
    | "places"
    | "savedLocations"
  >;
  /**
   * Required (FR-003) — the one instant a seat override is quoted at, through
   * the same per-seat resolver the charge uses.
   */
  clock: ClockPort;
  /** Called when a corrupt stored override is shown as no override. */
  reportError?: ReporterPort;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Public use case to fetch seat-level availability for a published event.
 *
 * Returns each seat with its current status so the checkout seat picker can
 * render available / held / sold / blocked states. The output deliberately
 * omits order IDs and other sensitive information.
 */
export async function listEventSeatAvailability(
  deps: ListEventSeatAvailabilityDeps,
  rawInput: unknown,
): Promise<ListEventSeatAvailabilityOutput> {
  const logger = deps.logger?.child({ useCase: "listEventSeatAvailability" });

  const execute = async () => {
    const input = parseInput(listEventSeatAvailabilityInputSchema, rawInput);

    const event = await deps.repos.events.getById(input.eventId);
    if (!event) {
      throw fail("EVENT_NOT_FOUND");
    }

    if (event.status !== "PUBLISHED") {
      throw fail("EVENT_NOT_ON_SALE");
    }

    const seatRecords = await deps.repos.seats.listByEvent({
      eventId: input.eventId,
    });
    const quotes = await quoteSeatPriceOverrides(
      deps,
      event,
      seatRecords,
      logger,
    );

    return listEventSeatAvailabilityOutputSchema.parse({
      eventId: input.eventId,
      seats: seatRecords.map((seat) => ({
        id: seat.id,
        seatSectionId: seat.seatSectionId,
        status: seat.status,
        label: seat.label,
        row: seat.row,
        number: seat.number,
        // Explicit fields only: the organizer's private `reason` note never
        // goes out on this public read.
        priceOverride: quotes.get(seat.id) ?? null,
      })),
    });
  };

  if (logger) {
    return logger.withTime("listEventSeatAvailability", execute);
  }

  return execute();
}
