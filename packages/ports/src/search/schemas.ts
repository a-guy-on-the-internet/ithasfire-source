import { z } from "zod";

import {
  SEARCH_PORT_ERROR_CODES,
  type QueryContext,
  type QueryFilters,
  type SearchAutocompleteInput,
  type SearchAutocompleteOutput,
  type SearchDocument,
  type SearchFacetBuckets,
  type SearchHealthStatus,
  type SearchIndexDeleteInput,
  type SearchIndexDeleteOutput,
  type SearchIndexRefreshOutput,
  type SearchIndexUpsertInput,
  type SearchIndexUpsertOutput,
  type SearchPrompt,
  type SearchPromptListInput,
  type SearchPromptListResult,
  type SearchQueryInput,
  type SearchQueryResult,
  type SearchRelatedInput,
  type SearchRelatedResult,
  type SearchResult,
  type SearchSuggestion,
  type SearchTelemetryInteractionInput,
  type SearchTelemetryInteractionResult,
  type TicketAvailability,
} from "./types";

const nullableDateSchema = z.date().nullable();
const nonEmptyString = z.string().min(1);
const normalizedStringArray = () => z.array(nonEmptyString).default([]);
const embeddingVectorSchema = z.array(z.number().finite()).max(1536);

export const ticketAvailabilitySchema = z
  .object({
    status: z.enum(["AVAILABLE", "LOW", "SOLD_OUT", "UNKNOWN"] as const),
    remaining: z.number().int().nonnegative().optional(),
    lastUpdatedAt: nullableDateSchema.optional(),
  })
  .strict() satisfies z.ZodType<TicketAvailability>;

export const searchDocumentSchema = z
  .object({
    eventId: nonEmptyString,
    slug: z.string().min(1).nullable().default(null),
    orgId: nonEmptyString.nullable().default(null),
    ownerType: z.enum(["ORG", "HUMAN"] as const),
    ownerHumanId: nonEmptyString.nullable().default(null),
    title: nonEmptyString,
    artists: normalizedStringArray(),
    tags: normalizedStringArray(),
    venueId: nonEmptyString.nullable().default(null),
    venueName: z.string().nullable().default(null),
    addressText: z.string().nullable().default(null),
    city: z.string().nullable().default(null),
    regionCode: z.string().nullable().default(null),
    countryCode: z.string().nullable().default(null),
    lat: z.number().nullable().default(null),
    lng: z.number().nullable().default(null),
    startsAt: nullableDateSchema,
    endsAt: nullableDateSchema,
    status: z.enum(["DRAFT", "PUBLISHED", "HIDDEN"] as const),
    popularityScore: z.number().min(0).max(1000),
    recencyScore: z.number().int().nonnegative(),
    summary: z.string().nullable().default(null),
    embeddingVersion: nonEmptyString,
    embeddingVector: embeddingVectorSchema.nullable().default(null),
    ticketAvailability: ticketAvailabilitySchema.optional(),
  })
  .strict() satisfies z.ZodType<SearchDocument>;

export const searchSuggestionSchema = z
  .object({
    eventId: nonEmptyString,
    slug: z.string().nullable().optional(),
    title: nonEmptyString,
    subtitle: z.string().nullable().optional(),
    helper: z.string().nullable().optional(),
    matchReason: z
      .enum(["title", "artist", "venue", "city", "semantic"] as const)
      .optional(),
    confidence: z.number().min(0).max(1),
  })
  .strict() satisfies z.ZodType<SearchSuggestion>;

export const searchResultLocationSchema = z.object({
  venueId: z.string().nullable().optional(),
  venueName: z.string().nullable().optional(),
  addressText: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  regionCode: z.string().nullable().optional(),
  countryCode: z.string().nullable().optional(),
  lat: z.number().nullable().optional(),
  lng: z.number().nullable().optional(),
});

export const searchResultSchema = z
  .object({
    eventId: nonEmptyString,
    slug: z.string().nullable().optional(),
    title: nonEmptyString,
    snippet: z.string().nullable().optional(),
    badges: z.array(z.string()).optional(),
    location: searchResultLocationSchema.optional(),
    startsAt: nullableDateSchema.optional(),
    endsAt: nullableDateSchema.optional(),
    status: z.enum(["DRAFT", "PUBLISHED", "HIDDEN"] as const).optional(),
    matchReasons: z.array(z.string()).default([]),
    score: z.number().finite(),
    sgrank: z.number().int().nonnegative().optional(),
    confidence: z.number().min(0).max(1),
    ticketAvailability: ticketAvailabilitySchema.optional(),
    document: searchDocumentSchema.optional(),
  })
  .strict() satisfies z.ZodType<SearchResult>;

export const queryFiltersSchema = z
  .object({
    orgId: nonEmptyString.optional(),
    ownerHumanId: nonEmptyString.optional(),
    venueId: nonEmptyString.optional(),
    status: z.array(z.enum(["PUBLISHED", "HIDDEN"] as const)).optional(),
    dateRange: z
      .object({
        gte: z.date().optional(),
        lte: z.date().optional(),
      })
      .optional(),
    regionCodes: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    geo: z
      .object({
        lat: z.number(),
        lng: z.number(),
        radiusKm: z.number().positive(),
      })
      .optional(),
  })
  .strict() satisfies z.ZodType<QueryFilters>;

