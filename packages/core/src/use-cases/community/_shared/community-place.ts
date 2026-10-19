import { createHash } from "node:crypto";
import { z } from "zod";

import type { ContentFilterPort } from "@th/ports/content-filter";
import type { PlaceRecord, TxRepos } from "@th/ports/repos";
import { fail } from "@th/errors";

import { haversineDistance } from "../../../lib/geo/haversine";
import { PLACE_UNIT_MAX_LENGTH } from "../../../lib/location/place-unit";
import {
  plainTextOptional,
  plainTextRequired,
} from "../../../lib/sanitize-plain-text";
import { assertOwnerlessWriteAllowed } from "../../places/_shared/ownerless-write-guard";
import type { NormalizedPlaceAddress } from "../../places/upsert-place";
import { checkBlocked } from "./suggestion-validation";
import { suggestionRejection } from "./suggestion-rejection";

/**
 * What the community-place use cases share: a place a community moderator
 * adds, corrects, archives or restores while NOBODY owns it (owner ruling
 * 2026-10-13). `createCommunityPlace`, `updateCommunityPlace`,
 * `archiveCommunityPlace`, `restoreCommunityPlace`.
 */

/**
 * Same name within this distance of the pin = the same place. Matches
 * `VENUE_MOVE_THRESHOLD_METERS`, the distance a listing's pin may drift
 * before it counts as moved.
 */
export const DUPLICATE_RADIUS_METERS = 50;

/** How many same-name candidates the duplicate guard reads. */
const DUPLICATE_CANDIDATE_LIMIT = 50;

export const communityPlaceNameSchema = plainTextRequired(140).pipe(
  z.string().min(2),
);

/** A place's "Unit or room" line; null or "" = none. */
export const communityPlaceUnitSchema = plainTextOptional(
  PLACE_UNIT_MAX_LENGTH,
).nullable();

export const communityPlaceAddressSchema = z
  .object({
    formatted: plainTextRequired(280),
    line1: plainTextOptional(160).optional(),
    /**
     * "Unit or room" (`Place.addrLine2`), WITHOUT it in `formatted`: the
     * server folds it in (`lib/location/place-unit.ts`). On create, absent /
     * null / "" = no unit. On update, ABSENT = keep the stored unit; null or
     * "" = clear it.
     */
    line2: communityPlaceUnitSchema.optional(),
    city: plainTextOptional(120).optional(),
    region: plainTextOptional(120).optional(),
    postalCode: plainTextOptional(32).optional(),
    countryCode: z
      .string()
      .trim()
      .length(2)
      .regex(/^[A-Za-z]{2}$/)
      .transform((value) => value.toUpperCase()),
    // REQUIRED, unlike upsertPlace: a community listing's place must carry a
    // pin (`resolveListingPlaceLocation`), and these places exist for one.
    lat: z.number().gte(-90).lte(90),
    lng: z.number().gte(-180).lte(180),
  })
  .strict();

export type CommunityPlaceAddress = z.infer<typeof communityPlaceAddressSchema>;

