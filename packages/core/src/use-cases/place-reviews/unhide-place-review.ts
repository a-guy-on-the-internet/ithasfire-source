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

export const unhidePlaceReviewInputSchema = z
  .object({
    reviewId: z.string().uuid(),
    actorHumanId: z.string().uuid(),
  })
  .strict();

export const unhidePlaceReviewOutputSchema = z
  .object({
    reviewId: z.string().uuid(),
    hidden: z.literal(false),
  })
  .strict();

export type UnhidePlaceReviewInput = z.infer<
  typeof unhidePlaceReviewInputSchema
>;
export type UnhidePlaceReviewOutput = z.infer<
  typeof unhidePlaceReviewOutputSchema
>;

export type UnhidePlaceReviewDeps = {
  repos: Pick<Repos, "placeReviews" | "audit">;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function unhidePlaceReview(
  deps: UnhidePlaceReviewDeps,
  rawInput: unknown,
): Promise<UnhidePlaceReviewOutput> {
  const input = parseInput(unhidePlaceReviewInputSchema, rawInput);
  const now = deps.clock.now();

  // Platform admin only
  await requirePlatformStaff({
    authz: deps.authz,
    actorHumanId: input.actorHumanId,
    roles: ["ADMIN"],
    errorCode: "STAFF_ONLY",
  });

  const review = await deps.repos.placeReviews.getById(input.reviewId);
  if (!review) {
    throw fail("REVIEW_NOT_FOUND");
  }

  if (!review.hidden) {
    throw fail("REVIEW_NOT_HIDDEN");
  }

  await deps.repos.placeReviews.unhide(input.reviewId);

  await deps.repos.audit.log({
    entity: "place_review",
    entityId: input.reviewId,
    action: "place_review.unhidden",
    data: {
      placeId: review.placeId,
      unhiddenBy: input.actorHumanId,
    },
    at: now,
  });

  return {
    reviewId: input.reviewId,
    hidden: false,
  };
}
