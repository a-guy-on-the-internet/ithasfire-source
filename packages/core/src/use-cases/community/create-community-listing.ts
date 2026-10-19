import { enqueueEventFollowers } from "../follows/enqueue-event-followers";
import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { ContentFilterPort } from "@th/ports/content-filter";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import type { EventBody } from "@th/schema";
import {
  eventAttendanceModeSchema,
  eventStatusSchema,
  eventStewardshipSchema,
} from "@th/schema";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import {
  plainTextOptional,
  plainTextRequired,
} from "../../lib/sanitize-plain-text";
import { requirePlatformStaff } from "../../lib/rbac";
import { encodeGeohash } from "../../lib/geo/geohash";
import { generateEventSlug } from "../events/_shared/slug";
import { sanitizeEventBody } from "../events/_shared/event-body-sanitizer";
import { reindexAfterMutation } from "../search/reindex-after-mutation";
import { markForSearchReindex } from "../search/search-reindex-marks";
import {
  bookingHoldNotificationIntentSchema,
  bookingHoldStaffRecipientHintSchema,
} from "../booking-holds/_shared/booking-hold-intents";
import {
  settleHeldDatesForEvent,
  type SettleHeldDatesForEventResult,
} from "../booking-holds/settle-held-dates-for-published-event";
import {
  COMMUNITY_MODERATION_ROLES,
  ensureSuggestionTextAllowed,
} from "./_shared/suggestion-validation";
import {
  LINKED_PLACE_PRIVACY,
  resolveListingPlaceLocation,
} from "./_shared/resolve-listing-place";
import {
  applyRecurrenceForEvent,
  recurrenceScheduleSchema,
} from "./_shared/community-recurrence";

/**
 * FR-005 (community-managed-event-listings spec): a verified community
 * moderator (or platform ADMIN) creates an ownerless RSVP+COMMUNITY listing.
 * Does NOT route through publishEvent (which requires an owner, ticket types,
 * and payout terms) — slug/shortId + geohash are generated inline and the row
 * is written via `events.createCommunityListing`.
 *
 * `status` picks the birth state and DEFAULTS to "PUBLISHED", so the original
 * one-shot form (create = go live) is unchanged. Passing "DRAFT" mints an
 * invisible row for the EventBuilder to author against and defers going live
 * to `publishCommunityListing` — the body-image and hero upload paths need an
 * `eventId` that only exists once the row does.
 *
 * Creator attribution lives ONLY in the AuditLog (`community_listing.created`)
 * — never in Event.humanId/orgId (spec decision: listings are ownerless by
 * design; owner columns would leak them into dashboards/payout paths).
 *
 * v1 scope notes:
 *  - `heroImageId` is NOT accepted at create. The FR-015 suggestion-upload
 *    flow keys images to an EXISTING event (`events/{eventId}/...` storage
 *    keys + Image.eventId FK), so no image can reference this event before
 *    the row exists. Moderators add a hero post-create through the normal
 *    edit-suggestion flow.
 *  - `lat`/`lng` are REQUIRED (with `addressText`/`countryCode`) unless a
 *    `placeId` is given: `CreateCommunityListingInput` requires the full pin
 *    for map/discovery surfaces, and the slug needs `countryCode`. With a
 *    `placeId` the pin and address are copied from the place instead.
 */

/**
 * What a DRAFT create settles: nothing. Mirrors the helper's own internal
 * no-op result so the two branches below return the same shape.
 */
const NO_HELD_DATES: SettleHeldDatesForEventResult = {
  confirmed: [],
  released: [],
  intents: [],
  staffRecipientHint: null,
};

/** Accepts a Date or ISO datetime string (transport payloads) → valid Date. */
const instantSchema = z
  .union([z.date(), z.string().trim()])
  .transform((value, ctx) => {
    const date = value instanceof Date ? value : new Date(Date.parse(value));
    if (Number.isNaN(date.getTime())) {
      ctx.addIssue({ code: "custom", message: "Invalid datetime" });
      return z.NEVER;
    }
    return date;
  });

