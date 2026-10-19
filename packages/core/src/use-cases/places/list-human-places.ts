import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type {
  ListAccessiblePlacesSortField,
  PlaceListItemRecord,
  PlaceStatus,
  PlaceVerificationStatus,
  Repos,
} from "@th/ports/repos";
import { offsetPageInfoSchema } from "@th/ports/pagination";

import { parseInput } from "../../lib/io";
import { redactPlaceLocation } from "../../lib/location/redact-place-location";
import { resolvePlaceAddressUnlocks } from "./_shared/place-address-unlock";
import { fail } from "@th/errors";

const PLACE_STATUS_VALUES = [
  "ACTIVE",
  "SUSPENDED",
  "ARCHIVED",
] as const satisfies readonly PlaceStatus[];
const PLACE_VERIFICATION_STATUS_VALUES = [
  "UNVERIFIED",
  "VERIFIED",
  "PENDING",
  "REJECTED",
] as const satisfies readonly PlaceVerificationStatus[];
const PLACE_SORT_FIELDS = [
  "name",
  "created",
  "capacity",
  "status",
] as const satisfies readonly ListAccessiblePlacesSortField[];

const DEFAULT_LIMIT = 20;
const MAX_ORG_FILTERS = 12;

export const listHumanPlacesInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    limit: z.number().int().min(1).max(50).default(DEFAULT_LIMIT),
    offset: z.number().int().min(0).default(0),
    query: z.string().trim().min(2).max(140).optional(),
    orgIds: z.array(z.string().uuid()).max(MAX_ORG_FILTERS).optional(),
    /**
     * If true (default), only returns VERIFIED places.
     * If false, includes unverified places owned by the requesting human/orgs.
     *
     * Note: even when false, unverified places NOT owned by the actor are still excluded.
     */
    verifiedOnly: z.boolean().default(true),
    /**
     * If true, only return places where the actor or their orgs have an
     * ownership record. Globally verified places the actor does NOT own are
     * excluded. Useful for the admin "my places" table.
     */
    ownedOnly: z.boolean().default(false),
    /**
     * Only meaningful with `ownedOnly` + `orgIds`. Normally that pair means
     * "this ORG's venues and only those" (the event builder / place picker).
     * Set this to also include places the ACTOR owns directly — the personal
     * admin context, which is a hub across everything the person holds rather
     * than a single tenant.
     */
    includeActorOwnedWithOrgs: z.boolean().default(false),
    /**
     * Sort applied server-side BEFORE pagination — a page is a window over
     * the fully sorted result set. Default matches the historical ordering
     * (name asc). `capacity` sorts nulls last in both directions.
     */
    sort: z
      .object({
        field: z.enum(PLACE_SORT_FIELDS),
        direction: z.enum(["asc", "desc"]),
      })
      .strict()
      .default({ field: "name", direction: "asc" }),
    /**
     * Lifecycle scope, applied BEFORE pagination and reflected in
     * pageInfo.total. "active" = status != ARCHIVED (includes SUSPENDED),
     * "archived" = status == ARCHIVED, "all" = no status constraint.
     * OMITTED (undefined) preserves the legacy ACTIVE-only scope every
     * pre-existing caller was written against — so this stays optional
     * with NO default.
     */
    status: z.enum(["active", "archived", "all"]).optional(),
  })
  .strict();

