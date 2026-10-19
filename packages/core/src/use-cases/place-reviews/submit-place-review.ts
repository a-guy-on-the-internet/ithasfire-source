import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";

// ---------------------------------------------------------------------------
// Enum value sets (mirror Prisma enums exactly)
// ---------------------------------------------------------------------------

const PAYMENT_METHOD = [
  "GUARANTEE",
  "DOOR_SPLIT",
  "TICKET_SALES",
  "BAR_PERCENTAGE",
  "TIPS_ONLY",
  "PAY_TO_PLAY",
  "UNPAID",
  "OTHER",
] as const;

const PROMOTION_LEVEL = [
  "ACTIVELY_PROMOTED",
  "POSTED_ONCE",
  "NO_PROMOTION",
] as const;

const SOUND_QUALITY = ["GREAT", "ADEQUATE", "BAD", "NONEXISTENT"] as const;

const STAGE_EQUIPMENT = ["FULL", "PARTIAL", "NONE"] as const;

const AUDIENCE_FIT = ["PERFECT_FIT", "OKAY", "WRONG_CROWD"] as const;

const PLAY_AGAIN = ["YES", "MAYBE", "NO"] as const;

const PARKING = [
  "DEDICATED_LOT",
  "STREET_NEARBY",
  "DIFFICULT",
  "NIGHTMARE",
] as const;

const BOOKER_RATING = [
  "EXCELLENT",
  "GOOD",
  "OKAY",
  "POOR",
  "TERRIBLE",
] as const;

const SOURCE = ["SURVEY", "PLATFORM", "IMPORTED"] as const;

const MERCH_POLICY = [
  "ALLOWED_FREELY",
  "ALLOWED_WITH_CUT",
  "NOT_ALLOWED",
] as const;

const STAFF_SUPPORT = ["YES", "SOMEWHAT", "NO"] as const;

const INDEPENDENT_VENUE = ["YES", "NO", "NOT_SURE"] as const;

const TIME_OF_DAY = ["MORNING", "AFTERNOON", "EVENING", "NIGHT"] as const;

// ---------------------------------------------------------------------------
// Input / Output schemas
// ---------------------------------------------------------------------------

export const submitPlaceReviewInputSchema = z
  .object({
    // Either an existing placeId OR a new stub (name + city)
    placeId: z.string().uuid().optional(),
    placeName: z.string().min(1).max(200).optional(),
    placeCity: z.string().min(1).max(100).optional(),

    /**
     * The review form's session token. When present, the new review is bound
     * to the (token, place) session row in the same transaction — the only
     * binding `patchReviewEmail` accepts.
     */
    sessionToken: z.string().uuid().optional(),

    // Actor (optional in seed phase — no auth required)
    humanId: z.string().uuid().optional(),
    anonymousName: z.string().min(1).max(120).optional(),
    anonymousEmail: z.string().email().optional(),

    // Financial
    payoutCents: z.number().int().nonnegative().nullable().optional(),
    paymentMethod: z.enum(PAYMENT_METHOD),
    paymentDetail: z.string().max(500).optional(),

    // Required enums
    venuePromoted: z.enum(PROMOTION_LEVEL),
    soundQuality: z.enum(SOUND_QUALITY),
    stageEquipment: z.enum(STAGE_EQUIPMENT),
    audienceFit: z.enum(AUDIENCE_FIT),
    wouldPlayAgain: z.enum(PLAY_AGAIN),
    parkingLoadIn: z.enum(PARKING),
    bookerRating: z.enum(BOOKER_RATING),

    // Optional freeform
    promotionDetail: z.string().max(500).optional(),
    soundDetail: z.string().max(500).optional(),
    stageEquipmentDetail: z.string().max(500).optional(),
    audienceDetail: z.string().max(500).optional(),
    parkingDetail: z.string().max(500).optional(),
    bookerDetail: z.string().max(500).optional(),
    comment: z.string().max(1000).optional(),
    genre: z.string().max(200).optional(),
    genreTags: z.array(z.string().max(100)).max(20).optional(),
    estimatedDraw: z.number().int().nonnegative().optional(),

    // v3 optional fields
    gigDate: z.coerce.date().optional(),
    gigTimeOfDay: z.enum(TIME_OF_DAY).optional(),
    gigTimeExact: z.string().max(10).optional(),
    dayOfWeek: z.number().int().min(0).max(6).optional(),
    merchAllowed: z.enum(MERCH_POLICY).optional(),
    merchCutPct: z.number().int().min(0).max(100).optional(),
    staffSupport: z.enum(STAFF_SUPPORT).optional(),
    photoKeys: z.array(z.string()).max(10).optional(),
    independentVenue: z.enum(INDEPENDENT_VENUE).optional(),

    // Optional link to event
    eventId: z.string().uuid().optional(),

    // Source
    source: z.enum(SOURCE).default("SURVEY"),

    // Attribution (campaign/channel tracking)
    sourceAttribution: z
      .object({
        campaign: z.string().max(200).optional(),
        channel: z.enum(["email", "homepage", "direct"]).optional(),
      })
      .optional(),
  })
  .strict()
  .refine((d) => d.placeId || (d.placeName && d.placeCity), {
    message: "Either placeId or both placeName and placeCity are required",
  });

