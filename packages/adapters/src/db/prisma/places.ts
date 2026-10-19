import { Prisma } from "@prisma/client";
import type {
  BulkCreatePlaceInput,
  ListAccessiblePlacesByHumanInput,
  ListAllPlacesInput,
  ListOwnedPlacesBySubjectInput,
  ListWithheldOwnedNearPointInput,
  PlaceFlag,
  PlaceOwnerInput,
  PlaceRecord,
  PlaceSitemapEntryRecord,
  PlaceStatus,
  PlaceVerificationStatus,
  PlaceWebsiteSource,
  PlacesRepo,
  UpsertPlaceInput,
} from "@th/ports/repos/places";
import type { EventLocationMode } from "@th/types/repos/events";
import type {
  CreateProvisionalOwnershipInput,
  CreateVerifiedOwnershipInput,
  PlaceOwnershipRecord,
  RevokeOwnershipInput,
  VerifyOwnershipInput,
} from "@th/types/repos/place-verification";
import {
  buildOffsetPageInfo,
  buildOffsetPaginatedResult,
  sanitizeOffsetPagination,
} from "@th/ports/pagination";

import type { PrismaClientOrTx } from "./types";

/**
 * The SQL half of {@link PlacesRepo.findActiveExactByNormalizedName}: the ids
 * of ACTIVE, address-public places whose name, normalized here, equals
 * `normalizedName`. Exported so the integration test runs this exact query.
 *
 * The normal form, applied in this order: `normalize(name, NFKC)` (folds
 * no-break, em and other compatibility spaces into U+0020 and composes
 * accents, so "Café" typed two ways is one name), whitespace runs to one
 * space, `btrim`, `lower`. `[[:space:]]` rather than `\s` keeps a backslash
 * out of a JS template literal, where `\s` would cook to a bare `s`.
 * `normalize()` needs Postgres 13+ and a UTF8 database.
 *
 * `lower()` follows the database's LC_CTYPE: under a libc or ICU locale it
 * lower-cases non-ASCII letters as JS `toLowerCase()` does ("CAFÉ" →
 * "café"); under LC_CTYPE=C it folds ASCII only, and "CAFÉ" would not match
 * "café". The integration test pins the behaviour on a UTF8 database; a
 * database created with the C locale breaks the non-ASCII case.
 *
 * No index: the predicate is a function of `name`, so this is a sequential
 * scan of "Place" — trivial at a few thousand rows. If the table grows past
 * that, an expression index on the same expression (every function in it is
 * IMMUTABLE) makes it an index lookup.
 */
