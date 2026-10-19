import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { isAppError } from "@th/errors";
import {
  ensureEventReadableBySlug,
  eventNotFoundBySlug,
} from "@th/core/use-cases/events";

import {
  getSuggestionBase,
  getSuggestionBaseInputSchema,
  getSuggestionBaseOutputSchema,
  listMyEditSuggestions,
  listMyEditSuggestionsOutputSchema,
  listPendingEditSuggestions,
  listPendingEditSuggestionsOutputSchema,
  reviewEventEditSuggestion,
  reviewEventEditSuggestionInputSchema,
  reviewEventEditSuggestionWireOutputSchema,
  submitEventEditSuggestion,
  submitEventEditSuggestionInputSchema,
  submitEventEditSuggestionOutputSchema,
} from "@th/core/use-cases/community";

import {
  authedProcedure,
  optionalProcedure,
  publicProcedure,
  rateLimit,
} from "../init";
import { makeEventHoldIntentsNotifier } from "../booking-hold-notifier";
import { ensureFullEventReadAccessByEventId } from "../event-read-access";
import { toTrpcError } from "../utils";

// submitter identity/IP always come from ctx (never the client payload).
const submitInput = submitEventEditSuggestionInputSchema.omit({
  submitterHumanId: true,
  submitterIp: true,
});
const reviewInput = reviewEventEditSuggestionInputSchema.omit({
  actorHumanId: true,
});

// tRPC's useInfiniteQuery injects a top-level `direction` ("forward" | "backward")
// into every request input. Without allowing it, `.strict()` rejects the whole
// call with BAD_REQUEST (unrecognized_keys: ["direction"]) — which silently
// breaks every infinite-scroll consumer of this schema.
const infiniteDirection = z.enum(["forward", "backward"]).optional();

const cursorPageInput = z
  .object({
    cursor: z.string().min(1).nullable().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    direction: infiniteDirection,
  })
  .strict();

// Owner-side inbox scopes only (FR-016) — the community-wide moderator queue
// is listForModeration; keeping `kind: "community"` out of this input means a
// client cannot accidentally hit the moderator authz branch here.
const listForOwnerInput = z
  .object({
    scope: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("org"), orgId: z.uuid() }).strict(),
      z.object({ kind: z.literal("event"), eventId: z.uuid() }).strict(),
    ]),
    cursor: z.string().min(1).nullable().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    direction: infiniteDirection,
  })
  .strict();

/**
 * Universal event edit suggestions (community-managed-event-listings spec
 * FR-006/008/016). Submission is anon-capable (optionalProcedure — a
 * signed-in submitter is recorded, an anonymous one is not); review authz
 * branches INSIDE the use case (COMMUNITY → moderator, org → ORG_EDIT_ROLES,
 * personal → owner).
 */
