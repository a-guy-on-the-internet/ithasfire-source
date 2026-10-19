import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  ENTITY_REPORT_STATUSES,
  ENTITY_REPORT_SUBJECT_TYPES,
  listEntityReports,
  listEntityReportsOutputSchema,
  precheckSubmitEntityReport,
  reviewEntityReport,
  reviewEntityReportInputSchema,
  reviewEntityReportOutputSchema,
  submitEntityReport,
  submitEntityReportInputSchema,
  submitEntityReportOutputSchema,
} from "@th/core/use-cases/entity-reports";
import { getFeatureGates } from "@th/core/use-cases/features";
import { fail, isAppError } from "@th/errors";

import type { Ctx } from "../context";
import { hasFullEventReadAccessByEventId } from "../event-read-access";
import { authedProcedure, rateLimit } from "../init";
import { toTrpcError } from "../utils";

/**
 * arrival-areas FR-011 / FR-017: an ARRIVAL_AREA report is accepted only while
 * the `arrivalAreas` gate is on. Off, no one is shown an area, so the refusal
 * is the same ARRIVAL_AREA_NOT_FOUND an unseen area gets.
 */
async function ensureArrivalAreaReportsEnabled(ctx: Ctx): Promise<void> {
  const gates = await getFeatureGates({
    platformSettings: ctx.repos.platformSettings,
    reportError: ctx.reportError ?? undefined,
  });
  if (!gates.arrivalAreas) throw fail("ARRIVAL_AREA_NOT_FOUND");
}

/**
 * arrival-areas FR-011: has this reporter passed `seenOnEventId`'s password /
 * application gate? The unlock / grant cookies are only readable here, so the
 * transport answers and the use case receives it as `gateAccessGranted`. Same
 * decision as every public event read (`fullEventReadDenialByEventId`). An
 * event the reporter may not read at all (a draft, a missing id) answers as
 * the area not existing, so the report is no oracle for the event either.
 */
async function arrivalAreaGatePass(
  ctx: Ctx,
  seenOnEventId: string | undefined,
): Promise<boolean> {
  if (seenOnEventId === undefined) return false;
  try {
    return await hasFullEventReadAccessByEventId(ctx, seenOnEventId);
  } catch (err) {
    if (isAppError(err) && err.code === "EVENT_NOT_FOUND") {
      throw fail("ARRIVAL_AREA_NOT_FOUND");
    }
    throw err;
  }
}

// Reporter/reviewer identity always comes from ctx (never the client payload).
// `.omit` preserves `.strict()`, so a client-supplied `actorHumanId` (or the
// server-decided `gateAccessGranted`) is rejected with BAD_REQUEST
// (unrecognized_keys), not silently ignored.
const submitInput = submitEntityReportInputSchema.omit({
  actorHumanId: true,
  gateAccessGranted: true,
});
const reviewInput = reviewEntityReportInputSchema.omit({ actorHumanId: true });

// tRPC's useInfiniteQuery injects a top-level `direction` ("forward" |
// "backward") into every request input. Without allowing it, `.strict()`
// rejects the whole call with BAD_REQUEST (unrecognized_keys: ["direction"]) —
// which silently breaks every infinite-scroll consumer of this schema. Allowed
// here, stripped before the use case (same treatment as event-suggestions'
// cursorPageInput).
const infiniteDirection = z.enum(["forward", "backward"]).optional();

// Derived from `listEntityReportsInputSchema` minus `actorHumanId` (ctx-only)
// plus the tRPC-injected `direction`. Field schemas reuse core's exported
// enums/bounds so the two cannot drift apart on the values that matter.
const listForModerationInput = z
  .object({
    status: z.enum(ENTITY_REPORT_STATUSES).optional(),
    subjectType: z.enum(ENTITY_REPORT_SUBJECT_TYPES).optional(),
    cursor: z.string().min(1).nullable().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    direction: infiniteDirection,
  })
  .strict();

/**
 * Entity reports (entity-report-intake spec v1.1): the "Report" action on
 * venue / human / org listing pages, backed by the /platform/reports queue —
 * PLATFORM-level trust & safety, NOT community moderation (COMMUNITY_MODERATOR
 * has no access). Submission is authed-only (NFR-001 — no anonymous branch,
 * no IP retention); the staff authz for list/review lives INSIDE the use
 * cases (ADMIN/SUPPORT/DEVELOPER via `requirePlatformStaff`, same class as
 * `credits.grant`). The 2FA step-up for the two staff procedures is
 * path-allowlisted in guard.ts (`SECOND_FACTOR_GATED_MODERATION_PATHS` —
 * path-based because this namespace isn't under `platform.*`); the gated-role
 * set (`SECOND_FACTOR_GATED_ROLES`) covers ADMIN/SUPPORT/DEVELOPER, so every
 * permitted reviewer gets the step-up.
 */
