import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";
import { findOwnerlessWriteBlock } from "../places/_shared/ownerless-write-guard";
import {
  COMMUNITY_ARCHIVED_ACTION,
  duplicateProbe,
  findDuplicatePlace,
  latestPlaceStatusChange,
} from "./_shared/community-place";
import { COMMUNITY_MODERATION_ROLES } from "./_shared/suggestion-validation";

/**
 * Whether a community moderator (or platform ADMIN) may edit, archive or
 * restore a place, and why not, asked BEFORE the dialog opens so the card
 * can say "Only its owner can change this place" instead of letting the
 * moderator fill a form `updatePlace` refuses.
 *
 * ADVISORY. It reads without locks; `updateCommunityPlace`,
 * `archiveCommunityPlace` and `restoreCommunityPlace` re-check every rule
 * under their locks, so a claim or an organiser's event landing between this
 * answer and the write is still refused there.
 *
 * The answer mirrors the writes:
 *  - canEdit    = ACTIVE, no ownerless-write block, address published
 *                 (`locationMode = EXACT`; update refuses a place that
 *                 withholds its address);
 *  - canArchive = ACTIVE, no block, `linkedListingCount === 0` (archive
 *                 waits until no live published community listing uses it);
 *  - canRestore = ARCHIVED, no block, the latest status audit row is
 *                 `place.community_archived` (a moderator restores only what
 *                 a moderator archived; an ADMIN actor skips this rule, owner
 *                 ruling 2026-10-14), and no ACTIVE place with the same
 *                 name sits within 50 m or at the same address (restore's
 *                 duplicate guard, through the same `findDuplicatePlace`).
 *
 * An ARCHIVED place answers canArchive false: archiving it again is a no-op
 * the card has no reason to offer. A SUSPENDED place answers false to all
 * three.
 *
 * `reason` is the first refusal that applies, in this order, or null:
 *  1. "OWNED" | "CLAIM_PENDING" | "OWNED_EVENTS_AT_PLACE" — the
 *     ownerless-write block (`findOwnerlessWriteBlock`); blocks every action;
 *  2. "NOT_ACTIVE" — SUSPENDED (staff's to decide; nothing is allowed);
 *  3. "NOT_COMMUNITY_ARCHIVED" — ARCHIVED, but not by a moderator, and the
 *     actor is not an ADMIN (never answered to an ADMIN);
 *  4. "DUPLICATE_ACTIVE" — ARCHIVED and restorable by this actor, but an
 *     ACTIVE place with
 *     the same name now stands at the same spot; `duplicatePlaceId` names
 *     it (the finder returns only ACTIVE, address-public places, so the id
 *     is of a public place, and restore's own PLACE_ALREADY_EXISTS hands
 *     back the same place);
 *  5. "ADDRESS_WITHHELD" — ACTIVE, but the place withholds its address, so
 *     it cannot be edited here (archive may still be allowed).
 * An ARCHIVED place this actor may restore answers reason null. A place
 * with live listings answers reason null with `canArchive: false`;
 * `linkedListingCount` says why.
 *
 * `duplicatePlaceId` is null except with "DUPLICATE_ACTIVE".
 *
 * `archivedByModerator` is true when the place is ARCHIVED and its newest
 * status audit row is `place.community_archived`, whoever asks and whatever
 * blocks it. canRestore no longer implies it (an ADMIN may restore what a
 * moderator did not archive), so the platform panel reads this to say "by a
 * moderator".
 *
 * `statusChangedAt` is when the place's newest status audit row was written
 * (`status_updated`, `place.community_archived` or
 * `place.community_restored`, whichever is newest), as an ISO string; null
 * when it has none (a place never archived or restored). The same read
 * decides `canRestore`, so the two always agree.
 *
 * Output is these fields only: no name, address or owner, so a place that
 * withholds its address leaks nothing.
 *
 * Refused: STAFF_ONLY (or SECOND_FACTOR_REQUIRED) for a non-moderator,
 * PLACE_NOT_FOUND for an unknown id.
 */
export const getCommunityPlaceEditabilityInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    placeId: z.string().uuid(),
  })
  .strict();

