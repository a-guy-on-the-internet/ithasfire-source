import { z } from "zod";
import type { RefinementCtx } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { SaveEventInput, EventRecord } from "@th/ports/repos/events";
import type { PlacesRepo, PlaceRecord } from "@th/ports/repos/places";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import type { SavedLocationRecord } from "@th/ports/repos/saved-locations";
import type { TaxRateLookupPort } from "@th/ports/tax-rate-lookup";
import type { TimezoneLookupPort } from "@th/ports/timezone-lookup";
import type { AddressRevealPreset } from "@th/types";
import { type EventBody } from "@th/schema";
import { describeError, parseInput } from "../../../lib/io";
import {
  plainTextOptional,
  plainTextRequired,
} from "../../../lib/sanitize-plain-text";
import { applyPlaceLocationFloor } from "../../../lib/location/redact-place-location";
import {
  MAX_OBFUSCATION_RADIUS_METERS,
  MIN_OBFUSCATION_RADIUS_METERS,
  snapValidatedObfuscationRadius,
} from "../../../lib/location/obfuscation-radius-ladder";
import { DEFAULT_VENUE_TIMEZONE } from "../../../lib/venue-local-time";
import { applyInstructionExemption } from "../../../lib/tax/instruction-exemption";
import {
  commitPreparedEventTaxRate,
  prepareEventTaxRate,
  type EventTaxRateLocationRef,
  type PreparedEventTaxRate,
} from "./resolve-event-tax-rate";
import { validateEventBody } from "./event-body-sanitizer";
import {
  appendBookingEventModifiedEntry,
  diffBookingTrackedEventFields,
} from "./booking-event-ledger";
import {
  bookingHoldNotificationIntentSchema,
  bookingHoldStaffRecipientHintSchema,
} from "../../booking-holds/_shared/booking-hold-intents";
import { settleHeldDatesForEvent } from "../../booking-holds/settle-held-dates-for-published-event";
import { bookingRequestNotificationIntentSchema } from "../../booking-requests/_shared/booking-request-intents";
import {
  bookingIntentSchema,
  type BookingIntentInput,
} from "../../booking-requests/create-booking-request";
import {
  createBookingRequestFromEvent,
  EVENT_FIRST_ABSORBED_SKIP_REASONS,
  isEventFirstAbsorbedSkip,
  type CreateBookingRequestFromEventResult,
} from "../../booking-requests/create-booking-request-from-event";
import { hasActiveVenueConfirmationStamp } from "../../../lib/venue-confirmation";
import { assignSlugOnCreate } from "./assign-slug-on-create";
import { onEventLocationChanged } from "../../arrival-areas/on-event-location-changed";
import { scrubEventSearchDocIfWithheld } from "../../search/privacy-scrub";
import { searchForTx } from "../../search/tx-bound-search";
import { reindexAfterMutation } from "../../search/reindex-after-mutation";
import { markForSearchReindex } from "../../search/search-reindex-marks";
import {
  classifyBuilderVenueTrust,
  type BuilderVenueTrustResult,
} from "./builder-venue-trust";
import { ensureAddressIsNotOwnWithheldPlace } from "./own-withheld-place-guard";
import { ensureLoadedPlaceAttachable } from "./place-access";
import {
  probeManagedPlace,
  stampVenueConfirmationForSave,
} from "./venue-manager-stamp";
import { fail } from "@th/errors";

import {
  enforceQuota,
  incrementResourceUsage,
} from "../../quotas/enforce-quota";

export { describeError, parseInput } from "../../../lib/io";

export type RawLocationInput = Partial<{
  placeId: string;
  savedLocationId: string;
  addressText: string;
  lat: number;
  lng: number;
  locality: string;
  region: string;
  countryCode: string;
  postalCode: string;
}>;

export const isoDateTimeSchema = z
  .string()
  .trim()
  .superRefine((value: string, ctx: RefinementCtx) => {
    const time = Date.parse(value);
    if (Number.isNaN(time)) {
      ctx.addIssue({
        code: "custom",
        message: "Invalid datetime",
      });
    }
  })
  .transform((value) => new Date(value));

export const locationSchema = z
  .object({
    placeId: z.string().uuid().optional(),
    savedLocationId: z.string().uuid().optional(),
    addressText: plainTextRequired(280).optional(),
    lat: z.coerce.number().gte(-90).lte(90).optional(),
    lng: z.coerce.number().gte(-180).lte(180).optional(),
    locality: plainTextOptional(200).optional(),
    region: plainTextOptional(200).optional(),
    countryCode: z.string().trim().max(6).optional(),
    postalCode: z.string().trim().max(20).optional(),
  })
  .partial()
  .default({})
  .superRefine((value: RawLocationInput, ctx: RefinementCtx) => {
    const hasPlace = Boolean(value.placeId);
    const hasSaved = Boolean(value.savedLocationId);
    const hasFreeform =
      value.addressText !== undefined ||
      value.lat !== undefined ||
      value.lng !== undefined;

    const locationModes = [hasPlace, hasSaved, hasFreeform].filter(
      Boolean,
    ).length;
    if (locationModes > 1) {
      ctx.addIssue({
        code: "custom",
        message: "multiple location modes",
      });
    }

    if (hasFreeform) {
      if (!value.addressText) {
        ctx.addIssue({
          code: "custom",
          path: ["addressText"],
          message: "addressText is required when lat/lng provided",
        });
      }
      if (value.lat === undefined || value.lng === undefined) {
        ctx.addIssue({
          code: "custom",
          message: "lat and lng are required together",
        });
      }
    }

    if (!hasPlace && !hasSaved && !hasFreeform) {
      // no location is allowed
      return;
    }

    if (value.lat !== undefined && value.lng === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["lng"],
        message: "lng is required when lat provided",
      });
    }
    if (value.lng !== undefined && value.lat === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["lat"],
        message: "lat is required when lng provided",
      });
    }
  });

export const baseSaveEventInputSchema = z.object({
  eventId: z.string().uuid().optional(),
  actorHumanId: z.uuid(),
  title: plainTextRequired(140),
  startsAt: isoDateTimeSchema,
  endsAt: isoDateTimeSchema,
  location: locationSchema,
  locationMode: z.enum(["EXACT", "OBSCURED"]).default("EXACT"),
  /**
   * Public pre-reveal precision under OBSCURED: 100..50,000m obfuscation
   * circle, or null = FULLY HIDDEN (no public map). Ignored for EXACT.
   * SNAPPED UP to the radius ladder before it is stored
   * (`obfuscation-radius-ladder.ts`): a circle is only ever drawn at a rung,
   * and every off-ladder radius would be one more sample of the location.
   */
  locationRadiusMeters: z.coerce
    .number()
    .int()
    .min(MIN_OBFUSCATION_RADIUS_METERS)
    .max(MAX_OBFUSCATION_RADIUS_METERS)
    .transform(snapValidatedObfuscationRadius)
    .nullable()
    .default(500),
  locationLabel: plainTextRequired(200).nullable().default(null),
  timezone: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .optional()
    .refine((value) => {
      if (!value) return true;
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }, "invalid timezone"),
  addressRevealPreset: z
    .enum([
      "IMMEDIATELY",
      "ONE_HOUR_BEFORE",
      "DAY_BEFORE",
      "WEEK_BEFORE",
      "CUSTOM",
      // "Never reveal this address, to anyone." The one preset that resolves
      // a NULL `addressRevealAt` on purpose — see `resolveAddressReveal`.
      "NEVER",
    ])
    .optional(),
  addressRevealAt: isoDateTimeSchema.nullable().optional(),
  // Validate event content JSON using shared schema without leaking zod types across package boundaries.
  // Schema validation + media-embed allowlist re-verification live in the
  // shared event-body-sanitizer so the edit-suggestion paths run the exact
  // same checks (community-managed-event-listings FR-007).
  content: z
    .unknown()
    .optional()
    .superRefine((value, ctx) => {
      if (value === undefined) return;
      const result = validateEventBody(value);
      if (result.ok) return;
      for (const issue of result.issues) {
        ctx.addIssue({
          code: "custom",
          path: issue.path,
          message: issue.message,
        });
      }
    })
    .transform((value) =>
      value === undefined ? undefined : (value as EventBody),
    ),
  heroImageId: z.string().uuid().nullable().optional(),
  ageLimit: z.coerce.number().int().min(0).max(99).nullable().optional(),
  /**
   * Organizer attestation that this event's admission is for INSTRUCTION only
   * (classes / lessons / courses). Drives the Tennessee instruction-only tax
   * exemption. Omitted = leave unchanged (defaults false at creation).
   */
  instructionalAdmission: z.boolean().optional(),
  clientKey: z.string().min(8),
});

/**
 * Optional venue-hierarchy placement on a save (FR-005/FR-011,
 * docs/specs/2026-08-18/completed/venue-hierarchy-and-holds.spec.yaml).
 *
 * Spread into the save-event input schemas that are actually reachable from a
 * placement-aware caller (`saveEventForHuman` / `saveEventForOrg`) rather than
 * onto {@link baseSaveEventInputSchema}: a schema that ACCEPTS these keys but
 * whose use case drops them on the floor is exactly the silent-loss bug this
 * step exists to close.
 *
 * `undefined` = leave the stored value alone (Prisma patch semantics all the
 * way down). Explicit `null` = clear. Both are only meaningful when the save
 * resolves to a linked Place — see {@link resolveVenuePlacement}.
 */
export const venuePlacementInputShape = {
  calendarId: z.uuid().nullable().optional(),
  spaceId: z.uuid().nullable().optional(),
  /**
   * Event-first (venue-confirmation spec "Two entry paths, one request"):
   * what the builder asks the venue for when it names a place AND a
   * calendar. Omitted = PERFORM. RENT / USE additionally need the event's
   * WINDOW (`startsAt` + `endsAt`); a `spaceId` is optional for every intent
   * (ruling 2026-09-22 — the room is chosen at accept/confirm, on the draft
   * event). Ignored (no request) for a venue-owned event, a grant-holder's
   * event, or a calendar that does not accept the intent — see
   * `createBookingRequestFromEvent`.
   */
  bookingIntent: bookingIntentSchema.optional(),
};

/**
 * The event-first booking request on the save output (see
 * `saveEventOutputSchema.bookingRequest`), discriminated on `outcome`.
 * Derived from `CreateBookingRequestFromEventResult`:
 *   · `created` / `existing` — a request exists for this event; here is
 *     who has it.
 *   · `skipped` — the venue's gate walk refused the ask and the save
 *     absorbed it (owner ruling 2026-09-08: the builder must SAY so rather
 *     than save into silence). Only the two gate-walk reasons ride; the
 *     internal "nothing to ask" skips are `null` on the wire.
 */
export const saveEventBookingRequestSchema = z.discriminatedUnion("outcome", [
  z.object({
    /**
     * `"created"` on this save; `"existing"` when a re-save found the request
     * an earlier save created (idempotent on `originEventId`).
     */
    outcome: z.enum(["created", "existing"]),
    id: z.uuid(),
    placeId: z.uuid(),
    /**
     * The venue's display name. Null only on a re-save whose re-found row has
     * lost its denormalized name (the place is gone) — the builder falls back
     * to "the venue".
     */
    placeName: z.string().nullable(),
    /** The request's own intent; on `existing`, a re-save asking RENT still reports the PERFORM request it found. */
    intent: bookingIntentSchema,
    /**
     * True when the place is unclaimed and the request was parked (spec:
     * "venue not yet claimed — we've asked them to"). On an `existing`
     * request this is the row's CURRENT parking state, so a venue that has
     * claimed since the first save reads `false`.
     */
    parked: z.boolean(),
  }),
  z.object({
    outcome: z.literal("skipped"),
    /** `venue_not_accepting` (paused / unverified / no hours / closed night / calendar rejects the intent) or `sender_not_eligible` (no performer mode). */
    reason: z.enum(EVENT_FIRST_ABSORBED_SKIP_REASONS),
    /** The refusal's own error code, e.g. `PLACE_NOT_ACCEPTING_REQUESTS`. */
    code: z.string(),
    /** Its machine message when the code has more than one (`booking_requests_unconfigured`); else the code itself. */
    message: z.string().nullable(),
    /** The venue that refused — so the builder can still name it. */
    placeId: z.uuid(),
    placeName: z.string().nullable(),
    /** What was asked. */
    intent: bookingIntentSchema,
  }),
]);
export type SaveEventBookingRequest = z.infer<typeof saveEventBookingRequestSchema>;

export const saveEventOutputSchema = z.object({
  eventId: z.uuid(),
  status: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED", "CANCELLED", "COMPLETED"]),
  /** Usage count of the auto-created/reused SavedLocation. Present only for freeform address saves. */
  savedLocationUsageCount: z.number().int().optional(),
  /**
   * Booking-hold notifications this save owes (FR-018: a PUBLISHED event
   * moved onto a held calendar+date). Present only on the LIVE return — an
   * idempotent replay carries none, so nothing is sent twice.
   */
  notificationIntents: z.array(bookingHoldNotificationIntentSchema).optional(),
  staffRecipientHint: bookingHoldStaffRecipientHintSchema.nullable().optional(),
  /**
   * Event-first booking-request notifications this save owes (venue-
   * confirmation spec): the venue claim invite when the named place is
   * unclaimed, else the claimed venue's "new request" notice. LIVE return
   * only — a replay carries none. Absent when no request was created.
   */
  bookingRequestNotificationIntents: z
    .array(bookingRequestNotificationIntentSchema)
    .optional(),
  /**
   * Event-first (venue-confirmation spec "UI / Flow › Event builder"): the
   * booking request this save CREATED or FOUND, so the builder can say who
   * the event was sent to — "Sent to The Blue Room for confirmation" / "This
   * venue hasn't claimed its page yet". STAYS ON THE WIRE (it is a fact about
   * the saved event, not a side effect) and is CACHED for idempotent replay
   * for the same reason — see `StoredSaveEventRecord`.
   *
   * REQUIRED: both save entry points (`finalizeSaveEvent` and
   * `finalizeSaveEventInCallerTx`, which share `runSaveEventTxBody` — the only
   * producer) always emit it —
   * `null` when there was nothing to ask (venue-owned, grant-holder, no
   * place, no calendar, no owner); `outcome: "skipped"` when the venue's
   * gates refused the ask (non-accepting calendar, paused / unverified /
   * no hours / closed night, sender not a performer). An idempotency
   * envelope written before this field existed is normalised on replay
   * (see `finalizeSaveEvent`).
   */
  bookingRequest: saveEventBookingRequestSchema.nullable(),
});

