import type { CategoryNameTranslations } from "../category-names";

export type EventStatus =
  | "DRAFT"
  | "PUBLISHED"
  | "ARCHIVED"
  | "CANCELLED"
  | "COMPLETED";
/**
 * How attendance works: TICKETED (ticket types / checkout / tax / payouts —
 * every pre-existing event) vs RSVP (free — a signed-in user just says
 * "I'm going"; no money paths). RSVP is only reachable via COMMUNITY
 * stewardship in v1.
 */
export type EventAttendanceMode = "TICKETED" | "RSVP";
/**
 * Who maintains the listing: OWNED (a human or org — every pre-existing
 * event) vs COMMUNITY (ownerless; humanId AND orgId are null, edits flow
 * through the moderated suggestion queue).
 */
export type EventStewardship = "OWNED" | "COMMUNITY";
export type EventVisibility = "PUBLIC" | "PRIVATE";
export type EventGateType = "NONE" | "APPLICATION" | "PASSWORD";
/**
 * EXACT — full public address + coordinates.
 * OBSCURED — public pre-reveal view governed by `locationRadiusMeters`
 * (non-null = obfuscated circle, null = fully hidden / no public map); the
 * exact address is always revealed to ticket holders at the mandatory
 * `addressRevealAt`. Legacy APPROXIMATE/HIDDEN collapsed into OBSCURED.
 */
export type EventLocationMode = "EXACT" | "OBSCURED";
/**
 * Reveal schedule for an OBSCURED event's exact address.
 *
 * Every member except `NEVER` resolves a NON-NULL `addressRevealAt`.
 * `NEVER` is the one member that deliberately resolves `addressRevealAt =
 * null`, and it is what makes a null reveal date READABLE. Before it existed,
 * a null on an OBSCURED event could only be an invariant violation, so
 * `redactLocation` and `buildEventSeo` fail-close on it and every reader had
 * to guess whether the row was broken.
 *
 * The redaction behaviour is UNCHANGED: `(OBSCURED, NEVER, null)` stays locked
 * forever — to everyone, including ticket holders, past any date. All `NEVER`
 * adds is intent: `(OBSCURED, preset = NEVER, at = null)` is a choice, while
 * `(OBSCURED, preset = null, at = null)` is still a defect.
 */
export type AddressRevealPreset =
  | "IMMEDIATELY"
  | "ONE_HOUR_BEFORE"
  | "DAY_BEFORE"
  | "WEEK_BEFORE"
  | "CUSTOM"
  | "NEVER";
export type WaitlistStatus = "DISABLED" | "SCHEDULED" | "OPEN";
export type WaitlistEntrySource = "PUBLIC" | "INVITE" | "APPLICATION";
export type WaitlistEntryStatus =
  | "PENDING"
  | "NOTIFIED"
  | "PURCHASED"
  | "DROPPED";
export type ApplicationQuestionType =
  | "SHORT_TEXT"
  | "LONG_TEXT"
  | "MULTI_CHOICE"
  | "SINGLE_CHOICE";
/**
 * What an application form is FOR (open calls v1, spec data block): ATTEND is
 * the attendee gate (Event.gateType APPLICATION); PERFORM is an open call for
 * acts. An event holds at most one form of each; a series holds at most one
 * PERFORM form. Every event-keyed form/submission read names its purpose, so
 * no caller can read the other form by accident.
 */
export type ApplicationFormPurpose = "ATTEND" | "PERFORM";
export type ApplicationSubmissionStatus =
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "WITHDRAWN"
  | "EXPIRED"
  | "WAITLISTED";
export type InviteListOwnerType = "HUMAN" | "ORGANIZATION";

export type ContactImportFileFormat = "CSV" | "XLSX";

export interface SaveEventInput {
  eventId?: string | null;
  orgId: string | null;
  humanId: string | null;
  title: string;
  /**
   * Draft event page/body content (ProseMirror JSON blocks). Stored as JSONB.
   * Validated at the use-case boundary.
   */
  content?: unknown | null;
  startsAt: Date;
  endsAt?: Date | null;
  status: EventStatus;
  defaultLocale?: string | null;
  /**
   * IANA timezone identifier (e.g. "America/Chicago"). Optional on input — use
   * cases default it from the linked EventSeries or a sensible fallback.
   */
  timezone?: string | null;
  /**
   * `place` — the adapter copies the location columns FROM the Place, under
   * the withheld-venue contract documented on `EventRecord.addressText`: at a
   * place that is not EXACT it writes the venue's public projection (and
   * floors `locationMode`/`locationRadiusMeters` at the venue's), never the
   * true street or coordinates. `freeform` is stored as given.
   */
  location:
    | { kind: "place"; placeId: string }
    | { kind: "saved-location"; savedLocationId: string }
    | {
        kind: "freeform";
        addressText: string;
        lat: number;
        lng: number;
        locality?: string | null;
        region?: string | null;
        countryCode?: string | null;
        postalCode?: string | null;
      }
    | { kind: "none" };
  /** Controls how the event location is displayed to public viewers. Defaults to EXACT. */
  locationMode?: EventLocationMode;
  /**
   * Public pre-reveal precision for OBSCURED events: radius in metres for the
   * obfuscation circle, or null = FULLY HIDDEN (no public map). Defaults to 500.
   */
  locationRadiusMeters?: number | null;
  /** Human-readable area label (e.g. "Downtown Austin") for redacted views. */
  locationLabel?: string | null;
  /**
   * When the exact address is revealed to ticket holders. REQUIRED (non-null)
   * for OBSCURED events — there is no 'never reveal' state; null only for
   * EXACT events.
   */
  addressRevealAt?: Date | null;
  /** Preset that generated `addressRevealAt` (for UI display in the edit form). */
  addressRevealPreset?: AddressRevealPreset | null;
  /** Place layout to assign for reserved-seating events. Null clears the link. */
  placeLayoutId?: string | null;
  /**
   * Venue-hierarchy placement (FR-005/FR-011): the named Calendar (programming
   * stream) the event shows on and the physical Space it blocks. Prisma patch
   * semantics — OMITTED leaves the stored value alone, explicit `null` clears
   * it. The same-place / ACTIVE-space invariants are the CALLER's (core)
   * obligation, asserted inside the save transaction; the adapter just writes.
   */
  calendarId?: string | null;
  spaceId?: string | null;
  /** Hero image to associate with the event. Null clears the link. */
  heroImageId?: string | null;
  /** Minimum age required for attendees. Null means no age restriction. */
  ageLimit?: number | null;
  /** Optional per-event override for reseller payout release timing, in whole days. */
  resalePayoutReleaseDaysOverride?: number | null;
  /**
   * Organizer-attested: admission is for INSTRUCTION only (classes / lessons /
   * courses). Drives the Tennessee instruction-only tax exemption at
   * save/publish/checkout. Omitted = leave unchanged (defaults false in DB).
   */
  instructionalAdmission?: boolean;
  createdAt?: Date;
}

/**
 * The Event location columns a linked Place writes onto its events.
 *
 * `geohash6` is included because it is derived from `lat`/`lng`; at a withheld
 * venue it is derived from the PUBLIC centre (or NULL), never the true point.
 */
export interface EventPlaceLocationColumns {
  lat: number | null;
  lng: number | null;
  geohash6: string | null;
  addressText: string | null;
  locality: string | null;
  region: string | null;
  countryCode: string | null;
  postalCode: string | null;
}

/**
 * What one Place projects onto EVERY event linked to it. Computed in core
 * (`projectPlaceLocationForEvents`) and handed to
 * `EventsRepo.reprojectLocationForPlace`, which applies it in one UPDATE.
 *
 *   exact    → the venue publishes its address: restore the true columns
 *              (the same values an event save copies from an EXACT place).
 *   withheld → the venue's public projection. The per-event radius is the
 *              event's own floored at `venueRadiusMeters`
 *              (`applyPlaceLocationFloor`), and an event whose floored radius
 *              is NULL (fully hidden) gets NO coordinates at all.
 */
export type PlaceEventLocationProjection =
  | { kind: "exact"; columns: EventPlaceLocationColumns }
  | {
      kind: "withheld";
      /** The venue's circle radius in metres; NULL = the venue is fully hidden. */
      venueRadiusMeters: number | null;
      /**
       * The venue's public circle centre, or NULL when the venue publishes no
       * map (fully hidden, or no coordinates). Written only to events whose
       * floored radius is non-null.
       */
      publicCentre: { lat: number; lng: number; geohash6: string | null } | null;
      /** Coarse fields published in every state. `addressText` = the area label. */
      addressText: string | null;
      locality: string | null;
      region: string | null;
      countryCode: string | null;
    };

export interface ReprojectEventLocationsForPlaceInput {
  placeId: string;
  projection: PlaceEventLocationProjection;
  /** Stamped on `updatedAt` (and on the reveal-notification cursor, see below). */
  now: Date;
  /**
   * The reveal schedule given to an event that was EXACT until this call and
   * carries neither a preset nor a date (withheld projections only). Mirrors
   * `resolveAddressReveal`'s default for a newly-OBSCURED event. An event
   * whose computed reveal is already `<= now` also gets its
   * `addressRevealNotifiedAt` cursor stamped, so the reveal job never
   * retro-announces an address its ticket holders already had.
   */
  defaultReveal: { preset: AddressRevealPreset; leadMs: number };
}

/**
 * The address follow (owner ruling 2026-10-14, "make events follow the
 * edits"): an EXACT place's edited address, written onto its UPCOMING events.
 * See `EventsRepo.followPlaceAddress`.
 */
