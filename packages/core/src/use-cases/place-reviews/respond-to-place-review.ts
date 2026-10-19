import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";

// ---------------------------------------------------------------------------
// Input / Output schemas
// ---------------------------------------------------------------------------

export const respondToPlaceReviewInputSchema = z
  .object({
    reviewId: z.string().uuid(),
    actorHumanId: z.string().uuid(),
    responseText: z.string().min(1).max(2000),
  })
  .strict();

export const respondToPlaceReviewOutputSchema = z
  .object({
    reviewId: z.string().uuid(),
    respondedAt: z.string().datetime(),
  })
  .strict();

export type RespondToPlaceReviewInput = z.infer<
  typeof respondToPlaceReviewInputSchema
>;
export type RespondToPlaceReviewOutput = z.infer<
  typeof respondToPlaceReviewOutputSchema
>;

export type RespondToPlaceReviewDeps = {
  repos: Pick<Repos, "placeReviews" | "places" | "authz" | "audit">;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function respondToPlaceReview(
  deps: RespondToPlaceReviewDeps,
  rawInput: unknown,
): Promise<RespondToPlaceReviewOutput> {
  const input = parseInput(respondToPlaceReviewInputSchema, rawInput);
  const now = deps.clock.now();

  const review = await deps.repos.placeReviews.getById(input.reviewId);
  if (!review) {
    throw fail("REVIEW_NOT_FOUND");
  }

  if (review.responseText) {
    throw fail("REVIEW_ALREADY_RESPONDED");
  }

  // Verify the actor owns the place (directly or via org)
  const place = await deps.repos.places.getById(review.placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }

  const isDirectOwner = place.humanIdsWithAccess.includes(input.actorHumanId);

  let isOrgOwner = false;
  if (!isDirectOwner && place.orgIdsWithAccess.length > 0) {
    const memberships = await deps.repos.authz.getOrgMemberships({
      orgIds: place.orgIdsWithAccess,
      humanId: input.actorHumanId,
    });
    isOrgOwner = memberships.length > 0;
  }

  if (!isDirectOwner && !isOrgOwner) {
    throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "place" } });
  }

  const updated = await deps.repos.placeReviews.respond({
    reviewId: input.reviewId,
    responseById: input.actorHumanId,
    responseText: input.responseText,
  });

  await deps.repos.audit.log({
    entity: "place_review",
    entityId: input.reviewId,
    action: "place_review.response_added",
    data: {
      placeId: review.placeId,
      responderId: input.actorHumanId,
    },
    at: now,
  });

  return {
    reviewId: updated.id,
    respondedAt: updated.respondedAt!.toISOString(),
  };
}