/** What transport puts on the wire: the intents + routing hint stay server-side. */
export const saveEventWireOutputSchema = saveEventOutputSchema.omit({
  notificationIntents: true,
  staffRecipientHint: true,
  bookingRequestNotificationIntents: true,
});

export type SaveEventOutput = z.infer<typeof saveEventOutputSchema>;
export type SaveEventWireOutput = z.infer<typeof saveEventWireOutputSchema>;
export type SaveEventDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Optional Ziptax adapter for US sales tax rate lookups by postal code. */
  taxRateLookup?: TaxRateLookupPort | null;
  /**
   * Optional lat/lng → IANA timezone resolver (venue-hierarchy FR-004).
   *
   * A LINKED-VENUE event inherits the zone `upsertPlace` already derived onto
   * `Place.timezone`; this port is what gives a FREEFORM-ADDRESS event the
   * same answer, because its `SavedLocation` has no zone until someone derives
   * one. Same lookup-and-cache lifecycle as `taxRateLookup`: derived once from
   * the coordinates and persisted onto the SavedLocation for reuse.
   *
   * Non-fatal in every failure mode — a missing port, missing coordinates, or
   * a `null`/throwing lookup leaves the zone unresolved and the chain falls
   * through to the platform default. An event save must never fail because tz
   * lookup broke.
   */
  timezoneLookup?: TimezoneLookupPort | null;
  /**
   * Error tracker for the deliberate swallow branch in this module (a throwing
   * `timezoneLookup`). See the repo's Sentry convention: swallowed failures
   * MUST be reported, not just logged.
   */
  reportError?: ReporterPort;
  /**
   * `canManagePlace` — REQUIRED, because two save-time rules are decided by
   * it and an optional dep would decide them by omission
   * (place-address-withholding W1 / N2):
   *   · a place-linked save by someone who can MANAGE the place is the
   *     venue's own word and stamps the venue confirmation
   *     (`venue-manager-stamp.ts`);
   *   · a freeform / saved address within 50 m of a withheld place the saver
   *     manages is refused (`own-withheld-place-guard.ts`).
   * Wire it from `ctx.authz`.
   */
  authz: Pick<AuthZPort, "canManagePlace">;
  /**
   * The search index. Used ONLY when a save of an existing event leaves its
   * public location withheld (event-level OBSCURED / hidden, a new radius, a
   * move onto a withheld venue): the event's document is deleted before
   * commit, fail-closed, and re-indexed after (see `search/privacy-scrub.ts`).
   * Omitted = no index to scrub.
   */
  search?: MultiSearchPort;
};

export type OwnerContext =
  | { kind: "org"; orgId: string }
  | { kind: "human"; humanId: string };

export type NormalizedLocation = SaveEventInput["location"];

/**
 * What the idempotency cache may hold: the wire shape, except that an
 * envelope written before `bookingRequest` existed has no such key. Replays
 * go through `normalizeReplayedSaveEvent`, which defaults it.
 */
type StoredSaveEventResponse = Omit<SaveEventWireOutput, "bookingRequest"> & {
  bookingRequest?: SaveEventBookingRequest | null;
};

interface StoredSaveEventRecord {
  payloadHash: string;
  /**
   * Wire-shaped: a replay must never re-emit the hold / booking-request
   * intents (re-dispatching them re-sends mail). `bookingRequest` is KEPT:
   * it is a fact about the saved event (which request, at which venue),
   * not a side effect, so a replayed save tells the builder the same thing
   * the live one did.
   */
  response: StoredSaveEventResponse;
}

export function ensureEndsAfterStarts(
  startsAt: Date,
  endsAt: Date | null | undefined,
): void {
  if (endsAt && endsAt <= startsAt) {
    throw {
      code: "invalid_input",
      message: "endsAt must be after startsAt",
      issues: [
        {
          code: "custom",
          path: ["endsAt"],
          message: "must be after startsAt",
        },
      ],
    } as const;
  }
}

export function normalizeLocation(
  location: RawLocationInput,
): NormalizedLocation {
  if (location.placeId) {
    return { kind: "place", placeId: location.placeId };
  }

  if (location.savedLocationId) {
    return {
      kind: "saved-location",
      savedLocationId: location.savedLocationId,
    };
  }

  const hasFreeform =
    location.addressText !== undefined &&
    location.lat !== undefined &&
    location.lng !== undefined;

  if (hasFreeform) {
    return {
      kind: "freeform",
      addressText: location.addressText!,
      lat: location.lat!,
      lng: location.lng!,
      locality: location.locality ?? null,
      region: location.region ?? null,
      countryCode: location.countryCode ?? null,
      postalCode: location.postalCode ?? null,
    };
  }

  return { kind: "none" };
}

export async function ensurePlaceAccessibleForOrg(
  placesRepo: PlacesRepo,
  orgId: string,
  placeId: string,
  _logger?: LoggerPort,
): Promise<PlaceRecord> {
  // The rule itself lives in place-access.ts. Owner → its own place (the
  // held-dates settle re-asserts that rule on a loaded row); anyone else →
  // any ACTIVE place, as a third party (venue-confirmation spec).
  return ensureLoadedPlaceAttachable(await placesRepo.getById(placeId), {
    kind: "org",
    orgId,
  });
}

export async function ensurePlaceAccessibleForHuman(
  placesRepo: PlacesRepo,
  humanId: string,
  placeId: string,
  _logger?: LoggerPort,
): Promise<PlaceRecord> {
  return ensureLoadedPlaceAttachable(await placesRepo.getById(placeId), {
    kind: "human",
    humanId,
  });
}

export async function ensureSavedLocationAccessibleForOrg(
  repos: Repos,
  orgId: string,
  savedLocationId: string,
  _logger?: LoggerPort,
): Promise<SavedLocationRecord> {
  const saved = await repos.savedLocations.getAccessibleByOrg({
    id: savedLocationId,
    orgId,
  });
  if (!saved) {
    throw fail("SAVED_LOCATION_NOT_FOUND");
  }
  return saved;
}

export async function ensureSavedLocationAccessibleForHuman(
  repos: Repos,
  humanId: string,
  savedLocationId: string,
  _logger?: LoggerPort,
): Promise<SavedLocationRecord> {
  const saved = await repos.savedLocations.getAccessibleByHuman({
    id: savedLocationId,
    humanId,
  });
  if (!saved) {
    throw fail("SAVED_LOCATION_NOT_FOUND");
  }
  return saved;
}

export async function fetchAndValidateExistingEvent(
  repos: Repos,
  owner: OwnerContext,
  eventId: string,
  logger: LoggerPort | undefined,
): Promise<EventRecord> {
  const existingEvent = await repos.events.getById(eventId);

  if (!existingEvent) {
    throw fail("EVENT_NOT_FOUND");
  }

  if (
    existingEvent.status !== "DRAFT" &&
    existingEvent.status !== "PUBLISHED"
  ) {
    throw fail("EVENT_NOT_EDITABLE");
  }

  if (owner.kind === "org") {
    if (existingEvent.orgId !== owner.orgId) {
      throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "event" } });
    }
  } else if (existingEvent.humanId !== owner.humanId) {
    throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "event" } });
  }

  return existingEvent;
}

export type FinalizeParams = {
  owner: OwnerContext;
  actorHumanId: string;
  eventId: string | null;
  existingEvent: EventRecord | null;
  title: string;
  startsAt: Date;
  endsAt: Date;
  location: NormalizedLocation;
  locationMode?: "EXACT" | "OBSCURED";
  locationRadiusMeters?: number | null;
  locationLabel?: string | null;
  addressRevealPreset?: AddressRevealPreset | undefined;
  addressRevealAt?: Date | null | undefined;
  timezone?: string | null | undefined;
  content?: EventBody | undefined;
  heroImageId?: string | null;
  ageLimit?: number | null;
  /** Organizer attestation: admission is instruction-only (TN tax exemption). */
  instructionalAdmission?: boolean | undefined;
  /**
   * Venue-hierarchy placement (FR-005/FR-011). `undefined` = untouched,
   * `null` = clear. Validated INSIDE the save transaction by
   * {@link resolveVenuePlacement}.
   */
  calendarId?: string | null | undefined;
  spaceId?: string | null | undefined;
  /** Event-first intent (see {@link venuePlacementInputShape}). Default PERFORM. */
  bookingIntent?: BookingIntentInput | undefined;
  clientKey: string;
};

/**
 * Input to {@link finalizeSaveEventInCallerTx}: {@link FinalizeParams} plus the
 * CALLER'S already-open transaction (FR-004,
 * docs/specs/2026-09-05/completed/booking-accept-is-the-mint-point.spec.md).
 *
 * The save runs every statement against THIS handle and never calls
 * `deps.repos.tx`. `repos.tx` always opens a FRESH interactive transaction off
 * the root Prisma client, so calling it from inside one opens a second
 * connection that blocks on the first's advisory locks — nesting is a hang, not
 * a nest. {@link finalizeSaveEvent} — no `tx` anywhere in its signature — stays
 * byte-identical to the standalone save it has always been.
 *
 * `tx` is REQUIRED here, not optional, and the two entry points are two named
 * FUNCTIONS rather than two overloads of one. Both facts are load-bearing: the
 * shapes have different RETURN types, and TypeScript would bind the first
 * applicable overload for a named variable, silently handing back a
 * standalone-typed result while running the caller-tx branch. See the note on
 * {@link finalizeSaveEvent} for the measured failure.
 *
 * FIVE THINGS A CALLER OWNS:
 *
 *  1. POST-COMMIT WORK IS NOT RUN — it is RETURNED. When this function
 *     returns, the caller's transaction has not committed, so the steps that
 *     must not straddle a commit (today: {@link assignSlugOnCreate}, which
 *     takes its OWN transaction) cannot run here. They come back as
 *     {@link SaveEventDeferredWork} on the result; the caller invokes
 *     `runAfterCommit()` after ITS commit.
 *
 *  2. THERE IS NO INNER IDEMPOTENCY ENVELOPE (FR-005). No `get` replay
 *     short-circuit, no `begin`, no `commit`, no `fail`. The caller owns the
 *     one envelope wrapping the whole operation — two nested envelopes over
 *     one transaction is a deadlock waiting to be discovered in production.
 *     Nothing else in the save depends on the envelope having run: it gates
 *     only the replay return and the cached response.
 *
 *  3. THE CALLER PREPARES THE TAX RATE — see {@link preparedTaxRate}.
 *
 *  4. LOCK ORDER. Take the hold-line advisory locks FIRST, in the global
 *     sorted order (`lockLines` / `sortLineKeys`,
 *     `booking-holds/_shared/hold-line.ts`), and only then call this. The save
 *     then takes row locks in the order its body writes them:
 *
 *       Event (`upsertDraft`)
 *         → Seat (`materializeSections`)
 *         → SavedLocation (freeform branch: `create` for a new address, else
 *           `incrementUsage` on the row it reuses)
 *         → Event (`linkSavedLocation`)
 *         → SavedLocation (`incrementUsage`, saved-location kind)
 *         → Place OR SavedLocation (`commitPreparedEventTaxRate` →
 *           a point re-read, then the compare-and-set
 *           `fillTaxRateIfUnset` on whichever row `cacheTarget` names — a
 *           place-linked save locks Place here, a freeform / saved-location
 *           save locks SavedLocation and never touches Place at all)
 *         → Event (`updateTaxRate`, `setVenueConfirmation`)
 *         → BookingRequest (+ its thread rows and audit) — THIRD-PARTY ARM
 *           ONLY: a place-linked save whose owner is neither the venue nor a
 *           grant-holder runs `createBookingRequestFromEvent` →
 *           `writeBookingRequestInTx`, which does `bookingRequests.create`
 *           plus system thread entries
 *         → ResourceUsage (`incrementResourceUsage`, LAST — `enforceQuota` at
 *           the top only READS, via `getEffectiveQuota`)
 *
 *     Every one of those is now held for the CALLER'S whole transaction rather
 *     than just the save's, so a venue saving two events at once (Place) and an
 *     org near its event quota (ResourceUsage) both serialize for longer.
 *
 *     LATENT, and this is the one FR-006's caller walks into: that
 *     BookingRequest write is reached whenever the save is place-linked and the
 *     owner is a THIRD PARTY to the place. A caller that already holds a
 *     BookingRequest row lock — an accept, which locks the request it is
 *     accepting — and then passes a place-linked event whose owner is a third
 *     party to that place takes the lock a second time inside this save. Same
 *     transaction, so it is re-entrant rather than a deadlock, but the row set
 *     the caller thought it had bounded is not the row set it holds. Know which
 *     trust arm your mint lands in (`classifyBuilderVenueTrust`) before you
 *     reason about the caller's lock footprint.
 *
 *     LATENT, worth knowing before FR-003 lands: the FR-018 held-dates settle
 *     inside the body takes `lockLines` of its OWN, but it is gated on
 *     `existingEvent && status === "PUBLISHED"`. The accept mint passes
 *     `existingEvent: null`, so it cannot fire outside the caller's pre-locked
 *     set. A caller that passes an EXISTING PUBLISHED event (FR-003's legacy
 *     path) must widen its pre-lock set to cover the settle's lines too, or it
 *     takes a line lock out of order and can deadlock.
 *
 *  5. THE WRAPPERS' CHECKS DO NOT RUN. This is the shared body, not the use
 *     case: `saveEventForOrg` / `saveEventForHuman` are what run
 *     {@link ensurePlaceAccessibleForOrg} / {@link ensurePlaceAccessibleForHuman}
 *     (the attach gate), {@link fetchAndValidateExistingEvent} (the ownership
 *     check), {@link ensureEndsAfterStarts}, and the Zod parse that sanitizes
 *     free text through `plainTextRequired` (title, locationLabel). Inside the
 *     body only {@link resolveVenuePlacement} enforces anything cross-entity,
 *     and only for Calendar/Space-vs-Place; NOTHING here checks that
 *     `params.owner` may attach to `params.location.placeId`. A direct caller
 *     owns all four. FR-006 plans to mint under a counterparty who is NOT the
 *     actor, which is exactly the case where "the wrapper did it" stops being
 *     true — so the accept path must assert place authority itself.
 *
 * Not a `repos` whose `.tx` is a passthrough shim: that leaves the callee
 * believing it owns a transaction it does not (spec FR-004, explicit).
 */
