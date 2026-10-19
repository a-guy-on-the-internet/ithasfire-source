import { TRPCError } from "@trpc/server";
import {
  listOrderSplits,
  listOrderSplitsInputSchema,
  listOrderSplitsOutputSchema,
} from "@th/core/use-cases/splits/list-order-splits";

import { authedProcedure } from "../init";
import { toTrpcError } from "../utils";

/**
 * Splits router for admin/staff operations.
 *
 * Order splits represent how revenue from an order is divided among payees
 * according to agreements. These routes allow inspection of split allocations.
 *
 * All routes require the ADMIN staff role.
 */
export const splitsRouter = {
  /**
   * List all splits for a specific order.
   * Returns payee details and amounts for each split.
   */
  listForOrder: authedProcedure
    .meta({ description: "List splits for an order (admin)" })
    .input(listOrderSplitsInputSchema)
    .output(listOrderSplitsOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const staff = await ctx.authz.hasStaffRole({
        actorHumanId,
        requiredRoles: ["ADMIN"],
      });
      if (!staff.allowed) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Requires ADMIN role",
        });
      }

      const deps = {
        repos: ctx.repos,
      } satisfies Parameters<typeof listOrderSplits>[0];

      try {
        return await listOrderSplits(deps, input);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};

export type SplitsRouter = typeof splitsRouter;
