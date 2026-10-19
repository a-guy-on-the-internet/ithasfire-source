import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  sendAnnouncement,
  sendAnnouncementInputBaseSchema,
  sendAnnouncementOutputSchema,
  listAnnouncements,
  listAnnouncementsInputSchema,
  listAnnouncementsOutputSchema,
  previewAudienceCount,
  previewAudienceCountInputSchema,
  previewAudienceCountOutputSchema,
  sendTestAnnouncement,
  sendTestAnnouncementInputSchema,
  sendTestAnnouncementOutputSchema,
  unsubscribeFromAudience,
  unsubscribeFromAudienceInputSchema,
  unsubscribeFromAudienceOutputSchema,
  unsubscribeFromOrgAnnouncements,
  unsubscribeFromOrgAnnouncementsInputSchema,
  unsubscribeFromOrgAnnouncementsOutputSchema,
  unsubscribeReviewPrompts,
  unsubscribeReviewPromptsInputSchema,
  unsubscribeReviewPromptsOutputSchema,
} from "@th/core/use-cases/announcements";
import { authedProcedure, publicProcedure, rateLimit } from "../init";
import { toTrpcError } from "../utils";
import { postJobToJobsService } from "../jobs-service-request";

// ─────────────────────────────────────────────────────────────────────────────
// Rate limit configs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Max 5 full sends per actor + owner + audience combo in a 5-minute window.
 * Keyed on the actor too (security review F4): the owner id is caller-chosen,
 * so a key on it alone lets one caller exhaust — or dodge — another's budget.
 */
const announcementSendLimit = rateLimit<{
  ownerId: string;
  audienceType: string;
  audienceRef?: string;
}>({
  key: (ctx, input) =>
    `announce:send:${ctx.actorHumanId ?? "anon"}:${input.ownerId}:${input.audienceType}:${input.audienceRef ?? "all"}`,
  maxRequests: 5,
  windowSeconds: 300,
  message: "sending announcements to this audience",
});

/** Max 10 test sends per actor + owner in a 1-minute window. */
const announcementTestLimit = rateLimit<{ ownerId: string }>({
  key: (ctx, input) =>
    `announce:test:${ctx.actorHumanId ?? "anon"}:${input.ownerId}`,
  maxRequests: 10,
  windowSeconds: 60,
  message: "sending test announcements",
});

// ─────────────────────────────────────────────────────────────────────────────
// Input schemas (strip actorHumanId — injected from context)
// ─────────────────────────────────────────────────────────────────────────────

const sendInput = sendAnnouncementInputBaseSchema.omit({ actorHumanId: true });
const listInput = listAnnouncementsInputSchema.omit({ actorHumanId: true });
const previewCountInput = previewAudienceCountInputSchema.omit({
  actorHumanId: true,
});
const sendTestInput = sendTestAnnouncementInputSchema.omit({
  actorHumanId: true,
});

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