export const entityReportsRouter = {
  /**
   * A signed-in visitor reports a PLACE / HUMAN / ORGANIZATION listing, or
   * an ARRIVAL_AREA they can see (behind the `arrivalAreas` gate; pass
   * `seenOnEventId` when it was seen on an event page).
   * Per-human transport cap (NFR-001) on top of the global default floor
   * (`defaultRateLimit` in guard.ts, keyed `default:<path>:<actor>` — the two
   * stack as distinct Redis buckets); the use case's (reporter, subject,
   * PENDING) dedupe caps repeat reports on one subject.
   *
   * Error serialization (verified against toTrpcError + the initTRPC
   * errorFormatter, trpc.ts:18-32): the field-level rejections
   * (`invalid_reason_for_subject` / `details_required`) are AppErrors whose
   * `meta` — including `meta.reason` and `meta.fields` — is stashed on the
   * TRPCError (utils.ts, AppError branch) and DOES reach the client as
   * `data.meta` alongside `data.appCode: "INVALID_INPUT"`, so the report
   * dialog can anchor server-side rejections at the offending input. The
   * dedupe error travels the legacy path (`report_already_open` →
   * errorCodeMap → CONFLICT) with the domain code as the error `message`.
   */
  submit: authedProcedure
    .input(submitInput)
    .use(
      rateLimit<z.infer<typeof submitInput>>({
        // Authed-only procedure — requireAuth has already run, so keying on
        // the actor is always possible; no anonymous/IP branch needed (unlike
        // eventSuggestions.submit).
        key: (ctx) => `report:h:${ctx.actorHumanId}`,
        maxRequests: 5,
        windowSeconds: 300,
        message: "submitting reports",
      }),
    )
    .output(submitEntityReportOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        // ARRIVAL_AREA only: the viewer checks behind "may this reporter see
        // the area" (listArrivalAreasForViewer).
        authz: ctx.authz,
        clock: ctx.clock,
        logger: ctx.logger,
        // Sentry hook for the post-commit notification swallow branches —
        // wired to `safeReporter(Sentry.captureException)` at the API
        // composition root (apps/api/src/lib/dep.ts, TrpcDeps.reportError).
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof submitEntityReport>[0];

      try {
        if (input.subjectType === "ARRIVAL_AREA") {
          await ensureArrivalAreaReportsEnabled(ctx);
          // Core's repo-free field checks before the gate read, on the input
          // parsed as the use case parses it: a malformed report never costs
          // that read, and gets the same answer whether or not
          // `seenOnEventId` is readable (the use case re-runs them).
          precheckSubmitEntityReport({ ...input, actorHumanId });
          const gateAccessGranted = await arrivalAreaGatePass(
            ctx,
            input.seenOnEventId,
          );
          return await submitEntityReport(deps, {
            ...input,
            actorHumanId,
            gateAccessGranted,
          });
        }
        return await submitEntityReport(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * The /platform/reports queue (+ PlatformShell badge via `pendingCount`).
   * Platform-staff authz (ADMIN/SUPPORT/DEVELOPER) runs inside the use case —
   * everyone else (including COMMUNITY_MODERATOR) gets STAFF_ONLY → FORBIDDEN
   * before any queue data (even its size) is read.
   */
  listForModeration: authedProcedure
    .input(listForModerationInput)
    .output(listEntityReportsOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        logger: ctx.logger,
        // Sentry hook for the subject-hydration swallow branch (degraded
        // null-name queue must still be Sentry-visible).
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof listEntityReports>[0];

      try {
        // `direction` deliberately not forwarded — transport-only key.
        return await listEntityReports(deps, {
          actorHumanId,
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.subjectType !== undefined
            ? { subjectType: input.subjectType }
            : {}),
          ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * RESOLVED / DISMISSED verdict + optional note. Staff authz + the
   * PENDING-status CAS (double-review guard) live inside the use case; the
   * loser of a concurrent review sees CONFLICT (`report_already_reviewed`),
   * a missing row NOT_FOUND (`entity_report_not_found`).
   */
  review: authedProcedure
    .input(reviewInput)
    .output(reviewEntityReportOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        clock: ctx.clock,
        logger: ctx.logger,
        // Same live Sentry hook as submit (reporter-notification swallows).
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof reviewEntityReport>[0];

      try {
        return await reviewEntityReport(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};
