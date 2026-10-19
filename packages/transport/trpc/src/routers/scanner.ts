import { TRPCError } from "@trpc/server";
import {
  getScannerEventManifest,
  getScannerEventManifestInputSchema,
  getScannerSessionContext,
  getScannerSessionContextInputSchema,
  listScannerAccessibleEvents,
  listScannerAccessibleEventsInputSchema,
  recordScannerOperatorBootstrap,
  recordScannerOperatorBootstrapInputSchema,
  sendScannerOnboardingEmail,
  sendScannerOnboardingEmailInputObject,
  sendScannerOnboardingEmailRecipientRefinement,
  sendScannerOnboardingEmailRecipientRefinementMessage,
} from "@th/core/use-cases/scanner";

import { authedProcedure, rateLimit, router } from "../init";
import { toTrpcError } from "../utils";

// Use cases throw `{ code, message }`. `toTrpcError` already maps the standard
// codes (invalid_input, forbidden, not_found, conflict, not_configured, …) so
// we only need a thin wrapper here.
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toTrpcError(err);
  }
}

function requireActor(ctx: { actorHumanId: string | null }): string {
  if (!ctx.actorHumanId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Missing actor human id",
    });
  }
  return ctx.actorHumanId;
}

// Strip actorHumanId from inputs — it is injected from ctx so clients cannot
// impersonate another human.
const listAccessibleEventsInput = listScannerAccessibleEventsInputSchema.omit({
  actorHumanId: true,
});
const getSessionContextInput = getScannerSessionContextInputSchema.omit({
  actorHumanId: true,
});
const sendOnboardingEmailInput = sendScannerOnboardingEmailInputObject
  .omit({ actorHumanId: true })
  .refine(sendScannerOnboardingEmailRecipientRefinement, {
    message: sendScannerOnboardingEmailRecipientRefinementMessage,
  });
const getEventManifestInput = getScannerEventManifestInputSchema.omit({
  actorHumanId: true,
});
const recordBootstrapInput = recordScannerOperatorBootstrapInputSchema.omit({
  actorHumanId: true,
});

export const scannerRouter = {
  listAccessibleEvents: authedProcedure
    .input(listAccessibleEventsInput)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        listScannerAccessibleEvents(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            logger: ctx.logger,
            reportError: ctx.reportError ?? undefined,
          },
          { ...input, actorHumanId },
        ),
      );
    }),

  getSessionContext: authedProcedure
    .input(getSessionContextInput)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        getScannerSessionContext(
          { repos: ctx.repos, authz: ctx.authz, logger: ctx.logger },
          { ...input, actorHumanId },
        ),
      );
    }),

  sendOnboardingEmail: authedProcedure
    // `.input()` MUST come before `.use(rateLimit(...))` — middleware sees
    // `input: undefined` until the input parser runs, so reading
    // `input.orgId` against an unparsed input throws at runtime.
    .input(sendOnboardingEmailInput)
    .use(
      rateLimit<{ orgId: string }>({
        // 20 per (actor, org) per hour. Mailer-side per-(org,recipient,UTC-day)
        // idempotency caps duplicates; this caps fan-out across distinct
        // recipients so a compromised/abusive admin can't blast the
        // download-link email through Ithas Fire's branded sender.
        key: (ctx, input) =>
          `scanner:sendOnboardingEmail:${ctx.actorHumanId ?? "anon"}:${input.orgId}`,
        maxRequests: 20,
        windowSeconds: 60 * 60,
        message: "sending scanner onboarding emails",
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      if (!ctx.mailer) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "mailer_not_configured",
        });
      }
      return call(() =>
        sendScannerOnboardingEmail(
          {
            repos: ctx.repos,
            clock: ctx.clock,
            mailer: ctx.mailer!,
            iosAppUrl: ctx.scannerAppIosUrl ?? null,
            androidAppUrl: ctx.scannerAppAndroidUrl ?? null,
            logger: ctx.logger,
          },
          { ...input, actorHumanId },
        ),
      );
    }),

  getEventManifest: authedProcedure
    .input(getEventManifestInput)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        getScannerEventManifest(
          { repos: ctx.repos, authz: ctx.authz, logger: ctx.logger },
          { ...input, actorHumanId },
        ),
      );
    }),

  recordBootstrap: authedProcedure
    .input(recordBootstrapInput)
    // Every call writes an audit row. The app reports once per sign-in per
    // run, so 20/hour per actor is generous for real use and stops the audit
    // log being flooded at the 240/min floor (F16, 2026-09-29).
    .use(
      rateLimit({
        key: (ctx) => `scanner:recordBootstrap:${ctx.actorHumanId ?? "anon"}`,
        maxRequests: 20,
        windowSeconds: 60 * 60,
        message: "recording scanner bootstraps",
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        recordScannerOperatorBootstrap(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
          },
          { ...input, actorHumanId },
        ),
      );
    }),
};

export type ScannerRouter = typeof scannerRouter;

// Re-export so callers wiring the root router can do `router(scannerRouter)`
// without needing a separate import. Mirrors the volunteer router shape.
export const scannerRouterDef = router(scannerRouter);
