import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";

// ---------------------------------------------------------------------------
// Input / Output schemas
// ---------------------------------------------------------------------------

export const flagPlaceReviewInputSchema = z
  .object({
    reviewId: z.string().uuid(),
    actorHumanId: z.string().uuid(),
    flagReason: z.string().min(1).max(500),
  })
  .strict();

export const flagPlaceReviewOutputSchema = z
  .object({
    reviewId: z.string().uuid(),
    flagged: z.literal(true),
  })
  .strict();

export type FlagPlaceReviewInput = z.infer<typeof flagPlaceReviewInputSchema>;
export type FlagPlaceReviewOutput = z.infer<typeof flagPlaceReviewOutputSchema>;

export type FlagPlaceReviewDeps = {
  repos: Pick<Repos, "placeReviews" | "audit">;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function flagPlaceReview(
  deps: FlagPlaceReviewDeps,
  rawInput: unknown,
): Promise<FlagPlaceReviewOutput> {
  const input = parseInput(flagPlaceReviewInputSchema, rawInput);
  const now = deps.clock.now();

  const review = await deps.repos.placeReviews.getById(input.reviewId);
  if (!review) {
    throw fail("REVIEW_NOT_FOUND");
  }

  if (review.flagged) {
    throw fail("REVIEW_ALREADY_FLAGGED");
  }

  await deps.repos.placeReviews.flag({
    reviewId: input.reviewId,
    flagReason: input.flagReason,
  });

  await deps.repos.audit.log({
    entity: "place_review",
    entityId: input.reviewId,
    action: "place_review.flagged",
    data: {
      placeId: review.placeId,
      flaggedBy: input.actorHumanId,
      flagReason: input.flagReason,
    },
    at: now,
  });

  return {
    reviewId: input.reviewId,
    flagged: true,
  };
}
