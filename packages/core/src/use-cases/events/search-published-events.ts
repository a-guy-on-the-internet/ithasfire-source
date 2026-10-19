import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, EventRecord } from "@th/ports/repos";
import type { MultiSearchQueryPort } from "@th/ports/search/multi-index.port";
import type { EventSuggestion } from "@th/ports/search/multi-index.types";

import { formatEventMonthDay } from "../../lib/event-local-date";
import { parseInput } from "../../lib/io";
import { projectPublicEventLocation } from "../../lib/location/project-public-event-location";
import type { PlaceLocationSource } from "../../lib/location/redact-place-location";
import { resolveVenueConfirmationByEvent } from "../../lib/venue-confirmation";

const MIN_QUERY_LENGTH = 2;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 12;

const suggestionSchema = z
  .object({
    eventId: z.string().uuid(),
    title: z.string(),
    subtitle: z.string().nullable(),
    helper: z.string().nullable(),
    slug: z.string().nullable(),
  })
  .strict();

export const searchPublishedEventsInputSchema = z
  .object({
    query: z.string().trim().min(MIN_QUERY_LENGTH).max(120),
    limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  })
  .strict();

export const searchPublishedEventsOutputSchema = z
  .object({
    suggestions: z.array(suggestionSchema),
  })
  .strict();

export type SearchPublishedEventsInput = z.infer<
  typeof searchPublishedEventsInputSchema
>;
export type SearchPublishedEventsOutput = z.infer<
  typeof searchPublishedEventsOutputSchema
>;

export type SearchPublishedEventsDeps = {
  repos: Repos;
  logger?: LoggerPort;
  /** Optional Meilisearch-powered search. Falls back to Postgres if not provided. */
  search?: MultiSearchQueryPort | null;
  /**
   * Optional best-effort error reporter. Fired when the Meilisearch backend
   * fails and the use case falls back to Postgres — the fallback keeps the
   * request working, so this failure would otherwise be silent. Never throws
   * into the request path.
   */
  reportError?: ReporterPort;
};

/** "Oct 12" in the event's own zone, never the server's (UTC on Cloud Run). */
const formatHelper = (
  startsAt: Date | null,
  timeZone: string | null | undefined,
): string | null => {
  if (!startsAt) return null;
  try {
    return formatEventMonthDay(startsAt, timeZone);
  } catch {
    return null;
  }
};

const formatLocation = (
  event: EventRecord,
  placeLocation: PlaceLocationSource | null,
): string | null => {
  // THE public projection: an OBSCURED event (or one at a withheld venue)
  // prints "locality, region", never its street.
  const address = projectPublicEventLocation(event, {
    place: placeLocation,
  }).label?.trim();
  if (address) {
    return address;
  }

  const region = event.regionCode?.trim();
  if (region) {
    return region.toUpperCase();
  }

  return null;
};

const toSuggestion = (
  event: EventRecord,
  placeLocation: PlaceLocationSource | null,
) =>
  suggestionSchema.parse({
    eventId: event.id,
    title: event.title,
    subtitle: formatLocation(event, placeLocation),
    helper: formatHelper(event.startsAt ?? null, event.timezone),
    slug: event.slug ?? null,
  });

const meilisearchSuggestionToOutput = (suggestion: EventSuggestion) =>
  suggestionSchema.parse({
    eventId: suggestion.eventId,
    title: suggestion.title,
    subtitle: suggestion.subtitle,
    helper: suggestion.helper,
    slug: suggestion.slug,
  });

export async function searchPublishedEvents(
  deps: SearchPublishedEventsDeps,
  rawInput: unknown,
): Promise<SearchPublishedEventsOutput> {
  const input = parseInput(searchPublishedEventsInputSchema, rawInput);
  const normalizedQuery = input.query.trim();

  if (!normalizedQuery) {
    return { suggestions: [] } satisfies SearchPublishedEventsOutput;
  }

  const nowIso = new Date().toISOString();

  // Try Meilisearch first if available
  if (deps.search) {
    const result = await deps.search.autocomplete({
      query: normalizedQuery,
      limit: input.limit,
      filters: {
        types: ["event"],
        publishedOnly: true,
        dateRange: { from: nowIso },
      },
    });

    if (result.ok) {
      deps.logger?.info("events.search_published_meilisearch", {
        queryLength: normalizedQuery.length,
        limit: input.limit,
        resultCount: result.value.suggestions.length,
        latencyMs: result.value.latencyMs,
      });

      const suggestions = result.value.suggestions
        .filter((s): s is EventSuggestion => s.type === "event")
        .map(meilisearchSuggestionToOutput);

      return searchPublishedEventsOutputSchema.parse({ suggestions });
    }

    // Log error but fall back to Postgres
    deps.logger?.warn("events.search_meilisearch_failed", {
      error: result.error.message,
      fallback: "postgres",
    });
    try {
      deps.reportError?.(result.error, {
        tags: { useCase: "searchPublishedEvents" },
        extra: { fallback: "postgres", queryLength: normalizedQuery.length },
      });
    } catch {
      // Reporting is best-effort — a throwing reporter must never break the
      // Postgres fallback path below.
    }
  }

  // Fallback to Postgres full-text search
  const events = await deps.repos.events.searchPublished({
    query: normalizedQuery,
    limit: input.limit,
    startsAfter: new Date(nowIso),
  });

  deps.logger?.info("events.search_published_postgres", {
    queryLength: normalizedQuery.length,
    limit: input.limit,
    resultCount: events.length,
  });

  // The label is floored by each venue's CURRENT address privacy — one place
  // read per distinct venue.
  const venueResolution = await resolveVenueConfirmationByEvent(
    { repos: deps.repos, logger: deps.logger, reportError: deps.reportError },
    events,
    { useCase: "searchPublishedEvents" },
  );
  const suggestions = events.map((event) =>
    toSuggestion(event, venueResolution.get(event.id)?.placeLocation ?? null),
  );
  return searchPublishedEventsOutputSchema.parse({ suggestions });
}
