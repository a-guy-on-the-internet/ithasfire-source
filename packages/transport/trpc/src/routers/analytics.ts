import { TRPCError } from "@trpc/server";
import {
  getOrgDashboardStats,
  getOrgDashboardStatsInputSchema,
  getOrgDashboardStatsOutputSchema,
} from "@th/core/use-cases/analytics";
import { authedProcedure } from "../init";
import { toTrpcError } from "../utils";

const getOrgDashboardStatsInput = getOrgDashboardStatsInputSchema.omit({
  actorHumanId: true,
});

export const analyticsRouter = {
  getOrgDashboardStats: authedProcedure
    .input(getOrgDashboardStatsInput)
    .output(getOrgDashboardStatsOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
      } satisfies Parameters<typeof getOrgDashboardStats>[0];

      try {
        return await getOrgDashboardStats(deps, { ...input, actorHumanId });
      } catch (error) {
        throw toTrpcError(error);
      }
    }),
};