/** IANA timezone check — same Intl runtime probe the owned builder uses. */
const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "invalid timezone");

export const createCommunityListingInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    title: plainTextRequired(140),
    startsAt: instantSchema,
    endsAt: instantSchema,
    timezone: timezoneSchema,
    /**
     * The venue the listing is at. When set, the PLACE is the source of truth
     * for the address and coordinates: every address field below is optional
     * and, if sent, ignored (see `resolveListingLocation`). When absent, the
     * address fields are required exactly as before (see the superRefine).
     */
    placeId: z.uuid().nullable().optional(),
    /** Required unless `placeId` is set (superRefine). */
    addressText: plainTextRequired(280).optional(),
    /**
     * Required unless `placeId` is set (superRefine) — slug generation
     * depends on it (FR-005).
     */
    countryCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/, "must be a 2-letter ISO country code")
      .transform((value) => value.toUpperCase())
      .optional(),
    region: plainTextOptional(200).nullable().optional(),
    locality: plainTextOptional(200).nullable().optional(),
    postalCode: z.string().trim().max(20).nullable().optional(),
    /** Required unless `placeId` is set (superRefine). */
    lat: z.number().gte(-90).lte(90).optional(),
    /** Required unless `placeId` is set (superRefine). */
    lng: z.number().gte(-180).lte(180).optional(),
    categoryId: z.uuid().nullable().optional(),
    /** Full EventBody JSON; deep-validated via sanitizeEventBody below. */
    content: z.unknown().nullable().optional(),
    ageLimit: z.number().int().min(0).max(99).nullable().optional(),
    /**
     * Optional recurrence: turns this into a listing that repeats as ONE row
     * (e.g. a weekly open mic). When present, `startsAt`/`endsAt` describe the
     * duration/time-of-day template and the Event is pinned to the FIRST
     * upcoming expanded date. Absent = single-date listing (unchanged).
     */
    recurrenceSchedule: recurrenceScheduleSchema.nullable().optional(),
    /**
     * Birth state. DEFAULTS to "PUBLISHED" so every pre-existing caller (the
     * standalone moderator form, seeds, tests) keeps the original
     * create-is-go-live behaviour without passing anything.
     *
     * "DRAFT" is the EventBuilder path: the row is minted invisible
     * (`publishedAt` null, absent from public reads / suggestions / search)
     * and `publishCommunityListing` is what takes it live. Only these two —
     * CANCELLED/COMPLETED/ARCHIVED are end-states, never a create.
     */
    status: z.enum(["DRAFT", "PUBLISHED"]).default("PUBLISHED"),
  })
  .strict()
  .superRefine((value, ctx) => refineCreateCommunityListingInput(value, ctx));

/** The fields {@link refineCreateCommunityListingInput} reads. */
type CreateCommunityListingRefineFields = {
  startsAt: Date;
  endsAt: Date;
  placeId?: string | null;
  addressText?: string;
  countryCode?: string;
  lat?: number;
  lng?: number;
};

/** Address fields a freeform (no `placeId`) listing must carry. */
const FREEFORM_REQUIRED_ADDRESS_FIELDS = [
  "addressText",
  "countryCode",
  "lat",
  "lng",
] as const;

/**
 * Cross-field rules for the create input. Exported so the tRPC router, which
 * rebuilds the object from `.shape` (zod 4 forbids `.omit()` on a refined
 * schema), applies the SAME rules at its boundary.
 *
 *  - `endsAt` must be after `startsAt` (path `["endsAt"]`).
 *  - With no `placeId` (absent or null), `addressText`, `countryCode`, `lat`
 *    and `lng` are each required (one issue per missing field, path
 *    `[<field>]`) — exactly the pre-placeId contract.
 *  - With a `placeId`, none of them is required; the place supplies them.
 */
