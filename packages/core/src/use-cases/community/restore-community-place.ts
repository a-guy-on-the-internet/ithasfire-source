import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { PlaceRecord, Repos, TxRepos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import { fail } from "@th/errors";

import { asKnownError } from "../../lib/errors";
import { abandonClaim } from "../../lib/idempotency-claim";
import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";
import { reindexAfterMutation } from "../search/reindex-after-mutation";
import { markForSearchReindex } from "../search/search-reindex-marks";
import {
  COMMUNITY_ARCHIVED_ACTION,
  communityPlaceSchema,
  duplicateProbe,
  hashPayload,
  latestPlaceStatusAction,
  lockAndRefuseDuplicatePlace,
  normalizePlaceName,
  toCommunityPlace,
} from "./_shared/community-place";
import { COMMUNITY_MODERATION_ROLES } from "./_shared/suggestion-validation";
import { loadUnownedPlaceForModerator } from "./update-community-place";

/**
 * A community moderator (or platform ADMIN) brings back an archived place
 * nobody owns: ARCHIVED → ACTIVE (orchestrator decision 2026-10-13: a
 * moderator may restore what they may archive; owner ruling 2026-10-14: a
 * platform ADMIN may also restore one a moderator did not archive, such as a
 * legacy archived row or a place whose owner lost ownership).
 *
 * Refused, read inside the transaction after `lockPlaceForClaim` and the
 * EXCLUSIVE place-location lock:
 *  - PLACE_NOT_FOUND;
 *  - PLACE_HAS_OWNER, `meta.reason` "OWNED" | "CLAIM_PENDING" |
 *    "OWNED_EVENTS_AT_PLACE": the same places a moderator may not archive;
 *  - PLACE_NOT_ACTIVE for a SUSPENDED place (staff's to decide);
 *  - CONFLICT, `meta.reason` "PLACE_NOT_ARCHIVED": only an ARCHIVED place is
 *    restored. A replay of the same clientKey returns the first answer;
 *  - CONFLICT, `meta.reason` "NOT_COMMUNITY_ARCHIVED", for a moderator who
 *    is not an ADMIN: the place's latest status change in the audit log is
 *    not `place.community_archived`. A moderator restores only what a
 *    moderator archived; a place its owner archived (whose ownership was
 *    later revoked) stays archived until an ADMIN restores it. An ADMIN
 *    skips this rule and no other: a place someone owns (or claims) is
 *    refused above, for an ADMIN too;
 *  - PLACE_ALREADY_EXISTS (`meta.existingPlace`): an ACTIVE place with the
 *    same name at the same spot was added while this one was archived. The
 *    same in-transaction duplicate guard as create, excluding this place.
 *
 * What restoring does: status ACTIVE (`places.setStatus`; every other
 * column as it was), an
 * audit row (`place.community_restored`, its data saying which rule let it
 * through: `restoredBy` "ADMIN" | "COMMUNITY_MODERATOR" and
 * `previousStatusAction`, the newest status action before it), a search mark
 * and the after-commit
 * reindex, which puts the place back in the place picker's search. Listings
 * linked to it while it was archived were never unlinked, so nothing else
 * changes.
 */
export const restoreCommunityPlaceInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    placeId: z.string().uuid(),
    clientKey: z.string().min(8).max(200),
  })
  .strict();

export const restoreCommunityPlaceOutputSchema = communityPlaceSchema;

export type RestoreCommunityPlaceInput = z.infer<
  typeof restoreCommunityPlaceInputSchema
>;
export type RestoreCommunityPlaceOutput = z.infer<
  typeof restoreCommunityPlaceOutputSchema
>;

export type RestoreCommunityPlaceDeps = {
  repos: Repos;
  authz: Pick<AuthZPort, "hasStaffRole">;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  /** The after-commit reindex that puts the place back in search. */
  search?: MultiSearchPort;
  /** The reindex's swallow branches report here (repo Sentry convention). */
  reportError?: ReporterPort;
};

type StoredRecord = {
  payloadHash: string;
  response: RestoreCommunityPlaceOutput;
};

const USE_CASE = "restoreCommunityPlace";

/**
 * The place's newest status action, refused for a non-ADMIN unless it is the
 * community archive. An ADMIN may restore an ownerless place whatever
 * archived it (owner ruling 2026-10-14).
 */
async function assertMayRestoreArchive(
  tx: Pick<TxRepos, "audit">,
  placeId: string,
  actorIsAdmin: boolean,
): Promise<string | null> {
  const latest = await latestPlaceStatusAction(tx, placeId);
  if (!actorIsAdmin && latest !== COMMUNITY_ARCHIVED_ACTION) {
    throw fail("CONFLICT", {
      message: "a moderator did not archive this place, so cannot restore it",
      meta: {
        placeId,
        reason: "NOT_COMMUNITY_ARCHIVED",
        latestStatusAction: latest,
      },
    });
  }
  return latest;
}

function assertArchived(place: PlaceRecord): void {
  if (place.status !== "ARCHIVED") {
    throw fail("CONFLICT", {
      message: "only an archived place can be restored",
      meta: {
        placeId: place.id,
        reason: "PLACE_NOT_ARCHIVED",
        status: place.status,
      },
    });
  }
}

