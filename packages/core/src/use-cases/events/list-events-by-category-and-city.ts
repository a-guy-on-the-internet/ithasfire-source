import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";

import { parseInput } from "../../lib/io";
import { categoryNamesSchema } from "../categories/_shared/category-output";
import { categoryNames } from "@th/types";
import { resolveTimeZone } from "../../lib/venue-local-time";
import { fail } from "@th/errors";
import {
  gateHeroUrl,
  resolveVisibleHeroKeys,
} from "../moderation/gate-image-visibility";
import { parseCitySegment, slugifyCity } from "./_shared/geo-category";
import {
  cardVenueName,
  resolveVenueConfirmationByEvent,
} from "../../lib/venue-confirmation";
import { projectPublicEventLocation } from "../../lib/location/project-public-event-location";
import type { PlaceLocationSource } from "../../lib/location/redact-place-location";
import {
  loadPricingByEventId,
  pricingSummarySchema,
  type PricingSummary,
} from "./_shared/event-pricing";

const categorySummarySchema = z
  .object({
    // `id` (not `eventId`) so the pricing-aware `localEventsToDto` transport
    // mapper can consume this summary directly.
    id: z.string(),
    title: z.string(),
    status: z.string(),
    slug: z.string().nullable(),
    startsAt: z.date(),
    /** `Event.timezone`, resolved: the card's date renders in it, not UTC. */
    timezone: z.string(),
    addressText: z.string().nullable(),
    /** Venue name — only when the venue confirmed the event. */
    placeName: z.string().nullable(),
    regionCode: z.string().nullable(),
    heroImageUrl: z.string().nullable(),
    gateType: z.enum(["NONE", "PASSWORD", "APPLICATION"]).optional(),
    // Drives the "Free" card affordance for RSVP community listings, which
    // carry no ticket types (so the pricing rollup alone is null).
    attendanceMode: z.enum(["TICKETED", "RSVP"]),
    // True when the event carries a recurrence schedule (a single Event that
    // repeats, e.g. a weekly open mic). Surfaces a "Recurring" card affordance.
    isRecurring: z.boolean(),
    pricing: pricingSummarySchema.nullable(),
  })
  .strict();

export const listEventsByCategoryAndCityInputSchema = z
  .object({
    categorySlug: z.string().min(1).max(64),
    citySegment: z.string().min(1).max(96),
    limit: z.number().int().min(1).max(60).default(48),
    offset: z.number().int().min(0).default(0),
  })
  .strict();

export const listEventsByCategoryAndCityOutputSchema = z
  .object({
    events: z.array(categorySummarySchema),
    total: z.number().int().min(0),
    /**
     * Matches that are NOT gated (`gateType = NONE`). The page's robots
     * threshold (`MIN_EVENTS_PER_GEO_CATEGORY_PAGE`) counts these only, as
     * the geo×category sitemap does (every URL it lists is indexable; not
     * every indexable page is listed there); `total` includes
     * gated events, which list but do not make the page worth indexing (owner
     * ruling 2026-10-13).
     */
    indexableTotal: z.number().int().min(0),
    categoryName: z.string(),
    names: categoryNamesSchema,
    cityLabel: z.string(),
    /**
     * Lowercased region of the canonical segment: the request's own region,
     * or, for a region-less request, the one region every match shares (null
     * when they span several). See `resolveSingleRegion`.
     */
    regionCode: z.string().nullable(),
  })
  .strict();

export type ListEventsByCategoryAndCityInput = z.infer<
  typeof listEventsByCategoryAndCityInputSchema
>;
export type ListEventsByCategoryAndCityOutput = z.infer<
  typeof listEventsByCategoryAndCityOutputSchema
>;

export type ListEventsByCategoryAndCityDeps = {
  repos: Pick<
    Repos,
    | "events"
    | "categories"
    | "imageModerationRecords"
    | "places"
    // The all-in card price (`loadPricingByEventId` → fee context + venue situs).
    | "payoutTerms"
    | "feePolicies"
    | "savedLocations"
  >;
  /** Required (FR-003) — `loadPricingByEventId` resolves each tier's price at `now`. */
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Deliberate-swallow reporter (ReporterPort convention). Handed to
   * `resolveVenueConfirmationByEvent`, which degrades a venue whose row
   * cannot be read (not confirmed, fully hidden) instead of failing the
   * page — that degradation must reach Sentry, not only the log.
   */
  reportError?: ReporterPort;
};

