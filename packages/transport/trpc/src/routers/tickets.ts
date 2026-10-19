import { TRPCError } from "@trpc/server";
import {
  revertTicketScan,
  revertTicketScanInputSchema,
} from "@th/core/use-cases/tickets/revert-ticket-scan";
import {
  scanTicket,
  scanTicketInputSchema,
  scanTicketOutputSchema,
} from "@th/core/use-cases/tickets/scan-ticket";
import {
  searchOrgTickets,
  searchOrgTicketsInputSchema,
  searchOrgTicketsOutputSchema,
} from "@th/core/use-cases/tickets/search-org-tickets";
import {
  transferTicket,
  transferTicketInputSchema,
  transferTicketOutputSchema,
} from "@th/core/use-cases/tickets/transfer-ticket";
import {
  initiateEmailTransfer,
  initiateEmailTransferInputSchema,
  initiateEmailTransferOutputSchema,
} from "@th/core/use-cases/tickets/initiate-email-transfer";
import {
  claimPendingTransfer,
  claimPendingTransferInputSchema,
  claimPendingTransferOutputSchema,
} from "@th/core/use-cases/tickets/claim-pending-transfer";
import {
  cancelPendingTransfer,
  cancelPendingTransferInputSchema,
  cancelPendingTransferOutputSchema,
} from "@th/core/use-cases/tickets/cancel-pending-transfer";
import {
  getPendingTransfers,
  getPendingTransfersInputSchema,
  getPendingTransfersOutputSchema,
} from "@th/core/use-cases/tickets/get-pending-transfers";

import { authedProcedure, verifiedEmailProcedure } from "../init";
import { toTrpcError } from "../utils";

const scanTicketInput = scanTicketInputSchema.omit({ actorHumanId: true });
const revertTicketScanInput = revertTicketScanInputSchema.omit({
  actorHumanId: true,
});
const searchOrgTicketsInput = searchOrgTicketsInputSchema.omit({
  actorHumanId: true,
});
const transferTicketInput = transferTicketInputSchema.omit({
  actorHumanId: true,
});
const initiateEmailTransferInput = initiateEmailTransferInputSchema.omit({
  actorHumanId: true,
});
const claimPendingTransferInput = claimPendingTransferInputSchema.omit({
  actorHumanId: true,
});
const cancelPendingTransferInput = cancelPendingTransferInputSchema.omit({
  actorHumanId: true,
});

export const ticketsRouter = {
  scanTicket: authedProcedure
    .input(scanTicketInput)
    .output(scanTicketOutputSchema)
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
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof scanTicket>[0];

      try {
        return await scanTicket(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  revertTicketScan: authedProcedure
    .input(revertTicketScanInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }
      try {
        return await revertTicketScan(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  searchOrgTickets: authedProcedure
    .input(searchOrgTicketsInput)
    .output(searchOrgTicketsOutputSchema)
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
      } satisfies Parameters<typeof searchOrgTickets>[0];

      try {
        return await searchOrgTickets(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  transferTicket: authedProcedure
    .input(transferTicketInput)
    .output(transferTicketOutputSchema)
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
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof transferTicket>[0];

      try {
        return await transferTicket(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  initiateEmailTransfer: authedProcedure
    .input(initiateEmailTransferInput)
    .output(initiateEmailTransferOutputSchema)
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
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof initiateEmailTransfer>[0];

      try {
        return await initiateEmailTransfer(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  claimPendingTransfer: authedProcedure
    .input(claimPendingTransferInput)
    .output(claimPendingTransferOutputSchema)
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
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof claimPendingTransfer>[0];

      try {
        return await claimPendingTransfer(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  cancelPendingTransfer: verifiedEmailProcedure
    .input(cancelPendingTransferInput)
    .output(cancelPendingTransferOutputSchema)
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
      } satisfies Parameters<typeof cancelPendingTransfer>[0];

      try {
        return await cancelPendingTransfer(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  getPendingTransfers: verifiedEmailProcedure
    .output(getPendingTransfersOutputSchema)
    .query(async ({ ctx }) => {
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
      } satisfies Parameters<typeof getPendingTransfers>[0];

      try {
        return await getPendingTransfers(deps, { actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};

export type TicketsRouter = typeof ticketsRouter;
