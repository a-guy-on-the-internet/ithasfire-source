import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  getModerationAlertState,
  getModerationAlertStateInputSchema,
  getModerationAlertStateOutputSchema,
  getModerationQueueBreakdown,
  getModerationQueueBreakdownInputSchema,
  getModerationQueueBreakdownOutputSchema,
  getModerationSeverityHistogram,
  getModerationSeverityHistogramInputSchema,
  getModerationSeverityHistogramOutputSchema,
  getModerationQueueSnapshot,
  getModerationQueueSnapshotInputSchema,
  getModerationQueueSnapshotOutputSchema,
  listModerationQueueSignal,
  listModerationQueueSignalInputSchema,
  listModerationQueueSignalOutputSchema,
  lookupModerationRecord,
  lookupModerationRecordInputSchema,
  lookupModerationRecordOutputSchema,
  rescanImage,
  rescanImageInputSchema,
  rescanImageOutputSchema,
  resolveUnscannableImage,
  resolveUnscannableImageInputSchema,
  resolveUnscannableImageOutputSchema,
  reviewFlaggedImage,
  reviewFlaggedImageInputSchema,
  reviewFlaggedImageOutputSchema,
} from "@th/core/use-cases/moderation";
import { COMMUNITY_MODERATION_ROLES } from "@th/core/use-cases/community";
import type { HumanRole } from "@th/ports/authz";
import type { ImageModerationRecord } from "@th/ports/repos/image-moderation-records";

import type { Ctx } from "../context";
import { authedProcedure } from "../init";
import { toTrpcError } from "../utils";

/**
 * The queue-health snapshot + drill-down are a PLATFORM OPS surface, not a
 * moderation surface: they answer "is the pipeline running", not "should this
 * image stay up". So they gate on ADMIN/DEVELOPER rather than
 * `COMMUNITY_MODERATION_ROLES` — a community moderator has no business reading
 * provider-failure telemetry, and (the other direction) a DEVELOPER on call at
 * 3am should not need the moderator role to see that the drain is dead.
 *
 * Consequence, and the reason the drill-down DTO withholds both the image URL
 * and (for `awaitingReview` alone) the storage key: this gate admits
 * DEVELOPERs who are not moderators, and one of the five buckets
 * (`awaitingReview`) is un-reviewed flagged CONTENT.
 */
const PLATFORM_OPS_ROLES: HumanRole[] = ["ADMIN", "DEVELOPER"];

/**
 * The WRITE gate for this surface: ADMIN only, deliberately NARROWER than
 * `PLATFORM_OPS_ROLES`.
 *
 * Reading provider telemetry at 3am and mutating moderation state are not the
 * same privilege. `resolveUnscannable` terminally hides a record and
 * `rescanImage` discards a machine verdict and re-queues an object; both are
 * decisions with a blast radius, both write an audit row naming the actor, and
 * neither is something an on-call DEVELOPER needs in order to diagnose a dead
 * drain. A single ops role list covering both would have been the convenient
 * shape and the wrong one — the roles differ because the questions differ.
 */
const PLATFORM_OPS_WRITE_ROLES: HumanRole[] = ["ADMIN"];

/**
 * Both ops mutations strip `actorHumanId` from the client payload for the same
 * reason `reviewInput` does: the actor always comes from ctx, and the use case
 * re-parses the full strict schema after the handler re-adds it. `.omit()`
 * preserves `.strict()`.
 */
const resolveUnscannableInput = resolveUnscannableImageInputSchema.omit({
  actorHumanId: true,
});
const rescanImageInput = rescanImageInputSchema.omit({ actorHumanId: true });

// The moderator's identity always comes from ctx (never the client payload),
// so strip `actorHumanId` from the review surface. `reviewFlaggedImageInputSchema`
// is `.strict()` and Zod's `.omit()` preserves that strictness — the handler
// re-adds the ctx actor and the use case re-parses the full strict schema.
const reviewInput = reviewFlaggedImageInputSchema.omit({ actorHumanId: true });