export async function findActiveExactPlaceIdsByNormalizedName(
  p: PrismaClientOrTx,
  input: { normalizedName: string; excludePlaceId?: string; limit?: number },
): Promise<string[]> {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
  const exclude = input.excludePlaceId ?? null;
  const rows = await p.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT pl.id
    FROM "Place" pl
    WHERE pl.status = 'ACTIVE'
      AND pl.location_mode = 'EXACT'
      AND lower(btrim(regexp_replace(normalize(pl.name, NFKC), '[[:space:]]+', ' ', 'g'))) = ${input.normalizedName}
      AND (${exclude}::text IS NULL OR pl.id <> ${exclude}::text)
    ORDER BY pl.id
    LIMIT ${limit}::int
  `);
  return rows.map((row) => row.id);
}

/**
 * The `updateMany` args for {@link PlacesRepo.setFlag}: write `value` to the
 * one flag column, only while the row holds `!value`. A switch rather than a
 * computed key so each branch is a literal Prisma checks column by column.
 */
function placeFlagUpdate(
  placeId: string,
  flag: PlaceFlag,
  value: boolean,
): Prisma.PlaceUpdateManyArgs {
  switch (flag) {
    case "acceptsBookingRequests":
      return {
        where: { id: placeId, acceptsBookingRequests: !value },
        data: { acceptsBookingRequests: value },
      };
    case "attendeeReviewsPublic":
      return {
        where: { id: placeId, attendeeReviewsPublic: !value },
        data: { attendeeReviewsPublic: value },
      };
    case "communityReviewsEnabled":
      return {
        where: { id: placeId, communityReviewsEnabled: !value },
        data: { communityReviewsEnabled: value },
      };
  }
}

export function makePlacesRepo(p: PrismaClientOrTx): PlacesRepo {
  const PLACE_SELECT = {
    id: true,
    name: true,
    address: true,
    addrLine1: true,
    addrLine2: true,
    city: true,
    region: true,
    postcode: true,
    country: true,
    addressHash: true,
    admissionTaxRateBps: true,
    taxRateSource: true,
    taxRateFetchedAt: true,
    timezone: true,
    capacity: true,
    lat: true,
    lng: true,
    phone: true,
    website: true,
    websiteSource: true,
    status: true,
    verification: true,
    defaultPrimaryPayoutTermsId: true,
    defaultResalePayoutTermsId: true,
    listedInDirectory: true,
    acceptsBookingRequests: true,
    acceptsCommunityListings: true,
    attendeeReviewsPublic: true,
    communityReviewsEnabled: true,
    // Address privacy. Selected on EVERY read path so no caller can end up
    // holding a place row that cannot answer "may I publish this address?".
    locationMode: true,
    locationRadiusMeters: true,
    locationLabel: true,
    createdAt: true,
    updatedAt: true,
  } as const;

  const OWNERSHIP_SELECT = {
    ownerId: true,
    ownerType: true,
    verified: true,
    revokedAt: true,
  } as const;

  type PlaceRow = {
    id: string;
    name: string;
    address: string | null;
    addrLine1: string | null;
    addrLine2: string | null;
    city: string | null;
    region: string | null;
    postcode: string | null;
    country: string | null;
    addressHash: string | null;
    admissionTaxRateBps: number | null;
    taxRateSource: string | null;
    taxRateFetchedAt: Date | null;
    timezone: string | null;
    capacity: number | null;
    lat: number | null;
    lng: number | null;
    phone: string | null;
    website: string | null;
    websiteSource: PlaceWebsiteSource;
    status: PlaceStatus;
    verification: PlaceVerificationStatus;
    defaultPrimaryPayoutTermsId: string | null;
    defaultResalePayoutTermsId: string | null;
    listedInDirectory: boolean;
    acceptsBookingRequests: boolean;
    acceptsCommunityListings: boolean;
    attendeeReviewsPublic: boolean;
    communityReviewsEnabled: boolean;
    locationMode: EventLocationMode;
    locationRadiusMeters: number | null;
    locationLabel: string | null;
    createdAt: Date;
    updatedAt: Date;
  };

  type OwnershipRow = {
    ownerId: string;
    ownerType: "HUMAN" | "ORGANIZATION";
    verified: boolean;
    revokedAt: Date | null;
  };

  async function toPlaceRecord(
    row: PlaceRow,
    ownerships?: OwnershipRow[],
  ): Promise<PlaceRecord> {
    // Access is gated on VERIFIED, non-revoked ownership (claim-venue-flow
    // FR-005). A PROVISIONAL claim (verified=false) marks WHO claimed the venue
    // but confers NO edit access; a soft-revoked (revokedAt set) row confers
    // none either. All pre-existing ownership rows are verified=true /
    // revokedAt=null, so this is behavior-preserving for them.
    //
    // When ownerships are not pre-loaded, fetch only access-granting rows.
    // Callers may pass a pre-filtered set explicitly; we re-apply the same
    // predicate defensively so a provisional row can never leak access.
    const resolvedOwnerships =
      ownerships ??
      (await p.placeOwnership.findMany({
        where: { placeId: row.id, verified: true, revokedAt: null },
        select: OWNERSHIP_SELECT,
      }));

    const accessOwnerships = resolvedOwnerships.filter(
      (o) => o.verified && o.revokedAt === null,
    );

    const orgIdsWithAccess = accessOwnerships
      .filter((o) => o.ownerType === "ORGANIZATION")
      .map((o) => o.ownerId);
    const humanIdsWithAccess = accessOwnerships
      .filter((o) => o.ownerType === "HUMAN")
      .map((o) => o.ownerId);

    return {
      id: row.id,
      name: row.name,
      formattedAddress: row.address,
      addressLine1: row.addrLine1,
      addressLine2: row.addrLine2,
      city: row.city,
      region: row.region,
      postalCode: row.postcode,
      countryCode: row.country,
      addressHash: row.addressHash,
      admissionTaxRateBps: row.admissionTaxRateBps,
      taxRateSource: row.taxRateSource,
      taxRateFetchedAt: row.taxRateFetchedAt,
      timezone: row.timezone,
      capacity: row.capacity,
      lat: row.lat,
      lng: row.lng,
      phone: row.phone,
      website: row.website,
      websiteSource: row.websiteSource,
      status: row.status as PlaceStatus,
      verificationStatus: row.verification as PlaceVerificationStatus,
      listedInDirectory: row.listedInDirectory,
      acceptsBookingRequests: row.acceptsBookingRequests,
      acceptsCommunityListings: row.acceptsCommunityListings,
      attendeeReviewsPublic: row.attendeeReviewsPublic,
      communityReviewsEnabled: row.communityReviewsEnabled,
      // Fail-closed on the way OUT of the database too: a row whose
      // `location_mode` somehow arrives as null/unknown is treated as
      // OBSCURED, never as EXACT. The column is NOT NULL with an EXACT
      // default, so this only ever fires on a hand-built row — which is
      // precisely the case where a silent `?? "EXACT"` would leak.
      locationMode: row.locationMode === "EXACT" ? "EXACT" : "OBSCURED",
      locationRadiusMeters: row.locationRadiusMeters ?? null,
      locationLabel: row.locationLabel ?? null,
      orgIdsWithAccess,
      humanIdsWithAccess,
      defaultPrimaryPayoutTermsId: row.defaultPrimaryPayoutTermsId ?? null,
      defaultResalePayoutTermsId: row.defaultResalePayoutTermsId ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } satisfies PlaceRecord;
  }

  /** Map a Prisma PLACE_SELECT result to a PlaceRow for toPlaceRecord. */
  function placeRowFromSelect(place: {
    id: string;
    name: string;
    address: string;
    addrLine1: string | null;
    addrLine2: string | null;
    city: string | null;
    region: string | null;
    postcode: string | null;
    country: string | null;
    addressHash: string | null;
    admissionTaxRateBps: number | null;
    taxRateSource: string | null;
    taxRateFetchedAt: Date | null;
    timezone: string | null;
    capacity: number | null;
    lat: number | null;
    lng: number | null;
    phone: string | null;
    website: string | null;
    websiteSource: string;
    status: string;
    verification: string;
    defaultPrimaryPayoutTermsId: string | null;
    defaultResalePayoutTermsId: string | null;
    listedInDirectory: boolean;
    acceptsBookingRequests: boolean;
    acceptsCommunityListings: boolean;
    attendeeReviewsPublic: boolean;
    communityReviewsEnabled: boolean;
    locationMode: string;
    locationRadiusMeters: number | null;
    locationLabel: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): PlaceRow {
    return {
      id: place.id,
      name: place.name,
      address: place.address,
      addrLine1: place.addrLine1,
      addrLine2: place.addrLine2,
      city: place.city,
      region: place.region,
      postcode: place.postcode,
      country: place.country,
      addressHash: place.addressHash,
      admissionTaxRateBps: place.admissionTaxRateBps,
      taxRateSource: place.taxRateSource,
      taxRateFetchedAt: place.taxRateFetchedAt,
      timezone: place.timezone,
      capacity: place.capacity,
      lat: place.lat,
      lng: place.lng,
      phone: place.phone,
      website: place.website,
      websiteSource: place.websiteSource as PlaceWebsiteSource,
      status: place.status as PlaceStatus,
      verification: place.verification as PlaceVerificationStatus,
      defaultPrimaryPayoutTermsId: place.defaultPrimaryPayoutTermsId,
      defaultResalePayoutTermsId: place.defaultResalePayoutTermsId,
      listedInDirectory: place.listedInDirectory,
      acceptsBookingRequests: place.acceptsBookingRequests,
      acceptsCommunityListings: place.acceptsCommunityListings,
      attendeeReviewsPublic: place.attendeeReviewsPublic,
      communityReviewsEnabled: place.communityReviewsEnabled,
      // Fail-closed cast: only the literal "EXACT" survives as EXACT.
      locationMode: place.locationMode === "EXACT" ? "EXACT" : "OBSCURED",
      locationRadiusMeters: place.locationRadiusMeters,
      locationLabel: place.locationLabel,
      createdAt: place.createdAt,
      updatedAt: place.updatedAt,
    };
  }

  return {
    async getById(id) {
      const place = await p.place.findUnique({
        where: { id },
        select: PLACE_SELECT,
      });

      if (!place) {
        return null;
      }

      return toPlaceRecord(placeRowFromSelect(place));
    },

    async getByIds(ids) {
      const unique = [...new Set(ids)];
      const result = new Map<string, PlaceRecord>();
      if (unique.length === 0) return result;
      // Same select, ownership predicate and mapping as `getById`, so each
      // record is identical to what the point read returns — but TWO queries
      // for the page (rows, then every access-granting ownership), not one
      // ownership read per place.
      const places = await p.place.findMany({
        where: { id: { in: unique } },
        select: PLACE_SELECT,
      });
      if (places.length === 0) return result;
      const ownerships = await p.placeOwnership.findMany({
        where: {
          placeId: { in: places.map((place) => place.id) },
          verified: true,
          revokedAt: null,
        },
        select: { ...OWNERSHIP_SELECT, placeId: true },
      });
      const ownershipsByPlace = new Map<string, OwnershipRow[]>();
      for (const { placeId, ...ownership } of ownerships) {
        const bucket = ownershipsByPlace.get(placeId) ?? [];
        bucket.push(ownership);
        ownershipsByPlace.set(placeId, bucket);
      }
      for (const place of places) {
        result.set(
          place.id,
          await toPlaceRecord(
            placeRowFromSelect(place),
            ownershipsByPlace.get(place.id) ?? [],
          ),
        );
      }
      return result;
    },

    async upsert(input: UpsertPlaceInput) {
      const data = buildPlaceData(input);

      const place = input.placeId
        ? await p.place.update({
            where: { id: input.placeId },
            data,
            select: PLACE_SELECT,
          })
        : await p.place.create({
            data: data as Parameters<typeof p.place.create>[0]["data"],
            select: PLACE_SELECT,
          });

      if (input.owner) {
        const owner = input.owner;
        // Default verified=true preserves every legacy caller (org/human create
        // paths). The claim flow uses createProvisionalOwnership instead, so it
        // never reaches this branch with verified=false — but we honor the flag
        // defensively for any future caller.
        const verified = input.ownerVerified ?? true;
        await p.placeOwnership.upsert({
          where: {
            placeId_ownerType_ownerId: {
              placeId: place.id,
              ownerType: owner.kind === "org" ? "ORGANIZATION" : "HUMAN",
              ownerId: owner.kind === "org" ? owner.orgId : owner.humanId,
            },
          },
          update: {
            verified,
          },
          create: {
            placeId: place.id,
            ownerType: owner.kind === "org" ? "ORGANIZATION" : "HUMAN",
            ownerId: owner.kind === "org" ? owner.orgId : owner.humanId,
            verified,
          },
        });
      }

      return toPlaceRecord(placeRowFromSelect(place));
    },

    async setStatus(input) {
      const place = await p.place.update({
        where: { id: input.placeId },
        data: { status: input.status },
        select: PLACE_SELECT,
      });
      return toPlaceRecord(placeRowFromSelect(place));
    },

    async compareAndSetStatus(input) {
      const { count } = await p.place.updateMany({
        where: { id: input.placeId, status: input.from },
        data: { status: input.to },
      });
      return { changed: count === 1 };
    },

    async setDirectoryListing(input) {
      const { count } = await p.place.updateMany({
        where: {
          id: input.placeId,
          listedInDirectory: !input.listedInDirectory,
        },
        data: { listedInDirectory: input.listedInDirectory },
      });
      return { changed: count === 1 };
    },

    async setVerificationStatus(input) {
      const { count } = await p.place.updateMany({
        where: { id: input.placeId, verification: input.from },
        data: { verification: input.to },
      });
      return { changed: count === 1 };
    },

    async setFlag(input) {
      const { count } = await p.place.updateMany(
        placeFlagUpdate(input.placeId, input.flag, input.value),
      );
      return { changed: count === 1 };
    },

    async setCommunityListingAcceptance(input) {
      const { count } = await p.place.updateMany({
        where: {
          id: input.placeId,
          acceptsCommunityListings: !input.accepts,
          ...(input.requireVerified ? { verification: "VERIFIED" as const } : {}),
        },
        data: { acceptsCommunityListings: input.accepts },
      });
      return { changed: count === 1 };
    },

    async listAccessibleByHuman(input: ListAccessiblePlacesByHumanInput) {
      const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
      const offset = Math.max(input.offset ?? 0, 0);
      const trimmedQuery = input.query?.trim();
      const normalizedOrgIds = Array.from(
        new Set(
          (input.orgIds ?? []).map((value) => value.trim()).filter(Boolean),
        ),
      );

      const includeOwnedUnverified = input.includeOwnedUnverified ?? false;
      const ownedOnly = input.ownedOnly ?? false;
      const includeActorOwnedWithOrgs =
        input.includeActorOwnedWithOrgs ?? false;

      // When ownedOnly + orgIds are both set, the caller is scoping to a
      // specific org context (e.g. the event builder).  Only return
      // org-owned places — *not* places the human owns personally — so the
      // UI never surfaces venues the org cannot actually use.
      //
      // `includeActorOwnedWithOrgs` opts OUT of that narrowing for the
      // PERSONAL admin context, which is a hub rather than a tenant: there,
      // "your venues" is the union of what you hold yourself and what your
      // orgs hold. Still ownership-only — the global `verification: VERIFIED`
      // OR-branch below stays off whenever `ownedOnly` is set, so this can
      // never widen back into "every venue on the platform".
      // `revokedAt: null` is UNCONDITIONAL, unlike `verified`.
      //
      // A soft-revoked ownership row confers no access anywhere else in this
      // file — `listOwnedBySubject` requires it, and `toPlaceRecord` drops
      // revoked rows when computing `orgIdsWithAccess`/`humanIdsWithAccess`.
      // It was missing HERE, so a revoked owner kept seeing the venue in their
      // admin Places table while every other surface (the booking inbox
      // included) had correctly let go of it — the last way those two lists
      // could disagree about "your venues".
      //
      // `verified` stays conditional on purpose: an unverified claim on a stub
      // the actor created IS legitimately theirs to see, which is what
      // `includeOwnedUnverified` exists for. A REVOKED one never is.
      const ownershipBase = { revokedAt: null };
      const ownershipFilter =
        normalizedOrgIds.length > 0
          ? ownedOnly && !includeActorOwnedWithOrgs
            ? {
                ...ownershipBase,
                ownerType: "ORGANIZATION" as const,
                ownerId: { in: normalizedOrgIds },
                ...(includeOwnedUnverified ? {} : { verified: true }),
              }
            : {
                OR: [
                  {
                    ...ownershipBase,
                    ownerType: "HUMAN" as const,
                    ownerId: input.humanId,
                    ...(includeOwnedUnverified ? {} : { verified: true }),
                  },
                  {
                    ...ownershipBase,
                    ownerType: "ORGANIZATION" as const,
                    ownerId: { in: normalizedOrgIds },
                    ...(includeOwnedUnverified ? {} : { verified: true }),
                  },
                ],
              }
          : {
              ...ownershipBase,
              ownerType: "HUMAN" as const,
              ownerId: input.humanId,
              ...(includeOwnedUnverified ? {} : { verified: true }),
            };

      // Lifecycle scope. Applied in SQL so BOTH the page and the count share
      // it — pageInfo.total must reflect the filter or pagination lies.
      // undefined = LEGACY ACTIVE-only scope: every pre-existing caller
      // (place picker, org-admin search, bookings hub) was written against
      // that behavior, so absence of the param must not widen the result set.
      const statusWhere =
        input.status === undefined
          ? { status: "ACTIVE" as const }
          : input.status === "active"
            ? { status: { not: "ARCHIVED" as const } }
            : input.status === "archived"
              ? { status: "ARCHIVED" as const }
              : {}; // "all" — no status constraint

      // Sort applied in SQL BEFORE pagination (default: name asc, matching
      // the historical hard-coded ordering). `id` tiebreak keeps pages
      // stable. Capacity sorts nulls last in both directions.
      const sortField = input.sort?.field ?? "name";
      const sortDirection = input.sort?.direction ?? "asc";
      const orderBy: Prisma.PlaceOrderByWithRelationInput[] =
        sortField === "created"
          ? [{ createdAt: sortDirection }, { id: "asc" }]
          : sortField === "capacity"
            ? [
                { capacity: { sort: sortDirection, nulls: "last" } },
                { id: "asc" },
              ]
            : sortField === "status"
              ? // Postgres enum order: ACTIVE, SUSPENDED, ARCHIVED.
                [{ status: sortDirection }, { name: "asc" }, { id: "asc" }]
              : [{ name: sortDirection }, { id: "asc" }];

      // Semantics:
      // - When `ownedOnly` is true, ONLY return places the actor/orgs own.
      // - Otherwise, also include globally verified places (even not owned).
      // - When `includeOwnedUnverified` is true, the owned places can be unverified.
      //   When FALSE, `verification = VERIFIED` is enforced HERE, in the where
      //   clause shared by count + findMany — so pageInfo.total reflects the
      //   verified-only scope instead of a post-pagination filter lying about it.
      // - Status scope per `statusWhere` above (legacy default: ACTIVE only).
      const baseWhere = {
        ...statusWhere,
        ...(includeOwnedUnverified
          ? {}
          : { verification: "VERIFIED" as const }),
        // The street arm matches EXACT places ONLY. Inclusion in this list is
        // itself an answer: with `ownedOnly: false` any signed-in user sees
        // every VERIFIED venue, and even with the rows redacted, "does a venue
        // come back for `elm st`?" is a substring oracle on the street of a
        // venue that withholds its address — tens of queries recover it. The
        // same predicate backs the org-admin spotlight (`searchOrgAdmin`),
        // where a door SCANNER could run the probe against its own org's
        // withheld venues. A withheld venue is still found by `name` or
        // `city`, both of which it publishes; its owners find it by name.
        ...(trimmedQuery
          ? {
              OR: [
                {
                  name: {
                    contains: trimmedQuery,
                    mode: "insensitive" as const,
                  },
                },
                {
                  AND: [
                    { locationMode: "EXACT" as const },
                    {
                      address: {
                        contains: trimmedQuery,
                        mode: "insensitive" as const,
                      },
                    },
                  ],
                },
                {
                  city: {
                    contains: trimmedQuery,
                    mode: "insensitive" as const,
                  },
                },
              ],
            }
          : {}),
      };

      // When ownedOnly, skip the global verified clause — only match owned places.
      const accessFilter = ownedOnly
        ? {
            ownerships: {
              some: ownershipFilter,
            },
          }
        : {
            OR: [
              { verification: "VERIFIED" as const },
              {
                ownerships: {
                  some: ownershipFilter,
                },
              },
            ],
          };

      const fullWhere = {
        ...baseWhere,
        AND: [accessFilter],
      };

      const [total, places] = await Promise.all([
        p.place.count({ where: fullWhere }),
        p.place.findMany({
          where: fullWhere,
          select: {
            ...PLACE_SELECT,
            ownerships: {
              where: includeOwnedUnverified ? undefined : { verified: true },
              select: OWNERSHIP_SELECT,
            },
            // Filtered relation count — a single aggregated subquery over
            // the page, NOT a per-row query. Scoped to PUBLISHED + PUBLIC
            // events only: globally-VERIFIED venues are listable by any
            // signed-in user, so counting other organizers' DRAFT or PRIVATE
            // (link-only) events would leak cross-tenant activity metadata.
            // Events are hard-deleted (object-deletion outbox) — no
            // deleted-rows predicate needed.
            _count: {
              select: {
                events: { where: { status: "PUBLISHED", visibility: "PUBLIC" } },
              },
            },
          },
          orderBy,
          skip: offset,
          take: limit,
        }),
      ]);

      const items = await Promise.all(
        places.map(async (place) => ({
          ...(await toPlaceRecord(placeRowFromSelect(place), place.ownerships)),
          eventsCount: place._count.events,
        })),
      );

      return {
        items,
        pageInfo: buildOffsetPageInfo({
          total,
          limit,
          offset,
          count: items.length,
        }),
      };
    },

    async listOwnedBySubject(input: ListOwnedPlacesBySubjectInput) {
      const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);

      // Ownership predicate = VERIFIED + non-revoked ONLY.
      //
      // This is the security boundary for the public (actor-free) embed widget
      // read paths. A PROVISIONAL claim (verified=false) or a soft-revoked row
      // (revokedAt set) confers NO ownership — exactly the predicate
      // `toPlaceRecord` uses to compute humanIdsWithAccess/orgIdsWithAccess.
      // Without the `verified: true` clause, anyone could file an unreviewed
      // claim against a rival venue and immediately pull that venue's public
      // calendar onto their own website.
      //
      // The place's own `verificationStatus` is deliberately NOT required:
      // a self-created stub place is legitimately the owner's to list, and
      // because events are keyed to a specific `placeId`, a duplicate stub of
      // a real venue carries none of the real venue's events — nothing leaks.
      const places = await p.place.findMany({
        where: {
          status: "ACTIVE",
          ownerships: {
            some: {
              ownerType: input.ownerType,
              ownerId: input.ownerId,
              verified: true,
              revokedAt: null,
            },
          },
        },
        select: {
          ...PLACE_SELECT,
          ownerships: {
            where: { verified: true, revokedAt: null },
            select: OWNERSHIP_SELECT,
          },
        },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        take: limit,
      });

      return Promise.all(
        places.map((place) =>
          toPlaceRecord(placeRowFromSelect(place), place.ownerships),
        ),
      );
    },

    async listWithheldOwnedNearPoint(input: ListWithheldOwnedNearPointInput) {
      const limit = Math.min(Math.max(Math.trunc(input.limit ?? 5), 1), 20);
      const withinMeters = Math.min(Math.max(input.withinMeters, 1), 1000);
      if (!Number.isFinite(input.lat) || !Number.isFinite(input.lng)) return [];
      // A box at least `withinMeters` wide in each direction. 111 320 m per
      // degree of latitude; longitude degrees shrink by cos(lat) (floored so
      // a pole never divides by ~0). The caller measures the true distance.
      const METERS_PER_DEGREE = 111_320;
      const dLat = withinMeters / METERS_PER_DEGREE;
      const dLng =
        withinMeters /
        (METERS_PER_DEGREE *
          Math.max(Math.cos((input.lat * Math.PI) / 180), 0.01));
      const orgIds = [...new Set(input.orgIds)].filter((id) => id.length > 0);

      // OWNER-SCOPED (port doc): only the caller's own places are ever
      // candidates, so nothing here can answer "is there a withheld venue
      // near this point" for a stranger — not by result, not by timing.
      // The ownership predicate is `toPlaceRecord`'s: verified, unrevoked.
      const ownershipScope = {
        verified: true,
        revokedAt: null,
        OR: [
          { ownerType: "HUMAN" as const, ownerId: input.humanId },
          ...(orgIds.length > 0
            ? [{ ownerType: "ORGANIZATION" as const, ownerId: { in: orgIds } }]
            : []),
        ],
      };
      const places = await p.place.findMany({
        where: {
          status: "ACTIVE",
          locationMode: { not: "EXACT" },
          lat: { gte: input.lat - dLat, lte: input.lat + dLat },
          lng: { gte: input.lng - dLng, lte: input.lng + dLng },
          ownerships: { some: ownershipScope },
        },
        select: {
          ...PLACE_SELECT,
          ownerships: {
            where: { verified: true, revokedAt: null },
            select: OWNERSHIP_SELECT,
          },
        },
        orderBy: [{ id: "asc" }],
        take: limit,
      });

      return Promise.all(
        places.map((place) =>
          toPlaceRecord(placeRowFromSelect(place), place.ownerships),
        ),
      );
    },

    async listAll(input: ListAllPlacesInput) {
      const page = sanitizeOffsetPagination({
        limit: input.limit,
        offset: input.offset,
        defaultLimit: 25,
        maxLimit: 100,
      });

      const trimmedQuery = input.query?.trim();

      const where: Record<string, unknown> = {};

      if (input.verificationStatus && input.verificationStatus.length > 0) {
        where.verification = { in: input.verificationStatus };
      }
      if (input.status && input.status.length > 0) {
        where.status = { in: input.status };
      }
      if (input.listedInDirectory !== undefined) {
        where.listedInDirectory = input.listedInDirectory;
      }
      if (input.placeIds !== undefined) {
        where.id = { in: input.placeIds };
      }
      if (trimmedQuery && trimmedQuery.length > 0) {
        where.OR = [
          { name: { contains: trimmedQuery, mode: "insensitive" as const } },
          // Deliberately NOT `Place.slug`: that column is deprecated (a
          // multi-segment directory key nothing routes on) and is no longer
          // minted, so matching it would only ever hit legacy rows.
          //
          // The street arm is UNRESTRICTED here, unlike `listAccessibleByHuman`:
          // the only caller is the platform-staff places table
          // (`listPlatformPlaces`, STAFF_ONLY), whose readers are allowed the
          // true address of a withheld venue anyway. Do not reuse this finder
          // on a non-staff surface without adding the EXACT-only guard.
          { address: { contains: trimmedQuery, mode: "insensitive" as const } },
          { city: { contains: trimmedQuery, mode: "insensitive" as const } },
        ];
      }

      const [total, places] = await Promise.all([
        p.place.count({ where }),
        p.place.findMany({
          where,
          select: {
            ...PLACE_SELECT,
            ownerships: {
              select: OWNERSHIP_SELECT,
            },
          },
          orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
          take: page.limit,
          skip: page.offset,
        }),
      ]);

      const items = await Promise.all(
        places.map((place) =>
          toPlaceRecord(placeRowFromSelect(place), place.ownerships),
        ),
      );

      return buildOffsetPaginatedResult({
        items,
        total,
        limit: page.limit,
        offset: page.offset,
      });
    },

    async listForSearchIndex({ limit, offset }) {
      const page = sanitizeOffsetPagination({
        limit,
        offset,
        defaultLimit: 100,
        maxLimit: 1000,
      });

      const where = {
        status: "ACTIVE" as const,
      };

      const [total, places] = await Promise.all([
        p.place.count({ where }),
        p.place.findMany({
          where,
          select: {
            ...PLACE_SELECT,
            ownerships: {
              where: { verified: true },
              select: OWNERSHIP_SELECT,
            },
          },
          orderBy: [{ name: "asc" }, { id: "asc" }],
          take: page.limit,
          skip: page.offset,
        }),
      ]);

      const items = await Promise.all(
        places.map((place) =>
          toPlaceRecord(placeRowFromSelect(place), place.ownerships),
        ),
      );

      return buildOffsetPaginatedResult({
        items,
        total,
        limit: page.limit,
        offset: page.offset,
      });
    },

    async listForSitemap(input) {
      // Cap at Google's 50k-per-sitemap-file limit. The sitemaps job shards
      // output at 45k URLs/file, so a single 50k read fills at most ~2 files.
      // TODO: >50k places will need cursor pagination here.
      const take = Math.min(Math.max(input?.limit ?? 50000, 1), 50000);

      const records = await p.place.findMany({
        where: {
          status: "ACTIVE",
          events: {
            some: {
              status: "PUBLISHED",
              visibility: "PUBLIC",
            },
          },
        },
        orderBy: { updatedAt: "desc" },
        take,
        select: {
          id: true,
          updatedAt: true,
        },
      });

      // Hydrate each place's EntityPage slug — the ONLY identifier `/p/[slug]`
      // resolves on — together with its VISIBILITY, which decides whether that
      // slug may be published at all (the policy itself lives in core, see
      // `lib/entity-page-visibility`; this repo just carries the facts).
      //
      // EntityPage is polymorphic (ownerType + ownerId), so there is no Prisma
      // relation to include; this is a second, index-backed read over
      // `@@index([ownerType, ownerId])`, chunked so a 50k page never builds a
      // 50k-parameter IN list. Chunks are independent, so they run together
      // rather than as 25 sequential round trips at the 50k cap.
      const ENTITY_PAGE_LOOKUP_CHUNK = 2000;
      const idChunks: string[][] = [];
      for (let i = 0; i < records.length; i += ENTITY_PAGE_LOOKUP_CHUNK) {
        idChunks.push(
          records.slice(i, i + ENTITY_PAGE_LOOKUP_CHUNK).map((r) => r.id),
        );
      }
      const chunkResults = await Promise.all(
        idChunks.map((ids) =>
          p.entityPage.findMany({
            where: { ownerType: "PLACE", ownerId: { in: ids } },
            select: { ownerId: true, slug: true, visibility: true },
          }),
        ),
      );
      const pageByPlaceId = new Map(
        chunkResults.flat().map((page) => [page.ownerId, page]),
      );

      return records.map<PlaceSitemapEntryRecord>((record) => {
        const page = pageByPlaceId.get(record.id);
        return {
          placeId: record.id,
          pageSlug: page?.slug ?? null,
          pageVisibility: page?.visibility ?? null,
          updatedAt: record.updatedAt ?? null,
        };
      });
    },

    async countDirectory(input) {
      // A directory place is `Place.status = ACTIVE AND
      // Place.listedInDirectory = true`; when a `near` scope is given,
      // additionally `lat`/`lng` are non-null and within `radiusKm` of the
      // point.
      if (!input?.near) {
        return p.place.count({
          where: { status: "ACTIVE", listedInDirectory: true },
        });
      }

      const { lat, lng, radiusKm } = input.near;
      const radiusM = radiusKm * 1000;
      // Same earthdistance/cube pattern as EventsRepo.pickRandom: `earth_box`
      // narrows to an index-friendly bounding box, `earth_distance` refines to
      // a true great-circle radius. Table is "Place" (no @@map); the listing
      // flag is @map("listed_in_directory").
      //
      // EXACT venues ONLY in the near-scoped count. The radius has no floor,
      // so counting a withheld venue by its TRUE point makes this anonymous
      // endpoint a presence oracle — shrink the radius around a guess and the
      // count drops by one exactly when the house leaves it. A venue that
      // withholds its address is simply not counted "near" anything.
      const rows = await p.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        SELECT COUNT(*)::int AS count
        FROM "Place" pl
        WHERE pl.status = 'ACTIVE'
          AND pl.listed_in_directory = true
          AND pl.location_mode = 'EXACT'
          AND pl.lat IS NOT NULL
          AND pl.lng IS NOT NULL
          AND earth_box(ll_to_earth(${lat}::float8, ${lng}::float8), ${radiusM}::float8) @> ll_to_earth(pl.lat, pl.lng)
          AND earth_distance(ll_to_earth(${lat}::float8, ${lng}::float8), ll_to_earth(pl.lat, pl.lng)) <= ${radiusM}::float8
      `);
      return rows[0]?.count ?? 0;
    },

    async deletePlace(placeId: string): Promise<void> {
      await p.place.delete({ where: { id: placeId } });
    },

    async updateTaxRate({
      id,
      admissionTaxRateBps,
      taxRateSource,
      taxRateFetchedAt,
    }) {
      await p.place.update({
        where: { id },
        data: { admissionTaxRateBps, taxRateSource, taxRateFetchedAt },
      });
    },

    async fillTaxRateIfUnset({
      id,
      expectedPostalCode,
      expectedCountryCode,
      admissionTaxRateBps,
      taxRateSource,
      taxRateFetchedAt,
    }) {
      // Compare-and-set (port doc): only an EMPTY cache, and only while the
      // row still has the address the rate was looked up for.
      const { count } = await p.place.updateMany({
        where: {
          id,
          admissionTaxRateBps: null,
          postcode: expectedPostalCode,
          country: expectedCountryCode,
        },
        data: { admissionTaxRateBps, taxRateSource, taxRateFetchedAt },
      });
      return count > 0;
    },

    async updateTimezone({ id, timezone }) {
      // Mirrors updateTaxRate: callers only ever pass a NON-null value (a
      // failed lookup keeps the previously-derived timezone — port doc).
      await p.place.update({
        where: { id },
        data: { timezone },
      });
    },

    async bulkCreate(places: BulkCreatePlaceInput[]) {
      if (places.length === 0) return { created: 0 };

      const now = new Date();

      const placeData = places.map((pl) => ({
        id: pl.id,
        name: pl.name,
        address: pl.address.formatted,
        addrLine1: pl.address.line1,
        addrLine2: pl.address.line2 ?? null,
        city: pl.address.city ?? null,
        region: pl.address.region ?? null,
        postcode: pl.address.postalCode ?? null,
        country: pl.address.countryCode,
        lat: pl.geo?.lat ?? null,
        lng: pl.geo?.lng ?? null,
        capacity: pl.capacity ?? null,
        phone: pl.phone ?? null,
        website: pl.website ?? null,
        // FAIL-SAFE default. `TRUSTED_IMPORT` unlocks the FR-010 claim
        // fast-track: `submit-place-claim` auto-verifies an email_domain_match
        // against the place's website domain with NO admin review. That is only
        // sound for a genuinely curated feed, so it must be an explicit opt-in
        // by the caller — never something a caller inherits by omission.
        //
        // Bulk import is NOT inherently trusted: the platform CSV importer takes
        // a staff paste and the MCP `import_places` tool takes an LLM scrape.
        // Defaulting those to TRUSTED_IMPORT would arm auto-verify across the
        // whole scraped corpus — a scraped row whose website is a municipal
        // (`nashville.gov`), parent-company (`livenation.com`) or aggregator
        // (`linktr.ee`) domain would hand VERIFIED ownership to any holder of a
        // mailbox at that domain, since `isFreeEmailDomain` only screens ~25
        // consumer mail providers. The spec is explicit that TRUSTED_IMPORT is
        // "set exclusively by verified import paths"
        // (docs/specs/2026-07-05/completed/claim-venue-flow.spec.yaml, FR-010 mitigation),
        // and that existing/unknown rows default to UNKNOWN — no fast-track.
        websiteSource: pl.websiteSource ?? ("UNKNOWN" as const),
        listedInDirectory: pl.listedInDirectory ?? false,
        createdAt: now,
        updatedAt: now,
      }));

      // Ownership rows are written ONLY for places that carry an owner. An
      // owner-less row imports the place UNOWNED, so no verified ownership
      // exists and `getPlaceClaimEligibility` keeps returning `claimable` —
      // the state a scraped venue has to be in for its real operator to claim
      // it. Writing a verified ownership unconditionally (the old behaviour)
      // made every bulk-imported venue permanently unclaimable.
      const ownershipData = places
        // Type-predicate filter, not a bare boolean + `!`: the compiler now
        // enforces the narrowing, so editing the predicate can't silently
        // reintroduce an unchecked `owner` deref in the `map` below.
        .filter(
          (pl): pl is BulkCreatePlaceInput & { owner: PlaceOwnerInput } =>
            pl.owner != null,
        )
        .map((pl) => {
          const owner = pl.owner;
          return {
            placeId: pl.id,
            ownerType:
              owner.kind === "org"
                ? ("ORGANIZATION" as const)
                : ("HUMAN" as const),
            ownerId: owner.kind === "org" ? owner.orgId : owner.humanId,
            verified: true,
          };
        });

      const result = await p.place.createMany({ data: placeData });
      if (result.count !== places.length) {
        throw {
          code: "internal_error",
          message: "place_insert_count_mismatch",
        } as const;
      }
      if (ownershipData.length > 0) {
        await p.placeOwnership.createMany({ data: ownershipData });
      }

      return { created: result.count };
    },

    async getVerifiedOwnershipForPlace(placeId: string) {
      const row = await p.placeOwnership.findFirst({
        where: { placeId, verified: true, revokedAt: null },
        orderBy: { reviewedAt: "desc" },
      });
      return row ? toOwnershipRecord(row) : null;
    },

    async findActiveExactByNormalizedName(input) {
      const ids = await findActiveExactPlaceIdsByNormalizedName(p, input);
      if (ids.length === 0) return [];
      // Same select, ownership predicate and mapping as every other read.
      const byId = await makePlacesRepo(p).getByIds(ids);
      return ids.flatMap((id) => {
        const place = byId.get(id);
        return place ? [place] : [];
      });
    },

    async lockPlaceName(normalizedName: string) {
      // Parameterized; the prefix keeps this key space apart from
      // `lockPlaceForClaim`'s. `hashtext` is 32-bit, so two keys can
      // collide. A collision usually only over-serializes, but it can also
      // close a cycle with another lock (e.g. this name vs. a claim lock
      // taken in the other order) that Postgres detects as a deadlock and
      // aborts one transaction with a retryable error; the use case's
      // `abandonClaim` then releases its idempotency key, so a retry works.
      await p.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`place_name:${normalizedName}`}))`;
    },

    async lockPlaceForClaim(placeId: string) {
      // Transaction-scoped advisory lock so concurrent claimants of the SAME
      // place serialize. `hashtext` maps the placeId deterministically to a
      // bigint key; `pg_advisory_xact_lock` releases when the surrounding tx
      // commits/rolls back, so the next waiter then observes the committed
      // verified owner and bails. Co-ownership is allowed (multiple verified
      // owners per place), so a unique index can't guard this — the lock does.
      // Parameterized to avoid SQL injection.
      await p.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${placeId}))`;
    },

    async lockClaimsByActor(actorHumanId: string) {
      // Parameterized; the prefix keeps this key space apart from
      // `lockPlaceForClaim`'s bare `hashtext(placeId)`. `hashtext` is 32-bit,
      // so a collision can over-serialize or, rarely, close a cycle Postgres
      // aborts as a deadlock (the claim fails and can be resubmitted) — the
      // same trade as `lockPlaceName`.
      await p.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`place_claim_actor:${actorHumanId}`}))`;
    },

    async getOwnershipById(ownershipId: string) {
      const row = await p.placeOwnership.findUnique({
        where: { id: ownershipId },
      });
      return row ? toOwnershipRecord(row) : null;
    },

    async listActiveOwnershipsForPlace(placeId: string) {
      // Every non-revoked row — verified owners AND provisional claims — so a
      // dispute resolution can revoke the full contested set in one pass.
      const rows = await p.placeOwnership.findMany({
        where: { placeId, revokedAt: null },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(toOwnershipRecord);
    },

    async createVerifiedOwnership(input: CreateVerifiedOwnershipInput) {
      // Reuse the (placeId, ownerType, ownerId) row if the identity already
      // holds one (e.g. a just-revoked prior claim) — mirror
      // createProvisionalOwnership's upsert-on-unique-key pattern, but land in
      // the VERIFIED state with the admin reviewer stamped.
      const row = await p.placeOwnership.upsert({
        where: {
          placeId_ownerType_ownerId: {
            placeId: input.placeId,
            ownerType: input.ownerType,
            ownerId: input.ownerId,
          },
        },
        update: {
          verified: true,
          revokedAt: null,
          reviewerHumanId: input.reviewerHumanId,
          reviewedAt: input.reviewedAt,
          proof: input.proof as object,
        },
        create: {
          placeId: input.placeId,
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          verified: true,
          reviewerHumanId: input.reviewerHumanId,
          reviewedAt: input.reviewedAt,
          proof: input.proof as object,
        },
      });
      return toOwnershipRecord(row);
    },

    async createProvisionalOwnership(input: CreateProvisionalOwnershipInput) {
      // A provisional claim reuses the (placeId, ownerType, ownerId) row if one
      // already exists (e.g. a prior REVOKED claim) — flip it back to a fresh
      // provisional state rather than colliding on the unique constraint.
      const row = await p.placeOwnership.upsert({
        where: {
          placeId_ownerType_ownerId: {
            placeId: input.placeId,
            ownerType: input.ownerType,
            ownerId: input.ownerId,
          },
        },
        update: {
          verified: false,
          revokedAt: null,
          reviewerHumanId: null,
          reviewedAt: null,
          proof: input.proof as object,
        },
        create: {
          placeId: input.placeId,
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          verified: false,
          proof: input.proof as object,
        },
      });
      return toOwnershipRecord(row);
    },

    async verifyOwnership(input: VerifyOwnershipInput) {
      // REFUSES to un-revoke: a soft-revoked row (e.g. after an approved
      // dispute transfer) must never be resurrected by a stale claim approval.
      // The conditional WHERE is re-evaluated on the locked row version under
      // READ COMMITTED, so a verify racing a concurrently-committing revoke
      // loses cleanly instead of silently flipping the row back. Safe for the
      // FR-010 fast-track (the only other caller): it verifies a row it just
      // created/reset in the SAME tx under the advisory lock, so revokedAt is
      // always null there.
      const result = await p.placeOwnership.updateMany({
        where: { id: input.ownershipId, revokedAt: null },
        data: {
          verified: true,
          reviewerHumanId: input.reviewerHumanId,
          reviewedAt: input.reviewedAt,
        },
      });
      if (result.count === 0) {
        throw {
          code: "conflict",
          message: "ownership_revoked_or_missing",
        } as const;
      }
      const row = await p.placeOwnership.findUniqueOrThrow({
        where: { id: input.ownershipId },
      });
      return toOwnershipRecord(row);
    },

    async revokeOwnership(input: RevokeOwnershipInput) {
      const row = await p.placeOwnership.update({
        where: { id: input.ownershipId },
        data: { verified: false, revokedAt: input.revokedAt },
      });
      return toOwnershipRecord(row);
    },
  };

  function toOwnershipRecord(row: {
    id: string;
    placeId: string;
    ownerType: "HUMAN" | "ORGANIZATION";
    ownerId: string;
    verified: boolean;
    reviewerHumanId: string | null;
    reviewedAt: Date | null;
    revokedAt: Date | null;
    proof: unknown;
    createdAt: Date;
    updatedAt: Date;
  }): PlaceOwnershipRecord {
    return {
      id: row.id,
      placeId: row.placeId,
      ownerType: row.ownerType,
      ownerId: row.ownerId,
      verified: row.verified,
      reviewerHumanId: row.reviewerHumanId,
      reviewedAt: row.reviewedAt,
      revokedAt: row.revokedAt,
      proof: (row.proof as Record<string, unknown> | null) ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  function buildPlaceData(input: UpsertPlaceInput) {
    const normalizedAddress = input.address.formatted.trim();
    const addressHash = normalizedAddress
      ? normalizedAddress.toLowerCase()
      : null;

    // OMITTED means "leave alone"; explicit `null` means "clear it".
    //
    // These fields deliberately DON'T coerce `undefined` to `null`. Prisma
    // already treats `undefined` as "skip this column" and `null` as "write
    // NULL", which is exactly the contract we want — and the previous
    // `?? null` coercion collapsed those two into one, so every caller that
    // rebuilds a place from a PlaceRecord to flip ONE field silently wiped
    // everything it didn't happen to re-send. Two real callers proved it:
    //
    //   • `toggle-place-directory-listing` omits `geo`, so listing or
    //     unlisting a venue erased its map pin, directions link and
    //     location-search position (seeded venues were found already sitting
    //     at `lat: null` from exactly this path).
    //   • `set-default-payout-terms` rebuilds from only formatted/line1/
    //     countryCode, so a FINANCE member choosing payout terms nulled
    //     city/region/postcode/capacity, resurrected an ARCHIVED venue to
    //     ACTIVE, and demoted a VERIFIED venue to UNVERIFIED — and
    //     `verification` gates visibility in `listAccessibleByHuman`, so the
    //     venue quietly dropped out of the picker for every non-owner.
    //
    // `status` and `verification` are safe to omit on CREATE: both carry a
    // Prisma `@default` (ACTIVE / UNVERIFIED). The rest are nullable columns.
    // Mirrors the hasOwnProperty guards used for phone/website below.
    const data: Record<string, unknown> = {
      name: input.name,
      address: normalizedAddress,
      addrLine1: input.address.line1,
      addrLine2: input.address.line2,
      city: input.address.city,
      region: input.address.region,
      postcode: input.address.postalCode,
      country: input.address.countryCode,
      capacity: input.capacity,
      status: input.status,
      verification: input.verificationStatus,
      addressHash,
    };

    if (Object.prototype.hasOwnProperty.call(input, "geo")) {
      data.lat = input.geo?.lat ?? null;
      data.lng = input.geo?.lng ?? null;
    }

    // Only write phone/website when the caller explicitly provides the key.
    // Callers that rebuild a place from a PlaceRecord to flip ONE field (e.g.
    // the claim submit + verification review, which omit phone/website) must
    // not null out the venue's website — that website is the very proof of
    // ownership. Mirrors the hasOwnProperty guard used for the other optional
    // columns below. An explicit `website: null` still clears it.
    if (Object.prototype.hasOwnProperty.call(input, "phone")) {
      data.phone = input.phone ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(input, "website")) {
      data.website = input.website ?? null;
    }

    if (
      Object.prototype.hasOwnProperty.call(input, "defaultPrimaryPayoutTermsId")
    ) {
      data.defaultPrimaryPayoutTermsId =
        input.defaultPrimaryPayoutTermsId ?? null;
    }
    if (
      Object.prototype.hasOwnProperty.call(input, "defaultResalePayoutTermsId")
    ) {
      data.defaultResalePayoutTermsId =
        input.defaultResalePayoutTermsId ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(input, "listedInDirectory")) {
      data.listedInDirectory = input.listedInDirectory;
    }
    if (Object.prototype.hasOwnProperty.call(input, "acceptsBookingRequests")) {
      data.acceptsBookingRequests = input.acceptsBookingRequests;
    }
    if (
      Object.prototype.hasOwnProperty.call(input, "acceptsCommunityListings")
    ) {
      data.acceptsCommunityListings = input.acceptsCommunityListings;
    }
    if (Object.prototype.hasOwnProperty.call(input, "attendeeReviewsPublic")) {
      data.attendeeReviewsPublic = input.attendeeReviewsPublic;
    }
    if (
      Object.prototype.hasOwnProperty.call(input, "communityReviewsEnabled")
    ) {
      data.communityReviewsEnabled = input.communityReviewsEnabled;
    }
    // Address privacy. Same OMITTED-preserves contract as every field above —
    // and it matters MORE here than anywhere else in this function, because
    // the failure mode of an accidental write is a withheld venue being
    // silently un-withheld by a caller that only wanted to flip a payout term.
    //
    // `locationRadiusMeters: null` is NOT a "clear": under OBSCURED it is the
    // documented FULLY-HIDDEN sentinel, i.e. the strictest setting. So the
    // hasOwnProperty guard is what distinguishes "don't touch it" from "hide
    // the map entirely"; a `?? null` here would hide every venue any caller
    // ever re-saved.
    if (Object.prototype.hasOwnProperty.call(input, "locationMode")) {
      data.locationMode = input.locationMode;
    }
    if (Object.prototype.hasOwnProperty.call(input, "locationRadiusMeters")) {
      data.locationRadiusMeters = input.locationRadiusMeters ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(input, "locationLabel")) {
      data.locationLabel = input.locationLabel ?? null;
    }
    // Only write websiteSource when the caller explicitly provides it, so
    // ordinary upserts never clobber a place's provenance marker back to
    // UNKNOWN. The USER_STUB / TRUSTED_IMPORT paths set it deliberately.
    if (Object.prototype.hasOwnProperty.call(input, "websiteSource")) {
      data.websiteSource = input.websiteSource;
    }

    return data;
  }
}
