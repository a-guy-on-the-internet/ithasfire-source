import { TRPCError } from "@trpc/server";

import {
  createClaim,
  createClaimInputSchema,
  createClaimOutputSchema,
  respondToClaim,
  respondToClaimInputSchema,
  respondToClaimOutputSchema,
  reviewClaim,
  reviewClaimInputSchema,
  reviewClaimOutputSchema,
  listClaims,
  listClaimsInputSchema,
  listClaimsOutputSchema,
  listMyClaims,
  listMyClaimsOutputSchema,
  getClaim,
  getClaimInputSchema,
  getClaimOutputSchema,
} from "@th/core/use-cases/resale";

import { authedProcedure, verifiedEmailProcedure } from "../init";
import { toTrpcError } from "../utils";

// ── Omit actorHumanId for authed procedures ────────────────────────────────
// The actor ALWAYS comes from the session (`ctx.actorHumanId`); no procedure
// here accepts a client-supplied one. Authorization lives inside the use
// cases (`claim-desk-staff.ts`): this router is mounted at the root, NOT under
// `platform.*`, so it inherits no staff or second-factor gate.
const createInput = createClaimInputSchema.omit({ actorHumanId: true });
const respondInput = respondToClaimInputSchema.omit({ actorHumanId: true });
const reviewInput = reviewClaimInputSchema.omit({ actorHumanId: true });
const listInput = listClaimsInputSchema.omit({ actorHumanId: true });
const listMyInput = listInput.omit({
  respondentId: true,
  claimantId: true,
  eventId: true,
  orderId: true,
});
const getInput = getClaimInputSchema.omit({ actorHumanId: true });

export const claimsRouter = {
  // ── Buyer: file a claim ────────────────────────────────────────────────

  create: verifiedEmailProcedure
    .input(createInput)
    .output(createClaimOutputSchema)
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
        mailer: ctx.mailer ?? undefined,
        publicAppUrl: ctx.publicAppUrl ?? undefined,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof createClaim>[0];

      try {
        return await createClaim(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  // ── Seller: respond to a claim ─────────────────────────────────────────

  respond: verifiedEmailProcedure
    .input(respondInput)
    .output(respondToClaimOutputSchema)
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
      } satisfies Parameters<typeof respondToClaim>[0];

      try {
        return await respondToClaim(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  // ── Support: review / resolve a claim ──────────────────────────────────

  review: authedProcedure
    .input(reviewInput)
    .output(reviewClaimOutputSchema)
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
        payments: ctx.payments,
        mailer: ctx.mailer ?? undefined,
        publicAppUrl: ctx.publicAppUrl ?? undefined,
        logger: ctx.logger,
        // Refund-debit swallows must reach Sentry (Step C review, BLOCKING).
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof reviewClaim>[0];

      try {
        return await reviewClaim(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  // ── Queries ────────────────────────────────────────────────────────────

  /**
   * Platform-wide (no filter) → claim-desk staff only; `eventId` → staff or
   * the event owner's edit/finance roles (the org admin's Claims tab);
   * `claimantId` / `respondentId` → that human or staff. Decided in the use
   * case; a refused call returns FORBIDDEN before any claim row is read.
   */
  list: verifiedEmailProcedure
    .input(listInput)
    .output(listClaimsOutputSchema)
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
      } satisfies Parameters<typeof listClaims>[0];

      try {
        return await listClaims(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Convenience endpoint: lists claims where the authed user is the seller (respondent). */
  listMy: verifiedEmailProcedure
    .input(listMyInput)
    .output(listMyClaimsOutputSchema)
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
      } satisfies Parameters<typeof listMyClaims>[0];

      try {
        // Self-scoped (the respondent IS the actor) and the respondent view:
        // no buyer identity or raw evidence in the seller's list.
        return await listMyClaims(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Buyer, seller, or claim-desk staff. Anyone else sees NOT_FOUND. */
  get: verifiedEmailProcedure
    .input(getInput)
    .output(getClaimOutputSchema)
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
      } satisfies Parameters<typeof getClaim>[0];

      try {
        return await getClaim(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};

export type ClaimsRouter = typeof claimsRouter;
