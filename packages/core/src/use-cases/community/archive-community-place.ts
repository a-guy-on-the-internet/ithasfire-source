import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import { fail } from "@th/errors";

import { asKnownError } from "../../lib/errors";
import { abandonClaim } from "../../lib/idempotency-claim";
import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";
import { reindexAfterMutation } from "../search/reindex-after-mutation";
import { markForSearchReindex } from "../search/search-reindex-marks";
import { hashPayload } from "./_shared/community-place";
import { COMMUNITY_MODERATION_ROLES } from "./_shared/suggestion-validation";
import { loadUnownedPlaceForModerator } from "./update-community-place";

/**
 * A community moderator (or platform ADMIN) archives a place NOBODY OWNS —
 * the duplicate, or the typo'd place that should not have been created.
 *
 * A separate use case, not a branch of `updatePlaceStatus`: that one's owner
 * path stays exactly as it is, and this one can only ever move a place a
 * moderator may change to ARCHIVED. Refused, read inside the transaction
 * after `lockPlaceForClaim` and the EXCLUSIVE place-location lock:
 *  - PLACE_HAS_OWNER, `meta.reason` "OWNED" | "CLAIM_PENDING" |
 *    "OWNED_EVENTS_AT_PLACE" (`assertPlaceUnowned`): an owned place, one
 *    with a claim in review, or one an organiser's live (published, not
 *    ended) event uses;
 *  - PLACE_HAS_LIVE_LISTINGS, `meta.reason` "LINKED_LISTINGS" with
 *    `meta.linkedListingCount`: PUBLISHED community listings at the place
 *    that have not ended (orchestrator decision 2026-10-13). Archive it once
 *    they have ended, or move them first;
 *  - PLACE_NOT_ACTIVE for a SUSPENDED place, which is staff's to decide.
 * Archiving an archived place is a no-op that returns it.
 *
 * What archiving does, and does not do:
 *  - status ARCHIVED (`places.setStatus`: no other column is written), an
 *    audit row (`place.community_archived`), a search
 *    mark and the after-commit reindex — which REMOVES the place's search
 *    document (`buildSearchIndex` deletes any place that is not ACTIVE), so
 *    it leaves the place picker's "all places" search;
 *  - NO cascade to events. Ended or unpublished community listings at the
 *    place keep their `placeId` and the address they copied. A listing can
 *    no longer be newly linked to it, or re-linked by an edit that sends
 *    this placeId (`resolveListingPlaceLocation` refuses an ARCHIVED place
 *    with PLACE_ARCHIVED).
 *  - nothing is deleted: the EntityPage, Main Space and Main Calendar stay,
 *    and `restoreCommunityPlace` (`community.restorePlace`) brings the place
 *    back under the same rules (orchestrator decision 2026-10-13).
 */
export const archiveCommunityPlaceInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    placeId: z.string().uuid(),
    clientKey: z.string().min(8).max(200),
  })
  .strict();

export const archiveCommunityPlaceOutputSchema = z
  .object({
    placeId: z.string().uuid(),
    status: z.literal("ARCHIVED"),
  })
  .strict();

export type ArchiveCommunityPlaceInput = z.infer<
  typeof archiveCommunityPlaceInputSchema
>;
export type ArchiveCommunityPlaceOutput = z.infer<
  typeof archiveCommunityPlaceOutputSchema
>;

export type ArchiveCommunityPlaceDeps = {
  repos: Repos;
  authz: Pick<AuthZPort, "hasStaffRole">;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  /** The after-commit reindex that takes the place out of search. */
  search?: MultiSearchPort;
  /** The reindex's swallow branches report here (repo Sentry convention). */
  reportError?: ReporterPort;
};

type StoredRecord = {
  payloadHash: string;
  response: ArchiveCommunityPlaceOutput;
};

const USE_CASE = "archiveCommunityPlace";

export async function archiveCommunityPlace(
  deps: ArchiveCommunityPlaceDeps,
  rawInput: unknown,
): Promise<ArchiveCommunityPlaceOutput> {
  const logger = deps.logger?.child({ useCase: USE_CASE });

  const input = parseInput(archiveCommunityPlaceInputSchema, rawInput);

  await requirePlatformStaff({
    authz: deps.authz,
    actorHumanId: input.actorHumanId,
    roles: COMMUNITY_MODERATION_ROLES,
  });

  const payloadHash = hashPayload(input.placeId, "ARCHIVED");
  const idemKey = `place:community:archive:${input.actorHumanId}:${input.placeId}:${input.clientKey}`;

  // A replay answers first, as restore does: the first call's answer stands
  // even if the place has changed since.
  const replay = await deps.idempotency.get<StoredRecord>(idemKey);
  if (replay) {
    if (replay.payloadHash !== payloadHash) {
      throw fail("IDEMPOTENCY_KEY_CONFLICT");
    }
    return replay.response;
  }

  // Cheap rejections before any claim; re-checked in the tx.
  await loadUnownedPlaceForModerator(deps.repos, input.placeId, {
    now: deps.clock.now(),
    allowArchived: true,
  });

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

  let changed: boolean;
  try {
    const at = deps.clock.now();
    changed = await deps.repos.tx(async (tx) => {
      // Lock order as update: the claim lock, then the place-location lock
      // EXCLUSIVE, so no listing or event save lands at the place between
      // the reads below and the status write.
      await tx.places.lockPlaceForClaim(input.placeId);
      await tx.events.lockLocationsAtPlace({
        placeId: input.placeId,
        mode: "exclusive",
      });
      const current = await loadUnownedPlaceForModerator(tx, input.placeId, {
        now: at,
        allowArchived: true,
      });
      if (current.status === "ARCHIVED") return false;

      const linkedListingCount =
        await tx.events.countLiveCommunityListingsAtPlace({
          placeId: input.placeId,
          now: at,
        });
      if (linkedListingCount > 0) {
        throw fail("PLACE_HAS_LIVE_LISTINGS", {
          message: "published community listings still use this place",
          meta: {
            placeId: input.placeId,
            reason: "LINKED_LISTINGS",
            linkedListingCount,
          },
        });
      }

      await tx.places.setStatus({ placeId: input.placeId, status: "ARCHIVED" });
      await tx.audit.log({
        entity: "place",
        entityId: input.placeId,
        action: "place.community_archived",
        data: {
          actorHumanId: input.actorHumanId,
          from: current.status,
          to: "ARCHIVED",
          name: current.name,
          formattedAddress: current.formattedAddress,
        },
        at,
      });
      await markForSearchReindex(tx, [{ kind: "place", id: input.placeId }], at);
      return true;
    });
  } catch (error) {
    await abandonClaim(deps.idempotency, idemKey, ownerToken, error, {
      useCase: USE_CASE,
      logger: deps.logger,
      reportError: deps.reportError,
    });
    throw asKnownError("archive_community_place", error);
  }

  const response: ArchiveCommunityPlaceOutput = {
    placeId: input.placeId,
    status: "ARCHIVED",
  };
  try {
    await deps.idempotency.commit<StoredRecord>(idemKey, {
      payloadHash,
      response,
    });
  } catch (error) {
    throw asKnownError("archive_community_place", error);
  }

  if (changed) {
    // Removes the place's search document (not ACTIVE any more). Never
    // throws; failures are reported and the mark stays for the drain.
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
    logger?.info("community_place_archived", {
      placeId: input.placeId,
      actorHumanId: input.actorHumanId,
    });
  }

  return response;
}