const toSummary = (
  record: EventRecord,
  pricing: PricingSummary | null,
  visibleHeroKeys: ReadonlySet<string>,
  /**
   * The venue's name for the card label: the confirmed venue's name, or an
   * unconfirmed COMMUNITY listing's name-only display per
   * `mayNameUnconfirmedVenue` (owner ruling 2026-10-07) — both read from
   * `VenueConfirmationResolution.displayPlaceName`, the same value the search
   * indexer uses. A plain-text label ONLY: never a link, venue id, or
   * confirmed mark.
   */
  displayPlaceName: string | null,
  /** `VenueConfirmationResolution.confirmed` — gates the unconfirmed name on an EXACT public location. */
  venueConfirmed: boolean,
  /**
   * The venue's privacy row from the same batched place read
   * (`VenueConfirmationResolution.placeLocation`); null for no place. The
   * card label goes through the public projection — an OBSCURED event (or
   * one at a withheld venue) prints "locality, region", never its street.
   */
  placeLocation: PlaceLocationSource | null,
) => {
  const location = projectPublicEventLocation(record, { place: placeLocation });
  return categorySummarySchema.parse({
    id: record.id,
    title: record.title,
    status: record.status,
    slug: record.slug ?? null,
    startsAt: record.startsAt,
    timezone: resolveTimeZone(record.timezone),
    addressText: location.label,
    placeName: cardVenueName(displayPlaceName, venueConfirmed, location),
    regionCode: record.regionCode ?? null,
    heroImageUrl: gateHeroUrl(record, visibleHeroKeys),
    gateType: record.gateType !== "NONE" ? record.gateType : undefined,
    attendanceMode: record.attendanceMode,
    isRecurring: record.recurrenceSchedule != null,
    pricing,
  });
};

/** Title-case a space-separated slug fragment for a display fallback. */
const titleCase = (value: string): string =>
  value
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

const TWO_LETTER_REGION = /^[a-z]{2}$/;

/**
 * The one region code every matched event of a region-less city query shares,
 * or null. Reads `regionCode` off the fetched page (a NULL code, even with a
 * free-text `region`, disqualifies). When the page does not hold every match
 * (total > items), one strict count proves the rest: the number of matches
 * whose `lower(regionCode)` equals the candidate — the key the sitemap groups
 * by — must equal the region-less total, so no off-page match carries another
 * code or none at all.
 */
async function resolveSingleRegion(
  deps: ListEventsByCategoryAndCityDeps,
  args: {
    categorySlug: string;
    citySlug: string;
    startsAfter: Date;
    page: { items: EventRecord[]; pageInfo: { total: number } };
  },
): Promise<string | null> {
  const regions = new Set(
    args.page.items.map((record) =>
      (record.regionCode ?? "").trim().toLowerCase(),
    ),
  );
  if (regions.size !== 1) return null;
  const [candidate] = [...regions];
  // A missing or non-2-letter code cannot form a `-<region>` segment.
  if (!candidate || !TWO_LETTER_REGION.test(candidate)) return null;

  if (args.page.items.length >= args.page.pageInfo.total) return candidate;

  const strictTotal =
    await deps.repos.events.countPublishedByCategoryAndCityRegionCode({
      categorySlug: args.categorySlug,
      citySlug: args.citySlug,
      regionCode: candidate,
      startsAfter: args.startsAfter,
    });
  return strictTotal === args.page.pageInfo.total ? candidate : null;
}

/**
 * List upcoming published events for a geo×category landing page. Validates the
 * category is active, decodes the city segment, and returns a summary list plus
 * display labels the page uses for its canonical/robots/heading. Community
 * (ownerless) listings are included — the repo enforces PUBLISHED + PUBLIC +
 * upcoming, never ownership.
 */