export const announcementsRouter = {
  // `.input()` MUST precede the input-keyed limiter: in tRPC v11 a middleware
  // sees `input: undefined` until the parser middleware has run, so the
  // limiter's `input.ownerId` threw on every call (2026-09-29 prod 500s).
  send: authedProcedure
    .input(sendInput)
    .use(announcementSendLimit)
    .output(sendAnnouncementOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      // Build optional enqueueNotifyJob when jobs service is configured
      let enqueueNotifyJob: Parameters<
        typeof sendAnnouncement
      >[0]["enqueueNotifyJob"];
      if (ctx.jobsServiceUrl) {
        const jobsBaseUrl = ctx.jobsServiceUrl;
        enqueueNotifyJob = async (payload) => {
          // API key header + Google OIDC token: a bare `Bearer <api key>`
          // never gets past Cloud Run IAM (see jobs-service-request.ts).
          const res = await postJobToJobsService(
            jobsBaseUrl,
            "announcements.dispatch-notifications",
            payload,
          );
          if (!res.ok) {
            const body = await res.text().catch(() => "");
            throw new Error(
              `Failed to enqueue notify job: ${res.status} ${body}`,
            );
          }
        };
      }

      const deps = {
        repos: ctx.repos,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: ctx.logger,
        mailer: ctx.mailer ?? undefined,
        publicAppUrl: ctx.publicAppUrl ?? undefined,
        unsubscribeSecret: ctx.unsubscribeSecret ?? undefined,
        senderPhysicalAddress: ctx.senderPhysicalAddress ?? undefined,
        // Drives the CAN-SPAM fail-closed guard: in production the use case
        // refuses to dispatch announcement email without a working opt-out.
        isProduction: ctx.isProduction ?? false,
        reportError: ctx.reportError ?? undefined,
        notify: ctx.notify,
        enqueueNotifyJob,
      } satisfies Parameters<typeof sendAnnouncement>[0];

      try {
        return await sendAnnouncement(deps, { ...input, actorHumanId });
      } catch (error) {
        throw toTrpcError(error);
      }
    }),

  list: authedProcedure
    .input(listInput)
    .output(listAnnouncementsOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
      } satisfies Parameters<typeof listAnnouncements>[0];

      try {
        return await listAnnouncements(deps, { ...input, actorHumanId });
      } catch (error) {
        throw toTrpcError(error);
      }
    }),

  previewAudienceCount: authedProcedure
    .input(previewCountInput)
    .output(previewAudienceCountOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
      } satisfies Parameters<typeof previewAudienceCount>[0];

      try {
        return await previewAudienceCount(deps, { ...input, actorHumanId });
      } catch (error) {
        throw toTrpcError(error);
      }
    }),

  // Parse before the input-keyed limiter — see `send` above.
  sendTest: authedProcedure
    .input(sendTestInput)
    .use(announcementTestLimit)
    .output(sendTestAnnouncementOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        mailer: ctx.mailer ?? undefined,
      } satisfies Parameters<typeof sendTestAnnouncement>[0];

      try {
        return await sendTestAnnouncement(deps, { ...input, actorHumanId });
      } catch (error) {
        throw toTrpcError(error);
      }
    }),

  unsubscribe: publicProcedure
    .input(unsubscribeFromAudienceInputSchema)
    .output(unsubscribeFromAudienceOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const secret = ctx.unsubscribeSecret;
      if (!secret) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Unsubscribe is not configured",
        });
      }

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        unsubscribeSecret: secret,
      } satisfies Parameters<typeof unsubscribeFromAudience>[0];

      try {
        return await unsubscribeFromAudience(deps, input);
      } catch (error) {
        throw toTrpcError(error);
      }
    }),

  unsubscribeOrg: publicProcedure
    .input(unsubscribeFromOrgAnnouncementsInputSchema)
    .output(unsubscribeFromOrgAnnouncementsOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const secret = ctx.unsubscribeSecret;
      if (!secret) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Unsubscribe is not configured",
        });
      }

      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
        unsubscribeSecret: secret,
      } satisfies Parameters<typeof unsubscribeFromOrgAnnouncements>[0];

      try {
        return await unsubscribeFromOrgAnnouncements(deps, input);
      } catch (error) {
        throw toTrpcError(error);
      }
    }),

  // attendee-prompt-delivery-hygiene FR-006: one-click, token-gated opt-out
  // from the weekly attendee review-prompt EMAIL digest. Flips only the
  // ATTENDEE_FEEDBACK subscription; no login, no other prefs touched.
  unsubscribeReviewPrompts: publicProcedure
    .input(unsubscribeReviewPromptsInputSchema)
    .output(unsubscribeReviewPromptsOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const secret = ctx.unsubscribeSecret;
      if (!secret) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Unsubscribe is not configured",
        });
      }

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        unsubscribeSecret: secret,
      } satisfies Parameters<typeof unsubscribeReviewPrompts>[0];

      try {
        return await unsubscribeReviewPrompts(deps, input);
      } catch (error) {
        throw toTrpcError(error);
      }
    }),
};
