import { TRPCError } from "@trpc/server";
import {
  getOrgPayoutOverview,
  getOrgPayoutOverviewInputSchema,
  getOrgPayoutOverviewOutputSchema,
} from "@th/core/use-cases/payouts/get-org-payout-overview";
import {
  getPayeeStatement,
  getPayeeStatementInputSchema,
  getPayeeStatementOutputSchema,
} from "@th/core/use-cases/payouts/get-payee-statement";
import {
  exportPayeeLedger,
  exportPayeeLedgerInputSchema,
  exportPayeeLedgerOutputSchema,
} from "@th/core/use-cases/payouts/export-payee-ledger";

import { authedProcedure } from "../init";
import { toTrpcError } from "../utils";

/**
 * Payouts router — the ORGANISER-facing view of the payee LEDGER.
 *
 * Deliberately NOT on `settlements`. That router reads the FROZEN
 * `Settlement` table, which the 2026-08-10 ledger cutover left with zero
 * writers: every credit now lands in `PayeeLedgerEntry`, so
 * `settlements.listForOrg` returns an empty list to every organiser and
 * always will. Hanging the replacement off the same namespace would tie the
 * live read to the dead table's vocabulary and invite exactly the conflation
 * the statement exists to prevent. The use case already lives in
 * `core/use-cases/payouts/`; the transport namespace matches it.
 *
 * RBAC lives in the use case (`canFinanceOrg` for the org path; the human
 * path is the actor's own payee by construction). The transport checks only
 * that an actor exists.
 */
export const payoutsRouter = {
  /**
   * The organiser's ledger statement: BALANCE (everything owed, matured or
   * not) and PAYABLE (the matured, unblocked cell tonight's batch plans
   * from) as SEPARATE figures, the next maturity date, the batch's payout
   * minimum, and a page of the journal.
   */
  getStatement: authedProcedure
    .meta({ description: "Payee ledger statement for an org or the actor" })
    // `.optional()`, because the omit leaves an all-optional object and a
    // required object 400s the no-argument human-path call (`useQuery()`
    // sends `undefined`). Strictness survives: a caller that DOES pass an
    // object still has its unknown keys refused.
    .input(getPayeeStatementInputSchema.omit({ actorHumanId: true }).optional())
    .output(getPayeeStatementOutputSchema)
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
        clock: ctx.clock,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof getPayeeStatement>[0];

      try {
        return await getPayeeStatement(deps, { ...(input ?? {}), actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * EVERY ledger entry of the payee, oldest first, with a signed change and
   * a running balance per currency — the rows behind the Payouts page's
   * "Download CSV". The web app builds the file (its headers are
   * translated). No row cap; a failed read fails the whole export.
   *
   * A MUTATION, though it reads: it writes an audit row, so a query
   * refetch (focus, remount) or a cross-site GET must not be able to
   * re-run it. That audit row is also why this is its own procedure and
   * not a `getStatement` walk.
   */
  exportLedger: authedProcedure
    .meta({ description: "Full payee ledger, oldest first, for CSV export" })
    // `.optional()` for the same reason as `getStatement`: the no-argument
    // human-path call sends `undefined`.
    .input(exportPayeeLedgerInputSchema.omit({ actorHumanId: true }).optional())
    .output(exportPayeeLedgerOutputSchema)
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
        authz: ctx.authz,
        clock: ctx.clock,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof exportPayeeLedger>[0];

      try {
        return await exportPayeeLedger(deps, { ...(input ?? {}), actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * The organiser's payouts SPINE for one org: balance vs payable as
   * separate figures, the upcoming maturity tranches with event attribution,
   * the overdue verdict and the most recent payouts sent. ORG-ONLY — there
   * is no human-payee form of this view, so `orgId` is required and the
   * input object is not optional.
   */
  getOverview: authedProcedure
    .meta({ description: "Organiser payout overview for an org" })
    .input(getOrgPayoutOverviewInputSchema.omit({ actorHumanId: true }))
    .output(getOrgPayoutOverviewOutputSchema)
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
        clock: ctx.clock,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof getOrgPayoutOverview>[0];

      try {
        return await getOrgPayoutOverview(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};

export type PayoutsRouter = typeof payoutsRouter;
