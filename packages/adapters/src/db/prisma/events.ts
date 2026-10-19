import {
  Prisma,
  TicketTypeStatus as PrismaTicketTypeStatus,
} from "@prisma/client";
import {
  buildOffsetPageInfo,
  buildOffsetPaginatedResult,
  sanitizeOffsetPagination,
} from "@th/ports/pagination";
import type {
  AssignEventSlugInput,
  SaveEventInput,
  EventAttestationRecord,
  EventRecord,
  EventGateSettings,
  EventGateType,
  EventLocationMode,
  EventsRepo,
  EventStatus,
  EventTicketTypeSummary,
  EventSlugContext,
  EventSlugResolution,
  EventSitemapEntryRecord,
  EventVisibility,
  GeoCategoryComboRecord,
  ListAllEventsByPlaceInput,
  ListEventsByOwnerInput,
  OwnerUpcomingEventStats,
  PlaceOccurrenceRecord,
  RecordEventSlugHistoryInput,
  UpdateEventSlugInput,
  VenueConfirmedFor,
  WaitlistStatus,
} from "@th/ports/repos/events";
import {
  parseCategoryNameTranslations,
  type ExactLocationPrivacyReset,
} from "@th/types";
import { encodeGeohash } from "@th/core/lib/geo/geohash";
import {
  WITHHELD_EVENT_DEFAULT_REVEAL,
  projectEventLocationAtPlace,
  type PlaceEventLocationSource,
} from "@th/core/lib/location/place-event-location";
import {
  projectPublicEventLocation,
  publicDistanceMeters,
  unreadablePlaceLocation,
  type PublicEventLocationSource,
} from "@th/core/lib/location/project-public-event-location";
import type { PlaceLocationSource } from "@th/core/lib/location/redact-place-location";

import { snappedObfuscationRadiusSql } from "../../geo/obfuscation";

import type { PrismaClientOrTx } from "./types";
import { NOTE_SELECT, writeNote } from "./note-columns";
import { clonePayoutTermsRow } from "./payout-terms";
import {
  indexableListedEventWhere,
  publicListedEventWhere,
  UNGATED_EVENT_SQL,
} from "./public-listed-event-where";
import {
  EVENT_OWNER_STANDING_SELECT,
  eventOwnerNotWithheldSubquerySql,
  eventOwnerNotWithheldWhere,
  notWithheldEventWhere,
  ownerBannedFromStanding,
  resolveWithheldOwners,
} from "./banned-owner";

/**
 * Candidate page for a `near` random pick (see `pickRandomEvent`): random
 * order, first in-range EMITTED point wins.
 */
const RANDOM_NEAR_CANDIDATE_LIMIT = 200;

/**
 * One `near` candidate: every column the public projection reads, event and
 * venue, from the single candidate query (see `pickRandomEvent`).
 */
type RandomNearCandidateRow = {
  id: string;
  orgId: string | null;
  humanId: string | null;
  placeId: string | null;
  /** Selected explicitly (N5): the projector treats a missing gate as gated. */
  gateType: string | null;
  locationMode: string | null;
  locationRadiusMeters: number | null;
  locationLabel: string | null;
  addressText: string | null;
  lat: number | null;
  lng: number | null;
  locality: string | null;
  region: string | null;
  countryCode: string | null;
  postalCode: string | null;
  placeRowId: string | null;
  placeLocationMode: string | null;
  placeLocationRadiusMeters: number | null;
  placeLocationLabel: string | null;
  placeLat: number | null;
  placeLng: number | null;
  placeCity: string | null;
  placeRegion: string | null;
  placeCountry: string | null;
};

function randomNearCandidateEvent(
  row: RandomNearCandidateRow,
): PublicEventLocationSource {
  return {
    id: row.id,
    orgId: row.orgId,
    humanId: row.humanId,
    gateType: row.gateType,
    locationMode: row.locationMode,
    locationRadiusMeters: row.locationRadiusMeters,
    locationLabel: row.locationLabel,
    addressText: row.addressText,
    lat: row.lat,
    lng: row.lng,
    locality: row.locality,
    region: row.region,
    countryCode: row.countryCode,
    postalCode: row.postalCode,
  };
}

/** The joined venue as the projection reads it; fails closed if unjoined. */
function randomNearCandidatePlace(
  row: RandomNearCandidateRow,
): PlaceLocationSource | null {
  if (!row.placeId) return null;
  if (!row.placeRowId) return unreadablePlaceLocation(row.placeId);
  return {
    id: row.placeRowId,
    locationMode: row.placeLocationMode,
    locationRadiusMeters: row.placeLocationRadiusMeters,
    locationLabel: row.placeLocationLabel,
    lat: row.placeLat,
    lng: row.placeLng,
    city: row.placeCity,
    region: row.placeRegion,
    countryCode: row.placeCountry,
  };
}

export const EVENT_SELECT = {
  id: true,
  orgId: true,
  humanId: true,
  title: true,
  status: true,
  attendanceMode: true,
  stewardship: true,
  visibility: true,
  gateType: true,
  locationMode: true,
  locationRadiusMeters: true,
  locationLabel: true,
  addressRevealAt: true,
  addressRevealPreset: true,
  timezone: true,
  startsAt: true,
  endsAt: true,
  placeId: true,
  savedLocationId: true,
  // Venue hierarchy (FR-005): space = physical blocking, calendar = stream.
  spaceId: true,
  calendarId: true,
  // Venue confirmation (venue-confirmation spec): per-event trust stamp.
  venueConfirmedAt: true,
  venueConfirmedByHumanId: true,
  venueConfirmedPlaceId: true,
  venueConfirmationRequestId: true,
  venueConfirmationWithdrawnAt: true,
  venueConfirmationWithdrawnReason: true,
  venueConfirmedStartsAt: true,
  // freeze-the-deal FR-001.
  dealFrozenAt: true,
  dealFrozenByHumanId: true,
  cancelledFromStatus: true,
  categoryId: true,
  addressText: true,
  countryCode: true,
  region: true,
  locality: true,
  postalCode: true,
  lat: true,
  lng: true,
  slug: true,
  shortId: true,
  regionCode: true,
  publishedAt: true,
  currentAttestationId: true,
  payoutTermsId: true,
  resalePayoutTermsId: true,
  placeLayoutId: true,
  defaultLocale: true,
  listingPriority: true,
  passwordHash: true,
  passwordUpdatedAt: true,
  waitlistStatus: true,
  waitlistPublishAt: true,
  waitlistDescription: true,
  waitlistCap: true,
  refundCutoffAt: true,
  resalePayoutReleaseDaysOverride: true,
  admissionTaxRateBps: true,
  taxRateSource: true,
  instructionalAdmission: true,
  currency: true,
  waiverTemplateId: true,
  ageLimit: true,
  volunteeringEnabled: true,
  volunteerAutoApprove: true,
  volunteerWaiverRequired: true,
  volunteerIntroText: true,
  createdAt: true,
  updatedAt: true,
  body: true,
  recurrenceSchedule: true,
  heroImage: {
    select: {
      publicUrl: true,
      key: true,
      width: true,
      height: true,
    },
  },
  // Category's schema.org Event @type (data-driven per category), used to
  // stamp the JSON-LD @type on the public event page. Nullable relation:
  // uncategorised events resolve to null → SEO builder emits plain "Event".
  category: {
    select: {
      seoType: true,
      name: true,
      nameTranslations: true,
    },
  },
  // Only the NAME. An event with a `placeId` is at a named venue, and the
  // listing card should say "The Blue Room", not "801 Red River St" — a street
  // address is noise when you are scanning a list. Freeform-address events
  // have no `placeId`, so this is null and the address stays the label.
  place: {
    select: {
      name: true,
    },
  },
} as const;

// Default payout-terms lookup filters.
// subjectType/subjectId were removed from PayoutTerms — ownership is now
// expressed via real FKs (Event.payoutTermsId, Agreement.payoutTermsId,
// Organization.defaultPrimaryPayoutTermsId, etc.).
// For new drafts, payout terms are resolved from the owning org/human's
// defaults.  They are required before publish.

export type EventSelectResult = Prisma.EventGetPayload<{
  select: typeof EVENT_SELECT;
}>;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EVENT_ATTESTATION_SELECT = {
  id: true,
  eventId: true,
  attestedByHumanId: true,
  attestedAt: true,
  ipAddress: true,
  userAgent: true,
  policyVersion: true,
  policyTextSnapshot: true,
  legalRightToHost: true,
  zoningAndNoiseCompliance: true,
  alcoholCompliance: true,
  taxResponsibility: true,
  organizerFaqReviewed: true,
  metadata: true,
  createdAt: true,
} as const;

type EventAttestationSelectResult = Prisma.EventAttestationGetPayload<{
  select: typeof EVENT_ATTESTATION_SELECT;
}>;

const SLUG_CONTEXT_SELECT = {
  id: true,
  orgId: true,
  humanId: true,
  title: true,
  startsAt: true,
  timezone: true,
  shortId: true,
  countryCode: true,
  region: true,
  locality: true,
  org: {
    select: {
      name: true,
    },
  },
  // No `human` relation: a person's name never goes in an event URL (see
  // `EventSlugContext.orgName`).
  place: {
    select: {
      city: true,
      region: true,
      country: true,
    },
  },
  savedLocation: {
    select: {
      locality: true,
      region: true,
      countryCode: true,
    },
  },
} as const;

type SlugContextSelectResult = Prisma.EventGetPayload<{
  select: typeof SLUG_CONTEXT_SELECT;
}>;

const GATE_SETTINGS_SELECT = {
  id: true,
  visibility: true,
  gateType: true,
  passwordHash: true,
  passwordUpdatedAt: true,
  waitlistStatus: true,
  waitlistPublishAt: true,
  waitlistDescription: true,
  waitlistCap: true,
} as const;

type GateSettingsSelectResult = Prisma.EventGetPayload<{
  select: typeof GATE_SETTINGS_SELECT;
}>;

/** Both sides known and positive, or null: never half a size. */
const toImageSize = (
  width: number | null | undefined,
  height: number | null | undefined,
): { width: number; height: number } | null =>
  width != null && height != null && width > 0 && height > 0
    ? { width, height }
    : null;

/**
 * `cancelledWhilePublished` (port contract, owner ruling 2026-10-17): the row
 * was PUBLISHED at the moment it was cancelled. A row cancelled before
 * `cancelledFromStatus` existed (NULL) is excluded: its status at cancel is
 * unknown, and the cancelled-in-feed read never shipped, so no subscriber
 * holds an entry for it. An AND element, so it sits in the WHERE the `take`
 * truncates and never crowds the page.
 */
const CANCELLED_WHILE_PUBLISHED_WHERE: Prisma.EventWhereInput = {
  cancelledFromStatus: "PUBLISHED",
};

export const mapEvent = (ev: EventSelectResult): EventRecord => ({
  id: ev.id,
  orgId: ev.orgId,
  humanId: ev.humanId,
  title: ev.title,
  status: ev.status as EventStatus,
  attendanceMode: ev.attendanceMode as EventRecord["attendanceMode"],
  stewardship: ev.stewardship as EventRecord["stewardship"],
  visibility: ev.visibility as EventVisibility,
  gateType: ev.gateType as EventGateType,
  locationMode: ev.locationMode as EventLocationMode,
  locationRadiusMeters: ev.locationRadiusMeters ?? null,
  locationLabel: ev.locationLabel ?? null,
  addressRevealAt: ev.addressRevealAt ?? null,
  addressRevealPreset: (ev.addressRevealPreset ??
    null) as EventRecord["addressRevealPreset"],
  timezone: ev.timezone,
  startsAt: ev.startsAt,
  endsAt: ev.endsAt,
  placeId: ev.placeId,
  savedLocationId: ev.savedLocationId,
  spaceId: ev.spaceId ?? null,
  calendarId: ev.calendarId ?? null,
  venueConfirmedAt: ev.venueConfirmedAt ?? null,
  venueConfirmedByHumanId: ev.venueConfirmedByHumanId ?? null,
  venueConfirmedPlaceId: ev.venueConfirmedPlaceId ?? null,
  venueConfirmationRequestId: ev.venueConfirmationRequestId ?? null,
  venueConfirmationWithdrawnAt: ev.venueConfirmationWithdrawnAt ?? null,
  venueConfirmationWithdrawnReason: ev.venueConfirmationWithdrawnReason ?? null,
  venueConfirmedStartsAt: ev.venueConfirmedStartsAt ?? null,
  dealFrozenAt: ev.dealFrozenAt ?? null,
  dealFrozenByHumanId: ev.dealFrozenByHumanId ?? null,
  cancelledFromStatus: (ev.cancelledFromStatus ?? null) as EventStatus | null,
  categoryId: ev.categoryId,
  categorySeoType: ev.category?.seoType ?? null,
  categoryName: ev.category?.name ?? null,
  categoryNameTranslations: ev.category
    ? parseCategoryNameTranslations(ev.category.nameTranslations)
    : null,
  // RAW name — deliberately ungated here. The consent rule
  // (`isVenueConfirmed`) has TWO arms: an active confirmation stamp, and a
  // venue-owned event at its own place. Only the second needs place
  // ownership, which this select does not carry, so a gate written here can
  // implement just one arm — which is exactly how the DB path and the search
  // index came to disagree about the same event.
  //
  // The rule therefore lives at the PUBLIC boundary, in the use cases, via the
  // one canonical resolver (`resolveVenueConfirmationByEvent`) that the search
  // indexer also uses. Admin surfaces legitimately need the name ungated.
  placeName: ev.place?.name ?? null,
  addressText: ev.addressText,
  countryCode: ev.countryCode ?? null,
  region: ev.region ?? null,
  locality: ev.locality ?? null,
  postalCode: ev.postalCode ?? null,
  lat: ev.lat,
  lng: ev.lng,
  // Stored as Json in Postgres/Prisma; validated at use-case boundary.
  content: (ev as any).body ?? null,
  slug: ev.slug ?? null,
  shortId: ev.shortId ?? null,
  regionCode: ev.regionCode ?? null,
  publishedAt: ev.publishedAt ?? null,
  currentAttestationId: ev.currentAttestationId ?? null,
  payoutTermsId: ev.payoutTermsId,
  resalePayoutTermsId: ev.resalePayoutTermsId ?? null,
  agreementPrimaryId: ev.payoutTermsId,
  agreementResaleId: ev.resalePayoutTermsId ?? null,
  placeLayoutId: ev.placeLayoutId ?? null,
  defaultLocale: ev.defaultLocale ?? null,
  listingPriority: ev.listingPriority ?? null,
  passwordHash: ev.passwordHash ?? null,
  passwordUpdatedAt: ev.passwordUpdatedAt ?? null,
  waitlistStatus: ev.waitlistStatus as WaitlistStatus,
  waitlistPublishAt: ev.waitlistPublishAt ?? null,
  waitlistDescription: ev.waitlistDescription ?? null,
  waitlistCap: ev.waitlistCap ?? null,
  refundCutoffAt: ev.refundCutoffAt ?? null,
  resalePayoutReleaseDaysOverride: ev.resalePayoutReleaseDaysOverride ?? null,
  admissionTaxRateBps: ev.admissionTaxRateBps ?? null,
  taxRateSource: ev.taxRateSource ?? null,
  instructionalAdmission: ev.instructionalAdmission ?? false,
  heroImageUrl: ev.heroImage?.publicUrl ?? null,
  heroImageKey: ev.heroImage?.key ?? null,
  heroImageSize: toImageSize(ev.heroImage?.width, ev.heroImage?.height),
  currency: ev.currency ?? null,
  waiverTemplateId: ev.waiverTemplateId ?? null,
  ageLimit: ev.ageLimit ?? null,
  volunteeringEnabled: ev.volunteeringEnabled ?? false,
  volunteerAutoApprove: ev.volunteerAutoApprove ?? false,
  volunteerWaiverRequired: ev.volunteerWaiverRequired ?? false,
  volunteerIntroText: ev.volunteerIntroText ?? null,
  // Selected via EVENT_SELECT, so it flows through the derived payload type —
  // a future select/type drift fails the compiler instead of being masked.
  // The JSON→domain shape is validated at the use-case boundary.
  recurrenceSchedule:
    (ev.recurrenceSchedule as EventRecord["recurrenceSchedule"]) ?? null,
  createdAt: ev.createdAt,
  updatedAt: ev.updatedAt,
});

/**
 * Confirmed-only predicate for place-scoped public reads (port doc on
 * `venueConfirmedFor`): stamped-and-not-withdrawn AND BOUND TO THE PLACE
 * BEING READ (`venueConfirmedPlaceId`), OR owned by one of the place's
 * owners. The place binding is what stops a stamp travelling with the row
 * when an organizer moves a confirmed event to another venue. Returned as an
 * `AND` fragment so it composes with a caller's own top-level `OR`
 * (listPublishedOccurrencesByPlace has one for the date window — two ORs at
 * one level would collapse into nonsense). Undefined = no filter, no
 * fragment. Empty owner sets contribute no clause (an `in: []` is a valid
 * Prisma query that scans and matches nothing, but omitting it keeps the SQL
 * honest).
 *
 * `{ placeIds }` (the batched read) binds with `IN` — looser than the
 * single-place form, documented on the port. The community arm (FR-002) is
 * LOOSER STILL in that form: `acceptsCommunityListings` is ONE boolean for the
 * whole fan-out, so it cannot express "place A accepts community listings,
 * place B does not" — it either admits accepted listings at every place in the
 * batch or at none. Acceptable only while `listPublishedByPlaceIds` has no
 * confirmed-only caller; a caller that needs per-place consent must fan out
 * the single-place read.
 */
/**
 * The typed error the venue-confirmation writes throw when their (id,
 * placeId) CAS matches zero rows (port contract). Plain object, same shape as
 * the calendars adapter's `calendar_requires_space` — core matches on `code`.
 */
function eventPlaceMismatch() {
  return {
    code: "event_place_mismatch",
    message: "event_place_mismatch",
  } as const;
}

/** The venue confirmed a start the event no longer has (R3-1). */
function eventStartsAtMismatch() {
  return {
    code: "event_starts_at_mismatch",
    message: "event_starts_at_mismatch",
  } as const;
}

/**
 * WHICH arms of `isVenueConfirmed` this filter contributes — the ONE piece of
 * arm-selection logic the two SQL renderings below share.
 *
 * The predicate is unavoidably expressed twice in this file (Prisma
 * `WhereInput` for the list reads, hand-written `Prisma.sql` for
 * `pickRandomEvent`'s raw query) because one pushes through the query builder
 * and the other does not. What is NOT duplicated is the decision about which
 * arms apply: both call this. So a fourth arm can only be forgotten in the
 * RENDERING, which is exactly what the parity test pins
 * (`__tests__/venue-confirmed-parity.test.ts`).
 */
export type VenueConfirmedArmKind =
  | "stamp"
  | "orgOwner"
  | "humanOwner"
  | "community";

export function venueConfirmedArmKinds(
  filter: VenueConfirmedFor | undefined,
): VenueConfirmedArmKind[] {
  if (!filter) return [];
  const kinds: VenueConfirmedArmKind[] = ["stamp"];
  // Empty owner sets contribute no clause (an `in: []` is a valid Prisma query
  // that scans and matches nothing, but omitting it keeps the SQL honest).
  if (filter.orgIds.length > 0) kinds.push("orgOwner");
  if (filter.humanIds.length > 0) kinds.push("humanOwner");
  // FR-002's community arm. `false` contributes nothing at all, which is what
  // makes the flag-off case identical to the pre-FR-001 query.
  if (filter.acceptsCommunityListings) kinds.push("community");
  return kinds;
}

