export const SEARCH_PORT_ERROR_CODES = [
  "invalid_input",
  "not_found",
  "forbidden",
  "dependency_failed",
  "transient",
  "unimplemented",
] as const;

export type SearchPortErrorCode = (typeof SEARCH_PORT_ERROR_CODES)[number];

export interface SearchPortErrorOptions {
  readonly details?: unknown;
  readonly cause?: unknown;
}

function isSearchPortErrorCode(code: unknown): code is SearchPortErrorCode {
  return (
    typeof code === "string" &&
    (SEARCH_PORT_ERROR_CODES as readonly string[]).includes(code)
  );
}

export class SearchPortError extends Error {
  readonly code: SearchPortErrorCode;
  readonly details?: unknown;

  constructor(
    code: SearchPortErrorCode,
    message: string,
    options?: SearchPortErrorOptions,
  ) {
    if (!isSearchPortErrorCode(code)) {
      throw new TypeError(`invalid SearchPortErrorCode: ${String(code)}`);
    }
    super(message, { cause: options?.cause });
    this.code = code;
    this.details = options?.details;
    this.name = "SearchPortError";
  }
}

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export type TicketAvailability = {
  status: "AVAILABLE" | "LOW" | "SOLD_OUT" | "UNKNOWN";
  remaining?: number;
  lastUpdatedAt?: Date | null;
};

export type SearchDocument = {
  eventId: string;
  slug: string | null;
  orgId: string | null;
  ownerType: "ORG" | "HUMAN";
  ownerHumanId: string | null;
  title: string;
  artists: string[];
  tags: string[];
  venueId: string | null;
  venueName: string | null;
  addressText: string | null;
  city: string | null;
  regionCode: string | null;
  countryCode: string | null;
  lat: number | null;
  lng: number | null;
  startsAt: Date | null;
  endsAt: Date | null;
  status: "DRAFT" | "PUBLISHED" | "HIDDEN";
  popularityScore: number;
  recencyScore: number;
  summary: string | null;
  embeddingVersion: string;
  embeddingVector: number[] | null;
  ticketAvailability?: TicketAvailability;
};

export type SearchSuggestion = {
  eventId: string;
  slug?: string | null;
  title: string;
  subtitle?: string | null;
  helper?: string | null;
  matchReason?: "title" | "artist" | "venue" | "city" | "semantic";
  confidence: number;
};

export type SearchResultLocation = {
  venueId?: string | null;
  venueName?: string | null;
  addressText?: string | null;
  city?: string | null;
  regionCode?: string | null;
  countryCode?: string | null;
  lat?: number | null;
  lng?: number | null;
};

export type SearchResult = {
  eventId: string;
  slug?: string | null;
  title: string;
  snippet?: string | null;
  badges?: string[];
  location?: SearchResultLocation;
  startsAt?: Date | null;
  endsAt?: Date | null;
  status?: "DRAFT" | "PUBLISHED" | "HIDDEN";
  matchReasons: string[];
  score: number;
  sgrank?: number;
  confidence: number;
  ticketAvailability?: TicketAvailability;
  document?: SearchDocument;
};

export type QueryFilters = {
  orgId?: string;
  ownerHumanId?: string;
  venueId?: string;
  status?: Array<"PUBLISHED" | "HIDDEN">;
  dateRange?: { gte?: Date; lte?: Date };
  regionCodes?: string[];
  tags?: string[];
  geo?: { lat: number; lng: number; radiusKm: number };
};

export type QueryContext = {
  requestId?: string;
  actorId?: string;
  ip?: string;
  userAgent?: string;
  traceId?: string;
};

export type SearchAutocompleteInput = {
  query: string;
  limit?: number;
  filters?: QueryFilters;
  context?: QueryContext;
};

export type SearchAutocompleteOutput = {
  suggestions: SearchSuggestion[];
  latencyMs: number;
};

export type SearchQueryInput = {
  query: string;
  limit?: number;
  offset?: number;
  filters?: QueryFilters;
  context?: QueryContext;
  includeFacets?: boolean;
  includeAvailability?: boolean;
};

export type SearchFacetBuckets = Record<
  string,
  Array<{ label: string; count: number }>
>;

export type SearchQueryResult = {
  results: SearchResult[];
  facets?: SearchFacetBuckets;
  latencyMs: number;
};

export type SearchRelatedInput = {
  eventId: string;
  limit?: number;
  context?: QueryContext;
};

export type SearchRelatedResult = {
  results: SearchResult[];
};

export type SearchIndexUpsertInput = {
  documents: SearchDocument[];
  mode?: "merge" | "replace";
  traceId?: string;
};

export type SearchIndexUpsertOutput = {
  indexed: number;
  failed: number;
  failureReasons?: Record<string, string>;
};

export type SearchIndexDeleteInput = {
  eventIds?: string[];
  orgId?: string;
  slug?: string;
};

export type SearchIndexDeleteOutput = {
  deleted: number;
};

export type SearchIndexRefreshOutput = {
  refreshedAt: Date;
};

export type SearchTelemetryInteractionInput = {
  query: string;
  suggestionId?: string;
  eventId?: string;
  action: "view" | "click" | "purchase";
  context?: QueryContext & { latencyMs?: number; rank?: number };
};

export type SearchTelemetryInteractionResult = {
  recorded: boolean;
};

export type SearchPromptListInput = {
  orgId?: string;
  ownerHumanId?: string;
  regionCode?: string;
  limit?: number;
};

export type SearchPrompt = {
  id: string;
  title: string;
  subtitle?: string;
  helper?: string;
};

export type SearchPromptListResult = {
  prompts: SearchPrompt[];
};

export type SearchHealthStatus = {
  ok: boolean;
  details?: Record<string, unknown>;
};
