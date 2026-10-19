import { TRPCError } from "@trpc/server";

import {
  answerDealClauseInputSchema,
  answerDealClauseOutputSchema,
  confirmDealClause,
  declineDealClause,
  addSheetDirectPayment,
  addSheetDirectPaymentInputSchema,
  clearSheetDeductionActual,
  clearSheetDeductionActualInputSchema,
  exportEventSettlementCsv,
  exportEventSettlementCsvInputSchema,
  exportEventSettlementCsvOutputSchema,
  freezeEventDeal,
  freezeEventDealInputSchema,
  freezeEventDealOutputSchema,
  getAgreementDeal,
  getAgreementDealInputSchema,
  getAgreementDealOutputSchema,
  getEventSettlement,
  getEventSettlementInputSchema,
  getEventSettlementOutputSchema,
  getTermsDeal,
  getTermsDealInputSchema,
  getTermsDealOutputSchema,
  listDealChanges,
  listDealChangesInputSchema,
  listDealChangesOutputSchema,
  getResaleClause,
  getResaleClauseInputSchema,
  getResaleClauseOutputSchema,
  markEventSettled,
  markEventSettledInputSchema,
  markEventSettledOutputSchema,
  projectAgreementDeal,
  projectAgreementDealInputSchema,
  projectAgreementDealOutputSchema,
  projectTermsDeal,
  projectTermsDealInputSchema,
  projectTermsDealOutputSchema,
  removeSheetDirectPayment,
  removeSheetDirectPaymentInputSchema,
  removeSheetOffPlatform,
  removeSheetOffPlatformInputSchema,
  reopenEventSettlement,
  reopenEventSettlementInputSchema,
  reopenEventSettlementOutputSchema,
  setResaleClause,
  setResaleClauseInputSchema,
  setResaleClauseOutputSchema,
  setSheetDeductionActual,
  setSheetDeductionActualInputSchema,
  setTermsDeal,
  setTermsDealInputSchema,
  setTermsDealOutputSchema,
  sheetWriteOutputSchema,
  upsertSheetOffPlatform,
  upsertSheetOffPlatformInputSchema,
} from "@th/core/use-cases/deals";

import { dealChangeNoticeDeps } from "../deal-change-notice-deps";
import { authedProcedure } from "../init";
import { toTrpcError } from "../utils";

// Deal terms on a booking agreement and the event settlement sheet
// (deal-terms-and-settlement stage 1, P4b). Thin: parse, call, map errors.
// Every visibility and authz rule (M5, organiser side) lives in the use cases.

const actorOmitted = { actorHumanId: true } as const;

function requireActor(actorHumanId: string | null | undefined): string {
  if (!actorHumanId) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Missing actor human id" });
  }
  return actorHumanId;
}

