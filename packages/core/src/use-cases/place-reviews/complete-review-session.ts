import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";

// ---------------------------------------------------------------------------
// Input / Output schemas
// ---------------------------------------------------------------------------

export const completeReviewSessionInputSchema = z
  .object({
    sessionToken: z.string().uuid(),
    placeReviewId: z.string().uuid(),
  })
  .strict();

export const completeReviewSessionOutputSchema = z
  .object({ ok: z.boolean() })
  .strict();

export type CompleteReviewSessionInput = z.infer<
  typeof completeReviewSessionInputSchema
>;
export type CompleteReviewSessionOutput = z.infer<
  typeof completeReviewSessionOutputSchema
>;

export type CompleteReviewSessionDeps = {
  repos: Pick<Repos, "placeReviewSessions" | "placeReviews">;
  logger?: LoggerPort;
};

export async function completeReviewSession(
  deps: CompleteReviewSessionDeps,
  rawInput: unknown,
): Promise<CompleteReviewSessionOutput> {
  const input = parseInput(completeReviewSessionInputSchema, rawInput);

  // No longer a binding point (F16, 2026-09-29). `submitPlaceReview` binds
  // the review to the (token, place) session row in the transaction that
  // creates it; binding here let any client-minted token claim an unbound
  // review, and "newest row by token" broke re-reviews. This only reports
  // whether that binding exists. Nothing is written.
  const review = await deps.repos.placeReviews.getById(input.placeReviewId);
  if (!review) return { ok: false };
  const session =
    await deps.repos.placeReviewSessions.getBySessionTokenAndPlace(
      input.sessionToken,
      review.placeId,
    );
  return { ok: session?.placeReviewId === input.placeReviewId };
}
