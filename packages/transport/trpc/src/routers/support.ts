import { TRPCError } from "@trpc/server";
import {
  sendSupportMessage,
  sendSupportMessageInputSchema,
  sendSupportMessageOutputSchema,
  getSupportMessages,
  getSupportMessagesInputSchema,
  getSupportMessagesOutputSchema,
  listSupportThreads,
  listSupportThreadsInputSchema,
  listSupportThreadsOutputSchema,
  replyToSupportThread,
  replyToSupportThreadInputSchema,
  replyToSupportThreadOutputSchema,
  setSupportThreadStatus,
  setSupportThreadStatusInputSchema,
  setSupportThreadStatusOutputSchema,
  getMyActiveThread,
  getMyActiveThreadInputSchema,
  getMyActiveThreadOutputSchema,
  markThreadRead,
  markThreadReadInputSchema,
  markThreadReadOutputSchema,
} from "@th/core/use-cases/support";

import { authedProcedure } from "../init";
import { rateLimit } from "../guard";
import { toTrpcError } from "../utils";
import type { Ctx } from "../context";

/**
 * Fallback support rate-limit tiers when `ctx.supportRateLimits` is unset
 * (tests / unconfigured deps). Production values come from env via TrpcDeps.
 */
const SUPPORT_RATE_LIMIT_DEFAULTS = {
  sendBurstMax: 5,
  sendBurstWindowS: 10,
  sendSustainedMax: 30,
  sendSustainedWindowS: 300,
  replyMax: 60,
  replyWindowS: 60,
} as const;

const limitsFor = (ctx: Ctx) =>
  ctx.supportRateLimits ?? SUPPORT_RATE_LIMIT_DEFAULTS;

/**
 * Per-actor cap on support thread status changes (Redis fixed-window). This
 * tier is NOT env-threaded — it's a fixed backstop against status-flip /
 * audit-row flooding, deliberately generous so the owner's legit "talk to a
 * human" escalation button never trips it.
 */
const SUPPORT_SET_STATUS_MAX = 30;
const SUPPORT_SET_STATUS_WINDOW_S = 60;

// Inputs drop actorHumanId — it is injected from the authenticated session so
// the client can never spoof who a thread/message belongs to.
const sendMessageInput = sendSupportMessageInputSchema.omit({
  actorHumanId: true,
});
const getMessagesInput = getSupportMessagesInputSchema.omit({
  actorHumanId: true,
});
const listThreadsInput = listSupportThreadsInputSchema.omit({
  actorHumanId: true,
});
const replyToThreadInput = replyToSupportThreadInputSchema.omit({
  actorHumanId: true,
});
const setThreadStatusInput = setSupportThreadStatusInputSchema.omit({
  actorHumanId: true,
});
const getMyActiveThreadInput = getMyActiveThreadInputSchema.omit({
  actorHumanId: true,
});
const markThreadReadInput = markThreadReadInputSchema.omit({
  actorHumanId: true,
});

function requireActor(actorHumanId: string | null | undefined): string {
  if (!actorHumanId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Missing actor human id",
    });
  }
  return actorHumanId;
}

