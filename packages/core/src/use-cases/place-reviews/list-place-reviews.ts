import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";

// ---------------------------------------------------------------------------
// Input / Output schemas
// ---------------------------------------------------------------------------

export const listPlaceReviewsInputSchema = z
  .object({
    placeId: z.string().uuid(),
    limit: z.number().int().min(1).max(50).default(20),
    offset: z.number().int().nonnegative().default(0),
  })
  .strict();

export const listPlaceReviewsOutputSchema = z
  .object({
    reviews: z.array(
      z.object({
        id: z.string().uuid(),
        placeId: z.string().uuid(),
        anonymousName: z.string().nullable(),
        payoutCents: z.number().nullable(),
        paymentMethod: z.string(),
        paymentDetail: z.string().nullable(),
        venuePromoted: z.string(),
        promotionDetail: z.string().nullable(),
        soundQuality: z.string(),
        soundDetail: z.string().nullable(),
        stageEquipment: z.string(),
        stageEquipmentDetail: z.string().nullable(),
        audienceFit: z.string(),
        audienceDetail: z.string().nullable(),
        wouldPlayAgain: z.string(),
        parkingLoadIn: z.string(),
        parkingDetail: z.string().nullable(),
        bookerRating: z.string(),
        bookerDetail: z.string().nullable(),
        comment: z.string().nullable(),
        genre: z.string().nullable(),
        estimatedDraw: z.number().nullable(),
        source: z.string(),
        // Response
        responseText: z.string().nullable(),
        respondedAt: z.string().datetime().nullable(),
        createdAt: z.string().datetime(),
      }),
    ),
    total: z.number(),
  })
  .strict();

export type ListPlaceReviewsInput = z.infer<typeof listPlaceReviewsInputSchema>;
export type ListPlaceReviewsOutput = z.infer<
  typeof listPlaceReviewsOutputSchema
>;

export type ListPlaceReviewsDeps = {
  repos: Pick<Repos, "placeReviews">;
  logger?: LoggerPort;
};

export async function listPlaceReviews(
  deps: ListPlaceReviewsDeps,
  rawInput: unknown,
): Promise<ListPlaceReviewsOutput> {
  const input = parseInput(listPlaceReviewsInputSchema, rawInput);

  const [reviews, total] = await Promise.all([
    deps.repos.placeReviews.listByPlace({
      placeId: input.placeId,
      visibleOnly: true,
      limit: input.limit,
      offset: input.offset,
    }),
    deps.repos.placeReviews.countByPlace(input.placeId, true),
  ]);

  return {
    reviews: reviews.map((r) => ({
      id: r.id,
      placeId: r.placeId,
      // Strip anonymousEmail from output (privacy)
      anonymousName: r.anonymousName,
      payoutCents: r.payoutCents,
      paymentMethod: r.paymentMethod,
      paymentDetail: r.paymentDetail,
      venuePromoted: r.venuePromoted,
      promotionDetail: r.promotionDetail,
      soundQuality: r.soundQuality,
      soundDetail: r.soundDetail,
      stageEquipment: r.stageEquipment,
      stageEquipmentDetail: r.stageEquipmentDetail,
      audienceFit: r.audienceFit,
      audienceDetail: r.audienceDetail,
      wouldPlayAgain: r.wouldPlayAgain,
      parkingLoadIn: r.parkingLoadIn,
      parkingDetail: r.parkingDetail,
      bookerRating: r.bookerRating,
      bookerDetail: r.bookerDetail,
      comment: r.comment,
      genre: r.genre,
      estimatedDraw: r.estimatedDraw,
      source: r.source,
      responseText: r.responseText,
      respondedAt: r.respondedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
    total,
  };
}
