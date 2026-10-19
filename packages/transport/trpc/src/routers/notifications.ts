import { z } from "zod";
import type { ReporterPort } from "@th/ports/reporter";
import { createThrottledReporter } from "@th/core/lib/throttled-reporter";
import {
  listNotifications,
  listNotificationsInputSchema,
  registerPushDevice,
  registerPushDeviceInputSchema,
  registerPushDeviceOutputSchema,
  unregisterPushDevice,
  unregisterPushDeviceInputSchema,
  unregisterPushDeviceOutputSchema,
} from "@th/core/use-cases/comms";
import { authedProcedure, rateLimit } from "../init";
import { toTrpcError } from "../utils";

// Actor comes from the authenticated session — never from client input.
const registerPushDeviceInput = registerPushDeviceInputSchema.omit({
  actorHumanId: true,
});
const unregisterPushDeviceInput = unregisterPushDeviceInputSchema.omit({
  actorHumanId: true,
});

// The reader comes from the authenticated session — never from client input.
// `direction` is injected by tRPC's useInfiniteQuery; the strict core schema
// would reject it (BAD_REQUEST), so it is accepted here and dropped below.
const listInput = listNotificationsInputSchema
  .omit({ humanId: true })
  .extend({ direction: z.enum(["forward", "backward"]).optional() });

/**
 * The inbox polls `list` every 30s, so a variant whose stored payloads stop
 * parsing would otherwise send one Sentry event per open Spanish inbox per
 * poll. The use case reports once per (templateKey, locale) per call; this
 * window spans calls. Memoized per `ctx.reportError` identity (the same
 * pattern as `getThrottledRateLimitReporter` in guard.ts): `ctx` is built
 * per request, so a fresh wrapper per call would never throttle.
 */
const NOTIFICATION_RENDER_REPORT_THROTTLE_MS = 15 * 60 * 1000;
const renderThrottledReporters = new WeakMap<ReporterPort, ReporterPort>();

function getThrottledRenderReporter(
  reportError: ReporterPort | null | undefined,
): ReporterPort | undefined {
  if (!reportError) return undefined;
  let throttled = renderThrottledReporters.get(reportError);
  if (!throttled) {
    throttled = createThrottledReporter(
      reportError,
      NOTIFICATION_RENDER_REPORT_THROTTLE_MS,
    );
    renderThrottledReporters.set(reportError, throttled);
  }
  return throttled;
}

const markReadInput = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
});

export const notificationsRouter = {
  // Each row's text in the reader's language; the stored template is
  // stripped inside the use case (see NotificationListItem).
  list: authedProcedure.input(listInput).query(async ({ ctx, input }) => {
    const { direction: _direction, ...rest } = input;
    try {
      return await listNotifications(
        {
          repos: ctx.repos,
          reportError: getThrottledRenderReporter(ctx.reportError),
        },
        { ...rest, humanId: ctx.actorHumanId! },
      );
    } catch (error) {
      throw toTrpcError(error);
    }
  }),

  countUnread: authedProcedure.query(async ({ ctx }) => {
    const repo = ctx.repos.notifications;
    if (!repo) return { count: 0 };
    const count = await repo.countUnread(ctx.actorHumanId!);
    return { count };
  }),

  markRead: authedProcedure
    .input(markReadInput)
    .mutation(async ({ ctx, input }) => {
      const repo = ctx.repos.notifications;
      if (!repo) return { count: 0 };
      return repo.markRead(input.ids, ctx.actorHumanId!);
    }),

  markAllRead: authedProcedure.mutation(async ({ ctx }) => {
    const repo = ctx.repos.notifications;
    if (!repo) return { count: 0 };
    return repo.markAllRead(ctx.actorHumanId!);
  }),

  // ── Push device registration (mobile clients) ─────────────────────────
  // Actor-scoped: a human can only register/unregister devices for
  // themselves — the use-case input takes the actor from the session.

  registerPushDevice: authedProcedure
    .input(registerPushDeviceInput)
    // Registration is a once-per-app-launch call in legitimate clients; a
    // tight per-actor window blunts scripted fake-token churn (the adapter's
    // per-human active-device cap bounds what slips through anyway).
    .use(
      rateLimit({
        key: (ctx) => `push:register:${ctx.actorHumanId}`,
        maxRequests: 10,
        windowSeconds: 60,
        message: "registering push devices",
      }),
    )
    .output(registerPushDeviceOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await registerPushDevice(
          { push: ctx.push, logger: ctx.logger },
          { ...input, actorHumanId: ctx.actorHumanId! },
        );
      } catch (error) {
        throw toTrpcError(error);
      }
    }),

  unregisterPushDevice: authedProcedure
    .input(unregisterPushDeviceInput)
    .output(unregisterPushDeviceOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await unregisterPushDevice(
          { push: ctx.push, logger: ctx.logger },
          { ...input, actorHumanId: ctx.actorHumanId! },
        );
      } catch (error) {
        throw toTrpcError(error);
      }
    }),
};
