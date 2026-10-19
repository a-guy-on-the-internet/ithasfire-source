import { z } from "zod";
import type { Repos } from "@th/ports/repos";
import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";

export const patchReviewEmailInputSchema = z
  .object({
    reviewId: z.string().uuid(),
    /**
     * The token the form minted for `createSession`; `submitPlaceReview`
     * bound it to this review in the transaction that created it. Proves the caller is the browser that wrote the
     * review — without it anyone holding a public review id could attach an
     * address to someone else's anonymous review.
     */
    sessionToken: z.string().uuid(),
    email: z.string().email().max(320),
  })
  .strict();

export const patchReviewEmailOutputSchema = z
  .object({
    ok: z.literal(true),
  })
  .strict();

export type PatchReviewEmailInput = z.infer<typeof patchReviewEmailInputSchema>;
export type PatchReviewEmailOutput = z.infer<
  typeof patchReviewEmailOutputSchema
>;

export type PatchReviewEmailDeps = {
  repos: Pick<Repos, "placeReviews" | "placeReviewSessions">;
};

export async function patchReviewEmail(
  deps: PatchReviewEmailDeps,
  rawInput: unknown,
): Promise<PatchReviewEmailOutput> {
  const input = parseInput(patchReviewEmailInputSchema, rawInput);

  // Session binding (F16, 2026-09-29): the review must be the one this
  // token's session for the review's place was bound to AT SUBMIT (tokens
  // are reused across places and re-reviews, so look up by the pair, never
  // "newest by token"). Any mismatch answers like a missing review.
  const existing = await deps.repos.placeReviews.getById(input.reviewId);
  if (!existing) {
    throw fail("REVIEW_NOT_FOUND");
  }
  const session =
    await deps.repos.placeReviewSessions.getBySessionTokenAndPlace(
      input.sessionToken,
      existing.placeId,
    );
  if (!session || session.placeReviewId !== input.reviewId) {
    throw fail("REVIEW_NOT_FOUND");
  }

  // Idempotent: if email already set, succeed as no-op
  if (existing.anonymousEmail) {
    return { ok: true };
  }

  await deps.repos.placeReviews.patchEmail({
    reviewId: input.reviewId,
    email: input.email,
  });

  return { ok: true };
}