export type FinalizeSaveEventInCallerTxParams = FinalizeParams & {
  tx: TxRepos;
  /**
   * The admission tax rate the CALLER resolved before opening its transaction.
   *
   * P-1 moved `prepareEventTaxRate` OUT of the save transaction because on a
   * cache miss it reaches the tax provider — in production a live HTTP call to
   * ZipTax with a 5-second timeout. A caller that already holds a transaction
   * has no "before the transaction" left for this save to use, so resolving it
   * here would put that call straight back inside a transaction — now one
   * holding advisory locks on hold lines. So the caller does it, before it
   * opens the transaction, and hands the result in:
   *
   * ```ts
   * const prepared = await prepareEventTaxRate(
   *   { taxRateLookup, clock, reportError },
   *   repos,
   *   saveEventTaxRateLocationRef(location, existingFreeformSavedLocation),
   *   logger,
   * );
   * ```
   *
   * BUILD THE REF WITH {@link saveEventTaxRateLocationRef}, NOT
   * `eventTaxRateLocationRef`. They are not interchangeable: the latter builds
   * from an event's PERSISTED columns and its inline arm demands a postal code
   * AND a country, so a freeform address carrying only a country and a region
   * (a Canadian one, say) resolves to `null` there and silently collects no
   * tax. `saveEventTaxRateLocationRef` builds from the NORMALIZED location the
   * save is about to write and tolerates the same nulls the row does, leaving
   * the provider gate where it belongs (inside `lookupAdmissionTaxRate`).
   *
   * REQUIRED whenever this save would restamp the rate — a new event, a
   * changed location, an event with no rate yet, or a freeform address not yet
   * saved. Missing it in that case is a PROGRAMMER ERROR and throws, naming the
   * problem; the provider is never called as a fallback. When no restamp is
   * needed the save leaves the stored rate alone exactly as it does without a
   * caller tx, and any value passed here goes unused.
   */
  preparedTaxRate?: PreparedEventTaxRate;
  /**
   * The place the actor MANAGES (`probeManagedPlace`, run by the CALLER before
   * it opened its transaction — the same "outside the tx" reason as
   * {@link preparedTaxRate}). Omitted = none: no W1 manager stamp. The
   * booking accept mints under the VENUE party (venue-owned, owner arm), so
   * it has nothing to pass.
   */
  managedPlaceId?: string | null;
};

/**
 * A post-commit step a caller-tx save owes once the CALLER'S transaction has
 * committed. Named rather than anonymous so a caller (and a test) can see what
 * it is being handed.
 *
 * · `assign-slug-on-create` — {@link assignSlugOnCreate}. Deliberately outside
 *   the save's transaction even on the standalone path (a statement that fails
 *   AT the database aborts the Postgres transaction and Postgres then answers
 *   COMMIT with ROLLBACK and no error, so a catch INSIDE a transaction cannot
 *   do this job at all — read the long comment at its call site). Present only
 *   on a CREATE.
 */
export type SaveEventDeferredStep = "assign-slug-on-create";

/**
 * The work {@link finalizeSaveEventInCallerTx} could not do because the
 * caller's transaction had not committed yet. Run it AFTER the commit.
 * ({@link finalizeSaveEvent} never produces any: it commits its own
 * transaction and then does its post-commit work itself.)
 *
 * `runAfterCommit` is best-effort by construction — every step inside it is
 * already best-effort on the standalone path (`assignSlugOnCreate` swallows and
 * reports its own failures), so it does not throw and must not be treated as
 * part of the atomic unit. Skipping it entirely leaves exactly the state the
 * standalone path leaves when the process dies between commit and slug: a
 * slugless event, which `apps/api/src/scripts/backfill/backfill-event-slugs.ts` repairs.
 *
 * Calling `runAfterCommit` TWICE is safe but not free: `generateEventSlug`
 * reuses the stored `shortId` (`ensureShortId`), so the second run derives the
 * identical slug and the assign is a no-op write — but `assignSlugOnCreate`
 * logs its audit row unconditionally, so a duplicate `event.slug_assigned`
 * entry appears on the event's trail. Drain it once.
 */
export type SaveEventDeferredWork = {
  /** What `runAfterCommit` will do. Empty on an update (nothing is owed). */
  readonly steps: readonly SaveEventDeferredStep[];
  runAfterCommit(): Promise<void>;
};

/** {@link finalizeSaveEventInCallerTx}'s return: the save's output, plus the
 * post-commit work the caller must drain once ITS transaction commits. */
export type FinalizeSaveEventInCallerTxResult = SaveEventOutput & {
  deferred: SaveEventDeferredWork;
};

/** The subset of `SaveEventInput` {@link resolveVenuePlacement} contributes. */
type ResolvedVenuePlacement = Pick<
  Partial<SaveEventInput>,
  "calendarId" | "spaceId"
>;

/**
 * Resolve the placement columns (`Event.calendarId` / `Event.spaceId`) this save
 * should write, enforcing venue-hierarchy invariants (FR-005/FR-011).
 *
 * MUST be called with a TRANSACTIONAL `tx` from the same `repos.tx()` that
 * persists the draft: the checks below are read-then-write, and cross-place
 * isolation is a core-layer invariant the schema does not enforce (a Calendar
 * / Space of ANOTHER place is a perfectly valid FK target).
 *
 * Rules:
 *  - Placement is only meaningful for an event linked to a Place. A non-null
 *    `calendarId` / `spaceId` on a freeform-address, saved-location, or
 *    no-location save is REJECTED with `invalid_input` rather than silently
 *    dropped — a caller sending placement for a placeless event has a bug and
 *    deserves to hear about it.
 *  - The calendar and the space must belong to THAT place. A cross-place id is
 *    reported as `CALENDAR_NOT_FOUND` / `SPACE_NOT_FOUND`, indistinguishable
 *    from a missing row (the IDOR posture the ports document).
 *  - A RETIRED space must not receive new events; it is reported as
 *    `SPACE_NOT_FOUND` too (same "not available to you" posture — retiring a
 *    space is precisely how a venue removes it from scheduling, and there is no
 *    separate user-facing code for it).
 *  - `calendarId` without `spaceId` leaves the space alone. We never GUESS a
 *    space here: the Step-8 UI only auto-picks when a calendar has exactly ONE
 *    active space, and that decision belongs to the UI, not the save path.
 *    ONE exception, and it only ever CLEARS: when the save moves the event to
 *    a DIFFERENT calendar and the room it is already in is not on that
 *    calendar, the room is dropped rather than left pointing across streams —
 *    see {@link staleSpaceMustBeCleared} for why that lives here. A room the
 *    new calendar does own is preserved, so a venue's deliberate choice at
 *    accept survives an organizer's re-save.
 *  - When this save MOVES the event to a different place (or off a place
 *    entirely), any unspecified side is force-cleared: a Space/Calendar of the
 *    OLD venue must never survive on an event that has left it.
 */
export async function resolveVenuePlacement(
  tx: TxRepos,
  params: {
    calendarId: string | null | undefined;
    spaceId: string | null | undefined;
    location: NormalizedLocation;
    existingEvent: EventRecord | null;
  },
): Promise<ResolvedVenuePlacement> {
  const placeId =
    params.location.kind === "place" ? params.location.placeId : null;
  const wantedCalendarId = params.calendarId ?? null;
  const wantedSpaceId = params.spaceId ?? null;

  if (
    (wantedCalendarId !== null || wantedSpaceId !== null) &&
    placeId === null
  ) {
    throw {
      code: "invalid_input",
      message: "a calendar or space needs a linked place",
      issues: [
        {
          code: "custom",
          path: [wantedCalendarId !== null ? "calendarId" : "spaceId"],
          message: "requires location.placeId",
        },
      ],
    } as const;
  }

  if (wantedCalendarId !== null) {
    const calendar = await tx.calendars.findById(wantedCalendarId);
    if (!calendar || calendar.placeId !== placeId) {
      throw fail("CALENDAR_NOT_FOUND");
    }
  }

  if (wantedSpaceId !== null) {
    const space = await tx.spaces.findById(wantedSpaceId);
    if (!space || space.placeId !== placeId || space.status !== "ACTIVE") {
      throw fail("SPACE_NOT_FOUND");
    }
  }

  // The event left the place its stored placement belongs to → both columns
  // are stale, so write both (whatever the caller specified, else null).
  //
  // COUPLING — read before adding a caller. `placeId` above is null for BOTH
  // "this save moved the event off its place" and "this save said nothing about
  // location", because `locationSchema` carries `.default({})` and
  // `normalizeLocation` collapses an omitted `location` to `kind: "none"`. The
  // two are indistinguishable by the time we get here, so a caller that
  // legitimately OMITS `location` on a place-linked event would silently clear
  // its calendar/space.
  //
  // That is safe today only because both callers — `saveEventForOrg` and
  // `saveEventForHuman` (tRPC `events.createEventForOrg` /
  // `events.createEventForHuman`) — send the full event on every save, always
  // re-sending `location`. Making this robust needs an explicit "location was
  // supplied" signal, which means dropping `.default({})` at the parse
  // boundary and threading the flag through both use cases — a real semantic
  // change to `location: {}` (today: "no location", and pinned as such), not a
  // tidy-up. Do it deliberately, with tests, or keep re-sending location.
  const placeChanged =
    params.existingEvent !== null &&
    (params.existingEvent.placeId ?? null) !== placeId;

  const clearStaleSpace = await staleSpaceMustBeCleared(tx, {
    placeId,
    placeChanged,
    wantedCalendarId,
    spaceSupplied: params.spaceId !== undefined,
    existingEvent: params.existingEvent,
  });

  return {
    ...(params.calendarId !== undefined || placeChanged
      ? { calendarId: wantedCalendarId }
      : {}),
    ...(params.spaceId !== undefined || placeChanged
      ? { spaceId: wantedSpaceId }
      : clearStaleSpace
        ? { spaceId: null }
        : {}),
  };
}

/**
 * "Does this save MOVE the event to a calendar that does not own the room it
 * is already in?" — the calendar/space coherence guard for the omitted-space
 * case (owner ruling 2026-09-22).
 *
 * WHY THIS EXISTS. Since the room came off the booking request, the event
 * builder no longer sends `spaceId` at all; it used to auto-fill the selected
 * calendar's first room, so switching calendars re-pointed the space. Omission
 * is patch semantics — "leave `Event.spaceId` as it is" — and that reading is
 * deliberate: a room the VENUE assigned at accept must survive an organizer's
 * re-save. But it lets an organizer switch the cascade from MAIN to SIDE and
 * leave the event sitting in MAIN's room, which nothing else rejects:
 * `resolveVenuePlacement` validates a space against the PLACE, never against
 * the calendar. Occupancy reads would then show the event in a room belonging
 * to a different calendar.
 *
 * WHY HERE and not at accept/confirm: the incoherence is CREATED by this save,
 * and accept/confirm only covers events that arrived via a booking request —
 * an organizer editing an event directly never passes through it. The drift
 * guard lives with the data.
 *
 * NARROW BY CONSTRUCTION. It fires only when the save WRITES a non-null
 * calendar that differs from the stored one, says nothing about the space, and
 * the event already has one. Everything else — the calendar unchanged, the
 * space explicitly supplied, `placeChanged` (which force-clears both sides
 * already), an event with no room — returns false without a query, so the
 * common save pays nothing.
 *
 * MEMBERSHIP, NOT STATUS. A joined-but-RETIRED room counts as "on the
 * calendar" and is PRESERVED. `CalendarWithSpacesRow.spaces` deliberately
 * includes retired joins, the event is still in a room that calendar owns, and
 * occupancy stays coherent — the narrow thing this guards. Clearing on retired
 * would mean a venue retiring a room silently wipes assignments off events
 * whose organizer happens to switch calendars, which is a bigger surprise than
 * the drift. (An explicitly SUPPLIED retired space is still `SPACE_NOT_FOUND`
 * above; that path is unchanged.)
 */
async function staleSpaceMustBeCleared(
  tx: TxRepos,
  params: {
    placeId: string | null;
    placeChanged: boolean;
    wantedCalendarId: string | null;
    spaceSupplied: boolean;
    existingEvent: EventRecord | null;
  },
): Promise<boolean> {
  if (params.spaceSupplied || params.placeChanged) return false;
  if (params.placeId === null || params.wantedCalendarId === null) return false;

  const existing = params.existingEvent;
  const existingSpaceId = existing?.spaceId ?? null;
  if (existing === null || existingSpaceId === null) return false;
  if ((existing.calendarId ?? null) === params.wantedCalendarId) return false;

  const calendars = await tx.calendars.listByPlace(params.placeId);
  const target = calendars.find((c) => c.id === params.wantedCalendarId);
  // A calendar that vanished between the `findById` above and here cannot be
  // shown to own the room, so the room goes. (`findById` already proved it
  // existed and belonged to the place; this is the paranoid branch.)
  return !target?.spaces.some((s) => s.id === existingSpaceId);
}

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const ONE_WEEK_MS = 7 * ONE_DAY_MS;