export interface FollowPlaceAddressInput {
  placeId: string;
  /** The EXACT place's columns (`exactPlaceLocationColumns`). */
  columns: EventPlaceLocationColumns;
  /**
   * The place's timezone after this write. Only events whose own
   * `Event.timezone` equals it are written; the rest are returned as
   * skipped. NULL (zone unknown) writes nothing and skips every upcoming
   * event.
   */
  timezone: string | null;
  /** "Upcoming" is judged against this instant; also stamped on `updatedAt`. */
  now: Date;
}

export interface FollowPlaceAddressResult {
  /** Upcoming events rewritten with the new address. */
  followedIds: string[];
  /** Upcoming events left alone because their timezone differs (or is unknown). */
  skippedIds: string[];
}

export interface EventRecord {
  id: string;
  orgId: string | null;
  humanId: string | null;
  title: string;
  status: EventStatus;
  /** TICKETED (default; all money paths) or RSVP (free community attendance). */
  attendanceMode: EventAttendanceMode;
  /** OWNED (default) or COMMUNITY (ownerless, moderated edits). */
  stewardship: EventStewardship;
  visibility: EventVisibility;
  gateType: EventGateType;
  locationMode: EventLocationMode;
  /**
   * Public pre-reveal precision for OBSCURED events: radius in metres for the
   * obfuscation circle, or null = FULLY HIDDEN (no public map).
   */
  locationRadiusMeters: number | null;
  locationLabel: string | null;
  /**
   * When the exact address is revealed to ticket holders. Non-null for every
   * OBSCURED event (backfilled by migration 20260707100000); null for EXACT.
   */
  addressRevealAt: Date | null;
  /** Preset that produced `addressRevealAt`. Null on legacy events. */
  addressRevealPreset: AddressRevealPreset | null;
  /**
   * IANA timezone identifier (e.g. "America/Chicago") used to format event
   * dates/times (including address-reveal time) consistently regardless of the
   * viewer's locale.
   */
  timezone: string;
  startsAt: Date;
  endsAt: Date | null;
  placeId: string | null;
  savedLocationId: string | null;
  /**
   * Physical Space this event occupies (venue-hierarchy FR-005/FR-006).
   * Space = physical blocking: conflict detection keys on THIS column. Null
   * for freeform-address and pre-hierarchy events, which are EXEMPT from
   * space conflict analysis. Optional (not `| null` alone) because the field
   * was added after many purpose-built projections were written — absent
   * reads as null.
   */
  spaceId?: string | null;
  /**
   * Named Calendar (programming stream) this event shows on (FR-005).
   * Calendar rendering filters on THIS column — NEVER via the space join (a
   * shared space must not bleed one stream's events onto another's calendar).
   */
  calendarId?: string | null;
  categoryId: string | null;
  /**
   * schema.org Event `@type` inherited from the event's category
   * (`Category.seoType`), e.g. "MusicEvent". Null when the event has no
   * category. Consumed by the SEO builder, which falls back to "Event" for
   * null / unknown values (see `isValidEventSchemaType`).
   */
  categorySeoType: string | null;
  /** Display name of the event's category, for the SEO description. */
  categoryName?: string | null;
  /**
   * The category's non-English names keyed by locale (`{ es: "Música" }`),
   * beside the English `categoryName`. Absent / empty = no translation.
   */
  categoryNameTranslations?: CategoryNameTranslations | null;
  /**
   * Display name of the linked Place, when the event has a `placeId`.
   * Null for freeform-address events. Listing surfaces prefer this over
   * `addressText` — a venue name is what people scan by.
   */
  placeName: string | null;
  /**
   * ── LOCATION COLUMNS: the withheld-venue contract (place-address-withholding D1) ──
   *
   * For an event with `placeId` whose place is not EXACT, the Event row's
   * location fields are already a public projection; the TRUE location is on
   * the Place row only.
   *
   * Concretely, at a withheld venue these columns hold what the venue's public
   * redactor (`redactPlaceLocation`) emits and nothing derived from the true
   * point: `lat`/`lng` = the venue's public circle centre (NULL when the venue
   * or the event is fully hidden), `addressText` = the coarse area label,
   * `postalCode` = NULL, `locationMode` = OBSCURED and `locationRadiusMeters`
   * = the event's radius floored at the venue's (see
   * `packages/core/src/lib/location/place-event-location.ts`). The events
   * adapter enforces it on every `upsertDraft`, and `upsertPlace` re-projects
   * every event at a venue whose privacy changes. A reader that needs the TRUE
   * address of a place-linked event (a ticket holder past the reveal) must read
   * it from the Place, never from here.
   *
   * Freeform-address events (no `placeId`) are unaffected: their row IS the
   * source of truth and event-level OBSCURED is redacted at read time.
   */
  addressText: string | null;
  countryCode?: string | null;
  region?: string | null;
  locality?: string | null;
  /** NULL for an event at a withheld venue — see the location-columns contract above. */
  postalCode?: string | null;
  /** Public circle centre (or NULL) for an event at a withheld venue — see above. */
  lat: number | null;
  lng: number | null;
  /**
   * Draft event listing page content (ProseMirror JSON blocks). Stored as JSONB.
   * This is validated at the use-case boundary.
   */
  content?: unknown | null;
  slug: string | null;
  shortId: string | null;
  regionCode: string | null;
  publishedAt: Date | null;
  currentAttestationId?: string | null;
  /** Canonical payout terms ID. Null for drafts created before payout terms are configured. */
  payoutTermsId: string | null;
  /** Canonical resale payout terms ID. */
  resalePayoutTermsId: string | null;
  /** @deprecated Use payoutTermsId */
  agreementPrimaryId: string | null;
  /** @deprecated Use resalePayoutTermsId */
  agreementResaleId: string | null;
  /** Place layout assigned to this event (nullable when GA or no layout). */
  placeLayoutId: string | null;
  defaultLocale?: string | null;
  listingPriority?: number | null;
  passwordHash?: string | null;
  passwordUpdatedAt?: Date | null;
  waitlistStatus: WaitlistStatus;
  waitlistPublishAt?: Date | null;
  waitlistDescription?: string | null;
  waitlistCap?: number | null;
  /** Whether a confirmation email is sent when someone joins the waitlist. */
  waitlistEmailEnabled?: boolean;
  /** Custom subject line for the waitlist confirmation email. */
  waitlistEmailSubject?: string | null;
  /** Rich-text body (ProseMirror JSON) for the waitlist confirmation email. */
  waitlistEmailBody?: unknown | null;
  /**
   * Deadline for self-serve refund requests. When null, defaults to startsAt.
   * Organizers can set this earlier than event start to stop refunds sooner.
   */
  refundCutoffAt?: Date | null;
  /**
   * Public URL of the hero/cover image for this event (from EventImage).
   * Null when no hero image has been set.
   */
  heroImageUrl?: string | null;
  /**
   * R2 storage key of the hero image (from the joined EventImage). Carried
   * alongside `heroImageUrl` so PUBLIC read paths can run the moderation
   * visibility gate (keyed by storage key) and hide a pending/flagged hero.
   * Null when no hero image has been set. Legacy heroes with no moderation
   * record are treated as visible.
   */
  heroImageKey?: string | null;
  /**
   * Pixel size of the hero image as the browser displays it (from the joined
   * EventImage, read at upload). Null when there is no hero or its size is
   * unknown. Same visibility as `heroImageUrl`: public reads must drop it
   * whenever the moderation gate drops the url.
   */
  heroImageSize?: { width: number; height: number } | null;
  /**
   * ISO 4217 currency code for this event's pricing (e.g. "usd", "eur").
   * Stamped at publish time from the organizer's Stripe Connect account.
   * Null while the event is still a draft.
   */
  currency: string | null;
  /**
   * Admission tax rate in basis points (e.g. 975 = 9.75%). Null = tax-free
   * or not yet resolved. Stamped from the SavedLocation / Place at publish.
   */
  admissionTaxRateBps?: number | null;
  /** Source of the stamped rate: "ziptax", "manual", "exempt", etc. */
  taxRateSource?: string | null;
  /**
   * Organizer-attested: admission is for INSTRUCTION only (classes / lessons /
   * courses), not recreation. When true AND the tax situs is US/TN, admission
   * tax resolves to 0 with source "exempt:tn-instruction". Defaults false.
   */
  instructionalAdmission?: boolean;
  /** Whether volunteering is enabled for this event. */
  volunteeringEnabled?: boolean;
  /** Event-level default for auto-approve of volunteer signups. */
  volunteerAutoApprove?: boolean;
  /**
   * When true AND the event has an assigned waiver template, volunteer
   * signups require waiver acceptance (Gap 3).
   */
  volunteerWaiverRequired?: boolean;
  /** Optional intro text shown on the volunteer signup page. */
  volunteerIntroText?: string | null;
  /** Waiver template assigned to this event. Null if no waiver required. */
  waiverTemplateId?: string | null;
  /** Minimum age required for attendees. Null means no age restriction. */
  ageLimit?: number | null;
  /** Optional per-event override for reseller payout release timing, in whole days. */
  resalePayoutReleaseDaysOverride?: number | null;
  /**
   * Recurrence definition (RRULE / FIXED_DATES) for a listing that repeats as
   * ONE row. Null/absent = single-date event. Expanded occurrences live in
   * separate {@link EventDateRecord} rows.
   */
  recurrenceSchedule?: RecurrenceSchedule | null;
  // ── Venue confirmation (venue-confirmation-and-booking-intents spec,
  // docs/specs/2026-08-27) ───────────────────────────────────────────────────
  // Trust is PER EVENT: the venue vouches for THIS event at THIS place.
  //
  // Derived, never stored — core computes:
  //   isVenueConfirmed = (venueConfirmedAt != null && venueConfirmationWithdrawnAt == null
  //                       && venueConfirmedPlaceId === placeId)
  //                      OR the event owner (orgId / humanId) is a verified,
  //                      unrevoked PlaceOwnership owner of placeId
  //                      OR (stewardship === "COMMUNITY" && placeId != null
  //                          && Place.acceptsCommunityListings
  //                          && venueConfirmationWithdrawnAt == null).
  // The third arm (community-listings-at-claimed-venues FR-002) exists because
  // a COMMUNITY listing is OWNERLESS by DB constraint, so the owner arm can
  // never hold for one: the venue consents ONCE for the venue instead.
  // The stamp is BOUND TO THE PLACE: moving the event elsewhere voids it with
  // no write, so a confirmation can never travel to a venue that never saw it.
  // Public rendering (venue name + link vs address-only) and availability /
  // conflict blocking read that derivation ONLY. `placeId` is ALWAYS retained
  // regardless of confirmation.
  //
  // Optional (not `| null` alone) for the same reason as `spaceId`: the
  // columns post-date many purpose-built projections — absent reads as null.
  /** When the venue confirmed (or the migration stamped a venue-owned event). */
  venueConfirmedAt?: Date | null;
  /** Staff human who confirmed. Plain id. */
  venueConfirmedByHumanId?: string | null;
  /**
   * The place the venue vouched for. The stamp is live ONLY while
   * `placeId === venueConfirmedPlaceId` — see the derivation above.
   */
  venueConfirmedPlaceId?: string | null;
  /** The BookingRequest that produced the confirmation. Plain id, no FK. */
  venueConfirmationRequestId?: string | null;
  /** Non-null = withdrawn (NOT confirmed even though venueConfirmedAt is set). */
  venueConfirmationWithdrawnAt?: Date | null;
  venueConfirmationWithdrawnReason?: string | null;
  /**
   * `startsAt` as it was when the venue stamped the event — the date the
   * venue vouched for. Written by `setVenueConfirmation` from the row itself,
   * cleared by withdrawal. The withheld-venue reveal floor is
   * `max(startsAt, venueConfirmedStartsAt) − 24h` (core
   * `holderRevealSchedule`), so a third party that moves its confirmed show
   * EARLIER cannot pull the venue's address forward with it.
   */
  venueConfirmedStartsAt?: Date | null;
  /**
   * freeze-the-deal FR-001: when the event's whole deal froze (null = not
   * frozen), and who froze it (null = automatically, at first publish or by
   * the backfill). Read under the terms row lock by every deal write
   * (`deals/_shared/deal-freeze.ts`). Optional only so hand-built fakes still
   * type-check; the Prisma adapter always sets both.
   */
  dealFrozenAt?: Date | null;
  dealFrozenByHumanId?: string | null;
  /**
   * The status the event had when it was cancelled, copied from the row by
   * `EventsRepo.cancel` in the same transaction (the caller holds the row
   * lock). Null = not cancelled, or cancelled before the column existed
   * (2026-10-17). Optional only so hand-built fakes
   * still type-check; the Prisma adapter always sets it.
   */
  cancelledFromStatus?: EventStatus | null;
  /**
   * DERIVED at read time, never stored (ban-that-sticks, 2026-09-29): the
   * event's owner is withheld from public reads because of a ban — the owning
   * human is BANNED, or every OWNER of the owning org is. Loaded by the
   * single-event reads (`getById`, `findManyByIds`); `undefined` elsewhere.
   * Public-read gates treat `true` as "not publicly readable"
   * (`isEventPubliclyReadable`); list reads filter in SQL instead.
   */
  ownerBanned?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Event statuses that count as "a show that HAPPENED" for the venue track
 * record (venue-track-record-and-review-switch R10, ruled 2026-09-25):
 * `completeEvent` moves a fulfilled booking's event PUBLISHED → COMPLETED,
 * and those are the venue's own shows. Every track-record read — the stats
 * recompute, the page loader's window, the lineup history, the stale arms —
 * admits both. `listPublishedByPlace`'s default stays PUBLISHED-only.
 */
export const TRACK_RECORD_EVENT_STATUSES = ["PUBLISHED", "COMPLETED"] as const;

/**
 * Confirmed-only filter for place-scoped public reads (venue-confirmation
 * spec). When provided, an event is returned only when it is venue-confirmed
 * for THE PLACE BEING READ:
 *   `venueConfirmedAt IS NOT NULL AND venueConfirmationWithdrawnAt IS NULL
 *    AND venueConfirmedPlaceId = <the place being read>`
 *   OR `orgId IN orgIds` OR `humanId IN humanIds`
 *   OR (`acceptsCommunityListings` AND `stewardship = COMMUNITY`
 *       AND `venueConfirmationWithdrawnAt IS NULL`
 *       AND `placeId = <the place being read>`)
 * — the owner-id sets are the place's verified, unrevoked owners (resolved by
 * the caller, so the adapter never joins PlaceOwnership). Omitted = no
 * confirmation filter (admin reads derive confirmation in core). Empty arrays
 * are valid and simply match no owner.
 *
 * Build it with `venueConfirmedFilterFor(place)` in core — this is
 * `isVenueConfirmed` expressed for SQL, and the two are pinned together by
 * `packages/adapters/src/db/prisma/__tests__/venue-confirmed-parity.test.ts`.
 */
export interface VenueConfirmedFor {
  orgIds: string[];
  humanIds: string[];
  /**
   * `Place.acceptsCommunityListings` for the place being read
   * (community-listings-at-claimed-venues FR-004). False contributes no
   * clause at all.
   */
  acceptsCommunityListings: boolean;
}

/**
 * Stamp (or re-stamp) venue confirmation on one event. Clears any withdrawal.
 * `placeId` is the place the caller AUTHORIZED against; the write is a CAS on
 * `id = eventId AND placeId = placeId` and binds the stamp to that place.
 */
export interface SetVenueConfirmationInput {
  eventId: string;
  /** The place the caller authorized against — the CAS guard + the binding. */
  placeId: string;
  confirmedByHumanId: string;
  /** The BookingRequest that produced it; null for a direct confirm. */
  bookingRequestId: string | null;
  at: Date;
  /**
   * The start the confirming venue SAW (R3-1). When set, the CAS also
   * requires `startsAt = expectedStartsAt`: a show its organizer moved
   * after the venue's screen loaded is not stamped, and the adapter throws
   * the typed `{ code: "event_starts_at_mismatch" }`. Omitted by the
   * writers that stamp the row they just saved in the same transaction
   * (grant / manager save, the agreement mint).
   */
  expectedStartsAt?: Date | null;
}

/**
 * Withdraw venue confirmation. Leaves `venueConfirmedAt` as history; sets the
 * withdrawn pair. Idempotent: a second call with the same reason is a no-op
 * success (the original `withdrawnAt` is kept).
 */
export interface WithdrawVenueConfirmationInput {
  eventId: string;
  /** The place the caller authorized against — the CAS guard. */
  placeId: string;
  reason: string;
  at: Date;
}

/**
 * The complete set of surfaces on an event that can reference an uploaded
 * image. Fetched as a purpose-built projection for the storage GC
 * (`sweepOrphanedUploads`), which must not delete a blob that any of these
 * still point at.
 *
 * Deliberately NOT folded into `EventRecord`: that type omits both the hero FK
 * (it exposes the resolved `heroImageUrl`/`heroImageKey` instead) and the
 * builder `body` JSON, and a GC decision must read the raw, always-populated
 * columns rather than whatever a read-model happened to hydrate.
 */
export interface EventMediaReferenceSet {
  eventId: string;
  /** Raw `Event.heroImageId` FK — the id, not the resolved URL. */
  heroImageId: string | null;
  /**
   * EVERY free-form JSON column on the event that could mention an image id,
   * opaque here and walked wholesale by the GC.
   *
   * An array rather than a named `body` field on purpose: adding a new JSON
   * column to `Event` should be a one-line adapter change, not a silent new
   * blind spot for the sweep. Today: `body` (builder) and `waitlistEmailBody`.
   */
  bodies: unknown[];
}

import type { CommunityEditableFieldValues } from "./event-edit-suggestions.js";
import type { RecurrenceSchedule } from "./event-dates.js";

/**
 * Create an ownerless COMMUNITY listing (FR-005). Does NOT route through the
 * owned draft/publish pipeline: the caller (use case) generates slug/shortId +
 * geohash and stamps status/publishedAt here. `countryCode` is required (slug
 * generation depends on it). The literal attendanceMode/stewardship types make
 * it impossible to create an owned or ticketed row through this path.
 *
 * `status` is DRAFT or PUBLISHED only. DRAFT is how a listing authored in the
 * EventBuilder is minted — invisible everywhere until
 * `publishCommunityListing` flips it — and a DRAFT row carries
 * `publishedAt: null` (the column is the go-live stamp, not a lifecycle flag).
 * The union deliberately excludes ARCHIVED/CANCELLED/COMPLETED: those are
 * end-states, never a create.
 */
export interface CreateCommunityListingInput {
  title: string;
  /** Event listing body/description (ProseMirror JSON blocks). */
  content?: unknown | null;
  startsAt: Date;
  /** Required — Event.endsAt is a non-nullable column. */
  endsAt: Date;
  /** IANA timezone identifier (e.g. "America/Chicago"). */
  timezone: string;
  addressText: string;
  countryCode: string;
  region?: string | null;
  locality?: string | null;
  postalCode?: string | null;
  lat: number;
  lng: number;
  /** Derived server-side from lat/lng by the use case. */
  geohash6: string;
  categoryId?: string | null;
  heroImageId?: string | null;
  ageLimit?: number | null;
  slug: string;
  shortId: string;
  regionCode?: string | null;
  attendanceMode: "RSVP";
  stewardship: "COMMUNITY";
  status: "DRAFT" | "PUBLISHED";
  /** The go-live stamp. MUST be null when `status` is DRAFT. */
  publishedAt: Date | null;
  /**
   * Recurrence definition for a listing that repeats as ONE row (e.g. a weekly
   * open mic). Null/absent = single-date listing (unchanged). The expanded
   * {@link EventDateRecord} occurrences are written separately via the
   * EventDatesRepo; this only persists the schedule JSON on the Event.
   */
  recurrenceSchedule?: RecurrenceSchedule | null;
  /**
   * The venue the listing is at. Null/absent = a freeform-address listing.
   * When set, the use case has already copied the address and coordinates
   * from this place (ACTIVE, EXACT), so the row and the place agree.
   * Linking does NOT confirm the venue: no confirmation fields are set.
   */
  placeId?: string | null;
  /**
   * The place's location privacy, set when the listing is linked to a place
   * (always EXACT: only an EXACT place can be linked). Absent = the column
   * defaults apply.
   */
  locationPrivacy?: ExactLocationPrivacyReset;
}

/**
 * The location-privacy columns a COMMUNITY listing linked to a place takes.
 * A listing has no privacy setting of its own; the place is the source of
 * truth, and only an EXACT place can be linked, so: EXACT, no radius, and no
 * address-reveal schedule (the reveal cursor is cleared whenever a reset is
 * written, unaudited bookkeeping, so a later
 * re-obscuring cascade schedules and announces a fresh reveal).
 */
export interface ExactLocationPrivacyReset {
  locationMode: "EXACT";
  locationRadiusMeters: null;
  addressRevealAt: null;
  addressRevealPreset: null;
  addressRevealNotifiedAt: null;
}

/**
 * Apply an approved edit-suggestion diff to an event — ANY event kind
 * (COMMUNITY, org-owned, or personal; suggestions are universal per FR-006).
 * Restricted to the whitelisted {@link CommunityEditableFieldValues} — never
 * a free-form partial Event update.
 */
export interface ApplyCommunityEditInput {
  eventId: string;
  /** Partial whitelisted diff; only present keys are written. */
  fields: CommunityEditableFieldValues;
  /**
   * Re-derived geohash when the diff moves the pin. When omitted and the
   * diff touches lat/lng, the adapter resolves the effective pair
   * (pre-reading the stored row if only one side is in the diff) and
   * re-derives geohash6 itself — or nulls it when the pin is cleared.
   */
  geohash6?: string | null;
  /**
   * Optional recurrence-schedule change. `undefined` leaves the stored
   * schedule untouched; a value replaces it; `null` clears it (revert to a
   * single-date listing). Persisting the JSON here is a data-layer capability
   * for a later slice that recomputes {@link EventDateRecord} rows on edit —
   * the review/apply use-case wiring is NOT part of slice 1.
   */
  recurrenceSchedule?: RecurrenceSchedule | null;
  /**
   * Place link change, moderator direct edit only (never a suggestion):
   * `undefined` leaves `placeId` untouched, a string links, `null` unlinks.
   * The caller copies the place's address/geo into `fields` itself; this
   * writes the link column and nothing else (no venue confirmation).
   */
  placeId?: string | null;
  /**
   * Reset the location-privacy columns to the linked place's (EXACT), moderator
   * direct edit only, alongside a place link or re-sync. Absent = untouched.
   */
  locationPrivacy?: ExactLocationPrivacyReset;
}

export interface EventAttestationAcknowledgements {
  legalRightToHost: boolean;
  zoningAndNoiseCompliance: boolean;
  alcoholCompliance: boolean;
  taxResponsibility: boolean;
  organizerFaqReviewed: boolean;
}

export interface EventAttestationRecord
  extends EventAttestationAcknowledgements {
  id: string;
  eventId: string;
  /** Null when the attesting account has been deleted (attester detached). */
  attestedByHumanId: string | null;
  attestedAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  policyVersion: string;
  policyTextSnapshot: Record<string, string>;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export interface CreateEventAttestationInput
  extends EventAttestationAcknowledgements {
  eventId: string;
  attestedByHumanId: string;
  attestedAt: Date;
  ipAddress?: string | null;
  userAgent?: string | null;
  policyVersion: string;
  policyTextSnapshot: Record<string, string>;
  metadata?: Record<string, unknown> | null;
}

import type { TicketTypeStatus } from "./tickets.js";

export interface EventTicketTypeSummary {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  pricingMode: import("./tickets.js").TicketTypePricingMode;
  minimumCents: number | null;
  suggestedCents: number | null;
  capacity: number;
  status: TicketTypeStatus;
  seatSectionId?: string | null;
  /** Whether tickets of this type can be listed for resale. */
  resaleAllowed: boolean;
  /** Maximum resale price in cents. Null = no cap. */
  resaleCapCents: number | null;
  /** Whether tickets of this type can be transferred (gifted). */
  transferAllowed: boolean;
  /**
   * Scheduled price change (time-based-ticket-pricing FR-005). Both null or
   * both set. NEVER read `priceCents` off this summary directly at a
   * money-authoritative site — pass the whole summary to
   * `resolveUnitPriceCents(tt, { now })` so the schedule applies.
   */
  scheduledPriceCents: number | null;
  scheduledPriceAt: Date | null;
  /**
   * Per-type sales window (ticket-type-packs FR-014). Null = no bound, which is
   * every pre-existing row. `salesOpenAt` INCLUSIVE, `salesCloseAt` EXCLUSIVE.
   *
   * NEVER compare these by hand at a money site — pass the summary to
   * `assertTicketTypeOnSale(tt, now)` so the POS, checkout and cart surfaces
   * cannot disagree about whether a tier is sellable.
   */
  salesOpenAt: Date | null;
  salesCloseAt: Date | null;
}

/**
 * Aggregated stats for calculating event popularity score in search indexing.
 */
export interface EventPopularityStats {
  eventId: string;
  ticketsSold: number;
  waitlistCount: number;
  totalCapacity: number;
}

export interface EventSlugHistoryRecord {
  eventId: string;
  slug: string;
  recordedAt: Date;
}

export interface EventSlugResolution {
  eventId: string;
  currentSlug: string;
  redirect: boolean;
}

export interface EventSitemapEntryRecord {
  slug: string;
  updatedAt: Date | null;
}

export interface EventSlugContext {
  eventId: string;
  orgId: string | null;
  humanId: string | null;
  eventTitle: string;
  startsAt: Date;
  /**
   * `Event.timezone` (IANA). The slug's date segment is the event's LOCAL
   * start in this zone, not the UTC instant: a 7pm Chicago show is 00:00 UTC
   * the next day.
   */
  timezone: string;
  /**
   * The ONLY name that may reach an event URL. There is deliberately no
   * `humanName`: a person-owned event's host segment is the neutral `event`,
   * because a person's real name + city + date in a public URL is a lead to
   * their home address. Do not add one back.
   */
  orgName: string | null;
  countryCode: string | null;
  regionCode: string | null;
  cityOrRegionCode: string | null;
  shortId: string | null;
}

export interface AssignEventSlugInput {
  eventId: string;
  slug: string;
  shortId: string;
  regionCode: string | null;
  assignedAt: Date;
}

export interface UpdateEventSlugInput {
  eventId: string;
  slug: string;
  regionCode: string | null;
  updatedAt: Date;
}

export interface RecordEventSlugHistoryInput {
  eventId: string;
  slug: string;
  recordedAt: Date;
}

/**
 * One row of `EventsRepo.listSluggedPage`: just what the slug date
 * correction needs to classify an event's slug.
 */
export interface EventSlugDateRow {
  id: string;
  slug: string;
  startsAt: Date;
  timezone: string;
  status: EventStatus;
  /**
   * When the event row was created. The correction only reinterprets a slug's
   * date segment as a UTC instant for events created before the local-slug fix
   * was deployed (`utcMintedBefore`).
   */
  createdAt: Date;
}

/**
 * `EventsRepo.setSlugOnly`: writes `Event.slug` (and the automatic
 * `updatedAt`) and nothing else.
 */
export interface SetEventSlugOnlyInput {
  eventId: string;
  slug: string;
}

export interface ListSluggedEventsPageInput {
  /** Keyset cursor: only ids strictly greater than this. Null = first page. */
  afterId: string | null;
  limit: number;
}

export interface SetListingPriorityInput {
  eventId: string;
  priority: number | null;
}

export interface EventGateSettings {
  eventId: string;
  visibility: EventVisibility;
  gateType: EventGateType;
  passwordHash: string | null;
  passwordUpdatedAt: Date | null;
  waitlistStatus: WaitlistStatus;
  waitlistPublishAt: Date | null;
  waitlistDescription: string | null;
  waitlistCap: number | null;
  waitlistEmailEnabled: boolean;
  waitlistEmailSubject: string | null;
  waitlistEmailBody: unknown | null;
}

export interface ApplicationFormDefaults {
  includeName: boolean;
  includeReason: boolean;
  includeSocialLinks: boolean;
}

export interface EventApplicationFormRecord {
  id: string;
  /**
   * The owning event. Non-null here: every repo read that returns this record
   * is keyed by eventId (series-owned PERFORM forms get their own reads when
   * open calls add them).
   */
  eventId: string;
  purpose: ApplicationFormPurpose;
  /** Short random public id (10-char base-36) for `/call/<publicId>`. */
  publicId: string;
  introText: string | null;
  defaults: ApplicationFormDefaults;
  /** Application window start. Null = open immediately (spec Phase 2). */
  opensAt: Date | null;
  /**
   * Application window end. Null = never closes. Also anchors the nightly
   * expiry sweep (PENDING past closesAt + grace → EXPIRED).
   */
  closesAt: Date | null;
  /**
   * Submission cap. Null = uncapped. Counted over non-WITHDRAWN /
   * non-EXPIRED submissions.
   */
  maxSubmissions: number | null;
  /**
   * "Registration with questions" mode: submissions land APPROVED with an
   * unlock + approval token minted at submit (parity with
   * volunteerAutoApprove).
   */
  autoApprove: boolean;
  updatedByHumanId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EventApplicationQuestionOption {
  id: string;
  label: string;
}

export interface EventApplicationQuestionRecord {
  id: string;
  formId: string;
  type: ApplicationQuestionType;
  label: string;
  description: string | null;
  options?: EventApplicationQuestionOption[] | null;
  isRequired: boolean;
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A single question captured into a submission's `questionsSnapshot` at
 * submit time (spec D3). `options` is present only for choice types
 * (SINGLE_CHOICE / MULTI_CHOICE).
 */
export interface EventApplicationQuestionSnapshotEntry {
  label: string;
  type: ApplicationQuestionType;
  options?: EventApplicationQuestionOption[];
  /**
   * The question's form position (EventApplicationQuestion.order) at submit
   * time. REQUIRED for ordering: Postgres jsonb sorts object keys bytewise,
   * so snapshot key order does NOT survive persistence — the review queue
   * ranks entries by this value (live-form fallback for legacy snapshots
   * written without it, hence optional).
   */
  order?: number;
}

export interface EventApplicationSubmissionRecord {
  id: string;
  /** The form this submission answers (open calls v1). */
  formId: string;
  /**
   * That form's purpose. Attendee paths that load a submission by id or by
   * token treat anything but ATTEND as not found, so a PERFORM (open-call)
   * application can never be reviewed, withdrawn or redeemed as an attendee
   * one, nor mint an EventUnlock. Internal: not part of any API output.
   */
  purpose: ApplicationFormPurpose;
  eventId: string;
  humanId: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  status: ApplicationSubmissionStatus;
  answers: Record<string, unknown>;
  /** Reviewer-provided, attendee-facing decision reason (rejections). */
  decisionReason: string | null;
  /**
   * Question snapshot at submit time, keyed by question id. `{}` for
   * historical rows that predate snapshotting.
   */
  questionsSnapshot: Record<string, EventApplicationQuestionSnapshotEntry>;
  reviewerHumanId: string | null;
  reviewedAt: Date | null;
  approvalToken: string | null;
  tokenExpiresAt: Date | null;
  /**
   * The invite link that approved this submission (gated-event invite links
   * FR-005). Set = "Via invite": excluded from the maxSubmissions cap (R11).
   */
  inviteId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface EventWaitlistEntryRecord {
  id: string;
  eventId: string;
  humanId: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  source: WaitlistEntrySource;
  status: WaitlistEntryStatus;
  metadata: Record<string, unknown>;
  notifiedAt: Date | null;
  convertedOrderId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface InviteListRecord {
  id: string;
  ownerType: InviteListOwnerType;
  ownerId: string;
  name: string;
  description: string | null;
  passwordHint: string | null;
  contactCount: number;
  lastImportAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface InviteListEntryRecord {
  id: string;
  inviteListId: string;
  humanId: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  displayName: string | null;
  notes: string | null;
  tags: string[];
  lastInvitedAt: Date | null;
  metadata: Record<string, unknown>;
  importId: string | null;
  consentSource: string | null;
  consentRecordedAt: Date | null;
  unsubscribedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EventInviteListLinkRecord {
  id: string;
  eventId: string;
  inviteListId: string;
  context: Record<string, unknown>;
  createdAt: Date;
}

/**
 * Presence semantics (spec Phase 2): every optional field uses
 * "absent = leave the stored value unchanged, null = clear". The organizer
 * surfaces write DIFFERENT slices of the form (the question builder ensures
 * the row exists; the gate-settings panel writes the lifecycle fields), so an
 * unconditional write from one panel must never clobber the other's fields.
 */
export interface UpsertEventApplicationFormInput {
  eventId: string;
  /** Which of the event's forms to write. Required, no default. */
  purpose: ApplicationFormPurpose;
  introText?: string | null;
  defaults?: ApplicationFormDefaults;
  /** Application window start. Null clears (= open immediately). */
  opensAt?: Date | null;
  /** Application window end. Null clears (= never closes). */
  closesAt?: Date | null;
  /** Submission cap (>= 1). Null clears (= uncapped). */
  maxSubmissions?: number | null;
  /** Instant-approval ("registration with questions") mode. */
  autoApprove?: boolean;
  updatedByHumanId: string;
}

/**
 * Posted pay terms on an open call (open calls FR-002). Details text is
 * required for FIXED, DOOR_SPLIT, TICKET_SHARE and TICKET_QUOTA (core
 * enforces it; the column is nullable).
 */
export type OpenCallPayKind =
  | "FIXED"
  | "DOOR_SPLIT"
  | "TICKET_SHARE"
  | "TICKET_QUOTA"
  | "UNPAID"
  | "DISCUSSED_AFTER";

/**
 * What an open call hangs off (open calls Q40): exactly one event or one
 * series. A series call is always PERFORM.
 */
export type OpenCallAnchor =
  | { kind: "event"; eventId: string }
  | { kind: "series"; seriesId: string };

/**
 * A PERFORM form (an open call), read by the open-call methods. Unlike
 * {@link EventApplicationFormRecord} (always event-owned), `eventId` is null
 * on a series call and `seriesId` is null on an event call; exactly one is
 * set (SQL CHECK "EventApplicationForm_one_owner_check").
 */
export interface OpenCallFormRecord
  extends Omit<EventApplicationFormRecord, "eventId" | "purpose"> {
  purpose: "PERFORM";
  eventId: string | null;
  seriesId: string | null;
  payKind: OpenCallPayKind | null;
  payDetails: string | null;
  /** Set when someone with edit rights pressed Close (FR-005). */
  closedAt: Date | null;
  closedByHumanId: string | null;
  /**
   * Set by "Post call" (owner ruling Q41). Null = a DRAFT call: not public,
   * not on the poster's page, takes no applications. One-way.
   */
  postedAt: Date | null;
  postedByHumanId: string | null;
}

/**
 * Write an open call (create or update). Same presence semantics as
 * {@link UpsertEventApplicationFormInput}: absent = leave unchanged, null =
 * clear. Pay validation (FR-002) is core's job, against the merged values.
 */
export interface UpsertOpenCallFormInput {
  anchor: OpenCallAnchor;
  introText?: string | null;
  defaults?: ApplicationFormDefaults;
  opensAt?: Date | null;
  closesAt?: Date | null;
  maxSubmissions?: number | null;
  payKind?: OpenCallPayKind | null;
  payDetails?: string | null;
  updatedByHumanId: string;
}

/** An upcoming event of a series that holds its OWN open call (FR-001). */
export interface SeriesEventOpenCallRecord {
  formId: string;
  eventId: string;
  eventTitle: string;
  eventStartsAt: Date;
}

/** Who posted an open call, for the poster's public page (FR-003). */
export type OpenCallPoster =
  | { kind: "org"; orgId: string }
  | { kind: "human"; humanId: string };

/** One card on the poster's public page: an open (not closed) call. */
export interface PosterOpenCallRecord {
  formId: string;
  publicId: string;
  anchor: OpenCallAnchor;
  /** The event's title, or the series' name. */
  title: string;
  payKind: OpenCallPayKind | null;
  closesAt: Date | null;
  /** The event's start, or the series' next live occurrence. */
  nextStartsAt: Date;
  timezone: string;
}

export interface UpsertEventApplicationQuestionInput {
  questionId?: string;
  formId: string;
  type: ApplicationQuestionType;
  label: string;
  description?: string | null;
  options?: EventApplicationQuestionOption[] | null;
  isRequired?: boolean;
  order?: number;
}

export interface CreateEventApplicationSubmissionInput {
  /**
   * The form this submission answers. The caller passes the form it already
   * read and validated against (window, cap, questions), so the row lands on
   * exactly that form. The composite FK (formId, eventId) -> form(id, eventId)
   * rejects a formId that belongs to another event.
   */
  formId: string;
  eventId: string;
  humanId?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  answers: Record<string, unknown>;
  /** Question snapshot at submit time (spec D3). Defaults to `{}`. */
  questionsSnapshot?: Record<string, EventApplicationQuestionSnapshotEntry>;
  /** The invite link this submission came through (FR-005). Default null. */
  inviteId?: string | null;
  submittedAt: Date;
}

export interface UpdateEventApplicationSubmissionStatusInput {
  submissionId: string;
  status: ApplicationSubmissionStatus;
  reviewerHumanId?: string | null;
  reviewedAt?: Date | null;
  approvalToken?: string | null;
  tokenExpiresAt?: Date | null;
  /**
   * Attendee-facing decision reason. Only applied when the property is
   * present (hasOwnProperty semantics, matching the other optional fields).
   */
  decisionReason?: string | null;
  /**
   * The invite link approving this submission (FR-005: an invite approves
   * the holder's open submission). Only applied when the property is present.
   */
  inviteId?: string | null;
  /**
   * Optimistic status guard (mirrors bookingRequests.updateStatus's
   * expectedFrom): when present the write only lands if the row's CURRENT
   * status is in this set; otherwise the adapter throws a
   * `{ code: "conflict" }` use-case error and the caller decides how to
   * surface it. Closes the read→write race with a concurrent review.
   */
  expectedFromStatuses?: ApplicationSubmissionStatus[];
  /**
   * Optional invite-stamp guard, checked in the SAME guarded write as
   * `expectedFromStatuses`: when the property is present the write only
   * lands while the row's CURRENT `inviteId` equals it (`null` = no stamp).
   * A miss throws the same `{ code: "conflict" }`. Lets the invite revoke
   * rescind an approval only while it is still THAT invite's, even if a
   * re-approval under another invite kept the status APPROVED.
   */
  expectedInviteId?: string | null;
}

export interface ListApplicationSubmissionsInput {
  eventId: string;
  /** Which of the event's forms to list. Required, no default. */
  purpose: ApplicationFormPurpose;
  statuses?: ApplicationSubmissionStatus[];
  /** Only submissions this invite approved (revoking a PERSONAL invite). */
  inviteId?: string;
  limit?: number;
  offset?: number;
}

/** COUNT(*) of one form's submissions (any anchor), by status set. */
export interface CountSubmissionsByFormInput {
  formId: string;
  statuses?: ApplicationSubmissionStatus[];
}

/**
 * COUNT(*) of an event's submissions, optionally filtered to a status set.
 * Backs the maxSubmissions cap check in submit-event-application (the cap
 * counts non-WITHDRAWN / non-EXPIRED submissions) — a dedicated count, never
 * list-and-count.
 */
export interface CountApplicationSubmissionsInput {
  eventId: string;
  /** Which of the event's forms to count. Required, no default. */
  purpose: ApplicationFormPurpose;
  statuses?: ApplicationSubmissionStatus[];
  /**
   * Leave out submissions an invite approved (`inviteId` set). The
   * maxSubmissions cap passes `true`: invites don't count against it (R11).
   */
  excludeInvited?: boolean;
}

/**
 * One-open-application dedupe lookup (spec Phase 3 item 2 / D5). Exactly one
 * identity is supplied — `humanId` for signed-in applicants, `contactEmail`
 * for guests. The repo owns the "open" status set (PENDING | APPROVED |
 * WAITLISTED) so it can never drift from the partial unique indexes that
 * back it.
 */
export type FindOpenApplicationSubmissionInput = {
  /**
   * The form to check. Keyed by form, exactly like the partial unique indexes
   * (open calls v1 re-keyed them eventId -> formId), so one person can hold an
   * open ATTEND and an open PERFORM application on the same event.
   */
  formId: string;
} & (
  | { humanId: string; contactEmail?: never }
  | { contactEmail: string; humanId?: never }
);

// ── Open-call applications (PERFORM submissions; open calls v1 step 4) ─────

/**
 * One date an open-call applicant said they can do (FR-007), pointing at
 * exactly one target (SQL CHECK "OpenCallDateChoice_one_target_check").
 * A series call's choices always point at the OCCURRENCE (never its
 * materialised event); an event call's at the EventDate. `startsAt` is the
 * target's start, read through the relation (token expiry, the backstop).
 */
export interface OpenCallDateChoiceRecord {
  eventId: string | null;
  occurrenceId: string | null;
  eventDateId: string | null;
  startsAt: Date;
}

/** The target of a new date choice: exactly one id set. */
export type OpenCallDateChoiceTarget =
  | { occurrenceId: string; eventDateId?: never; eventId?: never }
  | { eventDateId: string; occurrenceId?: never; eventId?: never };

/**
 * A submission on an open call (PERFORM form). Unlike
 * {@link EventApplicationSubmissionRecord}, `eventId` is null on a series
 * call. Internal record: `statusTokenHash`, `contactEmail` and the rest never
 * reach an API output except through a use case's field-by-field projection.
 */
export interface OpenCallSubmissionRecord {
  id: string;
  formId: string;
  eventId: string | null;
  humanId: string | null;
  applyingAsOrgId: string | null;
  guestName: string | null;
  guestUrl: string | null;
  contactEmail: string | null;
  /**
   * The language the applicant applied in ("en" / "es", core's
   * NOTIFICATION_LOCALES); null = unknown, so the platform default. Read
   * for a guest's emails (core: resolveGuestNoticeLocale).
   */
  contactLocale: string | null;
  status: ApplicationSubmissionStatus;
  answers: Record<string, unknown>;
  questionsSnapshot: Record<string, EventApplicationQuestionSnapshotEntry>;
  isPrivate: boolean;
  openedAt: Date | null;
  /** SHA-256 (hex) of the status-link token (NFR-001). */
  statusTokenHash: string | null;
  droppedOutAt: Date | null;
  /**
   * A picked act later removed from the lineup by the organizer side (spec
   * FR-019). Status stays APPROVED, so the history stays true.
   */
  removedFromLineupAt: Date | null;
  /** The optional "not this time" note (spec FR-018). */
  decisionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Ascending by startsAt. */
  dateChoices: OpenCallDateChoiceRecord[];
}

/**
 * An act's identity on a lineup, as an open-call pick writes it (spec
 * FR-016): a person (EventHuman.humanId), an organisation (EventHuman.orgId)
 * or a guest (a free-text PERFORMER row matched by name, trimmed and
 * case-insensitive, AND by url, trimmed, null = null). There is no column
 * linking a lineup row to the submission that put it there; this identity,
 * on the call's events, is the link (core: _shared/open-call-decision.ts).
 */
export type OpenCallLineupAct =
  | { kind: "human"; humanId: string }
  | { kind: "org"; orgId: string }
  | { kind: "guest"; name: string; url: string | null };

export interface CreateOpenCallSubmissionInput {
  /**
   * The new row's id, chosen by the caller (a UUID): the status token is
   * derived from it before the insert (core: _shared/status-token.ts).
   */
  id: string;
  /** A PERFORM form the caller read through `lockOpenCallForSubmit`. */
  formId: string;
  /** The form's eventId (null for a series call): the composite FK checks it. */
  eventId: string | null;
  humanId: string | null;
  applyingAsOrgId: string | null;
  guestName: string | null;
  guestUrl: string | null;
  contactEmail: string | null;
  /** See {@link OpenCallSubmissionRecord.contactLocale}. */
  contactLocale: string | null;
  answers: Record<string, unknown>;
  questionsSnapshot: Record<string, EventApplicationQuestionSnapshotEntry>;
  isPrivate: boolean;
  statusTokenHash: string;
  dateChoices: OpenCallDateChoiceTarget[];
  submittedAt: Date;
}

export interface UpdateOpenCallSubmissionInput {
  submissionId: string;
  /**
   * The PERFORM form the caller read this submission on. A same-table guard
   * column: the write matches only a row on this form.
   */
  formId: string;
  answers: Record<string, unknown>;
  questionsSnapshot: Record<string, EventApplicationQuestionSnapshotEntry>;
  isPrivate: boolean;
  /** Replaces every stored choice. */
  dateChoices: OpenCallDateChoiceTarget[];
}

/**
 * One row of the applicant-facing peer list (FR-008): display fields only.
 * Never a status, vote, note, email or submission id (NFR-002).
 */
export interface OpenCallPeerRecord {
  kind: "human" | "org" | "guest";
  name: string;
  /** The PUBLIC page's avatar; null for guests or without a public page. */
  photoUrl: string | null;
  /** The PUBLIC page's slug; null for guests or without a public page. */
  pageSlug: string | null;
  /** A guest's own link (guestUrl). Null for humans and orgs. */
  url: string | null;
}

// ── Open-call review (organizer side; open calls v1 step 5) ────────────────

/** One organizer-side vote (FR-014). Mirrors the Prisma enum. */
export type ApplicationVoteValue = "YES" | "MAYBE" | "NO";

/** Who wrote a thread message (FR-015). Mirrors the Prisma enum. */
export type ApplicationMessageAuthorSide = "ORGANIZER" | "APPLICANT";

/**
 * The review queue's filters (FR-012). There is deliberately no sort
 * option: the queue is always time applied, oldest first (principle 6).
 */
export interface OpenCallReviewFilter {
  /**
   * Statuses to include. Absent = every status except WITHDRAWN (a
   * withdrawn application shows only when asked for by status).
   */
  statuses?: ApplicationSubmissionStatus[];
  /** A chosen date: an occurrence id (series call) or EventDate id (event call). */
  dateId?: string;
  /** The viewer's own vote; NONE = the viewer has not voted. */
  myVote?: ApplicationVoteValue | "NONE";
}

export interface ListOpenCallReviewCardsInput {
  /** The PERFORM form; rows of any other form are never read. */
  formId: string;
  /** Whose vote is `myVote` and whom the `myVote` filter means. */
  viewerHumanId: string;
  filter: OpenCallReviewFilter;
  /**
   * The last submission id of the previous page. Resolved to its
   * (createdAt, id) on THIS form; a foreign or unknown id restarts from the
   * top (it can't leak another call's position).
   */
  cursor: string | null;
  limit: number;
  /** One card only (opening a card). Still scoped to `formId`. */
  onlySubmissionId?: string;
  /** "Now" for the trust traces (a night counts once it is over). */
  now: Date;
  /** EventHuman roles that count as playing a night (core's rule). */
  lineupRoles: readonly string[];
  /**
   * OrgMember roles that make a PERSON's OWN lineup nights on their org's
   * events count as "ran", never "played" (core passes ORG_EDIT_ROLES).
   */
  organiserOrgRoles: readonly string[];
}

/**
 * Raw trust-trace counts (FR-013) for a signed-in applicant entity. Core
 * turns them into display values ("New here", never a zero). Display only:
 * never used for ordering or gating.
 *
 * A night = one OVER date of a PUBLIC event that happened (status in
 * {@link TRACK_RECORD_EVENT_STATUSES}: PUBLISHED or COMPLETED, so never a
 * draft or a cancelled event; visibility PUBLIC, so a private night never
 * leaves its circle): each SCHEDULED EventDate row that has ended, or the
 * event itself (once it has ended) when it has no date rows.
 *
 * "Organised by" the act: for a person, their own personal event, or an
 * event of an org where they CURRENTLY hold an organiser role
 * (`organiserOrgRoles`) AND are on its lineup themselves (self-booking; the
 * org's other nights are never theirs); for an org, an event it owns.
 * Organised nights are "ran" and never "played" (counted once). v1 limit:
 * membership is current, OrgMember keeps no history.
 */
export interface OpenCallTraceCounts {
  /** Lineup nights at the call's place(s), on events the act did not organise. */
  playedHereNights: number;
  /** Lineup nights anywhere, on events the act did not organise. */
  playedNights: number;
  /** Nights of events the act organised (owns). */
  ranNights: number;
}

/**
 * The submission as a QUEUE card carries it: no answers or questions
 * snapshot (FR-010: answers reach the organizer side only by opening the
 * card, which stamps openedAt), and no email or token hash.
 */
export type OpenCallReviewSubmissionRecord = Omit<
  OpenCallSubmissionRecord,
  | "answers"
  | "questionsSnapshot"
  | "contactEmail"
  | "contactLocale"
  | "statusTokenHash"
  // Decision detail (step 6) is not on the queue card yet; the card reads
  // status. Add them here when a screen needs them.
  | "removedFromLineupAt"
  | "decisionReason"
>;

/** One card in the organizer-side review queue (FR-013, FR-014). */
export interface OpenCallReviewCardRecord {
  submission: OpenCallReviewSubmissionRecord;
  /** The name to show: the org's, the person's (public page first), or the guest's. */
  displayName: string | null;
  /** The PUBLIC page's avatar; null for guests or without a public page. */
  photoUrl: string | null;
  /** The PUBLIC page's slug; null for guests or without a public page. */
  pageSlug: string | null;
  votes: { yes: number; maybe: number; no: number };
  myVote: ApplicationVoteValue | null;
  noteCount: number;
  /** APPLICANT messages the organizer side has not read yet. */
  unreadForOrganizer: number;
  /** Null for a guest (always "New here"). */
  traces: OpenCallTraceCounts | null;
}

/** An organizer-side note (FR-014). Never on an applicant-facing read. */
export interface ApplicationNoteRecord {
  id: string;
  submissionId: string;
  /** Null once the author's account is deleted (the note stays). */
  authorHumanId: string | null;
  authorName: string | null;
  body: string;
  createdAt: Date;
}

/** One thread message (FR-015). */
export interface ApplicationMessageRecord {
  id: string;
  submissionId: string;
  authorSide: ApplicationMessageAuthorSide;
  /** Null for a message sent through a status link. */
  authorHumanId: string | null;
  body: string;
  /** Set when the other side has read it. Never cleared. */
  readAt: Date | null;
  createdAt: Date;
}

/** One of a human's own open-call applications ("My applications", FR-009). */
export interface MyOpenCallApplicationRecord {
  submissionId: string;
  publicId: string;
  anchor: OpenCallAnchor;
  /** The event's title, or the series' name. */
  title: string;
  status: ApplicationSubmissionStatus;
  applyingAsOrgId: string | null;
  applyingAsOrgName: string | null;
  createdAt: Date;
}

export interface CreateWaitlistEntryInput {
  eventId: string;
  humanId?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  source: WaitlistEntrySource;
  status?: WaitlistEntryStatus;
  metadata?: Record<string, unknown>;
}

export interface UpdateWaitlistEntryStatusInput {
  entryId: string;
  status: WaitlistEntryStatus;
  notifiedAt?: Date | null;
  convertedOrderId?: string | null;
  /**
   * REPLACES the stored metadata when present (callers merge with the
   * existing record's metadata first). Used to stamp the
   * `submissionId` linkback when a WAITLISTED application decision lands on
   * an already-existing waitlist entry.
   */
  metadata?: Record<string, unknown>;
  updatedAt: Date;
}

export interface ListWaitlistEntriesInput {
  eventId: string;
  statuses?: WaitlistEntryStatus[];
  limit?: number;
  offset?: number;
}

export interface FindWaitlistEntryInput {
  eventId: string;
  humanId?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
}

export interface CreateInviteListInput {
  ownerType: InviteListOwnerType;
  ownerId: string;
  name: string;
  description?: string | null;
  passwordHint?: string | null;
}

export interface UpdateInviteListInput {
  inviteListId: string;
  name?: string;
  description?: string | null;
  passwordHint?: string | null;
}

export interface CreateInviteListEntryInput {
  inviteListId: string;
  humanId?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  displayName?: string | null;
  notes?: string | null;
  tags?: string[];
  metadata?: Record<string, unknown>;
  /** How the sender says consent was obtained (same field imports record). */
  consentSource?: string | null;
  /** When consent was recorded — stamped by the use case, as imports do. */
  consentRecordedAt?: Date | null;
}

export interface GetInviteListEntryInput {
  entryId: string;
  /** Scoped like update/delete: an entry in another list reads as null. */
  inviteListId: string;
}

export interface DeleteInviteListEntryInput {
  entryId: string;
  /** Scopes the delete — see {@link UpdateInviteListEntryInput.inviteListId}. */
  inviteListId: string;
}

export interface UpdateInviteListEntryInput {
  entryId: string;
  /**
   * The list the entry must belong to. The write is scoped to
   * `{ id: entryId, inviteListId }`, so an entry id from another owner's
   * list matches nothing (security review F9, 2026-09-29).
   */
  inviteListId: string;
  contactEmail?: string | null;
  contactPhone?: string | null;
  displayName?: string | null;
  notes?: string | null;
  tags?: string[];
  metadata?: Record<string, unknown>;
  lastInvitedAt?: Date | null;
  unsubscribedAt?: Date | null;
  /** Restamped by the use case when the entry's email changes. */
  consentSource?: string | null;
  consentRecordedAt?: Date | null;
}

export interface CopyInviteListEntriesInput {
  sourceInviteListId: string;
  targetInviteListId: string;
  performedByHumanId: string;
}

export interface ListInviteListsByOwnerInput {
  ownerType: InviteListOwnerType;
  ownerId: string;
}

export interface ListInviteListEntriesInput {
  inviteListId: string;
  limit?: number;
  offset?: number;
  search?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Contact Imports
// ─────────────────────────────────────────────────────────────────────────────

export interface ContactImportRecord {
  id: string;
  ownerType: InviteListOwnerType;
  ownerId: string;
  inviteListId: string;
  fileName: string;
  fileFormat: ContactImportFileFormat;
  totalRows: number;
  importedCount: number;
  skippedCount: number;
  rejectedCount: number;
  chunksReceived: number;
  totalChunks: number | null;
  completedAt: Date | null;
  createdByHumanId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateContactImportInput {
  ownerType: InviteListOwnerType;
  ownerId: string;
  inviteListId: string;
  fileName: string;
  fileFormat: ContactImportFileFormat;
  totalRows: number;
  rejectedCount: number;
  totalChunks: number | null;
  createdByHumanId: string;
}

export interface IncrementContactImportCountsInput {
  importId: string;
  importedDelta: number;
  skippedDelta: number;
}

export interface ListContactImportsByOwnerInput {
  ownerType: InviteListOwnerType;
  ownerId: string;
  limit?: number;
  offset?: number;
}

export interface BatchUpsertInviteListEntriesInput {
  inviteListId: string;
  entries: Array<{
    contactEmail?: string | null;
    contactPhone?: string | null;
    displayName?: string | null;
    notes?: string | null;
    tags?: string[];
    humanId?: string | null;
    importId?: string | null;
    consentSource?: string | null;
    consentRecordedAt?: Date | null;
  }>;
}

export interface BatchUpsertResult {
  insertedCount: number;
  skippedCount: number;
}

export interface AttachInviteListToEventInput {
  eventId: string;
  inviteListId: string;
  context?: Record<string, unknown>;
}

export interface DetachInviteListFromEventInput {
  eventId: string;
  inviteListId: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Event listing by owner
// ─────────────────────────────────────────────────────────────────────────────

export type EventOwnerType = "HUMAN" | "ORGANIZATION";

/** One owner's upcoming-events rollup — see `EventsRepo.getUpcomingStatsForOwners`. */
export interface OwnerUpcomingEventStats {
  ownerType: EventOwnerType;
  ownerId: string;
  /** PUBLISHED events with `startsAt > now`. */
  upcomingCount: number;
  /** Soonest `startsAt` among them. */
  nextEventAt: Date;
}

/**
 * The owners withheld from public reads because of a ban (ban-that-sticks,
 * 2026-09-29): BANNED humans, and orgs whose every OWNER is banned. Resolved
 * by `bans.listWithheldOwners`; list reads take it pre-resolved so one
 * request with several reads resolves it once.
 */
export type WithheldOwnerIds = {
  readonly humanIds: readonly string[];
  readonly orgIds: readonly string[];
};

export interface ListEventsByOwnerInput {
  ownerType: EventOwnerType;
  ownerId: string;
  status?: EventStatus[];
  /**
   * Optional filter on `Event.visibility` (IN). Absent/empty = no filter —
   * the owner-facing default. An ANONYMOUS reader (the public calendar
   * feeds) must pass `["PUBLIC"]`: a PRIVATE event's title and time are not
   * public, and filtering after the query would let private rows crowd the
   * page limit.
   */
  visibility?: EventVisibility[];
  /** Optional case-insensitive text filter on title / addressText. */
  query?: string;
  /**
   * Optional filter on `Event.startsAt`. Both bounds are optional and
   * INCLUSIVE (`gte` / `lte`). Ignored when absent, and equally ignored when
   * present with neither bound set — an omitted bound is "open ended", never
   * "match nothing".
   */
  dateRange?: { from?: Date; to?: Date };
  /**
   * FR-003 (event-calendar-redesign): when set alongside a bounded
   * `dateRange`, an event ALSO matches when one of its SCHEDULED `EventDate`
   * rows starts inside the window — not only when its pinned `Event.startsAt`
   * does. A recurring community listing's pin mirrors its first upcoming
   * night, so the pinned-instant filter alone hides every later night from
   * the owner's calendar. Opt-in; absent/false leaves the WHERE byte-identical
   * for existing callers. Ignored without a bounded `dateRange` (nothing to
   * widen). Pagination and `pageInfo.total` stay EVENT-shaped either way.
   */
  includeDateOccurrences?: boolean;
  /**
   * The `EventDate` statuses the `includeDateOccurrences` arm matches.
   * Omitted = `["SCHEDULED"]` (unchanged for existing callers).
   */
  dateOccurrenceStatuses?: ReadonlyArray<"SCHEDULED" | "CANCELLED">;
  /**
   * With `includeDateOccurrences` and a bounded `dateRange`: match ONLY on
   * the EventDate arm, never on the pinned `Event.startsAt`. Omitted/false =
   * unchanged.
   *
   * REQUIRES both prerequisites. Without them there is no EventDate arm to
   * narrow to, so the flag would silently fall back to the plain pinned
   * read (a WIDER result than asked for); the adapter throws instead.
   */
  matchDateOccurrencesOnly?: boolean;
  /**
   * With `dateRange.from`: also match an event still RUNNING at `from`
   * (`endsAt >= from`, and `startsAt <= to` when `to` is set), not only one
   * that starts after it. Omitted/false = unchanged. The public owner feeds
   * pass it so a months-long exhibition stays listed while it runs.
   */
  includeRunning?: boolean;
  /**
   * Drop events whose owner is withheld because of a ban (ban-that-sticks;
   * the same rule as `ownerBanned` on the single-event reads). Omitted =
   * kept. The public owner feeds pass `true`.
   */
  excludeBannedOwners?: boolean;
  /**
   * With `excludeBannedOwners`: the withheld set the caller already
   * resolved (`bans.listWithheldOwners`), used instead of resolving it again
   * for this read. A caller making several reads for one request resolves
   * once and passes it to each. Omitted = the adapter resolves it. Passed
   * without `excludeBannedOwners` the adapter throws: the set would filter
   * nothing.
   */
  withheldOwners?: WithheldOwnerIds;
  /**
   * Only events that were PUBLISHED at the moment they were cancelled
   * (owner ruling 2026-10-17): `cancelledFromStatus = 'PUBLISHED'`. A row
   * cancelled before that column existed (NULL) is excluded: its status at
   * cancel is unknown, and the cancelled-in-feed read never shipped, so no
   * subscriber holds an entry for it. Omitted = no filter. The public
   * calendar feeds pass it with `status: ["CANCELLED"]`, so a show that was
   * a draft when cancelled (never published, or unpublished and edited
   * first) never surfaces.
   */
  cancelledWhilePublished?: boolean;
  /**
   * `Event.startsAt` sort direction. Omitted = `"desc"` (newest first, the
   * owner-facing default). The public calendar feeds pass `"asc"` with a
   * `dateRange.from`, so the NEAREST shows survive the page limit.
   */
  startsAtOrder?: "asc" | "desc";
  /**
   * Optional filter on `Event.categoryId` (OR across the given ids). Ignored
   * when absent or empty — an empty array never means "match nothing".
   *
   * NOTE: `Event.categoryId` is NULLABLE, and SQL `IN` never matches NULL, so
   * setting this filter at all makes UNCATEGORISED events unreachable — even
   * if the caller enumerates every category id that exists. That is the
   * correct semantics for a category facet, but it means "uncategorised"
   * CANNOT be expressed through this field. That is what
   * {@link ListEventsByOwnerInput.includeUncategorised} is for — do not try to
   * encode it as an id.
   */
  categoryIds?: string[];
  /**
   * Widen the category filter to also match events with NO category
   * (`categoryId IS NULL`).
   *
   * ## Why a separate flag and not an id
   *
   * "Uncategorised" is the ABSENCE of a value, not a value. There is no id an
   * admin could add to `categoryIds` that would bring null-category events
   * back — SQL `IN` never matches NULL — and inventing a sentinel id
   * ("__none__") would have to be pattern-matched out of a list the rest of the
   * stack validates as UUIDs. A boolean says exactly what it means at every
   * layer and cannot collide with a real category.
   *
   * ## Semantics (all four combinations are pinned by adapter tests)
   *
   * | `categoryIds` | `includeUncategorised` | predicate                              |
   * |---------------|------------------------|----------------------------------------|
   * | absent/empty  | absent/false           | no category filter                     |
   * | `[a,b]`       | absent/false           | `categoryId IN (a,b)`                  |
   * | `[a,b]`       | `true`                 | `categoryId IN (a,b) OR categoryId IS NULL` |
   * | absent/empty  | `true`                 | `categoryId IS NULL` — **only** uncategorised |
   *
   * That last row is deliberate: a lone `includeUncategorised` is a real,
   * useful filter ("show me what still needs categorising"), NOT a no-op that
   * degrades to "everything".
   *
   * `false` and absent are the SAME thing here, unlike the arrays above where
   * `[]` had to be rejected to stop it becoming a second spelling of "absent".
   * A boolean has only one sensible reading of `false` ("do not widen"), which
   * is exactly what absent means, so there is nothing to diverge.
   */
  includeUncategorised?: boolean;
  limit?: number;
  offset?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Venue occupancy occurrences (booking availability)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ONE night a venue's space is actually taken by a published event.
 *
 * Distinct from {@link EventRecord} because an event and an occupancy are not
 * the same count: a recurring listing is ONE event row that occupies MANY
 * nights. Booking availability has to reason in nights, so it reads these
 * rather than events — an event-shaped read reports a weekly residency as a
 * single booked night and leaves the venue bookable on every other week.
 *
 * The set is a union of two storage shapes, because `EventDate` rows exist
 * only for events carrying a `recurrenceSchedule`:
 *   · recurring listing → one occurrence per SCHEDULED `EventDate` in range
 *   · single-date event → one occurrence from `Event.startsAt`/`endsAt`
 */
export interface PlaceOccurrenceRecord {
  eventId: string;
  /**
   * The {@link EventDateRecord} this was expanded from, or null when it came
   * from `Event.startsAt` because the event has no occurrence rows. Carried so
   * a caller can tell a real per-date row from the single-date fallback
   * without re-querying.
   */
  eventDateId: string | null;
  title: string;
  startsAt: Date;
  /** Nullable exactly as stored: an unknown end is not a zero-length show. */
  endsAt: Date | null;
  /**
   * The `Space` this occurrence physically occupies (venue-hierarchy FR-005),
   * or NULL when the event names no space.
   *
   * NULL means UNKNOWN PLACEMENT, not "no placement": pre-hierarchy events and
   * freeform place-linked events carry no `spaceId` at all. A caller narrowing
   * occupancy to a set of spaces MUST treat a null-space occurrence as
   * occupying EVERY space — under-blocking oversells a room that is in fact
   * taken, while over-blocking only hides a slot the venue can still offer by
   * hand. This is also why {@link ListPublishedOccurrencesByPlaceInput.spaceIds}
   * never filters null rows out.
   */
  spaceId: string | null;
}

export interface ListPublishedOccurrencesByPlaceInput {
  placeId: string;
  /** Inclusive lower bound on the OCCURRENCE instant, not on `Event.startsAt`. */
  from: Date;
  to: Date;
  /** Hard cap on occurrences returned, not on parent events. */
  limit?: number;
  /**
   * Narrow occupancy to these spaces. OMITTED = the whole place's diary (the
   * pre-hierarchy behaviour, unchanged).
   *
   * The filter is `spaceId IN (…) OR spaceId IS NULL` — never a bare `IN`. See
   * {@link PlaceOccurrenceRecord.spaceId}: an occurrence with no space has
   * unknown placement and must block every space.
   *
   * An EMPTY array is NOT the same as omitting the key: it means "this
   * calendar has no spaces joined", and matches only the null-space
   * occurrences. Callers that mean "don't filter" must omit the key.
   */
  spaceIds?: string[];
  /**
   * Confirmed-only occupancy (venue-confirmation spec: unconfirmed events
   * count for neither availability nor conflicts). See
   * {@link VenueConfirmedFor}. Omitted = every published event occupies.
   */
  venueConfirmedFor?: VenueConfirmedFor;
}

// ─────────────────────────────────────────────────────────────────────────────
// Event listing by place (all statuses — venue calendar)
// ─────────────────────────────────────────────────────────────────────────────

export interface ListAllEventsByPlaceInput {
  placeId: string;
  from: Date;
  to: Date;
  /** Optional status filter. When omitted, returns all non-ARCHIVED statuses. */
  statuses?: EventStatus[];
  /**
   * Event-calendar-redesign FR-003: ALSO match an event when one of its
   * SCHEDULED `EventDate` rows lands in `[from, to]`, not only when
   * `Event.startsAt`/`endsAt` do. A recurring community listing pins
   * `Event.startsAt` to its first upcoming date, so a window a month out
   * would otherwise never see it even though it has a night inside. Opt-in
   * so every existing caller's result set is byte-identical; the calendar
   * reads pass `true` and expand the rows themselves (`expandEventDates`).
   */
  includeDateOccurrences?: boolean;
}
