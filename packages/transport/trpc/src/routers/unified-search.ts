/**
 * Unified Search tRPC Router
 *
 * Exposes the unified search use case that searches across multiple entity types.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { AuthZRole, HumanRole } from "@th/ports/authz";
import { eventSummaryDtoSchema } from "@th/types";

import {
  unifiedSearch,
  nearbyEvents,
  nearbyEventsInputSchema,
  featuredEvents,
  featuredEventsInputSchema,
  tieredPopularEvents,
  tieredPopularEventsInputSchema,
  discoverEventsByCategory,
  discoverEventsByCategoryInputSchema,
  searchOrgAdmin,
  searchOrgAdminInputSchema,
  searchOrgAdminOutputSchema,
  type UnifiedSearchDeps,
  type NearbyEventsDeps,
  type FeaturedEventsDeps,
  type TieredPopularEventsDeps,
  type DiscoverEventsByCategoryDeps,
} from "@th/core/use-cases/search";
import { getFeatureGates } from "@th/core/use-cases/features";

import type { Ctx } from "../context";
import { authedProcedure, optionalProcedure } from "../init";
import { throwIfStaffSecondFactorRequired } from "../guard";
import { discoveredEventsToDto } from "../event-summary-mapper";
import { toTrpcError } from "../utils";
import { publicDiscoveryCacheFor } from "../anonymous-request";

const unifiedSearchInputSchemaTransport = z
  .object({
    /**
     * Empty allowed: drives the /search "browse all events" landing
     * experience. The use case forwards the empty string to Meilisearch,
     * which returns the filter-matching set ranked by its defaults.
     */
    query: z.string().trim().max(120).default(""),
    limit: z.number().int().min(1).max(50).default(10),
    offset: z.number().int().min(0).max(1000).default(0),
    types: z
      .array(z.enum(["event", "human", "place", "organization"]))
      .optional(),
    /** Optional geo filter — scopes event results to a radius around a coordinate. */
    geo: z
      .object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        // Up to 20,000 km — covers nationwide / continent-scale searches.
        // Worldwide ("all events") is encoded as no geo filter at all,
        // not as a sentinel huge radius.
        radiusKm: z.number().min(1).max(20_000),
      })
      .optional(),
    /** Scope results to a specific org. */
    orgId: z.uuid("orgId must be a UUID").optional(),
    /** Scope results to a specific human owner. */
    ownerHumanId: z.uuid("ownerHumanId must be a UUID").optional(),
    /** When false, drafts are included (for admin contexts). Defaults to true. */
    publishedOnly: z.boolean().default(true),
    /** Filter events by free-form tags. A category goes in `categorySlugs`. */
    tags: z.array(z.string()).optional(),
    /**
     * Filter events by category. Gated in the use case: a missing or inactive
     * category is dropped, the rest join the tag filter. Bounds mirror the use
     * case's `MAX_CATEGORY_SLUG_LENGTH` / `MAX_CATEGORY_SLUGS`.
     */
    categorySlugs: z.array(z.string().min(1).max(64)).max(50).optional(),
    /** Filter events to those held at the given venue place ids. */
    placeIds: z.array(z.uuid()).max(50).optional(),
    /** Filter events by start-date range (ISO 8601 strings). */
    dateRange: z
      .object({
        from: z.string().optional(),
        to: z.string().optional(),
      })
      .optional(),
    /** Filter events by price range in cents. */
    priceRange: z
      .object({
        minCents: z.number().optional(),
        maxCents: z.number().optional(),
      })
      .optional(),
    /** When true, only show free events. */
    freeOnly: z.boolean().optional(),
    /** When true, only surface places the owner listed in the public directory. */
    listedInDirectoryOnly: z.boolean().optional(),
    /**
     * How to order EVENT rows. Anything other than `relevance` narrows the
     * query to events — see `scopeSortToEvents`.
     */
    sort: z
      .enum([
        "relevance",
        "date",
        "date_desc",
        "distance",
        "price_asc",
        "price_desc",
        "popularity",
      ])
      .default("relevance"),
  })
  .strict();

const nearbyEventsInputSchemaTransport = z
  .object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    radiusKm: z.number().min(1).max(500).default(50),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();