/**
 * Resolve `(addressRevealPreset, addressRevealAt)` for a save-event call.
 *
 * Rules:
 *  - If `locationMode === "EXACT"`, both fields are silently nulled.
 *  - `NEVER` resolves `{ preset: "NEVER", at: null }` — the organizer's
 *    explicit choice that this address is never revealed, to anyone, ever.
 *    Both redactors already fail CLOSED on a null reveal date, so this needs
 *    no new read-path behaviour; what it adds is that the null is now
 *    READABLE as intent rather than indistinguishable from a broken row.
 *  - Every OTHER preset resolves a non-null `addressRevealAt`:
 *     - preset omitted + new event → default `DAY_BEFORE`.
 *     - preset omitted + existing event with a stored preset → recompute from
 *       the (possibly updated) `startsAt`. Covers reschedules without the
 *       caller re-sending the preset.
 *     - preset omitted + existing event with a stored reveal date but no
 *       preset (legacy row) → preserve the stored date as CUSTOM.
 *     - `IMMEDIATELY` → `now` (reveal right away — already passed by read
 *       time, never null).
 *     - non-CUSTOM presets → computed from `startsAt` (caller-provided
 *       `addressRevealAt` is ignored).
 *     - `CUSTOM` → caller-provided `addressRevealAt` (falling back to the
 *       stored value); a CUSTOM preset with no resolvable date is rejected.
 */
export function resolveAddressReveal(params: {
  locationMode: "EXACT" | "OBSCURED";
  startsAt: Date;
  preset: AddressRevealPreset | undefined;
  addressRevealAt: Date | null | undefined;
  existingEvent: EventRecord | null;
  /** Save time — anchors the IMMEDIATELY preset. */
  now: Date;
}): { preset: AddressRevealPreset | null; at: Date | null } {
  if (params.locationMode === "EXACT") {
    return { preset: null, at: null };
  }

  let preset = params.preset;
  if (preset === undefined) {
    if (params.existingEvent?.addressRevealPreset) {
      // Recompute against the (possibly new) startsAt using the existing preset.
      preset = params.existingEvent.addressRevealPreset;
    } else if (params.existingEvent?.addressRevealAt) {
      // Legacy row with a stored reveal date but no preset — preserve the
      // stored date as an explicit CUSTOM choice.
      preset = "CUSTOM";
    } else {
      // New OBSCURED event (or legacy row with neither field) — default
      // preset is DAY_BEFORE.
      preset = "DAY_BEFORE";
    }
  }

  switch (preset) {
    case "NEVER":
      // The ONE member that legitimately produces a null reveal date. Stored
      // ALONGSIDE the null so the pair reads as a choice:
      //   (OBSCURED, NEVER, null) → deliberate, locked forever;
      //   (OBSCURED, null,  null) → still a data-integrity defect.
      return { preset, at: null };
    case "IMMEDIATELY":
      // A reveal date is mandatory for OBSCURED — "immediately" anchors to
      // the save time rather than the legacy null-means-immediate sentinel.
      return { preset, at: params.now };
    case "ONE_HOUR_BEFORE":
      return { preset, at: new Date(params.startsAt.getTime() - ONE_HOUR_MS) };
    case "DAY_BEFORE":
      return { preset, at: new Date(params.startsAt.getTime() - ONE_DAY_MS) };
    case "WEEK_BEFORE":
      return { preset, at: new Date(params.startsAt.getTime() - ONE_WEEK_MS) };
    case "CUSTOM": {
      const at =
        params.addressRevealAt ?? params.existingEvent?.addressRevealAt ?? null;
      if (at === null) {
        throw {
          code: "invalid_input",
          message: "addressRevealAt is required for the CUSTOM reveal preset",
          issues: [
            {
              code: "custom",
              path: ["addressRevealAt"],
              message: "required for CUSTOM preset",
            },
          ],
        } as const;
      }
      return { preset, at };
    }
    default: {
      // Exhaustiveness guard.
      const _exhaustive: never = preset;
      return _exhaustive;
    }
  }
}

/**
 * Derive an IANA timezone from coordinates, the way `upsertPlace` does.
 *
 * TOTALLY non-fatal, by design — an event save must never fail because tz
 * lookup broke. Every degraded path returns `null` and the caller falls
 * through to the platform default:
 *   - no port wired (older composition roots, tests),
 *   - no coordinates,
 *   - the library returning `null` for an unknown/ocean point,
 *   - the library THROWING on out-of-range coordinates. `tz-lookup` throws
 *     rather than returning a fallback, and while the adapter already maps
 *     that to `null`, this guard does not assume a well-behaved adapter.
 *
 * The throw branch is a deliberate swallow, so it is REPORTED (repo Sentry
 * convention), and the reporter itself is guarded — a throwing reporter must
 * never escape and fail the save.
 */
function deriveTimezoneFromCoordinates(
  deps: SaveEventDeps,
  logger: LoggerPort | undefined,
  lat: number | null | undefined,
  lng: number | null | undefined,
  logContext: Record<string, unknown>,
): string | null {
  if (!deps.timezoneLookup || lat == null || lng == null) {
    return null;
  }
  try {
    return deps.timezoneLookup(lat, lng);
  } catch (error) {
    try {
      deps.reportError?.(error, {
        tags: { useCase: "saveEvent", stage: "timezone_lookup" },
        extra: { ...logContext, lat, lng },
      });
    } catch {
      // Reporting is best-effort — a throwing reporter must never escape the
      // swallow branch and fail the event save.
    }
    logger?.error("timezone_lookup_failed", {
      ...logContext,
      error: describeError(error),
    });
    return null;
  }
}

/**
 * Persist an event save, STANDALONE — the save owns its own idempotency
 * envelope, resolves the tax rate before opening its own transaction, commits,
 * and does its own post-commit work. Every production caller today.
 *
 * TWO ENTRY POINTS, TWO NAMES — NOT ONE OVERLOADED NAME. To join a transaction
 * the caller already opened, call {@link finalizeSaveEventInCallerTx} instead;
 * it takes {@link FinalizeSaveEventInCallerTxParams} and returns
 * {@link FinalizeSaveEventInCallerTxResult}, which carries the deferred
 * post-commit work.
 *
 * This WAS a single overloaded `finalizeSaveEvent` discriminated on an optional
 * `tx`, and that shape is unsafe in a way that is invisible until it ships.
 * TypeScript binds the FIRST applicable overload, and the caller-tx params are
 * a SUBTYPE of the standalone ones, so a named VARIABLE (which gets no
 * excess-property check, unlike a fresh object literal) binds the standalone
 * overload even while carrying a live `tx`. Measured, not theorised:
 * `declare const p: FinalizeSaveEventInCallerTxParams; (await
 * finalizeSaveEvent(deps, logger, p)).deferred` failed with
 * `TS2339: Property 'deferred' does not exist`. The call compiles, the
 * caller-tx branch runs, and `runAfterCommit()` is never called because the
 * type says there is nothing to call — minting a draft with `slug === null`,
 * whose public page 500s (see `assign-slug-on-create.ts`) on exactly the
 * "Open preview in a new tab" link the builder shows pre-publish. Silent.
 *
 * Reordering the overloads does not fix it: a variable typed with
 * `tx: TxRepos | undefined` is assignable to {@link FinalizeParams} and binds
 * the standalone signature under either ordering. Two names is the only shape
 * where a caller cannot pick the wrong one by accident.
 *
 * The split leaves ONE residual that no type can close, which is what the
 * runtime guard below is for — see it for the reason.
 */
export async function finalizeSaveEvent(
  deps: SaveEventDeps,
  logger: LoggerPort | undefined,
  params: FinalizeParams,
): Promise<SaveEventOutput> {
  // ── Wrong entry point (programmer error) ─────────────────────────────────
  // TypeScript cannot catch this. `FinalizeSaveEventInCallerTxParams` is an
  // intersection, hence a structural SUBTYPE of `FinalizeParams`, and a named
  // variable gets no excess-property check — so caller-tx params handed to this
  // function compile with ZERO errors (measured). This function knows nothing
  // about `tx`, so it would ignore the live handle and call `deps.repos.tx`,
  // opening a SECOND transaction while the caller still holds one. The adapter
  // always opens a fresh transaction off the root client, so that second one
  // blocks on the first's advisory locks — under the hold-line contention the
  // accept path creates, it waits out `maxWait` (10s) and dies on a Prisma
  // timeout, having taken a connection with it.
  //
  // Loud rather than silent, which is why it is a guard and not a redesign. It
  // is checked FIRST, before the clock read and before any I/O, so a mis-dialled
  // call costs nothing. NO SYMMETRIC GUARD on `finalizeSaveEventInCallerTx`:
  // `tx` is REQUIRED in its params, so its absence is already a compile error.
  if ("tx" in params) {
    throw new Error(
      "finalizeSaveEvent: called with a `tx` — these are " +
        "`FinalizeSaveEventInCallerTxParams`, which belong to " +
        "`finalizeSaveEventInCallerTx`. This function opens its OWN " +
        "transaction, so it would ignore your handle and nest: the second " +
        "transaction blocks on the advisory locks the first holds and times " +
        "out. Call `finalizeSaveEventInCallerTx` instead, and run the " +
        "`deferred` work it returns after your commit.",
    );
  }

  const createdAt = deps.clock.now();

  const payloadHash = buildPayloadHash({
    eventId: params.eventId,
    actorHumanId: params.actorHumanId,
    owner: params.owner,
    title: params.title,
    startsAt: params.startsAt,
    endsAt: params.endsAt,
    location: params.location,
    content: params.content,
    calendarId: params.calendarId,
    spaceId: params.spaceId,
    bookingIntent: params.bookingIntent,
  });

  const idemKey =
    params.owner.kind === "org"
      ? `saveEventForOrg:${params.actorHumanId}:${params.owner.orgId}:${params.eventId ?? "new"}:${params.clientKey}`
      : `saveEventForHuman:${params.owner.humanId}:${params.eventId ?? "new"}:${params.clientKey}`;

  const replay = await deps.idempotency.get<StoredSaveEventRecord>(idemKey);
  if (replay) {
    if (replay.payloadHash !== payloadHash) {
      throw fail("IDEMPOTENCY_KEY_CONFLICT");
    }
    return normalizeReplayedSaveEvent(replay.response);
  }

  // ── N2: an address that is the saver's own withheld place ──────────────
  // Read-only, and BEFORE the idempotency claim, so a refusal claims nothing
  // (same position as the wrappers' attach gate). See the guard's doc.
  await ensureSaveAddressIsNotOwnWithheldPlace(deps, params);

  const acquired = await deps.idempotency.begin(idemKey, 120);
  if (!acquired) {
    const afterWait =
      await deps.idempotency.get<StoredSaveEventRecord>(idemKey);
    if (afterWait) {
      if (afterWait.payloadHash !== payloadHash) {
        throw fail("IDEMPOTENCY_KEY_CONFLICT");
      }
      return normalizeReplayedSaveEvent(afterWait.response);
    }
    throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
  }

  try {
    // A freeform address is normalized into a SavedLocation owned by the
    // event's owner. The owner key is pure, so it is derived once here and
    // shared by the pre-tx tax resolution and the tx body below.
    const { ownerType: freeformOwnerType, ownerId: freeformOwnerId } =
      freeformOwnerKey(params.owner);

    // ── Admission tax rate: RESOLVE here, STAMP inside the tx (P-1) ───────
    // On a cache miss `prepareEventTaxRate` reaches the tax provider — in
    // production a live HTTP call to ZipTax with a 5s timeout. That call used
    // to run INSIDE the transaction below, holding a Postgres connection (and
    // `repos.tx`'s fixed 30s budget) open across a third-party round trip.
    // It runs here instead, after the idempotency claim (a replayed clientKey
    // returns above and never reaches it) and before any connection is held.
    //
    // Reads only. Every write the resolution produces — the fresh rate cached
    // onto the Place / SavedLocation, the stamp on the Event — happens inside
    // the transaction through `commitPreparedEventTaxRate`, so a rolled-back
    // save leaves no half-written cache behind. That is the deliberate split:
    // HTTP out here, DB writes in there.
    //
    // This read holds NO lock, so the row can change before the transaction
    // writes: `upsertPlace` can move the venue and cache the new address's
    // rate, or a checkout's self-heal can fill an empty cache. The in-tx write
    // is therefore conditional (cache filled only while still empty and still
    // at the looked-up address) and the stamp is re-checked against the row
    // under the place-location lock — see `commitPreparedEventTaxRate`.
    //
    // The freeform SavedLocation is looked up here too, because the ref
    // depends on it: an address that is already saved resolves through its
    // row (a cached rate wins, no provider call); one that is not yet saved
    // resolves INLINE from the typed address — the same columns `upsertDraft`
    // copies onto the event — and the tx caches the fresh answer onto the row
    // it mints. The tx repeats this read as its authoritative one; this copy
    // only decides the ref and the gate.
    //
    // Same gate as before ("don't clobber a good rate with a transient
    // null"): resolve only when the location changed or the event has no rate
    // at all, so a provider failure on an unrelated edit can never null out an
    // already-collected rate. A freeform address with no SavedLocation yet
    // ALWAYS counts as changed — the row about to be minted cannot be the one
    // the event is linked to — which is what the in-tx gate concluded when it
    // compared against the freshly minted id.
    const preTxFreeformSavedLocation: SavedLocationRecord | null =
      params.location.kind === "freeform" && params.location.addressText
        ? await deps.repos.savedLocations.findByOwnerAndAddress({
            ownerType: freeformOwnerType,
            ownerId: freeformOwnerId,
            address: params.location.addressText,
          })
        : null;
    const mintsFreeformSavedLocation =
      params.location.kind === "freeform" &&
      Boolean(params.location.addressText) &&
      preTxFreeformSavedLocation === null;
    const taxRestampNeeded =
      params.existingEvent?.admissionTaxRateBps == null ||
      mintsFreeformSavedLocation ||
      didLocationChange(
        params.existingEvent,
        params.location,
        preTxFreeformSavedLocation?.id ?? null,
      );
    const preparedTaxRate: PreparedEventTaxRate | null = taxRestampNeeded
      ? await prepareEventTaxRate(
          {
            taxRateLookup: deps.taxRateLookup,
            clock: deps.clock,
            reportError: deps.reportError,
          },
          deps.repos,
          saveEventTaxRateLocationRef(
            params.location,
            preTxFreeformSavedLocation,
          ),
          logger,
          // `eventId` is null on create, so a pre-tx lookup failure for a new
          // event would be uncorrelatable without the owner and the
          // idempotency key (which carries the clientKey).
          {
            eventId: params.eventId,
            ownerKind: params.owner.kind,
            ownerId: freeformOwnerId,
            idemKey,
          },
        )
      : null;

    // W1: does the ACTOR manage the place this save attaches? Probed here,
    // before the transaction (see `SaveEventTxContext.managedPlaceId`).
    const managedPlaceId =
      params.location.kind === "place"
        ? await probeManagedPlace(deps.authz, {
            actorHumanId: params.actorHumanId,
            placeId: params.location.placeId,
          })
        : null;

    let searchScrubbed = false;
    let searchMarked = false;
    const result = await deps.repos.tx(async (tx) => {
      const lockedBefore = { row: null as EventRecord | null };
      const saved = await runSaveEventTxBody(deps, logger, params, tx, {
        createdAt,
        freeformOwnerType,
        freeformOwnerId,
        preparedTaxRate,
        managedPlaceId,
        lockedBefore,
      });
      // ── Search privacy scrub: the LAST step before commit ──────────────
      // An edit that leaves the event's public location withheld deletes its
      // search document here, or fails the save (fail-closed, see
      // `search/privacy-scrub.ts`). Event saves do not otherwise touch the
      // index, so without this an event switched to hidden kept its old pin
      // in search until the nightly reindex. Create has no document yet.
      searchScrubbed = false;
      searchMarked = false;
      if (params.existingEvent) {
        const after = await tx.events.getById(saved.eventId);
        if (after) {
          // A PUBLISHED event's document shows most of what a save can change
          // (title, dates, location, summary, tags, tiers). Mark it in this
          // transaction so the refresh survives a failed or starved
          // post-commit reindex (`search/search-reindex-marks.ts`). A draft
          // has no document.
          if (after.status === "PUBLISHED") {
            await markForSearchReindex(
              tx,
              [{ kind: "event", id: after.id }],
              deps.clock.now(),
            );
            searchMarked = true;
          }
          searchScrubbed = await scrubEventSearchDocIfWithheld({
            search: searchForTx(deps.search, tx),
            places: tx.places,
            // The row as it stood just before THIS write, locked; falls back
            // to the pre-tx read only if the row vanished in between.
            before: lockedBefore.row ?? params.existingEvent,
            after,
            useCase: "saveEvent",
            logger,
            reportError: deps.reportError,
          });
        }
      }
      return saved;
    });

    await deps.idempotency.commit<StoredSaveEventRecord>(idemKey, {
      payloadHash,
      response: saveEventWireOutputSchema.parse(result),
    });

    // ── Slug at CREATE (best-effort) ───────────────────────────────────────
    // A never-published event used to have no slug at all, which made its
    // public page 500 rather than render — and the builder's "Open preview in
    // a new tab" is shown ONLY pre-publish, so it pointed at exactly that page.
    // Assign one now so a draft is linkable from birth.
    //
    // CREATE BRANCH ONLY. `events.upsertDraft` routes a TRUTHY `eventId` to
    // `p.event.update`; only a null/undefined one creates. Re-deriving on every
    // save would also churn the URL under anyone already holding the draft link
    // — a rename is what `regenerateEventSlug` is for, and publish re-derives
    // once so the LIVE url reflects the final title.
    //
    // ── AFTER THE TRANSACTION, NOT INSIDE IT ──────────────────────────────
    // This used to sit at the end of the tx callback, which was wrong in a way
    // that is invisible until it bites: a statement that fails AT the database
    // aborts the Postgres transaction, and Postgres then answers COMMIT with
    // ROLLBACK and no error. Prisma does not surface that, so `repos.tx()`
    // RESOLVES and a `try/catch` around the failing statement makes the whole
    // save silently disappear while reporting success — an `eventId` on the
    // wire, and cached under the idempotency key for 120s, for a row that was
    // never written. (Reachable, not theoretical: `EventSlugHistory.slug` is
    // globally unique and the regenerate flow can put a slug back in play.)
    // The hazard is not "the catch is too narrow", it is "a catch inside a
    // transaction cannot do this job at all" — so the slug work moved out and
    // takes its own transaction. See `assignSlugOnCreate`.
    //
    // Reads the slug context AFTER commit deliberately: the segments come from
    // `getSlugContext`, which falls back through the event's linked
    // SavedLocation / Place, and the freeform branch only links its
    // SavedLocation late in the tx. Post-commit is the first moment the
    // location is fully resolved.
    //
    // A crash between the commit above and this line leaves a slugless event.
    // That is the accepted cost, and it is the exact state
    // `apps/api/src/scripts/backfill/backfill-event-slugs.ts` exists to repair.
    if (params.eventId === null) {
      await assignSlugOnCreate(
        { logger, reportError: deps.reportError },
        deps.repos,
        { eventId: result.eventId, now: createdAt, useCase: "saveEvent" },
      );
    }

    // Write the (redacted) document back, or remove it if the event is not
    // published. Best-effort, like every post-mutation reindex: a failure is
    // reported and the mark above keeps the entity for the scheduled drain
    // (nightly reindex as the backstop) — over-private, never a leak.
    if (searchScrubbed || searchMarked) {
      reindexAfterMutation(
        {
          repos: deps.repos,
          search: deps.search,
          clock: deps.clock,
          logger,
          reportError: deps.reportError,
        },
        "saveEvent",
        { kind: "event", id: result.eventId },
      );
    }

    return result;
  } catch (err) {
    await deps.idempotency.fail(idemKey, describeError(err));
    throw err;
  }
}