const placeSummarySchema = z
  .object({
    placeId: z.string().uuid(),
    name: z.string(),
    /**
     * REDACTED BELOW THE MANAGE BAR. This listing deliberately includes
     * globally VERIFIED venues the actor does NOT own (that is what makes the
     * venue picker useful), so it is a cross-tenant read — and a venue that
     * withholds its address must not hand that address to every organizer on
     * the platform through a table, nor to a SCANNER / VIEWER / FINANCE
     * member of the venue's own org. Only a viewer who passes
     * `authz.canManagePlace` sees the real values; everyone else gets the
     * public projection.
     */
    formattedAddress: z.string().nullable(),
    addressLine1: z.string().nullable(),
    addressLine2: z.string().nullable(),
    city: z.string().nullable(),
    region: z.string().nullable(),
    postalCode: z.string().nullable(),
    countryCode: z.string().nullable(),
    capacity: z.number().int().nullable(),
    lat: z.number().gte(-90).lte(90).nullable(),
    lng: z.number().gte(-180).lte(180).nullable(),
    /** False when this row's address is withheld from this viewer. */
    locationIsExact: z.boolean(),
    /** True = fully hidden: no coordinates at all on this row. */
    locationHidden: z.boolean(),
    /** Coarse area label for a withheld venue. */
    areaLabel: z.string().nullable(),
    /**
     * IANA zone derived from the venue's coordinates at place creation
     * (TimezoneLookupPort). Null on rows that predate the derivation or where
     * the lookup failed — callers MUST treat null as "unknown" and keep
     * whatever zone they already had. Additive: already present on
     * `PlaceRecord` and already selected by the Prisma adapter, so this only
     * stops the projection from dropping it. The event builder reads it to
     * type the organizer's wall clock in the VENUE's zone instead of the
     * browser's.
     */
    timezone: z.string().nullable(),
    /**
     * Number of PUBLISHED events located at this place. Scoped to
     * PUBLISHED only so non-owned (globally verified) venues never leak
     * other organizers' draft/cancelled activity. Aggregated in the
     * listing query; no extra round-trip.
     */
    eventsCount: z.number().int().min(0),
    status: z.enum(PLACE_STATUS_VALUES),
    verificationStatus: z.enum(PLACE_VERIFICATION_STATUS_VALUES),
    /**
     * In-flight verification request status, if one exists. PENDING means
     * the request is in queue; IN_REVIEW means a platform admin has claimed
     * it and is actively reviewing. Null when no active request exists.
     * Surface this on the table so organizers see the live state without
     * an extra round-trip.
     */
    activeVerificationRequestStatus: z
      .enum(["PENDING", "IN_REVIEW"])
      .nullable(),
    listedInDirectory: z.boolean(),
    createdAt: z.date(),
    access: z.object({
      orgIds: z.array(z.string().uuid()),
      humanIds: z.array(z.string().uuid()),
    }),
  })
  .strict();

export const listHumanPlacesOutputSchema = z
  .object({
    places: z.array(placeSummarySchema),
    pageInfo: offsetPageInfoSchema,
  })
  .strict();

export type ListHumanPlacesInput = z.infer<typeof listHumanPlacesInputSchema>;
export type ListHumanPlacesOutput = z.infer<typeof listHumanPlacesOutputSchema>;

export type ListHumanPlacesDeps = {
  repos: Repos;
  /**
   * REQUIRED: `canManagePlace` is the bar for unlocking a withheld venue's
   * address on this list (see `resolvePlaceAddressUnlocks`). Optional would be
   * an authz decision made by omission.
   */
  authz: Pick<AuthZPort, "canManagePlace">;
  logger?: LoggerPort;
};

export async function listHumanPlaces(
  deps: ListHumanPlacesDeps,
  rawInput: unknown,
): Promise<ListHumanPlacesOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "listHumanPlaces" });

  const execute = async () => {
    const input = parseInput(listHumanPlacesInputSchema, rawInput);
    return handleListHumanPlaces(deps, scopedLogger, input);
  };

  if (scopedLogger) {
    return scopedLogger.withTime("listHumanPlaces", execute);
  }

  return execute();
}

