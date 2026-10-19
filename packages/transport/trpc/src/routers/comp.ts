import { TRPCError } from "@trpc/server";

import {
  issueCompTickets,
  issueCompTicketsInputSchema,
  issueCompTicketsOutputSchema,
  listCompOrders,
  listCompOrdersInputSchema,
  listCompOrdersOutputSchema,
} from "@th/core/use-cases/comp";

import { authedProcedure } from "../init";
import { toTrpcError } from "../utils";

// ── Omit actorHumanId — injected from session ─────────────────────────────
const issueInput = issueCompTicketsInputSchema.omit({ actorHumanId: true });
const listInput = listCompOrdersInputSchema.omit({ actorHumanId: true });

export const compRouter = {
  issue: authedProcedure
    .input(issueInput)
    .output(issueCompTicketsOutputSchema)
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
      } satisfies Parameters<typeof issueCompTickets>[0];

      try {
        return await issueCompTickets(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Comps ledger for one event. Read-only; the org gate is EDIT-or-FINANCE
   * (wider than `issue`, which is admin-only) — the reasoning lives in the use
   * case docblock, not here.
   */
  list: authedProcedure
    .input(listInput)
    .output(listCompOrdersOutputSchema)
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
      } satisfies Parameters<typeof listCompOrders>[0];

      try {
        return await listCompOrders(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};

export type CompRouter = typeof compRouter;
