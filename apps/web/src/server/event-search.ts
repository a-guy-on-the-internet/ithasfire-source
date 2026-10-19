import "server-only";

import type { SearchPublishedEventsOutput } from "@th/core/use-cases/events";

import { serverRuntimeEnv } from "@/config/env";
import { getSmokeEventSummaries } from "@/server/events";
import { getServerTrpcClient } from "@/server/trpc-client";

const MIN_QUERY_LENGTH = 2;
const SEARCH_LIMIT = 12;

type Suggestions = SearchPublishedEventsOutput["suggestions"];
export type EventSearchSuggestion = Suggestions[number];

const buildSmokeSuggestions = (): EventSearchSuggestion[] =>
  getSmokeEventSummaries().map((summary) => ({
    eventId: summary.id,
    title: summary.title,
    subtitle: summary.venue ?? null,
    helper: summary.date,
    slug: null,
  }));

const normalizeQuery = (value: string): string => value.trim();

export async function searchEventsByQuery(
  query: string,
): Promise<EventSearchSuggestion[]> {
  const normalized = normalizeQuery(query);

  if (serverRuntimeEnv.flags.smokeBuild) {
    const smokeSuggestions = buildSmokeSuggestions();
    if (!normalized) {
      return smokeSuggestions;
    }
    const lowered = normalized.toLowerCase();
    return smokeSuggestions.filter((suggestion) =>
      suggestion.title.toLowerCase().includes(lowered),
    );
  }

  if (normalized.length < MIN_QUERY_LENGTH) {
    return [];
  }

  const client = getServerTrpcClient();
  try {
    const { suggestions } = await client.events.searchPublishedEvents.query({
      query: normalized,
      limit: SEARCH_LIMIT,
    });
    return suggestions;
  } catch (error) {
    console.warn(
      "Unable to load event search results",
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}