export const dealsRouter = {
  // ── The deal on a booking agreement ───────────────────────────────────
  getAgreementDeal: authedProcedure
    .input(getAgreementDealInputSchema.omit(actorOmitted))
    .output(getAgreementDealOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      try {
        return await getAgreementDeal({ repos: ctx.repos }, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  // No `setAgreementDeal` procedure: a booking's deal is written through
  // `setTermsDeal` (target BOOKING_AGREEMENT), which carries the lost-update
  // guard (`expectedDealFingerprint`). Removed in organiser-resale-share B5a.

  /** "If we sell N at $P" — the editor's calculator. */
  projectAgreementDeal: authedProcedure
    .input(projectAgreementDealInputSchema.omit(actorOmitted))
    .output(projectAgreementDealOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      try {
        return await projectAgreementDeal({ repos: ctx.repos, clock: ctx.clock }, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  // ── The deal on any terms: a booking agreement, an event without a
  // booking, an org's default (FR-003). Same deal shapes as above.
  getTermsDeal: authedProcedure
    .input(getTermsDealInputSchema.omit(actorOmitted))
    .output(getTermsDealOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      try {
        return await getTermsDeal({ repos: ctx.repos }, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  setTermsDeal: authedProcedure
    .input(setTermsDealInputSchema.omit(actorOmitted))
    .output(setTermsDealOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      try {
        return await setTermsDeal(
          {
            repos: ctx.repos,
            clock: ctx.clock,
            logger: ctx.logger,
            // A frozen change notifies every payee (freeze-the-deal FR-006).
            ...dealChangeNoticeDeps(ctx),
          },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * The resale clause on a target, read on its own: `getTermsDeal` carries it
   * only once the target has a PRIMARY deal (organiser-resale-share C2).
   */
  getResaleClause: authedProcedure
    .input(getResaleClauseInputSchema.omit(actorOmitted))
    .output(getResaleClauseOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      try {
        return await getResaleClause({ repos: ctx.repos }, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * The resale clause (organiser-resale-share FR-001, FR-011) on a target's
   * RESALE terms. A separate write from the deal: a different terms row.
   */
  setResaleClause: authedProcedure
    .input(setResaleClauseInputSchema.omit(actorOmitted))
    .output(setResaleClauseOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      try {
        return await setResaleClause(
          {
            repos: ctx.repos,
            clock: ctx.clock,
            logger: ctx.logger,
            // A frozen change notifies every payee (freeze-the-deal FR-006).
            ...dealChangeNoticeDeps(ctx),
          },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  // ── Freezing the deal (freeze-the-deal FR-003, FR-007). Who may freeze
  // and who may read the changes is decided in the use cases.

  /** Freeze an event's deal; a no-op on a frozen one (FR-003). */
  freezeEventDeal: authedProcedure
    .input(freezeEventDealInputSchema.omit(actorOmitted))
    .output(freezeEventDealOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      try {
        return await freezeEventDeal(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** The event's frozen changes, newest first: deal editors and payees (FR-007). */
  listDealChanges: authedProcedure
    .input(listDealChangesInputSchema.omit(actorOmitted))
    .output(listDealChangesOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      try {
        return await listDealChanges({ repos: ctx.repos }, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  projectTermsDeal: authedProcedure
    .input(projectTermsDealInputSchema.omit(actorOmitted))
    .output(projectTermsDealOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      try {
        return await projectTermsDeal({ repos: ctx.repos, clock: ctx.clock }, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * The payee named on a clause settled directly answers it (EVENT terms
   * only; the use case decides who may answer).
   */
  confirmDealClause: authedProcedure
    .input(answerDealClauseInputSchema.omit(actorOmitted))
    .output(answerDealClauseOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      try {
        return await confirmDealClause(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  declineDealClause: authedProcedure
    .input(answerDealClauseInputSchema.omit(actorOmitted))
    .output(answerDealClauseOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      try {
        return await declineDealClause(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  // ── The event settlement sheet ────────────────────────────────────────
  getEventSettlement: authedProcedure
    .input(getEventSettlementInputSchema.omit(actorOmitted))
    .output(getEventSettlementOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      try {
        return await getEventSettlement(
          {
            repos: ctx.repos,
            clock: ctx.clock,
            // Typed-in rows the deal can no longer place are left out of the
            // sheet and reported (a degraded read, never a silent one).
            reportError: ctx.reportError ?? undefined,
          },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  exportEventSettlementCsv: authedProcedure
    .input(exportEventSettlementCsvInputSchema.omit(actorOmitted))
    .output(exportEventSettlementCsvOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      try {
        return await exportEventSettlementCsv(
          { repos: ctx.repos, clock: ctx.clock, reportError: ctx.reportError ?? undefined },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  upsertSheetOffPlatform: authedProcedure
    .input(upsertSheetOffPlatformInputSchema.omit(actorOmitted))
    .output(sheetWriteOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      try {
        return await upsertSheetOffPlatform(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  removeSheetOffPlatform: authedProcedure
    .input(removeSheetOffPlatformInputSchema.omit(actorOmitted))
    .output(sheetWriteOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      try {
        return await removeSheetOffPlatform(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  setSheetDeductionActual: authedProcedure
    .input(setSheetDeductionActualInputSchema.omit(actorOmitted))
    .output(sheetWriteOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      try {
        return await setSheetDeductionActual(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  clearSheetDeductionActual: authedProcedure
    .input(clearSheetDeductionActualInputSchema.omit(actorOmitted))
    .output(sheetWriteOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      try {
        return await clearSheetDeductionActual(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  addSheetDirectPayment: authedProcedure
    .input(addSheetDirectPaymentInputSchema.omit(actorOmitted))
    .output(sheetWriteOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      try {
        return await addSheetDirectPayment(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  removeSheetDirectPayment: authedProcedure
    .input(removeSheetDirectPaymentInputSchema.omit(actorOmitted))
    .output(sheetWriteOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      try {
        return await removeSheetDirectPayment(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Organiser only, after the show; no money moves (stage 1). */
  markEventSettled: authedProcedure
    .input(markEventSettledInputSchema.omit(actorOmitted))
    .output(markEventSettledOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      try {
        return await markEventSettled(
          {
            repos: ctx.repos,
            clock: ctx.clock,
            logger: ctx.logger,
            // B2: the frozen sheet's degraded branch reports, like the read.
            reportError: ctx.reportError ?? undefined,
          },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  reopenEventSettlement: authedProcedure
    .input(reopenEventSettlementInputSchema.omit(actorOmitted))
    .output(reopenEventSettlementOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      try {
        return await reopenEventSettlement(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};
