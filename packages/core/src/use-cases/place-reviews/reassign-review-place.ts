import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";
import { fail } from "@th/errors";

// ---------------------------------------------------------------------------
// Input / Output schemas
// ---------------------------------------------------------------------------

export const reassignReviewPlaceInputSchema = z
  .object({
    reviewId: z.string().uuid(),
    newPlaceId: z.string().uuid(),
    actorHumanId: z.string().uuid(),
  })
  .strict();

export const reassignReviewPlaceOutputSchema = z
  .object({
    reviewId: z.string().uuid(),
    oldPlaceId: z.string().uuid(),
    newPlaceId: z.string().uuid(),
    newPlaceName: z.string(),
  })
  .strict();

export type ReassignReviewPlaceInput = z.infer<
  typeof reassignReviewPlaceInputSchema
>;
export type ReassignReviewPlaceOutput = z.infer<
  typeof reassignReviewPlaceOutputSchema
>;

export type ReassignReviewPlaceDeps = {
  repos: Pick<Repos, "placeReviews" | "places" | "audit">;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * Move a review to a different place. Staff-only operation used when a
 * reviewer misspelled or mislabeled the venue.
 */
export async function reassignReviewPlace(
  deps: ReassignReviewPlaceDeps,
  rawInput: unknown,
): Promise<ReassignReviewPlaceOutput> {
  const input = parseInput(reassignReviewPlaceInputSchema, rawInput);
  const now = deps.clock.now();

  // Platform staff only
  await requirePlatformStaff({
    authz: deps.authz,
    actorHumanId: input.actorHumanId,
    roles: ["ADMIN", "REVIEWER"],
    errorCode: "STAFF_ONLY",
  });

  // Validate the review exists
  const review = await deps.repos.placeReviews.getById(input.reviewId);
  if (!review) {
    throw fail("REVIEW_NOT_FOUND");
  }

  // No-op if already on the target place
  if (review.placeId === input.newPlaceId) {
    const place = await deps.repos.places.getById(input.newPlaceId);
    return {
      reviewId: input.reviewId,
      oldPlaceId: review.placeId,
      newPlaceId: input.newPlaceId,
      newPlaceName: place?.name ?? "Unknown",
    };
  }

  // Validate the target place exists
  const targetPlace = await deps.repos.places.getById(input.newPlaceId);
  if (!targetPlace) {
    throw fail("PLACE_NOT_FOUND", { meta: { role: "target" } });
  }

  const oldPlaceId = review.placeId;

  await deps.repos.placeReviews.reassignPlace(input.reviewId, input.newPlaceId);

  await deps.repos.audit.log({
    entity: "place_review",
    entityId: input.reviewId,
    action: "place_review.reassigned",
    data: {
      oldPlaceId,
      newPlaceId: input.newPlaceId,
      newPlaceName: targetPlace.name,
      reassignedBy: input.actorHumanId,
    },
    at: now,
  });

  deps.logger?.info("place_reviews.reassign", {
    reviewId: input.reviewId,
    oldPlaceId,
    newPlaceId: input.newPlaceId,
    actorHumanId: input.actorHumanId,
  });

  return {
    reviewId: input.reviewId,
    oldPlaceId,
    newPlaceId: input.newPlaceId,
    newPlaceName: targetPlace.name,
  };
}
