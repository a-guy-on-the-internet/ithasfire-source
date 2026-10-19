import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  getPlaceForEdit,
  getPlaceForEditInputSchema,
  getPlaceForEditOutputSchema,
  getPlaceTitle,
  getPlaceTitleInputSchema,
  getPlaceTitleOutputSchema,
  getPlacePublic,
  getPlacePublicInputSchema,
  getPlacePublicOutputSchema,
  listHumanPlaces,
  listHumanPlacesInputSchema,
  listHumanPlacesOutputSchema,
  listPlaceSitemapEntries,
  listPlaceSitemapEntriesInputSchema,
  listPlaceSitemapEntriesOutputSchema,
  countDirectoryPlaces,
  countDirectoryPlacesInputSchema,
  countDirectoryPlacesOutputSchema,
  resolvePlaceById,
  resolvePlaceByIdInputSchema,
  resolvePlaceByIdOutputSchema,
  resolveTimezone,
  resolveTimezoneInputSchema,
  resolveTimezoneOutputSchema,
  updatePlaceStatus,
  updatePlaceStatusInputSchema,
  updatePlaceStatusOutputSchema,
  upsertPlace,
  upsertPlaceInputSchema,
  upsertPlaceOutputSchema,
  bulkUpsertPlaces,
  bulkUpsertPlacesInputSchema,
  bulkUpsertPlacesOutputSchema,
  bulkArchivePlaces,
  bulkArchivePlacesInputSchema,
  bulkArchivePlacesOutputSchema,
  bulkImportPlaces,
  bulkImportPlacesInputSchema,
  bulkImportPlacesOutputSchema,
  requestVerificationDocUpload,
  requestVerificationDocUploadInputSchema,
  requestVerificationDocUploadOutputSchema,
  submitPlaceVerification,
  submitPlaceVerificationInputSchema,
  submitPlaceVerificationOutputSchema,
  getPlaceDetail,
  getPlaceDetailInputSchema,
  getPlaceDetailOutputSchema,
  setPlaceDirectoryListing,
  setPlaceDirectoryListingInputSchema,
  setPlaceDirectoryListingOutputSchema,
  setPlaceBookingAcceptance,
  setPlaceBookingAcceptanceInputSchema,
  setPlaceBookingAcceptanceOutputSchema,
  setPlaceCommunityListingAcceptance,
  setPlaceCommunityListingAcceptanceInputSchema,
  setPlaceCommunityListingAcceptanceOutputSchema,
  getAvailabilitySetupState,
  getAvailabilitySetupStateInputSchema,
  getAvailabilitySetupStateOutputSchema,
  notifyAvailabilitySetupNeeded,
  type NotifyAvailabilitySetupNeededArgs,
  setPlaceAttendeeReviewsPublic,
  setPlaceAttendeeReviewsPublicInputSchema,
  setPlaceAttendeeReviewsPublicOutputSchema,
  setPlaceCommunityReviewsEnabled,
  setPlaceCommunityReviewsEnabledInputSchema,
  setPlaceCommunityReviewsEnabledOutputSchema,
  getVerificationDocumentUrl,
  getVerificationDocumentUrlInputSchema,
  getVerificationDocumentUrlOutputSchema,
  acknowledgePlaceVerification,
  acknowledgePlaceVerificationInputSchema,
  acknowledgePlaceVerificationOutputSchema,
  withdrawPlaceVerification,
  withdrawPlaceVerificationInputSchema,
  withdrawPlaceVerificationOutputSchema,
  releasePlaceVerification,
  releasePlaceVerificationInputSchema,
  releasePlaceVerificationOutputSchema,
  reviewPlaceVerification,
  reviewPlaceVerificationInputSchema,
  reviewPlaceVerificationWireOutputSchema,
  getPlatformVerificationQueue,
  getPlatformVerificationQueueInputSchema,
  getPlatformVerificationQueueOutputSchema,
  submitPlaceClaim,
  submitPlaceClaimInputSchema,
  submitPlaceClaimWireOutputSchema,
  requestClaimDocUpload,
  requestClaimDocUploadInputSchema,
  requestClaimDocUploadOutputSchema,
  requestClaimEmailChallenge,
  requestClaimEmailChallengeInputSchema,
  requestClaimEmailChallengeOutputSchema,
  confirmClaimEmailChallenge,
  confirmClaimEmailChallengeInputSchema,
  confirmClaimEmailChallengeOutputSchema,
  filePlaceOwnershipDispute,
  filePlaceOwnershipDisputeInputSchema,
  filePlaceOwnershipDisputeOutputSchema,
  getPlaceClaimEligibility,
  getPlaceClaimEligibilityInputSchema,
  getPlaceClaimEligibilityOutputSchema,
  listMyPlaceClaims,
  listMyPlaceClaimsOutputSchema,
  getPlaceBookingAvailability,
  getPlaceBookingAvailabilityInputSchema,
  getPlaceBookingAvailabilityOutputSchema,
  getPlaceBookingOptions,
  getPlaceBookingOptionsInputSchema,
  getPlaceBookingOptionsOutputSchema,
  listSpaces,
  listSpacesInputSchema,
  listSpacesOutputSchema,
  createSpace,
  createSpaceInputSchema,
  createSpaceOutputSchema,
  updateSpace,
  updateSpaceInputSchema,
  updateSpaceOutputSchema,
  setSpaceStatus,
  setSpaceStatusInputSchema,
  setSpaceStatusOutputSchema,
  listCalendars,
  listCalendarsInputSchema,
  listCalendarsOutputSchema,
  createCalendar,
  createCalendarInputSchema,
  createCalendarOutputSchema,
  refineRentalRatePair,
  updateCalendar,
  updateCalendarInputSchema,
  updateCalendarOutputSchema,
  assignCalendarSpaces,
  assignCalendarSpacesInputSchema,
  assignCalendarSpacesOutputSchema,
  listCalendarAvailability,
  listCalendarAvailabilityInputSchema,
  listCalendarAvailabilityOutputSchema,
  upsertCalendarAvailability,
  upsertCalendarAvailabilityOutputSchema,
  deleteCalendarAvailability,
  deleteCalendarAvailabilityInputSchema,
  deleteCalendarAvailabilityOutputSchema,
} from "@th/core/use-cases/places";