export const submitPlaceReviewOutputSchema = z
  .object({
    reviewId: z.string().uuid(),
    placeId: z.string().uuid(),
    createdStubPlace: z.boolean(),
  })
  .strict();

export type SubmitPlaceReviewInput = z.infer<
  typeof submitPlaceReviewInputSchema
>;
export type SubmitPlaceReviewOutput = z.infer<
  typeof submitPlaceReviewOutputSchema
>;

export type SubmitPlaceReviewDeps = {
  repos: Pick<
    Repos,
    "tx" | "places" | "placeReviews" | "placeReviewSessions" | "audit"
  >;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function submitPlaceReview(
  deps: SubmitPlaceReviewDeps,
  rawInput: unknown,
): Promise<SubmitPlaceReviewOutput> {
  const input = parseInput(submitPlaceReviewInputSchema, rawInput);
  const now = deps.clock.now();

  return deps.repos.tx(async (tx) => {
    let placeId = input.placeId;
    let createdStubPlace = false;

    // Create stub place if needed
    if (!placeId) {
      const stub = await tx.places.upsert({
        name: input.placeName!,
        address: {
          formatted: input.placeCity!,
          line1: "",
          city: input.placeCity!,
          countryCode: "US",
        },
        status: "ACTIVE",
        verificationStatus: "UNVERIFIED",
        listedInDirectory: false,
        // Anonymous-review stubs are UNTRUSTED provenance — never fast-trackable.
        websiteSource: "USER_STUB",
      });
      placeId = stub.id;
      createdStubPlace = true;

      await tx.audit.log({
        entity: "place",
        entityId: placeId,
        action: "place.stub_created_from_review",
        data: { name: input.placeName, city: input.placeCity },
        at: now,
      });
    } else {
      // Verify place exists
      const existing = await tx.places.getById(placeId);
      if (!existing) {
        throw fail("PLACE_NOT_FOUND");
      }
      // The place turned performer reviews off (venue-track-record-and-
      // review-switch FR-002, R1): refuse BEFORE any row is written. Only an
      // explicit `true` opens the channel — a record that could not
      // establish the switch is treated as closed.
      if (existing.communityReviewsEnabled !== true) {
        throw fail("PLACE_COMMUNITY_REVIEWS_DISABLED");
      }
    }

    // Compute dayOfWeek from gigDate if provided and not explicitly set
    const dayOfWeek =
      input.dayOfWeek ?? (input.gigDate ? input.gigDate.getDay() : null);

    const review = await tx.placeReviews.create({
      placeId,
      humanId: input.humanId ?? null,
      anonymousName: input.anonymousName ?? null,
      anonymousEmail: input.anonymousEmail ?? null,
      payoutCents: input.payoutCents ?? null,
      paymentMethod: input.paymentMethod,
      paymentDetail: input.paymentDetail ?? null,
      venuePromoted: input.venuePromoted,
      promotionDetail: input.promotionDetail ?? null,
      soundQuality: input.soundQuality,
      soundDetail: input.soundDetail ?? null,
      stageEquipment: input.stageEquipment,
      stageEquipmentDetail: input.stageEquipmentDetail ?? null,
      audienceFit: input.audienceFit,
      audienceDetail: input.audienceDetail ?? null,
      parkingLoadIn: input.parkingLoadIn,
      parkingDetail: input.parkingDetail ?? null,
      bookerRating: input.bookerRating,
      bookerDetail: input.bookerDetail ?? null,
      wouldPlayAgain: input.wouldPlayAgain,
      comment: input.comment ?? null,
      genre: input.genre ?? null,
      genreTags: input.genreTags ?? [],
      estimatedDraw: input.estimatedDraw ?? null,
      gigDate: input.gigDate ?? null,
      gigTimeOfDay: input.gigTimeOfDay ?? null,
      gigTimeExact: input.gigTimeExact ?? null,
      dayOfWeek,
      merchAllowed: input.merchAllowed ?? null,
      merchCutPct: input.merchCutPct ?? null,
      staffSupport: input.staffSupport ?? null,
      photoKeys: input.photoKeys ?? [],
      independentVenue: input.independentVenue ?? null,
      source: input.source,
      eventId: input.eventId ?? null,
      sourceCampaign: input.sourceAttribution?.campaign ?? null,
      sourceChannel: input.sourceAttribution?.channel ?? null,
    });

    // Bind at creation (F16): the review was created in THIS transaction, so
    // no other session can hold it — the only way a session gets to set a
    // review's email later. Re-reviewing the same place re-points the
    // (token, place) row at the newest review; the older one keeps its
    // anonymousEmail but can no longer be patched.
    if (input.sessionToken) {
      await tx.placeReviewSessions.bindReview({
        sessionToken: input.sessionToken,
        placeId,
        placeReviewId: review.id,
        humanId: input.humanId ?? null,
        completedAt: now,
      });
    }

    await tx.audit.log({
      entity: "place_review",
      entityId: review.id,
      action: "place_review.submitted",
      data: {
        placeId,
        humanId: input.humanId ?? null,
        source: input.source,
        createdStubPlace,
        sourceCampaign: input.sourceAttribution?.campaign ?? null,
        sourceChannel: input.sourceAttribution?.channel ?? null,
      },
      at: now,
    });

    return {
      reviewId: review.id,
      placeId,
      createdStubPlace,
    };
  });
}
