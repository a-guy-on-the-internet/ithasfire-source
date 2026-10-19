import { TRPCError } from "@trpc/server";

import {
  getPerformerBookingDefaults,
  getPerformerBookingDefaultsInputSchema,
  getPerformerBookingDefaultsOutputSchema,
  getPerformerStatus,
  getPerformerStatusOutputSchema,
  setPerformerBookingAcceptance,
  setPerformerBookingAcceptanceInputSchema,
  setPerformerBookingAcceptanceOutputSchema,
  setPerformerMode,
  setPerformerModeInputSchema,
  setPerformerModeOutputSchema,
  updatePerformerBookingDefaults,
  updatePerformerBookingDefaultsBaseSchema,
  updatePerformerBookingDefaultsOutputSchema,
} from "@th/core/use-cases/performers";

import { authedProcedure } from "../init";
import { toTrpcError } from "../utils";

const setModeInput = setPerformerModeInputSchema.omit({ actorHumanId: true });

const setBookingAcceptanceInput = setPerformerBookingAcceptanceInputSchema.omit(
  { actorHumanId: true },
);

const getBookingDefaultsInput = getPerformerBookingDefaultsInputSchema.omit({
  actorHumanId: true,
});

// `.omit()` can't be applied after the base schema's cross-field `.refine()`, so
// derive the wire input from the pre-refine base. The use case re-validates the
// full refined schema.
const updateBookingDefaultsInput =
  updatePerformerBookingDefaultsBaseSchema.omit({ actorHumanId: true });

export const performersRouter = {
  setMode: authedProcedure
    .input(setModeInput)
    .output(setPerformerModeOutputSchema)
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
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof setPerformerMode>[0];

      try {
        return await setPerformerMode(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Opt-in toggle for RECEIVING organizer booking requests
   * (organizer-booking-requests FR-002). Authz (self / org admin) and the
   * performer-mode gate live inside the use case.
   */
  setBookingAcceptance: authedProcedure
    .input(setBookingAcceptanceInput)
    .output(setPerformerBookingAcceptanceOutputSchema)
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
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof setPerformerBookingAcceptance>[0];

      try {
        return await setPerformerBookingAcceptance(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  getMyStatus: authedProcedure
    .output(getPerformerStatusOutputSchema)
    .query(async ({ ctx }) => {
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
      } satisfies Parameters<typeof getPerformerStatus>[0];

      try {
        return await getPerformerStatus(deps, { actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  getBookingDefaults: authedProcedure
    .input(getBookingDefaultsInput)
    .output(getPerformerBookingDefaultsOutputSchema)
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
      } satisfies Parameters<typeof getPerformerBookingDefaults>[0];

      try {
        return await getPerformerBookingDefaults(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  updateBookingDefaults: authedProcedure
    .input(updateBookingDefaultsInput)
    .output(updatePerformerBookingDefaultsOutputSchema)
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
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof updatePerformerBookingDefaults>[0];

      try {
        return await updatePerformerBookingDefaults(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};