import {
  listPlaceEvents,
  listPlaceEventsInputSchema,
  listPlaceEventsOutputSchema,
  getVenueCalendar,
  getVenueCalendarOutputSchema,
  getVenueCalendarAdminOutputSchema,
  type GetVenueCalendarAdminOutput,
  getCalendarEvents,
  getCalendarEventsPublic,
  getCalendarEventsPublicOutputSchema,
  getCalendarEventsAdminOutputSchema,
  type GetCalendarEventsAdminOutput,
} from "@th/core/use-cases/events";

import {
  getPlaceAttendanceBand,
  getPlaceAttendanceBandInputSchema,
  getPlaceAttendanceBandOutputSchema,
  listPlaceLineupHistory,
  listPlaceLineupHistoryInputSchema,
  listPlaceLineupHistoryOutputSchema,
} from "@th/core/use-cases/place-reviews";
import {
  getBookingStandardsForEditing,
  getBookingStandardsForEditingInputSchema,
  getBookingStandardsForEditingOutputSchema,
  refineItemsApplyToIntent,
  setBookingStandardsOutputSchema,
  setCalendarBookingStandards,
  setCalendarBookingStandardsInputSchema,
  setCalendarPitchExamples,
  setCalendarPitchExamplesInputSchema,
  setPitchExamplesOutputSchema,
  setPlaceBookingStandards,
  setPlaceBookingStandardsInputSchema,
  setPlacePitchExamples,
  setPlacePitchExamplesInputSchema,
} from "@th/core/use-cases/booking-standards";

import {
  authedProcedure,
  optionalProcedure,
  publicProcedure,
  rateLimit,
} from "../init";
import { toTrpcError } from "../utils";

const upsertPlaceProcedureInput = upsertPlaceInputSchema.omit({
  actorHumanId: true,
});
const bulkUpsertPlacesProcedureInput = bulkUpsertPlacesInputSchema.omit({
  actorHumanId: true,
});
const bulkArchivePlacesProcedureInput = bulkArchivePlacesInputSchema.omit({
  actorHumanId: true,
});
const listHumanPlacesInput = listHumanPlacesInputSchema.omit({
  actorHumanId: true,
});
const getPlaceForEditInput = getPlaceForEditInputSchema.omit({
  actorHumanId: true,
});
const getPlaceTitleInput = getPlaceTitleInputSchema.omit({
  actorHumanId: true,
});
const updatePlaceStatusInput = updatePlaceStatusInputSchema.omit({
  actorHumanId: true,
});
const requestVerificationDocUploadInput =
  requestVerificationDocUploadInputSchema.omit({ actorHumanId: true });
