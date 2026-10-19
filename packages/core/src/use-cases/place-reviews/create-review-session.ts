import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";

// ---------------------------------------------------------------------------
// Input / Output schemas
// ---------------------------------------------------------------------------

export const createReviewSessionInputSchema = z
  .object({
    sessionToken: z.string().uuid(),
    placeId: z.string().uuid(),
    humanId: z.string().uuid().optional(),
  })
  .strict();

export const createReviewSessionOutputSchema = z
  .object({
    sessionId: z.string().uuid(),
  })
  .strict();

export type CreateReviewSessionInput = z.infer<
  typeof createReviewSessionInputSchema
>;
export type CreateReviewSessionOutput = z.infer<
  typeof createReviewSessionOutputSchema
>;

export type CreateReviewSessionDeps = {
  repos: Pick<Repos, "placeReviewSessions" | "places">;
  logger?: LoggerPort;
};

export async function createReviewSession(
  deps: CreateReviewSessionDeps,
  rawInput: unknown,
): Promise<CreateReviewSessionOutput> {
  const input = parseInput(createReviewSessionInputSchema, rawInput);

  // Verify place exists
  const place = await deps.repos.places.getById(input.placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }
  // FR-002: a multi-step form must not START against a place whose
  // performer-review switch is off — refuse before the session row exists.
  // Only an explicit `true` opens the channel (mirrors submitPlaceReview).
  if (place.communityReviewsEnabled !== true) {
    throw fail("PLACE_COMMUNITY_REVIEWS_DISABLED");
  }

  const session = await deps.repos.placeReviewSessions.upsert({
    sessionToken: input.sessionToken,
    placeId: input.placeId,
    humanId: input.humanId,
  });

  return { sessionId: session.id };
}
