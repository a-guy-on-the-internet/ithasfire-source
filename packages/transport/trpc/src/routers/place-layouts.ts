import { TRPCError } from "@trpc/server";
import {
  replacePlaceLayout,
  replacePlaceLayoutInputSchema,
  replacePlaceLayoutOutputSchema,
  deletePlaceLayout,
  deletePlaceLayoutInputSchema,
  deletePlaceLayoutOutputSchema,
  getPlaceLayout,
  getPlaceLayoutInputSchema,
  getPlaceLayoutOutputSchema,
  getPublicPlaceLayout,
  getPublicPlaceLayoutInputSchema,
  getPublicPlaceLayoutOutputSchema,
  requestPlaceLayoutUpload,
  requestPlaceLayoutUploadInputSchema,
  requestPlaceLayoutUploadOutputSchema,
} from "@th/core/use-cases/place-layouts";
import { authedProcedure, publicProcedure } from "../init";
import { toTrpcError } from "../utils";

const replacePlaceLayoutProcedureInput = replacePlaceLayoutInputSchema.omit({
  actorHumanId: true,
});
const deletePlaceLayoutProcedureInput = deletePlaceLayoutInputSchema.omit({
  actorHumanId: true,
});
const getPlaceLayoutProcedureInput = getPlaceLayoutInputSchema.omit({
  actorHumanId: true,
});
const requestPlaceLayoutUploadProcedureInput =
  requestPlaceLayoutUploadInputSchema.omit({ actorHumanId: true });

export const placeLayoutsRouter = {
  replacePlaceLayout: authedProcedure
    .input(replacePlaceLayoutProcedureInput)
    .output(replacePlaceLayoutOutputSchema)
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
        parser: ctx.placeLayoutParser,
        idempotency: ctx.idempotency,
        streaming: ctx.placeLayoutStreaming,
        storage: ctx.fileStorage,
        clock: ctx.clock,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof replacePlaceLayout>[0];

      try {
        return await replacePlaceLayout(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  deletePlaceLayout: authedProcedure
    .input(deletePlaceLayoutProcedureInput)
    .output(deletePlaceLayoutOutputSchema)
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
        streaming: ctx.placeLayoutStreaming,
        storage: ctx.fileStorage,
        clock: ctx.clock,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof deletePlaceLayout>[0];

      try {
        return await deletePlaceLayout(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  getPlaceLayout: authedProcedure
    .input(getPlaceLayoutProcedureInput)
    .output(getPlaceLayoutOutputSchema)
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
        logger: ctx.logger,
      } satisfies Parameters<typeof getPlaceLayout>[0];

      try {
        return await getPlaceLayout(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  getPublicPlaceLayout: publicProcedure
    .input(getPublicPlaceLayoutInputSchema)
    .output(getPublicPlaceLayoutOutputSchema)
    .query(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
      } satisfies Parameters<typeof getPublicPlaceLayout>[0];

      try {
        return await getPublicPlaceLayout(deps, input);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  requestPlaceLayoutUpload: authedProcedure
    .input(requestPlaceLayoutUploadProcedureInput)
    .output(requestPlaceLayoutUploadOutputSchema)
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
        storage: ctx.fileStorage,
        logger: ctx.logger,
      } satisfies Parameters<typeof requestPlaceLayoutUpload>[0];

      try {
        return await requestPlaceLayoutUpload(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};