/**
 * The freeform-address owner key. A freeform address is normalized into a
 * `SavedLocation` owned by the event's owner; the key is pure, so both entry
 * paths derive it the same way from the same input.
 */
function freeformOwnerKey(owner: OwnerContext): {
  ownerType: "ORGANIZATION" | "HUMAN";
  ownerId: string;
} {
  return owner.kind === "org"
    ? { ownerType: "ORGANIZATION", ownerId: owner.orgId }
    : { ownerType: "HUMAN", ownerId: owner.humanId };
}

/**
 * The point a freeform or saved-address save would draw its own circle
 * around, run through {@link ensureAddressIsNotOwnWithheldPlace}. A
 * place-linked save draws the place's circle already; `none` draws nothing.
 * Only a standalone save runs this: the caller-tx path (the booking accept)
 * mints place-linked events only.
 */
async function ensureSaveAddressIsNotOwnWithheldPlace(
  deps: SaveEventDeps,
  params: FinalizeParams,
): Promise<void> {
  let point: { lat: number | null; lng: number | null } | null = null;
  if (params.location.kind === "freeform") {
    point = { lat: params.location.lat, lng: params.location.lng };
  } else if (params.location.kind === "saved-location") {
    // The wrapper already checked the actor may use this row.
    const saved = await deps.repos.savedLocations.getById(
      params.location.savedLocationId,
    );
    point = saved ? { lat: saved.lat ?? null, lng: saved.lng ?? null } : null;
  }
  if (point === null) return;
  await ensureAddressIsNotOwnWithheldPlace(
    { repos: deps.repos, authz: deps.authz },
    { actorHumanId: params.actorHumanId, point },
  );
  // A delegate saving the principal's event (owner ruling 2026-09-28) must
  // not publish the PRINCIPAL's withheld address either: check the event
  // owner's managed places too. The delegate acts for the principal, so
  // naming the principal's place in the refusal discloses nothing the
  // principal's own builder would not.
  if (
    params.owner.kind === "human" &&
    params.owner.humanId !== params.actorHumanId
  ) {
    await ensureAddressIsNotOwnWithheldPlace(
      { repos: deps.repos, authz: deps.authz },
      { actorHumanId: params.owner.humanId, point },
    );
  }
}

/**
 * The save, joined to a transaction the CALLER already opened (FR-004).
 *
 * The caller-tx twin of {@link finalizeSaveEvent}. A separate exported function
 * rather than an overload of it — read the note on `finalizeSaveEvent` for the
 * measured reason (overload resolution silently binds the standalone signature
 * for a named variable, and the deferred work is then never run).
 *
 * READ {@link FinalizeSaveEventInCallerTxParams} BEFORE CALLING THIS. Its doc
 * carries the five things a caller owns: draining the deferred work, its own
 * idempotency envelope, preparing the tax rate, the lock order, and the four
 * wrapper checks that do NOT run here.
 *
 * What this path deliberately does NOT do, and why (all three are load-bearing):
 *
 *  · `deps.repos.tx` is never called. Every statement goes through the handle
 *    that was passed in. The adapter opens a FRESH transaction off the root
 *    client for every `repos.tx`, so a nested call would take a second
 *    connection and block on the first's advisory locks.
 *  · No idempotency envelope — no replay `get`, no `begin`, no `commit`, no
 *    `fail`. The caller has exactly one, around the whole operation (FR-005).
 *  · No post-commit work. The caller's transaction is still open when this
 *    returns, so the steps that must follow a commit are handed back as
 *    {@link SaveEventDeferredWork} instead of being run here.
 *
 * And the one thing it needs FROM the caller: a `preparedTaxRate`, whenever the
 * save would restamp. Resolving it here would put a live tax-provider HTTP call
 * (5s timeout) inside the caller's transaction — precisely what P-1 removed.
 *
 * The freeform `SavedLocation` pre-read is NOT hoisted the same way: it is a
 * single point read with no third-party I/O behind it, and issuing it on the
 * root client while the caller holds a transaction would burn a second
 * connection to see a snapshot the transaction cannot. It runs through `tx`.
 */
export async function finalizeSaveEventInCallerTx(
  deps: SaveEventDeps,
  logger: LoggerPort | undefined,
  params: FinalizeSaveEventInCallerTxParams,
): Promise<FinalizeSaveEventInCallerTxResult> {
  // One `clock.now()` per save, shared by every write — the same contract the
  // standalone entry point has.
  const createdAt = deps.clock.now();
  const tx = params.tx;
  const { ownerType: freeformOwnerType, ownerId: freeformOwnerId } =
    freeformOwnerKey(params.owner);

  // The same read, and the same restamp gate, the standalone path runs before
  // it opens its transaction — through the caller's handle instead of the root
  // client. The tx body repeats it as its authoritative read exactly as it does
  // on the standalone path; this copy only decides the gate.
  const preTxFreeformSavedLocation: SavedLocationRecord | null =
    params.location.kind === "freeform" && params.location.addressText
      ? await tx.savedLocations.findByOwnerAndAddress({
          ownerType: freeformOwnerType,
          ownerId: freeformOwnerId,
          address: params.location.addressText,
        })
      : null;
  const mintsFreeformSavedLocation =
    params.location.kind === "freeform" &&
    Boolean(params.location.addressText) &&
    preTxFreeformSavedLocation === null;
  const taxRestampNeeded =
    params.existingEvent?.admissionTaxRateBps == null ||
    mintsFreeformSavedLocation ||
    didLocationChange(
      params.existingEvent,
      params.location,
      preTxFreeformSavedLocation?.id ?? null,
    );

  let preparedTaxRate: PreparedEventTaxRate | null = null;
  if (taxRestampNeeded) {
    if (!params.preparedTaxRate) {
      // A PROGRAMMER error, not a user-facing refusal: the alternative — call
      // the provider from in here — is the exact regression P-1 landed to
      // prevent, so it is never the fallback. Thrown, so it rolls the caller's
      // transaction back and reaches Sentry through the thrown-error backstop.
      throw new Error(
        "finalizeSaveEventInCallerTx: this save restamps the admission tax " +
          "rate, but no `preparedTaxRate` was supplied. BEFORE opening your " +
          "transaction, call `prepareEventTaxRate` with a ref built by " +
          "`saveEventTaxRateLocationRef` (NOT `eventTaxRateLocationRef`, whose " +
          "inline arm demands postal code AND country and silently yields no " +
          "rate for a country+region-only address), and pass the result in. " +
          "Resolving it here would run a live tax-provider HTTP call (ZipTax, " +
          "5s timeout) inside the caller's transaction, which is what P-1 " +
          "removed.",
      );
    }
    preparedTaxRate = params.preparedTaxRate;
  }

  const output = await runSaveEventTxBody(deps, logger, params, tx, {
    createdAt,
    freeformOwnerType,
    freeformOwnerId,
    preparedTaxRate,
    // The caller already holds a transaction, so the save cannot probe
    // `canManagePlace` itself (it reads on its own connection). A caller that
    // wants the W1 manager stamp probes before opening its transaction and
    // passes the answer; omitted = none.
    managedPlaceId: params.managedPlaceId ?? null,
  });

  return {
    ...output,
    deferred: buildDeferredWork(deps, logger, params, output.eventId, createdAt),
  };
}

/**
 * Package the post-commit steps this save owes into something the caller can
 * run after ITS commit. Built only once the save body has succeeded, so a
 * failed save hands back nothing to run.
 *
 * Today there is exactly one step and it applies to a CREATE only —
 * {@link assignSlugOnCreate}, which takes the NON-transactional `Repos` bag and
 * opens its own transaction. That is why it cannot run inline here: the
 * caller's transaction is still open, and `assignSlugOnCreate` would nest.
 *
 * The idempotency `commit` the standalone path also does post-commit is NOT
 * here: on this path there is no inner envelope to commit (FR-005). The
 * notification intents on {@link SaveEventOutput} are not here either — they
 * are returned data the caller's transport dispatches, the same as always.
 */
