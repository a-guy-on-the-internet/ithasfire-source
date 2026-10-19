import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";
import { requirePlaceSwitchAuthority } from "./_shared/place-switch-authority";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const setPlaceCommunityReviewsEnabledInputSchema = z
  .object({
    placeId: z.string().uuid(),
    actorHumanId: z.string().uuid(),
    enabled: z.boolean(),
  })
  .strict();

export const setPlaceCommunityReviewsEnabledOutputSchema = z
  .object({
    placeId: z.string().uuid(),
    communityReviewsEnabled: z.boolean(),
  })
  .strict();

export type SetPlaceCommunityReviewsEnabledInput = z.infer<
  typeof setPlaceCommunityReviewsEnabledInputSchema
>;
export type SetPlaceCommunityReviewsEnabledOutput = z.infer<
  typeof setPlaceCommunityReviewsEnabledOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type SetPlaceCommunityReviewsEnabledDeps = {
  repos: Pick<Repos, "places" | "authz" | "audit" | "tx">;
  clock: ClockPort;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Owner-controlled flip of `Place.communityReviewsEnabled` — the PERFORMER-tier
 * switch (docs/specs/2026-09-24/completed/venue-track-record-and-review-switch FR-005,
 * reversing 2026-07-23 FR-007). Off = the place refuses new `PlaceReview`
 * submissions and review sessions, and every public performer surface
 * (`venue_stats`, `placeReviews.getPublicStats`, the trusted-venues list)
 * serves nothing for it (R1). What was already written is NOT deleted: the
 * owner's respond / hide / unhide / list paths keep working (FR-004).
 *
 * This switch governs ONLY the performer tier. It never reads or writes
 * `attendeeReviewsPublic` (FR-001).
 *
 * Ownership is the shared switch bar (`_shared/place-switch-authority`): a
 * direct human owner, or OWNER/ADMIN in an owning org. EDITOR is deliberately
 * NOT enough — closing an inbound channel speaks for the venue, so it sits at
 * the same bar as the other three place switches, not at `ensurePlaceOwnerAccess`.
 *
 * No verification gate. Idempotent — flipping to the current state writes
 * nothing but still emits an audit log.
 */
export async function setPlaceCommunityReviewsEnabled(
  deps: SetPlaceCommunityReviewsEnabledDeps,
  rawInput: unknown,
): Promise<SetPlaceCommunityReviewsEnabledOutput> {
  const input = parseInput(setPlaceCommunityReviewsEnabledInputSchema, rawInput);

  const place = await deps.repos.places.getById(input.placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }

  await requirePlaceSwitchAuthority(deps, place, input.actorHumanId);

  const now = deps.clock.now();

  // ONE column, as a compare-and-set, with its audit row in the same
  // transaction. Never a whole-row `places.upsert` rebuilt from the read
  // above: that would undo a moderator's concurrent name/address edit and
  // rewrite a NULL street line or country as "". `changed` comes from the
  // write, not the read, so the audit `previous` is what the row actually
  // held. Flipping to the current state writes nothing but still audits the
  // (idempotent) owner intent. No reindex: `communityReviewsEnabled` is on no
  // search document.
  const { changed } = await deps.repos.tx(async (tx) => {
    const result = await tx.places.setFlag({
      placeId: place.id,
      flag: "communityReviewsEnabled",
      value: input.enabled,
    });
    // No change can also mean the row is gone (deleted or merged since the
    // read): that is not success.
    if (!result.changed && !(await tx.places.getById(place.id))) {
      throw fail("PLACE_NOT_FOUND");
    }
    await tx.audit.log({
      entity: "place",
      entityId: place.id,
      action: input.enabled
        ? "place.community_reviews_enabled"
        : "place.community_reviews_disabled",
      data: {
        previous: result.changed ? !input.enabled : input.enabled,
        next: input.enabled,
        actorHumanId: input.actorHumanId,
      },
      at: now,
    });
    return result;
  });

  deps.logger?.info("places.set_community_reviews_enabled", {
    placeId: place.id,
    actorHumanId: input.actorHumanId,
    communityReviewsEnabled: input.enabled,
    changed,
  });

  return setPlaceCommunityReviewsEnabledOutputSchema.parse({
    placeId: place.id,
    communityReviewsEnabled: input.enabled,
  });
}
