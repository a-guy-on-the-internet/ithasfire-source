import { z } from "zod";

/** Default "near you" radius when a nearby follow has none stored. */
export const FOLLOW_NEARBY_DEFAULT_RADIUS_KM = 100;

const pageOwnerTypeSchema = z.enum(["HUMAN", "ORGANIZATION", "PLACE"]);
const actorHumanIdSchema = z.string().trim().min(1);
const entityPageIdSchema = z.string().trim().min(1);
const cursorSchema = z.string().trim().min(1).nullable();

export const followEntityInputSchema = z
  .object({
    actorHumanId: actorHumanIdSchema,
    entityPageId: entityPageIdSchema,
    notifyNearby: z.boolean().optional(),
    radiusKm: z.number().int().positive().max(500).optional(),
  })
  .strict();

export const followEntityOutputSchema = z
  .object({
    followId: z.string(),
    alreadyFollowing: z.boolean(),
  })
  .strict();

export const unfollowEntityInputSchema = z
  .object({
    actorHumanId: actorHumanIdSchema,
    entityPageId: entityPageIdSchema,
  })
  .strict();

export const unfollowEntityOutputSchema = z
  .object({
    success: z.boolean(),
  })
  .strict();

export const isFollowingInputSchema = z
  .object({
    actorHumanId: actorHumanIdSchema,
    entityPageId: entityPageIdSchema,
  })
  .strict();

export const isFollowingOutputSchema = z
  .object({
    isFollowing: z.boolean(),
  })
  .strict();

export const getEntityFollowerCountInputSchema = z
  .object({
    entityPageId: entityPageIdSchema,
  })
  .strict();

export const getEntityFollowerCountOutputSchema = z
  .object({
    count: z.number().int().nonnegative().nullable(),
    isPublic: z.boolean(),
  })
  .strict();

export const updateFollowPreferencesInputSchema = z
  .object({
    actorHumanId: actorHumanIdSchema,
    entityPageId: entityPageIdSchema,
    notifyNewEvents: z.boolean(),
    notifyNearby: z.boolean(),
    radiusKm: z.number().int().positive().max(500).optional(),
  })
  .strict();

export const updateFollowPreferencesOutputSchema = z
  .object({
    followId: z.string(),
  })
  .strict();

export const updateEntityFollowSettingsInputSchema = z
  .object({
    actorHumanId: actorHumanIdSchema,
    entityPageId: entityPageIdSchema,
    allowFollows: z.boolean(),
    showFollowerCount: z.boolean(),
  })
  .strict();

export const updateEntityFollowSettingsOutputSchema = z
  .object({
    entityPageId: z.string(),
  })
  .strict();

const followedEntityItemSchema = z
  .object({
    followId: z.string(),
    entityPageId: z.string(),
    slug: z.string(),
    displayName: z.string(),
    avatarUrl: z.string().nullable(),
    ownerType: pageOwnerTypeSchema,
    followedAt: z.date(),
    notifyNewEvents: z.boolean(),
    notifyNearby: z.boolean(),
    radiusKm: z.number().int().positive().max(500).nullable(),
  })
  .strict();

export const listFollowedEntitiesInputSchema = z
  .object({
    actorHumanId: actorHumanIdSchema,
    ownerTypeFilter: pageOwnerTypeSchema.optional(),
    cursor: cursorSchema.optional(),
    limit: z.number().int().positive().max(100).optional(),
  })
  .strict();

export const listFollowedEntitiesOutputSchema = z
  .object({
    items: z.array(followedEntityItemSchema),
    nextCursor: cursorSchema,
  })
  .strict();

export const getEntityFollowerStatsInputSchema = z
  .object({
    actorHumanId: actorHumanIdSchema,
    entityPageId: entityPageIdSchema,
  })
  .strict();

export const getEntityFollowerStatsOutputSchema = z
  .object({
    totalFollowers: z.number().int().nonnegative(),
    newLast7Days: z.number().int().nonnegative(),
    newLast30Days: z.number().int().nonnegative(),
  })
  .strict();

export { pageOwnerTypeSchema };