const featuredEventsInputSchemaTransport = z
  .object({
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    radiusKm: z.number().min(1).max(500).optional(),
    regionCode: z.string().optional(),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();

const tieredPopularEventsInputSchemaTransport = z
  .object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    regionCode: z.string().optional(),
    minResults: z.number().int().min(1).max(20).default(6),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();

const discoverEventsByCategoryInputSchemaTransport = z
  .object({
    categorySlug: z.string().min(1),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    radiusKm: z.number().min(1).max(500).default(50),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();

type UnifiedSearchTransportInput = z.infer<
  typeof unifiedSearchInputSchemaTransport
>;

const adminOrgSearchInput = searchOrgAdminInputSchema.omit({
  actorHumanId: true,
});

const SEARCH_SCOPE_ORG_ROLES: AuthZRole[] = [
  "OWNER",
  "ADMIN",
  "EDITOR",
  "VIEWER",
  "FINANCE",
  "SCANNER",
];
const SEARCH_SCOPE_STAFF_ROLES: HumanRole[] = [
  "ADMIN",
  "REVIEWER",
  "SUPPORT",
  "DEVELOPER",
];

const getUnifiedSearchDeps = (ctx: Ctx): UnifiedSearchDeps => {
  if (!ctx.multiSearch) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Search service not available",
    });
  }

  return {
    search: ctx.multiSearch,
    // Read for `Category.active` when the request carries `categorySlugs`.
    repos: ctx.repos,
    logger: ctx.logger,
  };
};

const executeAutocomplete = async (
  ctx: Ctx,
  // `includeNonPublicEvents` is never client-settable — it's injected by the
  // admin procedure only (see `autocompleteAdmin`). The core use case still
  // fail-closes it to `false` unless an owner scope is present.
  input: UnifiedSearchTransportInput & { includeNonPublicEvents?: boolean },
) => {
  const deps = getUnifiedSearchDeps(ctx);

  try {
    const result = await unifiedSearch(deps, scopeSortToEvents(input));

    return {
      suggestions: result.suggestions,
      latencyMs: result.latencyMs,
      estimatedTotalHits: result.estimatedTotalHits,
    };
  } catch (err) {
    throw toTrpcError(err);
  }
};

type SearchType = NonNullable<UnifiedSearchTransportInput["types"]>[number];

/**
 * Enforce the adapters' sort guard-rail: every non-`relevance` mode orders on
 * an event column (`startsAt`, `lowestBuyerTotalCents`, `popularityScore`), and
 * non-event rows are NULL there. Sorting a MIXED result set by date would not
 * interleave venues and artists — it would dump all of them below the events,
 * which reads as "the search lost my venues".
 *
 * So a non-`relevance` sort is treated as an event-scoped request and narrows
 * `types` to `["event"]`. This is Baymard's "faceted sorting": the scope and
 * the ordering are one choice, not two that can contradict each other. The
 * /search UI mirrors it by only offering these options in an event scope, but
 * the rule lives HERE so a hand-rolled client cannot produce the broken mix.
 *
 * Runs inside `executeAutocomplete`, so both the public and admin procedures
 * are covered and neither can bypass it. Narrowing to `["event"]` is always
 * safe after the `humanProfilesPublic` strip — it can never re-add `human`.
 */
const scopeSortToEvents = <T extends { sort?: string; types?: SearchType[] }>(
  input: T,
): T =>
  input.sort && input.sort !== "relevance"
    ? { ...input, types: ["event"] as SearchType[] }
    : input;

/** Public entity types minus `human` — the effective set when the
 * `humanProfilesPublic` gate is off. */
const HUMANLESS_SEARCH_TYPES: readonly SearchType[] = [
  "event",
  "place",
  "organization",
];

/**
 * Server-side enforcement of the `humanProfilesPublic` gate for PUBLIC search.
 * When the gate is off, human hits must never surface (their public profile
 * pages 404), so we drop `"human"` from the effective search types. This runs
 * in the shared public `autocomplete` procedure, so BOTH consumer search UIs
 * (Spotlight + the /search page) are covered by one change that a client can't
 * bypass.
 *
 * Returns the humanless type list.
 *
 * "All types" is expressed two ways by callers — an ABSENT `types` and an EMPTY
 * `types: []` (the adapters treat both as "no filter → all"). Both must map to
 * all-types-minus-human when gated, so toggling the gate never flips a
 * browse-all request from everything to nothing. Only the case where the input
 * NAMED specific types and filtering emptied the set (i.e. the caller asked for
 * ONLY humans) yields `[]` — the autocomplete procedure short-circuits that to
 * an empty result rather than forwarding `[]` (which would mean "all").
 */
const stripHumanType = (
  types: readonly SearchType[] | undefined,
): SearchType[] => {
  if (types === undefined || types.length === 0) {
    return [...HUMANLESS_SEARCH_TYPES];
  }
  return types.filter((t): t is Exclude<SearchType, "human"> => t !== "human");
};

const toPublicAutocompleteInput = (
  input: UnifiedSearchTransportInput,
): UnifiedSearchTransportInput => {
  const {
    orgId: _orgId,
    ownerHumanId: _ownerHumanId,
    publishedOnly: _publishedOnly,
    ...publicInput
  } = input;

  return {
    ...publicInput,
    publishedOnly: true,
  };
};

const authorizeAdminAutocomplete = async (
  ctx: Ctx,
  input: UnifiedSearchTransportInput,
): Promise<void> => {
  const actorHumanId = ctx.actorHumanId;

  if (!actorHumanId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Missing actor human id",
    });
  }

  if (!input.publishedOnly && !input.orgId && !input.ownerHumanId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "unpublished_results_require_scope",
    });
  }

  if (input.orgId) {
    await ctx.authz.requireOrgRole({
      actorHumanId,
      orgId: input.orgId,
      requiredRoles: SEARCH_SCOPE_ORG_ROLES,
      scope: { action: "read" },
    });
  }

  if (input.ownerHumanId && input.ownerHumanId !== actorHumanId) {
    const staff = await ctx.authz.hasStaffRole({
      actorHumanId,
      requiredRoles: SEARCH_SCOPE_STAFF_ROLES,
    });

    // Staff-only owner-scope override: this branch is what lets a staff
    // actor search another human's results (`ownerHumanId !==
    // actorHumanId`). The port refuses a staff member with no second factor;
    // that refusal is raised HERE as `SECOND_FACTOR_REQUIRED`, the code the
    // web redirects on, rather than by adding
    // `unifiedSearch.autocompleteAdmin` to guard.ts's path-level allowlist
    // (that would over-gate the ordinary, non-staff org members who also
    // call this same procedure with just `orgId` scope and no
    // `ownerHumanId` override).
    throwIfStaffSecondFactorRequired(staff);

    if (!staff.allowed) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "owner_scope_mismatch",
      });
    }
  }
};

