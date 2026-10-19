import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";

import { parseInput } from "../../lib/io";
import { projectPublicEventLocation } from "../../lib/location/project-public-event-location";
import type { PlaceLocationSource } from "../../lib/location/redact-place-location";
import { resolveVenueConfirmationByEvent } from "../../lib/venue-confirmation";
import { resolveTimeZone } from "../../lib/venue-local-time";
import { fail } from "@th/errors";
import {
  gateHeroUrl,
  resolveVisibleHeroKeys,
} from "../moderation/gate-image-visibility";

const categorySummarySchema = z
  .object({
    eventId: z.string(),
    title: z.string(),
    status: z.string(),
    slug: z.string().nullable(),
    startsAt: z.date(),
    /** `Event.timezone`, resolved: the card's date renders in it, not UTC. */
    timezone: z.string(),
    addressText: z.string().nullable(),
    regionCode: z.string().nullable(),
    heroImageUrl: z.string().nullable(),
    /**
     * Set only for a gated event (PASSWORD / APPLICATION), as in
     * `listEventsByCategoryAndCity`. The card shows the gate, and the
     * category page leaves gated events out of its ItemList JSON-LD (their
     * own pages are noindex).
     */
    gateType: z.enum(["PASSWORD", "APPLICATION"]).optional(),
  })
  .strict();

export const listEventsByCategoryInputSchema = z
  .object({
    categorySlug: z.string().min(1).max(64),
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).default(0),
  })
  .strict();

export const listEventsByCategoryOutputSchema = z
  .object({
    events: z.array(categorySummarySchema),
    total: z.number().int().min(0),
    /**
     * Upcoming listed events that are NOT gated (`countIndexableByCategory`).
     * The page is indexable when this is at least 1; `total` counts gated
     * events too, which list but do not make the page worth indexing (owner
     * ruling 2026-10-13). The category sitemap uses the same rule.
     */
    indexableTotal: z.number().int().min(0),
  })
  .strict();

export type ListEventsByCategoryInput = z.infer<
  typeof listEventsByCategoryInputSchema
>;
export type ListEventsByCategoryOutput = z.infer<
  typeof listEventsByCategoryOutputSchema
>;

export type ListEventsByCategoryDeps = {
  repos: Pick<
    Repos,
    "events" | "categories" | "imageModerationRecords" | "places"
  >;
  logger?: LoggerPort;
  /**
   * Deliberate-swallow reporter: a failed venue read renders that venue's
   * events with the coarse label only (fail closed) instead of failing the
   * list — see `resolveVenueConfirmationByEvent`.
   */
  reportError?: ReporterPort;
};

const toSummary = (
  record: EventRecord,
  visibleHeroKeys: ReadonlySet<string>,
  /**
   * The venue's privacy row (`VenueConfirmationResolution.placeLocation`);
   * null for no place. The card label goes through the public projection —
   * an OBSCURED event (or one at a withheld venue) never prints its street.
   */
  placeLocation: PlaceLocationSource | null,
) =>
  categorySummarySchema.parse({
    eventId: record.id,
    title: record.title,
    status: record.status,
    slug: record.slug ?? null,
    startsAt: record.startsAt,
    timezone: resolveTimeZone(record.timezone),
    addressText: projectPublicEventLocation(record, { place: placeLocation })
      .label,
    regionCode: record.regionCode ?? null,
    heroImageUrl: gateHeroUrl(record, visibleHeroKeys),
    gateType:
      record.gateType && record.gateType !== "NONE"
        ? record.gateType
        : undefined,
  });

export async function listEventsByCategory(
  deps: ListEventsByCategoryDeps,
  rawInput: unknown,
): Promise<ListEventsByCategoryOutput> {
  const input = parseInput(listEventsByCategoryInputSchema, rawInput);
  const scopedLogger = deps.logger?.child({ useCase: "listEventsByCategory" });

  const execute = async () => {
    // Verify the category exists and is active.
    const category = await deps.repos.categories.getBySlug(input.categorySlug);
    if (!category || !category.active) {
      throw fail("CATEGORY_NOT_FOUND");
    }

    // ONE instant for the listing and its indexability count.
    const startsAfter = new Date();
    const [page, indexableTotal] = await Promise.all([
      deps.repos.events.filterByCategory({
        categorySlug: input.categorySlug,
        limit: input.limit,
        offset: input.offset,
        startsAfter,
      }),
      deps.repos.events.countIndexableByCategory({
        categorySlug: input.categorySlug,
        startsAfter,
      }),
    ]);

    scopedLogger?.info("categories.list_events", {
      categorySlug: input.categorySlug,
      limit: input.limit,
      offset: input.offset,
      resultCount: page.items.length,
      total: page.pageInfo.total,
      indexableTotal,
    });

    const visibleHeroKeys = await resolveVisibleHeroKeys(
      deps.repos,
      page.items,
    );

    // One place read per distinct venue: the label is floored by the venue's
    // CURRENT address privacy, not by what the event row says.
    const venueResolution = await resolveVenueConfirmationByEvent(
      deps,
      page.items,
      { useCase: "listEventsByCategory" },
    );

    return listEventsByCategoryOutputSchema.parse({
      events: page.items.map((record) =>
        toSummary(
          record,
          visibleHeroKeys,
          venueResolution.get(record.id)?.placeLocation ?? null,
        ),
      ),
      total: page.pageInfo.total,
      indexableTotal,
    });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("listEventsByCategory", execute);
  }

  return execute();
}