// ─────────────────────────────────────────────────────────────────────────────
// Flagged-queue DTO (what /moderate/images renders — FR-008)
// ─────────────────────────────────────────────────────────────────────────────

const flaggedImageDtoSchema = z
  .object({
    recordId: z.string(),
    publicUrl: z.string().nullable(),
    kind: z.enum(["EVENT_HERO", "AVATAR", "BANNER", "PAGE_MEDIA"]),
    subjectType: z.enum(["EVENT", "HUMAN", "ORGANIZATION", "PLACE"]).nullable(),
    subjectId: z.string().nullable(),
    maxSeverity: z.number().nullable(),
    categories: z
      .array(
        z.object({
          category: z.enum(["SEXUAL", "VIOLENCE", "HATE", "SELF_HARM"]),
          severity: z.number(),
        }),
      )
      .nullable(),
    degraded: z.boolean(),
    moderatedAt: z.date().nullable(),
    createdByHumanId: z.string().nullable(),
    reviewNote: z.string().nullable(),
  })
  .strict();

const listFlaggedImagesOutput = z
  .object({
    items: z.array(flaggedImageDtoSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

const DEFAULT_LIMIT = 30;

const listFlaggedImagesInput = z
  .object({
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().min(1).nullable().optional(),
    // tRPC's useInfiniteQuery injects a top-level `direction` on every request;
    // `.strict()` would otherwise reject it with BAD_REQUEST (unrecognized_keys)
    // and break the flagged-images queue on scroll/paginate. Allowed and unused.
    direction: z.enum(["forward", "backward"]).optional(),
  })
  .strict();

function toFlaggedImageDto(
  record: ImageModerationRecord,
): z.infer<typeof flaggedImageDtoSchema> {
  return {
    recordId: record.id,
    publicUrl: record.publicUrl,
    kind: record.kind,
    subjectType: record.subjectType,
    subjectId: record.subjectId,
    maxSeverity: record.maxSeverity,
    categories: record.categories,
    degraded: record.degraded,
    moderatedAt: record.moderatedAt,
    createdByHumanId: record.createdByHumanId,
    reviewNote: record.reviewNote,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Ops gates
//
// The two older ops procedures (`queueSnapshot` / `queueSignal`) inline this
// check; the newer ones call these helpers rather than adding six more copies.
// Both throw the same errors those inline copies throw, so the gate behaviour
// is unchanged — this is deduplication, not a new policy. They are kept as
// plain functions (not middleware) so each procedure's gate stays visible at
// its own call site, which is how the rest of this router reads.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ADMIN/DEVELOPER read gate. Throws UNAUTHORIZED without an actor, FORBIDDEN
 * without the role. Returns the actor id for callers that need it.
 */
async function ensurePlatformOpsRead(ctx: Ctx): Promise<string> {
  return ensureRole(ctx, PLATFORM_OPS_ROLES, "Platform ops access required");
}

/**
 * ADMIN-only write gate. Narrower than the read gate on purpose — see
 * `PLATFORM_OPS_WRITE_ROLES`.
 */
async function ensurePlatformOpsWrite(ctx: Ctx): Promise<string> {
  return ensureRole(
    ctx,
    PLATFORM_OPS_WRITE_ROLES,
    "Platform admin access required",
  );
}

async function ensureRole(
  ctx: Ctx,
  requiredRoles: HumanRole[],
  message: string,
): Promise<string> {
  const actorHumanId = ctx.actorHumanId;
  if (!actorHumanId) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  const staffCheck = await ctx.authz.hasStaffRole({
    actorHumanId,
    requiredRoles,
  });
  if (!staffCheck.allowed) {
    throw new TRPCError({ code: "FORBIDDEN", message });
  }
  return actorHumanId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Image-moderation review surface (image-moderation-azure-content-safety spec
 * FR-007). Both procedures are moderator-gated: they require a
 * COMMUNITY_MODERATION_ROLES (COMMUNITY_MODERATOR / platform ADMIN) actor, and
 * the 2FA step-up is enforced automatically by `requireStaffSecondFactor`
 * (guard.ts) because `moderation.*` paths are on the gated-moderation allowlist.
 *
 * `reviewFlaggedImage` does NOT re-run role checks (there is no core-level
 * staff-authz method), so the transport is the authz boundary here — mirroring
 * `moderatorApplications.list`'s inline staff pre-check.
 */
export const moderationRouter = {
  /**
   * FR-007/FR-008: the FLAGGED image queue, newest `moderatedAt` first, paged
   * with an opaque cursor. Returns the queue DTO the review UI renders (preview
   * url, severities, owning entity, degraded marker). The owning-entity is left
   * as `subjectType` + `subjectId` for the UI to build the deep link — resolving
   * human-readable labels here would add an N+1 across mixed subject types.
   */
  listFlaggedImages: authedProcedure
    .input(listFlaggedImagesInput)
    .output(listFlaggedImagesOutput)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      // Same moderator gate the rest of /moderate enforces (COMMUNITY_MODERATOR
      // / ADMIN). Mirrors the inline staff pre-check pattern for read queues.
      const staffCheck = await ctx.authz.hasStaffRole({
        actorHumanId,
        requiredRoles: [...COMMUNITY_MODERATION_ROLES],
      });
      if (!staffCheck.allowed) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Moderator access required",
        });
      }

      try {
        const page = await ctx.repos.imageModerationRecords.listFlagged({
          limit: input.limit ?? DEFAULT_LIMIT,
          cursor: input.cursor ?? undefined,
        });
        return {
          items: page.items.map(toFlaggedImageDto),
          nextCursor: page.nextCursor,
        };
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * FR-007: moderator APPROVE / REJECT on a FLAGGED record. APPROVE flips it to
   * APPROVED (image becomes visible via read-time gating); REJECT flips it to
   * REJECTED and enqueues the R2 object for deletion. Fires the uploader
   * approve-after-hold / reject notification. Idempotent (compare-and-set on
   * FLAGGED) — a lost cross-decision race returns `alreadyDecided: true`.
   */
  reviewImage: authedProcedure
    .input(reviewInput)
    .output(reviewFlaggedImageOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      // Authz boundary lives here — the use case accepts the already-authorized
      // actor and does not re-check roles. Same moderator gate as the queue.
      const staffCheck = await ctx.authz.hasStaffRole({
        actorHumanId,
        requiredRoles: [...COMMUNITY_MODERATION_ROLES],
      });
      if (!staffCheck.allowed) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Moderator access required",
        });
      }

      const deps = {
        repos: ctx.repos,
        notify: ctx.notify,
        clock: ctx.clock,
        logger: ctx.logger,
        // Reindex the image's subject after a decision so a newly-approved hero
        // (or a rejection) reflects on public search/embeds promptly.
        search: ctx.multiSearch ?? undefined,
        reportError: ctx.reportError ?? undefined,
        // Lets the uploader notice link the event the image lives on.
        appBaseUrl: ctx.publicAppUrl ?? null,
      } satisfies Parameters<typeof reviewFlaggedImage>[0];

      try {
        return await reviewFlaggedImage(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * PLATFORM OPS: the five image-moderation queue-health counts, plus the
   * window (thresholds + derived cutoffs + `observedAt`) that produced them, so
   * the page labels tiles like "Degraded (last 2h)" from data instead of
   * hardcoding the number.
   *
   * Same counts and same defaults as the hourly Discord alert job, and none of
   * its state — loading the page must never reset the Discord alert
   * fingerprint. Note the honest shape of that guarantee: this transport hands
   * the WHOLE `ctx.repos` into a `Pick<Repos, "imageModerationRecords">`
   * parameter, so `platformSettings` is still reachable at runtime through a
   * cast. What holds the line is the use case's declared deps (a reader has to
   * add a cast to break it) plus a throwing-proxy test. See the block comment
   * in `get-moderation-queue-snapshot.ts`.
   *
   * The `cutoffs` + `thresholds` it returns are what the drill-down wants fed
   * back to it — `queueSignal` takes absolute instants, not relative knobs.
   */
  queueSnapshot: authedProcedure
    .input(getModerationQueueSnapshotInputSchema)
    .output(getModerationQueueSnapshotOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const staffCheck = await ctx.authz.hasStaffRole({
        actorHumanId,
        requiredRoles: PLATFORM_OPS_ROLES,
      });
      if (!staffCheck.allowed) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Platform ops access required",
        });
      }

      try {
        return await getModerationQueueSnapshot(
          { repos: ctx.repos, clock: ctx.clock },
          input,
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * PLATFORM OPS: the rows behind ONE snapshot tile, paged with the same opaque
   * cursor convention as `listFlaggedImages` — including `cursor` being
   * `.nullable()` and a tolerated top-level `direction`, both of which
   * `useInfiniteQuery` requires and neither of which is optional to get right.
   *
   * The caller passes back the ABSOLUTE `cutoffs` + `maxRequeues` it holds from
   * `queueSnapshot` rather than the relative knobs, so this list is selected
   * against the very window the clicked tile counted. No clock is read on this
   * path at all.
   *
   * WHAT IT WITHHOLDS. No image URL for any bucket, and no `storageKey` for
   * `awaitingReview`. The second one is the control that actually binds: R2
   * public URLs are `${publicBaseUrl}/${key}` by string join and moderation
   * gating is app-side, so a storage key plus a base URL that appears in every
   * published event's markup IS the image. `awaitingReview` holds un-reviewed
   * flagged content and this procedure admits DEVELOPERs who are not
   * moderators. The other four buckets keep `storageKey` — they are scanner
   * failures, unscanned rows and vanished objects, not content holds, and an
   * engineer needs to be able to name the row.
   *
   * Enforced in the use case, not here, so it cannot be lost by a transport
   * rewrite. Actual review lives at `/moderate/images` behind the moderator
   * gate. Do not add `publicUrl` "just for the flagged bucket".
   */
  queueSignal: authedProcedure
    .input(listModerationQueueSignalInputSchema)
    .output(listModerationQueueSignalOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const staffCheck = await ctx.authz.hasStaffRole({
        actorHumanId,
        requiredRoles: PLATFORM_OPS_ROLES,
      });
      if (!staffCheck.allowed) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Platform ops access required",
        });
      }

      try {
        // No `clock`: the drill-down derives no window of its own (see
        // `ListModerationQueueSignalDeps`).
        return await listModerationQueueSignal({ repos: ctx.repos }, input);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * PLATFORM OPS: the five queue-health counts split by image kind.
   *
   * Takes the ABSOLUTE cutoffs the caller already holds from `queueSnapshot`,
   * exactly like `queueSignal` and for the same reason — a breakdown re-derived
   * from a fresh clock could total 37 under a tile that says 40, and neither
   * surface could say which is right. No clock is read on this path.
   *
   * Aggregate counts only. No row identity, so no withholding question arises.
   */
  queueBreakdown: authedProcedure
    .input(getModerationQueueBreakdownInputSchema)
    .output(getModerationQueueBreakdownOutputSchema)
    .query(async ({ ctx, input }) => {
      await ensurePlatformOpsRead(ctx);
      try {
        return await getModerationQueueBreakdown({ repos: ctx.repos }, input);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * PLATFORM OPS: the distribution of provider severities over a window, so an
   * operator can judge whether the review threshold is in the right place
   * instead of taking the number on faith.
   *
   * AGGREGATE COUNTS ONLY — no record id, no storage key, no subject, no URL,
   * not even a sample row. The drill-down is the surface for rows, and it is
   * the surface that carries the withholding rules; a "show me the 4s" link
   * bolted onto a histogram would route around them.
   */
  severityHistogram: authedProcedure
    .input(getModerationSeverityHistogramInputSchema)
    .output(getModerationSeverityHistogramOutputSchema)
    .query(async ({ ctx, input }) => {
      await ensurePlatformOpsRead(ctx);
      try {
        return await getModerationSeverityHistogram({ repos: ctx.repos }, input);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * PLATFORM OPS: what the hourly Discord alert has (and has not) said.
   *
   * "7 awaiting review" is ambiguous on its own — a known backlog somebody is
   * already sitting on, or something nobody has been told about. The alert is
   * edge-triggered, so the tile looks identical either way.
   *
   * READ-ONLY, AND THAT IS LOAD-BEARING. `reportModerationQueueHealth` would
   * answer the same question and WRITES the fingerprint as part of its gate, so
   * calling it here would reset the suppression window on every page load and a
   * healthy read would clear the row and re-arm an alert that had already
   * fired. This calls `platformSettings.get()` and nothing else; a throwing-
   * `upsert` test in core holds the line.
   */
  alertState: authedProcedure
    .input(getModerationAlertStateInputSchema)
    .output(getModerationAlertStateOutputSchema)
    .query(async ({ ctx, input }) => {
      await ensurePlatformOpsRead(ctx);
      try {
        return await getModerationAlertState(
          {
            repos: ctx.repos,
            logger: ctx.logger,
            reportError: ctx.reportError ?? undefined,
          },
          input,
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * PLATFORM OPS: find one moderation record by its R2 storage key — the thing
   * a Sentry event or a CDN log line actually hands you.
   *
   * A MISS IS NOT AN ERROR: `found: false` means the object is unmoderated, and
   * since read-time gating treats "no record" as APPROVED, that is a finding
   * rather than a fault.
   *
   * SAME WITHHOLDING AS THE DRILL-DOWN, from the same predicate. If the record
   * is an un-reviewed content hold (FLAGGED, not degraded, unreviewed), both
   * `storageKey` and `lastError` are omitted and `withheld` says so. Echoing
   * back the key the drill-down refuses to show would defeat that control
   * completely — the caller supplied the key, but a non-moderator learning that
   * THIS key is held flagged content is the disclosure, not the key itself.
   */
  lookupByKey: authedProcedure
    .input(lookupModerationRecordInputSchema)
    .output(lookupModerationRecordOutputSchema)
    .query(async ({ ctx, input }) => {
      await ensurePlatformOpsRead(ctx);
      try {
        return await lookupModerationRecord({ repos: ctx.repos }, input);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * PLATFORM OPS WRITE (ADMIN only): terminally resolve one unscannable row.
   *
   * `degradedExhausted` rows are past the requeue cap and no automation will
   * ever touch them again; until now the fix was a hand-written UPDATE against
   * production. Resolves to ORPHANED — never REJECTED, which would enqueue an
   * R2 deletion for an object we were never able to fetch and notify the
   * uploader about a machine failure.
   *
   * The eligibility check is the repo's WHERE (`degraded = true` among others),
   * so a genuine CONTENT hold is unreachable from here even under a race. A
   * CAS that matches nothing returns `resolved: false` rather than throwing.
   */
  resolveUnscannable: authedProcedure
    .input(resolveUnscannableInput)
    .output(resolveUnscannableImageOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = await ensurePlatformOpsWrite(ctx);
      try {
        return await resolveUnscannableImage(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * PLATFORM OPS WRITE (ADMIN only): send one image back to PENDING for a
   * re-scan — after a provider outage, or a threshold change.
   *
   * Refuses anything a human decided. `create()` (the underlying mechanism)
   * resets ANY row, so a naive re-scan of a REJECTED record would revive a
   * moderator's decision and could put the image back into circulation; the
   * repo's WHERE admits only machine states (PENDING, ORPHANED, FLAGGED +
   * degraded) so that is impossible rather than merely guarded against.
   */
  rescanImage: authedProcedure
    .input(rescanImageInput)
    .output(rescanImageOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = await ensurePlatformOpsWrite(ctx);
      try {
        return await rescanImage(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};
