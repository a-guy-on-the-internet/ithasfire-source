import {
  grantCredit,
  grantCreditInputSchema,
  listCreditsForHuman,
} from "@th/core/use-cases/credits";

import { authedProcedure, verifiedEmailProcedure } from "../init";
import { toTrpcError } from "../utils";

const grantInput = grantCreditInputSchema.omit({ actorHumanId: true });

export const creditsRouter = {
  /**
   * Read-only view of the signed-in human's platform credits, redemption
   * history, and spendable balance for the account UI.
   *
   * B2: a refund to credit on an order guest checkout attached by email lands
   * on the Human, so an unverified account sees no balance. It could not
   * spend one anyway (checkout requires a verified email).
   */
  listMine: verifiedEmailProcedure.query(async ({ ctx }) => {
    try {
      return await listCreditsForHuman(
        { repos: ctx.repos, logger: ctx.logger },
        { humanId: ctx.actorHumanId },
      );
    } catch (err) {
      throw toTrpcError(err);
    }
  }),

  /**
   * Platform-staff-only credit grant. RBAC is enforced inside the use case via
   * requirePlatformStaff; there is no staff grant UI yet (Phase 1).
   */
  grant: authedProcedure
    .input(grantInput)
    .mutation(async ({ ctx, input }) => {
      try {
        return await grantCredit(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
          },
          { ...input, actorHumanId: ctx.actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};
