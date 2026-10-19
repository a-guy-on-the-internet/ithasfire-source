import { TRPCError } from "@trpc/server";
import {
  createCreditsFromOrder,
  createCreditsFromOrderInputSchema,
  createCreditsFromOrderOutputSchema,
} from "@th/core/use-cases/settlements/create-credits-from-order";
import {
  getSettlement,
  getSettlementInputSchema,
  getSettlementOutputSchema,
} from "@th/core/use-cases/settlements/get-settlement";
import {
  listOrgSettlements,
  listOrgSettlementsInputSchema,
  listOrgSettlementsOutputSchema,
} from "@th/core/use-cases/settlements/list-org-settlements";

import { authedProcedure } from "../init";
import { toTrpcError } from "../utils";

/**
 * Settlements router for admin/staff operations.
 *
 * These routes handle the money-flow pipeline after order completion:
 * - Writing SETTLEMENT_CREDIT ledger entries from an order's splits
 * - Querying the FROZEN historical settlement rows
 *
 * `executeTransfer` and `resetFailed` are DELETED with the settlement claim
 * machinery (spec 2026-08-10 §7): transfers happen only in the payout batch,
 * off `max(0, payable)`, and there is no failed settlement row to reset — a
 * failed payout item simply leaves its credits unconsumed for the next cycle.
 *
 * All mutation/query routes (except `listForOrg`, which delegates RBAC to
 * its core use case) require the ADMIN staff role.
 */
export const settlementsRouter = {
  /**
   * Write SETTLEMENT_CREDIT ledger entries from an order's splits — the
   * recovery affordance when the finalize-time write failed. Groups splits by
   * payee; the repo's idempotency keys make re-driving safe.
   */
  createFromOrder: authedProcedure
    .meta({ description: "Create ledger credits from order splits (admin)" })
    .input(createCreditsFromOrderInputSchema)
    .output(createCreditsFromOrderOutputSchema)
    .mutation(async ({ ctx, input }) => {
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
        clock: ctx.clock,
        instantPayouts: ctx.devInstantPayouts,
      } satisfies Parameters<typeof createCreditsFromOrder>[0];

      try {
        return await createCreditsFromOrder(deps, input);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Get details of a specific settlement.
   */
  get: authedProcedure
    .meta({ description: "Get settlement details (admin)" })
    .input(getSettlementInputSchema)
    .output(getSettlementOutputSchema)
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
      } satisfies Parameters<typeof getSettlement>[0];

      try {
        return await getSettlement(deps, input);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Paginated list of settlements for an org.
   * Requires canFinanceOrg permission.
   */
  listForOrg: authedProcedure
    .meta({ description: "List settlements for an org (admin)" })
    .input(listOrgSettlementsInputSchema.omit({ actorHumanId: true }))
    .output(listOrgSettlementsOutputSchema)
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
      } satisfies Parameters<typeof listOrgSettlements>[0];

      try {
        return await listOrgSettlements(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};

export type SettlementsRouter = typeof settlementsRouter;