export const queryContextSchema = z
  .object({
    requestId: z.string().optional(),
    actorId: z.string().optional(),
    ip: z.string().optional(),
    userAgent: z.string().optional(),
    traceId: z.string().optional(),
  })
  .strict() satisfies z.ZodType<QueryContext>;

export const searchAutocompleteInputSchema = z
  .object({
    query: nonEmptyString,
    limit: z.number().int().positive().max(20).optional(),
    filters: queryFiltersSchema.optional(),
    context: queryContextSchema.optional(),
  })
  .strict() satisfies z.ZodType<SearchAutocompleteInput>;

export const searchAutocompleteOutputSchema = z
  .object({
    suggestions: z.array(searchSuggestionSchema),
    latencyMs: z.number().int().nonnegative(),
  })
  .strict() satisfies z.ZodType<SearchAutocompleteOutput>;

export const searchQueryInputSchema = z
  .object({
    query: nonEmptyString,
    limit: z.number().int().positive().max(200).optional(),
    offset: z.number().int().nonnegative().optional(),
    filters: queryFiltersSchema.optional(),
    context: queryContextSchema.optional(),
    includeFacets: z.boolean().optional(),
    includeAvailability: z.boolean().optional(),
  })
  .strict() satisfies z.ZodType<SearchQueryInput>;

const facetBucketSchema = z.record(
  z.string(),
  z.array(
    z.object({
      label: z.string(),
      count: z.number().int().nonnegative(),
    }),
  ),
);

export const searchQueryResultSchema = z
  .object({
    results: z.array(searchResultSchema),
    facets: facetBucketSchema.optional(),
    latencyMs: z.number().int().nonnegative(),
  })
  .strict() satisfies z.ZodType<SearchQueryResult>;

export const searchRelatedInputSchema = z
  .object({
    eventId: nonEmptyString,
    limit: z.number().int().positive().max(50).optional(),
    context: queryContextSchema.optional(),
  })
  .strict() satisfies z.ZodType<SearchRelatedInput>;

export const searchRelatedResultSchema = z
  .object({
    results: z.array(searchResultSchema),
  })
  .strict() satisfies z.ZodType<SearchRelatedResult>;

export const searchIndexUpsertInputSchema = z
  .object({
    documents: z.array(searchDocumentSchema).min(1),
    mode: z.enum(["merge", "replace"] as const).optional(),
    traceId: z.string().optional(),
  })
  .strict() satisfies z.ZodType<SearchIndexUpsertInput>;

export const searchIndexUpsertOutputSchema = z
  .object({
    indexed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    failureReasons: z.record(z.string(), z.string()).optional(),
  })
  .strict() satisfies z.ZodType<SearchIndexUpsertOutput>;

export const searchIndexDeleteInputSchema = z
  .object({
    eventIds: z.array(nonEmptyString).optional(),
    orgId: nonEmptyString.optional(),
    slug: nonEmptyString.optional(),
  })
  .strict() satisfies z.ZodType<SearchIndexDeleteInput>;

export const searchIndexDeleteOutputSchema = z
  .object({
    deleted: z.number().int().nonnegative(),
  })
  .strict() satisfies z.ZodType<SearchIndexDeleteOutput>;

export const searchIndexRefreshOutputSchema = z
  .object({
    refreshedAt: z.date(),
  })
  .strict() satisfies z.ZodType<SearchIndexRefreshOutput>;

export const searchTelemetryInteractionInputSchema = z
  .object({
    query: nonEmptyString,
    suggestionId: z.string().optional(),
    eventId: z.string().optional(),
    action: z.enum(["view", "click", "purchase"] as const),
    context: queryContextSchema
      .extend({
        latencyMs: z.number().int().nonnegative().optional(),
        rank: z.number().int().nonnegative().optional(),
      })
      .optional(),
  })
  .strict() satisfies z.ZodType<SearchTelemetryInteractionInput>;

export const searchTelemetryInteractionResultSchema = z
  .object({
    recorded: z.boolean(),
  })
  .strict() satisfies z.ZodType<SearchTelemetryInteractionResult>;

export const searchPromptSchema = z
  .object({
    id: nonEmptyString,
    title: nonEmptyString,
    subtitle: z.string().optional(),
    helper: z.string().optional(),
  })
  .strict() satisfies z.ZodType<SearchPrompt>;

export const searchPromptListInputSchema = z
  .object({
    orgId: nonEmptyString.optional(),
    ownerHumanId: nonEmptyString.optional(),
    regionCode: z.string().optional(),
    limit: z.number().int().positive().max(20).optional(),
  })
  .strict() satisfies z.ZodType<SearchPromptListInput>;

export const searchPromptListResultSchema = z
  .object({
    prompts: z.array(searchPromptSchema),
  })
  .strict() satisfies z.ZodType<SearchPromptListResult>;

export const searchPortErrorCodeSchema = z.enum(SEARCH_PORT_ERROR_CODES);

export const searchHealthSchema = z
  .object({
    ok: z.boolean(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict() satisfies z.ZodType<SearchHealthStatus>;

export const searchFacetBucketsSchema =
  facetBucketSchema satisfies z.ZodType<SearchFacetBuckets>;