function buildDeferredWork(
  deps: SaveEventDeps,
  logger: LoggerPort | undefined,
  params: FinalizeParams,
  eventId: string,
  createdAt: Date,
): SaveEventDeferredWork {
  const steps: SaveEventDeferredStep[] =
    params.eventId === null ? ["assign-slug-on-create"] : [];

  return {
    steps,
    async runAfterCommit(): Promise<void> {
      if (!steps.includes("assign-slug-on-create")) return;
      // Best-effort and self-reporting, exactly as at the standalone call site
      // (read the long comment there): it takes its OWN transaction, swallows
      // and reports its own failures, and a slugless event is the accepted
      // outcome the backfill script repairs.
      await assignSlugOnCreate(
        { logger, reportError: deps.reportError },
        deps.repos,
        { eventId, now: createdAt, useCase: "saveEvent" },
      );
    },
  };
}

/** What {@link runSaveEventTxBody} needs from whichever path opened the tx. */
type SaveEventTxContext = {
  /** The save instant. One `clock.now()` per save, shared by every write. */
  createdAt: Date;
  /**
   * Standalone saves of an EXISTING event pass a holder here; the body fills
   * it with the event row as it stands immediately before this save's write,
   * read under `FOR UPDATE` (after the venue lock, see `EventsRepo.lockRows`).
   * The search privacy scrub compares against THAT row, not `existingEvent`,
   * which was read before the idempotency claim and a possible tax lookup and
   * can be stale by then.
   */
  lockedBefore?: { row: EventRecord | null };
  freeformOwnerType: "ORGANIZATION" | "HUMAN";
  freeformOwnerId: string;
  /**
   * The prepared rate, or `null` when the restamp gate said "leave the stored
   * rate alone". Resolved OUTSIDE this transaction on both paths — by the save
   * itself when it owns the transaction, by the caller when it does not.
   */
  preparedTaxRate: PreparedEventTaxRate | null;
  /**
   * The place the ACTOR was probed to MANAGE (`canManagePlace`), or null —
   * probed OUTSIDE this transaction (`probeManagedPlace`: the authz adapter
   * reads on its own pool connection, which must never be requested while a
   * transaction holds one). Honoured only when it is the saved row's place
   * (place-address-withholding W1).
   */
  managedPlaceId: string | null;
};

/**
 * THE SAVE ITSELF: every statement, and nothing that must straddle a commit.
 *
 * Extracted verbatim from the body of `finalizeSaveEvent`'s `repos.tx`
 * callback so both entry paths run the identical sequence against whatever
 * `TxRepos` handle they were given — the standalone path's own, or the
 * caller's. Writes only through `tx`; it must never reach for `deps.repos`.
 */
