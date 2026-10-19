import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  applyToBeModerator,
  applyToBeModeratorInputSchema,
  applyToBeModeratorOutputSchema,
  attachCommunityListingHero,
  attachCommunityListingHeroInputSchema,
  attachCommunityListingHeroOutputSchema,
  cancelEventDate,
  cancelEventDateInputSchema,
  cancelEventDateWireOutputSchema,
  cancelEventDateRsvp,
  cancelEventDateRsvpInputSchema,
  cancelEventDateRsvpOutputSchema,
  cancelRsvp,
  cancelRsvpInputSchema,
  cancelRsvpOutputSchema,
  COMMUNITY_MODERATION_ROLES,
  createCommunityListing,
  createCommunityListingInputSchema,
  createCommunityListingWireOutputSchema,
  archiveCommunityPlace,
  archiveCommunityPlaceInputSchema,
  archiveCommunityPlaceOutputSchema,
  createCommunityPlace,
  createCommunityPlaceInputSchema,
  createCommunityPlaceOutputSchema,
  updateCommunityPlace,
  updateCommunityPlaceInputSchema,
  updateCommunityPlaceOutputSchema,
  restoreCommunityPlace,
  restoreCommunityPlaceInputSchema,
  restoreCommunityPlaceOutputSchema,
  getCommunityPlaceEditability,
  getCommunityPlaceEditabilityInputSchema,
  getCommunityPlaceEditabilityOutputSchema,
  listEventDates,
  listEventDatesInputSchema,
  listEventDatesOutputSchema,
  listCommunityListings,
  listCommunityListingsInputSchema,
  listCommunityListingsOutputSchema,
  listMyRsvps,
  listMyRsvpsInputSchema,
  listMyRsvpsOutputSchema,
  publishCommunityListing,
  publishCommunityListingInputSchema,
  publishCommunityListingWireOutputSchema,
  refineCreateCommunityListingInput,
  rsvpToEvent,
  rsvpToEventDate,
  rsvpToEventDateInputSchema,
  rsvpToEventDateOutputSchema,
  restoreEventDate,
  restoreEventDateInputSchema,
  restoreEventDateWireOutputSchema,
  rsvpToEventInputSchema,
  rsvpToEventOutputSchema,
  updateCommunityListing,
  updateCommunityListingInputSchema,
  updateCommunityListingWireOutputSchema,
  updateCommunityRecurrence,
  updateCommunityRecurrenceInputSchema,
  updateCommunityRecurrenceWireOutputSchema,
} from "@th/core/use-cases/community";

import { staffSecondFactorBypassEnabled } from "../dev-staff-2fa-bypass";
import { rateLimit, throwIfStaffSecondFactorRequired } from "../guard";
import { authedProcedure, optionalProcedure } from "../init";
import { makeEventHoldIntentsNotifier } from "../booking-hold-notifier";
import { makeLineupNoticeNotifier } from "../lineup-notice-notifier";
import { toTrpcError } from "../utils";

// createCommunityListingInputSchema carries a top-level superRefine
// (endsAt > startsAt; address fields required without a placeId), and zod 4
// forbids `.omit()` on refined object schemas — rebuild from `.shape`, then
// re-apply the SAME refinement so the boundary rejects what the use case
// would. The use case still re-parses with the full schema.
const createListingInput = z
  .strictObject(createCommunityListingInputSchema.shape)
  .omit({ actorHumanId: true })
  .superRefine((value, ctx) => refineCreateCommunityListingInput(value, ctx));

// No refinement on the schema, so a plain `.omit()` is safe; the actor is
// threaded from ctx and the use case re-parses the full strict schema.
const createPlaceInput = createCommunityPlaceInputSchema.omit({
  actorHumanId: true,
});
const updatePlaceInput = updateCommunityPlaceInputSchema.omit({
  actorHumanId: true,
});
const archivePlaceInput = archiveCommunityPlaceInputSchema.omit({
  actorHumanId: true,
});
const restorePlaceInput = restoreCommunityPlaceInputSchema.omit({
  actorHumanId: true,
});
const getPlaceEditabilityInput = getCommunityPlaceEditabilityInputSchema.omit({
  actorHumanId: true,
});
const listListingsForPlatformInput = listCommunityListingsInputSchema.omit({
  actorHumanId: true,
});