async function handleListHumanPlaces(
  deps: ListHumanPlacesDeps,
  logger: LoggerPort | undefined,
  input: ListHumanPlacesInput,
): Promise<ListHumanPlacesOutput> {
  const human = await deps.repos.humans.getById(input.actorHumanId);
  if (!human) {
    throw fail("HUMAN_NOT_FOUND");
  }

  const requestedOrgIds = normalizeOrgIds(input.orgIds ?? []);
  const authorizedOrgIds = await resolveAuthorizedOrgIds(
    deps.repos,
    input.actorHumanId,
    requestedOrgIds,
  );

  const trimmedQuery = input.query?.trim();
  const searchQuery =
    trimmedQuery && trimmedQuery.length > 0 ? trimmedQuery : undefined;

  const result = await deps.repos.places.listAccessibleByHuman({
    humanId: input.actorHumanId,
    orgIds: authorizedOrgIds.length > 0 ? authorizedOrgIds : undefined,
    query: searchQuery,
    limit: input.limit,
    offset: input.offset,
    includeOwnedUnverified: input.verifiedOnly ? false : true,
    ownedOnly: input.ownedOnly,
    includeActorOwnedWithOrgs: input.includeActorOwnedWithOrgs,
    sort: input.sort,
    status: input.status,
  });

  // verifiedOnly is enforced in the adapter's where clause (via
  // includeOwnedUnverified=false → verification=VERIFIED), shared by both
  // the page query and the count — no post-pagination filtering here, so
  // pageInfo.total is honest.

  // Hydrate active-request statuses in one batch so the table can show
  // IN_REVIEW (which lives only on the request, not on Place.verification).
  const activeStatusMap =
    await deps.repos.placeVerificationRequests.getActiveStatusByPlaceIds(
      result.items.map((p) => p.id),
    );

  // Which of the returned WITHHELD venues may this actor see the real address
  // of? The bar is `canManagePlace` (D5) — not "is a member of an owning
  // org", which let a door SCANNER read the street address of a house. One
  // batched membership read over the page's withheld venues, then the probe
  // for the few that could pass. `authorizedOrgIds` above is only the orgs
  // the caller FILTERED by, which is not the same question.
  const unlocked = await resolvePlaceAddressUnlocks(
    { repos: deps.repos, authz: deps.authz },
    input.actorHumanId,
    result.items,
  );

  const response = listHumanPlacesOutputSchema.parse({
    places: result.items.map((record) =>
      mapPlaceRecord(
        record,
        activeStatusMap.get(record.id) ?? null,
        unlocked.has(record.id),
      ),
    ),
    pageInfo: result.pageInfo,
  });

  logger?.info("places.list_human_places", {
    actorHumanId: input.actorHumanId,
    query: searchQuery ?? null,
    requestedOrgIds,
    authorizedOrgIds,
    limit: input.limit,
    offset: input.offset,
    verifiedOnly: input.verifiedOnly,
    sort: input.sort,
    status: input.status ?? null,
    resultCount: response.places.length,
    pageInfo: response.pageInfo,
  });

  return response;
}

function normalizeOrgIds(orgIds: string[]): string[] {
  return Array.from(
    new Set(
      orgIds.map((value) => value.trim()).filter((value) => value.length > 0),
    ),
  );
}

async function resolveAuthorizedOrgIds(
  repos: Repos,
  humanId: string,
  orgIds: string[],
): Promise<string[]> {
  if (orgIds.length === 0) {
    return [];
  }

  const memberships = await repos.authz.getOrgMemberships({ orgIds, humanId });

  return memberships.map((m) => m.orgId);
}

function mapPlaceRecord(
  record: PlaceListItemRecord,
  activeVerificationRequestStatus: "PENDING" | "IN_REVIEW" | null,
  /**
   * Whether the actor passes `canManagePlace` for this venue. ONLY then is a
   * withheld address shown. Defaults to FALSE so a future caller that forgets
   * the argument redacts rather than leaks.
   */
  viewerCanManagePlace = false,
) {
  const location = redactPlaceLocation(record, {
    viewerCanSeeExact: viewerCanManagePlace,
  });
  return {
    placeId: record.id,
    name: record.name,
    formattedAddress: location.formattedAddress,
    addressLine1: location.addressLine1,
    addressLine2: location.addressLine2,
    city: location.city,
    region: location.region,
    postalCode: location.postalCode,
    countryCode: location.countryCode,
    capacity: record.capacity,
    lat: location.lat,
    lng: location.lng,
    locationIsExact: location.isExact,
    locationHidden: location.hidden,
    areaLabel: location.areaLabel,
    // `?? null` (not a bare read) so a repo row that omits the column — every
    // hand-built test fake does — projects as "unknown" instead of failing the
    // strict output parse.
    timezone: record.timezone ?? null,
    eventsCount: record.eventsCount,
    status: record.status,
    verificationStatus: record.verificationStatus,
    activeVerificationRequestStatus,
    listedInDirectory: record.listedInDirectory,
    createdAt: record.createdAt,
    access: {
      orgIds: record.orgIdsWithAccess,
      humanIds: record.humanIdsWithAccess,
    },
  };
}
