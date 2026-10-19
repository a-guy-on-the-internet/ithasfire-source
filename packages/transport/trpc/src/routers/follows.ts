import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  followEntity,
  followEntityInputSchema,
  followEntityOutputSchema,
  unfollowEntity,
  unfollowEntityInputSchema,
  unfollowEntityOutputSchema,
  isFollowing,
  isFollowingInputSchema,
  isFollowingOutputSchema,
  getEntityFollowerCount,
  getEntityFollowerCountInputSchema,
  getEntityFollowerCountOutputSchema,
  updateFollowPreferences,
  updateFollowPreferencesInputSchema,
  updateFollowPreferencesOutputSchema,
  updateEntityFollowSettings,
  updateEntityFollowSettingsInputSchema,
  updateEntityFollowSettingsOutputSchema,
  listFollowedEntities,
  listFollowedEntitiesInputSchema,
  listFollowedEntitiesOutputSchema,
  getEntityFollowerStats,
  getEntityFollowerStatsInputSchema,
  getEntityFollowerStatsOutputSchema,
} from "@th/core/use-cases/follows";

import { authedProcedure, publicProcedure } from "../init";
import { toTrpcError } from "../utils";

const followEntityInput = followEntityInputSchema.omit({ actorHumanId: true });
const unfollowEntityInput = unfollowEntityInputSchema.omit({
  actorHumanId: true,
});
const isFollowingInput = isFollowingInputSchema.omit({ actorHumanId: true });
const updateFollowPreferencesInput = updateFollowPreferencesInputSchema.omit({
  actorHumanId: true,
});
const updateEntityFollowSettingsInput =
  updateEntityFollowSettingsInputSchema.omit({ actorHumanId: true });
// useInfiniteQuery includes `direction`; the strict core schema does not.
const listFollowedEntitiesInput = listFollowedEntitiesInputSchema
  .omit({ actorHumanId: true })
  .extend({ direction: z.enum(["forward", "backward"]).optional() });
const getEntityFollowerStatsInput = getEntityFollowerStatsInputSchema.omit({
  actorHumanId: true,
});

const addActor = <T extends Record<string, unknown>>(
  input: T,
  actorHumanId: string,
) => ({
  ...input,
  actorHumanId,
});

export const followsRouter = {
  followEntity: authedProcedure
    .input(followEntityInput)
    .output(followEntityOutputSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      try {
        return await followEntity(
          { repos: ctx.repos, logger: ctx.logger },
          addActor(input, ctx.actorHumanId),
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  unfollowEntity: authedProcedure
    .input(unfollowEntityInput)
    .output(unfollowEntityOutputSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      try {
        return await unfollowEntity(
          { repos: ctx.repos, logger: ctx.logger },
          addActor(input, ctx.actorHumanId),
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  isFollowing: authedProcedure
    .input(isFollowingInput)
    .output(isFollowingOutputSchema)
    .query(async ({ ctx, input }) => {
      if (!ctx.actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      try {
        return await isFollowing(
          { repos: ctx.repos, logger: ctx.logger },
          addActor(input, ctx.actorHumanId),
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  listFollowedEntities: authedProcedure
    .input(listFollowedEntitiesInput)
    .output(listFollowedEntitiesOutputSchema)
    .query(async ({ ctx, input }) => {
      if (!ctx.actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      try {
        const { direction: _direction, ...rest } = input;
        return await listFollowedEntities(
          { repos: ctx.repos, logger: ctx.logger },
          addActor(rest, ctx.actorHumanId),
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  getFollowerCount: publicProcedure
    .input(getEntityFollowerCountInputSchema)
    .output(getEntityFollowerCountOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await getEntityFollowerCount(
          { repos: ctx.repos, logger: ctx.logger },
          input,
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  getFollowerStats: authedProcedure
    .input(getEntityFollowerStatsInput)
    .output(getEntityFollowerStatsOutputSchema)
    .query(async ({ ctx, input }) => {
      if (!ctx.actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      try {
        return await getEntityFollowerStats(
          { repos: ctx.repos, authz: ctx.authz, logger: ctx.logger },
          addActor(input, ctx.actorHumanId),
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  updateFollowPrefs: authedProcedure
    .input(updateFollowPreferencesInput)
    .output(updateFollowPreferencesOutputSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      try {
        return await updateFollowPreferences(
          { repos: ctx.repos, logger: ctx.logger },
          addActor(input, ctx.actorHumanId),
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  updateFollowSettings: authedProcedure
    .input(updateEntityFollowSettingsInput)
    .output(updateEntityFollowSettingsOutputSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      try {
        return await updateEntityFollowSettings(
          { repos: ctx.repos, authz: ctx.authz, logger: ctx.logger },
          addActor(input, ctx.actorHumanId),
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};