export const supportRouter = {
  /**
   * Send a message to the caller's support thread (creating one if none).
   * Sign-in only. Rate-limited per human so a single account can't flood the
   * Discord channel / DB (NFR-002).
   *
   * Two-tier limiter (both must pass, burst checked first): a tight burst
   * window stops rapid-fire flooding, while a wider sustained window caps total
   * volume. The two windows are independent Redis keys — passing the burst
   * window does not bypass the sustained cap. Limits come from
   * `ctx.supportRateLimits` (env-threaded) with built-in defaults as fallback.
   */
  sendMessage: authedProcedure
    // authedProcedure guarantees actorHumanId is present (the mutation also
    // re-asserts via requireActor), so no anonymous fallback. Keyed on
    // actorHumanId only — these are authenticated endpoints, so the human id is
    // the stronger, non-spoofable dimension; an IP key isn't added here (mirrors
    // the pre-existing limiter).
    .use(
      rateLimit({
        key: (ctx) => `support:sendMessage:burst:${ctx.actorHumanId}`,
        maxRequests: (ctx) => limitsFor(ctx).sendBurstMax,
        windowSeconds: (ctx) => limitsFor(ctx).sendBurstWindowS,
        message: "sending support messages",
      }),
    )
    .use(
      rateLimit({
        key: (ctx) => `support:sendMessage:sustained:${ctx.actorHumanId}`,
        maxRequests: (ctx) => limitsFor(ctx).sendSustainedMax,
        windowSeconds: (ctx) => limitsFor(ctx).sendSustainedWindowS,
        message: "sending support messages",
      }),
    )
    .input(sendMessageInput)
    .output(sendSupportMessageOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        notifySupport: ctx.notifySupport ?? undefined,
      } satisfies Parameters<typeof sendSupportMessage>[0];

      try {
        return await sendSupportMessage(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Poll target: read messages + thread status for a thread the caller owns
   * (or any thread when the caller is platform support staff).
   */
  getMessages: authedProcedure
    .input(getMessagesInput)
    .output(getSupportMessagesOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        logger: ctx.logger,
      } satisfies Parameters<typeof getSupportMessages>[0];

      try {
        return await getSupportMessages(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Authoritative way for the widget to discover its thread: the caller's
   * current active (OPEN / AWAITING_HUMAN) thread, or null. Replaces relying on
   * a localStorage-persisted threadId (which could be stale or foreign).
   */
  getMyActiveThread: authedProcedure
    .input(getMyActiveThreadInput)
    .output(getMyActiveThreadOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);

      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
      } satisfies Parameters<typeof getMyActiveThread>[0];

      try {
        return await getMyActiveThread(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Owner marks the counterparty's messages (HUMAN_AGENT / AI_CLERK / SYSTEM)
   * in their own thread as read — clears the widget's unread badge. Owner-only;
   * idempotent.
   *
   * Deliberately left unlimited: the widget auto-marks on open, and the op is
   * idempotent + owner-scoped, so it is not an abuse vector worth a limiter.
   */
  markThreadRead: authedProcedure
    .input(markThreadReadInput)
    .output(markThreadReadOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof markThreadRead>[0];

      try {
        return await markThreadRead(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Operator inbox: paginated thread list (awaiting-human first). Staff only;
   * the use case enforces the platform support role.
   */
  listThreads: authedProcedure
    .input(listThreadsInput)
    .output(listSupportThreadsOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        logger: ctx.logger,
      } satisfies Parameters<typeof listSupportThreads>[0];

      try {
        return await listSupportThreads(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Operator posts a HUMAN_AGENT reply to a thread. Staff only. Rate-limited
   * with a generous per-staff cap as a backstop against a runaway / scripted
   * client; normal operator usage stays well under it.
   */
  replyToThread: authedProcedure
    // Keyed on actorHumanId only — authenticated staff endpoint, so the human id
    // is the stronger, non-spoofable dimension; no IP key (mirrors sendMessage).
    .use(
      rateLimit({
        key: (ctx) => `support:replyToThread:${ctx.actorHumanId}`,
        maxRequests: (ctx) => limitsFor(ctx).replyMax,
        windowSeconds: (ctx) => limitsFor(ctx).replyWindowS,
        message: "posting support replies",
      }),
    )
    .input(replyToThreadInput)
    .output(replyToSupportThreadOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof replyToSupportThread>[0];

      try {
        return await replyToSupportThread(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Move a thread OPEN / AWAITING_HUMAN / RESOLVED. Staff may set any status;
   * the thread owner may escalate their own thread to AWAITING_HUMAN.
   * AWAITING_HUMAN fires a best-effort support alert.
   *
   * Rate-limited per actor as a backstop against status-flip / audit-row
   * flooding (each transition writes an audit row and AWAITING_HUMAN fires a
   * support alert). The cap is generous so the owner's legit "talk to a human"
   * escalation button never trips it. Keyed on actorHumanId only — authenticated
   * endpoint, so the human id is the stronger, non-spoofable dimension (mirrors
   * sendMessage / replyToThread).
   */
  setThreadStatus: authedProcedure
    .use(
      rateLimit({
        key: (ctx) => `support:setStatus:${ctx.actorHumanId}`,
        maxRequests: SUPPORT_SET_STATUS_MAX,
        windowSeconds: SUPPORT_SET_STATUS_WINDOW_S,
        message: "changing support thread status",
      }),
    )
    .input(setThreadStatusInput)
    .output(setSupportThreadStatusOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        clock: ctx.clock,
        logger: ctx.logger,
        notifySupport: ctx.notifySupport ?? undefined,
      } satisfies Parameters<typeof setSupportThreadStatus>[0];

      try {
        return await setSupportThreadStatus(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};

export type SupportRouter = typeof supportRouter;
