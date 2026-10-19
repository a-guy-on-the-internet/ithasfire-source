import { TRPCError } from "@trpc/server";
import {
  generateWalletPass,
  generateWalletPassInputSchema,
  generateWalletPassOutputSchema,
} from "@th/core/use-cases/orders/generate-wallet-pass";

import { verifiedEmailProcedure } from "../init";
import { toTrpcError } from "../utils";

const generateWalletPassInput = generateWalletPassInputSchema.omit({
  actorHumanId: true,
});

export const walletPassesRouter = {
  generate: verifiedEmailProcedure
    .input(generateWalletPassInput)
    .output(generateWalletPassOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      if (!ctx.walletPass) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Wallet passes are not configured",
        });
      }

      const deps = {
        repos: ctx.repos,
        walletPass: ctx.walletPass,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof generateWalletPass>[0];

      try {
        return await generateWalletPass(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};
