import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { EntityPageRecord } from "@th/ports/repos/entity-pages";
import type { LoggerPort } from "@th/ports/logger";
import type {
  PlaceRecord,
  PlaceStatus,
  PlaceVerificationStatus,
  Repos,
} from "@th/ports/repos";
import {
  buildOffsetPaginatedResult,
  offsetPageInfoSchema,
  sanitizeOffsetPagination,
} from "@th/ports/pagination";

import { linkablePageSlug } from "../../lib/entity-page-visibility";
import { callOrDependencyFailed, parseInput } from "../../lib/io";
import { fail } from "@th/errors";

const PLATFORM_STAFF_ROLES = [
  "ADMIN",
  "REVIEWER",
  "SUPPORT",
  "DEVELOPER",
] as const;

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

export const listPlatformPlacesInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    limit: z.number().int().min(1).max(100).default(25),
    offset: z.number().int().min(0).default(0),
    query: z.string().trim().min(1).max(200).optional(),
    verificationStatus: z
      .array(z.enum(PLACE_VERIFICATION_STATUS_VALUES))
      .optional(),
    status: z.array(z.enum(PLACE_STATUS_VALUES)).optional(),
    /**
     * Exact by-id read: only these places, ANDed with the other filters.
     * The panel opens a known place (a duplicate, a rename collision) with
     * it, whatever its status or name.
     */
    placeIds: z.array(z.string().uuid()).min(1).max(50).optional(),
  })
  .strict();

const placeSummarySchema = z
  .object({
    placeId: z.string().uuid(),
    name: z.string(),
    formattedAddress: z.string().nullable(),
    city: z.string().nullable(),
    region: z.string().nullable(),
    countryCode: z.string().nullable(),
    capacity: z.number().int().nullable(),
    status: z.enum(PLACE_STATUS_VALUES),
    verificationStatus: z.enum(PLACE_VERIFICATION_STATUS_VALUES),
    ownerCount: z.number().int().nonnegative(),
    listedInDirectory: z.boolean(),
    /**
     * Site-relative URL of the place's public page, `/places/{EntityPage.slug}`
     * (the route every place link uses, see the /admin places panel), or null
     * when the place has no page or its page is PRIVATE (`linkablePageSlug`:
     * PUBLIC and UNLISTED pages render, PRIVATE 404s).
     */
    publicPath: z.string().nullable(),
  })
  .strict();

export const listPlatformPlacesOutputSchema = z
  .object({
    places: z.array(placeSummarySchema),
    pageInfo: offsetPageInfoSchema,
  })
  .strict();

export type ListPlatformPlacesInput = z.infer<
  typeof listPlatformPlacesInputSchema
>;
export type ListPlatformPlacesOutput = z.infer<
  typeof listPlatformPlacesOutputSchema
>;

export type ListPlatformPlacesDeps = {
  repos: Repos;
  authz: AuthZPort;
  logger?: LoggerPort;
};

function placePublicPath(page: EntityPageRecord | undefined): string | null {
  const slug = linkablePageSlug(page);
  return slug ? `/places/${encodeURIComponent(slug)}` : null;
}

function mapPlaceToSummary(
  place: PlaceRecord,
  page: EntityPageRecord | undefined,
) {
  return {
    placeId: place.id,
    name: place.name,
    formattedAddress: place.formattedAddress,
    city: place.city,
    region: place.region,
    countryCode: place.countryCode,
    capacity: place.capacity,
    status: place.status,
    verificationStatus: place.verificationStatus,
    ownerCount:
      (place.orgIdsWithAccess?.length ?? 0) +
      (place.humanIdsWithAccess?.length ?? 0),
    listedInDirectory: place.listedInDirectory,
    publicPath: placePublicPath(page),
  };
}

export async function listPlatformPlaces(
  deps: ListPlatformPlacesDeps,
  rawInput: unknown,
): Promise<ListPlatformPlacesOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "listPlatformPlaces" });

  const execute = async () => {
    const input = parseInput(listPlatformPlacesInputSchema, rawInput);

    const staffCheck = await callOrDependencyFailed(
      () =>
        deps.authz.hasStaffRole({
          actorHumanId: input.actorHumanId,
          requiredRoles: [...PLATFORM_STAFF_ROLES],
        }),
      scopedLogger,
      { action: "authz.hasStaffRole", actorHumanId: input.actorHumanId },
    );

    if (!staffCheck.allowed) {
      throw fail("STAFF_ONLY");
    }

    const pagination = sanitizeOffsetPagination({
      limit: input.limit,
      offset: input.offset,
    });

    const result = await callOrDependencyFailed(
      () =>
        deps.repos.places.listAll({
          query: input.query,
          verificationStatus: input.verificationStatus,
          status: input.status,
          placeIds: input.placeIds,
          limit: pagination.limit,
          offset: pagination.offset,
        }),
      scopedLogger,
      { action: "repos.places.listAll", actorHumanId: input.actorHumanId },
    );

    // EntityPage is polymorphic (ownerType + ownerId, no Prisma relation), so
    // the page slugs come from one batched read for the whole page of rows.
    const placeIds = result.items.map((place) => place.id);
    const pages =
      placeIds.length > 0
        ? await callOrDependencyFailed(
            () => deps.repos.entityPages.getByOwners("PLACE", placeIds),
            scopedLogger,
            {
              action: "repos.entityPages.getByOwners",
              actorHumanId: input.actorHumanId,
            },
          )
        : [];
    const pageByPlaceId = new Map(pages.map((page) => [page.ownerId, page]));

    const places = result.items.map((place) =>
      mapPlaceToSummary(place, pageByPlaceId.get(place.id)),
    );

    return {
      places,
      pageInfo: buildOffsetPaginatedResult({
        items: places,
        total: result.pageInfo.total,
        limit: pagination.limit,
        offset: pagination.offset,
      }).pageInfo,
    };
  };

  if (scopedLogger) {
    return scopedLogger.withTime("listPlatformPlaces", execute);
  }

  return execute();
}
