import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";
import { reindexAfterMutation } from "../search/reindex-after-mutation";
import { markForSearchReindex } from "../search/search-reindex-marks";
import { COMMUNITY_MODERATION_ROLES } from "./_shared/suggestion-validation";

/**
 * Set the hero/banner image on an EXISTING community listing.
 *
 * Community listings are ownerless COMMUNITY rows (FR-005). They can only
 * receive a hero AFTER creation because image storage keys embed the event id
 * (`events/{eventId}/...` + Image.eventId FK) — no image can reference the row
 * before it exists. The web form therefore (1) creates the listing,
 * (2) uploads the banner against the now-existing event via the existing
 * `events.requestImageUpload` → PUT → `events.finalizeImageUpload` procedures,
 * then (3) calls this use-case to link `Event.heroImageId`.
 *
 * DRAFT listings are accepted as well as PUBLISHED: the same three steps are
 * what the EventBuilder does while authoring a listing that is not live yet.
 * There is no oracle risk in widening it — unlike `requestEventImageUpload`'s
 * any-signed-in-user arm, this use case is `requirePlatformStaff`-gated before
 * it reads anything, so only a moderator ever learns whether the row exists.
 *
 * Moderation matches the OWNED-event path exactly: the hero is set IMMEDIATELY
 * and the async EVENT_HERO moderation job (already enqueued by finalize) flags
 * it later if needed. This use-case invents NO extra gating.
 */

/**
 * Listing states that may take a hero: being authored, or live. Deliberately
 * NOT every status — see the guard's comment.
 */
const HERO_ATTACHABLE_STATUSES: ReadonlySet<string> = new Set([
  "DRAFT",
  "PUBLISHED",
]);

export const attachCommunityListingHeroInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    eventId: z.uuid(),
    imageId: z.uuid(),
  })
  .strict();

export const attachCommunityListingHeroOutputSchema = z
  .object({
    eventId: z.uuid(),
    heroImageId: z.uuid(),
  })
  .strict();

export type AttachCommunityListingHeroUseCaseInput = z.infer<
  typeof attachCommunityListingHeroInputSchema
>;
export type AttachCommunityListingHeroUseCaseOutput = z.infer<
  typeof attachCommunityListingHeroOutputSchema
>;

export type AttachCommunityListingHeroDeps = {
  repos: Repos;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  /**
   * Optional: best-effort incremental search-index update after the hero is
   * set (the hero shows on cards/search). No-ops when omitted — the nightly
   * `search.full-reindex` still reconciles the row.
   */
  search?: MultiSearchPort;
  logger?: LoggerPort;
};

export async function attachCommunityListingHero(
  deps: AttachCommunityListingHeroDeps,
  rawInput: unknown,
): Promise<AttachCommunityListingHeroUseCaseOutput> {
  const scopedLogger = deps.logger?.child({
    useCase: "attachCommunityListingHero",
  });

  const execute =
    async (): Promise<AttachCommunityListingHeroUseCaseOutput> => {
      const input = parseInput(attachCommunityListingHeroInputSchema, rawInput);

      // Actor gate: COMMUNITY_MODERATOR or platform ADMIN (same guard as
      // createCommunityListing).
      await requirePlatformStaff({
        authz: deps.authz,
        actorHumanId: input.actorHumanId,
        roles: COMMUNITY_MODERATION_ROLES,
      });

      // The listing must exist AND be an ownerless COMMUNITY row that is
      // still authorable — DRAFT (being built) or PUBLISHED (live). CANCELLED
      // / COMPLETED / ARCHIVED are refused: a hero on a dead listing is sweep
      // fodder. Collapse every condition into EVENT_NOT_FOUND so the endpoint
      // cannot be used to probe for private/owned/dead events (mirrors
      // request-event-image-upload's 404 collapse — no leaking which failed).
      const event = await deps.repos.events.getById(input.eventId);
      if (
        !event ||
        event.stewardship !== "COMMUNITY" ||
        !HERO_ATTACHABLE_STATUSES.has(event.status)
      ) {
        throw fail("EVENT_NOT_FOUND");
      }

      // The image must exist, belong to THIS event, and be finalized. Both
      // "missing" and "belongs to another event" collapse to IMAGE_NOT_FOUND
      // so the attach cannot be used to probe images on other events (IDOR).
      const image = await deps.repos.images.getById(input.imageId);
      if (!image || image.eventId !== input.eventId) {
        throw fail("IMAGE_NOT_FOUND");
      }
      // Finalize sets `uploadedAt` + `publicUrl`; require the upload is done.
      // (No IMAGE_UPLOAD_NOT_FINALIZED code exists — UPLOAD_NOT_COMPLETE is the
      // existing code finalize itself returns for the not-yet-uploaded case.)
      if (!image.uploadedAt || !image.publicUrl) {
        throw fail("UPLOAD_NOT_COMPLETE");
      }

      const now = deps.clock.now();

      await deps.repos.tx(async (tx) => {
        await tx.events.applyCommunityEdit({
          eventId: input.eventId,
          fields: { heroImageId: input.imageId },
        });

        // Maintain `attached` in the SAME tx as the hero link. NOTE: this
        // flag is no longer load-bearing — neither the storage sweep nor
        // card/search image resolution reads it any more (both go through the
        // `Event.heroImageId` FK / a computed reachability walk instead,
        // because nothing else in the codebase ever set this flag and trusting
        // it deleted live images in prod). Kept for now so the column stays
        // coherent for the two paths that do write it. Mirrors the
        // suggestion-approve hero attach in review-event-edit-suggestion.ts
        // (FR-007). `image.ownerId === eventId` (set at request-upload time).
        if (!image.attached) {
          await tx.images.attach({
            ownerId: input.eventId,
            imageIds: [input.imageId],
            attachedAt: now,
          });
        }

        await tx.audit.log({
          entity: "event",
          entityId: input.eventId,
          action: "community_listing.hero_attached",
          data: {
            actorHumanId: input.actorHumanId,
            imageId: input.imageId,
          },
          at: now,
        });

        await markForSearchReindex(
          tx,
          [{ kind: "event", id: input.eventId }],
          now,
        );
      });

      // Best-effort incremental search-index update AFTER commit — the hero
      // shows on cards/search. No-ops when `search` is absent.
      reindexAfterMutation(
        {
          repos: deps.repos,
          search: deps.search,
          clock: deps.clock,
          logger: deps.logger,
        },
        "attachCommunityListingHero",
        { kind: "event", id: input.eventId },
      );

      return attachCommunityListingHeroOutputSchema.parse({
        eventId: input.eventId,
        heroImageId: input.imageId,
      });
    };

  if (scopedLogger) {
    return scopedLogger.withTime("attachCommunityListingHero", execute);
  }

  return execute();
}