/** The fields the web `PlacePickerItem` needs to select the place directly. */
export const communityPlaceSchema = z.object({
  placeId: z.string().uuid(),
  name: z.string(),
  formattedAddress: z.string().nullable(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  timezone: z.string().nullable(),
  status: z.enum(["ACTIVE", "SUSPENDED", "ARCHIVED"]),
  verificationStatus: z.enum(["UNVERIFIED", "VERIFIED", "PENDING", "REJECTED"]),
});

export type CommunityPlace = z.infer<typeof communityPlaceSchema>;

export function toCommunityPlace(place: PlaceRecord): CommunityPlace {
  return {
    placeId: place.id,
    name: place.name,
    formattedAddress: place.formattedAddress,
    city: place.city,
    region: place.region,
    lat: place.lat,
    lng: place.lng,
    timezone: place.timezone ?? null,
    status: place.status,
    verificationStatus: place.verificationStatus,
  };
}

/**
 * Case, spacing and Unicode form do not make a different name. MUST agree
 * with the SQL normal form `PlacesRepo.findActiveExactByNormalizedName`
 * matches on: NFKC, whitespace runs to one space, trim, lower-case — in
 * that order.
 */
export function normalizePlaceName(name: string): string {
  return name.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

/** sha256 of the parts, for an idempotency payload hash. */
export function hashPayload(...parts: unknown[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(JSON.stringify(part ?? null));
  return hash.digest("hex");
}

/**
 * The name becomes a public page title: the same content filter a listing's
 * title goes through. The address is exempt, as it is there.
 */
export async function ensurePlaceNameAllowed(
  contentFilter: ContentFilterPort,
  name: string,
): Promise<void> {
  const blocked = await checkBlocked(contentFilter, name);
  if (blocked.blocked) {
    throw suggestionRejection(
      "blocked_content",
      ["name"],
      blocked.term ? { term: blocked.term } : undefined,
    );
  }
}

/**
 * THE DUPLICATE GUARD, run INSIDE the write's transaction:
 *
 *  1. take the advisory lock on the normalized name, so a second write of
 *     the same name (another moderator, or a double submit with a fresh
 *     clientKey) waits for this one and then sees its committed row;
 *  2. read the ACTIVE, address-public places with that name, matched in SQL
 *     (`findActiveExactByNormalizedName`);
 *  3. refuse with PLACE_ALREADY_EXISTS when one is within
 *     {@link DUPLICATE_RADIUS_METERS} of the pin or has the same address
 *     text, handing it back in `meta.existingPlace` so the form can offer it.
 *
 * Places that withhold their address are never matched (the finder excludes
 * them): a moderator is not their owner, and "a place with this name is
 * within 50 m of the point you typed" would say where a house is.
 */
export async function lockAndRefuseDuplicatePlace(
  tx: Pick<TxRepos, "places">,
  input: DuplicatePlaceProbe,
): Promise<void> {
  await tx.places.lockPlaceName(normalizePlaceName(input.name));
  await refuseDuplicatePlace(tx, input);
}

/**
 * The refusal half of {@link lockAndRefuseDuplicatePlace}: PLACE_ALREADY_EXISTS
 * when {@link findDuplicatePlace} finds a twin. The CALLER must already hold
 * the name lock (`places.lockPlaceName`). `updateCommunityPlace`'s name-only
 * edit uses it on its own: it takes the name lock first, then reads the
 * stored address under the claim lock, then probes with that address.
 */
export async function refuseDuplicatePlace(
  tx: Pick<TxRepos, "places">,
  input: DuplicatePlaceProbe,
): Promise<void> {
  const existing = await findDuplicatePlace(tx.places, input);
  if (existing) {
    throw fail("PLACE_ALREADY_EXISTS", {
      message: "a place with this name already exists here",
      meta: { existingPlace: toCommunityPlace(existing) },
    });
  }
}

/** What the duplicate guard compares: a name, an address and a pin. */
export type DuplicatePlaceProbe = {
  name: string;
  address: Pick<NormalizedPlaceAddress, "formatted" | "lat" | "lng">;
  excludePlaceId?: string;
};

/**
 * The matching half of {@link lockAndRefuseDuplicatePlace}, with no lock:
 * the ACTIVE, address-public place with the same normalized name that sits
 * within {@link DUPLICATE_RADIUS_METERS} of the pin or has the same address
 * text, or null. The locked write and `getCommunityPlaceEditability`'s
 * advisory read both call this, so they cannot disagree about what counts
 * as a duplicate. The finder never returns a place that withholds its
 * address.
 */
export async function findDuplicatePlace(
  places: Pick<TxRepos["places"], "findActiveExactByNormalizedName">,
  input: DuplicatePlaceProbe,
): Promise<PlaceRecord | null> {
  const candidates = await places.findActiveExactByNormalizedName({
    normalizedName: normalizePlaceName(input.name),
    ...(input.excludePlaceId ? { excludePlaceId: input.excludePlaceId } : {}),
    limit: DUPLICATE_CANDIDATE_LIMIT,
  });

  const addressHash = input.address.formatted.trim().toLowerCase();
  const { lat, lng } = input.address;
  return (
    candidates.find(
      (place) =>
        (place.addressHash !== null && place.addressHash === addressHash) ||
        (place.lat !== null &&
          place.lng !== null &&
          lat !== undefined &&
          lng !== undefined &&
          haversineDistance(place.lat, place.lng, lat, lng) <=
            DUPLICATE_RADIUS_METERS),
    ) ?? null
  );
}

/**
 * The duplicate guard's view of an existing place's own name and pin,
 * excluding the place itself. Restore runs the guard on it (an ACTIVE twin
 * may have been added while the place was archived).
 */
export function duplicateProbe(place: PlaceRecord): DuplicatePlaceProbe {
  return {
    name: place.name,
    address: {
      formatted: place.formattedAddress ?? "",
      lat: place.lat ?? undefined,
      lng: place.lng ?? undefined,
    },
    excludePlaceId: place.id,
  };
}

/**
 * A community moderator may change a place ONLY while nobody owns it, nobody
 * is claiming it, and no organiser's live (published, not ended) event uses
 * it: PLACE_HAS_OWNER with `meta.reason` "OWNED" | "CLAIM_PENDING" |
 * "OWNED_EVENTS_AT_PLACE" otherwise (`findOwnerlessWriteBlock`). Read inside the transaction, after
 * `places.lockPlaceForClaim`, so a claim being submitted or verified at the
 * same moment (both take that lock) either lands first and is seen here, or
 * waits for this write. `writePlaceInTx` re-runs the same predicate.
 */
export async function assertPlaceUnowned(
  tx: Pick<TxRepos, "places" | "events">,
  place: PlaceRecord,
  now: Date,
): Promise<void> {
  await assertOwnerlessWriteAllowed(tx, place, now);
}

/** The audit action a community moderator's archive writes. */
export const COMMUNITY_ARCHIVED_ACTION = "place.community_archived";

/** The audit actions that record a place's status changing. */
const PLACE_STATUS_ACTIONS = new Set([
  "status_updated", // updatePlaceStatus (owner; bulk archive)
  COMMUNITY_ARCHIVED_ACTION,
  "place.community_restored",
]);

/** Rows read per page while looking for a status row. */
const STATUS_AUDIT_PAGE = 50;

/** The newest status-change audit row of a place: what it did, and when. */
export type PlaceStatusChange = { action: string; at: Date };

/**
 * The action of the place's newest status-change audit row, or null when it
 * has none. `restoreCommunityPlace` lets a moderator who is not an ADMIN
 * restore only a place whose answer is {@link COMMUNITY_ARCHIVED_ACTION} (a
 * moderator restores only what a moderator archived; an ADMIN restores either
 * way). Same read as {@link latestPlaceStatusChange}.
 */
export async function latestPlaceStatusAction(
  repos: Pick<TxRepos, "audit">,
  placeId: string,
): Promise<string | null> {
  return (await latestPlaceStatusChange(repos, placeId))?.action ?? null;
}

/**
 * The place's newest status-change audit row (`{ action, at }`), or null
 * when it has none. `getCommunityPlaceEditability` reads it once for both
 * `canRestore` (the action) and `statusChangedAt` (the time).
 *
 * `audit.list` filters `action` by substring ("status_updated" also matches
 * "verification_status_updated"), so each action is paged newest-first until
 * the first row whose action matches EXACTLY, or the rows run out. A fixed
 * window would let enough newer near-miss rows push the owner's real
 * `status_updated` out of sight, and a restore the owner's archive should
 * block would go through.
 *
 * On equal `at`, the strict `>` keeps the action visited first
 * (`status_updated`), so a moderator's restore refuses: the safe outcome;
 * keep it. (An ADMIN's restore records the action but is not refused by it.)
 */
export async function latestPlaceStatusChange(
  repos: Pick<TxRepos, "audit">,
  placeId: string,
): Promise<PlaceStatusChange | null> {
  let newest: PlaceStatusChange | null = null;
  // One after another: inside a write these run on the transaction's
  // connection.
  for (const action of PLACE_STATUS_ACTIONS) {
    for (let offset = 0; ; offset += STATUS_AUDIT_PAGE) {
      const read = await repos.audit.list({
        entity: "place",
        entityId: placeId,
        action,
        sort: "at_desc",
        limit: STATUS_AUDIT_PAGE,
        offset,
      });
      const match = read.items.find(
        (row) =>
          row.entity === "place" &&
          row.entityId === placeId &&
          row.action === action,
      );
      if (match) {
        if (!newest || match.at.getTime() > newest.at.getTime()) {
          newest = { action: match.action, at: match.at };
        }
        break;
      }
      const seen = offset + read.items.length;
      if (read.items.length < STATUS_AUDIT_PAGE || seen >= read.total) break;
    }
  }
  return newest;
}
