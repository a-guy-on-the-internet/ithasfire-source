import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { EventStatus } from "@th/ports/repos/events";

import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";
import { plainTextOptional } from "../../lib/sanitize-plain-text";

/**
 * The read behind /platform/community-listings: every ownerless COMMUNITY
 * listing, so a platform ADMIN can find one to edit or take down.
 *
 * Gate: platform ADMIN only, the same gate `cancelEvent` / `archiveEvent`
 * apply to a COMMUNITY row (FR-014). COMMUNITY_MODERATORs are refused
 * (STAFF_ONLY) until the owner rules otherwise.
 *
 * Status filter: one status, or none. None means DRAFT, PUBLISHED and
 * COMPLETED. A listing is taken down by cancelling it (owner, 2026-10-16), so
 * CANCELLED and ARCHIVED leave the working list and are found by asking for
 * them explicitly.
 *
 * Night fields: nights count only while the listing is DRAFT or PUBLISHED;
 * a CANCELLED, COMPLETED or ARCHIVED listing shows none. A recurring
 * listing's nights are then its SCHEDULED `EventDate` rows from now on
 * (a listing cancelled before cancel called its nights off still has
 * SCHEDULED rows, which must not read as upcoming). A one-off has no
 * `EventDate` rows; its single night counts until it ends.
 *
 * No RSVP counts: going-counts stay server-side (FR-004).
 */

const LISTING_STATUSES = [
  "DRAFT",
  "PUBLISHED",
  "CANCELLED",
  "COMPLETED",
  "ARCHIVED",
] as const satisfies readonly EventStatus[];

/** The statuses listed when the caller names none: not CANCELLED or ARCHIVED. */
export const DEFAULT_COMMUNITY_LISTING_STATUSES: EventStatus[] = [
  "DRAFT",
  "PUBLISHED",
  "COMPLETED",
];

export const DEFAULT_COMMUNITY_LISTINGS_LIMIT = 25;
export const MAX_COMMUNITY_LISTINGS_LIMIT = 100;
export const MAX_COMMUNITY_LISTINGS_QUERY_LENGTH = 200;

export const listCommunityListingsInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    status: z.enum(LISTING_STATUSES).optional(),
    query: plainTextOptional(MAX_COMMUNITY_LISTINGS_QUERY_LENGTH).optional(),
    cursor: z.uuid().nullable().optional(),
    limit: z.number().int().min(1).max(MAX_COMMUNITY_LISTINGS_LIMIT).optional(),
  })
  .strict();

export const communityListingPlatformItemSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    status: z.enum(LISTING_STATUSES),
    slug: z.string().nullable(),
    timezone: z.string(),
    startsAt: z.date(),
    endsAt: z.date(),
    recurring: z.boolean(),
    placeId: z.string().nullable(),
    placeName: z.string().nullable(),
    /** The place's city, else the listing's own locality. */
    city: z.string().nullable(),
    /** The next night that will happen; null when none is left. */
    nextNightStartsAt: z.date().nullable(),
    /** Nights still to happen (see the file doc for one-offs). */
    upcomingNightCount: z.number().int().min(0),
    publishedAt: z.date().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict();

export const listCommunityListingsOutputSchema = z
  .object({
    items: z.array(communityListingPlatformItemSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export type ListCommunityListingsInput = z.input<
  typeof listCommunityListingsInputSchema
>;
export type ListCommunityListingsOutput = z.infer<
  typeof listCommunityListingsOutputSchema
>;
export type CommunityListingPlatformItem = z.infer<
  typeof communityListingPlatformItemSchema
>;

export type ListCommunityListingsDeps = {
  repos: Pick<Repos, "events">;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  logger?: LoggerPort;
};

/** A listing's nights count only in these statuses. */
const LIVE_STATUSES: ReadonlySet<EventStatus> = new Set(["DRAFT", "PUBLISHED"]);

export async function listCommunityListings(
  deps: ListCommunityListingsDeps,
  rawInput: unknown,
): Promise<ListCommunityListingsOutput> {
  const execute = () => run(deps, rawInput);
  const scopedLogger = deps.logger?.child({
    useCase: "listCommunityListings",
  });
  return scopedLogger
    ? scopedLogger.withTime("listCommunityListings", execute)
    : execute();
}

async function run(
  deps: ListCommunityListingsDeps,
  rawInput: unknown,
): Promise<ListCommunityListingsOutput> {
  const input = parseInput(listCommunityListingsInputSchema, rawInput);

  await requirePlatformStaff({
    authz: deps.authz,
    actorHumanId: input.actorHumanId,
    roles: ["ADMIN"],
  });

  const now = deps.clock.now();
  const titleContains = input.query?.trim() || null;

  const page = await deps.repos.events.listCommunityListingsForPlatform({
    statuses: input.status
      ? [input.status]
      : DEFAULT_COMMUNITY_LISTING_STATUSES,
    titleContains,
    cursor: input.cursor ?? null,
    limit: input.limit ?? DEFAULT_COMMUNITY_LISTINGS_LIMIT,
    now,
  });

  const items = page.items.map((row) => {
    const live = LIVE_STATUSES.has(row.status);
    const oneOffUpcoming =
      !row.recurring && live && row.endsAt.getTime() >= now.getTime();
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      slug: row.slug,
      timezone: row.timezone,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      recurring: row.recurring,
      placeId: row.placeId,
      placeName: row.placeName,
      city: row.placeCity ?? row.locality,
      nextNightStartsAt: row.recurring
        ? live
          ? row.nextScheduledDateStartsAt
          : null
        : oneOffUpcoming
          ? row.startsAt
          : null,
      upcomingNightCount: row.recurring
        ? live
          ? row.upcomingScheduledDateCount
          : 0
        : oneOffUpcoming
          ? 1
          : 0,
      publishedAt: row.publishedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  });

  return {
    items,
    nextCursor: page.nextCursor,
  } satisfies ListCommunityListingsOutput;
}