/**
 * Per-actor caps on the community-place writes. Each create (and each
 * address change) costs a tax-rate provider call and puts a public page up;
 * 20 an hour is far above a moderator fixing a night's listings and far
 * below a script. Separate buckets, so fixing typos never blocks adding.
 */
const createPlaceRateLimit = rateLimit({
  key: (ctx) => `community:place:create:${ctx.actorHumanId ?? "anon"}`,
  maxRequests: 20,
  windowSeconds: 3600,
  message: "adding places",
});
const updatePlaceRateLimit = rateLimit({
  key: (ctx) => `community:place:update:${ctx.actorHumanId ?? "anon"}`,
  maxRequests: 20,
  windowSeconds: 3600,
  message: "editing places",
});
const archivePlaceRateLimit = rateLimit({
  key: (ctx) => `community:place:archive:${ctx.actorHumanId ?? "anon"}`,
  maxRequests: 20,
  windowSeconds: 3600,
  message: "archiving places",
});
const restorePlaceRateLimit = rateLimit({
  key: (ctx) => `community:place:restore:${ctx.actorHumanId ?? "anon"}`,
  maxRequests: 20,
  windowSeconds: 3600,
  message: "restoring places",
});

const rsvpInput = rsvpToEventInputSchema.omit({ actorHumanId: true });
const cancelRsvpInput = cancelRsvpInputSchema.omit({ actorHumanId: true });
// tRPC's useInfiniteQuery injects a top-level `direction` ("forward" |
// "backward") on every request. listMyRsvpsInputSchema is `.strict()`, and Zod's
// `.omit()` PRESERVES that strictness, so without allowing `direction` the whole
// call 400s (unrecognized_keys) — breaking the /my-rsvps list on scroll/paginate.
// Allow it here; the handler strips it before the use case (which re-validates
// with the strict base schema and has no `direction` field).
const myRsvpsInput = listMyRsvpsInputSchema
  .omit({ actorHumanId: true })
  .extend({ direction: z.enum(["forward", "backward"]).optional() });
const applyToBeModeratorInput = applyToBeModeratorInputSchema.omit({
  actorHumanId: true,
});
// attachCommunityListingHeroInputSchema has NO top-level superRefine, so a
// plain `.omit()` is safe (the use-case re-parses the full schema at the
// boundary). The actor identity is threaded from ctx, never client input.
const attachHeroInput = attachCommunityListingHeroInputSchema.omit({
  actorHumanId: true,
});
const rsvpToDateInput = rsvpToEventDateInputSchema.omit({ actorHumanId: true });
const cancelDateRsvpInput = cancelEventDateRsvpInputSchema.omit({
  actorHumanId: true,
});
// Neither schema carries a refinement, so a plain `.omit()` is safe (each use
// case re-parses the full strict schema at the boundary). The actor identity is
// threaded from ctx, never client input.
const publishListingInput = publishCommunityListingInputSchema.omit({
  actorHumanId: true,
});
const updateListingInput = updateCommunityListingInputSchema.omit({
  actorHumanId: true,
});
// updateCommunityRecurrenceInputSchema carries a nested superRefined
// `recurrenceSchedule` but no top-level refinement, so a plain `.omit()` is
// safe here (the use-case re-parses the full schema at the boundary).
const updateRecurrenceInput = updateCommunityRecurrenceInputSchema.omit({
  actorHumanId: true,
});
// Neither call-off schema carries a refinement, so a plain `.omit()` is safe
// (the use case re-parses the full strict schema at the boundary). The actor
// identity is threaded from ctx, never client input.
const cancelEventDateInput = cancelEventDateInputSchema.omit({
  actorHumanId: true,
});
const restoreEventDateInput = restoreEventDateInputSchema.omit({
  actorHumanId: true,
});
// The viewer's humanId is threaded from ctx (optional auth), never trusted
// from client input — strip it from the public procedure's surface.
const listEventDatesInput = listEventDatesInputSchema.omit({
  viewerHumanId: true,
});

const myRsvpForEventInput = z
  .object({
    eventId: z.uuid(),
  })
  .strict();