async function runSaveEventTxBody(
  deps: SaveEventDeps,
  logger: LoggerPort | undefined,
  params: FinalizeParams,
  tx: TxRepos,
  ctx: SaveEventTxContext,
): Promise<SaveEventOutput> {
  const {
    createdAt,
    freeformOwnerType,
    freeformOwnerId,
    preparedTaxRate,
    managedPlaceId,
  } = ctx;

  // ── EVENTS_PER_ORG quota ─────────────────────────────────────────────
  // Only check on new event creation, not on updates.
  const isNewEvent = params.eventId === null;
  if (isNewEvent && params.owner.kind === "org") {
    await enforceQuota(tx, {
      subjectType: "ORG",
      subjectId: params.owner.orgId,
      kind: "EVENTS_PER_ORG",
    });
  }

  // When the event is linked to a Place, auto-resolve the place's
  // default layout (if one exists) so the Seating tab becomes available.
  let resolvedPlaceLayoutId: string | null = null;
  if (params.location.kind === "place") {
    const layout = await tx.placeLayouts.getByPlace(params.location.placeId);
    if (layout) {
      resolvedPlaceLayoutId = layout.id;
    }
  }

  // Venue-hierarchy placement (FR-005/FR-011). Resolved INSIDE this tx —
  // the same-place / ACTIVE-space asserts are read-then-write and must not
  // straddle the transaction that persists the draft.
  const placement = await resolveVenuePlacement(tx, {
    calendarId: params.calendarId,
    spaceId: params.spaceId,
    location: params.location,
    existingEvent: params.existingEvent,
  });

  const requestedLocationMode =
    params.locationMode ?? params.existingEvent?.locationMode ?? "EXACT";
  const requestedLocationRadiusMeters =
    params.locationRadiusMeters !== undefined
      ? params.locationRadiusMeters
      : (params.existingEvent?.locationRadiusMeters ?? null);

  // ── THE HARD CEILING: a venue's obscurity is a FLOOR for its events ──
  //
  // An event whose location resolves from a Place can never be more precise
  // in public than that Place. An event at an OBSCURED venue is OBSCURED —
  // whatever it asked for, by whatever route it asked.
  //
  // THIS is the guarantee. The event builder's UI lock is a courtesy: it
  // protects an organizer from a mistake, and it protects nobody from an API
  // call, a script, a template, a series generator, or a third party creating
  // a community listing at somebody's house. Those all land here.
  //
  // Enforced inside the transaction, against the place row read in the SAME
  // transaction, so a concurrent "hide my venue" cannot be straddled by a
  // save that read the old value. `buildEventSeo` re-applies the identical
  // clamp on READ, which is what makes hiding a venue take effect on events
  // that were already published there.
  //
  // THE SECRET LIVES IN ONE TABLE (place-address-withholding D1). The clamp
  // above decides the PRIVACY columns; the LOCATION columns are the events
  // adapter's: at a withheld venue `upsertDraft` stores the venue's public
  // projection (area label, public circle centre or nothing, no postcode) and
  // never the true street or coordinates — see
  // `lib/location/place-event-location.ts`. The adapter re-applies this same
  // floor itself, because three other `upsertDraft` callers (series generation
  // and sync, templates) never pass through here.
  //
  // The SHARED place-location lock is taken BEFORE the place read, so this
  // save and `upsertPlace`'s privacy cascade (which takes it EXCLUSIVE before
  // writing the Place) are strictly ordered: either this save reads the new
  // state, or the cascade re-projects this save's committed row. The adapter
  // takes it again (re-entrant) for callers that skip this body.
  //
  // LIMIT (W6): a FREEFORM address (no `placeId`) is not a venue and has no
  // other row to hold its truth — the Event row IS the record, so it stores
  // the real address and event-level OBSCURED is enforced at READ time only.
  // A house typed in as a freeform address therefore has none of the
  // one-table guarantees above; hosting it as a withheld Place is what gets
  // them.
  if (params.location.kind === "place") {
    await tx.events.lockLocationsAtPlace({
      placeId: params.location.placeId,
      mode: "shared",
    });
  }
  const ceilingPlace =
    params.location.kind === "place"
      ? await tx.places.getById(params.location.placeId)
      : null;
  const flooredLocation = applyPlaceLocationFloor(
    {
      locationMode: requestedLocationMode,
      locationRadiusMeters: requestedLocationRadiusMeters,
    },
    ceilingPlace,
  );
  const effectiveLocationMode = flooredLocation.locationMode;
  const effectiveLocationRadiusMeters = flooredLocation.locationRadiusMeters;

  if (
    effectiveLocationMode !== requestedLocationMode ||
    effectiveLocationRadiusMeters !== requestedLocationRadiusMeters
  ) {
    logger?.info("event.location_privacy_clamped_to_venue", {
      eventId: params.eventId ?? null,
      placeId:
        params.location.kind === "place" ? params.location.placeId : null,
      requestedLocationMode,
      requestedLocationRadiusMeters,
      effectiveLocationMode,
      effectiveLocationRadiusMeters,
    });
  }

  const { preset: resolvedRevealPreset, at: resolvedRevealAt } =
    resolveAddressReveal({
      locationMode: effectiveLocationMode,
      startsAt: params.startsAt,
      preset: params.addressRevealPreset,
      addressRevealAt: params.addressRevealAt,
      existingEvent: params.existingEvent,
      now: createdAt,
    });

  // ── Freeform SavedLocation: FIND (create happens further down) ───────
  // Hoisted above the timezone chain deliberately. A freeform address is
  // normalized into a SavedLocation, and that row is where the
  // address-derived zone lives — so the chain has to know whether this
  // address is already saved (and already carries an answer) BEFORE it
  // resolves. The create/link half still runs after the draft is persisted
  // (it needs `created.id`); this is only the lookup, and it is the SAME
  // lookup that half used to do, moved rather than duplicated.
  let existingFreeformSavedLocation: SavedLocationRecord | null = null;
  if (params.location.kind === "freeform" && params.location.addressText) {
    existingFreeformSavedLocation =
      await tx.savedLocations.findByOwnerAndAddress({
        ownerType: freeformOwnerType,
        ownerId: freeformOwnerId,
        address: params.location.addressText,
      });
  }

  // The freeform address's OWN zone, derived from its coordinates exactly
  // once per save. It is BOTH the chain's freeform source below AND the
  // value persisted onto a newly-created SavedLocation, so there is one
  // derivation and one stored answer. An already-saved address short-
  // circuits the derivation entirely — the stored value wins, which is
  // what makes the second event at the same address free.
  //
  // Derived even when an explicit param or the existing event will win the
  // chain: `SavedLocation.timezone` describes the ADDRESS, not this event's
  // display choice, and stamping an organiser's override onto the shared
  // row would poison every other event at that address.
  const freeformAddressTimezone: string | null =
    params.location.kind === "freeform"
      ? (existingFreeformSavedLocation?.timezone ??
        deriveTimezoneFromCoordinates(
          deps,
          logger,
          params.location.lat,
          params.location.lng,
          {
            eventId: params.eventId,
            addressText: params.location.addressText,
          },
        ))
      : null;

  // ── Event timezone (venue-hierarchy FR-004) ──────────────────────────
  // Precedence:
  //   explicit param
  //     > existing event's zone
  //     > linked Place.timezone
  //     > SavedLocation.timezone (stored, or derived for this save)
  //     > platform default
  //
  // `existingEvent` outranking BOTH derived sources is DELIBERATE: an
  // event that already carries a timezone must never have it silently
  // changed by a later save (e.g. swapping the venue), because the zone is
  // the display truth for every time on the event — door times, address
  // reveal, scheduled price flips, sales windows. Only events with no zone
  // yet (i.e. brand-new ones) adopt the venue's.
  //
  // The place's zone is READ, never re-derived here: `Place.timezone` is
  // the address-derived answer (upsert-place → TimezoneLookupPort, kept in
  // sync on address change), and re-deriving would create a second source
  // of truth. A place whose `timezone` is null (no coordinates, or the
  // lookup failed) falls through to the default.
  //
  // The two placeless-but-located kinds resolve through the SavedLocation:
  //   - `saved-location` — the picker handed us an existing row. Its
  //     stored zone wins; rows created before the column exists carry null,
  //     so we derive from the row's own coordinates rather than stranding
  //     them on the default forever. Nothing is written back: the
  //     derivation is a pure function of lat/lng, so re-deriving cannot
  //     disagree with a stored value, and a save has no business rewriting
  //     a shared row it did not otherwise touch.
  //   - `freeform` — resolved above.
  //
  // Online / no-venue events (`kind: "none"`) have no coordinates at all
  // and fall through to the platform default EXPLICITLY.
  //
  // A "freeform" address typed WITHOUT coordinates never gets this far:
  // `baseSaveEventInputSchema` rejects it at the boundary ("lat and lng
  // are required together"), so the freeform branch is guaranteed a
  // coordinate pair and the derivation has something to work with. (The
  // `lat == null` guard inside the helper is still real — it covers the
  // saved-location branch, whose stored coordinates ARE nullable.)
  let resolvedTimezone: string | null =
    params.timezone ?? params.existingEvent?.timezone ?? null;
  if (resolvedTimezone === null) {
    switch (params.location.kind) {
      case "place": {
        const linkedPlace = await tx.places.getById(params.location.placeId);
        resolvedTimezone = linkedPlace?.timezone ?? null;
        break;
      }
      case "saved-location": {
        const saved = await tx.savedLocations.getById(
          params.location.savedLocationId,
        );
        resolvedTimezone =
          saved?.timezone ??
          deriveTimezoneFromCoordinates(
            deps,
            logger,
            saved?.lat,
            saved?.lng,
            {
              eventId: params.eventId,
              savedLocationId: params.location.savedLocationId,
            },
          );
        break;
      }
      case "freeform": {
        resolvedTimezone = freeformAddressTimezone;
        break;
      }
      default:
        break;
    }
  }
  resolvedTimezone ??= DEFAULT_VENUE_TIMEZONE;

  const draftInput: SaveEventInput = {
    eventId: params.eventId,
    orgId: params.owner.kind === "org" ? params.owner.orgId : null,
    humanId: params.owner.kind === "human" ? params.owner.humanId : null,
    title: params.title,
    startsAt: params.startsAt,
    endsAt: params.endsAt,
    status: params.existingEvent?.status ?? "DRAFT",
    content: params.content,
    location: params.location,
    // The CLAMPED values, never the requested ones — see the ceiling above.
    // A caller that asked for EXACT at an obscured venue gets OBSCURED
    // persisted, so the stored row never claims a precision it may not have.
    locationMode: effectiveLocationMode,
    locationRadiusMeters: effectiveLocationRadiusMeters,
    locationLabel: params.locationLabel,
    addressRevealAt: resolvedRevealAt,
    addressRevealPreset: resolvedRevealPreset,
    timezone: resolvedTimezone,
    placeLayoutId: resolvedPlaceLayoutId,
    heroImageId: params.heroImageId,
    ageLimit: params.ageLimit,
    instructionalAdmission: params.instructionalAdmission,
    // Spread (not two `?? null`s): an ABSENT key means "leave the stored
    // placement alone", which is not the same as clearing it.
    ...placement,
    createdAt: params.existingEvent ? undefined : createdAt,
  };

  if (ctx.lockedBefore && params.existingEvent) {
    await tx.events.lockRows({
      ids: [params.existingEvent.id],
      mode: "update",
    });
    ctx.lockedBefore.row = await tx.events.getById(params.existingEvent.id);
  }

  const created = await persistEventDraft(tx, draftInput, logger);

  // ── Auto-materialise SeatSection + Seat rows from PlaceLayout ────────
  // When the event is linked to a layout, ensure DB-level seat inventory
  // exists so the checkout seat selector can join via layoutSectionId.
  if (resolvedPlaceLayoutId) {
    const layout = await tx.placeLayouts.getById(resolvedPlaceLayoutId);
    if (layout && layout.sections.length > 0) {
      const matResult = await tx.seats.materializeSections({
        eventId: created.id,
        placeLayoutId: layout.id,
        sections: layout.sections.map((s) => ({
          sectionId: s.sectionId,
          label: s.label,
          capacity: s.capacity,
          color: s.color ?? null,
          geometry: s.geometry ?? null,
          stageAnchor: s.stageAnchor ?? null,
        })),
        seatIds: layout.seatIds,
      });
      logger?.info("auto-materialised seat sections from layout", {
        eventId: created.id,
        sectionsCreated: matResult.sectionsCreated,
        seatsCreated: matResult.seatsCreated,
      });
    }
  }

  // ── Auto-create / link SavedLocation for freeform addresses ──────────
  // When the user types a freeform address (Google Autocomplete), we
  // automatically upsert a SavedLocation so:
  //   1. The address is reusable for future events.
  //   2. We have a stable place to cache the tax rate for this venue.
  //   3. The event's savedLocationId is set so publish-time tax stamping
  //      can resolve the venue's cached rate.
  let savedLocationUsageCount: number | undefined;
  // SavedLocation the freeform branch created/linked, so the tax stamp
  // below can resolve the venue's (possibly just-cached) rate. Stays null
  // for place / saved-location / no-location modes.
  let freeformSavedLocationId: string | null = null;

  if (params.location.kind === "freeform" && params.location.addressText) {
    const slOwnerType = freeformOwnerType;
    const slOwnerId = freeformOwnerId;

    // Already fetched above the timezone chain — the SAME lookup, not a
    // second one, so a freeform save still costs exactly one read here.
    const existing = existingFreeformSavedLocation;

    let linkedSavedLocationId: string;

    if (existing) {
      linkedSavedLocationId = existing.id;
      // Reuse existing — just bump usage counter.
      if (
        !params.existingEvent ||
        params.existingEvent.savedLocationId !== existing.id
      ) {
        await tx.savedLocations.incrementUsage(existing.id);
        savedLocationUsageCount = existing.usageCount + 1;
      }
      // When re-saving the same event at the same address, skip the
      // nudge — the user already chose this location intentionally.
    } else {
      // Create a new one — usage starts at 1 (set inside create).
      const newSaved = await tx.savedLocations.create({
        name: params.location.locality
          ? `${params.location.addressText.split(",")[0]}, ${params.location.locality}`
          : (params.location.addressText.split(",")[0] ??
            params.location.addressText),
        address: params.location.addressText,
        countryCode: params.location.countryCode ?? null,
        region: params.location.region ?? null,
        locality: params.location.locality ?? null,
        postalCode: params.location.postalCode ?? null,
        lat: params.location.lat,
        lng: params.location.lng,
        // The zone derived from THESE coordinates above — persisted here
        // so every later event at this address reads it instead of
        // re-deriving. Null when there is no port, no answer, or the
        // lookup threw; the readers treat null as "fall through".
        timezone: freeformAddressTimezone,
        ownerType: slOwnerType,
        ownerId: slOwnerId,
      });
      linkedSavedLocationId = newSaved.id;
      savedLocationUsageCount = 1;
      if (freeformAddressTimezone) {
        logger?.info("timezone_cached_on_saved_location", {
          savedLocationId: newSaved.id,
          timezone: freeformAddressTimezone,
        });
      }
      // The new row's tax rate was resolved by postal code BEFORE this
      // transaction opened (P-1, above) and is cached onto it by the stamp
      // block below, once the row's id is known. No provider call in here.
    }

    // Link the SavedLocation to the event so publish-time tax stamping
    // can look up admissionTaxRateBps via event.savedLocationId.
    await tx.events.linkSavedLocation({
      eventId: created.id,
      savedLocationId: linkedSavedLocationId,
    });
    freeformSavedLocationId = linkedSavedLocationId;
  }

  if (params.location.kind === "saved-location") {
    const savedLocationId = params.location.savedLocationId;
    if (
      !params.existingEvent ||
      params.existingEvent.savedLocationId !== savedLocationId
    ) {
      await tx.savedLocations.incrementUsage(savedLocationId);
    }
  }

  // ── Stamp admission tax rate onto the event at save time ─────────────
  // Now that the event is persisted and its location is fully resolved
  // (placeId set, freeform SavedLocation created/linked, or saved-location
  // referenced) we stamp the venue's sales-tax rate onto the Event so
  // checkout collects tax on plain Saves too — not only after Publish.
  //
  // The rate itself was resolved BEFORE this transaction opened (P-1):
  // `preparedTaxRate` is null exactly when the pre-tx gate said "leave the
  // existing rate alone" (location unchanged AND the event already has a
  // rate), which mirrors the addressHash-change gating used on
  // Place/SavedLocation save. Only writes happen here.
  if (preparedTaxRate) {
    // Where a fresh provider answer (if any) is cached. A freeform save
    // caches onto the SavedLocation it just minted or linked — the pre-tx
    // resolution could not name a row that did not exist yet, and if the
    // address WAS already saved this is that same row. Every other kind
    // caches onto the row the pre-tx read named.
    //
    // The prepared result was read BEFORE this transaction, so the row may
    // have moved since. This runs after the SHARED place-location lock above
    // (`upsertPlace` takes it EXCLUSIVE): it re-checks the row's address,
    // drops a stamp resolved for an address the venue no longer has (falling
    // back to the row's current cached rate, else null for checkout to
    // resolve), and caches a fresh answer only by compare-and-set. No
    // provider call in here.
    const taxStamp = await commitPreparedEventTaxRate(
      { reportError: deps.reportError },
      tx,
      preparedTaxRate,
      logger,
      { eventId: created.id },
      freeformSavedLocationId
        ? {
            cacheTarget: {
              kind: "saved-location",
              savedLocationId: freeformSavedLocationId,
            },
          }
        : {},
    );
    // TN instruction-only exemption: when the event is flagged
    // instructional AND its resolved situs is US/TN, zero the stamped rate
    // (source "exempt:tn-instruction") so the persisted stamp is correct
    // for checkout display + estimate-checkout-tax. No-op elsewhere.
    // `created.instructionalAdmission` reflects the value just persisted
    // by upsertDraft above.
    const exemptStamp = taxStamp
      ? applyInstructionExemption({
          instructionalAdmission: created.instructionalAdmission,
          situs: taxStamp.situs,
          rateBps: taxStamp.rateBps,
          source: taxStamp.source,
        })
      : null;
    await tx.events.updateTaxRate({
      eventId: created.id,
      admissionTaxRateBps: exemptStamp?.rateBps ?? null,
      taxRateSource: exemptStamp?.source ?? null,
    });
  }

  // ── Venue trust (venue-confirmation spec, docs/specs/2026-08-27) ─────
  // AFTER the row is written, INSIDE this tx. Four shapes for an event
  // at a place:
  //   · VENUE-OWNED — confirmed by construction; nothing to do.
  //   · the SAVER manages the place (place-address-withholding W1, e.g. a
  //     house owned personally whose shows run under the owner's org) —
  //     the save is the venue's own word: stamped, nothing asked
  //     (`venue-manager-stamp.ts`). A deliberate withdrawal is left alone.
  //   · the owner (org or person) is the grantee of an active booking
  //     grant for the place (calendar scope honoured; the grantee's OWN
  //     event, holds-without-a-request FR-002) — "confirmed by construction"
  //     too, but a grant-holder is not an owner, so the stamp is WRITTEN
  //     here through the same repo write the agreement mint uses
  //     (`create-event-from-agreement`).
  //   Both stamping shapes are idempotent on a re-save that did not move
  //   the show: the stamp is rewritten only when it is not CURRENT —
  //   missing, withdrawn (grant only), for another place, or recorded at a
  //   start other than this row's (N1: the stamp's `venueConfirmedStartsAt`
  //   follows a move made by the venue side, never one made by a third
  //   party).
  //   · THIRD PARTY with a calendar named — EVENT-FIRST: the booking
  //     request the venue confirms is created now, in this tx, through
  //     the pitch's own gates (`createBookingRequestFromEvent`). Its
  //     notifications ride the output as intents. No calendar → address-
  //     only, no request (spec).
  // The FR-018 settle below is gated to venue-owned / stamped events, so
  // an unconfirmed third-party save takes no hold line; a grant-stamped
  // save is handed the STAMPED row so it can.
  let savedEvent = created;
  let eventFirst: CreateBookingRequestFromEventResult | null = null;
  if (params.location.kind === "place" && (savedEvent.placeId ?? null)) {
    const classified = await resolveBuilderVenueTrust(tx, {
      event: savedEvent,
      owner: params.owner,
      now: createdAt,
    });
    const trust = classified.trust;
    // W1: the SAVER manages the place (not merely the event's owner) — the
    // save is the venue's own word. Only when the owner arm does not already
    // hold (a venue-owned event needs no stamp), and only for the place the
    // actor was probed against before this transaction opened.
    const savedByPlaceManager =
      trust !== "venue_owned" &&
      managedPlaceId !== null &&
      managedPlaceId === savedEvent.placeId;
    if (savedByPlaceManager) {
      // A deliberate WITHDRAWAL stands until the venue re-confirms it
      // explicitly: an unrelated edit by a manager must not silently undo a
      // colleague's "not this one". No booking request either way — the
      // venue does not ask itself.
      //
      // R3-2: the manager stamps when there is NO active stamp, or when THIS
      // save moved the show (the manager is then vouching for the date they
      // just set). An unrelated edit (a typo) of a show the ORGANIZER moved
      // re-stamps nothing, so the venue's floor stays on the date it really
      // confirmed — a manager fixing a title has not seen, let alone
      // confirmed, the organizer's move.
      const withdrawn = (savedEvent.venueConfirmationWithdrawnAt ?? null) !== null;
      if (
        !withdrawn &&
        (!hasActiveVenueConfirmationStamp(savedEvent) ||
          thisSaveMovedTheShow(params.existingEvent, savedEvent))
      ) {
        savedEvent = await stampVenueConfirmationForSave(tx, {
          event: savedEvent,
          actorHumanId: params.actorHumanId,
          via: "manager",
          at: createdAt,
        });
      }
    } else if (classified.trust === "grant") {
      // Stamped when missing, for another place, OR recorded at a start
      // other than this row's: a grant-holder moving their own show
      // re-vouches for the new date (the grant already lets them create a
      // show on that date), so the N1 floor follows the move. R3-3: a
      // WITHDRAWN stamp stands — the venue's explicit "not this one" is not
      // undone by the grantee's next save; only the venue re-confirms it.
      if ((savedEvent.venueConfirmationWithdrawnAt ?? null) === null) {
        savedEvent = await stampVenueConfirmationForSave(tx, {
          event: savedEvent,
          actorHumanId: params.actorHumanId,
          via: "grant",
          grantId: classified.grantId,
          at: createdAt,
        });
      }
    } else if (trust === "third_party") {
      eventFirst = await createBookingRequestFromEvent(tx, {
        event: savedEvent,
        intent: params.bookingIntent ?? "PERFORM",
        actorHumanId: params.actorHumanId,
        now: createdAt,
        logger,
      });
    }
  }

  // ── Booking timeline (`booking_event.modified`) ──────────────────────
  // When this event traces back to a booking request, log what moved onto
  // that request's thread — in THIS transaction, so the entry and the row
  // it describes commit together. Skipped entirely on creation (nothing to
  // diff, and the agreement anchor is stamped after the save), and the
  // reverse lookup only runs when a tracked field actually changed.
  // ── FR-018: a PUBLISHED event moved onto a held calendar+date ────────
  // Only a LIVE event takes dates (drafts are pencil-ins), and only when
  // this save actually moved its start or its calendar onto a calendar.
  // Runs inside this tx so an open challenge on the new line refuses the
  // save with nothing committed. Releases are terminal (FR-019): moving
  // OFF a date restores nothing.
  let heldDates: Awaited<ReturnType<typeof settleHeldDatesForEvent>> | null =
    null;
  if (
    params.existingEvent &&
    params.existingEvent.status === "PUBLISHED" &&
    (savedEvent.calendarId ?? null) !== null
  ) {
    const moved = diffBookingTrackedEventFields(params.existingEvent, savedEvent);
    if (moved.includes("startsAt") || moved.includes("calendar")) {
      heldDates = await settleHeldDatesForEvent(tx, {
        event: savedEvent,
        now: createdAt,
        actorHumanId: params.actorHumanId,
        // The same-place skip above (save-event-for-org) means this save
        // never re-checked the place; the settle does, on the owner,
        // before it touches another org's holds.
        owner: params.owner,
      });
    }
  }

  if (params.existingEvent) {
    await appendBookingEventModifiedEntry(tx, {
      previous: params.existingEvent,
      next: savedEvent,
      // N1: a show the venue confirmed, moved EARLIER than the date the
      // venue vouched for, by someone who is not the venue (a venue-side
      // save re-stamps above, so the stamp would now match). The venue's
      // address floor does not move with it (`holderRevealSchedule`), but
      // the venue should see the move: when the event has no agreement
      // thread, it is recorded on the booking request the confirmation came
      // from.
      fallbackBookingRequestId: confirmedShowMovedEarlier(savedEvent)
        ? (savedEvent.venueConfirmationRequestId ?? null)
        : null,
      // Same staleness the tax stamp above compensates for, and for the
      // same reason: `created` is upsertDraft's return value, and on a
      // FREEFORM save its savedLocationId is null because the link is
      // applied afterwards by `linkSavedLocation`. Passing `created`
      // unpatched reported a phantom "location changed" on every save.
      nextSavedLocationId:
        freeformSavedLocationId ?? created.savedLocationId,
      actorHumanId: params.actorHumanId,
    });
  }

  // ── FR-013: a PUBLISHED event's schedule moved → tell its audience ────
  // The same RESCHEDULED outbox row the community edit path writes
  // (`recordCommunityEditApplied`), in THIS tx so the notice commits with the
  // move; the drain (`dispatchEventChangeNotifications`) sends `event.changed`
  // to savers ∪ RSVPers. "Schedule" is the community path's SCHEDULE_GROUP
  // (startsAt/endsAt) compared as instants — a timezone edit is presentational
  // and never notifies. Drafts have no audience. The before-row is the one
  // read under the row lock when this save holds it, so two concurrent saves
  // to the same new date write one notice, not two. VENUE_CHANGED is NOT
  // written on this path.
  //
  // PUBLISHED BEFORE *AND* AFTER: the status this save writes comes from the
  // pre-tx `params.existingEvent`, which can be staler than the locked row
  // (pre-tx read DRAFT, a concurrent publish, locked read PUBLISHED → this
  // save writes DRAFT back). A draft has no audience, so no notice.
  const scheduleBefore = ctx.lockedBefore?.row ?? params.existingEvent;
  if (
    scheduleBefore !== null &&
    scheduleBefore.status === "PUBLISHED" &&
    savedEvent.status === "PUBLISHED" &&
    thisSaveMovedTheSchedule(scheduleBefore, savedEvent)
  ) {
    await tx.eventChangeNotices.create({
      eventId: savedEvent.id,
      changeType: "RESCHEDULED",
      payload: {
        // The title the audience knows — the community path's `before.title`.
        eventTitle: scheduleBefore.title,
        newStartsAt: savedEvent.startsAt.toISOString(),
        newEndsAt: savedEvent.endsAt ? savedEvent.endsAt.toISOString() : null,
      },
    });
  }

  // ── arrival-areas FR-014: the event changed place or address ──────────
  // Its own arrival areas switch off until the organiser repositions them,
  // and its hides of areas that are not its new place's are deleted, in THIS
  // transaction with audit rows (use-cases/arrival-areas/
  // on-event-location-changed.ts). Compared against the row under this
  // save's lock when it holds one. Without the lock (`lockedBefore` unset),
  // `before` is the pre-tx read: two concurrent saves of one event can miss
  // a move (the same limitation as the RESCHEDULED notice block above).
  const arrivalAreasBefore = ctx.lockedBefore?.row ?? params.existingEvent;
  if (arrivalAreasBefore) {
    await onEventLocationChanged(tx, {
      before: arrivalAreasBefore,
      after: savedEvent,
      actorHumanId: params.actorHumanId,
      now: createdAt,
    });
  }

  // Human events record the ACTOR alongside the owner: a delegate saving the
  // principal's event must show up as themselves, not as the principal.
  const auditData =
    params.owner.kind === "org"
      ? { orgId: params.owner.orgId, title: params.title }
      : {
          humanId: params.owner.humanId,
          actorHumanId: params.actorHumanId,
          title: params.title,
        };

  await tx.audit.log({
    entity: "event",
    entityId: created.id,
    action: params.existingEvent ? "updated" : "created",
    data: auditData,
    at: createdAt,
  });

  // Increment EVENTS_PER_ORG usage for new org events
  if (isNewEvent && params.owner.kind === "org") {
    await incrementResourceUsage(tx, {
      subjectType: "ORG",
      subjectId: params.owner.orgId,
      kind: "EVENTS_PER_ORG",
    });
  }

  return saveEventOutputSchema.parse({
    eventId: created.id,
    status: created.status,
    ...(savedLocationUsageCount != null ? { savedLocationUsageCount } : {}),
    ...(heldDates && heldDates.intents.length > 0
      ? {
          notificationIntents: heldDates.intents,
          staffRecipientHint: heldDates.staffRecipientHint,
        }
      : {}),
    ...(eventFirst && eventFirst.notificationIntents.length > 0
      ? { bookingRequestNotificationIntents: eventFirst.notificationIntents }
      : {}),
    // Always present on this path: the builder reads `null` as "no
    // request" (address-only / venue-owned / grant-stamped).
    bookingRequest: toSaveEventBookingRequest(eventFirst),
  });
}