export const COMMUNITY_PLACE_EDITABILITY_REASONS = [
  "OWNED",
  "CLAIM_PENDING",
  "OWNED_EVENTS_AT_PLACE",
  "NOT_ACTIVE",
  "NOT_COMMUNITY_ARCHIVED",
  "DUPLICATE_ACTIVE",
  "ADDRESS_WITHHELD",
] as const;

export const getCommunityPlaceEditabilityOutputSchema = z
  .object({
    placeId: z.string(),
    status: z.enum(["ACTIVE", "SUSPENDED", "ARCHIVED"]),
    canEdit: z.boolean(),
    canArchive: z.boolean(),
    canRestore: z.boolean(),
    reason: z.enum(COMMUNITY_PLACE_EDITABILITY_REASONS).nullable(),
    linkedListingCount: z.number().int().nonnegative(),
    duplicatePlaceId: z.string().nullable(),
    archivedByModerator: z.boolean(),
    statusChangedAt: z.string().datetime().nullable(),
  })
  .strict();

export type GetCommunityPlaceEditabilityInput = z.infer<
  typeof getCommunityPlaceEditabilityInputSchema
>;
export type GetCommunityPlaceEditabilityOutput = z.infer<
  typeof getCommunityPlaceEditabilityOutputSchema
>;
export type CommunityPlaceEditabilityReason =
  (typeof COMMUNITY_PLACE_EDITABILITY_REASONS)[number];

export type GetCommunityPlaceEditabilityDeps = {
  repos: Pick<Repos, "places" | "events" | "audit">;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
};

export async function getCommunityPlaceEditability(
  deps: GetCommunityPlaceEditabilityDeps,
  rawInput: unknown,
): Promise<GetCommunityPlaceEditabilityOutput> {
  const input = parseInput(getCommunityPlaceEditabilityInputSchema, rawInput);

  await requirePlatformStaff({
    authz: deps.authz,
    actorHumanId: input.actorHumanId,
    roles: COMMUNITY_MODERATION_ROLES,
  });
  // As restore asks it: after the gate, so the second-factor rule applied.
  const actorIsAdmin = (
    await deps.authz.hasStaffRole({
      actorHumanId: input.actorHumanId,
      requiredRoles: ["ADMIN"],
    })
  ).allowed;

  const place = await deps.repos.places.getById(input.placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND", { meta: { placeId: input.placeId } });
  }

  const now = deps.clock.now();
  const block = await findOwnerlessWriteBlock(deps.repos, place, now);
  const linkedListingCount =
    await deps.repos.events.countLiveCommunityListingsAtPlace({
      placeId: place.id,
      now,
    });

  const activeAndUnblocked = place.status === "ACTIVE" && block === null;
  const addressPublic = place.locationMode === "EXACT";
  // Read for every status: it decides canRestore and dates the status.
  const statusChange = await latestPlaceStatusChange(deps.repos, place.id);
  const communityArchived = statusChange?.action === COMMUNITY_ARCHIVED_ACTION;
  // Restore's rule: ARCHIVED, unblocked, and archived by a moderator unless
  // the actor is an ADMIN.
  const restorable =
    place.status === "ARCHIVED" &&
    block === null &&
    (actorIsAdmin || communityArchived);
  // Restore's duplicate guard, without its name lock.
  const duplicate = restorable
    ? await findDuplicatePlace(deps.repos.places, duplicateProbe(place))
    : null;

  let reason: CommunityPlaceEditabilityReason | null = null;
  if (block !== null) reason = block;
  else if (place.status === "SUSPENDED") reason = "NOT_ACTIVE";
  else if (place.status === "ARCHIVED" && !restorable) {
    reason = "NOT_COMMUNITY_ARCHIVED";
  } else if (duplicate !== null) {
    reason = "DUPLICATE_ACTIVE";
  } else if (place.status === "ACTIVE" && !addressPublic) {
    reason = "ADDRESS_WITHHELD";
  }

  return getCommunityPlaceEditabilityOutputSchema.parse({
    placeId: place.id,
    status: place.status,
    canEdit: activeAndUnblocked && addressPublic,
    canArchive: activeAndUnblocked && linkedListingCount === 0,
    canRestore: restorable && duplicate === null,
    reason,
    linkedListingCount,
    duplicatePlaceId: duplicate?.id ?? null,
    archivedByModerator: place.status === "ARCHIVED" && communityArchived,
    statusChangedAt: statusChange?.at.toISOString() ?? null,
  });
}