const myRsvpForEventOutput = z
  .object({
    rsvped: z.boolean(),
  })
  .strict();

const checkModeratorAccessOutput = z
  .object({
    allowed: z.boolean(),
    // Whether the actor has an enrolled second factor (passkey or TOTP).
    // Deliberately excluded from `requireStaffSecondFactor`'s gated-path
    // allowlist (packages/transport/trpc/src/guard.ts) — this probe must
    // keep answering for moderators missing a 2nd factor so ModerateShell /
    // ModerateLayout can redirect to the friendly `/enroll-2fa` prompt
    // instead of a raw tRPC error. `false` (not computed) when the actor
    // isn't a moderator at all — moot in that case.
    secondFactorEnrolled: z.boolean(),
  })
  .strict();

/**
 * Community-managed event listings (docs/specs/2026-07-01/
 * community-managed-event-listings.spec.yaml): moderator-gated listing
 * creation (FR-005), personal RSVP state (FR-004), and the moderator
 * application entry point (FR-010).
 *
 * NOTE — suggestion image uploads (FR-015) deliberately have NO procedures
 * here: `events.requestImageUpload` / `events.finalizeImageUpload` call the
 * request/finalize-event-image-upload use-cases with the ctx actor, and those
 * use-cases already carry the COMMUNITY authz branch (signed-in uploaders,
 * quota-checked, unattached until suggestion APPROVE). The UI uses the
 * existing events procedures directly.
 */
