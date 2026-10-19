import { TRPCError } from "@trpc/server";
import {
  confirmPayoutLine,
  confirmPayoutLineInputSchema,
  confirmPayoutLineOutputSchema,
  getPayoutLineForAck,
  getPayoutLineForAckInputSchema,
  getPayoutLineForAckOutputSchema,
} from "@th/core/use-cases/payout-terms";

import { authedProcedure } from "../init";
import { toTrpcError } from "../utils";

const confirmPayoutLineInput = confirmPayoutLineInputSchema.omit({
  actorHumanId: true,
});
const getPayoutLineForAckInput = getPayoutLineForAckInputSchema.omit({
  actorHumanId: true,
});

export const payoutTermsRouter = {
  confirmPayoutLine: authedProcedure
    .input(confirmPayoutLineInput)
    .output(confirmPayoutLineOutputSchema)
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
      } satisfies Parameters<typeof confirmPayoutLine>[0];
      try {
        return await confirmPayoutLine(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  getPayoutLineForAck: authedProcedure
    .input(getPayoutLineForAckInput)
    .output(getPayoutLineForAckOutputSchema)
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
      } satisfies Parameters<typeof getPayoutLineForAck>[0];
      try {
        return await getPayoutLineForAck(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};

export type PayoutTermsRouter = typeof payoutTermsRouter;