export const unifiedSearchRouter = {
  /**
   * Unified autocomplete search across events, humans, places, and organizations.
   * Returns a mixed list of suggestions with type discriminators.
   */
  autocomplete: optionalProcedure
    .input(unifiedSearchInputSchemaTransport)
    .query(async ({ ctx, input }) => {
      const publicInput = toPublicAutocompleteInput(input);

      // Resolve the `humanProfilesPublic` gate the SAME way the features
      // router does (DB override ?? env `ENABLE_HUMAN_PROFILES_PUBLIC` ??
      // false). When off, human profile pages 404, so human hits must never
      // surface in public search (no dead links). Fail-closed: a settings-read
      // failure falls back to the env default (off unless explicitly enabled).
      const gates = await getFeatureGates({
        enableHumanProfilesPublic: ctx.enableHumanProfilesPublic,
        platformSettings: ctx.repos.platformSettings,
        reportError: ctx.reportError ?? undefined,
      });

      if (gates.humanProfilesPublic) {
        return executeAutocomplete(ctx, publicInput);
      }

      const effectiveTypes = stripHumanType(publicInput.types);

      // Only reachable when the caller NAMED a non-empty types set that was
      // exactly `["human"]` (an absent/empty input already mapped to the
      // humanless set). Forwarding `[]` would be read as "all types" by the
      // adapters, so short-circuit to an empty result instead.
      if (effectiveTypes.length === 0) {
        return { suggestions: [], latencyMs: 0, estimatedTotalHits: 0 };
      }

      return executeAutocomplete(ctx, {
        ...publicInput,
        types: effectiveTypes,
      });
    }),

  /**
   * Authenticated autocomplete for admin surfaces.
   * Allows draft visibility and scoped search only after transport-level authz.
   */
  autocompleteAdmin: authedProcedure
    .input(unifiedSearchInputSchemaTransport)
    .query(async ({ ctx, input }) => {
      await authorizeAdminAutocomplete(ctx, input);
      // Opt into the PRIVATE-event visibility bypass on the admin path so an
      // owner-scoped admin sees its OWN non-public events. `authorizeAdmin-
      // Autocomplete` already enforces an owner scope for unpublished results,
      // and the core use case fail-closes this flag to `false` whenever no
      // orgId/ownerHumanId scope is present — so a scope-less admin call still
      // excludes PRIVATE events.
      return executeAutocomplete(ctx, {
        ...input,
        includeNonPublicEvents: true,
      });
    }),

  /**
   * Live, org-scoped admin search across Events (incl. drafts), Attendees
   * (order buyers, finance-gated), and Venues. Hits live repos rather than the
   * public discovery projection, so drafts and guest buyers are visible.
   */
  adminOrgSearch: authedProcedure
    .input(adminOrgSearchInput)
    .output(searchOrgAdminOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      // `authz` is for ONE thing: `canManagePlace`, the bar for showing a
      // withheld venue's address in the venues group (D5). Finance access is
      // still derived from the membership row the owner-access guard fetches
      // (one authz round-trip, not two).
      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        logger: ctx.logger,
      } satisfies Parameters<typeof searchOrgAdmin>[0];

      try {
        return await searchOrgAdmin(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Find events near a geographic coordinate.
   * Results are sorted by distance (closest first).
   */
  nearbyEvents: optionalProcedure
    .input(nearbyEventsInputSchemaTransport)
    .output(
      z.object({
        events: z.array(eventSummaryDtoSchema),
        latencyMs: z.number(),
      }),
    )
    .query(async ({ ctx, input }) => {
      if (!ctx.multiSearch) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Search service not available",
        });
      }

      const deps: NearbyEventsDeps = {
        search: ctx.multiSearch,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      };

      const result = await nearbyEvents(deps, input);

      return {
        events: discoveredEventsToDto(result.events),
        latencyMs: result.latencyMs,
      };
    }),

  /**
   * Find featured events sorted by popularity score.
   * Optionally filter by geographic region or coordinates.
   */
  featuredEvents: optionalProcedure
    .input(featuredEventsInputSchemaTransport)
    .output(
      z.object({
        events: z.array(eventSummaryDtoSchema),
        latencyMs: z.number(),
      }),
    )
    .query(async ({ ctx, input }) => {
      if (!ctx.multiSearch) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Search service not available",
        });
      }

      const deps: FeaturedEventsDeps = {
        search: ctx.multiSearch,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
        // Anonymous requests only — see `isAnonymousRequest`.
        cache: publicDiscoveryCacheFor(ctx),
      };

      const result = await featuredEvents(deps, input);

      return {
        events: discoveredEventsToDto(result.events),
        latencyMs: result.latencyMs,
      };
    }),

  /**
   * Find popular events with automatic geo fallback.
   * Tries local → regional → country → global until minResults is met.
   * Returns the tier that satisfied the request.
   */
  tieredPopularEvents: optionalProcedure
    .input(tieredPopularEventsInputSchemaTransport)
    .output(
      z.object({
        events: z.array(eventSummaryDtoSchema),
        tier: z.enum(["local", "regional", "country", "global"]),
        latencyMs: z.number(),
      }),
    )
    .query(async ({ ctx, input }) => {
      if (!ctx.multiSearch) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Search service not available",
        });
      }

      const deps: TieredPopularEventsDeps = {
        search: ctx.multiSearch,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      };

      const result = await tieredPopularEvents(deps, input);

      return {
        events: discoveredEventsToDto(result.events),
        tier: result.tier,
        latencyMs: result.latencyMs,
      };
    }),

  /**
   * Discover events by category slug using Meilisearch.
   * Optionally filters by proximity when coordinates are provided.
   */
  discoverEventsByCategory: optionalProcedure
    .input(discoverEventsByCategoryInputSchemaTransport)
    .output(
      z.object({
        events: z.array(eventSummaryDtoSchema),
        latencyMs: z.number(),
      }),
    )
    .query(async ({ ctx, input }) => {
      if (!ctx.multiSearch) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Search service not available",
        });
      }

      const deps: DiscoverEventsByCategoryDeps = {
        search: ctx.multiSearch,
        repos: ctx.repos,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      };

      try {
        const result = await discoverEventsByCategory(deps, input);

        return {
          events: discoveredEventsToDto(result.events),
          latencyMs: result.latencyMs,
        };
      } catch (err) {
        // A missing or inactive category is CATEGORY_NOT_FOUND, mapped to
        // NOT_FOUND like `categories.eventsByCategory`.
        throw toTrpcError(err);
      }
    }),
};