export async function listEventsByCategoryAndCity(
  deps: ListEventsByCategoryAndCityDeps,
  rawInput: unknown,
): Promise<ListEventsByCategoryAndCityOutput> {
  const input = parseInput(listEventsByCategoryAndCityInputSchema, rawInput);
  const scopedLogger = deps.logger?.child({
    useCase: "listEventsByCategoryAndCity",
  });

  const execute = async () => {
    const category = await deps.repos.categories.getBySlug(input.categorySlug);
    if (!category || !category.active) {
      throw fail("CATEGORY_NOT_FOUND");
    }

    // ONE instant for the page query and its prices, from the injected clock
    // (as the country listing does).
    const startsAfter = deps.clock.now();
    const parsed = parseCitySegment(input.citySegment);

    let citySlug = parsed.citySlug;
    let region = parsed.region;
    let page = await deps.repos.events.listPublishedByCategoryAndCity({
      categorySlug: input.categorySlug,
      citySlug,
      region,
      limit: input.limit,
      offset: input.offset,
      startsAfter,
    });

    // The trailing-2-letter split is heuristic: a region-less city whose last
    // token is 2 letters (e.g. "foo-ba") false-splits into region "ba". When a
    // region WAS split off but the region-scoped fetch is empty, retry once
    // treating the whole segment as the city slug with no region.
    if (region && page.pageInfo.total === 0) {
      const wholeCitySlug = slugifyCity(input.citySegment);
      const retry = await deps.repos.events.listPublishedByCategoryAndCity({
        categorySlug: input.categorySlug,
        citySlug: wholeCitySlug,
        region: null,
        limit: input.limit,
        offset: input.offset,
        startsAfter,
      });
      if (retry.pageInfo.total > 0) {
        citySlug = wholeCitySlug;
        region = null;
        page = retry;
      }
    }

    // Canonical region (SEO): when EVERY event a region-less request
    // ("nashville") matches has the same 2-letter `regionCode` (compared
    // lowercased; the free-text `region` column is never consulted), return
    // that code so the page's canonical/redirect collapses onto the
    // `-<region>` segment ("nashville-tn"), the URL the sitemap emits for that
    // `lower(regionCode)` group. Then the sitemap has no region-less group for
    // this city, so no listed URL redirects. When the matches span SEVERAL
    // codes (Portland OR + Portland ME), or any match has a NULL or
    // non-2-letter code, we do NOT guess: the region stays null and the
    // region-less segment is itself the canonical page.
    if (!region && page.pageInfo.total > 0) {
      region = await resolveSingleRegion(deps, {
        categorySlug: input.categorySlug,
        citySlug,
        startsAfter,
        page,
      });
    }

    // Prefer the real casing from a matched event; fall back to title-casing
    // the decoded city slug when the page is empty.
    const cityLabel = page.items[0]?.locality?.trim()
      ? (page.items[0].locality as string)
      : titleCase(citySlug.replace(/-/g, " "));

    scopedLogger?.info("events.list_by_category_and_city", {
      categorySlug: input.categorySlug,
      citySegment: input.citySegment,
      citySlug,
      region,
      resultCount: page.items.length,
      total: page.pageInfo.total,
    });

    const pricingByEventId = await loadPricingByEventId(
      deps,
      page.items,
      startsAfter,
      { useCase: "listEventsByCategoryAndCity" },
    );
    const visibleHeroKeys = await resolveVisibleHeroKeys(
      deps.repos,
      page.items,
    );

    const venueConfirmation = await resolveVenueConfirmationByEvent(
      deps,
      page.items,
      { useCase: "listEventsByCategoryAndCity" },
    );

    return listEventsByCategoryAndCityOutputSchema.parse({
      events: page.items.map((record) =>
        toSummary(
          record,
          pricingByEventId.get(record.id) ?? null,
          visibleHeroKeys,
          venueConfirmation.get(record.id)?.displayPlaceName ?? null,
          venueConfirmation.get(record.id)?.confirmed ?? false,
          venueConfirmation.get(record.id)?.placeLocation ?? null,
        ),
      ),
      total: page.pageInfo.total,
      indexableTotal: page.indexableTotal,
      categoryName: category.name,
      names: categoryNames(category),
      cityLabel,
      regionCode: region,
    });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("listEventsByCategoryAndCity", execute);
  }

  return execute();
}