export const communityRouter = {
  /**
   * FR-005: moderator/ADMIN creates an ownerless RSVP listing. Defaults to
   * PUBLISHED (the standalone form's create-is-go-live behaviour); the builder
   * passes `status: "DRAFT"` and follows up with `publishListing`.
   */
  createListing: authedProcedure
    .input(createListingInput)
    .output(createCommunityListingWireOutputSchema)
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
        // Best-effort incremental search-index update on success.
        search: ctx.multiSearch ?? undefined,
        logger: ctx.logger,
      } satisfies Parameters<typeof createCommunityListing>[0];

      // FR-018: a listing born PUBLISHED takes held dates, which owe
      // notifications, dispatched post-commit and never on the wire. A DRAFT
      // create takes nothing and owes nothing — `publishListing` is where that
      // happens for one.
      const notifyHoldIntents = makeEventHoldIntentsNotifier(ctx);
      let result;
      try {
        result = await createCommunityListing(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
      await notifyHoldIntents({ output: result, actorHumanId });
      return createCommunityListingWireOutputSchema.parse(result);
    }),

  /**
   * Moderator/ADMIN adds a place with NO owner, for a community listing at a
   * room no geocoder knows by name (owner ruling 2026-10-13). Returns the
   * fields a place picker selects. A same-name place within 50 m (or at the
   * same address) is refused with PLACE_ALREADY_EXISTS, `meta.existingPlace`
   * carrying it so the form can offer it instead.
   */
  createPlace: authedProcedure
    .use(createPlaceRateLimit)
    .input(createPlaceInput)
    .output(createCommunityPlaceOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      // The same Place-write deps `places.upsertPlace` gets.
      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        contentFilter: ctx.contentFilter,
        logger: ctx.logger,
        search: ctx.multiSearch ?? undefined,
        taxRateLookup: ctx.taxRateLookup ?? null,
        timezoneLookup: ctx.timezoneLookup ?? null,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof createCommunityPlace>[0];

      try {
        return await createCommunityPlace(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Moderator/ADMIN corrects the name, address and pin of a place NOBODY
   * owns (PLACE_HAS_OWNER once it is claimed). Same duplicate guard as
   * `createPlace`, excluding the place itself.
   */
  updatePlace: authedProcedure
    .use(updatePlaceRateLimit)
    .input(updatePlaceInput)
    .output(updateCommunityPlaceOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        contentFilter: ctx.contentFilter,
        logger: ctx.logger,
        search: ctx.multiSearch ?? undefined,
        taxRateLookup: ctx.taxRateLookup ?? null,
        timezoneLookup: ctx.timezoneLookup ?? null,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof updateCommunityPlace>[0];

      try {
        return await updateCommunityPlace(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Moderator/ADMIN archives a place nobody owns, nobody is claiming and no
   * organiser's event uses (PLACE_HAS_OWNER + meta.reason otherwise), and no
   * live published community listing uses (PLACE_HAS_LIVE_LISTINGS). It
   * leaves search, and so the place picker.
   */
  archivePlace: authedProcedure
    .use(archivePlaceRateLimit)
    .input(archivePlaceInput)
    .output(archiveCommunityPlaceOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: ctx.logger,
        search: ctx.multiSearch ?? undefined,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof archiveCommunityPlace>[0];

      try {
        return await archiveCommunityPlace(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Brings an ARCHIVED place nobody owns back to ACTIVE. An ADMIN may restore
   * any such place; a moderator only one a moderator archived (see the use
   * case's doc block in restore-community-place.ts). Returns the place in the
   * picker's shape.
   */
  restorePlace: authedProcedure
    .use(restorePlaceRateLimit)
    .input(restorePlaceInput)
    .output(restoreCommunityPlaceOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: ctx.logger,
        search: ctx.multiSearch ?? undefined,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof restoreCommunityPlace>[0];

      try {
        return await restoreCommunityPlace(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Moderator/ADMIN asks, before opening the edit dialog, whether it may
   * edit, archive or restore a place, and why not (`reason`). Advisory and
   * lock-free; the three writes above re-check under their locks. Same role
   * gate and second-factor step-up as those writes.
   */
  getPlaceEditability: authedProcedure
    .input(getPlaceEditabilityInput)
    .output(getCommunityPlaceEditabilityOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        clock: ctx.clock,
      } satisfies Parameters<typeof getCommunityPlaceEditability>[0];

      try {
        return await getCommunityPlaceEditability(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * /platform/community-listings: every ownerless COMMUNITY listing, newest
   * first, for a platform ADMIN to edit or take down. ADMIN-only inside
   * the use case (the cancel/archive gate); moderators get STAFF_ONLY.
   * With no `status`, CANCELLED and ARCHIVED are left out: cancelling is how a
   * listing is taken down (owner, 2026-10-16); ask for them by `status`.
   */
  listListingsForPlatform: authedProcedure
    .input(listListingsForPlatformInput)
    .output(listCommunityListingsOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof listCommunityListings>[0];

      try {
        return await listCommunityListings(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Take a DRAFT community listing live (`createListing` with
   * `status: "DRAFT"` is what mints one). Same moderator/ADMIN gate as
   * `createListing` — the use case runs `requirePlatformStaff` against
   * COMMUNITY_MODERATION_ROLES, and this procedure threads the actor from ctx
   * exactly the way `createListing` does.
   *
   * Idempotent: publishing an already-PUBLISHED listing succeeds with
   * `changed: false` rather than throwing, so a double-submit from the builder
   * does not paint an error over a listing that is live.
   */
  publishListing: authedProcedure
    .input(publishListingInput)
    .output(publishCommunityListingWireOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        clock: ctx.clock,
        // Best-effort incremental search-index update on success — this is
        // the flip that puts the listing into search.
        search: ctx.multiSearch ?? undefined,
        logger: ctx.logger,
        // Tell every person owed a "you're on the lineup" notice.
        lineupNotices: makeLineupNoticeNotifier(ctx),
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof publishCommunityListing>[0];

      // FR-018: a listing that becomes PUBLISHED takes its dates from any
      // holds on its calendar; those owe notifications, dispatched post-commit
      // and never on the wire. Same wiring as `createListing`.
      const notifyHoldIntents = makeEventHoldIntentsNotifier(ctx);
      let result;
      try {
        result = await publishCommunityListing(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
      await notifyHoldIntents({ output: result, actorHumanId });
      return publishCommunityListingWireOutputSchema.parse(result);
    }),

  /**
   * Save a field diff on a community listing — the EventBuilder's field-save.
   * Same moderator/ADMIN gate as `createListing`.
   *
   * DRAFT **and PUBLISHED**: a moderator fixing a typo on a live listing no
   * longer has to file a public suggestion against it and approve their own
   * proposal. The public suggestion queue is unchanged — it is still what
   * anonymous and public proposals go through (`submitEditSuggestion` →
   * `reviewEditSuggestion`), and an APPROVE there runs the same post-apply
   * pipeline this does.
   *
   * The three END states still refuse: ARCHIVED → EVENT_ARCHIVED,
   * CANCELLED / COMPLETED → EVENT_NOT_EDITABLE (the codes `events.setTags`
   * already answers for the same listing in the same states). The old blanket
   * EVENT_NOT_DRAFT is gone.
   */
  updateListing: authedProcedure
    .input(updateListingInput)
    .output(updateCommunityListingWireOutputSchema)
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
        // Best-effort incremental search-index update after a PUBLISHED save
        // commits — a saved title/venue/schedule must not keep serving stale
        // until the nightly full reindex. Same wiring as `publishListing`; the
        // DRAFT save no-ops it.
        search: ctx.multiSearch ?? undefined,
        logger: ctx.logger,
        // The reindex is the only swallow on this path; thread the reporter so
        // an index-drift failure is Sentry-visible.
        ...(ctx.reportError ? { reportError: ctx.reportError } : {}),
      } satisfies Parameters<typeof updateCommunityListing>[0];

      // FR-018: a save that moves a PUBLISHED listing's start takes its dates
      // from any holds on its calendar; those owe notifications, dispatched
      // post-commit and never on the wire. Same wiring as `publishListing`.
      // A DRAFT save owes nothing and this is a no-op.
      const notifyHoldIntents = makeEventHoldIntentsNotifier(ctx);
      let result;
      try {
        result = await updateCommunityListing(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
      await notifyHoldIntents({ output: result, actorHumanId });
      return updateCommunityListingWireOutputSchema.parse(result);
    }),

  /**
   * Set the hero/banner image on an EXISTING community listing (moderator/
   * ADMIN-gated). The web form creates the listing, uploads the banner via the
   * existing `events.requestImageUpload` → PUT → `events.finalizeImageUpload`
   * procedures, then calls this to link `Event.heroImageId`. The hero is set
   * immediately; the async EVENT_HERO moderation job (enqueued by finalize)
   * handles flagging.
   */
  attachHero: authedProcedure
    .input(attachHeroInput)
    .output(attachCommunityListingHeroOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        clock: ctx.clock,
        // Best-effort incremental search-index update on success.
        search: ctx.multiSearch ?? undefined,
        logger: ctx.logger,
      } satisfies Parameters<typeof attachCommunityListingHero>[0];

      try {
        return await attachCommunityListingHero(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Set/replace the recurrence schedule on an EXISTING community listing
   * (recurring-dates spec, slice 3). Moderator/ADMIN-gated (same guard as
   * createListing). Re-expands EventDate rows and re-pins Event.startsAt to the
   * first upcoming occurrence. Clearing recurrence is DEFERRED (a schedule is
   * required); the community edit-SUGGESTION path for recurrence is DEFERRED
   * (moderator-only for now).
   */
  updateRecurrence: authedProcedure
    .input(updateRecurrenceInput)
    .output(updateCommunityRecurrenceWireOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        clock: ctx.clock,
        // Best-effort incremental search-index update on success (startsAt moves).
        search: ctx.multiSearch ?? undefined,
        logger: ctx.logger,
        ...(ctx.reportError ? { reportError: ctx.reportError } : {}),
      } satisfies Parameters<typeof updateCommunityRecurrence>[0];

      const notifyHoldIntents = makeEventHoldIntentsNotifier(ctx);
      let result;
      try {
        result = await updateCommunityRecurrence(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
      await notifyHoldIntents({ output: result, actorHumanId });
      return updateCommunityRecurrenceWireOutputSchema.parse(result);
    }),

  /**
   * Call ONE night of a recurring community listing off. Moderator/ADMIN-gated
   * in the use case, PLUS the step-up 2FA gate at this transport.
   *
   * THE GATE HAS TO LIVE HERE, AND THAT IS THE WHOLE POINT. Every other
   * moderation control is reached through `/moderate/**`, which the web edge
   * middleware (`apps/web/src/middleware/staff-route-gate.ts`) fronts with
   * `community.checkModeratorAccess` AND the step-up 2FA requirement. This
   * control is designed to sit inline on the PUBLIC event page — a route with
   * no such edge gate in front of it — so leaning on "the caller is on a
   * /moderate route" would be leaning on something that is false by design.
   *
   * The step-up itself is enforced by the `requireStaffSecondFactor`
   * middleware chained into `authedProcedure`, via this path's entry in
   * `SECOND_FACTOR_GATED_MODERATION_PATHS` (see `guard.ts`). It surfaces as a
   * `FORBIDDEN` carrying `data.appCode: "SECOND_FACTOR_REQUIRED"`, which is
   * how the public-page UI tells "enrol a second factor" apart from a generic
   * failure and routes into `/enroll-2fa` instead of a toast. Adding a
   * procedure here WITHOUT adding its path to that set silently ships an
   * ungated moderation write on a public page.
   *
   * Idempotent: calling off an already-cancelled date succeeds with
   * `changed: false`. The recipient count is stripped from the wire (FR-004 —
   * a cancelled date's live-RSVP count is a going-count).
   */
  cancelEventDate: authedProcedure
    .input(cancelEventDateInput)
    .output(cancelEventDateWireOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        clock: ctx.clock,
        // Best-effort incremental search-index update (the re-pin moves
        // Event.startsAt, a discovery sort key).
        search: ctx.multiSearch ?? undefined,
        logger: ctx.logger,
        ...(ctx.reportError ? { reportError: ctx.reportError } : {}),
      } satisfies Parameters<typeof cancelEventDate>[0];

      try {
        const result = await cancelEventDate(deps, { ...input, actorHumanId });
        return cancelEventDateWireOutputSchema.parse(result);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Put a called-off night back on. Same gate, same step-up requirement, same
   * public-page reasoning as `cancelEventDate` — see that procedure's note,
   * and keep both paths listed in `SECOND_FACTOR_GATED_MODERATION_PATHS`.
   *
   * Idempotent: restoring an already-SCHEDULED date succeeds with
   * `changed: false`. The retracted-notice count is stripped from the wire for
   * the same FR-004 reason as the call-off's recipient count.
   */
  restoreEventDate: authedProcedure
    .input(restoreEventDateInput)
    .output(restoreEventDateWireOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        clock: ctx.clock,
        search: ctx.multiSearch ?? undefined,
        logger: ctx.logger,
        ...(ctx.reportError ? { reportError: ctx.reportError } : {}),
      } satisfies Parameters<typeof restoreEventDate>[0];

      try {
        const result = await restoreEventDate(deps, { ...input, actorHumanId });
        return restoreEventDateWireOutputSchema.parse(result);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Public read of a recurring listing's upcoming schedule with the VIEWER's
   * own per-date RSVP state (FR-004 — NO public going-count). `viewerHumanId`
   * comes from optional auth (ctx), never from client input.
   *
   * A caller that only wants the per-date flags may send
   * `includeRecurrence: false` to skip the Event row read (the web viewer-state
   * endpoint does); `recurrence` then comes back null and `truncated` reports
   * only the row cap. Read-shape only — it gates no data the default does not
   * already return.
   *
   * `moderatorView: true` adds a per-date `hasRsvp` boolean (presence, never
   * a count) for the moderator's schedule page. The gate is the USE CASE's:
   * it refuses anyone without a community-moderation role with `STAFF_ONLY`,
   * so this procedure forwards the flag and nothing else.
   */
  listEventDates: optionalProcedure
    .input(listEventDatesInput)
    .output(listEventDatesOutputSchema)
    .query(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        // For `moderatorView`: the use case checks the moderation roles
        // itself, so forwarding the flag never forwards the read ungated.
        authz: ctx.authz,
        logger: ctx.logger,
        // The recurrence summary is swallowed on failure (the page still
        // renders its dates), so the swallow needs a reporter to stay visible.
        ...(ctx.reportError ? { reportError: ctx.reportError } : {}),
      } satisfies Parameters<typeof listEventDates>[0];

      // The moderator view gets the same step-up the moderation WRITES get.
      // This procedure is `optionalProcedure` (the public read has no actor
      // to step up), so the path-level 2FA middleware never runs here; the
      // inference this read replaces — "which dropped nights survived as
      // Called off" — sits behind `updateRecurrence`, which is 2FA-gated, so
      // the read must not be more available than the write. The same probe
      // the middleware makes: only a moderator with no second factor is
      // stopped here, so a non-moderator still gets the use case's
      // STAFF_ONLY rather than a second-factor demand; the use case remains
      // the authoritative role gate.
      if (input.moderatorView && ctx.actorHumanId) {
        const staff = await ctx.authz.hasStaffRole({
          actorHumanId: ctx.actorHumanId,
          requiredRoles: [...COMMUNITY_MODERATION_ROLES],
        });
        throwIfStaffSecondFactorRequired(staff);
      }

      try {
        return await listEventDates(deps, {
          ...input,
          ...(ctx.actorHumanId ? { viewerHumanId: ctx.actorHumanId } : {}),
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** FR-004: idempotent "I'm going" on ONE occurrence of a recurring listing. */
  rsvpToDate: authedProcedure
    .input(rsvpToDateInput)
    .output(rsvpToEventDateOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      try {
        return await rsvpToEventDate(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** FR-004: reversible — idempotent per-date un-RSVP. */
  cancelDateRsvp: authedProcedure
    .input(cancelDateRsvpInput)
    .output(cancelEventDateRsvpOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      try {
        return await cancelEventDateRsvp(
          { repos: ctx.repos, logger: ctx.logger },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** FR-004: idempotent "I'm going" on a PUBLISHED RSVP event. */
  rsvp: authedProcedure
    .input(rsvpInput)
    .output(rsvpToEventOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      try {
        return await rsvpToEvent(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** FR-004: reversible — idempotent un-RSVP. */
  cancelRsvp: authedProcedure
    .input(cancelRsvpInput)
    .output(cancelRsvpOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      try {
        return await cancelRsvp(
          { repos: ctx.repos, logger: ctx.logger },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** The viewer's own RSVP list (attendance intent; never a public count). */
  myRsvps: authedProcedure
    .input(myRsvpsInput)
    .output(listMyRsvpsOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      try {
        // Drop the tRPC-injected `direction` before forwarding: the use case
        // re-validates against the strict listMyRsvpsInputSchema, which has no
        // `direction` field and would reject it a second time.
        const { direction: _direction, ...rest } = input;
        return await listMyRsvps(
          { repos: ctx.repos, logger: ctx.logger },
          { ...rest, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Per-event RSVP state for the detail page (UI request #2). Pure keyed
   * read scoped to the caller — a direct repo read, mirroring how the
   * platform router serves tiny actor-scoped reads without a use case.
   */
  myRsvpForEvent: authedProcedure
    .input(myRsvpForEventInput)
    .output(myRsvpForEventOutput)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      try {
        const rsvped = await ctx.repos.eventRsvps.existsForUser({
          eventId: input.eventId,
          humanId: actorHumanId,
        });
        return { rsvped };
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** FR-010: signed-in user applies to become a community moderator. */
  applyToBeModerator: authedProcedure
    .input(applyToBeModeratorInput)
    .output(applyToBeModeratorOutputSchema)
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
        logger: ctx.logger,
      } satisfies Parameters<typeof applyToBeModerator>[0];

      try {
        return await applyToBeModerator(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * UI request #1: gate for /moderate/* pages + builder Community mode.
   * Mirrors platform.checkStaffAccess but against the COMMUNITY moderation
   * roles (COMMUNITY_MODERATOR or ADMIN). Never throws for non-moderators —
   * the UI branches on `allowed`.
   */
  checkModeratorAccess: authedProcedure
    .output(checkModeratorAccessOutput)
    .query(async ({ ctx }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const result = await ctx.authz.hasStaffRole({
        actorHumanId,
        requiredRoles: [...COMMUNITY_MODERATION_ROLES],
        // Status probe: answers on the role so the shell can redirect.
        allowWithoutSecondFactor: true,
      });

      if (!result.allowed) {
        return { allowed: false, secondFactorEnrolled: false };
      }

      // Must agree with the dev bypass the authz port is built with, or the
      // moderation shell would redirect to /enroll-2fa while the API happily
      // served the calls.
      const secondFactorEnrolled =
        staffSecondFactorBypassEnabled ||
        (await ctx.repos.humans.hasSecondFactorEnrolled(actorHumanId));

      return { allowed: true, secondFactorEnrolled };
    }),
};
