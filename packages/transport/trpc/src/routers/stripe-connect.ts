import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  initiateOnboarding,
  initiateOnboardingOrgInputSchema,
  initiateOnboardingHumanInputSchema,
  initiateOnboardingOutputSchema,
  getConnectStatus,
  getConnectStatusOrgInputSchema,
  getConnectStatusHumanInputSchema,
  getConnectStatusOutputSchema,
  createConnectLoginLink,
  createConnectLoginLinkOrgInputSchema,
  createConnectLoginLinkHumanInputSchema,
  createConnectLoginLinkOutputSchema,
} from "@th/core/use-cases/stripe-connect";

import { authedProcedure } from "../init";
import { toTrpcError } from "../utils";

const initiateOnboardingInput = z.union([
  initiateOnboardingOrgInputSchema.omit({ actorHumanId: true }),
  initiateOnboardingHumanInputSchema.omit({ actorHumanId: true }),
  z
    .object({
      // Same-origin URL or root-relative path; checked in the use case.
      returnUrl: z.string().min(1).max(2_000),
      refreshUrl: z.string().min(1).max(2_000),
    })
    .strict(),
]);

const getConnectStatusInput = z
  .union([
    getConnectStatusOrgInputSchema.omit({ actorHumanId: true }),
    getConnectStatusHumanInputSchema.omit({ actorHumanId: true }),
    z.object({}).strict(),
  ])
  .default({});

const createLoginLinkInput = z
  .union([
    createConnectLoginLinkOrgInputSchema.omit({ actorHumanId: true }),
    createConnectLoginLinkHumanInputSchema.omit({ actorHumanId: true }),
    z.object({}).strict(),
  ])
  .default({});

function withActorHumanOwnerDefault(
  input: Record<string, unknown>,
  actorHumanId: string,
): Record<string, unknown> {
  if (
    Object.prototype.hasOwnProperty.call(input, "orgId") ||
    Object.prototype.hasOwnProperty.call(input, "humanId")
  ) {
    return { ...input, actorHumanId };
  }

  return { ...input, actorHumanId, humanId: actorHumanId };
}

export const stripeConnectRouter = {
  initiateOnboarding: authedProcedure
    .input(initiateOnboardingInput)
    .output(initiateOnboardingOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Missing actor human id",
        });
      }

      try {
        return await initiateOnboarding(
          {
            repos: ctx.repos,
            payments: ctx.payments,
            idempotency: ctx.idempotency,
            logger: ctx.logger,
            reportError: ctx.reportError ?? null,
            publicAppUrl: ctx.publicAppUrl,
          },
          withActorHumanOwnerDefault(input, actorHumanId),
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  getStatus: authedProcedure
    .input(getConnectStatusInput)
    .output(getConnectStatusOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Missing actor human id",
        });
      }

      try {
        return await getConnectStatus(
          {
            repos: ctx.repos,
            payments: ctx.payments,
            logger: ctx.logger,
            clock: ctx.clock,
            // This read self-heals the `Payee` row from live Stripe, so it
            // needs the reporter (deliberate swallow) and the dev capability
            // override (so a live read can't flip seeded accounts to PENDING).
            reportError: ctx.reportError ?? undefined,
            forceConnectCapabilities: ctx.forceConnectCapabilities === true,
          },
          withActorHumanOwnerDefault(input, actorHumanId),
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  createLoginLink: authedProcedure
    .input(createLoginLinkInput)
    .output(createConnectLoginLinkOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Missing actor human id",
        });
      }

      try {
        return await createConnectLoginLink(
          {
            repos: ctx.repos,
            payments: ctx.payments,
            logger: ctx.logger,
          },
          withActorHumanOwnerDefault(input, actorHumanId),
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};
