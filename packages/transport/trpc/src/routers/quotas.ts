import {
  getEffectiveQuota,
  getEffectiveQuotaInputSchema,
  getEffectiveQuotaOutputSchema,
  requestQuotaExpansion,
  requestQuotaExpansionInputSchema,
  requestQuotaExpansionOutputSchema,
  listExpansionRequests,
  listExpansionRequestsInputSchema,
  listExpansionRequestsOutputSchema,
  reviewExpansionRequest,
  reviewExpansionRequestInputSchema,
  reviewExpansionRequestOutputSchema,
  listDefaultResourceLimits,
  listDefaultResourceLimitsInputSchema,
  listDefaultResourceLimitsOutputSchema,
  updateDefaultResourceLimit,
  updateDefaultResourceLimitInputSchema,
  updateDefaultResourceLimitOutputSchema,
} from "@th/core/use-cases/quotas";

import { authedProcedure } from "../init";
import { toTrpcError } from "../utils";

export const quotasRouter = {
  // ── User-facing endpoints ─────────────────────────────────────────────────

  /** Get the effective quota for a subject+kind. */
  getEffectiveQuota: authedProcedure
    .input(getEffectiveQuotaInputSchema.omit({ actorHumanId: true }))
    .output(getEffectiveQuotaOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await getEffectiveQuota(
          { repos: ctx.repos },
          { ...input, actorHumanId: ctx.actorHumanId! },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Request an increase to a resource quota. */
  requestExpansion: authedProcedure
    .input(requestQuotaExpansionInputSchema.omit({ actorHumanId: true }))
    .output(requestQuotaExpansionOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await requestQuotaExpansion(
          { repos: ctx.repos },
          { ...input, actorHumanId: ctx.actorHumanId! },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  // ── Platform admin endpoints ──────────────────────────────────────────────

  /** List expansion requests (platform staff). */
  listExpansionRequests: authedProcedure
    .input(listExpansionRequestsInputSchema.omit({ actorHumanId: true }))
    .output(listExpansionRequestsOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await listExpansionRequests(
          { repos: ctx.repos, authz: ctx.authz },
          { ...input, actorHumanId: ctx.actorHumanId! },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Approve or reject an expansion request (platform admin). */
  reviewExpansionRequest: authedProcedure
    .input(reviewExpansionRequestInputSchema.omit({ actorHumanId: true }))
    .output(reviewExpansionRequestOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await reviewExpansionRequest(
          { repos: ctx.repos, authz: ctx.authz },
          { ...input, actorHumanId: ctx.actorHumanId! },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** List platform-wide default resource limits (platform staff). */
  listDefaultLimits: authedProcedure
    .input(listDefaultResourceLimitsInputSchema.omit({ actorHumanId: true }))
    .output(listDefaultResourceLimitsOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await listDefaultResourceLimits(
          { repos: ctx.repos, authz: ctx.authz },
          { ...input, actorHumanId: ctx.actorHumanId! },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Update a platform-wide default resource limit (platform admin). */
  updateDefaultLimit: authedProcedure
    .input(updateDefaultResourceLimitInputSchema.omit({ actorHumanId: true }))
    .output(updateDefaultResourceLimitOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await updateDefaultResourceLimit(
          { repos: ctx.repos, authz: ctx.authz },
          { ...input, actorHumanId: ctx.actorHumanId! },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};
