import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { assertEmbedOriginAllowed } from "./_shared/assert-embed-origin-allowed";
import { fail } from "@th/errors";

export const getBookingWidgetInputSchema = z
  .object({
    embedId: z.uuid(),
    /**
     * Origin of the page hosting the widget iframe, computed client-side.
     * Enforced against the embed's domain allowlist — null fails closed.
     */
    hostOrigin: z.string().url().nullable(),
  })
  .strict();

export const getBookingWidgetOutputSchema = z
  .object({
    embed: z.object({
      id: z.string(),
      subjectType: z.string(),
      domain: z.string(),
    }),
    place: z.object({
      id: z.string(),
      name: z.string(),
      city: z.string().nullable(),
      region: z.string().nullable(),
    }),
    /**
     * VERIFIED && acceptsBookingRequests. When false the iframe renders a calm
     * "not accepting requests" state — deliberately NOT an error, so a venue
     * that pauses bookings (or is mid-verification) never shows a broken
     * widget on their own website. createBookingInquiry re-checks the same
     * gates server-side regardless of this flag.
     */
    accepting: z.boolean(),
  })
  .strict();

export type GetBookingWidgetInput = z.infer<typeof getBookingWidgetInputSchema>;
export type GetBookingWidgetOutput = z.infer<
  typeof getBookingWidgetOutputSchema
>;

export type GetBookingWidgetDeps = {
  repos: Pick<Repos, "embeds" | "places" | "calendars">;
  /** Base URL of our own web app; its origin is always allowed to host embeds. */
  publicAppUrl?: string | null;
  logger?: LoggerPort;
};

/**
 * Resolve the display info the /embed/book iframe needs: embed summary, place
 * summary, and whether the place currently accepts booking requests
 * (spec 2026-07-13 booking-request-embed-button FR-002 backend half).
 *
 * Fail-closed on origin (NFR-001): a REVOKED embed, a null/unparseable
 * hostOrigin, or a non-allowlisted domain all reject before any place data is
 * read. Only "place" embeds are served — other subject types get the same
 * UNSUPPORTED_SUBJECT_TYPE rejection as the sibling widget reads.
 */
export async function getBookingWidget(
  deps: GetBookingWidgetDeps,
  rawInput: unknown,
): Promise<GetBookingWidgetOutput> {
  const logger = deps.logger?.child({ useCase: "getBookingWidget" });

  const execute = async () => {
    const input = parseInput(getBookingWidgetInputSchema, rawInput);

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

    if (embed.subjectType !== "place") {
      throw fail("UNSUPPORTED_SUBJECT_TYPE");
    }

    const place = await deps.repos.places.getById(embed.subjectId);
    if (!place) {
      throw fail("PLACE_NOT_FOUND");
    }

    // Availability-onboarding FR-005 (docs/specs/2026-08-31): an unconfigured
    // place (zero CalendarAvailability rows) publicly reads as not accepting —
    // the widget shows the same calm "not accepting requests" state as a
    // paused venue, leaking nothing about why. Short-circuited so the count
    // only runs for a venue that would otherwise render the form.
    const accepting =
      place.verificationStatus === "VERIFIED" &&
      place.acceptsBookingRequests &&
      (await deps.repos.calendars.countAvailabilityForPlace(place.id)) > 0;

    return {
      embed: {
        id: embed.id,
        subjectType: embed.subjectType,
        domain: embed.domain,
      },
      place: {
        id: place.id,
        name: place.name,
        city: place.city,
        region: place.region,
      },
      accepting,
    };
  };

  if (logger) {
    return logger.withTime("getBookingWidget", execute);
  }
  return execute();
}