export async function restoreCommunityPlace(
  deps: RestoreCommunityPlaceDeps,
  rawInput: unknown,
): Promise<RestoreCommunityPlaceOutput> {
  const logger = deps.logger?.child({ useCase: USE_CASE });

  const input = parseInput(restoreCommunityPlaceInputSchema, rawInput);

  await requirePlatformStaff({
    authz: deps.authz,
    actorHumanId: input.actorHumanId,
    roles: COMMUNITY_MODERATION_ROLES,
  });
  // Asked once, after the gate above (so the second-factor rule has already
  // applied): an ADMIN may restore what a moderator did not archive.
  const actorIsAdmin = (
    await deps.authz.hasStaffRole({
      actorHumanId: input.actorHumanId,
      requiredRoles: ["ADMIN"],
    })
  ).allowed;

  const payloadHash = hashPayload(input.placeId, "ACTIVE");
  const idemKey = `place:community:restore:${input.actorHumanId}:${input.placeId}:${input.clientKey}`;

  const replay = await deps.idempotency.get<StoredRecord>(idemKey);
  if (replay) {
    if (replay.payloadHash !== payloadHash) {
      throw fail("IDEMPOTENCY_KEY_CONFLICT");
    }
    return replay.response;
  }

  // Cheap rejections before any claim; every one is re-checked in the tx.
  // The read also supplies the name the duplicate guard locks on.
  const before = await loadUnownedPlaceForModerator(deps.repos, input.placeId, {
    now: deps.clock.now(),
    allowArchived: true,
  });
  assertArchived(before);

  const ownerToken = crypto.randomUUID();
  const claimed = await deps.idempotency.begin(idemKey, 300, ownerToken);
  if (!claimed) {
    const afterWait = await deps.idempotency.get<StoredRecord>(idemKey);
    if (afterWait) {
      if (afterWait.payloadHash !== payloadHash) {
        throw fail("IDEMPOTENCY_KEY_CONFLICT");
      }
      return afterWait.response;
    }
    throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
  }

  let restored: PlaceRecord;
  try {
    const at = deps.clock.now();
    restored = await deps.repos.tx(async (tx) => {
      // Lock order as update: the name, the claim lock, then the
      // place-location lock EXCLUSIVE (no listing or event save lands at the
      // place between the reads below and the status write). An ACTIVE twin
      // may have been created while this place was archived.
      await lockAndRefuseDuplicatePlace(tx, duplicateProbe(before));
      await tx.places.lockPlaceForClaim(input.placeId);
      await tx.events.lockLocationsAtPlace({
        placeId: input.placeId,
        mode: "exclusive",
      });
      const current = await loadUnownedPlaceForModerator(tx, input.placeId, {
        now: at,
        allowArchived: true,
      });
      assertArchived(current);
      const previousStatusAction = await assertMayRestoreArchive(
        tx,
        input.placeId,
        actorIsAdmin,
      );
      // An archived place cannot be renamed (update refuses ARCHIVED), so the
      // name locked above is the name now. Should that ever change, refuse
      // rather than take a second name lock after the claim lock.
      if (normalizePlaceName(current.name) !== normalizePlaceName(before.name)) {
        throw fail("CONFLICT", {
          message: "the place changed while it was being restored",
          meta: { placeId: input.placeId, reason: "PLACE_CHANGED" },
        });
      }

      await tx.places.setStatus({ placeId: input.placeId, status: "ACTIVE" });
      await tx.audit.log({
        entity: "place",
        entityId: input.placeId,
        action: "place.community_restored",
        data: {
          actorHumanId: input.actorHumanId,
          from: "ARCHIVED",
          to: "ACTIVE",
          name: current.name,
          formattedAddress: current.formattedAddress,
          restoredBy: actorIsAdmin ? "ADMIN" : "COMMUNITY_MODERATOR",
          previousStatusAction,
        },
        at,
      });
      await markForSearchReindex(tx, [{ kind: "place", id: input.placeId }], at);
      return (await tx.places.getById(input.placeId)) ?? {
        ...current,
        status: "ACTIVE",
      };
    });
  } catch (error) {
    await abandonClaim(deps.idempotency, idemKey, ownerToken, error, {
      useCase: USE_CASE,
      logger: deps.logger,
      reportError: deps.reportError,
    });
    throw asKnownError("restore_community_place", error);
  }

  let response: RestoreCommunityPlaceOutput;
  try {
    response = restoreCommunityPlaceOutputSchema.parse(
      toCommunityPlace(restored),
    );
    await deps.idempotency.commit<StoredRecord>(idemKey, {
      payloadHash,
      response,
    });
  } catch (error) {
    throw asKnownError("restore_community_place", error);
  }

  // Puts the place's search document back. Never throws; failures are
  // reported and the mark stays for the drain.
  reindexAfterMutation(
    {
      repos: deps.repos,
      search: deps.search,
      clock: deps.clock,
      logger: deps.logger,
      reportError: deps.reportError,
    },
    USE_CASE,
    { kind: "place", id: input.placeId },
  );
  logger?.info("community_place_restored", {
    placeId: input.placeId,
    actorHumanId: input.actorHumanId,
  });

  return response;
}
