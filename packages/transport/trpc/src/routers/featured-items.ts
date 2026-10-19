import { TRPCError } from "@trpc/server";

import {
  listFeaturedItems,
  listFeaturedAdminItems,
  listFeaturedAdminItemsInputSchema,
  listFeaturedAdminItemsOutputSchema,
  listFeaturedItemsInputSchema,
  listFeaturedItemsOutputSchema,
  upsertFeaturedItem,
  upsertFeaturedItemInputSchema,
  upsertFeaturedItemOutputSchema,
  removeFeaturedItem,
  removeFeaturedItemInputSchema,
  removeFeaturedItemOutputSchema,
} from "@th/core/use-cases/platform";

import { authedProcedure, publicProcedure } from "../init";
import { toTrpcError } from "../utils";

const upsertTransportInput = upsertFeaturedItemInputSchema.omit({
  actorHumanId: true,
});
const removeTransportInput = removeFeaturedItemInputSchema.omit({
  actorHumanId: true,
});

export const featuredItemsRouter = {
  list: publicProcedure
    .input(listFeaturedItemsInputSchema)
    .output(listFeaturedItemsOutputSchema)
    .query(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof listFeaturedItems>[0];

      try {
        return await listFeaturedItems(deps, input);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  listAdmin: authedProcedure
    .input(listFeaturedAdminItemsInputSchema.omit({ actorHumanId: true }))
    .output(listFeaturedAdminItemsOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        logger: ctx.logger,
      } satisfies Parameters<typeof listFeaturedAdminItems>[0];

      try {
        return await listFeaturedAdminItems(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  upsert: authedProcedure
    .input(upsertTransportInput)
    .output(upsertFeaturedItemOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof upsertFeaturedItem>[0];

      try {
        return await upsertFeaturedItem(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  remove: authedProcedure
    .input(removeTransportInput)
    .output(removeFeaturedItemOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof removeFeaturedItem>[0];

      try {
        return await removeFeaturedItem(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};