export function venueConfirmedFragment(
  place: { placeId: string } | { placeIds: string[] },
  filter: VenueConfirmedFor | undefined,
): Prisma.EventWhereInput[] {
  if (!filter) return [];
  const placeBinding =
    "placeId" in place ? place.placeId : { in: place.placeIds };
  const arms = venueConfirmedArmKinds(filter).map(
    (kind): Prisma.EventWhereInput => {
      switch (kind) {
        case "stamp":
          return {
            venueConfirmedAt: { not: null },
            venueConfirmationWithdrawnAt: null,
            venueConfirmedPlaceId: placeBinding,
          };
        case "orgOwner":
          return { orgId: { in: filter.orgIds } };
        case "humanOwner":
          return { humanId: { in: filter.humanIds } };
        case "community":
          // `placeId` is bound EXPLICITLY even in the single-place reads whose
          // outer WHERE already scopes it — it mirrors how the stamp arm binds
          // `venueConfirmedPlaceId`, and it is what makes the batched
          // `{ placeIds }` form correct at all.
          return {
            stewardship: "COMMUNITY",
            venueConfirmationWithdrawnAt: null,
            placeId: placeBinding,
          };
      }
    },
  );
  return [{ OR: arms }];
}

/**
 * The SAME arms as {@link venueConfirmedFragment}, rendered as raw SQL for
 * `pickRandomEvent`'s `$queryRaw`. Arm SELECTION comes from the shared
 * {@link venueConfirmedArmKinds}; only the rendering differs.
 *
 * `placeIdSql` is the expression the place binding compares against — the
 * caller has already pinned `e."placeId"` in the surrounding WHERE, so the
 * stamp arm can use the column itself and the community arm the bound id.
 *
 * `'COMMUNITY'` is written as an inline literal, NOT a bound parameter:
 * `Event.stewardship` is a Postgres enum (`"EventStewardship"`, created by
 * migration 20260701120000) and an unknown-typed literal coerces to it, while
 * a bound text parameter would need an explicit cast.
 */
export function venueConfirmedSqlArms(
  filter: VenueConfirmedFor | undefined,
  placeIdSql: Prisma.Sql,
): Array<{ kind: VenueConfirmedArmKind; sql: Prisma.Sql }> {
  if (!filter) return [];
  return venueConfirmedArmKinds(filter).map((kind) => {
    switch (kind) {
      case "stamp":
        return {
          kind,
          sql: Prisma.sql`(e."venueConfirmedAt" IS NOT NULL AND e."venueConfirmationWithdrawnAt" IS NULL AND e."venueConfirmedPlaceId" = e."placeId")`,
        };
      case "orgOwner":
        return {
          kind,
          sql: Prisma.sql`e."orgId" = ANY(${filter.orgIds}::text[])`,
        };
      case "humanOwner":
        return {
          kind,
          sql: Prisma.sql`e."humanId" = ANY(${filter.humanIds}::text[])`,
        };
      case "community":
        return {
          kind,
          sql: Prisma.sql`(e."stewardship" = 'COMMUNITY' AND e."venueConfirmationWithdrawnAt" IS NULL AND e."placeId" = ${placeIdSql})`,
        };
    }
  });
}

const mapEventAttestation = (
  record: EventAttestationSelectResult,
): EventAttestationRecord => ({
  id: record.id,
  eventId: record.eventId,
  attestedByHumanId: record.attestedByHumanId,
  attestedAt: record.attestedAt,
  ipAddress: record.ipAddress ?? null,
  userAgent: record.userAgent ?? null,
  policyVersion: record.policyVersion,
  policyTextSnapshot: record.policyTextSnapshot as Record<string, string>,
  legalRightToHost: record.legalRightToHost,
  zoningAndNoiseCompliance: record.zoningAndNoiseCompliance,
  alcoholCompliance: record.alcoholCompliance,
  taxResponsibility: record.taxResponsibility,
  organizerFaqReviewed: record.organizerFaqReviewed,
  metadata: record.metadata as Record<string, unknown> | null,
  createdAt: record.createdAt,
});

const mapSlugContext = (record: SlugContextSelectResult): EventSlugContext => {
  const countryCode =
    record.countryCode ??
    record.savedLocation?.countryCode ??
    record.place?.country ??
    null;
  const regionCode =
    record.region ??
    record.savedLocation?.region ??
    record.place?.region ??
    null;
  const cityOrRegionCode =
    record.locality ??
    record.savedLocation?.locality ??
    record.place?.city ??
    regionCode ??
    null;

  return {
    eventId: record.id,
    orgId: record.orgId,
    humanId: record.humanId,
    eventTitle: record.title,
    startsAt: record.startsAt,
    timezone: record.timezone,
    orgName: record.org?.name ?? null,
    countryCode,
    regionCode,
    cityOrRegionCode,
    shortId: record.shortId ?? null,
  } satisfies EventSlugContext;
};

const mapGateSettings = (
  record: GateSettingsSelectResult,
): EventGateSettings => ({
  eventId: record.id,
  visibility: record.visibility as EventVisibility,
  gateType: record.gateType as EventGateType,
  passwordHash: record.passwordHash ?? null,
  passwordUpdatedAt: record.passwordUpdatedAt ?? null,
  waitlistStatus: record.waitlistStatus as WaitlistStatus,
  waitlistPublishAt: record.waitlistPublishAt ?? null,
  waitlistDescription: record.waitlistDescription ?? null,
  waitlistCap: record.waitlistCap ?? null,
  waitlistEmailEnabled:
    ((record as Record<string, unknown>).waitlistEmailEnabled as boolean) ??
    false,
  waitlistEmailSubject:
    ((record as Record<string, unknown>).waitlistEmailSubject as
      | string
      | null) ?? null,
  waitlistEmailBody:
    (record as Record<string, unknown>).waitlistEmailBody ?? null,
});

function mapTicketTypeStatus(
  status: PrismaTicketTypeStatus,
): EventTicketTypeSummary["status"] {
  switch (status) {
    case "ACTIVE":
      return "ACTIVE";
    case "INACTIVE":
    case "ARCHIVED":
    default:
      return "DRAFT";
  }
}

// ─── Place → Event location (place-address-withholding D1) ─────────────────
//
// For an event with `placeId` whose place is not EXACT, the Event row's
// location fields are already a public projection; the TRUE location is on
// the Place row only.
//
// This adapter is the only code that writes Event location FROM a Place, and
// every caller funnels through `upsertDraft` — the save-event body, series
// generation, series draft sync and template application alike (three of
// those four never pass through the core's floor). So the rule
// is enforced HERE, fail-closed, whatever the caller asked for: at a withheld
// place the row gets the venue's public projection and a privacy floored at
// the venue's. The rule itself lives in core
// (`@th/core/lib/location/place-event-location`); this only applies it.

/** Place columns the Place → Event location copy reads. */
const PLACE_LOCATION_SELECT = {
  lat: true,
  lng: true,
  address: true,
  city: true,
  region: true,
  country: true,
  postcode: true,
  locationMode: true,
  locationRadiusMeters: true,
  locationLabel: true,
} as const;

type PlaceLocationRow = {
  lat: number | null;
  lng: number | null;
  address: string;
  city: string | null;
  region: string | null;
  country: string | null;
  postcode: string | null;
  locationMode: string;
  locationRadiusMeters: number | null;
  locationLabel: string | null;
};

function placeLocationSource(
  placeId: string,
  row: PlaceLocationRow,
): PlaceEventLocationSource {
  return {
    id: placeId,
    // Passed through RAW: the projection treats anything but the literal
    // "EXACT" as withheld, and a defensive `?? "EXACT"` here would defeat it.
    locationMode: row.locationMode,
    locationRadiusMeters: row.locationRadiusMeters,
    locationLabel: row.locationLabel,
    formattedAddress: row.address,
    city: row.city,
    region: row.region,
    countryCode: row.country,
    postalCode: row.postcode,
    lat: row.lat,
    lng: row.lng,
  };
}

/**
 * Transaction-scoped advisory lock on the location columns of every event at
 * `placeId` (see `EventsRepo.lockLocationsAtPlace`). Namespaced so it never
 * contends with `lockPlaceForClaim`'s `hashtext(placeId)` key.
 * `$executeRaw`, not `$queryRaw`: the lock functions return Postgres `void`.
 */
