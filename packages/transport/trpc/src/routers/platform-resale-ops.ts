import { TRPCError } from "@trpc/server";

import {
  cancelLegacyResaleListings,
  cancelLegacyResaleListingsInputSchema,
  cancelLegacyResaleListingsOutputSchema,
} from "@th/core/use-cases/resale";

import { authedProcedure } from "../init";
import { toTrpcError } from "../utils";

const cancelLegacyInput = cancelLegacyResaleListingsInputSchema.omit({
  actorHumanId: true,
});

/**
 * One-off resale operations run by platform staff. Mounted under
 * `platformJobs.*` (router.ts), which puts them behind the staff second-factor
 * gate and the API-key denylist prefix. The use cases check the staff role
 * themselves.
 */
export const platformResaleOpsRouter = {
  /**
   * Cancel live resale listings priced under the removed markup split, with
   * a notice to each seller to list again (organiser-resale-share FR-015).
   * `dryRun` defaults to true. Platform ADMIN.
   */
  cancelLegacyResaleListings: authedProcedure
    .input(cancelLegacyInput)
    .output(cancelLegacyResaleListingsOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }
      try {
        return await cancelLegacyResaleListings(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            mailer: ctx.mailer ?? null,
            publicAppUrl: ctx.publicAppUrl ?? null,
            logger: ctx.logger,
            reportError: ctx.reportError ?? null,
          },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};