const submitPlaceVerificationInput = submitPlaceVerificationInputSchema.omit({
  actorHumanId: true,
});
const getPlaceDetailInput = getPlaceDetailInputSchema.omit({
  actorHumanId: true,
});
// setPlaceDirectoryListingInputSchema has a `.refine()` so `.omit()` can't be
// used in Zod v4. Build the procedure input by hand.
const setPlaceDirectoryListingInput = z
  .object({
    placeId: z.string().uuid(),
    listedInDirectory: z.boolean(),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();
const setPlaceBookingAcceptanceInput =
  setPlaceBookingAcceptanceInputSchema.omit({ actorHumanId: true });
const setPlaceCommunityListingAcceptanceInput =
  setPlaceCommunityListingAcceptanceInputSchema.omit({ actorHumanId: true });
const getAvailabilitySetupStateInput =
  getAvailabilitySetupStateInputSchema.omit({ actorHumanId: true });
const setPlaceAttendeeReviewsPublicInput =
  setPlaceAttendeeReviewsPublicInputSchema.omit({ actorHumanId: true });
const setPlaceCommunityReviewsEnabledInput =
  setPlaceCommunityReviewsEnabledInputSchema.omit({ actorHumanId: true });
// `now` is a TEST SEAM on the use case (a caller-chosen clock would reveal an
// in-progress lineup or hide history) — the client never gets to send it.
// `.omit` keeps the schema strict, so a forwarded `now` is a 400, not a no-op.
const listPlaceLineupHistoryInput = listPlaceLineupHistoryInputSchema.omit({
  now: true,
});
const getVerificationDocumentUrlInput =
  getVerificationDocumentUrlInputSchema.omit({ actorHumanId: true });
const acknowledgePlaceVerificationInput =
  acknowledgePlaceVerificationInputSchema.omit({ actorHumanId: true });
const withdrawPlaceVerificationInput =
  withdrawPlaceVerificationInputSchema.omit({ actorHumanId: true });
const releasePlaceVerificationInput = releasePlaceVerificationInputSchema.omit({
  actorHumanId: true,
});
// reviewPlaceVerificationInputSchema has a `.refine()` so it isn't a plain
// ZodObject; build the procedure input by hand. The use case re-validates
// the rejection-notes rule, so we don't need the refinement here.
const reviewPlaceVerificationInput = z
  .object({
    requestId: z.string().uuid(),
    decision: z.enum(["APPROVED", "REJECTED"]),
    reviewerNotes: z.string().max(2000).nullable().optional(),
  })
  .strict();
const getPlatformVerificationQueueInput =
  getPlatformVerificationQueueInputSchema.omit({ actorHumanId: true });

const submitPlaceClaimInput = submitPlaceClaimInputSchema.omit({
  actorHumanId: true,
});
const requestClaimDocUploadInput = requestClaimDocUploadInputSchema.omit({
  actorHumanId: true,
});
const requestClaimEmailChallengeInput =
  requestClaimEmailChallengeInputSchema.omit({ actorHumanId: true });
const confirmClaimEmailChallengeInput =
  confirmClaimEmailChallengeInputSchema.omit({ actorHumanId: true });
const filePlaceOwnershipDisputeInput =
  filePlaceOwnershipDisputeInputSchema.omit({ actorHumanId: true });

// tRPC's useInfiniteQuery injects a top-level `direction` ("forward" |
// "backward") into every request input. Without allowing it, `.strict()`
// rejects the whole call with BAD_REQUEST (unrecognized_keys: ["direction"])
// — which silently breaks every infinite-scroll consumer of this schema.
// Mirrors cursorPageInput in event-suggestions.ts.
const listMyPlaceClaimsPageInput = z
  .object({
    cursor: z.string().min(1).nullable().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    direction: z.enum(["forward", "backward"]).optional(),
  })
  .strict();

// ── Venue hierarchy (spaces / calendars / availability) procedure inputs ──────
// All are plain `.omit({ actorHumanId: true })` derivations except
// upsertCalendarAvailability, whose use-case schema carries a `.superRefine()`
// (dayOfWeek-XOR-date) — zod v4 refuses `.omit()` on refined schemas, so the
// procedure input is built by hand; the use case re-parses with the refinement.
const listSpacesProcedureInput = listSpacesInputSchema.omit({
  actorHumanId: true,
});
const createSpaceProcedureInput = createSpaceInputSchema.omit({
  actorHumanId: true,
});
const updateSpaceProcedureInput = updateSpaceInputSchema.omit({
  actorHumanId: true,
});
const setSpaceStatusProcedureInput = setSpaceStatusInputSchema.omit({
  actorHumanId: true,
});
const listCalendarsProcedureInput = listCalendarsInputSchema.omit({
  actorHumanId: true,
});
// `createCalendarInputSchema` carries a `.superRefine` (rental rate = amount
// AND currency), and zod v4 refuses `.omit()` on a refined object. Re-derive
// the client shape from `.shape` (still `.strict()`, so a smuggled
// `actorHumanId` is rejected), then re-attach the SAME pair refine here: the
// use case re-parses with it too, but a refusal inside `parseInput` reaches
// the wire as a bare `invalid_input` with no field path, whereas a refusal at
// the procedure input carries `path: ["rentalRateCurrency"]` — which is what
// lets the calendar editor put the error on the field instead of in a toast.
const createCalendarProcedureInput = z
  .strictObject(createCalendarInputSchema.shape)
  .omit({ actorHumanId: true })
  .superRefine(refineRentalRatePair);
const updateCalendarProcedureInput = updateCalendarInputSchema.omit({
  actorHumanId: true,
});
const assignCalendarSpacesProcedureInput = assignCalendarSpacesInputSchema.omit({
  actorHumanId: true,
});
const listCalendarAvailabilityProcedureInput =
  listCalendarAvailabilityInputSchema.omit({ actorHumanId: true });
// FULL-PUT semantics (mirrors the use-case schema exactly, minus actor):
// `isOpen` stays REQUIRED with no default — omitting it must be a validation
// error, never a silent reopen (see upsertCalendarAvailabilityInputSchema).
// `.strict()` at the bottom: this input is hand-built (the use-case schema's
// superRefine blocks `.omit()`), so unknown-key rejection must be restated
// here or it silently diverges from every sibling procedure input.
const upsertCalendarAvailabilityProcedureInput = z.object({
  placeId: z.string().uuid(),
  /** Present = update that row; absent = create. */
  id: z.string().uuid().optional(),
  /** Null/absent = PLACE-WIDE row ("All calendars"). */
  calendarId: z.string().uuid().nullable().optional(),
  dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
  date: z.coerce.date().nullable().optional(),
  startTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Must be HH:mm (24h)")
    .nullable()
    .optional(),
  endTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Must be HH:mm (24h)")
    .nullable()
    .optional(),
  isOpen: z.boolean(),
  note: z.string().max(500).nullable().optional(),
}).strict();
const deleteCalendarAvailabilityProcedureInput =
  deleteCalendarAvailabilityInputSchema.omit({ actorHumanId: true });

// ── Booking standards (venue-booking-standards spec, FR-007) ─────────────────
// The two ITEMS schemas carry `.superRefine(refineItemsApplyToIntent)`, and
// zod v4 refuses `.omit()` on a refined object — same re-derivation as
// `createCalendarProcedureInput` above: `.shape` into a strict object, omit
// the actor, re-attach the SAME refine so a field that is not on the intent's
// form is refused here with its `items.N.field` path (the editor puts it on
// the row). The use cases re-parse with it too.
const setCalendarBookingStandardsProcedureInput = z
  .strictObject(setCalendarBookingStandardsInputSchema.shape)
  .omit({ actorHumanId: true })
  .superRefine(refineItemsApplyToIntent);
const setPlaceBookingStandardsProcedureInput = z
  .strictObject(setPlaceBookingStandardsInputSchema.shape)
  .omit({ actorHumanId: true })
  .superRefine(refineItemsApplyToIntent);
const setCalendarPitchExamplesProcedureInput =
  setCalendarPitchExamplesInputSchema.omit({ actorHumanId: true });
const setPlacePitchExamplesProcedureInput =
  setPlacePitchExamplesInputSchema.omit({ actorHumanId: true });
const getBookingStandardsForEditingProcedureInput =
  getBookingStandardsForEditingInputSchema.omit({ actorHumanId: true });

/**
 * One bucket per actor for the four standards writes: an editor saves one
 * (owner, intent) list at a time, so 30 a minute is far above a person and
 * far below a script replaying replace-all against the advisory lock.
 */
const bookingStandardsWriteRateLimit = rateLimit({
  key: (ctx) => `places:bookingStandards:write:${ctx.actorHumanId ?? "anon"}`,
  maxRequests: 30,
  windowSeconds: 60,
  message: "saving booking standards",
});

/**
 * One bucket per actor across EVERY place, for the claim writes. A pending
 * claim puts the place in CLAIM_PENDING, which stops moderators editing or
 * archiving it, so filing claims is a way to freeze places nobody owns. The
 * core's cap (`MAX_OPEN_CLAIMS_PER_ACTOR`, 20 open claims per person, for
 * themselves or an org) caps how many are open, not how fast they are filed:
 * each decided or withdrawn claim frees a slot. A real owner claims
 * one place, or a few for a group of rooms, so 10 an hour leaves room for
 * retries while one person can freeze at most 10 more ownerless places an
 * hour. The bucket is keyed on the person, never the place, so moving to the
 * next place starts no new budget.
 * `authedProcedure` has already resolved `actorHumanId`, so the "anon"
 * fallback is never reached.
 */
const placeClaimSubmitRateLimit = rateLimit({
  key: (ctx) => `places:claim:submit:${ctx.actorHumanId ?? "anon"}`,
  maxRequests: 10,
  windowSeconds: 3600,
  message: "claiming places",
});

/**
 * Each request can send an email to an address at the place's website domain.
 * The use case reuses a live challenge for the same (place, person), so a
 * person gets at most one email per place every 15 minutes. That rule says
 * nothing about how many places, so this bucket is per person across all
 * places, with the same limits as the submit bucket.
 */
const placeClaimEmailChallengeRateLimit = rateLimit({
  key: (ctx) => `places:claim:emailChallenge:${ctx.actorHumanId ?? "anon"}`,
  maxRequests: 10,
  windowSeconds: 3600,
  message: "sending claim codes",
});

// getCalendarEvents rides a discriminated union on `mode` in core; the two
// procedures below pin one mode each (mirroring getVenueCalendar /
// getPublicVenueCalendar), so `mode` and `actorHumanId` are server-set and
// never client-suppliable.
const getCalendarEventsAdminProcedureInput = z
  .object({
    calendarId: z.string().uuid(),
    from: z.date(),
    to: z.date(),
  })
  .strict();

const getCalendarEventsPublicProcedureInput = z
  .object({
    calendarId: z.string().uuid(),
    from: z.date().optional(),
    to: z.date().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

// Admin venue calendar: placeId + from/to + optional statuses (actorHumanId injected from session)
const getVenueCalendarAdminInput = z
  .object({
    placeId: z.string().uuid(),
    from: z.date(),
    to: z.date(),
    statuses: z
      .array(z.enum(["DRAFT", "PUBLISHED", "COMPLETED", "CANCELLED"]))
      .optional(),
  })
  .strict();

// Public venue calendar: placeId + optional window + pagination.
//
// There is deliberately no `placeSlug`. It used to accept `Place.slug` — a
// deprecated multi-segment DIRECTORY key that no route resolved and that
// nothing mints any more. A place's public slug lives on its `EntityPage`;
// callers resolve that to a `placeId` before asking for a calendar.
const getVenueCalendarPublicInput = z
  .object({
    placeId: z.string().uuid(),
    from: z.date().optional(),
    to: z.date().optional(),
    limit: z.number().int().min(1).max(50).default(20),
    offset: z.number().int().min(0).default(0),
  })
  .strict();

export const placesRouter = {
  resolvePlaceById: publicProcedure
    .input(resolvePlaceByIdInputSchema)
    .output(resolvePlaceByIdOutputSchema)
    .query(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
      } satisfies Parameters<typeof resolvePlaceById>[0];

      try {
        return await resolvePlaceById(deps, input);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * lat/lng → IANA timezone (venue-hierarchy FR-004).
   *
   * Lets the event editor adopt a FREEFORM address's zone the way it already
   * adopts `Place.timezone` on venue-select. Authed rather than public: the
   * only caller is the authoring UI, and there is no reason to hand out a free
   * geo-lookup endpoint. Read-only and repo-free — a pass-through to the port,
   * whose answer only ever informs the UI; the save path re-derives and stores
   * its own.
   */
  resolveTimezone: authedProcedure
    .input(resolveTimezoneInputSchema)
    .output(resolveTimezoneOutputSchema)
    .query(async ({ ctx, input }) => {
      const deps = {
        timezoneLookup: ctx.timezoneLookup ?? null,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof resolveTimezone>[0];

      try {
        return await resolveTimezone(deps, input);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  getPlacePublic: publicProcedure
    .input(getPlacePublicInputSchema)
    .output(getPlacePublicOutputSchema)
    .query(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
      } satisfies Parameters<typeof getPlacePublic>[0];

      try {
        return await getPlacePublic(deps, input);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Owner-gated place payload for the admin surfaces.
   *
   * `includeOwners` is opt-in and defaults to false: this read is shared by the
   * public page's Edit-button probe, the booking inbox and the verify/page
   * tabs, and only the edit surface renders owners. Callers that want the
   * owner list send `{ placeId, includeOwners: true }`; everyone else pays
   * nothing for it.
   */
  getPlaceForEdit: authedProcedure
    .input(getPlaceForEditInput)
    .output(getPlaceForEditOutputSchema)
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
        // The read's gate: `canManagePlace` (verified direct human owner, or
        // OWNER/ADMIN/EDITOR of an owning org). Its payload carries the
        // venue's street address and exact coordinates, so it sits at the same
        // bar as the page editor rather than at plain org membership.
        authz: ctx.authz,
        logger: ctx.logger,
        // Owner display resolution degrades to `owners: []` on failure; the
        // swallow has to reach Sentry.
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof getPlaceForEdit>[0];

      try {
        return await getPlaceForEdit(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Light title/status/verification fetch for shell surfaces (the admin
   * rail's place context header — place-admin-rail-context D5/FR-202).
   *
   * DELIBERATELY LOOSER than `getPlaceForEdit`, which it used to match: any
   * member of an owning org must be able to NAVIGATE, so this stays at plain
   * membership while that read sits at `canManagePlace`. It is safe there
   * precisely because it projects only id/name/status/verification and the
   * place's IANA zone name — nothing locational, nothing about ownership. Do
   * not add an address field here.
   */
  getPlaceTitle: authedProcedure
    .input(getPlaceTitleInput)
    .output(getPlaceTitleOutputSchema)
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
        logger: ctx.logger,
      } satisfies Parameters<typeof getPlaceTitle>[0];

      try {
        return await getPlaceTitle(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  listPlaceEvents: publicProcedure
    .input(listPlaceEventsInputSchema)
    .output(listPlaceEventsOutputSchema)
    .query(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
      } satisfies Parameters<typeof listPlaceEvents>[0];

      try {
        return await listPlaceEvents(deps, input);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  listHumanPlaces: authedProcedure
    .input(listHumanPlacesInput)
    .output(listHumanPlacesOutputSchema)
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
        // Required: `canManagePlace` is the bar for unlocking a withheld
        // venue's address on this list (D5) — never "any org membership".
        authz: ctx.authz,
        logger: ctx.logger,
      } satisfies Parameters<typeof listHumanPlaces>[0];

      try {
        return await listHumanPlaces(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  upsertPlace: authedProcedure
    .input(upsertPlaceProcedureInput)
    .output(upsertPlaceOutputSchema)
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
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: ctx.logger,
        search: ctx.multiSearch ?? undefined,
        // Cache the venue's admission tax rate on create / address change.
        taxRateLookup: ctx.taxRateLookup ?? null,
        // Derive Place.timezone from the address coordinates on the same
        // lifecycle (venue-hierarchy FR-004).
        timezoneLookup: ctx.timezoneLookup ?? null,
        // The use case's deliberate swallows (a throwing timezone lookup, the
        // fire-and-forget reindex of events re-projected by a privacy change)
        // are only Sentry-visible if this is forwarded.
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof upsertPlace>[0];

      try {
        return await upsertPlace(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  bulkUpsertPlaces: authedProcedure
    .input(bulkUpsertPlacesProcedureInput)
    .output(bulkUpsertPlacesOutputSchema)
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
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: ctx.logger,
        // An item that changes an existing venue's privacy re-projects its
        // events; these re-index them and report a failed index pass.
        search: ctx.multiSearch ?? undefined,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof bulkUpsertPlaces>[0];

      try {
        return await bulkUpsertPlaces(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  bulkArchivePlaces: authedProcedure
    .input(bulkArchivePlacesProcedureInput)
    .output(bulkArchivePlacesOutputSchema)
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
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof bulkArchivePlaces>[0];

      try {
        return await bulkArchivePlaces(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  updatePlaceStatus: authedProcedure
    .input(updatePlaceStatusInput)
    .output(updatePlaceStatusOutputSchema)
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
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof updatePlaceStatus>[0];

      try {
        return await updatePlaceStatus(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  // ── REMOVED: `places.updatePlaceVerificationStatus` ───────────────────
  //
  // Deleted (not deprecated) as a privilege-escalation hole. The procedure
  // forwarded any authenticated caller into
  // `updatePlaceVerificationStatus`, whose org-governance fallback clears
  // any ORG_ADMIN_ROLES member of an owning org — so an org owner could POST
  // `{ verificationStatus: "VERIFIED" }` and mint their own verified badge
  // with no document ever reviewed. `Place.verification === "VERIFIED"` is
  // load-bearing: it gates directory visibility and is the precondition
  // `setBookingAcceptance` requires. Living under `places.*` it ALSO sidestepped
  // guard.ts's staff second-factor gate, which covers `platform.*` wholesale.
  //
  // It had ZERO callers left repo-wide (web, mobile, scanner, api, jobs, mcp,
  // e2e) after the last admin-table row action was removed — pure attack
  // surface. The org-side flows it nominally served live elsewhere:
  // `places.submitPlaceVerification` (submit for review) and
  // `places.withdrawPlaceVerification` (withdraw). Staff decisions go through
  // `platform.updatePlaceVerificationStatus` (ADMIN/REVIEWER pre-check + the
  // wholesale 2FA gate) or `places.reviewPlaceVerification`.
  //
  // Do NOT re-add an org-side verification write here. The use case now
  // refuses VERIFIED/REJECTED for non-staff actors server-side, so a
  // re-added procedure would fail rather than escalate — but the right home
  // for a staff verification write is `platform.*`.

  getVenueCalendar: authedProcedure
    .input(getVenueCalendarAdminInput)
    .output(getVenueCalendarAdminOutputSchema)
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
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof getVenueCalendar>[0];

      try {
        // The union entry point returns public|admin; `mode` is pinned to
        // "admin" here (the `.output()` schema re-validates at the boundary).
        return (await getVenueCalendar(deps, {
          ...input,
          mode: "admin" as const,
          actorHumanId,
        })) as GetVenueCalendarAdminOutput;
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  getPublicVenueCalendar: publicProcedure
    .input(getVenueCalendarPublicInput)
    .output(getVenueCalendarOutputSchema)
    .query(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
      } satisfies Parameters<typeof getVenueCalendar>[0];

      try {
        return await getVenueCalendar(deps, {
          ...input,
          mode: "public" as const,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  listPlaceSitemapEntries: publicProcedure
    .input(listPlaceSitemapEntriesInputSchema)
    .output(listPlaceSitemapEntriesOutputSchema)
    .query(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
      } satisfies Parameters<typeof listPlaceSitemapEntries>[0];

      try {
        return await listPlaceSitemapEntries(deps, input);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  countDirectory: publicProcedure
    .input(countDirectoryPlacesInputSchema)
    .output(countDirectoryPlacesOutputSchema)
    .query(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
      } satisfies Parameters<typeof countDirectoryPlaces>[0];

      try {
        return await countDirectoryPlaces(deps, input);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  requestVerificationDocUpload: authedProcedure
    .input(requestVerificationDocUploadInput)
    .output(requestVerificationDocUploadOutputSchema)
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
        storage: ctx.fileStorage,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof requestVerificationDocUpload>[0];

      try {
        return await requestVerificationDocUpload(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  submitPlaceVerification: authedProcedure
    .input(submitPlaceVerificationInput)
    .output(submitPlaceVerificationOutputSchema)
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
        clock: ctx.clock,
        logger: ctx.logger,
        storage: ctx.fileStorage,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof submitPlaceVerification>[0];

      try {
        return await submitPlaceVerification(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  getPlaceDetail: authedProcedure
    .input(getPlaceDetailInput)
    .output(getPlaceDetailOutputSchema)
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
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof getPlaceDetail>[0];

      try {
        return await getPlaceDetail(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  setPlaceDirectoryListing: authedProcedure
    .input(setPlaceDirectoryListingInput)
    .output(setPlaceDirectoryListingOutputSchema)
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
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof setPlaceDirectoryListing>[0];

      try {
        return await setPlaceDirectoryListing(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  setBookingAcceptance: authedProcedure
    .input(setPlaceBookingAcceptanceInput)
    .output(setPlaceBookingAcceptanceOutputSchema)
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
        // Availability-onboarding FR-003 (deps assembly only): in-app-only
        // setup nudge on OFF→ON while unconfigured. Plain `ctx.notify` on
        // purpose — the renderer emits no email/push payload, so no mailer is
        // needed. The use case swallows notifier failures and reports them
        // via `reportError`; the hook holds the durable once-per-place claim.
        notifyAvailabilitySetupNeeded: (
          args: NotifyAvailabilitySetupNeededArgs,
        ) =>
          notifyAvailabilitySetupNeeded(
            {
              repos: ctx.repos,
              notify: ctx.notify,
              idempotency: ctx.idempotency,
              logger: ctx.logger,
              reportError: ctx.reportError ?? undefined,
              publicAppUrl: ctx.publicAppUrl ?? null,
            },
            args,
          ),
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof setPlaceBookingAcceptance>[0];

      try {
        return await setPlaceBookingAcceptance(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * The venue's standing consent to ownerless COMMUNITY listings at this place
   * (community-listings-at-claimed-venues FR-001). Deliberately shaped exactly
   * like `setBookingAcceptance` above — the owner meets both toggles on the
   * same admin page, and the pair diverging would be arbitrary. No notifier
   * hook: unlike booking acceptance there is no onboarding step to nudge.
   */
  setCommunityListingAcceptance: authedProcedure
    .input(setPlaceCommunityListingAcceptanceInput)
    .output(setPlaceCommunityListingAcceptanceOutputSchema)
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
        // Flipping consent re-resolves `isVenueConfirmed` for every COMMUNITY
        // listing at the place, which is STAMPED into the search document.
        // Without these two, search keeps asserting (or withholding) the
        // venue's backing until the nightly full reindex — and the
        // fire-and-forget failure that leaves it there reaches no backstop.
        search: ctx.multiSearch ?? undefined,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof setPlaceCommunityListingAcceptance>[0];

      try {
        return await setPlaceCommunityListingAcceptance(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Availability-onboarding detector (docs/specs/2026-08-31, `detector:`).
   * ONE owner-gated read consumed by every admin surface (FR-001 toggle
   * warning, FR-004 workspace banner, FR-006 picker empty state). WIRE
   * CONTRACT (fixed — UI builds against it):
   * `{ configured, calendarCount, defaultCalendarId, acceptsBookingRequests }`.
   */
  getAvailabilitySetupState: authedProcedure
    .input(getAvailabilitySetupStateInput)
    .output(getAvailabilitySetupStateOutputSchema)
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
        logger: ctx.logger,
      } satisfies Parameters<typeof getAvailabilitySetupState>[0];

      try {
        return await getAvailabilitySetupState(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  setAttendeeReviewsPublic: authedProcedure
    .input(setPlaceAttendeeReviewsPublicInput)
    .output(setPlaceAttendeeReviewsPublicOutputSchema)
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
      } satisfies Parameters<typeof setPlaceAttendeeReviewsPublic>[0];

      try {
        return await setPlaceAttendeeReviewsPublic(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * The PERFORMER-tier review switch (venue-track-record-and-review-switch
   * FR-005). OWNER/ADMIN bar lives in the use case; nothing is added here.
   */
  setCommunityReviewsEnabled: authedProcedure
    .input(setPlaceCommunityReviewsEnabledInput)
    .output(setPlaceCommunityReviewsEnabledOutputSchema)
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
      } satisfies Parameters<typeof setPlaceCommunityReviewsEnabled>[0];

      try {
        return await setPlaceCommunityReviewsEnabled(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * The attendance BAND for the request-to-play line (FR-014, NFR-004): the
   * sibling read chosen so the performer snapshot schema is not widened.
   * Door data, not performer data — `communityReviewsEnabled` does not gate
   * it. Never the raw `checkedInAvg`.
   */
  getTrackRecord: publicProcedure
    .input(getPlaceAttendanceBandInputSchema)
    .output(getPlaceAttendanceBandOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await getPlaceAttendanceBand({ repos: ctx.repos }, input);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Who has played here (FR-013 / FR-016): the venue page line and the Roster. */
  getLineupHistory: publicProcedure
    .input(listPlaceLineupHistoryInput)
    .output(listPlaceLineupHistoryOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await listPlaceLineupHistory(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          input,
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  getVerificationDocumentUrl: authedProcedure
    .input(getVerificationDocumentUrlInput)
    .output(getVerificationDocumentUrlOutputSchema)
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
        storage: ctx.fileStorage,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof getVerificationDocumentUrl>[0];

      try {
        return await getVerificationDocumentUrl(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  acknowledgePlaceVerification: authedProcedure
    .input(acknowledgePlaceVerificationInput)
    .output(acknowledgePlaceVerificationOutputSchema)
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
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof acknowledgePlaceVerification>[0];

      try {
        return await acknowledgePlaceVerification(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  withdrawPlaceVerification: authedProcedure
    .input(withdrawPlaceVerificationInput)
    .output(withdrawPlaceVerificationOutputSchema)
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
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof withdrawPlaceVerification>[0];

      try {
        return await withdrawPlaceVerification(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  releasePlaceVerification: authedProcedure
    .input(releasePlaceVerificationInput)
    .output(releasePlaceVerificationOutputSchema)
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
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof releasePlaceVerification>[0];

      try {
        return await releasePlaceVerification(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  reviewPlaceVerification: authedProcedure
    .input(reviewPlaceVerificationInput)
    .output(reviewPlaceVerificationWireOutputSchema)
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
        storage: ctx.fileStorage,
        clock: ctx.clock,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof reviewPlaceVerification>[0];

      let result;
      try {
        result = await reviewPlaceVerification(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
      return reviewPlaceVerificationWireOutputSchema.parse(result);
    }),

  getPlatformVerificationQueue: authedProcedure
    .input(getPlatformVerificationQueueInput)
    .output(getPlatformVerificationQueueOutputSchema)
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
        logger: ctx.logger,
      } satisfies Parameters<typeof getPlatformVerificationQueue>[0];

      try {
        return await getPlatformVerificationQueue(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  bulkImportPlaces: authedProcedure
    .input(bulkImportPlacesInputSchema.omit({ actorHumanId: true }))
    .output(bulkImportPlacesOutputSchema)
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
        logger: ctx.logger,
      } satisfies Parameters<typeof bulkImportPlaces>[0];

      try {
        return await bulkImportPlaces(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  // ── Claim venue flow (claim-venue-flow spec) ──────────────────────────────

  submitPlaceClaim: authedProcedure
    .input(submitPlaceClaimInput)
    .use(placeClaimSubmitRateLimit)
    .output(submitPlaceClaimWireOutputSchema)
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
        logger: ctx.logger,
        // FR-007's community-listing count is a deliberate swallow inside the
        // use case (a failed count must not fail a committed claim), so the
        // reporter has to be wired or that swallow is silent.
        reportError: ctx.reportError ?? undefined,
        storage: ctx.fileStorage,
      } satisfies Parameters<typeof submitPlaceClaim>[0];

      let result;
      try {
        result = await submitPlaceClaim(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
      return submitPlaceClaimWireOutputSchema.parse(result);
    }),

  // Claim/dispute proof-doc presign. NOT gated by canManagePlace (a claimant
  // isn't an owner yet); the use case gates on the place's claimable/disputable
  // state. Rate-limited per (actor, place) to bound presign abuse (NFR-001).
  requestClaimDocUpload: authedProcedure
    .input(requestClaimDocUploadInput)
    .use(
      rateLimit({
        key: (ctx, input: { placeId: string }) =>
          `place:claimDocUpload:${input.placeId}:${ctx.actorHumanId ?? "anon"}`,
        maxRequests: 20,
        windowSeconds: 60,
        message: "uploading claim documents",
      }),
    )
    .output(requestClaimDocUploadOutputSchema)
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
        storage: ctx.fileStorage,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof requestClaimDocUpload>[0];

      try {
        return await requestClaimDocUpload(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  requestClaimEmailChallenge: authedProcedure
    .input(requestClaimEmailChallengeInput)
    .use(placeClaimEmailChallengeRateLimit)
    .output(requestClaimEmailChallengeOutputSchema)
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
        mailer: ctx.mailer ?? undefined,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof requestClaimEmailChallenge>[0];

      try {
        return await requestClaimEmailChallenge(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  confirmClaimEmailChallenge: authedProcedure
    .input(confirmClaimEmailChallengeInput)
    .output(confirmClaimEmailChallengeOutputSchema)
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
      } satisfies Parameters<typeof confirmClaimEmailChallenge>[0];

      try {
        return await confirmClaimEmailChallenge(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  filePlaceOwnershipDispute: authedProcedure
    .input(filePlaceOwnershipDisputeInput)
    .output(filePlaceOwnershipDisputeOutputSchema)
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
        clock: ctx.clock,
        logger: ctx.logger,
        storage: ctx.fileStorage,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof filePlaceOwnershipDispute>[0];

      try {
        return await filePlaceOwnershipDispute(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  getPlaceClaimEligibility: publicProcedure
    .input(getPlaceClaimEligibilityInputSchema)
    .output(getPlaceClaimEligibilityOutputSchema)
    .query(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
        // Owner-name resolution (FR-007) degrades to `owner: null` on failure;
        // the swallow is reported rather than silently dropped.
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof getPlaceClaimEligibility>[0];

      try {
        return await getPlaceClaimEligibility(deps, input);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Claimant-facing "my venue claims": the signed-in human's own ownership
   * claims + disputes across ALL statuses, newest first, hydrated with each
   * target place's name + current slug. No scope input — the actor's humanId
   * (from ctx, never the client) is the only filter (IDOR-safe). Reviewer
   * identity is never returned.
   */
  listMyPlaceClaims: authedProcedure
    .input(listMyPlaceClaimsPageInput)
    .output(listMyPlaceClaimsOutputSchema)
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
        logger: ctx.logger,
      } satisfies Parameters<typeof listMyPlaceClaims>[0];

      try {
        return await listMyPlaceClaims(deps, {
          actorHumanId,
          cursor: input.cursor,
          limit: input.limit,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  // ── Availability: the booking date picker's read ─────────────────────────
  //
  // The Place-level availability EDITOR procedures (list / listForOwner /
  // create / update / delete over the old `PlaceAvailability` model) were
  // retired with the venue hierarchy (FR-007): hours and blackouts are now
  // calendar-scoped and are managed through `listCalendarAvailability` /
  // `upsertCalendarAvailability` / `deleteCalendarAvailability` below. The
  // model, port, adapter and table were dropped on 2026-08-21 (migration
  // 20260821140000_drop_place_availability).
  //
  // This read resolves `CalendarAvailability` for the place's default calendar
  // (or the one named in `calendarId`) and narrows occupancy to that calendar's
  // spaces.
  //
  // Still `publicProcedure`, and still note-free: the output schema is
  // `.strict()` with no `note` key, so a venue's private closure reason cannot
  // reach the wire. `calendarId` is client-supplied here, which is exactly why
  // the use case resolves it against the PLACE'S OWN calendar list — a foreign
  // id is CALENDAR_NOT_FOUND, never a confirmation that it exists elsewhere.

  // Per-day status, free gaps and offered start times for a window of dates,
  // already resolved into the venue's local minutes so the client never
  // re-derives a venue's day from instants.
  getBookingAvailability: publicProcedure
    .input(getPlaceBookingAvailabilityInputSchema)
    .output(getPlaceBookingAvailabilityOutputSchema)
    .query(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
        now: () => ctx.clock.now(),
      } satisfies Parameters<typeof getPlaceBookingAvailability>[0];

      try {
        return await getPlaceBookingAvailability(deps, input);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  // ── Booking options: the request dialog's read (docs/specs/2026-08-27) ───
  //
  // Public, no PII: which calendars accept which intents, each calendar's
  // ACTIVE rooms, the rental rate ONLY where the venue made it visible, and
  // whether the place is claimed (the dialog's "we've asked them to claim"
  // copy). Rate visibility and INSTANT-mode folding are done in the use
  // case; the `.strict()` output keeps the private fields (rentalMode,
  // hidden rates) off the wire structurally.
  //
  // `optionalProcedure`, not `publicProcedure`: the builder also reads this,
  // and needs `viewer.authority` — whether THIS viewer, saving under the
  // `owner` it names, is a venue owner / grant-holder / third party at the
  // place (owner ruling 2026-09-08: the third-party controls show for a true
  // third party only). The actor comes from ctx; an anonymous caller gets
  // the same shape with `viewer.authority: "none"`.
  getBookingOptions: optionalProcedure
    .input(getPlaceBookingOptionsInputSchema.omit({ actorHumanId: true }))
    .output(getPlaceBookingOptionsOutputSchema)
    .query(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
        now: () => ctx.clock.now(),
        // The standards read's degrade branch (ReporterPort convention).
        reportError: ctx.reportError ?? undefined,
        // W1: a viewer who manages the place is the venue (no third-party
        // controls) — the same rule the save applies.
        authz: ctx.authz,
      } satisfies Parameters<typeof getPlaceBookingOptions>[0];

      try {
        return await getPlaceBookingOptions(deps, {
          ...input,
          ...(ctx.actorHumanId ? { actorHumanId: ctx.actorHumanId } : {}),
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  // ── Venue hierarchy: spaces (FR-001) ──────────────────────────────────────
  // Transport stays thin: `ensurePlaceOwnerAccess` + the cross-place asserts
  // and the ≥1-active-space invariant all live in the use cases. No bespoke
  // rate limits, mirroring the sibling place-management mutations (the
  // default per-procedure floor still applies via authedProcedure).

  listSpaces: authedProcedure
    .input(listSpacesProcedureInput)
    .output(listSpacesOutputSchema)
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
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof listSpaces>[0];

      try {
        return await listSpaces(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  createSpace: authedProcedure
    .input(createSpaceProcedureInput)
    .output(createSpaceOutputSchema)
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
      } satisfies Parameters<typeof createSpace>[0];

      try {
        return await createSpace(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  updateSpace: authedProcedure
    .input(updateSpaceProcedureInput)
    .output(updateSpaceOutputSchema)
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
      } satisfies Parameters<typeof updateSpace>[0];

      try {
        return await updateSpace(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Retire / reactivate — the ONLY space lifecycle exit (no hard delete). */
  setSpaceStatus: authedProcedure
    .input(setSpaceStatusProcedureInput)
    .output(setSpaceStatusOutputSchema)
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
      } satisfies Parameters<typeof setSpaceStatus>[0];

      try {
        return await setSpaceStatus(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  // ── Venue hierarchy: calendars (FR-002/FR-003) ───────────────────────────

  listCalendars: authedProcedure
    .input(listCalendarsProcedureInput)
    .output(listCalendarsOutputSchema)
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
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof listCalendars>[0];

      try {
        return await listCalendars(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  createCalendar: authedProcedure
    .input(createCalendarProcedureInput)
    .output(createCalendarOutputSchema)
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
        // Availability-onboarding FR-003 (deps assembly only): a calendar
        // created for an unconfigured place programs nothing — nudge the
        // acting staff human, in-app only. Same composition as
        // setBookingAcceptance; the hook suppresses configured places and
        // holds the durable once-per-place claim.
        notifyAvailabilitySetupNeeded: (
          args: NotifyAvailabilitySetupNeededArgs,
        ) =>
          notifyAvailabilitySetupNeeded(
            {
              repos: ctx.repos,
              notify: ctx.notify,
              idempotency: ctx.idempotency,
              logger: ctx.logger,
              reportError: ctx.reportError ?? undefined,
              publicAppUrl: ctx.publicAppUrl ?? null,
            },
            args,
          ),
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof createCalendar>[0];

      try {
        return await createCalendar(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  updateCalendar: authedProcedure
    .input(updateCalendarProcedureInput)
    .output(updateCalendarOutputSchema)
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
      } satisfies Parameters<typeof updateCalendar>[0];

      try {
        return await updateCalendar(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** FULL replacement of a calendar's space joins (min 1 — every calendar has ≥1 space). */
  assignCalendarSpaces: authedProcedure
    .input(assignCalendarSpacesProcedureInput)
    .output(assignCalendarSpacesOutputSchema)
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
      } satisfies Parameters<typeof assignCalendarSpaces>[0];

      try {
        return await assignCalendarSpaces(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  // ── Venue hierarchy: calendar availability (FR-007) ──────────────────────
  // Owner-only surface (the availability editor). `calendarId: null` rows are
  // PLACE-WIDE ("All calendars"); upsert is FULL-PUT — see the procedure
  // input's note on `isOpen`.

  listCalendarAvailability: authedProcedure
    .input(listCalendarAvailabilityProcedureInput)
    .output(listCalendarAvailabilityOutputSchema)
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
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof listCalendarAvailability>[0];

      try {
        return await listCalendarAvailability(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  upsertCalendarAvailability: authedProcedure
    .input(upsertCalendarAvailabilityProcedureInput)
    .output(upsertCalendarAvailabilityOutputSchema)
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
      } satisfies Parameters<typeof upsertCalendarAvailability>[0];

      try {
        return await upsertCalendarAvailability(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  deleteCalendarAvailability: authedProcedure
    .input(deleteCalendarAvailabilityProcedureInput)
    .output(deleteCalendarAvailabilityOutputSchema)
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
      } satisfies Parameters<typeof deleteCalendarAvailability>[0];

      try {
        return await deleteCalendarAvailability(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  // ── Booking standards (venue-booking-standards spec, FR-007) ─────────────
  // What a pitch must include, per calendar (+ the place default), and the
  // venue's example pitches. Thin: authz (`ensurePlaceOwnerAccess`, the
  // calendar editor's own gate), the same-place calendar assert, the
  // intent-accepted check and the audit row all live in the use cases.
  // Writes are replace-all per (owner, intent) and share one per-actor
  // limit on top of the authedProcedure floor.

  getBookingStandardsForEditing: authedProcedure
    .input(getBookingStandardsForEditingProcedureInput)
    .output(getBookingStandardsForEditingOutputSchema)
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
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof getBookingStandardsForEditing>[0];

      try {
        return await getBookingStandardsForEditing(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  setCalendarBookingStandards: authedProcedure
    .input(setCalendarBookingStandardsProcedureInput)
    .use(bookingStandardsWriteRateLimit)
    .output(setBookingStandardsOutputSchema)
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
      } satisfies Parameters<typeof setCalendarBookingStandards>[0];

      try {
        return await setCalendarBookingStandards(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  setCalendarPitchExamples: authedProcedure
    .input(setCalendarPitchExamplesProcedureInput)
    .use(bookingStandardsWriteRateLimit)
    .output(setPitchExamplesOutputSchema)
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
      } satisfies Parameters<typeof setCalendarPitchExamples>[0];

      try {
        return await setCalendarPitchExamples(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  setBookingStandards: authedProcedure
    .input(setPlaceBookingStandardsProcedureInput)
    .use(bookingStandardsWriteRateLimit)
    .output(setBookingStandardsOutputSchema)
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
      } satisfies Parameters<typeof setPlaceBookingStandards>[0];

      try {
        return await setPlaceBookingStandards(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  setPitchExamples: authedProcedure
    .input(setPlacePitchExamplesProcedureInput)
    .use(bookingStandardsWriteRateLimit)
    .output(setPitchExamplesOutputSchema)
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
      } satisfies Parameters<typeof setPlacePitchExamples>[0];

      try {
        return await setPlacePitchExamples(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  // ── Venue hierarchy: named-calendar events (FR-005/FR-010) ───────────────
  // Two procedures pin the core discriminated union's modes (the exact
  // getVenueCalendar / getPublicVenueCalendar split): admin = owner-gated
  // with availability + conflict overlays; public = unauthenticated
  // PUBLISHED-only (rate-limited by the default publicProcedure floor, like
  // every other public read here).

  getCalendarEventsAdmin: authedProcedure
    .input(getCalendarEventsAdminProcedureInput)
    .output(getCalendarEventsAdminOutputSchema)
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
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof getCalendarEvents>[0];

      try {
        // The union entry point returns public|admin; `mode` is pinned to
        // "admin" here, so the assertion is safe (the `.output()` schema
        // re-validates the shape at the boundary regardless).
        return (await getCalendarEvents(deps, {
          ...input,
          mode: "admin" as const,
          actorHumanId,
        })) as GetCalendarEventsAdminOutput;
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  getCalendarEventsPublic: publicProcedure
    .input(getCalendarEventsPublicProcedureInput)
    .output(getCalendarEventsPublicOutputSchema)
    .query(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
      } satisfies Parameters<typeof getCalendarEventsPublic>[0];

      try {
        return await getCalendarEventsPublic(deps, {
          ...input,
          mode: "public" as const,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};

export type PlacesRouter = typeof placesRouter;
