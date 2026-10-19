import { TRPCError } from "@trpc/server";
import {
  getDefaultPayoutTerms,
  getDefaultPayoutTermsInputSchema,
  getDefaultPayoutTermsOutputSchema,
  updatePayoutSchedule,
  updatePayoutScheduleInputSchemaBase,
  updatePayoutScheduleOutputSchema,
} from "@th/core/use-cases/agreements";

import { authedProcedure } from "../init";
import { toTrpcError } from "../utils";

const getDefaultPayoutTermsInput = getDefaultPayoutTermsInputSchema.omit({
  actorHumanId: true,
});
const updatePayoutScheduleInput = updatePayoutScheduleInputSchemaBase.omit({
  actorHumanId: true,
});

export const agreementsRouter = {
  getDefaultPayoutTerms: authedProcedure
    .input(getDefaultPayoutTermsInput)
    .output(getDefaultPayoutTermsOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Missing actor human id",
        });
      }

      try {
        return await getDefaultPayoutTerms(
          { repos: ctx.repos, logger: ctx.logger },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  updatePayoutSchedule: authedProcedure
    .input(updatePayoutScheduleInput)
    .output(updatePayoutScheduleOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Missing actor human id",
        });
      }

      try {
        return await updatePayoutSchedule(
          { repos: ctx.repos, logger: ctx.logger },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};