export const eventSuggestionsRouter = {
  /**
   * Anyone — including anonymous — proposes a whitelisted diff against any
   * published public event. Soft per-IP transport cap (NFR-001) on top of the
   * use case's own 24h pending-per-IP cap; nothing is public until approved.
   */
  submit: optionalProcedure
    .input(submitInput)
    .use(
      rateLimit<z.infer<typeof submitInput>>({
        // Signed-in submitters get their own bucket so a proxy
        // misconfiguration (shared clientIp) can't exhaust the anonymous
        // window for everyone. Anon fallback matches the events router's
        // ip-key precedent.
        key: (ctx) =>
          ctx.actorHumanId
            ? `suggest:h:${ctx.actorHumanId}`
            : `suggest:${ctx.clientIp ?? "unknown"}`,
        maxRequests: 5,
        windowSeconds: 300,
        message: "submitting edit suggestions",
      }),
    )
    .output(submitEventEditSuggestionOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        contentFilter: ctx.contentFilter,
        // The IP is hashed in core under its own derived key; never stored.
        identitySecret: ctx.identityHashSecret ?? null,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof submitEventEditSuggestion>[0];

      try {
        return await submitEventEditSuggestion(deps, {
          ...input,
          submitterHumanId: ctx.actorHumanId,
          // `ctx.clientIp` is the real client IP (CF-Connecting-IP first,
          // socket last). It feeds the per-IP abuse cap and is NEVER stored:
          // core keeps only a keyed hash (`EventEditSuggestion.
          // submitterIpHash`), which the retention job clears after ~30 days.
          submitterIp: ctx.clientIp,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** APPROVE/REJECT — approver-side authz branches inside the use case. */
  review: authedProcedure
    .input(reviewInput)
    .output(reviewEventEditSuggestionWireOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        clock: ctx.clock,
        contentFilter: ctx.contentFilter,
        // Best-effort incremental search-index update after an APPROVE commits
        // — an approved "the venue moved" report must not leave search serving
        // the old venue until the nightly full reindex. Same wiring as
        // `community.updateListing`, which runs the same shared pipeline.
        search: ctx.multiSearch ?? undefined,
        logger: ctx.logger,
        // The reindex is the only swallow on this path; thread the reporter so
        // an index-drift failure is Sentry-visible.
        ...(ctx.reportError ? { reportError: ctx.reportError } : {}),
      } satisfies Parameters<typeof reviewEventEditSuggestion>[0];

      // FR-018: an approved schedule move on a PUBLISHED event may take held
      // dates; the notifications it owes are dispatched post-commit and never
      // put on the wire (same hook as community.updateRecurrence).
      const notifyHoldIntents = makeEventHoldIntentsNotifier(ctx);
      let result;
      try {
        result = await reviewEventEditSuggestion(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
      await notifyHoldIntents({ output: result, actorHumanId });
      return reviewEventEditSuggestionWireOutputSchema.parse(result);
    }),

  /** Moderator queue: all PENDING suggestions on COMMUNITY listings. */
  listForModeration: authedProcedure
    .input(cursorPageInput)
    .output(listPendingEditSuggestionsOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        logger: ctx.logger,
      } satisfies Parameters<typeof listPendingEditSuggestions>[0];

      try {
        return await listPendingEditSuggestions(deps, {
          actorHumanId,
          scope: { kind: "community" },
          cursor: input.cursor,
          limit: input.limit,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Owner-side inbox (FR-016): org-wide or single-event scope. */
  listForOwner: authedProcedure
    .input(listForOwnerInput)
    .output(listPendingEditSuggestionsOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        logger: ctx.logger,
      } satisfies Parameters<typeof listPendingEditSuggestions>[0];

      try {
        return await listPendingEditSuggestions(deps, {
          actorHumanId,
          scope: input.scope,
          cursor: input.cursor,
          limit: input.limit,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Submitter-facing "my edit suggestions": the signed-in human's own
   * suggestions across ALL statuses (PENDING/APPROVED/REJECTED), newest first,
   * hydrated with each target event's title + current slug. No scope input —
   * the actor's humanId (from ctx, never the client) is the only filter.
   */
  listMine: authedProcedure
    .input(cursorPageInput)
    .output(listMyEditSuggestionsOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
      } satisfies Parameters<typeof listMyEditSuggestions>[0];

      try {
        return await listMyEditSuggestions(deps, {
          actorHumanId,
          cursor: input.cursor,
          limit: input.limit,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * PUBLIC propose-mode hydration (UI request #4): the event's current
   * whitelisted-field values + attached images. PUBLISHED PUBLIC events only
   * (everything else collapses to EVENT_NOT_FOUND inside the use case), and
   * password/application-gated events require the same unlock the sibling
   * public reads (getEventSeo / getPublicEventBody) do. Non-EXACT location
   * modes have their geo fields redacted inside the use case.
   */
  getBaseForEvent: publicProcedure
    .input(getSuggestionBaseInputSchema)
    .output(getSuggestionBaseOutputSchema)
    .query(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
      } satisfies Parameters<typeof getSuggestionBase>[0];

      try {
        // N3 FIRST on the slug path, as in `getEventSeo`: the gate check
        // below would answer a gated DRAFT with `event_password_required`.
        // (The id path gets the same check inside the gate itself —
        // `getEventGateState` answers a hidden id like an unknown one.)
        if (input.slug) {
          await ensureEventReadableBySlug(
            ctx.repos,
            { slug: input.slug, viewerHumanId: ctx.actorHumanId ?? null },
            ctx.authz,
          );
        }

        // Same full-read gate the sibling public reads enforce. The use case
        // FOLLOWS slug redirects, so resolve the slug first and gate by
        // eventId — ensureFullEventReadAccessBySlug's redirect early-return
        // would otherwise let a legacy slug bypass the gate here.
        let gateEventId = input.eventId ?? null;
        if (!gateEventId && input.slug) {
          const resolution = await ctx.repos.events.resolveBySlug(input.slug);
          gateEventId = resolution?.eventId ?? null;
        }
        if (gateEventId) {
          await ensureFullEventReadAccessByEventId(ctx, gateEventId);
        }

        // Feed the resolved id through so the gated event and the read event
        // are the same row (no second slug resolution / TOCTOU). An
        // unresolvable slug keeps the original input — the use case owns the
        // 404 collapse.
        return await getSuggestionBase(
          deps,
          gateEventId ? { eventId: gateEventId } : input,
        );
      } catch (err) {
        // The slug path answers EVERY miss with the unknown-slug error, `meta`
        // included. The use case is handed the resolved id (see above), so
        // its "not suggestible" collapse carries no `via` — which would set a
        // real event's slug apart from one that never existed.
        if (input.slug && isAppError(err) && err.code === "EVENT_NOT_FOUND") {
          throw toTrpcError(eventNotFoundBySlug());
        }
        throw toTrpcError(err);
      }
    }),
};