export function refineCreateCommunityListingInput(
  value: CreateCommunityListingRefineFields,
  ctx: z.RefinementCtx,
): void {
  if (value.endsAt.getTime() <= value.startsAt.getTime()) {
    ctx.addIssue({
      code: "custom",
      path: ["endsAt"],
      message: "must be after startsAt",
    });
  }
  if (value.placeId == null) {
    for (const field of FREEFORM_REQUIRED_ADDRESS_FIELDS) {
      if (value[field] === undefined) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: "required when no placeId is given",
        });
      }
    }
  }
}

export const createCommunityListingOutputSchema = z
  .object({
    event: z
      .object({
        id: z.uuid(),
        title: z.string(),
        slug: z.string().nullable(),
        shortId: z.string().nullable(),
        status: eventStatusSchema,
        attendanceMode: eventAttendanceModeSchema,
        stewardship: eventStewardshipSchema,
        startsAt: z.date(),
        endsAt: z.date().nullable(),
        timezone: z.string(),
      })
      .strict(),
    /**
     * Booking-hold notifications this create owes (FR-018). Always empty for a
     * DRAFT create (an invisible listing takes no line) and, today, for a
     * PUBLISHED one too — community listings carry no calendar. Wired so the
     * rule holds if that ever changes. Server-side only.
     */
    notificationIntents: z.array(bookingHoldNotificationIntentSchema).optional(),
    staffRecipientHint: bookingHoldStaffRecipientHintSchema.nullable().optional(),
  })
  .strict();

/**
 * What transport puts on the wire: the intents + routing hint stay
 * server-side. Built from the omitted `.shape` (not `.omit()` on the strict
 * object) so `.parse(liveResult)` STRIPS the two keys instead of refusing the
 * result with `unrecognized_keys` the first time a listing actually owes one.
 */
export const createCommunityListingWireOutputSchema = z.object(
  createCommunityListingOutputSchema.omit({
    notificationIntents: true,
    staffRecipientHint: true,
  }).shape,
);

export type CreateCommunityListingUseCaseInput = z.infer<
  typeof createCommunityListingInputSchema
>;
export type CreateCommunityListingUseCaseOutput = z.infer<
  typeof createCommunityListingOutputSchema
>;

export type CreateCommunityListingDeps = {
  repos: Repos;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  contentFilter: ContentFilterPort;
  /**
   * Optional: best-effort incremental search-index update after create. When
   * omitted (seed scripts, tests without a search fake), indexing is skipped —
   * `reindexAfterMutation` no-ops without a `search` dep and the nightly
   * `search.full-reindex` still reconciles the row.
   */
  search?: MultiSearchPort;
  logger?: LoggerPort;
};

/** The location columns a new listing is written with. */
type ListingLocation = {
  placeId: string | null;
  addressText: string;
  countryCode: string;
  region: string | null;
  locality: string | null;
  postalCode: string | null;
  lat: number;
  lng: number;
  geohash6: string;
};

/**
 * Resolves where a new listing is: the picked place (checked and copied by
 * the shared `resolveListingPlaceLocation`, which ignores any client-sent
 * address value) or, with no `placeId`, the freeform address the schema
 * required.
 */
async function resolveListingLocation(
  tx: TxRepos,
  input: CreateCommunityListingUseCaseInput,
): Promise<ListingLocation> {
  if (input.placeId == null) {
    const { addressText, countryCode, lat, lng } = input;
    // The schema's superRefine already requires these without a placeId;
    // this narrows the types and fails closed if that rule is ever loosened.
    if (
      addressText === undefined ||
      countryCode === undefined ||
      lat === undefined ||
      lng === undefined
    ) {
      throw fail("INVALID_INPUT", {
        message: "addressText, countryCode, lat and lng are required without a placeId",
      });
    }
    return {
      placeId: null,
      addressText,
      countryCode,
      region: input.region ?? null,
      locality: input.locality ?? null,
      postalCode: input.postalCode ?? null,
      lat,
      lng,
      geohash6: encodeGeohash(lat, lng, 6),
    };
  }

  return resolveListingPlaceLocation(tx, input.placeId);
}

