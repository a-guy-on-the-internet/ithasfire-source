import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";

// ---------------------------------------------------------------------------
// Input / Output schemas
// ---------------------------------------------------------------------------

const MODERATION_FILTER_VALUES = [
  "all",
  "flagged",
  "hidden",
  "visible",
] as const;

export const listPlatformReviewsInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    placeId: z.string().uuid().optional(),
    moderationFilter: z.enum(MODERATION_FILTER_VALUES).default("all"),
    limit: z.number().int().min(1).max(100).default(25),
    offset: z.number().int().nonnegative().default(0),
  })
  .strict();

const reviewSummarySchema = z
  .object({
    id: z.string().uuid(),
    placeId: z.string().uuid(),
    placeName: z.string(),
    anonymousName: z.string().nullable(),
    anonymousEmail: z.string().nullable(),
    payoutCents: z.number().nullable(),
    paymentMethod: z.string(),
    paymentDetail: z.string().nullable(),
    venuePromoted: z.string(),
    promotionDetail: z.string().nullable(),
    soundQuality: z.string(),
    soundDetail: z.string().nullable(),
    stageEquipment: z.string().nullable(),
    stageEquipmentDetail: z.string().nullable(),
    audienceFit: z.string(),
    audienceDetail: z.string().nullable(),
    wouldPlayAgain: z.string(),
    bookerRating: z.string(),
    bookerDetail: z.string().nullable(),
    parkingLoadIn: z.string().nullable(),
    parkingDetail: z.string().nullable(),
    estimatedDraw: z.number().nullable(),
    comment: z.string().nullable(),
    genre: z.string().nullable(),
    source: z.string(),
    flagged: z.boolean(),
    flagReason: z.string().nullable(),
    hidden: z.boolean(),
    responseText: z.string().nullable(),
    respondedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();

export const listPlatformReviewsOutputSchema = z
  .object({
    reviews: z.array(reviewSummarySchema),
    total: z.number().int().nonnegative(),
  })
  .strict();

export type ListPlatformReviewsInput = z.infer<
  typeof listPlatformReviewsInputSchema
>;
export type ListPlatformReviewsOutput = z.infer<
  typeof listPlatformReviewsOutputSchema
>;

export type ListPlatformReviewsDeps = {
  repos: Pick<Repos, "placeReviews" | "places">;
  authz: Pick<AuthZPort, "hasStaffRole">;
  logger?: LoggerPort;
};

export async function listPlatformReviews(
  deps: ListPlatformReviewsDeps,
  rawInput: unknown,
): Promise<ListPlatformReviewsOutput> {
  const input = parseInput(listPlatformReviewsInputSchema, rawInput);

  await requirePlatformStaff({
    authz: deps.authz,
    actorHumanId: input.actorHumanId,
    roles: ["ADMIN", "REVIEWER", "SUPPORT", "DEVELOPER"],
    errorCode: "STAFF_ONLY",
  });

  const { reviews: allReviews, total } =
    await deps.repos.placeReviews.listForModeration({
      placeId: input.placeId,
      moderationFilter: input.moderationFilter,
      limit: input.limit,
      offset: input.offset,
    });

  // Resolve place names in a single batch
  const placeIds = [...new Set(allReviews.map((r) => r.placeId))];
  const placeMap = new Map<string, string>();
  await Promise.all(
    placeIds.map(async (pid) => {
      const place = await deps.repos.places.getById(pid);
      if (place) placeMap.set(pid, place.name);
    }),
  );

  return {
    reviews: allReviews.map((r) => ({
      id: r.id,
      placeId: r.placeId,
      placeName: placeMap.get(r.placeId) ?? "Unknown place",
      anonymousName: r.anonymousName,
      anonymousEmail: r.anonymousEmail,
      payoutCents: r.payoutCents,
      paymentMethod: r.paymentMethod,
      paymentDetail: r.paymentDetail ?? null,
      venuePromoted: r.venuePromoted,
      promotionDetail: r.promotionDetail ?? null,
      soundQuality: r.soundQuality,
      soundDetail: r.soundDetail ?? null,
      stageEquipment: r.stageEquipment ?? null,
      stageEquipmentDetail: r.stageEquipmentDetail ?? null,
      audienceFit: r.audienceFit,
      audienceDetail: r.audienceDetail ?? null,
      wouldPlayAgain: r.wouldPlayAgain,
      bookerRating: r.bookerRating,
      bookerDetail: r.bookerDetail ?? null,
      parkingLoadIn: r.parkingLoadIn ?? null,
      parkingDetail: r.parkingDetail ?? null,
      estimatedDraw: r.estimatedDraw ?? null,
      comment: r.comment,
      genre: r.genre,
      source: r.source,
      flagged: r.flagged,
      flagReason: r.flagReason,
      hidden: r.hidden,
      responseText: r.responseText,
      respondedAt: r.respondedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
    total,
  };
}