/**
 * A replayed idempotency envelope is returned UNPARSED, so one written by
 * pre-`bookingRequest` code and replayed inside its TTL would fail the
 * router's required output parse. Default the key; a cached value wins.
 */
function normalizeReplayedSaveEvent(
  response: StoredSaveEventResponse,
): SaveEventWireOutput {
  return { ...response, bookingRequest: response.bookingRequest ?? null };
}

/**
 * The event-first result as the builder sees it. "The block never ran" and
 * the internal skips (nothing to ask) collapse to `null`; a gate-walk
 * refusal the save absorbed rides as `outcome: "skipped"` with the venue
 * and the refusal, so the builder can tell "sent" from "the venue is not
 * taking this" (owner ruling 2026-09-08).
 */
function toSaveEventBookingRequest(
  result: CreateBookingRequestFromEventResult | null,
): SaveEventBookingRequest | null {
  if (result === null) return null;
  if (result.outcome === "skipped") {
    if (!isEventFirstAbsorbedSkip(result)) return null;
    return {
      outcome: "skipped",
      reason: result.reason,
      code: result.code,
      message: result.message,
      placeId: result.placeId,
      placeName: result.placeName,
      intent: result.intent,
    };
  }
  return {
    id: result.bookingRequestId,
    placeId: result.placeId,
    placeName: result.placeName,
    // The request's own intent: a re-save asking for something else still
    // finds (and reports) the first request.
    intent: result.intent,
    parked: result.parked,
    outcome: result.outcome,
  };
}

/**
 * R3-2: whether THIS save changed the show's start (an update whose stored
 * start differs from the saved one). A create moves nothing.
 */
function thisSaveMovedTheShow(
  previous: EventRecord | null,
  saved: EventRecord,
): boolean {
  return (
    previous !== null && previous.startsAt.getTime() !== saved.startsAt.getTime()
  );
}

/**
 * FR-013: whether this save changed the event's schedule — its start or its
 * end, compared as instants (null-safe on the end). Mirrors the community
 * path's SCHEDULE_GROUP_FIELDS; timezone is deliberately not part of it.
 */
function thisSaveMovedTheSchedule(
  previous: EventRecord,
  saved: EventRecord,
): boolean {
  const endMs = (d: Date | null | undefined) => (d ? d.getTime() : null);
  return (
    previous.startsAt.getTime() !== saved.startsAt.getTime() ||
    endMs(previous.endsAt) !== endMs(saved.endsAt)
  );
}

/**
 * N1: whether the saved row is a venue-STAMPED show whose start is now
 * earlier than the start the venue confirmed. Pure over the row.
 */
function confirmedShowMovedEarlier(event: EventRecord): boolean {
  const confirmedStartsAt = event.venueConfirmedStartsAt ?? null;
  return (
    hasActiveVenueConfirmationStamp(event) &&
    confirmedStartsAt !== null &&
    event.startsAt.getTime() < confirmedStartsAt.getTime()
  );
}

/**
 * Which of the three venue-trust shapes a place-linked save is in (see the
 * venue-trust block in {@link runSaveEventTxBody}). One place read, then THE classification
 * (`classifyBuilderVenueTrust`, `_shared/builder-venue-trust.ts`) — the same
 * code path `getPlaceBookingOptions.viewer.authority` answers from before
 * the save, so the builder and the save cannot disagree about who is a
 * third party. The row's own owner columns are passed (an update never
 * rewrites them), and the grant is scoped to the calendar the row landed on.
 */
async function resolveBuilderVenueTrust(
  tx: TxRepos,
  args: {
    event: Pick<EventRecord, "id" | "orgId" | "humanId" | "placeId" | "calendarId">;
    owner: OwnerContext;
    now: Date;
  },
): Promise<BuilderVenueTrustResult> {
  const placeId = args.event.placeId ?? null;
  if (placeId === null) return { trust: "third_party" };
  const place = await tx.places.getById(placeId);
  // The wrapper's attach gate already loaded this place; a miss here is a
  // deletion mid-save, and the save's own FK write would have failed first.
  if (!place) return { trust: "third_party" };
  return classifyBuilderVenueTrust(tx, {
    place,
    owner: args.owner,
    eventOwner: args.event,
    calendarId: args.event.calendarId ?? null,
    now: args.now,
  });
}

function buildPayloadHash(input: {
  eventId: string | null;
  actorHumanId: string;
  owner: OwnerContext;
  title: string;
  startsAt: Date;
  endsAt: Date | null;
  location: NormalizedLocation;
  content?: EventBody | undefined;
  calendarId?: string | null | undefined;
  spaceId?: string | null | undefined;
  bookingIntent?: BookingIntentInput | undefined;
}): string {
  const payload = {
    eventId: input.eventId,
    actorHumanId: input.actorHumanId,
    owner:
      input.owner.kind === "org"
        ? { kind: "org", orgId: input.owner.orgId }
        : { kind: "human", humanId: input.owner.humanId },
    title: input.title,
    startsAt: input.startsAt.toISOString(),
    endsAt: input.endsAt ? input.endsAt.toISOString() : null,
    location: normalizeLocationForHash(input.location),
    content: input.content ?? null,
    // Placement participates in the hash: replaying one clientKey with a
    // DIFFERENT calendar/space is a conflict, not a silent "here's the old one".
    // `undefined` (untouched) and `null` (clear) hash differently on purpose.
    calendarId: input.calendarId === undefined ? "∅" : input.calendarId,
    spaceId: input.spaceId === undefined ? "∅" : input.spaceId,
    // The event-first ask is part of the payload too: replaying a clientKey
    // with a different intent is a conflict, not the old request.
    bookingIntent: input.bookingIntent ?? "∅",
  };
  return JSON.stringify(payload);
}

function normalizeLocationForHash(location: NormalizedLocation) {
  switch (location.kind) {
    case "place":
      return { kind: "place", placeId: location.placeId };
    case "saved-location":
      return {
        kind: "saved-location",
        savedLocationId: location.savedLocationId,
      };
    case "freeform":
      return {
        kind: "freeform",
        addressText: location.addressText,
        lat: location.lat,
        lng: location.lng,
      };
    default:
      return { kind: "none" };
  }
}

async function persistEventDraft(
  txRepos: TxRepos,
  input: SaveEventInput,
  _logger?: LoggerPort,
): Promise<EventRecord> {
  return txRepos.events.upsertDraft(input);
}

/**
 * The tax-rate location ref for a save, built from the NORMALIZED location
 * before anything is persisted — the pre-tx twin of building it from the
 * event's columns after `upsertDraft` (which resets every location column and
 * rebuilds it from the same `location`, so the two agree by construction):
 *  - place:          the place
 *  - saved-location: the saved location
 *  - freeform:       the SavedLocation the address is already saved as, when
 *                    there is one (its cached rate wins); otherwise INLINE from
 *                    the typed address — the row does not exist yet, and the
 *                    save caches the fresh answer onto it once it does
 *  - none:           no location, no rate
 */
export function saveEventTaxRateLocationRef(
  location: NormalizedLocation,
  existingFreeformSavedLocation: SavedLocationRecord | null,
): EventTaxRateLocationRef | null {
  switch (location.kind) {
    case "place":
      return { kind: "place", placeId: location.placeId };
    case "saved-location":
      return {
        kind: "saved-location",
        savedLocationId: location.savedLocationId,
      };
    case "freeform":
      if (location.addressText && existingFreeformSavedLocation) {
        return {
          kind: "saved-location",
          savedLocationId: existingFreeformSavedLocation.id,
        };
      }
      // INLINE, built directly — NOT via `eventTaxRateLocationRef`, whose
      // inline arm demands both a postal code and a country. The row this
      // address is about to be minted as stores whichever of the three the
      // user typed, and the old in-tx path hydrated that row as-is: a
      // Canadian address with a region but no postal code still reached the
      // static GST/HST branch (keyed on country + region). The inline ref
      // must tolerate the same nulls the row did; the provider gate
      // (postal code AND country) lives inside `lookupAdmissionTaxRate`.
      // (`addressText` is required at the boundary whenever lat/lng are
      // given, so a freeform save always mints or links a row.)
      return {
        kind: "inline",
        postalCode: location.postalCode ?? null,
        countryCode: location.countryCode ?? null,
        region: location.region ?? null,
      };
    case "none":
      return null;
    default: {
      const _exhaustive: never = location;
      return _exhaustive;
    }
  }
}

/**
 * Whether this save changed the event's location relative to the existing row.
 * This is the "location changed" signal that gates a tax-rate restamp.
 *
 * New events (no `existingEvent`) always count as changed. Otherwise we compare
 * the new location's identity to the existing event's persisted location:
 *  - place:          existing `placeId`
 *  - saved-location: existing `savedLocationId`
 *  - freeform:       the SavedLocation we created/linked vs existing `savedLocationId`
 *                    (the freeform address is normalized into a SavedLocation, so
 *                    that id is the stable identity to compare)
 *  - none:           whether the event previously had any location at all
 */
function didLocationChange(
  existingEvent: EventRecord | null,
  location: NormalizedLocation,
  freeformSavedLocationId: string | null,
): boolean {
  if (!existingEvent) {
    return true;
  }

  switch (location.kind) {
    case "place":
      return existingEvent.placeId !== location.placeId;
    case "saved-location":
      return existingEvent.savedLocationId !== location.savedLocationId;
    case "freeform":
      // The freeform address was normalized into this SavedLocation id.
      return existingEvent.savedLocationId !== freeformSavedLocationId;
    case "none":
      return (
        existingEvent.placeId != null ||
        existingEvent.savedLocationId != null ||
        existingEvent.addressText != null
      );
    default: {
      const _exhaustive: never = location;
      return _exhaustive;
    }
  }
}
