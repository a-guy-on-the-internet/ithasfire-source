import type { EventSlugContext } from "@th/ports/repos/events";
import { fail } from "@th/errors";

import {
  slugSegment,
  sanitizeText,
  sanitizeCountryCode,
  truncate,
  deriveShortIdFromUuid,
  sanitizeShortId,
} from "../../../lib/slug-utils";
import { resolveTimeZone, toLocalParts } from "../../../lib/venue-local-time";

export type GeneratedEventSlug = {
  slug: string;
  shortId: string;
  regionCode: string | null;
};

const HOST_FALLBACK = "event";
const REGION_FALLBACK = "general";
const TITLE_FALLBACK = "event";
const MAX_SEGMENT_LENGTH = 64;
const MAX_TITLE_LENGTH = 96;

export function generateEventSlug(
  context: EventSlugContext,
): GeneratedEventSlug {
  // A valid location (at minimum a country code) is required to generate a slug.
  if (!context.countryCode) {
    throw fail("EVENT_LOCATION_REQUIRED");
  }

  // The host segment is the ORG's name or the neutral `event` — never a
  // person's. An event owned by a person (no org) used to put their real
  // `Human.name` here, and name + city + date in a public URL is a
  // people-search lead to a home address: exactly what a venue hiding its
  // address is trying to prevent. `EventSlugContext` deliberately carries no
  // human name at all, so it cannot creep back in through this function.
  // Existing person-owned slugs were moved by migration
  // 20260925200000_event_slug_host_person_history/_rewrite (old slug kept in
  // `EventSlugHistory`, so old links redirect).
  const hostSegment = slugSegment(
    context.orgName,
    HOST_FALLBACK,
    MAX_SEGMENT_LENGTH,
  );
  const countrySegment = sanitizeCountryCode(context.countryCode);
  const regionSource = context.cityOrRegionCode ?? context.regionCode;
  const regionSegment = slugSegment(
    regionSource,
    REGION_FALLBACK,
    MAX_SEGMENT_LENGTH,
  );
  const titleSegment = slugSegment(
    context.eventTitle,
    TITLE_FALLBACK,
    MAX_TITLE_LENGTH,
  );
  const dateSegment = formatEventSlugDateSegment(
    context.startsAt,
    context.timezone,
  );
  const shortId = ensureShortId(context);

  const slug = `${hostSegment}/${countrySegment}/${regionSegment}/${titleSegment}-${dateSegment}--${shortId}`;

  const regionCode = context.regionCode ?? context.cityOrRegionCode ?? null;

  return {
    slug,
    shortId,
    regionCode,
  };
}

/**
 * The event's LOCAL wall-clock start as `YYYY-MM-DD-HHmm`, in the event's own
 * zone. A 7pm CDT show is 00:00 UTC the next day, so formatting the UTC
 * instant put the wrong date in every evening event's URL. The zone is
 * explicit, so the output does not depend on the machine's TZ. An unknown or
 * empty zone falls back to `DEFAULT_VENUE_TIMEZONE` (`resolveTimeZone`).
 *
 * Exported for `correctEventSlugDates`, which renders the same instant in
 * "UTC" to recognise a slug minted before the fix.
 */
export function formatEventSlugDateSegment(
  date: Date,
  timeZone: string | null | undefined,
): string {
  const { date: localDate, minutes } = toLocalParts(
    date,
    resolveTimeZone(timeZone),
  );
  const hours = pad2(Math.floor(minutes / 60));
  const mins = pad2(minutes % 60);
  return `${localDate}-${hours}${mins}`;
}

function ensureShortId(context: EventSlugContext): string {
  const candidate = context.shortId ? sanitizeShortId(context.shortId) : null;
  if (candidate) {
    return candidate;
  }

  return deriveShortIdFromUuid(context.eventId);
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

export function testablesForSlugGeneration() {
  return {
    slugSegment,
    sanitizeText,
    sanitizeCountryCode,
    formatDateSegment: formatEventSlugDateSegment,
    ensureShortId,
    deriveShortIdFromEventId: deriveShortIdFromUuid,
    sanitizeShortId,
  };
}