async function lockPlaceLocations(
  p: PrismaClientOrTx,
  placeId: string,
  mode: "shared" | "exclusive",
): Promise<void> {
  const key = `place_location:${placeId}`;
  // Accepted: a tx already holding an Event row lock here can deadlock with a cascade; Postgres aborts one tx (an error, never a leak).
  // The search index write fence (core `withIndexWriteFence`) takes this lock
  // "shared" for every venue it indexes, BEFORE any Event row lock (`lockRows`),
  // so it never holds a row a cascade is waiting on; take locks in that same
  // order (venue first, rows second) in any new caller.
  if (mode === "exclusive") {
    await p.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
  } else {
    await p.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${key}))`;
  }
}

/**
 * Write the place's location onto `data`, the Event create/update payload
 * whose location columns the caller has ALREADY reset to NULL.
 *
 * EXACT place → the true columns; `locationMode` / radius / reveal are left as
 * the caller set them (the historical behaviour, unchanged).
 *
 * Withheld place → the public projection, and the row's privacy floored at
 * the venue's. The requested privacy is the caller's input, falling back to
 * the stored row on an update that omits it (and to the create defaults on a
 * create). A row that was EXACT until this write and carries no reveal
 * schedule gets the default one, so its ticket holders are not locked out.
 */
async function applyPlaceLocationToEventData(
  p: PrismaClientOrTx,
  data: Record<string, unknown>,
  placeId: string,
  place: PlaceLocationRow,
  write:
    | { kind: "create"; input: SaveEventInput }
    | { kind: "update"; eventId: string; input: SaveEventInput },
): Promise<void> {
  const { input } = write;
  const has = (key: keyof SaveEventInput) =>
    Object.prototype.hasOwnProperty.call(input, key);

  let requestedMode: EventLocationMode;
  let requestedRadius: number | null;
  let revealPreset: string | null;
  let revealAt: Date | null;

  if (write.kind === "create") {
    requestedMode = input.locationMode ?? "EXACT";
    requestedRadius =
      input.locationRadiusMeters === undefined ? 500 : input.locationRadiusMeters;
    revealPreset = input.addressRevealPreset ?? null;
    revealAt = input.addressRevealAt ?? null;
  } else {
    const needsStored =
      input.locationMode === undefined ||
      input.locationRadiusMeters === undefined ||
      !has("addressRevealPreset") ||
      !has("addressRevealAt");
    const stored = needsStored
      ? await p.event.findUnique({
          where: { id: write.eventId },
          select: {
            locationMode: true,
            locationRadiusMeters: true,
            addressRevealPreset: true,
            addressRevealAt: true,
          },
        })
      : null;
    requestedMode =
      input.locationMode ??
      ((stored?.locationMode as EventLocationMode | undefined) ?? "EXACT");
    requestedRadius =
      input.locationRadiusMeters !== undefined
        ? input.locationRadiusMeters
        : (stored?.locationRadiusMeters ?? null);
    revealPreset = has("addressRevealPreset")
      ? (input.addressRevealPreset ?? null)
      : ((stored?.addressRevealPreset as string | null | undefined) ?? null);
    revealAt = has("addressRevealAt")
      ? (input.addressRevealAt ?? null)
      : (stored?.addressRevealAt ?? null);
  }

  const projected = projectEventLocationAtPlace(
    placeLocationSource(placeId, place),
    { locationMode: requestedMode, locationRadiusMeters: requestedRadius },
  );

  Object.assign(data, projected.columns);
  if (!projected.withheld) return;

  // A fine geohash nobody writes today — cleared anyway, because a legacy row
  // carrying one would pin the house to ~38 m.
  data.geohash8 = null;
  data.locationMode = projected.privacy.locationMode;
  data.locationRadiusMeters = projected.privacy.locationRadiusMeters;

  if (requestedMode === "EXACT" && revealPreset === null && revealAt === null) {
    data.addressRevealPreset = WITHHELD_EVENT_DEFAULT_REVEAL.preset;
    data.addressRevealAt = new Date(
      input.startsAt.getTime() - WITHHELD_EVENT_DEFAULT_REVEAL.leadMs,
    );
  }
}

export function makeEventsRepo(p: PrismaClientOrTx): EventsRepo {
  return {
    // `withOwnerStanding` (opt-in, ban-that-sticks) also DERIVES
    // `ownerBanned`, so the public-read gates and checkout can refuse a banned
    // owner's event without a second port call. Internal reads skip the owner
    // join. See ./banned-owner.ts.
    getById: async (id: string, options?: { withOwnerStanding?: boolean }) => {
      if (options?.withOwnerStanding) {
        const ev = await p.event.findUnique({
          where: { id },
          select: { ...EVENT_SELECT, ...EVENT_OWNER_STANDING_SELECT },
        });
        return ev
          ? { ...mapEvent(ev), ownerBanned: ownerBannedFromStanding(ev) }
          : null;
      }
      const ev = await p.event.findUnique({
        where: { id },
        select: EVENT_SELECT,
      });
      return ev ? mapEvent(ev) : null;
    },
    findManyByIds: async (
      ids: string[],
      options?: { withOwnerStanding?: boolean },
    ) => {
      if (ids.length === 0) return [];
      if (options?.withOwnerStanding) {
        const events = await p.event.findMany({
          where: { id: { in: ids } },
          select: { ...EVENT_SELECT, ...EVENT_OWNER_STANDING_SELECT },
        });
        return events.map((ev) => ({
          ...mapEvent(ev),
          ownerBanned: ownerBannedFromStanding(ev),
        }));
      }
      const events = await p.event.findMany({
        where: { id: { in: ids } },
        select: EVENT_SELECT,
      });
      return events.map(mapEvent);
    },
    pickRandomEvent: async (input) => {
      // ALWAYS published + PUBLIC + ungated. This backs an anonymous
      // endpoint; there is no caller-controlled scope (the port has no
      // `publishedOnly` any more — `false` once returned drafts and private
      // events with their exact addresses). A gated event protects its
      // location like the rest of its page (the gated preview carries title
      // + hero only), so it is never a "surprise".
      const conditions: Prisma.Sql[] = [
        Prisma.sql`e.status = 'PUBLISHED'`,
        Prisma.sql`e.visibility = 'PUBLIC'`,
        Prisma.sql`e."gateType" = 'NONE'`,
        // Never pick a banned owner's event (banned-owner.ts).
        eventOwnerNotWithheldSubquerySql("e"),
      ];
      conditions.push(Prisma.sql`e."startsAt" >= ${input.window.from}`);
      conditions.push(Prisma.sql`e."startsAt" <= ${input.window.to}`);

      if (input.orgId) {
        conditions.push(Prisma.sql`e."orgId" = ${input.orgId}`);
      }
      if (input.placeId) {
        conditions.push(Prisma.sql`e."placeId" = ${input.placeId}`);
        // Confirmed-only pick (port doc): the SAME predicate as
        // listPublishedByPlace, built from the SAME arm-selection source
        // (`venueConfirmedArmKinds`) so a new arm cannot be added to one read
        // and forgotten here. `venueConfirmedPlaceId = e."placeId"` is exact
        // because placeId is pinned just above.
        const arms = venueConfirmedSqlArms(
          input.venueConfirmedFor,
          Prisma.sql`${input.placeId}`,
        ).map((arm) => arm.sql);
        if (arms.length > 0) {
          conditions.push(Prisma.sql`(${Prisma.join(arms, " OR ")})`);
        }
      }
      if (input.excludeEventIds.length > 0) {
        conditions.push(
          Prisma.sql`e.id <> ALL(${input.excludeEventIds}::text[])`,
        );
      }
      if (input.q) {
        conditions.push(Prisma.sql`e.title ILIKE ${`%${input.q}%`}`);
      }
      const near = input.near ?? null;
      if (near) {
        const radiusM = near.radiusKm * 1000;
        const origin = Prisma.sql`ll_to_earth(${near.lat}::float8, ${near.lng}::float8)`;
        // ANTI-ORACLE (FR-013/NFR-001 — the geo adapters' two-phase rule).
        // SQL is only a CANDIDATE fetch; whether an event is "near" is
        // decided BELOW from the point it is SHOWN at
        // (`projectPublicEventLocation`). Filtering on the stored pin would
        // make this anonymous endpoint a presence oracle: pin the pick to one
        // venue, slide the probe point, and the event appears exactly when
        // the house is within the radius — a few dozen requests trilaterate
        // it. Candidates are widened so every event whose EMITTED point could
        // be in range is fetched, by the DRAWN radius (the stored one snapped
        // up to the ladder — the emitted point is within it of the truth):
        //   · venue withholds → by the VENUE's point + the venue's radius
        //     (such events emit the venue's circle centre, whatever the row
        //     holds);
        //   · otherwise → by the row's point + its own radius (0 when EXACT).
        const venueRadius = snappedObfuscationRadiusSql(
          Prisma.sql`pl.location_radius_meters`,
        );
        const eventRadius = snappedObfuscationRadiusSql(
          Prisma.sql`e."locationRadiusMeters"`,
        );
        conditions.push(Prisma.sql`
          (
            (
              pl.id IS NOT NULL AND pl.location_mode <> 'EXACT'
              AND pl.lat IS NOT NULL AND pl.lng IS NOT NULL
              AND pl.location_radius_meters IS NOT NULL
              AND earth_distance(${origin}, ll_to_earth(pl.lat, pl.lng)) <= ${radiusM}::float8 + ${venueRadius}
            )
            OR (
              (pl.id IS NULL OR pl.location_mode = 'EXACT')
              AND e.lat IS NOT NULL AND e.lng IS NOT NULL
              AND earth_distance(${origin}, ll_to_earth(e.lat, e.lng)) <= ${radiusM}::float8
                + CASE WHEN e."locationMode" = 'EXACT' THEN 0 ELSE COALESCE(${eventRadius}, 0) END
            )
          )
        `);
      }

      const whereSql = conditions.length
        ? Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}`
        : Prisma.empty;

      if (near) {
        // TIMING ANTI-ORACLE. The candidate set above depends on the TRUE
        // point (it has to — the SHOWN point is a keyed HMAC draw SQL cannot
        // compute). So nothing after it may branch on whether a candidate
        // exists: ONE query returns every input the public projection needs
        // (event + venue columns), the shown point and the range test run in
        // JS, and only the CHOSEN row is hydrated. The number and shape of
        // queries is then a function of the pick — i.e. of SHOWN points —
        // never of a stored one. (It used to return early on an empty
        // candidate set and run two more queries otherwise: a probe inside
        // radius + R of the house was measurably slower than one outside.)
        //
        // Candidates in random order; the FIRST whose emitted point is in
        // range is the pick — a uniform pick over the in-range events. A
        // page larger than the in-range set is exact; past it the pick can
        // come back empty, which depends on aggregate density.
        const candidateRows = await p.$queryRaw<RandomNearCandidateRow[]>(Prisma.sql`
          SELECT
            e.id,
            e."orgId",
            e."humanId",
            e."placeId",
            e."gateType"::text AS "gateType",
            e."locationMode",
            e."locationRadiusMeters",
            e."locationLabel",
            e."addressText",
            e.lat,
            e.lng,
            e.locality,
            e.region,
            e."countryCode",
            e."postalCode",
            pl.id AS "placeRowId",
            pl.location_mode AS "placeLocationMode",
            pl.location_radius_meters AS "placeLocationRadiusMeters",
            pl.location_label AS "placeLocationLabel",
            pl.lat AS "placeLat",
            pl.lng AS "placeLng",
            pl.city AS "placeCity",
            pl.region AS "placeRegion",
            pl.country AS "placeCountry"
          FROM "Event" e
          LEFT JOIN "Place" pl ON pl.id = e."placeId"
          ${whereSql}
          ORDER BY random()
          LIMIT ${RANDOM_NEAR_CANDIDATE_LIMIT}
        `);
        const radiusM = near.radiusKm * 1000;
        const chosen = candidateRows.find((row) => {
          const shown = projectPublicEventLocation(
            randomNearCandidateEvent(row),
            { place: randomNearCandidatePlace(row) },
          );
          const distance = publicDistanceMeters(near, shown);
          return distance !== null && distance <= radiusM;
        });
        if (!chosen) return null;
        const ev = await p.event.findUnique({
          where: { id: chosen.id },
          select: EVENT_SELECT,
        });
        return ev ? mapEvent(ev) : null;
      }

      // Random pick over the filtered set. `ORDER BY random()` is acceptable at
      // the current catalogue scale; no dedicated random-sampling index is
      // warranted. We select only the id here, then hydrate the full record
      // through the shared EVENT_SELECT/mapEvent path for a consistent DTO.
      const rows = await p.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT e.id
        FROM "Event" e
        ${whereSql}
        ORDER BY random()
        LIMIT 1
      `);

      const picked = rows[0];
      if (!picked) return null;

      const ev = await p.event.findUnique({
        where: { id: picked.id },
        select: EVENT_SELECT,
      });
      return ev ? mapEvent(ev) : null;
    },
    getContent: async ({ eventId }) => {
      // NOTE: body is optional and may not be present in older generated Prisma clients.
      // Keep this code compiling by escaping the select typing.
      const ev = (await (p.event as any).findUnique({
        where: { id: eventId },
        select: { body: true },
      })) as { body?: unknown } | null;

      // Stored as JSONB; validated at use-case boundary.
      return (ev?.body as any) ?? null;
    },
    listMediaReferenceSets: async (eventIds) => {
      if (eventIds.length === 0) return [];
      // Reads the RAW columns (hero FK + body JSONB), not the hydrated
      // read-model — a GC decision must not depend on what a mapper chose to
      // populate. `body` is escaped for the same reason as `getContent`.
      const rows = (await (p.event as any).findMany({
        where: { id: { in: eventIds } },
        select: {
          id: true,
          heroImageId: true,
          body: true,
          waitlistEmailBody: true,
        },
      })) as {
        id: string;
        heroImageId: string | null;
        body?: unknown;
        waitlistEmailBody?: unknown;
      }[];

      // Every JSON column that could carry an image id goes in `bodies`. Add
      // new ones HERE — omitting one makes the GC blind to that surface and
      // deletes whatever only it references.
      //
      // `Event` has a third Json column, `recurrenceSchedule`, deliberately
      // excluded: it holds an RRULE / FIXED_DATES payload with no media fields.
      // The list is curated, not exhaustive-by-construction.
      return rows.map((row) => ({
        eventId: row.id,
        heroImageId: row.heroImageId ?? null,
        bodies: [row.body ?? null, row.waitlistEmailBody ?? null],
      }));
    },
    updateContent: async ({ eventId, content }) => {
      const updated = await (p.event as any).update({
        where: { id: eventId },
        data: {
          body: content as any,
        },
        select: EVENT_SELECT,
      });

      return mapEvent(updated);
    },
    listTicketTypes: async (eventId: string) => {
      const records = await p.ticketType.findMany({
        where: { eventId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          name: true,
          description: true,
          priceCents: true,
          pricingMode: true,
          minimumCents: true,
          suggestedCents: true,
          capacity: true,
          status: true,
          seatSectionId: true,
          resaleAllowed: true,
          resaleCapCents: true,
          transferAllowed: true,
          scheduledPriceCents: true,
          scheduledPriceAt: true,
          salesOpenAt: true,
          salesCloseAt: true,
        },
      });

      return records.map((tt) => ({
        id: tt.id,
        name: tt.name,
        description: tt.description ?? null,
        priceCents: tt.priceCents,
        pricingMode: tt.pricingMode,
        minimumCents: tt.minimumCents,
        suggestedCents: tt.suggestedCents,
        capacity: tt.capacity,
        status: mapTicketTypeStatus(tt.status),
        seatSectionId: tt.seatSectionId ?? null,
        resaleAllowed: tt.resaleAllowed,
        resaleCapCents: tt.resaleCapCents,
        transferAllowed: tt.transferAllowed,
        scheduledPriceCents: tt.scheduledPriceCents ?? null,
        scheduledPriceAt: tt.scheduledPriceAt ?? null,
        salesOpenAt: tt.salesOpenAt ?? null,
        salesCloseAt: tt.salesCloseAt ?? null,
      }));
    },
    listTicketTypesForEventIds: async (eventIds) => {
      if (eventIds.length === 0) return [];

      const records = await p.ticketType.findMany({
        where: { eventId: { in: eventIds } },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          eventId: true,
          name: true,
          description: true,
          priceCents: true,
          pricingMode: true,
          minimumCents: true,
          suggestedCents: true,
          capacity: true,
          status: true,
          seatSectionId: true,
          resaleAllowed: true,
          resaleCapCents: true,
          transferAllowed: true,
          scheduledPriceCents: true,
          scheduledPriceAt: true,
          salesOpenAt: true,
          salesCloseAt: true,
        },
      });

      return records.map((tt) => ({
        eventId: tt.eventId,
        id: tt.id,
        name: tt.name,
        description: tt.description ?? null,
        priceCents: tt.priceCents,
        pricingMode: tt.pricingMode,
        minimumCents: tt.minimumCents,
        suggestedCents: tt.suggestedCents,
        capacity: tt.capacity,
        status: mapTicketTypeStatus(tt.status),
        seatSectionId: tt.seatSectionId ?? null,
        resaleAllowed: tt.resaleAllowed,
        resaleCapCents: tt.resaleCapCents,
        transferAllowed: tt.transferAllowed,
        scheduledPriceCents: tt.scheduledPriceCents ?? null,
        scheduledPriceAt: tt.scheduledPriceAt ?? null,
        salesOpenAt: tt.salesOpenAt ?? null,
        salesCloseAt: tt.salesCloseAt ?? null,
      }));
    },
    listEventIdsWithScheduledPriceFlipBetween: async ({
      windowStart,
      windowEnd,
      limit,
      afterEventId,
    }) => {
      // Half-open on the left, closed on the right — matching the resolver's
      // inclusive-at-T flip semantics, so a tier flipping at exactly windowEnd
      // is picked up by THIS run rather than the next one.
      //
      // NO `distinct`: see the port's doc comment. `distinct` + `take` has
      // version-dependent semantics (DISTINCT ON push-down vs in-memory dedup),
      // and in the in-memory case `take` bounds ticket-type ROWS rather than
      // events, silently shrinking the page by a factor of tiers-per-event.
      // Returning rows and deduping in the caller removes the ambiguity
      // entirely rather than pinning whichever behaviour today's Prisma has.
      const rows = await p.ticketType.findMany({
        where: {
          status: "ACTIVE",
          scheduledPriceAt: { gt: windowStart, lte: windowEnd },
          // A half-configured row can never flip (the resolver treats it as
          // unscheduled), so it must not force a reindex either.
          scheduledPriceCents: { not: null },
          event: { status: "PUBLISHED" },
          ...(afterEventId ? { eventId: { gt: afterEventId } } : {}),
        },
        select: { eventId: true },
        orderBy: { eventId: "asc" },
        take: Math.max(1, limit),
      });

      return rows.map((row) => row.eventId);
    },
    listPublishedForSitemap: async (input) => {
      // Cap at Google's 50k-per-sitemap-file limit. The sitemaps job shards
      // output at 45k URLs/file, so a single 50k read fills at most ~2 files.
      // TODO: >50k published events will need cursor pagination here.
      const take = Math.min(Math.max(input?.limit ?? 50000, 1), 50000);

      // Drop events that have already finished so the sitemap doesn't advertise
      // dead URLs. `endsAt` is required on Event, so "not yet ended" is exactly
      // `endsAt >= now` — this retains upcoming AND in-progress multi-day
      // events. `now` is threaded from the use case for testability. (If
      // `endsAt` ever becomes nullable, fall back to `startsAt >= now` for the
      // null case via an OR.)
      const now = input?.now ?? new Date();

      const records = await p.event.findMany({
        where: {
          status: "PUBLISHED",
          visibility: "PUBLIC",
          slug: { not: null },
          endsAt: { gte: now },
          // A gated event's page is noindex, so the sitemap leaves it out
          // (owner ruling 2026-10-13).
          gateType: "NONE",
          // A banned owner's event is withheld (banned-owner.ts).
          ...(await notWithheldEventWhere(p)),
        },
        orderBy: { updatedAt: "desc" },
        take,
        select: {
          slug: true,
          updatedAt: true,
        },
      });

      return records
        .filter(
          (record): record is { slug: string; updatedAt: Date } =>
            typeof record.slug === "string",
        )
        .map<EventSitemapEntryRecord>((record) => ({
          slug: record.slug,
          updatedAt: record.updatedAt ?? null,
        }));
    },
    enumerateGeoCategoryCombos: async ({ minCount, startsAfter }) => {
      // Raw SQL so we can GROUP BY a SLUG-FOLDED locality/regionCode. The fold
      // MUST byte-for-byte match `slugifyCity` (lowercase → collapse every run
      // of non-alphanumerics to a single hyphen → strip leading/trailing
      // hyphens) so the segment we emit here resolves to a non-empty page in
      // `listPublishedByCategoryAndCity`, which folds identically. Values are
      // parameterized — no string interpolation. Enum columns compare against
      // text literals (Postgres casts them), matching the other raw queries.
      const rows = await p.$queryRaw<
        Array<{
          categorySlug: string;
          categoryName: string;
          categoryNameTranslations: unknown;
          locality: string;
          regionCode: string | null;
          count: number;
          latestUpdatedAt: Date | null;
        }>
      >`
        SELECT
          c.slug AS "categorySlug",
          c.name AS "categoryName",
          c."nameTranslations" AS "categoryNameTranslations",
          min(e.locality) AS "locality",
          lower(e."regionCode") AS "regionCode",
          count(*)::int AS "count",
          max(e."updatedAt") AS "latestUpdatedAt"
        FROM "Event" e
        JOIN "Category" c ON c.id = e."categoryId" AND c.active = true
        WHERE e.status = 'PUBLISHED'
          AND e.visibility = 'PUBLIC'
          AND e."categoryId" IS NOT NULL
          AND e.locality IS NOT NULL
          AND btrim(e.locality) <> ''
          AND e."startsAt" >= ${startsAfter}
          AND ${eventOwnerNotWithheldSubquerySql("e")}
          -- Only ungated events count toward the threshold: the page's
          -- robots rule counts ungated events too (indexableTotal), over a
          -- match set that contains this group, so every combo is indexable.
          AND ${UNGATED_EVENT_SQL}
        GROUP BY
          c.id,
          btrim(regexp_replace(lower(btrim(e.locality)), '[^a-z0-9]+', '-', 'g'), '-'),
          lower(e."regionCode")
        HAVING count(*) >= ${minCount}
        ORDER BY count(*) DESC, c.slug ASC
      `;

      return rows.map<GeoCategoryComboRecord>((row) => {
        const region = (row.regionCode ?? "").trim();
        return {
          categorySlug: row.categorySlug,
          categoryName: row.categoryName,
          categoryNameTranslations: parseCategoryNameTranslations(
            row.categoryNameTranslations,
          ),
          locality: row.locality,
          regionCode: region.length > 0 ? region.toLowerCase() : null,
          count: Number(row.count),
          latestUpdatedAt: row.latestUpdatedAt ?? null,
        };
      });
    },
    listPublishedByCategoryAndCity: async ({
      categorySlug,
      citySlug,
      region,
      limit,
      offset,
      startsAfter,
    }) => {
      const { limit: sanitizedLimit, offset: sanitizedOffset } =
        sanitizeOffsetPagination({
          limit,
          offset,
          defaultLimit: 48,
          maxLimit: 60,
        });

      const normalizedCitySlug = citySlug.trim().toLowerCase();
      const normalizedRegion = (region ?? "").trim().toLowerCase();

      // Prisma `where` can't express `regexp_replace`, so we fold the locality
      // in SQL — the SAME fold `enumerateGeoCategoryCombos` groups by — to pick
      // matching ids + the window total, then hydrate via EVENT_SELECT/mapEvent.
      // The region clause matches either the normalized regionCode or a
      // slug-folded free-text region. Enum comparisons use text literals.
      const regionClause = normalizedRegion
        ? Prisma.sql`AND (
            lower(e."regionCode") = ${normalizedRegion}
            OR btrim(regexp_replace(lower(btrim(e.region)), '[^a-z0-9]+', '-', 'g'), '-') = ${normalizedRegion}
          )`
        : Prisma.empty;

      // `indexableTotal` counts the ungated matches in the same window: the
      // page's robots threshold. It is at least what
      // `enumerateGeoCategoryCombos` counts for the same group (its region
      // clause also matches free-text regions), never less.
      const rows = await p.$queryRaw<
        Array<{ id: string; total: number; indexableTotal: number }>
      >(
        Prisma.sql`
          SELECT
            e.id AS "id",
            count(*) OVER()::int AS "total",
            (count(*) FILTER (WHERE ${UNGATED_EVENT_SQL}) OVER())::int AS "indexableTotal"
          FROM "Event" e
          JOIN "Category" c ON c.id = e."categoryId" AND c.active = true
          WHERE e.status = 'PUBLISHED'
            AND e.visibility = 'PUBLIC'
            AND c.slug = ${categorySlug}
            AND btrim(regexp_replace(lower(btrim(e.locality)), '[^a-z0-9]+', '-', 'g'), '-') = ${normalizedCitySlug}
            AND e."startsAt" >= ${startsAfter}
            AND ${eventOwnerNotWithheldSubquerySql("e")}
            ${regionClause}
          ORDER BY e."startsAt" ASC, e."createdAt" ASC
          LIMIT ${sanitizedLimit} OFFSET ${sanitizedOffset}
        `,
      );

      const total = rows.length > 0 ? Number(rows[0]!.total) : 0;
      const indexableTotal =
        rows.length > 0 ? Number(rows[0]!.indexableTotal) : 0;
      const ids = rows.map((r) => r.id);

      if (ids.length === 0) {
        return {
          ...buildOffsetPaginatedResult({
            items: [],
            total,
            limit: sanitizedLimit,
            offset: sanitizedOffset,
          }),
          indexableTotal,
        };
      }

      const events = await p.event.findMany({
        where: { id: { in: ids } },
        select: EVENT_SELECT,
      });
      const byId = new Map(events.map((ev) => [ev.id, ev]));
      const items = ids
        .map((id) => byId.get(id))
        .filter((ev): ev is EventSelectResult => ev != null)
        .map(mapEvent);

      return {
        ...buildOffsetPaginatedResult({
          items,
          total,
          limit: sanitizedLimit,
          offset: sanitizedOffset,
        }),
        indexableTotal,
      };
    },
    countPublishedByCategoryAndCityRegionCode: async ({
      categorySlug,
      citySlug,
      regionCode,
      startsAfter,
    }) => {
      // Same filters as `listPublishedByCategoryAndCity`, but the region is
      // matched on `lower(regionCode)` ONLY — the key the sitemap's
      // `enumerateGeoCategoryCombos` groups by — so a NULL-code row with a
      // free-text region never counts. Count only, no hydrate. Parameterized.
      const normalizedCitySlug = citySlug.trim().toLowerCase();
      const normalizedRegionCode = regionCode.trim().toLowerCase();
      const rows = await p.$queryRaw<Array<{ total: number }>>(
        Prisma.sql`
          SELECT count(*)::int AS "total"
          FROM "Event" e
          JOIN "Category" c ON c.id = e."categoryId" AND c.active = true
          WHERE e.status = 'PUBLISHED'
            AND e.visibility = 'PUBLIC'
            AND c.slug = ${categorySlug}
            AND btrim(regexp_replace(lower(btrim(e.locality)), '[^a-z0-9]+', '-', 'g'), '-') = ${normalizedCitySlug}
            AND e."startsAt" >= ${startsAfter}
            AND ${eventOwnerNotWithheldSubquerySql("e")}
            AND lower(e."regionCode") = ${normalizedRegionCode}
        `,
      );
      return Number(rows[0]?.total ?? 0);
    },
    listPublished: async ({
      limit,
      offset,
      startsAfter,
      visibility,
      excludeBannedOwners,
    }) => {
      const { limit: sanitizedLimit, offset: sanitizedOffset } =
        sanitizeOffsetPagination({
          limit,
          offset,
          defaultLimit: 100,
          maxLimit: 500,
        });

      const where: Prisma.EventWhereInput = {
        status: "PUBLISHED",
        // Omitted → every visibility (the search indexer needs PRIVATE rows);
        // a public listing passes ["PUBLIC"]. See the port doc.
        ...(visibility && visibility.length > 0
          ? { visibility: { in: visibility } }
          : {}),
        ...(startsAfter ? { startsAt: { gte: startsAfter } } : {}),
        // Public listings opt in; the search indexer and stats do not.
        ...(excludeBannedOwners ? await notWithheldEventWhere(p) : {}),
      };

      const [total, events] = await Promise.all([
        p.event.count({ where }),
        p.event.findMany({
          where,
          orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
          select: EVENT_SELECT,
          skip: sanitizedOffset,
          take: sanitizedLimit,
        }),
      ]);

      return {
        items: events.map(mapEvent),
        pageInfo: buildOffsetPageInfo({
          total,
          limit: sanitizedLimit,
          offset: sanitizedOffset,
          count: events.length,
        }),
      };
    },
    getPopularityStats: async (eventIds) => {
      if (eventIds.length === 0) return [];

      // Aggregate ticket sales: count all active order items for each event
      const salesData = await p.$queryRaw<
        Array<{ eventId: string; ticketsSold: bigint; totalCapacity: bigint }>
      >`
        SELECT 
          e.id AS "eventId",
          COALESCE(SUM(oi.qty), 0)::bigint AS "ticketsSold",
          COALESCE((
            SELECT SUM(tt.capacity)::bigint 
            FROM "TicketType" tt 
            WHERE tt."eventId" = e.id AND tt.status = 'ACTIVE'
          ), 0) AS "totalCapacity"
        FROM "Event" e
        LEFT JOIN "Order" o ON o."eventId" = e.id AND o.status = 'SUCCEEDED'
        LEFT JOIN "OrderItem" oi ON oi."orderId" = o.id AND oi.status = 'active' AND oi.kind = 'ticket'
        WHERE e.id = ANY(${eventIds})
        GROUP BY e.id
      `;

      // Aggregate waitlist entries (PENDING status only)
      const waitlistData = await p.$queryRaw<
        Array<{ eventId: string; waitlistCount: bigint }>
      >`
        SELECT 
          w."eventId",
          COUNT(*)::bigint AS "waitlistCount"
        FROM "EventWaitlistEntry" w
        WHERE w."eventId" = ANY(${eventIds}) AND w.status = 'PENDING'
        GROUP BY w."eventId"
      `;

      // Build a map for waitlist counts
      const waitlistMap = new Map(
        waitlistData.map((w) => [w.eventId, Number(w.waitlistCount)]),
      );

      // Merge results
      return salesData.map((s) => ({
        eventId: s.eventId,
        ticketsSold: Number(s.ticketsSold),
        waitlistCount: waitlistMap.get(s.eventId) ?? 0,
        totalCapacity: Number(s.totalCapacity),
      }));
    },
    ensureHostPermission: async (eventId: string, actorHumanId: string) => {
      const ev = await p.event.findUnique({
        where: { id: eventId },
        select: { orgId: true },
      });
      if (!ev?.orgId) return false;
      const member = await p.orgMember.findFirst({
        where: { orgId: ev.orgId, humanId: actorHumanId },
      });
      if (!member) return false;
      return ["OWNER", "ADMIN", "EDITOR"].includes(member.role as any);
    },
    async upsertDraft(input: SaveEventInput) {
      const subjectId = input.orgId ?? input.humanId;
      if (!subjectId) {
        throw { code: "invalid_input", message: "event_owner_missing" };
      }

      const location = input.location;

      if (input.eventId) {
        const data: Prisma.EventUncheckedUpdateInput = {
          title: input.title,
          startsAt: input.startsAt,
          status: input.status,
          placeId: null,
          savedLocationId: null,
          addressText: null,
          lat: null,
          lng: null,
          geohash6: null,
          locality: null,
          region: null,
          countryCode: null,
          postalCode: null,
          placeLayoutId: null,
        };

        if (input.endsAt) {
          data.endsAt = input.endsAt;
        }

        if (Object.prototype.hasOwnProperty.call(input, "defaultLocale")) {
          data.defaultLocale = input.defaultLocale ?? null;
        }

        if (Object.prototype.hasOwnProperty.call(input, "content")) {
          data.body = input.content ?? Prisma.DbNull;
        }

        if (input.locationMode !== undefined) {
          data.locationMode = input.locationMode;
        }
        if (input.locationRadiusMeters !== undefined) {
          data.locationRadiusMeters = input.locationRadiusMeters;
        }
        if (input.locationLabel !== undefined) {
          data.locationLabel = input.locationLabel;
        }
        if (Object.prototype.hasOwnProperty.call(input, "addressRevealAt")) {
          data.addressRevealAt = input.addressRevealAt ?? null;
        }
        if (
          Object.prototype.hasOwnProperty.call(input, "addressRevealPreset")
        ) {
          data.addressRevealPreset = input.addressRevealPreset ?? null;
        }

        if (
          Object.prototype.hasOwnProperty.call(input, "timezone") &&
          input.timezone
        ) {
          data.timezone = input.timezone;
        }

        // Only touch heroImageId when the caller explicitly provided one
        // (string or null). Upstream code passes the property through with
        // `value: params.heroImageId` even when params is undefined, so a
        // bare hasOwnProperty check would clobber the existing image on
        // every unrelated save (e.g. editing a ticket type).
        if (
          Object.prototype.hasOwnProperty.call(input, "heroImageId") &&
          input.heroImageId !== undefined
        ) {
          data.heroImageId = input.heroImageId;
        }
        if (
          Object.prototype.hasOwnProperty.call(
            input,
            "resalePayoutReleaseDaysOverride",
          )
        ) {
          data.resalePayoutReleaseDaysOverride =
            input.resalePayoutReleaseDaysOverride ?? null;
        }

        if (input.instructionalAdmission !== undefined) {
          data.instructionalAdmission = input.instructionalAdmission;
        }

        // Venue-hierarchy placement (FR-005/FR-011). Patch semantics: absent =
        // untouched, explicit null = clear. Unlike placeId above these are NOT
        // reset-then-rebuilt from `location` — the core decides (inside its tx)
        // whether a place change invalidates the stored placement.
        if (input.calendarId !== undefined) {
          data.calendarId = input.calendarId;
        }
        if (input.spaceId !== undefined) {
          data.spaceId = input.spaceId;
        }

        if (location.kind === "place") {
          data.placeId = location.placeId;
          if (input.placeLayoutId !== undefined) {
            data.placeLayoutId = input.placeLayoutId;
          }
          // Copy the place's location onto the event so public pages and
          // previews can render without a separate place lookup — under the
          // withheld-venue contract (see `applyPlaceLocationToEventData`).
          await lockPlaceLocations(p, location.placeId, "shared");
          const place = await p.place.findUnique({
            where: { id: location.placeId },
            select: PLACE_LOCATION_SELECT,
          });
          if (place) {
            await applyPlaceLocationToEventData(p, data, location.placeId, place, {
              kind: "update",
              eventId: input.eventId,
              input,
            });
          }
        } else if (location.kind === "saved-location") {
          data.savedLocationId = location.savedLocationId;
        } else if (location.kind === "freeform") {
          data.addressText = location.addressText;
          data.lat = location.lat;
          data.lng = location.lng;
          data.geohash6 = encodeGeohash(location.lat, location.lng, 6);
          if (location.locality) data.locality = location.locality;
          if (location.region) data.region = location.region;
          if (location.countryCode) data.countryCode = location.countryCode;
          if (location.postalCode) data.postalCode = location.postalCode;
        }

        const updated = await p.event.update({
          where: { id: input.eventId },
          data,
          select: EVENT_SELECT,
        });

        return mapEvent(updated);
      }

      // Resolve default payout terms from the owning org or human.
      // These FKs live directly on Organization / Human now.
      let defaultPrimaryId: string | null = null;
      let defaultResaleId: string | null = null;

      if (input.orgId) {
        const org = await p.organization.findUnique({
          where: { id: input.orgId },
          select: {
            defaultPrimaryPayoutTermsId: true,
            defaultResalePayoutTermsId: true,
          },
        });
        defaultPrimaryId = org?.defaultPrimaryPayoutTermsId ?? null;
        defaultResaleId = org?.defaultResalePayoutTermsId ?? null;
      } else if (input.humanId) {
        const human = await p.human.findUnique({
          where: { id: input.humanId },
          select: {
            defaultPrimaryPayoutTermsId: true,
            defaultResalePayoutTermsId: true,
          },
        });
        defaultPrimaryId = human?.defaultPrimaryPayoutTermsId ?? null;
        defaultResaleId = human?.defaultResalePayoutTermsId ?? null;
      }

      const data: any = {
        orgId: input.orgId,
        humanId: input.humanId,
        title: input.title,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        status: input.status,
        createdAt: input.createdAt ?? new Date(),
        body: input.content ?? null,
        placeId: null,
        savedLocationId: null,
        addressText: null,
        lat: null,
        lng: null,
        geohash6: null,
        locality: null,
        region: null,
        countryCode: null,
        postalCode: null,
        payoutTermsId: defaultPrimaryId,
        resalePayoutTermsId: defaultResaleId,
        locationMode: input.locationMode ?? "EXACT",
        // `=== undefined`, NOT `?? 500`: an explicit NULL is the FULLY-HIDDEN
        // sentinel. `?? 500` turned a new fully-hidden event into a public
        // 500 m circle until its second save.
        locationRadiusMeters:
          input.locationRadiusMeters === undefined
            ? 500
            : input.locationRadiusMeters,
        locationLabel: input.locationLabel ?? null,
        addressRevealAt: input.addressRevealAt ?? null,
        addressRevealPreset: input.addressRevealPreset ?? null,
        resalePayoutReleaseDaysOverride:
          input.resalePayoutReleaseDaysOverride ?? null,
        instructionalAdmission: input.instructionalAdmission ?? false,
        // Venue-hierarchy placement (FR-005/FR-011) — null on a plain create.
        calendarId: input.calendarId ?? null,
        spaceId: input.spaceId ?? null,
      };

      if (input.timezone) {
        data.timezone = input.timezone;
      }

      // See note at the create-side hero check above.
      if (
        Object.prototype.hasOwnProperty.call(input, "heroImageId") &&
        input.heroImageId !== undefined
      ) {
        data.heroImageId = input.heroImageId;
      }

      if (Object.prototype.hasOwnProperty.call(input, "defaultLocale")) {
        data.defaultLocale = input.defaultLocale ?? null;
      }

      if (location.kind === "place") {
        data.placeId = location.placeId;
        if (input.placeLayoutId !== undefined) {
          data.placeLayoutId = input.placeLayoutId;
        }
        // Copy the place's location onto the event so public pages and
        // previews can render without a separate place lookup — under the
        // withheld-venue contract (see `applyPlaceLocationToEventData`).
        await lockPlaceLocations(p, location.placeId, "shared");
        const place = await p.place.findUnique({
          where: { id: location.placeId },
          select: {
            ...PLACE_LOCATION_SELECT,
            defaultPrimaryPayoutTermsId: true,
            defaultResalePayoutTermsId: true,
          },
        });
        if (place) {
          await applyPlaceLocationToEventData(p, data, location.placeId, place, {
            kind: "create",
            input,
          });
        }

        // Place-level defaults override org/human defaults (cascade: place > org/human).
        if (place?.defaultPrimaryPayoutTermsId) {
          data.payoutTermsId = place.defaultPrimaryPayoutTermsId;
        }
        if (place?.defaultResalePayoutTermsId) {
          data.resalePayoutTermsId = place.defaultResalePayoutTermsId;
        }
      } else if (location.kind === "saved-location") {
        data.savedLocationId = location.savedLocationId;
      } else if (location.kind === "freeform") {
        data.addressText = location.addressText;
        data.lat = location.lat;
        data.lng = location.lng;
        data.geohash6 = encodeGeohash(location.lat, location.lng, 6);
        if (location.locality) data.locality = location.locality;
        if (location.region) data.region = location.region;
        if (location.countryCode) data.countryCode = location.countryCode;
        if (location.postalCode) data.postalCode = location.postalCode;
      }

      // Snapshot the resolved org/place/human default PayoutTerms rows into
      // event-owned clones, so subsequent mutations on the org's default (e.g.
      // payout schedule changes, fee mode updates, line edits) never
      // retroactively change the economics for this event. The clones are
      // `isDefault: false` event-owned rows. Every confirmation on them starts
      // PENDING (`resetConfirmations`): a default is a template, so an answer
      // recorded on it (CONFIRMED, COUNTERED or DECLINED) was never an answer
      // to this event's deal. The payee answers on the event's own terms.
      if (data.payoutTermsId) {
        const clonedPrimary = await clonePayoutTermsRow(p, {
          sourcePayoutTermsId: data.payoutTermsId as string,
          isDefault: false,
          // Snapshot of a default: a new event never inherits ABSORB.
          resetFeeMode: true,
          resetConfirmations: true,
        });
        if (clonedPrimary) {
          data.payoutTermsId = clonedPrimary.id;
        }
      }
      if (data.resalePayoutTermsId) {
        const clonedResale = await clonePayoutTermsRow(p, {
          sourcePayoutTermsId: data.resalePayoutTermsId as string,
          isDefault: false,
          resetFeeMode: true,
          resetConfirmations: true,
        });
        if (clonedResale) {
          data.resalePayoutTermsId = clonedResale.id;
        }
      }

      const created = await p.event.create({
        data,
        select: EVENT_SELECT,
      });

      return mapEvent(created);
    },
    lockLocationsAtPlace: async ({ placeId, mode }) => {
      await lockPlaceLocations(p, placeId, mode);
    },
    hasOwnedLiveEventsAtPlace: async ({ placeId, now }) => {
      // Served by @@index([placeId, endsAt]); stops at the first row.
      const row = await p.event.findFirst({
        where: {
          placeId,
          stewardship: "OWNED",
          status: "PUBLISHED",
          endsAt: { gt: now },
        },
        select: { id: true },
      });
      return row !== null;
    },
    countLiveCommunityListingsAtPlace: async ({ placeId, now }) => {
      // Served by @@index([placeId, endsAt]).
      return p.event.count({
        where: {
          placeId,
          stewardship: "COMMUNITY",
          status: "PUBLISHED",
          endsAt: { gt: now },
        },
      });
    },
    lockRows: async ({ ids, mode }) => {
      if (ids.length === 0) return;
      const sorted = [...new Set(ids)].sort();
      // Id order, so two lockers of overlapping sets queue instead of
      // deadlocking. `$queryRaw` (rows come back) with the lock strength as
      // a fixed fragment, never interpolated from input.
      if (mode === "update") {
        await p.$queryRaw`SELECT id FROM "Event" WHERE id = ANY(${sorted}::text[]) ORDER BY id FOR UPDATE`;
      } else {
        await p.$queryRaw`SELECT id FROM "Event" WHERE id = ANY(${sorted}::text[]) ORDER BY id FOR SHARE`;
      }
    },
    reprojectLocationForPlace: async ({
      placeId,
      projection,
      now,
      defaultReveal,
    }) => {
      if (projection.kind === "exact") {
        // RESTORE: the venue publishes its address again. Location columns
        // only — each event's own mode / radius / reveal schedule stay as they
        // are (see the port doc). ARCHIVED rows keep their projection.
        const c = projection.columns;
        const rows = await p.$queryRaw<Array<{ id: string }>>`
          UPDATE "Event" AS e SET
            "lat" = ${c.lat}::float8,
            "lng" = ${c.lng}::float8,
            "geohash6" = ${c.geohash6}::text,
            "addressText" = ${c.addressText}::text,
            "locality" = ${c.locality}::text,
            "region" = ${c.region}::text,
            "countryCode" = ${c.countryCode}::text,
            "postalCode" = ${c.postalCode}::text,
            "updatedAt" = ${now}::timestamp
          WHERE e."placeId" = ${placeId}
            AND e."status" <> 'ARCHIVED'::"EventStatus"
          RETURNING e."id"
        `;
        return rows.map((row) => row.id);
      }

      // WITHHELD: one statement, every status. The CASE below is
      // `applyPlaceLocationFloor` in SQL — the event's own requested privacy
      // is the row's CURRENT (locationMode, locationRadiusMeters):
      //   venue fully hidden            → NULL
      //   event EXACT                   → the venue's radius
      //   event OBSCURED + NULL (hidden)→ NULL (stricter than any circle)
      //   event OBSCURED + r            → max(r, venue radius)
      // Written inline in every SET (not via a CTE) so each expression reads
      // the row version this UPDATE actually locked. The parity with the TS
      // floor is pinned by `events-place-location.integration.test.ts`.
      //
      // Dates: the pg driver adapter binds a JS Date as a zone-less UTC
      // wall-clock string, so it is cast to `timestamp` for the timestamp(3)
      // columns and pinned to UTC for the one timestamptz column — correct
      // whatever the session TimeZone is.
      const venueRadius = projection.venueRadiusMeters;
      const flooredRadius = Prisma.sql`(CASE
          WHEN ${venueRadius}::int IS NULL THEN NULL
          WHEN e."locationMode" = 'EXACT'::"EventLocationMode" THEN ${venueRadius}::int
          WHEN e."locationRadiusMeters" IS NULL THEN NULL
          ELSE GREATEST(e."locationRadiusMeters", ${venueRadius}::int)
        END)`;
      // "Just withheld": EXACT until this statement and no schedule at all.
      // A NEVER event has a preset, so it is never matched.
      const justWithheld = Prisma.sql`(e."locationMode" = 'EXACT'::"EventLocationMode"
          AND e."address_reveal_preset" IS NULL
          AND e."address_reveal_at" IS NULL)`;
      const defaultRevealAt = Prisma.sql`(e."startsAt" - (${defaultReveal.leadMs}::bigint * interval '1 millisecond'))`;
      const centre = projection.publicCentre;

      const rows = await p.$queryRaw<Array<{ id: string }>>`
        UPDATE "Event" AS e SET
          "locationMode" = 'OBSCURED'::"EventLocationMode",
          "locationRadiusMeters" = ${flooredRadius},
          "lat" = CASE WHEN ${flooredRadius} IS NULL THEN NULL ELSE ${centre?.lat ?? null}::float8 END,
          "lng" = CASE WHEN ${flooredRadius} IS NULL THEN NULL ELSE ${centre?.lng ?? null}::float8 END,
          "geohash6" = CASE WHEN ${flooredRadius} IS NULL THEN NULL ELSE ${centre?.geohash6 ?? null}::text END,
          "geohash8" = NULL,
          "addressText" = ${projection.addressText}::text,
          "locality" = ${projection.locality}::text,
          "region" = ${projection.region}::text,
          "countryCode" = ${projection.countryCode}::text,
          "postalCode" = NULL,
          "address_reveal_preset" = CASE WHEN ${justWithheld}
            THEN ${defaultReveal.preset}::"AddressRevealPreset"
            ELSE e."address_reveal_preset" END,
          "address_reveal_at" = CASE WHEN ${justWithheld}
            THEN ${defaultRevealAt}
            ELSE e."address_reveal_at" END,
          "address_reveal_notified_at" = CASE
            WHEN ${justWithheld}
              AND e."address_reveal_notified_at" IS NULL
              AND ${defaultRevealAt} <= ${now}::timestamp
            THEN (${now}::timestamp AT TIME ZONE 'UTC')
            ELSE e."address_reveal_notified_at" END,
          "updatedAt" = ${now}::timestamp
        WHERE e."placeId" = ${placeId}
        RETURNING e."id"
      `;
      return rows.map((row) => row.id);
    },
    followPlaceAddress: async ({ placeId, columns: c, timezone, now }) => {
      // ADDRESS FOLLOW (owner ruling 2026-10-14). "Upcoming" per the port
      // doc: DRAFT/PUBLISHED and not ended. The EXISTS arm covers a
      // recurring listing whose startsAt/endsAt mirror has not been re-pinned
      // to its next night yet (the top-up job and date edits re-pin it; in
      // between, and when drained-and-pinned-to-now, `endsAt` can be past
      // while SCHEDULED dates are still ahead). Fixed fragment, no input.
      const upcoming = Prisma.sql`e."placeId" = ${placeId}
          AND e."status" IN ('DRAFT'::"EventStatus", 'PUBLISHED'::"EventStatus")
          AND (
            e."endsAt" > ${now}::timestamp
            OR EXISTS (
              SELECT 1 FROM "EventDate" d
               WHERE d."eventId" = e."id"
                 AND d."status" = 'SCHEDULED'::"EventDateStatus"
                 AND COALESCE(d."endsAt", d."startsAt") > ${now}::timestamp
            )
          )`;
      // Only events already in the place's (new) zone: moving the street
      // without the zone would show the right address at the wrong local
      // time. `= NULL` matches nothing, so an unknown zone writes nothing.
      const followed = await p.$queryRaw<Array<{ id: string }>>`
        UPDATE "Event" AS e SET
          "lat" = ${c.lat}::float8,
          "lng" = ${c.lng}::float8,
          "geohash6" = ${c.geohash6}::text,
          "geohash8" = NULL,
          "addressText" = ${c.addressText}::text,
          "locality" = ${c.locality}::text,
          "region" = ${c.region}::text,
          "countryCode" = ${c.countryCode}::text,
          "postalCode" = ${c.postalCode}::text,
          "updatedAt" = ${now}::timestamp
        WHERE ${upcoming}
          AND e."timezone" = ${timezone}::text
        RETURNING e."id"
      `;
      const skipped = await p.$queryRaw<Array<{ id: string }>>`
        SELECT e."id" FROM "Event" AS e
         WHERE ${upcoming}
           AND e."timezone" IS DISTINCT FROM ${timezone}::text
         ORDER BY e."id"
      `;
      return {
        followedIds: followed.map((row) => row.id),
        skippedIds: skipped.map((row) => row.id),
      };
    },
    createCommunityListing: async (input) => {
      // Ownerless RSVP+COMMUNITY row created as DRAFT or PUBLISHED (FR-005).
      // No payout terms / currency / tax stamping — this path never touches
      // the money pipeline. `publishedAt` is null for a DRAFT; the column is
      // nullable and the caller is the one that decides the pair.
      const data: Prisma.EventUncheckedCreateInput = {
        orgId: null,
        humanId: null,
        title: input.title,
        body: (input.content ?? undefined) as Prisma.InputJsonValue | undefined,
        status: input.status,
        attendanceMode: input.attendanceMode,
        stewardship: input.stewardship,
        // Explicit rather than schema defaults: FR-005 pins community
        // listings to PUBLIC visibility with no gate — a future default
        // change on the Event model must not silently alter this contract.
        visibility: "PUBLIC",
        gateType: "NONE",
        publishedAt: input.publishedAt,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        timezone: input.timezone,
        addressText: input.addressText,
        countryCode: input.countryCode,
        region: input.region ?? null,
        locality: input.locality ?? null,
        postalCode: input.postalCode ?? null,
        lat: input.lat,
        lng: input.lng,
        geohash6: input.geohash6,
        categoryId: input.categoryId ?? null,
        heroImageId: input.heroImageId ?? null,
        ageLimit: input.ageLimit ?? null,
        slug: input.slug,
        shortId: input.shortId,
        regionCode: input.regionCode ?? null,
        // The venue the listing is at, when staff picked one. Linking only:
        // no venue-confirmation column is written here (nobody grants
        // consent for an unowned place, staff included).
        placeId: input.placeId ?? null,
        // A listing linked to a place takes the place's privacy (EXACT).
        ...(input.locationPrivacy
          ? exactLocationPrivacyData(input.locationPrivacy)
          : {}),
      };

      // Recurrence JSON: only stamp when the caller provides a schedule. Null =
      // single-date listing (leave the column NULL). The expanded EventDate
      // rows are written separately by the use-case via the EventDatesRepo.
      if (input.recurrenceSchedule != null) {
        data.recurrenceSchedule =
          input.recurrenceSchedule as unknown as Prisma.InputJsonValue;
      }

      const created = await p.event.create({
        data,
        select: EVENT_SELECT,
      });

      return mapEvent(created);
    },
    applyCommunityEdit: async ({
      eventId,
      fields,
      geohash6,
      recurrenceSchedule,
      placeId,
      locationPrivacy,
    }) => {
      // Whitelisted community fields only (FR-007); the input type prevents
      // anything else from reaching this update.
      const data: Prisma.EventUncheckedUpdateInput = {};
      if (fields.title !== undefined) data.title = fields.title;
      if (fields.content !== undefined) {
        data.body =
          fields.content === null
            ? Prisma.DbNull
            : (fields.content as Prisma.InputJsonValue);
      }
      if (fields.startsAt !== undefined) data.startsAt = fields.startsAt;
      if (fields.endsAt !== undefined) data.endsAt = fields.endsAt;
      if (fields.timezone !== undefined) data.timezone = fields.timezone;
      if (fields.addressText !== undefined)
        data.addressText = fields.addressText;
      if (fields.countryCode !== undefined)
        data.countryCode = fields.countryCode;
      if (fields.region !== undefined) data.region = fields.region;
      if (fields.locality !== undefined) data.locality = fields.locality;
      if (fields.postalCode !== undefined) data.postalCode = fields.postalCode;
      if (fields.lat !== undefined) data.lat = fields.lat;
      if (fields.lng !== undefined) data.lng = fields.lng;
      if (fields.categoryId !== undefined) data.categoryId = fields.categoryId;
      if (fields.heroImageId !== undefined)
        data.heroImageId = fields.heroImageId;
      if (fields.ageLimit !== undefined) data.ageLimit = fields.ageLimit;
      // Place link (moderator direct edit only): undefined = untouched. The
      // link column only — no venue-confirmation column is written.
      if (placeId !== undefined) data.placeId = placeId;
      if (locationPrivacy !== undefined) {
        Object.assign(data, exactLocationPrivacyData(locationPrivacy));
      }

      // Recurrence schedule change (data-layer capability for a later slice's
      // edit-recompute wiring): undefined leaves it untouched, null clears it
      // (back to single-date), a value replaces the stored JSON.
      if (recurrenceSchedule !== undefined) {
        data.recurrenceSchedule =
          recurrenceSchedule === null
            ? Prisma.DbNull
            : (recurrenceSchedule as unknown as Prisma.InputJsonValue);
      }

      // Keep the spatial index in sync whenever the diff touches the pin:
      // prefer the caller-provided geohash; otherwise resolve the EFFECTIVE
      // lat/lng pair and re-derive (or null) geohash6 from it. Core schema
      // enforces lat/lng pairing in a diff, but if only one side reaches us
      // we defensively pre-read the row so a half-diff can never desync the
      // geohash from the stored coordinates.
      if (geohash6 !== undefined) {
        data.geohash6 = geohash6;
      } else if (fields.lat !== undefined || fields.lng !== undefined) {
        let effectiveLat = fields.lat;
        let effectiveLng = fields.lng;
        if (fields.lat === undefined || fields.lng === undefined) {
          const current = await p.event.findUniqueOrThrow({
            where: { id: eventId },
            select: { lat: true, lng: true },
          });
          effectiveLat = fields.lat === undefined ? current.lat : fields.lat;
          effectiveLng = fields.lng === undefined ? current.lng : fields.lng;
        }
        data.geohash6 =
          effectiveLat != null && effectiveLng != null
            ? encodeGeohash(effectiveLat, effectiveLng, 6)
            : null;
      }

      const updated = await p.event.update({
        where: { id: eventId },
        data,
        select: EVENT_SELECT,
      });

      return mapEvent(updated);
    },
    publishCommunityListingIfDraft: async ({ eventId, publishedAt }) => {
      // CAS: the status (and stewardship) guard lives in the WHERE, so a
      // concurrent publish that already won matches zero rows here. Postgres
      // re-evaluates the qualification on a row another transaction just
      // updated, so the loser blocks on the row lock and then sees count 0
      // rather than silently double-publishing. See the port doc.
      const { count } = await p.event.updateMany({
        where: { id: eventId, status: "DRAFT", stewardship: "COMMUNITY" },
        data: { status: "PUBLISHED", publishedAt },
      });
      if (count === 0) return null;

      // `updateMany` cannot return the row, so read it back inside the same
      // transaction the caller is running in.
      const updated = await p.event.findUniqueOrThrow({
        where: { id: eventId },
        select: EVENT_SELECT,
      });
      return mapEvent(updated);
    },
    listUnstampedUpcomingIdsAtTaxLocation: async ({ target, now, limit }) => {
      // Port doc: the tax resolver's precedence (Place → SavedLocation), so a
      // SavedLocation only owns events with no Place. `endsAt >= now` keeps
      // an event on sale until it ends (`isEventPast`).
      const rows = await p.event.findMany({
        where: {
          status: "PUBLISHED",
          admissionTaxRateBps: null,
          endsAt: { gte: now },
          ...(target.kind === "place"
            ? { placeId: target.placeId }
            : { placeId: null, savedLocationId: target.savedLocationId }),
        },
        orderBy: [{ endsAt: "asc" }, { id: "asc" }],
        take: limit,
        select: { id: true },
      });
      return rows.map((r) => r.id);
    },
    listRecurringEventIds: async ({ limit, cursor }) => {
      // Id-cursor pagination over PUBLISHED events that carry a recurrence
      // schedule. `recurrenceSchedule: { not: Prisma.DbNull }` selects rows
      // where the Json column is not SQL NULL. Order by id (stable) so the
      // cursor is monotonic; `id: { gt: cursor }` is an exclusive lower bound.
      const rows = await p.event.findMany({
        where: {
          status: "PUBLISHED",
          recurrenceSchedule: { not: Prisma.DbNull },
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: "asc" },
        take: limit,
        select: { id: true },
      });
      const ids = rows.map((r) => r.id);
      // A full page implies more may follow; a short page is the last one.
      const nextCursor = ids.length === limit ? ids[ids.length - 1] : undefined;
      return nextCursor ? { ids, nextCursor } : { ids };
    },
    listCommunityListingsForPlatform: async ({
      statuses,
      titleContains,
      cursor,
      limit,
      now,
    }) => {
      // Port doc: COMMUNITY rows only, newest first. Prisma's `cursor` reads
      // the cursor row's (createdAt, id) without the filter, so a row whose
      // status changed between pages still anchors the next one. One extra
      // row tells whether another page exists.
      const upcomingScheduled = {
        status: "SCHEDULED" as const,
        startsAt: { gte: now },
      };
      const rows = await p.event.findMany({
        where: {
          stewardship: "COMMUNITY",
          status: { in: statuses },
          ...(titleContains
            ? { title: { contains: titleContains, mode: "insensitive" as const } }
            : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        take: limit + 1,
        select: {
          id: true,
          title: true,
          status: true,
          slug: true,
          timezone: true,
          startsAt: true,
          endsAt: true,
          recurrenceSchedule: true,
          placeId: true,
          locality: true,
          publishedAt: true,
          createdAt: true,
          updatedAt: true,
          place: { select: { name: true, city: true } },
          dates: {
            where: upcomingScheduled,
            orderBy: { startsAt: "asc" },
            take: 1,
            select: { startsAt: true },
          },
          _count: { select: { dates: { where: upcomingScheduled } } },
        },
      });
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      return {
        items: page.map((row) => ({
          id: row.id,
          title: row.title,
          status: row.status,
          slug: row.slug,
          timezone: row.timezone,
          startsAt: row.startsAt,
          endsAt: row.endsAt,
          recurring: row.recurrenceSchedule !== null,
          placeId: row.placeId,
          placeName: row.place?.name ?? null,
          placeCity: row.place?.city ?? null,
          locality: row.locality,
          nextScheduledDateStartsAt: row.dates[0]?.startsAt ?? null,
          upcomingScheduledDateCount: row._count.dates,
          publishedAt: row.publishedAt,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })),
        nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      };
    },
    findObscuredEventsCrossingReveal: async ({
      windowStart,
      windowEnd,
      eventId,
    }) => {
      // Reveal-notification scan: PUBLISHED + OBSCURED events whose mandatory
      // addressRevealAt crossed inside (windowStart, windowEnd]. Scheduled
      // scans (no eventId) are gated by the un-stamped cursor
      // (addressRevealNotifiedAt IS NULL) so a notified event is never
      // re-picked. An EXPLICIT eventId bypasses the cursor gate — the ops
      // re-drive path for a partially-failed fan-out; the dispatcher's
      // durable notification-ledger subtraction confines that re-run to the
      // un-notified gap.
      const rows = await p.event.findMany({
        where: {
          status: "PUBLISHED",
          locationMode: "OBSCURED",
          addressRevealAt: { gt: windowStart, lte: windowEnd },
          ...(eventId ? { id: eventId } : { addressRevealNotifiedAt: null }),
        },
        orderBy: { addressRevealAt: "asc" },
        select: EVENT_SELECT,
      });
      return rows.map(mapEvent);
    },
    findObscuredPlaceEventsStartingIn: async ({
      startsAfter,
      startsAtOrBefore,
      eventId,
    }) => {
      // The reveal scan's START-keyed half (port doc). A plain candidate
      // read: no venue rule here — the dispatcher runs every row through the
      // holder gate, which decides "has the venue vouched, and is it time".
      // The venue floor is `max(startsAt, venueConfirmedStartsAt) − 24h`, so
      // EITHER anchor landing in the window makes a candidate: an event its
      // organizer moved earlier than the date the venue confirmed unlocks
      // off the confirmed date, which a `startsAt`-only read never sees.
      const startWindow = { gt: startsAfter, lte: startsAtOrBefore };
      const rows = await p.event.findMany({
        where: {
          status: "PUBLISHED",
          locationMode: "OBSCURED",
          placeId: { not: null },
          OR: [
            { startsAt: startWindow },
            { venueConfirmedStartsAt: startWindow },
          ],
          // Same cursor gate as findObscuredEventsCrossingReveal: a scheduled
          // scan never re-picks a notified event; an explicit id (the ops
          // re-drive path) bypasses it.
          ...(eventId ? { id: eventId } : { addressRevealNotifiedAt: null }),
        },
        orderBy: { startsAt: "asc" },
        select: EVENT_SELECT,
      });
      return rows.map(mapEvent);
    },
    markAddressRevealNotified: async (eventId, at) => {
      // Conditional stamp: only wins while the cursor is still unset, so
      // overlapping ticks can't both claim the event and an explicit re-drive
      // of an already-stamped event is a no-op. Returns whether we won.
      const updated = await p.event.updateMany({
        where: { id: eventId, addressRevealNotifiedAt: null },
        data: { addressRevealNotifiedAt: at },
      });
      return updated.count > 0;
    },
    // ── P3b (asks) ── V10: a booking's image never replaces an existing hero.
    setHeroImageIfEmpty: async ({ eventId, imageId }) => {
      const updated = await p.event.updateMany({
        where: { id: eventId, heroImageId: null },
        data: { heroImageId: imageId },
      });
      return updated.count > 0;
    },
    // holds-without-a-request FR-012: the shared note (note-columns.ts).
    async setNote(input) {
      return writeNote(
        {
          update: async (where, data) =>
            (
              await p.event.updateMany({
                where: { id: input.id, ...where },
                data,
              })
            ).count,
          read: () =>
            p.event.findUnique({
              where: { id: input.id },
              select: NOTE_SELECT,
            }),
        },
        input,
      );
    },
    createAttestation: async (input) => {
      const data: Prisma.EventAttestationUncheckedCreateInput = {
        eventId: input.eventId,
        attestedByHumanId: input.attestedByHumanId,
        attestedAt: input.attestedAt,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        policyVersion: input.policyVersion,
        policyTextSnapshot: input.policyTextSnapshot as Prisma.InputJsonValue,
        legalRightToHost: input.legalRightToHost,
        zoningAndNoiseCompliance: input.zoningAndNoiseCompliance,
        alcoholCompliance: input.alcoholCompliance,
        taxResponsibility: input.taxResponsibility,
        organizerFaqReviewed: input.organizerFaqReviewed,
      };

      if (input.metadata != null) {
        data.metadata = input.metadata as Prisma.InputJsonValue;
      }

      const created = await p.eventAttestation.create({
        data,
        select: EVENT_ATTESTATION_SELECT,
      });

      return mapEventAttestation(created);
    },
    publish: async ({
      eventId,
      publishedAt,
      currentAttestationId,
      currency,
      admissionTaxRateBps,
      taxRateSource,
    }) => {
      const data: Prisma.EventUncheckedUpdateInput = {
        status: "PUBLISHED",
        publishedAt,
      };
      if (currency) {
        data.currency = currency;
      }
      if (currentAttestationId !== undefined) {
        data.currentAttestationId = currentAttestationId;
      }
      if (admissionTaxRateBps !== undefined) {
        data.admissionTaxRateBps = admissionTaxRateBps;
      }
      if (taxRateSource !== undefined) {
        data.taxRateSource = taxRateSource;
      }
      const updated = await p.event.update({
        where: { id: eventId },
        data,
        select: EVENT_SELECT,
      });

      return mapEvent(updated);
    },
    unpublish: async ({ eventId }) => {
      const updated = await p.event.update({
        where: { id: eventId },
        // Keep `publishedAt` — it's a historical timestamp, not a lifecycle
        // flag. Status flipping back to DRAFT is what hides the event from
        // public surfaces; preserving publishedAt lets us re-publish later
        // without re-stamping the original go-live time.
        data: {
          status: "DRAFT",
          currentAttestationId: null,
        },
        select: EVENT_SELECT,
      });
      return mapEvent(updated);
    },
    cancel: async ({ eventId }) => {
      // Record the status the row had when it was cancelled (port contract):
      // copied in SQL from the row itself, so no caller can pass a stale one
      // or forget it. Prisma cannot set a column from another column, hence
      // the extra statement; the one caller (`cancelEvent`) runs both inside
      // its `repos.tx` under the event row lock, so they commit together. A
      // row already CANCELLED keeps the status it was cancelled from.
      await p.$executeRaw`
        UPDATE "Event"
        SET "cancelledFromStatus" = "status"
        WHERE "id" = ${eventId} AND "status" <> 'CANCELLED'::"EventStatus"
      `;
      const updated = await p.event.update({
        where: { id: eventId },
        data: {
          status: "CANCELLED",
        },
        select: EVENT_SELECT,
      });

      return mapEvent(updated);
    },
    complete: async ({ eventId }) => {
      const updated = await p.event.update({
        where: { id: eventId },
        data: {
          status: "COMPLETED",
        },
        select: EVENT_SELECT,
      });

      return mapEvent(updated);
    },
    archive: async ({ eventId }) => {
      const updated = await p.event.update({
        where: { id: eventId },
        data: {
          status: "ARCHIVED",
        },
        select: EVENT_SELECT,
      });

      return mapEvent(updated);
    },
    delete: async ({ eventId }) => {
      try {
        const result = await p.event.deleteMany({
          where: {
            id: eventId,
            status: "DRAFT",
            publishedAt: null,
            currentAttestationId: null,
            attestations: { none: {} },
          },
        });

        return result.count === 1;
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2003"
        ) {
          return false;
        }

        throw error;
      }
    },
    setCategory: async ({ eventId, categoryId }) => {
      const updated = await p.event.update({
        where: { id: eventId },
        data: { categoryId },
        select: EVENT_SELECT,
      });

      return mapEvent(updated);
    },
    setWaiverTemplate: async ({ eventId, waiverTemplateId }) => {
      const updated = await p.event.update({
        where: { id: eventId },
        data: { waiverTemplateId },
        select: EVENT_SELECT,
      });

      return mapEvent(updated);
    },
    setListingPriority: async ({ eventId, priority }) => {
      const updated = await p.event.update({
        where: { id: eventId },
        data: { listingPriority: priority },
        select: EVENT_SELECT,
      });

      return mapEvent(updated);
    },
    countIndexableByCategory: async ({ categorySlug, startsAfter }) =>
      // The rule is shared with the category sitemap
      // (`listActiveWithUpcomingEvents`): change it in
      // `indexableListedEventWhere`, never here.
      p.event.count({
        where: {
          ...(await indexableListedEventWhere(p, { startsAfter })),
          category: { slug: categorySlug, active: true },
        },
      }),
    filterByCategory: async ({ categorySlug, limit, offset, startsAfter }) => {
      const { limit: sanitizedLimit, offset: sanitizedOffset } =
        sanitizeOffsetPagination({
          limit,
          offset,
          defaultLimit: 20,
          maxLimit: 100,
        });

      const where: Prisma.EventWhereInput = {
        // Public listing (discover, featured, category pages), gated events
        // included. Change the rule in `publicListedEventWhere`, never here:
        // the indexability rule (`indexableListedEventWhere`) builds on it.
        ...(await publicListedEventWhere(p, { startsAfter })),
        ...(categorySlug
          ? {
              category: {
                slug: categorySlug,
                active: true,
              },
            }
          : {}),
      };

      const [total, events] = await Promise.all([
        p.event.count({ where }),
        p.event.findMany({
          where,
          orderBy: { startsAt: "asc" },
          select: EVENT_SELECT,
          skip: sanitizedOffset,
          take: sanitizedLimit,
        }),
      ]);

      return {
        items: events.map(mapEvent),
        pageInfo: buildOffsetPageInfo({
          total,
          limit: sanitizedLimit,
          offset: sanitizedOffset,
          count: events.length,
        }),
      };
    },
    listPublishedByPlace: async ({
      placeId,
      from,
      to,
      status,
      limit,
      offset,
      venueConfirmedFor,
      includeDateOccurrences,
      stewardship,
      excludeVenueConfirmationWithdrawn,
      statuses,
      excludeBannedOwners,
      cancelledWhilePublished,
      dateOccurrenceStatuses,
      matchDateOccurrencesOnly,
      withheldOwners,
    }) => {
      // Programming errors, before any query: each flag below only narrows
      // inside its prerequisite, and without it would silently do nothing
      // (date-arm-only would fall back to the WIDER pinned window).
      if (matchDateOccurrencesOnly && !includeDateOccurrences) {
        throw new Error(
          "listPublishedByPlace: matchDateOccurrencesOnly requires includeDateOccurrences",
        );
      }
      if (withheldOwners && !excludeBannedOwners) {
        throw new Error(
          "listPublishedByPlace: withheldOwners requires excludeBannedOwners",
        );
      }
      const { limit: sanitizedLimit, offset: sanitizedOffset } =
        sanitizeOffsetPagination({
          limit,
          offset,
          defaultLimit: 20,
          maxLimit: 100,
        });

      const confirmed = venueConfirmedFragment({ placeId }, venueConfirmedFor);
      // Public venue reads opt into the banned-owner filter (banned-owner.ts);
      // null (no filter at all) when they don't, or when nothing is withheld.
      // A caller with several reads per request passes the set it resolved.
      const notWithheld = excludeBannedOwners
        ? eventOwnerNotWithheldWhere(
            withheldOwners ?? (await resolveWithheldOwners(p)),
          )
        : null;
      const where: Prisma.EventWhereInput = {
        // Omitted `statuses` renders the literal equality, not `IN ($1)`, so
        // an existing caller's SQL does not move (port doc, R10).
        status:
          statuses && statuses.length > 0 ? { in: [...statuses] } : "PUBLISHED",
        visibility: "PUBLIC",
        placeId,
        // Both optional and both spread-absent when omitted, so an existing
        // caller's WHERE stays byte-identical. They sit HERE, in the object
        // the `take` below truncates, rather than being applied to the page
        // afterwards — a post-filter would make `limit` a budget of ROWS AT
        // THE PLACE instead of rows the caller asked for. Mirrors
        // `countCommunityListingsAtPlace`, which pairs the same two.
        ...(stewardship ? { stewardship } : {}),
        ...(excludeVenueConfirmationWithdrawn
          ? { venueConfirmationWithdrawnAt: null }
          : {}),
        // FR-003 (event-calendar-redesign): a recurring listing pins
        // `Event.startsAt` to its first upcoming date, so a plain startsAt
        // window misses every later night. When the caller opts in, an event
        // ALSO matches on a SCHEDULED EventDate inside the window (the same
        // clause listPublishedOccurrencesByPlace uses). Opt-in keeps every
        // existing caller's rows identical.
        //
        // ORDERING CAVEAT (known, this phase): the OR-arm only widens the
        // MATCH; `orderBy` / `skip` / `take` still run on `Event.startsAt`.
        // A listing admitted for a night deep in the window sorts by its
        // pinned instant — which may sit BEFORE `from` when the pin is stale
        // — so it can fill page 1 ahead of genuinely upcoming single events,
        // and `total` counts it as one event however many nights it has.
        // Pagination is therefore event-shaped, not chip-shaped; the caller
        // (get-venue-calendar) documents the same on `pageInfo.hasMore`.
        // Sorting on the admitting night needs a subquery / raw ORDER BY and
        // is deferred until the venue page actually pages.
        ...(includeDateOccurrences
          ? {
              OR: [
                // Date-arm-only reads (calendar feeds) drop the pin arm.
                ...(matchDateOccurrencesOnly
                  ? []
                  : [{ startsAt: { gte: from, lte: to } }]),
                {
                  dates: {
                    some: {
                      // Omitted renders the literal, so existing SQL is unchanged.
                      status:
                        dateOccurrenceStatuses &&
                        dateOccurrenceStatuses.length > 0
                          ? { in: [...dateOccurrenceStatuses] }
                          : "SCHEDULED",
                      startsAt: { gte: from, lte: to },
                    },
                  },
                },
              ],
            }
          : {
              startsAt: {
                gte: from,
                lte: to,
              },
            }),
        // Served by @@index([placeId, venueConfirmedAt]) on Event.
        // Public venue reads opt into the banned-owner filter; stats and
        // admin reads do not (banned-owner.ts).
        // `cancelledWhilePublished` is spread-absent when omitted (the
        // calendar feeds' cancelled read only), so other callers' SQL holds.
        ...(confirmed.length > 0 || notWithheld || cancelledWhilePublished
          ? {
              AND: [
                ...confirmed,
                ...(notWithheld ? [notWithheld] : []),
                ...(cancelledWhilePublished
                  ? [CANCELLED_WHILE_PUBLISHED_WHERE]
                  : []),
              ],
            }
          : {}),
      };

      const orderBy: Prisma.EventOrderByWithRelationInput[] =
        status === "past"
          ? [{ startsAt: "desc" }, { createdAt: "desc" }]
          : [{ startsAt: "asc" }, { createdAt: "asc" }];

      const [total, events] = await Promise.all([
        p.event.count({ where }),
        p.event.findMany({
          where,
          orderBy,
          select: EVENT_SELECT,
          skip: sanitizedOffset,
          take: sanitizedLimit,
        }),
      ]);

      return {
        items: events.map(mapEvent),
        pageInfo: buildOffsetPageInfo({
          total,
          limit: sanitizedLimit,
          offset: sanitizedOffset,
          count: events.length,
        }),
      };
    },
    listPublishedOccurrencesByPlace: async ({
      placeId,
      from,
      to,
      limit,
      spaceIds,
      venueConfirmedFor,
    }) => {
      const take = Math.min(Math.max(limit ?? 200, 1), 500);

      // Space narrowing (venue-hierarchy FR-005). Lives under `AND` rather
      // than merging into the window `OR` below — two ORs at one level would
      // collapse into "in range OR in a space", which is not the question.
      //
      // `spaceId: null` is ALWAYS kept: an event that names no space has
      // unknown placement, and dropping it would report a taken room as free.
      // `spaceIds: []` (a calendar with no spaces joined) is deliberately NOT
      // the same as omitting the key — `in: []` matches nothing, so only the
      // null-space occurrences survive.
      const spaceFilter: Prisma.EventWhereInput[] = [
        ...(spaceIds === undefined
          ? []
          : [{ OR: [{ spaceId: { in: spaceIds } }, { spaceId: null }] }]),
        // Confirmed-only occupancy (venue-confirmation spec): an unconfirmed
        // third-party event counts for neither availability nor conflicts.
        // Same `AND`-level placement as the space filter, for the same reason.
        ...venueConfirmedFragment({ placeId }, venueConfirmedFor),
      ];

      // The event-level filter is an OR, not a `startsAt` window. A recurring
      // listing pins `Event.startsAt` to its first upcoming date, so a
      // residency running every Tuesday for six months has ONE startsAt that
      // sits outside any window more than a week out — filtering on it would
      // drop the event before its occurrences were ever considered.
      const events = await p.event.findMany({
        where: {
          status: "PUBLISHED",
          visibility: "PUBLIC",
          placeId,
          OR: [
            { startsAt: { gte: from, lte: to } },
            {
              dates: {
                some: {
                  status: "SCHEDULED",
                  startsAt: { gte: from, lte: to },
                },
              },
            },
          ],
          // Served by @@index([spaceId, startsAt]) on Event.
          ...(spaceFilter.length > 0 ? { AND: spaceFilter } : {}),
        },
        select: {
          id: true,
          title: true,
          startsAt: true,
          endsAt: true,
          spaceId: true,
          // Bounded by the same window as the parent filter, so a listing with
          // a two-year expansion still costs only the rows in range.
          dates: {
            where: { status: "SCHEDULED", startsAt: { gte: from, lte: to } },
            select: { id: true, startsAt: true, endsAt: true },
            orderBy: { startsAt: "asc" },
            take,
          },
        },
        orderBy: { startsAt: "asc" },
        take,
      });

      const occurrences: PlaceOccurrenceRecord[] = [];
      for (const event of events) {
        if (event.dates.length > 0) {
          // Expanded rows are authoritative for this event. `Event.startsAt`
          // mirrors one of them, so emitting it too would report the same
          // night twice — once as a real row and once as a phantom.
          for (const date of event.dates) {
            occurrences.push({
              eventId: event.id,
              eventDateId: date.id,
              title: event.title,
              startsAt: date.startsAt,
              endsAt: date.endsAt,
              // Placement is a property of the EVENT, not the night — an
              // EventDate has no space of its own.
              spaceId: event.spaceId,
            });
          }
          continue;
        }
        // No rows in range. Either a single-date event (the common case — it
        // has no rows at all) or a recurring listing whose expansion does not
        // cover this window; both are correctly represented by the pinned
        // instant, and only when it actually lands in range.
        if (event.startsAt >= from && event.startsAt <= to) {
          occurrences.push({
            eventId: event.id,
            eventDateId: null,
            title: event.title,
            startsAt: event.startsAt,
            endsAt: event.endsAt,
            spaceId: event.spaceId,
          });
        }
      }

      // Re-sorted because the per-event flatten interleaves occurrence sets:
      // event ordering is by pinned `startsAt`, which says nothing about where
      // a given expanded date falls relative to another event's.
      occurrences.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
      return occurrences.slice(0, take);
    },
    listPublishedByPlaceIds: async ({
      placeIds,
      from,
      to,
      status,
      limit,
      venueConfirmedFor,
    }) => {
      // Batched mirror of listPublishedByPlace: identical PUBLISHED + PUBLIC +
      // startsAt-window filter and ordering, fanned across many places in one
      // query so callers never N+1 the single-place lister.
      const uniquePlaceIds = Array.from(
        new Set(placeIds.map((id) => id.trim()).filter(Boolean)),
      );
      if (uniquePlaceIds.length === 0) return [];

      // Same clamp shape as listPublishedByPlace (defaultLimit 20 / maxLimit
      // 100 there); this path fans in across many venues, so it carries the
      // higher 200 ceiling the embed calendar already budgets for.
      const take = Math.min(Math.max(limit ?? 50, 1), 200);

      const confirmed = venueConfirmedFragment(
        { placeIds: uniquePlaceIds },
        venueConfirmedFor,
      );
      const where: Prisma.EventWhereInput = {
        status: "PUBLISHED",
        visibility: "PUBLIC",
        placeId: { in: uniquePlaceIds },
        startsAt: {
          gte: from,
          lte: to,
        },
        ...(confirmed.length > 0 ? { AND: confirmed } : {}),
      };

      const orderBy: Prisma.EventOrderByWithRelationInput[] =
        status === "past"
          ? [{ startsAt: "desc" }, { createdAt: "desc" }]
          : [{ startsAt: "asc" }, { createdAt: "asc" }];

      const events = await p.event.findMany({
        where,
        orderBy,
        select: EVENT_SELECT,
        take,
      });

      return events.map(mapEvent);
    },
    listPublishedByOrg: async ({ orgId, from, to, status, limit, offset }) => {
      const { limit: sanitizedLimit, offset: sanitizedOffset } =
        sanitizeOffsetPagination({
          limit,
          offset,
          defaultLimit: 20,
          maxLimit: 100,
        });

      const where: Prisma.EventWhereInput = {
        status: "PUBLISHED",
        visibility: "PUBLIC",
        orgId,
        startsAt: {
          gte: from,
          lte: to,
        },
        // Only caller is the public org page (banned-owner.ts).
        ...(await notWithheldEventWhere(p)),
      };

      const orderBy: Prisma.EventOrderByWithRelationInput[] =
        status === "past"
          ? [{ startsAt: "desc" }, { createdAt: "desc" }]
          : [{ startsAt: "asc" }, { createdAt: "asc" }];

      const [total, events] = await Promise.all([
        p.event.count({ where }),
        p.event.findMany({
          where,
          orderBy,
          select: EVENT_SELECT,
          skip: sanitizedOffset,
          take: sanitizedLimit,
        }),
      ]);

      return {
        items: events.map(mapEvent),
        pageInfo: buildOffsetPageInfo({
          total,
          limit: sanitizedLimit,
          offset: sanitizedOffset,
          count: events.length,
        }),
      };
    },
    listAllByPlace: async ({
      placeId,
      from,
      to,
      statuses,
      includeDateOccurrences,
    }) => {
      const DEFAULT_STATUSES: EventStatus[] = [
        "DRAFT",
        "PUBLISHED",
        "COMPLETED",
        "CANCELLED",
      ];
      const statusFilter =
        statuses && statuses.length > 0 ? statuses : DEFAULT_STATUSES;

      // The pre-existing window is an OVERLAP test on the event's own span.
      // With `includeDateOccurrences` (FR-003, event-calendar-redesign) an
      // event ALSO matches when a SCHEDULED EventDate starts inside the
      // window — a recurring listing's `Event.startsAt` mirrors only its
      // first upcoming date, so the overlap test alone hides every later
      // night from the venue calendar. Opt-in: existing callers unchanged.
      const window: Prisma.EventWhereInput = includeDateOccurrences
        ? {
            OR: [
              { startsAt: { lte: to }, endsAt: { gte: from } },
              {
                dates: {
                  some: {
                    status: "SCHEDULED",
                    startsAt: { gte: from, lte: to },
                  },
                },
              },
            ],
          }
        : { startsAt: { lte: to }, endsAt: { gte: from } };

      const where: Prisma.EventWhereInput = {
        placeId,
        status: { in: statusFilter },
        ...window,
      };

      const events = await p.event.findMany({
        where,
        orderBy: [{ startsAt: "asc" }, { createdAt: "asc" }],
        select: EVENT_SELECT,
      });

      return events.map(mapEvent);
    },
    listByCalendar: async ({
      calendarId,
      from,
      to,
      publishedOnly,
      limit,
      venueConfirmedFor,
      includeDateOccurrences,
    }) => {
      // Filters on Event.calendarId DIRECTLY — never via the CalendarSpace
      // join (venue-hierarchy FR-005 space-bleed guard; see the port doc).
      //
      // The confirmed-only predicate binds the stamp to the calendar's PLACE
      // (a calendar belongs to exactly one place), resolved here so the
      // caller cannot hand us a mismatched placeId. An unknown calendar has
      // no events either way, so binding to an impossible id is exact.
      let confirmed: Prisma.EventWhereInput[] = [];
      if (venueConfirmedFor) {
        const calendar = await p.calendar.findUnique({
          where: { id: calendarId },
          select: { placeId: true },
        });
        confirmed = venueConfirmedFragment(
          { placeId: calendar?.placeId ?? "__no_such_place__" },
          venueConfirmedFor,
        );
      }
      const where: Prisma.EventWhereInput = {
        calendarId,
        // FR-003 (event-calendar-redesign): same opt-in OR-arm as
        // listPublishedByPlace — a recurring listing pins `Event.startsAt`
        // to its first upcoming night, so a plain window misses the rest.
        // Off = the pre-existing clause, byte-identical.
        //
        // ORDERING CAVEAT (same as listPublishedByPlace): the OR-arm only
        // widens the MATCH; `orderBy` / `take` still run on `Event.startsAt`.
        // A listing admitted for a night deep in the window sorts by its
        // pinned instant — which may sit BEFORE `from` when the pin is stale
        // — so it can consume the `take` budget ahead of genuinely upcoming
        // single events. Sorting on the admitting night needs a subquery /
        // raw ORDER BY and is deferred with the place read's.
        ...(includeDateOccurrences
          ? {
              OR: [
                { startsAt: { gte: from, lte: to } },
                {
                  dates: {
                    some: {
                      status: "SCHEDULED",
                      startsAt: { gte: from, lte: to },
                    },
                  },
                },
              ],
            }
          : { startsAt: { gte: from, lte: to } }),
        ...(confirmed.length > 0 ? { AND: confirmed } : {}),
        ...(publishedOnly
          ? // Public/embed pair: mirrors listPublishedByPlace (a published-
            // but-unlisted event must not leak onto a public calendar).
            { status: "PUBLISHED" as const, visibility: "PUBLIC" as const }
          : {
              status: {
                in: [
                  "DRAFT",
                  "PUBLISHED",
                  "COMPLETED",
                  "CANCELLED",
                ] satisfies EventStatus[],
              },
            }),
      };

      const events = await p.event.findMany({
        where,
        orderBy: [{ startsAt: "asc" }, { createdAt: "asc" }],
        select: EVENT_SELECT,
        // Port contract: provided limit → SQL take clamped to [1, 100]
        // (listPublishedByPlace's ceiling); omitted → no take (admin
        // overlay reads its whole bounded window).
        ...(limit !== undefined
          ? { take: Math.min(Math.max(Math.trunc(limit), 1), 100) }
          : {}),
      });

      return events.map(mapEvent);
    },
    setVenuePlacement: async ({ eventId, calendarId, spaceId, categoryId }) => {
      await p.event.update({
        where: { id: eventId },
        data: {
          calendarId,
          spaceId,
          // `undefined` = untouched (Prisma patch semantics) — categoryId is
          // only written when the caller applies a calendar default.
          ...(categoryId !== undefined ? { categoryId } : {}),
        },
      });
    },
    setVenueConfirmation: async ({
      eventId,
      placeId,
      confirmedByHumanId,
      bookingRequestId,
      at,
      expectedStartsAt,
    }) => {
      // Port contract: stamp the confirmation triple, BIND it to the place
      // the caller authorized against, and CLEAR any prior withdrawal —
      // re-confirming after a withdrawal is the normal path. CAS on
      // (id, placeId): an event moved since the authorization read, a foreign
      // eventId, or no such event matches zero rows → typed mismatch, nothing
      // written. `placeId` itself is never touched here.
      // R3-1: the venue's own confirm also pins the start it SAW, so a show
      // moved after its screen loaded is refused instead of vouched for.
      const expected = expectedStartsAt ?? null;
      const { count } = await p.event.updateMany({
        where: {
          id: eventId,
          placeId,
          ...(expected ? { startsAt: expected } : {}),
        },
        data: {
          venueConfirmedAt: at,
          venueConfirmedByHumanId: confirmedByHumanId,
          venueConfirmedPlaceId: placeId,
          venueConfirmationRequestId: bookingRequestId,
          venueConfirmationWithdrawnAt: null,
          venueConfirmationWithdrawnReason: null,
          // CAS-equal to the row's start when pinned; copied below otherwise.
          ...(expected ? { venueConfirmedStartsAt: expected } : {}),
        },
      });
      if (count === 0) {
        // Zero rows is a MOVED START (the row is at this place) or a CAS
        // miss on the place / id — the place-scoped read tells them apart.
        if (expected) {
          const atPlace = await p.event.findFirst({
            where: { id: eventId, placeId },
            select: { id: true },
          });
          if (atPlace) throw eventStartsAtMismatch();
        }
        throw eventPlaceMismatch();
      }
      // The date the venue vouched for (port contract, place-address-
      // withholding N1): the row's OWN `startsAt`, copied in SQL rather than
      // taken from the caller, so no stamp writer can pass a stale or wrong
      // date and none can forget it. Prisma cannot set a column from another
      // column, hence the second statement; every caller stamps inside its
      // `repos.tx`, where the two statements commit together. Same CAS.
      if (!expected) {
        await p.$executeRaw`
          UPDATE "Event"
          SET "venueConfirmedStartsAt" = "startsAt"
          WHERE "id" = ${eventId} AND "placeId" = ${placeId}
        `;
      }
      const row = await p.event.findUniqueOrThrow({
        where: { id: eventId },
        select: EVENT_SELECT,
      });
      return mapEvent(row);
    },
    withdrawVenueConfirmation: async ({ eventId, placeId, reason, at }) => {
      // Same CAS as setVenueConfirmation on (id, placeId). Idempotent (port
      // contract): only rows NOT already withdrawn with this exact reason are
      // written, so a retry keeps the original withdrawnAt and is a no-op
      // success. A different reason overwrites (the venue corrected itself).
      // venueConfirmedAt is history and stays; placeId is never touched — the
      // event drops to address-only, it does not detach.
      const { count } = await p.event.updateMany({
        where: {
          id: eventId,
          placeId,
          OR: [
            { venueConfirmationWithdrawnAt: null },
            { venueConfirmationWithdrawnReason: { not: reason } },
          ],
        },
        data: {
          venueConfirmationWithdrawnAt: at,
          venueConfirmationWithdrawnReason: reason,
          // A withdrawn stamp vouches for no date (port contract). A
          // re-confirm writes a fresh one.
          venueConfirmedStartsAt: null,
        },
      });
      // Zero rows is EITHER the idempotent no-op (row is at this place and
      // already withdrawn with this reason) OR a CAS miss — the place-scoped
      // read-back tells them apart: a row means no-op, none means mismatch.
      const row = await p.event.findFirst({
        where: { id: eventId, placeId },
        select: EVENT_SELECT,
      });
      if (!row) throw eventPlaceMismatch();
      if (count === 0 && row.venueConfirmationWithdrawnReason !== reason) {
        // Cannot happen (the OR above would have matched); guards a future
        // edit that loosens the WHERE without revisiting this branch.
        throw eventPlaceMismatch();
      }
      return mapEvent(row);
    },
    getStatsForPlace: async ({ placeId, now }) => {
      const baseWhere: Prisma.EventWhereInput = {
        placeId,
        status: { not: "ARCHIVED" },
      };

      const [total, upcoming, nextEvent] = await Promise.all([
        p.event.count({ where: baseWhere }),
        p.event.count({
          where: { ...baseWhere, startsAt: { gt: now } },
        }),
        p.event.findFirst({
          where: { ...baseWhere, startsAt: { gt: now } },
          orderBy: { startsAt: "asc" },
          select: { startsAt: true },
        }),
      ]);

      return {
        total,
        upcoming,
        past: total - upcoming,
        nextEventAt: nextEvent?.startsAt ?? null,
      };
    },
    countCommunityListingsAtPlace: async ({ placeId, now }) => {
      // NO venue-confirmation filter, deliberately — see the port doc. This is
      // the "what am I being asked to accept?" number, and every one of those
      // listings is unconfirmed by definition until the flag is flipped.
      //
      // BUT `venueConfirmationWithdrawnAt IS NULL` IS applied, and the two are
      // not in tension. Unconfirmed means "waiting on your answer"; WITHDRAWN
      // means "you already said no to this one", and FR-003 makes withdrawal
      // negate the community arm — so flipping the flag can never confirm a
      // withdrawn listing. Counting it would tell an owner "accept the 5
      // listings claiming your room", and they would flip it on and see none.
      //
      // THE "UPCOMING" FLOOR IS TWO CLAUSES, not one, because `Event.startsAt`
      // on a recurring listing is a PIN that can go stale (see the ordering
      // caveat on `listPublishedByPlace`'s `includeDateOccurrences`, and the
      // port doc on EventDate). A weekly open mic whose pin has fallen behind
      // but whose SCHEDULED nights run months out is still very much something
      // the venue is being asked to accept — and accepting it blocks every one
      // of those nights. Counting it zero would understate the exact thing the
      // spec's `blocking_is_intended` ruling is about. The `some` keeps this
      // one row per event: a residency counts once, not once per night.
      return await p.event.count({
        where: {
          placeId,
          stewardship: "COMMUNITY",
          status: "PUBLISHED",
          visibility: "PUBLIC",
          venueConfirmationWithdrawnAt: null,
          OR: [
            { startsAt: { gt: now } },
            { dates: { some: { status: "SCHEDULED", startsAt: { gt: now } } } },
          ],
        },
      });
    },
    getUpcomingStatsForOwners: async ({ owners, now }) => {
      const orgIds = owners
        .filter((o) => o.ownerType === "ORGANIZATION")
        .map((o) => o.ownerId);
      const humanIds = owners
        .filter((o) => o.ownerType === "HUMAN")
        .map((o) => o.ownerId);
      if (orgIds.length === 0 && humanIds.length === 0) return [];

      // PUBLISHED, TICKETED, starting after `now`. TICKETED is load-bearing:
      // an RSVP listing has no ticket types, no orders and no money path
      // (Event.attendanceMode doc), so it cannot recover a debt — counting
      // it would tell ops a payee has sales coming when nothing can be
      // netted. Two grouped queries (one per owner arm) instead of a
      // per-owner fan-out; the arms cannot overlap because an org-owned
      // event carries `humanId: null` (create-human-event is the only
      // writer of humanId).
      const upcomingWhere: Prisma.EventWhereInput = {
        status: "PUBLISHED",
        attendanceMode: "TICKETED",
        startsAt: { gt: now },
      };
      const [orgGroups, humanGroups] = await Promise.all([
        orgIds.length > 0
          ? p.event.groupBy({
              by: ["orgId"],
              where: { ...upcomingWhere, orgId: { in: orgIds } },
              _count: { _all: true },
              _min: { startsAt: true },
            })
          : [],
        humanIds.length > 0
          ? p.event.groupBy({
              by: ["humanId"],
              where: { ...upcomingWhere, humanId: { in: humanIds } },
              _count: { _all: true },
              _min: { startsAt: true },
            })
          : [],
      ]);

      const rows: OwnerUpcomingEventStats[] = [];
      for (const g of orgGroups) {
        if (!g.orgId || !g._min.startsAt) continue;
        rows.push({
          ownerType: "ORGANIZATION",
          ownerId: g.orgId,
          upcomingCount: g._count._all,
          nextEventAt: g._min.startsAt,
        });
      }
      for (const g of humanGroups) {
        if (!g.humanId || !g._min.startsAt) continue;
        rows.push({
          ownerType: "HUMAN",
          ownerId: g.humanId,
          upcomingCount: g._count._all,
          nextEventAt: g._min.startsAt,
        });
      }
      return rows;
    },
    listPublishedByRegion: async ({
      regionCode,
      limit,
      offset,
      startsAfter,
    }) => {
      const { limit: sanitizedLimit, offset: sanitizedOffset } =
        sanitizeOffsetPagination({
          limit,
          offset,
          defaultLimit: 20,
          maxLimit: 100,
        });

      const normalizedRegion = regionCode.trim().toLowerCase();
      if (!normalizedRegion) {
        return {
          items: [],
          pageInfo: buildOffsetPageInfo({
            total: 0,
            limit: sanitizedLimit,
            offset: sanitizedOffset,
            count: 0,
          }),
        };
      }

      const where: Prisma.EventWhereInput = {
        status: "PUBLISHED",
        // Public listing: a PRIVATE event is link-only and never listed.
        visibility: "PUBLIC",
        regionCode: normalizedRegion,
        ...(startsAfter ? { startsAt: { gte: startsAfter } } : {}),
        ...(await notWithheldEventWhere(p)),
      };

      const [total, events] = await Promise.all([
        p.event.count({ where }),
        p.event.findMany({
          where,
          orderBy: [{ startsAt: "asc" }, { createdAt: "asc" }],
          select: EVENT_SELECT,
          skip: sanitizedOffset,
          take: sanitizedLimit,
        }),
      ]);

      return {
        items: events.map(mapEvent),
        pageInfo: buildOffsetPageInfo({
          total,
          limit: sanitizedLimit,
          offset: sanitizedOffset,
          count: events.length,
        }),
      };
    },
    listPublishedByCountry: async ({
      countryCode,
      limit,
      offset,
      startsAfter,
      includeTotal = true,
    }) => {
      const { limit: sanitizedLimit, offset: sanitizedOffset } =
        sanitizeOffsetPagination({
          limit,
          offset,
          defaultLimit: 20,
          maxLimit: 100,
        });

      const normalizedCountry = countryCode.trim().toUpperCase();
      if (!normalizedCountry) {
        return {
          items: [],
          pageInfo: buildOffsetPageInfo({
            total: 0,
            limit: sanitizedLimit,
            offset: sanitizedOffset,
            count: 0,
          }),
        };
      }

      const where: Prisma.EventWhereInput = {
        status: "PUBLISHED",
        // Public listing: a PRIVATE event is link-only and never listed.
        visibility: "PUBLIC",
        countryCode: normalizedCountry,
        ...(startsAfter ? { startsAt: { gte: startsAfter } } : {}),
        ...(await notWithheldEventWhere(p)),
      };

      const page = p.event.findMany({
        where,
        orderBy: [{ startsAt: "asc" }, { createdAt: "asc" }],
        select: EVENT_SELECT,
        skip: sanitizedOffset,
        take: sanitizedLimit,
      });

      // `COUNT(*)` here is a second full pass over the same predicate, and the
      // caller that dominates this method (`events.countryEvents`) renders a
      // fixed band and reads neither `total` nor `hasNextPage`. When skipped,
      // `total` degrades to a lower bound so `buildOffsetPageInfo` reports
      // hasNextPage=false rather than inventing a page count — see the port's
      // `includeTotal` doc.
      const [total, events] = includeTotal
        ? await Promise.all([p.event.count({ where }), page])
        : await page.then(
            (rows) => [sanitizedOffset + rows.length, rows] as const,
          );

      return {
        items: events.map(mapEvent),
        pageInfo: buildOffsetPageInfo({
          total,
          limit: sanitizedLimit,
          offset: sanitizedOffset,
          count: events.length,
        }),
      };
    },
    searchPublished: async ({ query, limit = 12, startsAfter }) => {
      const normalizedQuery = query.trim();
      if (!normalizedQuery) {
        return [];
      }

      const sanitizedLimit = Math.min(Math.max(limit, 1), 50);

      const events = await p.event.findMany({
        where: {
          // Anonymous title search: published, PUBLIC (a PRIVATE event is
          // link-only) and UNGATED (a gate protects the event's details —
          // the gated preview carries title + hero only).
          status: "PUBLISHED",
          visibility: "PUBLIC",
          gateType: "NONE",
          title: {
            contains: normalizedQuery,
            mode: "insensitive",
          },
          ...(startsAfter ? { startsAt: { gte: startsAfter } } : {}),
          ...(await notWithheldEventWhere(p)),
        },
        orderBy: [{ startsAt: "asc" }, { createdAt: "asc" }],
        select: EVENT_SELECT,
        take: sanitizedLimit,
      });

      return events.map(mapEvent);
    },
    discoverActiveCities: async ({ startsAfter, countryCode, limit }) => {
      const sanitizedLimit = Math.min(Math.max(limit ?? 20, 1), 50);
      // Mirror listPublishedByCountry's normalization: uppercase exact match.
      const normalizedCountry = countryCode?.trim().toUpperCase();

      // Source of truth is the Event table, NOT the search index: event
      // SearchDocument rows never populate `city`/`isPublic`, so aggregating
      // there returns nothing. `visibility = 'PUBLIC'` is the airtight,
      // fail-closed gate — `status = 'PUBLISHED'` alone would leak the
      // existence of a PRIVATE event's city. `locality` is the city column.
      // GROUP BY gives DB-level distinct + COUNT; LIMIT applies to the grouped
      // result (not the underlying rows).
      //
      // THE CENTROID (place-address-withholding D2). Every public row still
      // COUNTS, but only rows whose PUBLIC location is exact are AVERAGED: the
      // event is EXACT and it is either placeless or at an EXACT place. A
      // town whose only upcoming public event is at a withheld house would
      // otherwise publish the house as its "city centre". A city with no
      // exact rows gets NULL coordinates — the caller (`CityMarquee`) already
      // renders a city without a geo link when either is null. Raw SQL
      // because Prisma's `groupBy` cannot FILTER an aggregate; the WHERE /
      // GROUP BY / ORDER BY / LIMIT are the previous `groupBy` call's,
      // clause for clause (`NOT locality = ''` on a non-null locality is
      // `locality <> ''`; the `_count.id desc, locality asc` order).
      const exactRow = Prisma.sql`(e."locationMode" = 'EXACT'::"EventLocationMode"
          AND (pl.id IS NULL OR pl.location_mode = 'EXACT'::"EventLocationMode"))`;
      const rows = await p.$queryRaw<
        Array<{
          locality: string | null;
          regionCode: string | null;
          countryCode: string | null;
          eventCount: number;
          lat: number | null;
          lng: number | null;
        }>
      >`
        SELECT
          e.locality AS "locality",
          e."regionCode" AS "regionCode",
          e."countryCode" AS "countryCode",
          COUNT(e.id)::int AS "eventCount",
          AVG(e.lat) FILTER (WHERE ${exactRow}) AS "lat",
          AVG(e.lng) FILTER (WHERE ${exactRow}) AS "lng"
        FROM "Event" e
        LEFT JOIN "Place" pl ON pl.id = e."placeId"
        WHERE e.status = 'PUBLISHED'::"EventStatus"
          AND e.visibility = 'PUBLIC'::"EventVisibility"
          AND e."startsAt" >= ${startsAfter}::timestamp
          AND e.locality IS NOT NULL
          AND e.locality <> ''
          AND ${eventOwnerNotWithheldSubquerySql("e")}
          ${
            normalizedCountry
              ? Prisma.sql`AND e."countryCode" = ${normalizedCountry}`
              : Prisma.empty
          }
        GROUP BY e.locality, e."regionCode", e."countryCode"
        ORDER BY COUNT(e.id) DESC, e.locality ASC
        LIMIT ${sanitizedLimit}
      `;

      return rows
        .filter((r): r is typeof r & { locality: string } => r.locality != null)
        .map((r) => ({
          city: r.locality,
          regionCode: r.regionCode ?? null,
          countryCode: r.countryCode ?? null,
          eventCount: Number(r.eventCount),
          lat: r.lat ?? null,
          lng: r.lng ?? null,
        }));
    },
    updateVisibility: async ({ eventId, visibility }) => {
      const updated = await p.event.update({
        where: { id: eventId },
        data: { visibility },
        select: EVENT_SELECT,
      });

      return mapEvent(updated);
    },
    updateGateType: async ({ eventId, gateType }) => {
      const updated = await p.event.update({
        where: { id: eventId },
        data: { gateType },
        select: EVENT_SELECT,
      });

      return mapEvent(updated);
    },
    updatePassword: async ({ eventId, passwordHash, passwordUpdatedAt }) => {
      const updated = await p.event.update({
        where: { id: eventId },
        data: {
          passwordHash,
          passwordUpdatedAt,
        },
        select: EVENT_SELECT,
      });

      return mapEvent(updated);
    },
    updateWaitlistSettings: async (input) => {
      const data: Prisma.EventUpdateInput = {
        waitlistStatus: input.status,
      };

      if (Object.prototype.hasOwnProperty.call(input, "publishAt")) {
        data.waitlistPublishAt = input.publishAt ?? null;
      }

      if (Object.prototype.hasOwnProperty.call(input, "description")) {
        data.waitlistDescription = input.description ?? null;
      }

      if (Object.prototype.hasOwnProperty.call(input, "cap")) {
        data.waitlistCap = input.cap ?? null;
      }

      const updated = await p.event.update({
        where: { id: input.eventId },
        data,
        select: EVENT_SELECT,
      });

      return mapEvent(updated);
    },
    getGateSettings: async (eventId: string) => {
      const record = await p.event.findUnique({
        where: { id: eventId },
        select: GATE_SETTINGS_SELECT,
      });

      if (!record) {
        return null;
      }

      return mapGateSettings(record);
    },
    assignSlug: async (input: AssignEventSlugInput) => {
      try {
        const updated = await p.event.update({
          where: { id: input.eventId },
          data: {
            slug: input.slug,
            shortId: input.shortId,
            regionCode: input.regionCode,
          },
          select: EVENT_SELECT,
        });

        return mapEvent(updated);
      } catch (error) {
        handleSlugConstraintError(error);
        throw error;
      }
    },
    updateSlug: async (input: UpdateEventSlugInput) => {
      try {
        const updated = await p.event.update({
          where: { id: input.eventId },
          data: {
            slug: input.slug,
            regionCode: input.regionCode,
          },
          select: EVENT_SELECT,
        });

        return mapEvent(updated);
      } catch (error) {
        handleSlugConstraintError(error);
        throw error;
      }
    },
    listSluggedPage: async (input) => {
      // Keyset on `id > afterId`, not Prisma `cursor` + `skip: 1`: the caller
      // rewrites slugs between pages, and a skip offset applied after the WHERE
      // can eat a row. Every status is included; old links exist for all.
      const rows = await p.event.findMany({
        where: {
          slug: { not: null },
          ...(input.afterId ? { id: { gt: input.afterId } } : {}),
        },
        orderBy: { id: "asc" },
        take: Math.max(1, input.limit),
        select: {
          id: true,
          slug: true,
          startsAt: true,
          timezone: true,
          status: true,
          createdAt: true,
        },
      });
      return rows.flatMap((row) =>
        row.slug
          ? [
              {
                id: row.id,
                slug: row.slug,
                startsAt: row.startsAt,
                timezone: row.timezone,
                status: row.status as EventStatus,
                createdAt: row.createdAt,
              },
            ]
          : [],
      );
    },
    getSlugDateRow: async (eventId) => {
      // Narrow select: see the port. Never widen it to EVENT_SELECT.
      const row = await p.event.findUnique({
        where: { id: eventId },
        select: {
          id: true,
          slug: true,
          startsAt: true,
          timezone: true,
          status: true,
          createdAt: true,
        },
      });
      if (!row?.slug) return null;
      return {
        id: row.id,
        slug: row.slug,
        startsAt: row.startsAt,
        timezone: row.timezone,
        status: row.status as EventStatus,
        createdAt: row.createdAt,
      };
    },
    setSlugOnly: async (input) => {
      // `select: { id }` keeps the UPDATE's RETURNING to one column: see the
      // port. `updatedAt` is set by Prisma's @updatedAt.
      try {
        await p.event.update({
          where: { id: input.eventId },
          data: { slug: input.slug },
          select: { id: true },
        });
      } catch (error) {
        handleSlugConstraintError(error);
        throw error;
      }
    },
    recordSlugHistory: async (input: RecordEventSlugHistoryInput) => {
      // `createMany({ skipDuplicates: true })` for a SINGLE row, deliberately:
      // `EventSlugHistory.slug` is GLOBALLY `@unique`, and an ordinary rename
      // flip-flop puts a slug back in play — create draft "A" (slug S_A),
      // rename to "B" + Regenerate (S_A → history), rename back to "A" +
      // Regenerate (`updateSlug` keeps the shortId, so `Event.slug` is S_A
      // again), then rename to "B" and publish → we try to file S_A a second
      // time. There is nothing to fix in that sequence: the row already says
      // exactly what we were about to say.
      //
      // Tolerating it here matters beyond tidiness. A statement that fails at
      // the database aborts the enclosing Postgres transaction, which then
      // answers COMMIT with ROLLBACK and no error — so a P2002 raised from
      // inside a caller's transaction can silently discard everything else
      // that transaction did. Not raising it at all is the sturdiest fix.
      //
      // NOT an upsert on `slug`: that column is unique ACROSS events, so an
      // upsert would repoint another event's history row at this one and break
      // its redirect. Skipping is the only correct conflict behaviour.
      try {
        await p.eventSlugHistory.createMany({
          data: [
            {
              eventId: input.eventId,
              slug: input.slug,
              recordedAt: input.recordedAt,
            },
          ],
          skipDuplicates: true,
        });
      } catch (error) {
        handleSlugConstraintError(error);
        throw error;
      }
    },
    resolveBySlug: async (
      slug: string,
    ): Promise<EventSlugResolution | null> => {
      const current = await p.event.findFirst({
        where: { slug },
        select: {
          id: true,
          slug: true,
        },
      });

      if (current?.slug) {
        return {
          eventId: current.id,
          currentSlug: current.slug,
          redirect: false,
        } satisfies EventSlugResolution;
      }

      const historical = await p.eventSlugHistory.findFirst({
        where: { slug },
        select: {
          eventId: true,
          event: {
            select: {
              slug: true,
            },
          },
        },
      });

      if (historical?.event?.slug) {
        return {
          eventId: historical.eventId,
          currentSlug: historical.event.slug,
          redirect: true,
        } satisfies EventSlugResolution;
      }

      // Accept a UUID as a stable fallback identifier so clients can link by
      // eventId when an event has no slug yet (otherwise the link would
      // silently route nowhere).
      if (UUID_RE.test(slug)) {
        const byId = await p.event.findUnique({
          where: { id: slug },
          select: { id: true, slug: true },
        });
        if (byId) {
          return {
            eventId: byId.id,
            currentSlug: byId.slug ?? byId.id,
            redirect: Boolean(byId.slug),
          } satisfies EventSlugResolution;
        }
      }

      return null;
    },
    resolveByShortId: async (
      shortId: string,
    ): Promise<Omit<EventSlugResolution, "redirect"> | null> => {
      const event = await p.event.findUnique({
        where: { shortId },
        select: { id: true, slug: true },
      });
      if (!event?.slug) return null;
      return { eventId: event.id, currentSlug: event.slug };
    },
    getSlugContext: async (eventId: string) => {
      const record = await p.event.findUnique({
        where: { id: eventId },
        select: SLUG_CONTEXT_SELECT,
      });

      if (!record) {
        return null;
      }

      return mapSlugContext(record);
    },
    listByOwner: async (input: ListEventsByOwnerInput) => {
      const {
        ownerType,
        ownerId,
        status,
        visibility,
        query,
        limit,
        offset,
        dateRange,
        includeDateOccurrences,
        dateOccurrenceStatuses,
        cancelledWhilePublished,
        startsAtOrder,
        matchDateOccurrencesOnly,
        includeRunning,
        excludeBannedOwners,
        withheldOwners,
        categoryIds,
        includeUncategorised,
      } = input;
      const { limit: sanitizedLimit, offset: sanitizedOffset } =
        sanitizeOffsetPagination({
          limit,
          offset,
          defaultLimit: 50,
          maxLimit: 200,
        });

      const trimmedQuery = query?.trim();
      // Inclusive bounds; either may be omitted for an open-ended range. Built
      // separately so a `dateRange` with NEITHER bound set emits no filter at
      // all rather than an empty `startsAt: {}` predicate.
      // `Event.startsAt` is NOT NULL in the schema, so a range filter here
      // cannot silently drop null-startsAt rows — there are none.
      const startsAtFilter: Prisma.DateTimeFilter = {
        ...(dateRange?.from ? { gte: dateRange.from } : {}),
        ...(dateRange?.to ? { lte: dateRange.to } : {}),
      };
      const hasStartsAtFilter = Object.keys(startsAtFilter).length > 0;

      // ── Category, including the "uncategorised" arm ──────────────────────
      //
      // `Event.categoryId` is NULLABLE and SQL `IN` never matches NULL, so
      // `categoryIds` alone can never reach an uncategorised event. The two
      // inputs therefore combine into ONE predicate:
      //
      //   ids only   → categoryId IN (…)
      //   flag only  → categoryId IS NULL      (only uncategorised, not "all")
      //   both       → categoryId IN (…) OR categoryId IS NULL
      //   neither    → no category filter at all
      //
      // The "both" arm is nested under `AND` rather than emitted as a
      // top-level `OR`: the text search above already owns the `where.OR` key,
      // and a sibling `OR` here would not AND with it — object spread would
      // simply overwrite one with the other, silently turning a narrowing
      // facet into a replacement for (or a widening of) the query. `AND` is
      // unused at this level, so it composes cleanly with every other
      // conjunct. The single-arm cases stay bare `categoryId` keys — wrapping
      // them in a pointless `OR` would change the emitted clause for filters
      // whose behaviour is unchanged.
      const hasCategoryIds = Boolean(categoryIds && categoryIds.length > 0);
      const categoryWhere: Prisma.EventWhereInput =
        hasCategoryIds && includeUncategorised
          ? {} // the "both" arm is an OR → lives in `andConjuncts` below
          : hasCategoryIds
            ? { categoryId: { in: categoryIds } }
            : includeUncategorised
              ? { categoryId: null }
              : {};

      // ── Date window, including the FR-003 EventDate arm ──────────────────
      //
      // With `includeDateOccurrences` (event-calendar-redesign FR-003) the
      // window ALSO admits an event whose SCHEDULED `EventDate` starts inside
      // it — a recurring listing's `Event.startsAt` mirrors only its first
      // upcoming night, so the pinned-instant filter alone hides every later
      // night from the owner's calendar. The widened window is an OR, and
      // (exactly like the category "both" arm) it cannot sit on the top-level
      // `OR` key the text search owns, so it goes into the `AND` list below.
      // OFF, or ON with no bound to widen, keeps the bare `startsAt` key so
      // existing callers' WHERE is byte-identical.
      const widenWindowToDates = includeDateOccurrences && hasStartsAtFilter;
      // Programming errors, before any query: each flag below only narrows
      // inside its prerequisite, and without it would silently do nothing
      // (date-arm-only would fall back to the WIDER pinned read).
      if (matchDateOccurrencesOnly && !widenWindowToDates) {
        throw new Error(
          "listByOwner: matchDateOccurrencesOnly requires includeDateOccurrences and a bounded dateRange",
        );
      }
      if (withheldOwners && !excludeBannedOwners) {
        throw new Error(
          "listByOwner: withheldOwners requires excludeBannedOwners",
        );
      }

      // `includeRunning` (public owner feeds): an event already under way at
      // `from` still matches — `endsAt >= from` (and `startsAt <= to` when
      // bounded). Without it the pinned-instant arm is the bare filter, so
      // existing callers' WHERE is unchanged.
      const runningArm: Prisma.EventWhereInput | null =
        includeRunning && dateRange?.from
          ? {
              endsAt: { gte: dateRange.from },
              ...(dateRange.to ? { startsAt: { lte: dateRange.to } } : {}),
            }
          : null;
      const startsArm: Prisma.EventWhereInput = runningArm
        ? { OR: [{ startsAt: startsAtFilter }, runningArm] }
        : { startsAt: startsAtFilter };
      // Ban-that-sticks, same rule as the single-event `ownerBanned`. A
      // caller with several reads per request passes the set it resolved.
      const notWithheld = excludeBannedOwners
        ? eventOwnerNotWithheldWhere(
            withheldOwners ?? (await resolveWithheldOwners(p)),
          )
        : null;

      // Conjuncts that must nest under ONE `AND` — spreading two `{ AND: … }`
      // objects would overwrite one with the other. Category first so the
      // pre-existing single-conjunct shape is unchanged when the date arm is
      // off.
      const andConjuncts: Prisma.EventWhereInput[] = [
        ...(hasCategoryIds && includeUncategorised
          ? [
              {
                OR: [
                  { categoryId: { in: categoryIds } },
                  { categoryId: null },
                ],
              },
            ]
          : []),
        ...(widenWindowToDates
          ? [
              {
                OR: [
                  ...(matchDateOccurrencesOnly ? [] : [startsArm]),
                  {
                    dates: {
                      some: {
                        status:
                          dateOccurrenceStatuses &&
                          dateOccurrenceStatuses.length > 0
                            ? { in: [...dateOccurrenceStatuses] }
                            : ("SCHEDULED" as const),
                        startsAt: startsAtFilter,
                      },
                    },
                  },
                ],
              },
            ]
          : []),
        // Running arm without the date widening: the pin filter moves here
        // (an OR cannot sit on the top-level key the text search owns).
        ...(runningArm && !widenWindowToDates ? [startsArm] : []),
        ...(notWithheld ? [notWithheld] : []),
        ...(cancelledWhilePublished ? [CANCELLED_WHILE_PUBLISHED_WHERE] : []),
      ];

      const where: Prisma.EventWhereInput = {
        ...(ownerType === "HUMAN" ? { humanId: ownerId } : { orgId: ownerId }),
        ...(status && status.length > 0 ? { status: { in: status } } : {}),
        ...(visibility && visibility.length > 0
          ? { visibility: { in: visibility } }
          : {}),
        // Search must cover every string the owner-facing listing SHOWS.
        // A place-linked event legitimately has `addressText: null` (publish
        // gates on placeId OR savedLocationId OR addressText), yet the admin
        // table renders "📍 <place name>" as the row's location line — without
        // the `place` arm, searching a venue name the user is literally
        // looking at returned zero rows.
        //
        // The `addressText` arm matches EXACT events ONLY. A freeform
        // OBSCURED event's row holds the TRUE street (it has no other row to
        // hold it), and this listing serves every org role — a SCANNER could
        // probe "Shelby", "1417 Shelby"… and read the street off which rows
        // come back, without ever being shown it (the inclusion oracle H1
        // closed for places). A place-linked event at a withheld venue stores
        // only the area label, but the rule is simpler stated once: search
        // matches the street only where the street is public.
        ...(trimmedQuery
          ? {
              OR: [
                { title: { contains: trimmedQuery, mode: "insensitive" } },
                {
                  AND: [
                    { locationMode: "EXACT" },
                    {
                      addressText: {
                        contains: trimmedQuery,
                        mode: "insensitive",
                      },
                    },
                  ],
                },
                {
                  place: {
                    name: { contains: trimmedQuery, mode: "insensitive" },
                  },
                },
              ],
            }
          : {}),
        // Facet filters are INDEPENDENT top-level conjuncts: Prisma ANDs
        // sibling keys, and `startsAt` / `categoryId` collide with none of the
        // keys above (`orgId`/`humanId`, `status`, `OR`), so they narrow the
        // text search rather than joining its OR.
        ...(hasStartsAtFilter && !widenWindowToDates && !runningArm
          ? { startsAt: startsAtFilter }
          : {}),
        ...categoryWhere,
        ...(andConjuncts.length > 0 ? { AND: andConjuncts } : {}),
      };

      const [total, events] = await Promise.all([
        p.event.count({ where }),
        p.event.findMany({
          where,
          orderBy:
            startsAtOrder === "asc"
              ? [{ startsAt: "asc" }, { createdAt: "asc" }]
              : [{ startsAt: "desc" }, { createdAt: "desc" }],
          select: EVENT_SELECT,
          skip: sanitizedOffset,
          take: sanitizedLimit,
        }),
      ]);

      return {
        items: events.map(mapEvent),
        pageInfo: buildOffsetPageInfo({
          total,
          limit: sanitizedLimit,
          offset: sanitizedOffset,
          count: events.length,
        }),
      };
    },

    linkSavedLocation: async (input: {
      eventId: string;
      savedLocationId: string;
    }) => {
      await p.event.update({
        where: { id: input.eventId },
        data: { savedLocationId: input.savedLocationId },
      });
    },

    updateTaxRate: async (input: {
      eventId: string;
      admissionTaxRateBps: number | null;
      taxRateSource: string | null;
    }) => {
      await p.event.update({
        where: { id: input.eventId },
        data: {
          admissionTaxRateBps: input.admissionTaxRateBps,
          taxRateSource: input.taxRateSource,
        },
      });
    },

    // Compare-and-set: the `admissionTaxRateBps: null` AND the `updatedAt`
    // version in the WHERE are the whole point — a stamp, or any other write
    // to the row, committed since the caller resolved its rate wins (port
    // doc).
    fillTaxRateIfUnset: async (input: {
      eventId: string;
      admissionTaxRateBps: number;
      taxRateSource: string;
      expectedUpdatedAt: Date;
    }) => {
      // Fail closed: Prisma reads `updatedAt: undefined` as "no filter", which
      // would silently turn this back into the NULL-only CAS the version check
      // exists to replace.
      if (!(input.expectedUpdatedAt instanceof Date)) {
        throw new TypeError("fillTaxRateIfUnset: expectedUpdatedAt is required");
      }
      const { count } = await p.event.updateMany({
        where: {
          id: input.eventId,
          admissionTaxRateBps: null,
          // The row version the rate was resolved from. Any write in between
          // (a settings save that left the stamp NULL included) moved it.
          updatedAt: input.expectedUpdatedAt,
        },
        data: {
          admissionTaxRateBps: input.admissionTaxRateBps,
          taxRateSource: input.taxRateSource,
        },
      });
      return count > 0;
    },

    // Compare-and-set on the whole stamp the caller read plus the row version
    // (port doc): a stamp written since, by anyone, wins.
    replaceTaxRateIfUnchanged: async (input: {
      eventId: string;
      expected: {
        admissionTaxRateBps: number;
        taxRateSource: string;
        updatedAt: Date;
      };
      admissionTaxRateBps: number | null;
      taxRateSource: string | null;
    }) => {
      // Fail closed, as fillTaxRateIfUnset: `undefined` is "no filter".
      if (!(input.expected.updatedAt instanceof Date)) {
        throw new TypeError(
          "replaceTaxRateIfUnchanged: expected.updatedAt is required",
        );
      }
      const { count } = await p.event.updateMany({
        where: {
          id: input.eventId,
          admissionTaxRateBps: input.expected.admissionTaxRateBps,
          taxRateSource: input.expected.taxRateSource,
          updatedAt: input.expected.updatedAt,
        },
        data: {
          admissionTaxRateBps: input.admissionTaxRateBps,
          taxRateSource: input.taxRateSource,
        },
      });
      return count > 0;
    },

    linkPayoutTerms: async (input: {
      eventId: string;
      payoutTermsId: string;
      kind?: "PRIMARY" | "RESALE" | "MERCH";
    }) => {
      const kind = input.kind ?? "PRIMARY";
      const data =
        kind === "RESALE"
          ? { resalePayoutTermsId: input.payoutTermsId }
          : kind === "MERCH"
            ? { merchPayoutTermsId: input.payoutTermsId }
            : { payoutTermsId: input.payoutTermsId };
      await p.event.update({
        where: { id: input.eventId },
        data,
      });
    },

    findByPayoutTermsId: async (payoutTermsId: string) => {
      const row = await p.event.findFirst({
        where: {
          OR: [{ payoutTermsId }, { resalePayoutTermsId: payoutTermsId }],
        },
        select: EVENT_SELECT,
      });
      return row ? mapEvent(row) : null;
    },

    updateRefundCutoff: async (input: {
      eventId: string;
      refundCutoffAt: Date | null;
    }) => {
      const row = await p.event.update({
        where: { id: input.eventId },
        data: { refundCutoffAt: input.refundCutoffAt },
        select: EVENT_SELECT,
      });
      return mapEvent(row);
    },

    updateInstructionalAdmission: async (input: {
      eventId: string;
      instructionalAdmission: boolean;
    }) => {
      const row = await p.event.update({
        where: { id: input.eventId },
        data: { instructionalAdmission: input.instructionalAdmission },
        select: EVENT_SELECT,
      });
      return mapEvent(row);
    },

    updateVolunteerSettings: async (input: {
      eventId: string;
      volunteeringEnabled?: boolean;
      volunteerAutoApprove?: boolean;
      volunteerWaiverRequired?: boolean;
      volunteerIntroText?: string | null;
    }) => {
      const data: Prisma.EventUpdateInput = {};
      if (input.volunteeringEnabled !== undefined) {
        data.volunteeringEnabled = input.volunteeringEnabled;
      }
      if (input.volunteerAutoApprove !== undefined) {
        data.volunteerAutoApprove = input.volunteerAutoApprove;
      }
      if (input.volunteerWaiverRequired !== undefined) {
        data.volunteerWaiverRequired = input.volunteerWaiverRequired;
      }
      if (input.volunteerIntroText !== undefined) {
        data.volunteerIntroText = input.volunteerIntroText;
      }
      const row = await p.event.update({
        where: { id: input.eventId },
        data,
        select: EVENT_SELECT,
      });
      return mapEvent(row);
    },
  };
}

function handleSlugConstraintError(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    // `cause` carries the original PrismaClientKnownRequestError, which is the
    // only thing that knows WHICH constraint was hit (slug vs shortId vs the
    // history table) and on which row. The use cases wrap this and forward
    // `cause` onward specifically so Sentry's linkedErrors integration can
    // walk to it; without it "conflict" reached monitoring as a bare two-word
    // object with nothing to diagnose from.
    throw { code: "conflict", cause: error } as const;
  }

  throw error;
}

/**
 * The Event columns for {@link ExactLocationPrivacyReset}: a community listing
 * linked to a place takes the place's (EXACT) privacy.
 */
function exactLocationPrivacyData(
  reset: ExactLocationPrivacyReset,
): Pick<
  // Plain column values: valid in a create AND an update (update also takes them).
  Prisma.EventUncheckedCreateInput,
  | "locationMode"
  | "locationRadiusMeters"
  | "addressRevealAt"
  | "addressRevealPreset"
  | "addressRevealNotifiedAt"
> {
  return {
    locationMode: reset.locationMode,
    locationRadiusMeters: reset.locationRadiusMeters,
    addressRevealAt: reset.addressRevealAt,
    addressRevealPreset: reset.addressRevealPreset,
    addressRevealNotifiedAt: reset.addressRevealNotifiedAt,
  };
}
