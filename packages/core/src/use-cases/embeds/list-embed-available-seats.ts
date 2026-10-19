import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";

import { parseInput } from "../../lib/io";
import { quoteSeatPriceOverrides } from "../events/_shared/quote-seat-price-overrides";
import { assertEmbedOriginAllowed } from "./_shared/assert-embed-origin-allowed";
import { assertEventAllowedForEmbed } from "./_shared/is-event-allowed-for-embed";
import { assertEventUngatedForEmbed } from "./_shared/assert-event-ungated-for-embed";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const listEmbedAvailableSeatsInputSchema = z
  .object({
    embedId: z.uuid(),
    eventId: z.uuid(),
    seatSectionId: z.uuid(),
    /**
     * Origin of the page hosting the widget iframe, computed client-side.
     * Enforced against the embed's domain allowlist — null fails closed.
     */
    hostOrigin: z.string().url().nullable(),
  })
  .strict();

const seatItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  row: z.string().nullable(),
  number: z.number().int().nullable(),
  status: z.enum(["AVAILABLE", "HELD", "SOLD", "BLOCKED"]),
  geometry: z.any().nullable(),
  priceOverride: z
    .object({
      priceCents: z.number().int(),
      buyerTotalCents: z.number().int().nonnegative().nullable().optional(),
    })
    .strict()
    .nullable(),
});

export const listEmbedAvailableSeatsOutputSchema = z
  .object({
    section: z.object({
      id: z.string(),
      name: z.string(),
      type: z.enum(["GA", "RESERVED"]),
      capacity: z.number().int().nullable(),
    }),
    seats: z.array(seatItemSchema),
  })
  .strict();

export type ListEmbedAvailableSeatsInput = z.infer<
  typeof listEmbedAvailableSeatsInputSchema
>;
export type ListEmbedAvailableSeatsOutput = z.infer<
  typeof listEmbedAvailableSeatsOutputSchema
>;

export type ListEmbedAvailableSeatsDeps = {
  repos: Pick<
    Repos,
    | "embeds"
    | "events"
    | "seats"
    | "payoutTerms"
    | "feePolicies"
    | "seriesOccurrences"
    // The venue situs decides the taxable base behind the ALL-IN per-seat
    // override price quoted below.
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
  /** Base URL of our own web app; its origin is always allowed to host embeds. */
  publicAppUrl?: string | null;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

export async function listEmbedAvailableSeats(
  deps: ListEmbedAvailableSeatsDeps,
  rawInput: unknown,
): Promise<ListEmbedAvailableSeatsOutput> {
  const logger = deps.logger?.child({ useCase: "listEmbedAvailableSeats" });

  const execute = async () => {
    const input = parseInput(listEmbedAvailableSeatsInputSchema, rawInput);

    // Validate embed
    const embed = await deps.repos.embeds.getById(input.embedId);
    if (!embed || embed.status !== "ACTIVE") {
      throw fail("EMBED_NOT_FOUND");
    }

    assertEmbedOriginAllowed({
      embed,
      hostOrigin: input.hostOrigin,
      publicAppUrl: deps.publicAppUrl,
      logger,
    });

    // Validate event belongs to this embed
    const event = await deps.repos.events.getById(input.eventId, {
      withOwnerStanding: true,
    });
    // A banned owner's event is withheld (ban-that-sticks).
    if (!event || event.status !== "PUBLISHED" || event.ownerBanned === true) {
      throw fail("EVENT_NOT_FOUND");
    }

    await assertEventAllowedForEmbed(deps, embed, event);
    // A gated event's seat map and per-seat prices are page content the
    // embed can never unlock. Refused rather than answered empty: the output
    // has no honest "nothing" (it needs a real section), and the widget never
    // reaches here for a gated event because its detail read lists no tiers.
    assertEventUngatedForEmbed(event);

    // Fetch section info
    const section = await deps.repos.seats.getSectionById(input.seatSectionId);
    if (!section) {
      throw fail("SEAT_SECTION_NOT_FOUND");
    }

    // List all seats for the section (to show the map with statuses)
    const seats = await deps.repos.seats.listAvailableBySection({
      seatSectionId: input.seatSectionId,
      eventId: input.eventId,
    });
    const quotes = await quoteSeatPriceOverrides(
      deps,
      event,
      seats.map((seat) => ({
        id: seat.id,
        seatSectionId: input.seatSectionId,
        priceOverride: seat.priceOverride,
      })),
      logger,
    );

    return listEmbedAvailableSeatsOutputSchema.parse({
      section: {
        id: section.id,
        name: section.name,
        type: section.type,
        capacity: section.capacity,
      },
      seats: seats.map((s) => ({
        id: s.id,
        label: s.label,
        row: s.row,
        number: s.number,
        status: s.status,
        geometry: s.geometry,
        // Explicit fields only: the organizer's private `reason` note never
        // goes out on this read.
        priceOverride: quotes.get(s.id) ?? null,
      })),
    });
  };

  if (logger) {
    return logger.withTime("listEmbedAvailableSeats", execute);
  }
  return execute();
}