export async function createCommunityListing(
  deps: CreateCommunityListingDeps,
  rawInput: unknown,
): Promise<CreateCommunityListingUseCaseOutput> {
  const scopedLogger = deps.logger?.child({
    useCase: "createCommunityListing",
  });

  const execute = async (): Promise<CreateCommunityListingUseCaseOutput> => {
    const input = parseInput(createCommunityListingInputSchema, rawInput);

    // FR-005 actor gate: COMMUNITY_MODERATOR or platform ADMIN.
    await requirePlatformStaff({
      authz: deps.authz,
      actorHumanId: input.actorHumanId,
      roles: COMMUNITY_MODERATION_ROLES,
    });

    // Body: schema + embed allowlist + cta href checks; PERSIST THE RETURNED
    // normalized value (sanitizeEventBody contract).
    const content: EventBody | null =
      input.content == null ? null : sanitizeEventBody(input.content);

    // Content filter over title + extracted body text (NFR-001). The address
    // fields are deliberately exempt — see ensureSuggestionTextAllowed.
    await ensureSuggestionTextAllowed({
      contentFilter: deps.contentFilter,
      title: input.title,
      content,
    });

    const { event, heldDates } = await deps.repos.tx(async (tx) => {
      // Where the listing is: the picked place (read and checked HERE, in the
      // same transaction as the insert) or the freeform address. Resolved
      // before the slug, because the slug's geo segments come from it.
      const location = await resolveListingLocation(tx, input);

      // Slug/shortId are generated inline (no publish pipeline). The shortId
      // is derived from a fresh UUID seed: the DB generates the row id at
      // insert, so there is no event id to derive from yet — the shortId only
      // needs to be a stable unique suffix, not linked to the row id.
      const slugSeedEventId = crypto.randomUUID();
      const generated = generateEventSlug({
        eventId: slugSeedEventId,
        orgId: null,
        humanId: null,
        eventTitle: input.title,
        startsAt: input.startsAt,
        // The zone the event row is written with below, so the slug's date
        // is the listing's local start.
        timezone: input.timezone,
        // Ownerless: host segment falls back to "event" (FR-005).
        orgName: null,
        countryCode: location.countryCode,
        regionCode: location.region,
        cityOrRegionCode: location.locality ?? location.region,
        shortId: null,
      });

      if (input.categoryId) {
        const category = await tx.categories.getById(input.categoryId);
        if (!category) {
          throw fail("CATEGORY_NOT_FOUND");
        }
        if (!category.active) {
          throw fail("CATEGORY_INACTIVE");
        }
      }

      const now = deps.clock.now();
      // A DRAFT has not gone live, so it carries no go-live stamp. `publish`
      // stamps it later; until then `publishedAt === null` is what tells a
      // never-published listing from a re-published one.
      const publishing = input.status === "PUBLISHED";
      const created = await tx.events.createCommunityListing({
        title: input.title,
        content,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        timezone: input.timezone,
        placeId: location.placeId,
        // Linked: the listing takes the place's privacy (EXACT, no radius, no
        // reveal schedule). A community listing has no setting of its own.
        ...(location.placeId !== null
          ? { locationPrivacy: LINKED_PLACE_PRIVACY }
          : {}),
        addressText: location.addressText,
        countryCode: location.countryCode,
        region: location.region,
        locality: location.locality,
        postalCode: location.postalCode,
        lat: location.lat,
        lng: location.lng,
        geohash6: location.geohash6,
        categoryId: input.categoryId ?? null,
        heroImageId: null,
        ageLimit: input.ageLimit ?? null,
        slug: generated.slug,
        shortId: generated.shortId,
        regionCode: generated.regionCode,
        attendanceMode: "RSVP",
        stewardship: "COMMUNITY",
        status: input.status,
        publishedAt: publishing ? now : null,
        recurrenceSchedule: input.recurrenceSchedule ?? null,
      });

      // Recurring listing: expand the schedule into EventDate rows and pin the
      // Event's startsAt/endsAt to the FIRST upcoming occurrence, so existing
      // discovery/sorting + geo×category SEO queries (which filter
      // startsAt >= now) treat it as one upcoming card. Zero future dates →
      // typed RECURRENCE_HAS_NO_UPCOMING_DATES (bubbles up, rolls back).
      let event = created;
      if (input.recurrenceSchedule) {
        const recurrence = await applyRecurrenceForEvent(tx, {
          eventId: created.id,
          schedule: input.recurrenceSchedule,
          timezone: input.timezone,
          baseStartsAt: input.startsAt,
          baseEndsAt: input.endsAt,
          now,
          // A listing born in this transaction has no prior occurrences, so
          // nothing can drop and nobody can have RSVP'd. "refuse" states that
          // as an assertion rather than leaving a fan-out policy implicit.
          droppedRsvpDates: "refuse",
        });
        event = await tx.events.applyCommunityEdit({
          eventId: created.id,
          fields: {
            startsAt: recurrence.firstStartsAt,
            endsAt: recurrence.firstEndsAt,
          },
        });
      }

      // FR-018: a listing that is born PUBLISHED takes its dates from any
      // holds on its calendar — a no-op while community listings carry no
      // calendar, wired so the rule cannot be missed if they ever do.
      //
      // A listing born DRAFT takes NOTHING: an invisible row must not evict a
      // venue's holds. The identical call moved to
      // `publishCommunityListing`, which is where a DRAFT becomes live — the
      // rule is "a PUBLISHED listing owns its dates", and it is now enforced
      // at both places a listing can become PUBLISHED. Keep the two in step.
      const heldDates = publishing
        ? await settleHeldDatesForEvent(tx, {
            event,
            now,
            actorHumanId: input.actorHumanId,
            // Ownerless listing: the moderator is held to the venue-staff bar.
            owner: { kind: "community" },
          })
        : NO_HELD_DATES;

      // Creator attribution lives ONLY here (spec decision) — the row itself
      // stays ownerless.
      await tx.audit.log({
        entity: "event",
        entityId: created.id,
        action: "community_listing.created",
        data: {
          actorHumanId: input.actorHumanId,
          title: input.title,
          slug: created.slug,
          startsAt: event.startsAt.toISOString(),
          endsAt: event.endsAt?.toISOString() ?? null,
          countryCode: location.countryCode,
          placeId: location.placeId,
          categoryId: input.categoryId ?? null,
          recurring: input.recurrenceSchedule != null,
          status: input.status,
        },
        at: now,
      });

      await markForSearchReindex(tx, [{ kind: "event", id: created.id }], now);
      if (publishing) await enqueueEventFollowers(tx, event, now);
      return { event, heldDates };
    });

    // Best-effort incremental search-index update AFTER commit (never index a
    // row that rolled back). Fire-and-forget: mirrors publishEvent so a fresh
    // COMMUNITY listing shows up in search/home rails immediately instead of
    // waiting for the nightly full-reindex. No-ops when `search` is absent.
    //
    // Called for a DRAFT too, deliberately: `buildSearchIndex` is
    // upsert-or-REMOVE keyed on `status === "PUBLISHED"`, so this is the path
    // that guarantees a draft listing is absent from the index rather than
    // merely not-yet-added. Unconditional beats "skip it, a new id cannot be
    // indexed" — the second is an assumption, the first is enforcement.
    reindexAfterMutation(
      {
        repos: deps.repos,
        search: deps.search,
        clock: deps.clock,
        logger: deps.logger,
      },
      "createCommunityListing",
      { kind: "event", id: event.id },
    );

    return createCommunityListingOutputSchema.parse({
      event: {
        id: event.id,
        title: event.title,
        slug: event.slug,
        shortId: event.shortId,
        status: event.status,
        attendanceMode: event.attendanceMode,
        stewardship: event.stewardship,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        timezone: event.timezone,
      },
      ...(heldDates.intents.length > 0
        ? {
            notificationIntents: heldDates.intents,
            staffRecipientHint: heldDates.staffRecipientHint,
          }
        : {}),
    });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("createCommunityListing", execute);
  }

  return execute();
}
