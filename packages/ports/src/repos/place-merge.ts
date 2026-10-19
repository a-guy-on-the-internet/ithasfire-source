/**
 * Storage for merging two duplicate Place rows (merge-duplicate-places spec,
 * docs/specs/2026-10-13/merge-duplicate-places.spec.yaml).
 *
 * The adapter does the row mechanics only: lock, read, count, re-point, drop
 * rows that would collide on a unique key, delete. Every decision (who may
 * merge, what blocks it, which fields fill, which ownership rows survive) is
 * core's `mergePlaces` / `previewPlaceMerge`. Call every method on a
 * tx-scoped repo (`repos.tx`), after {@link PlaceMergeRepo.lockForMerge}.
 */

import type { EventLocationMode } from "@th/types/repos/events";
import type {
  PlaceStatus,
  PlaceVerificationStatus,
  PlaceWebsiteSource,
} from "@th/types/repos/places";

/**
 * Every column of a Place row, as stored; the audit row keeps this whole.
 * One exception: the deprecated `Place.slug` directory key, which nothing
 * reads (core gate `no-place-slug-readers.test.ts`) and nothing routes on.
 */
export interface PlaceMergeRow {
  id: string;
  name: string;
  address: string;
  addrLine1: string | null;
  addrLine2: string | null;
  city: string | null;
  region: string | null;
  postcode: string | null;
  country: string | null;
  addressHash: string | null;
  capacity: number | null;
  lat: number | null;
  lng: number | null;
  phone: string | null;
  website: string | null;
  websiteSource: PlaceWebsiteSource;
  status: PlaceStatus;
  verification: PlaceVerificationStatus;
  timezone: string | null;
  admissionTaxRateBps: number | null;
  taxRateSource: string | null;
  taxRateFetchedAt: Date | null;
  locationMode: EventLocationMode;
  locationRadiusMeters: number | null;
  locationLabel: string | null;
  listedInDirectory: boolean;
  acceptsBookingRequests: boolean;
  acceptsCommunityListings: boolean;
  attendeeReviewsPublic: boolean;
  communityReviewsEnabled: boolean;
  defaultPrimaryPayoutTermsId: string | null;
  defaultResalePayoutTermsId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The columns a merge may write on the survivor. Core decides which; the
 * adapter writes exactly the keys present.
 */
export type PlaceMergeFillPatch = Partial<
  Pick<
    PlaceMergeRow,
    | "address"
    | "addrLine1"
    | "addrLine2"
    | "city"
    | "region"
    | "postcode"
    | "country"
    | "addressHash"
    | "lat"
    | "lng"
    | "timezone"
    | "admissionTaxRateBps"
    | "taxRateSource"
    | "taxRateFetchedAt"
    | "capacity"
    | "phone"
    | "website"
    | "websiteSource"
    | "locationLabel"
    | "defaultPrimaryPayoutTermsId"
    | "defaultResalePayoutTermsId"
  >
>;

export interface PlaceMergeOwnershipRow {
  id: string;
  ownerType: "HUMAN" | "ORGANIZATION";
  ownerId: string;
  verified: boolean;
  /** `revokedAt` is set. Revoked rows are history; they move with the place. */
  revoked: boolean;
}

export interface PlaceMergeCalendarRow {
  id: string;
  name: string;
  slug: string;
  isDefault: boolean;
  primarySpaceId: string;
}

export interface PlaceMergeSpaceRow {
  id: string;
  name: string;
}

export interface PlaceMergeLayoutRow {
  id: string;
  name: string;
}

/** One side of a merge, read under the lock. */
export interface PlaceMergeSide {
  place: PlaceMergeRow;
  /** The place's default calendar (`isDefault`), if it has one. */
  defaultCalendarId: string | null;
  /** The default calendar's primary space: the auto-made "Main Space". */
  mainSpaceId: string | null;
  /** The place's EntityPage (ownerType PLACE). */
  page: { id: string; slug: string } | null;
  /** Every PlaceOwnership row, revoked ones included. */
  ownerships: PlaceMergeOwnershipRow[];
  /** Every Calendar of the place, the default included, in id order. */
  calendars: PlaceMergeCalendarRow[];
  /** Every Space of the place, the Main Space included, in id order. */
  spaces: PlaceMergeSpaceRow[];
  /** Every PlaceLayout (seat map) of the place, in id order. */
  layouts: PlaceMergeLayoutRow[];
}

export interface PlaceMergeCountsInput {
  survivorId: string;
  mergedId: string;
  survivorPageId: string | null;
  mergedPageId: string | null;
  mergedDefaultCalendarId: string | null;
  mergedMainSpaceId: string | null;
  survivorDefaultCalendarId: string | null;
}

/** Cap on every id sample a count carries (the preview names, never lists all). */
export const PLACE_MERGE_ID_SAMPLE_CAP = 20;

/** A count with up to {@link PLACE_MERGE_ID_SAMPLE_CAP} of the ids behind it. */
export interface PlaceMergeIdSample {
  count: number;
  ids: string[];
}

/** Rows per booking intent, for one owner of booking standards. */
export type PlaceMergeIntentCounts = { intent: string; count: number }[];

/**
 * Booking standards (BookingStandardItem or BookingPitchExample) per owner
 * and intent. Each owner's list is replace-all per intent, so core decides per
 * intent whose list stays.
 */
export interface PlaceMergeStandardsOwners {
  mergedPlace: PlaceMergeIntentCounts;
  mergedDefaultCalendar: PlaceMergeIntentCounts;
  survivorPlace: PlaceMergeIntentCounts;
  survivorDefaultCalendar: PlaceMergeIntentCounts;
}

/**
 * What core needs to decide refusals and warnings (spec FR-006). Booking and
 * operations rows MOVE (owner ruling 2026-10-15); only the collisions below
 * can stop a merge.
 */
export interface PlaceMergeOperationsCounts {
  /** PENDING / IN_REVIEW PlaceVerificationRequest rows. */
  activeVerificationRequests: number;
  /** Merged Embed(place) rows whose domain the survivor already embeds on. */
  collidingEmbeds: number;
  /** Merged-place events with stewardship COMMUNITY (ownerless listings). */
  communityEvents: number;
  /**
   * Merged holds on the merged DEFAULT calendar whose date the survivor's
   * default calendar also holds in the same way: both in the live line
   * (ACTIVE / CHALLENGED: two position-1 acts) or both CONFIRMED (unique index
   * "BookingHold_confirmed_line_key"). Zero when the calendars do not fold.
   */
  holdLineConflicts: PlaceMergeIdSample;
  /**
   * Merged default-calendar holds on a date where one side has a CONFIRMED
   * hold and the other only live holds. No constraint forbids it.
   */
  holdSameNight: PlaceMergeIdSample;
  /**
   * Merged OPEN booking requests (PENDING / VIEWED) whose move would collide
   * with an open survivor request on "BookingRequest_open_pair_key" (same
   * performer) or "BookingRequest_open_anon_pair_key" (same contact email).
   */
  openRequestConflicts: PlaceMergeIdSample;
  /**
   * Active PlaceWaiver rows per side (`getActiveForPlace` returns ONE, the
   * highest version, so a moved active waiver could replace the survivor's).
   */
  activeWaivers: { survivor: number; merged: number };
  /**
   * Merged CalendarAvailability rows that land on the survivor's default
   * calendar (default-calendar rows when the calendars fold, and place-wide
   * rows) and share a weekday or a date with a survivor row there.
   */
  availabilityOverlaps: PlaceMergeIdSample;
  /** Merged place-wide (calendarId null) availability rows. */
  placeWideAvailability: number;
  /** Merged PlaceBookingGrant rows not yet revoked. */
  activeGrants: PlaceMergeIdSample;
  /** Merged grants not yet revoked with calendarId null (whole place). */
  wholePlaceGrants: PlaceMergeIdSample;
  /**
   * What the survivor's owner controls: its OPEN booking requests (PENDING,
   * VIEWED, ACCEPTED) and live agreements (DRAFT, PROPOSED, COUNTERED,
   * ACCEPTED, DISPUTED). Shown with OWNERSHIP_TRANSFERS, when the merged
   * owners move onto an ownerless survivor and take these over.
   */
  survivorControl: { openBookingRequests: number; liveAgreements: number };
  standards: {
    items: PlaceMergeStandardsOwners;
    examples: PlaceMergeStandardsOwners;
  };
}

/** What a merge would move, and the rows it would drop on a unique collision. */
export interface PlaceMergeMoveCounts {
  events: number;
  /**
   * Events AT the merged place whose venue confirmation names it; the stamp
   * moves with them. A lapsed stamp (the event has since moved elsewhere) is
   * left as it is, never revived at the survivor.
   */
  venueConfirmedEvents: number;
  /** Events on the merged default calendar (re-pointed to the survivor's). */
  eventsOnDefaultCalendar: number;
  /** Events on the merged Main Space (re-pointed to the survivor's). */
  eventsOnMainSpace: number;
  attendeeReviews: number;
  postEventPrompts: number;
  membershipBenefits: number;
  savedLocations: number;
  placeReviews: number;
  placeReviewSessions: number;
  placeReviewSessionsDropped: number;
  volunteerAsks: number;
  entityReports: number;
  entityReportsDropped: number;
  featuredItems: number;
  featuredItemsDropped: number;
  embeds: number;
  /** Closed (not PENDING / IN_REVIEW) verification requests: history. */
  verificationRequests: number;
  follows: number;
  followsDropped: number;
  eventNotices: number;
  eventNoticesDropped: number;
  pageSlugHistory: number;
  /** BookingRequest rows at the merged place (placeId), any status. */
  bookingRequests: number;
  agreements: number;
  bookingGrants: number;
  waivers: number;
  posReaders: number;
  layouts: number;
  /** Every CalendarAvailability row of the merged place. */
  calendarAvailability: number;
  /** BookingHold rows on any merged calendar, any status. */
  bookingHolds: number;
  /** EventSeries whose defaults name the merged place (rewritten). */
  series: number;
  /** EventTemplate rows whose defaults name the merged place (rewritten). */
  templates: number;
  /** EventSeriesOccurrence rows whose overrides name it (rewritten). */
  occurrences: number;
  /** ImageModerationRecord rows with subject PLACE = the merged place. */
  imageModerationRecords: number;
}

export interface PlaceMergeCounts {
  operations: PlaceMergeOperationsCounts;
  moves: PlaceMergeMoveCounts;
}

export interface RepointPlaceRowsInput {
  survivorId: string;
  mergedId: string;
  /** Re-point Event.calendarId from → to. Null when nothing needs it. */
  calendar: { from: string; to: string } | null;
  /** Re-point Event.spaceId from → to. Null when nothing needs it. */
  space: { from: string; to: string } | null;
  /**
   * PlaceOwnership rows (either side) to delete before the merged place's
   * rows move, so no (placeId, ownerType, ownerId) pair collides. Core picks
   * them.
   */
  dropOwnershipIds: string[];
  /**
   * For each dropped ownership, the KEPT row of the same owner. Verification
   * requests carry `ownershipId` with no FK; any request that points at a
   * dropped row is re-pointed at the kept one in the same transaction.
   */
  repointOwnershipIds?: { from: string; to: string }[];
}

/** Ids per table: what moved to the survivor, and what was dropped. */
export interface RepointPlaceRowsResult {
  events: string[];
  venueConfirmedEvents: string[];
  eventsCalendarRepointed: string[];
  eventsSpaceRepointed: string[];
  attendeeReviews: string[];
  postEventPrompts: string[];
  membershipBenefits: string[];
  savedLocations: string[];
  placeReviews: string[];
  placeReviewSessions: string[];
  placeReviewSessionsDropped: string[];
  volunteerAsks: string[];
  entityReports: string[];
  entityReportsDropped: string[];
  featuredItems: string[];
  featuredItemsDropped: string[];
  embeds: string[];
  ownerships: string[];
  ownershipsDropped: string[];
  verificationRequests: string[];
  /** ImageModerationRecord rows with subject PLACE re-pointed to the survivor. */
  imageModerationRecords: string[];
  /** Full rows of every dropped row above (the audit row is the reversal record). */
  droppedRows: {
    placeReviewSessions: PlaceMergeRowSnapshot[];
    entityReports: PlaceMergeRowSnapshot[];
    featuredItems: PlaceMergeRowSnapshot[];
    ownerships: PlaceMergeRowSnapshot[];
  };
}

export interface RepointPageRowsResult {
  follows: string[];
  followsDropped: string[];
  eventNotices: string[];
  eventNoticesDropped: string[];
  pageSlugHistory: string[];
  /** Full rows of the dropped follows / notices. */
  droppedRows: {
    follows: PlaceMergeRowSnapshot[];
    eventNotices: PlaceMergeRowSnapshot[];
  };
}

export interface PlaceMergeStandardDrop {
  ownerType: "PLACE" | "CALENDAR";
  ownerId: string;
  intent: string;
}

/**
 * Booking and operations rows (spec FR-003b, owner ruling 2026-10-15). Core
 * computes every name, slug and drop; the adapter writes exactly these.
 */
export interface MovePlaceOperationsInput {
  survivorId: string;
  mergedId: string;
  /**
   * Fold the merged DEFAULT calendar into the survivor's: calendar-scoped
   * rows move, then the emptied merged calendar is deleted. Null when the
   * calendars do not fold (either side has no default calendar).
   */
  calendar: { from: string; to: string } | null;
  /** Same for the merged Main Space → the survivor's. Null with `calendar`. */
  space: { from: string; to: string } | null;
  /** Merged calendars that move whole (placeId → survivor), final name/slug. */
  reparentCalendars: { id: string; name: string; slug: string }[];
  /** Merged spaces that move whole, final name. */
  reparentSpaces: { id: string; name: string }[];
  /** Every merged PlaceLayout, final name (unique per place). */
  layouts: { id: string; name: string }[];
  /** Merged BookingStandardItem rows to drop instead of moving. */
  dropStandardItems: PlaceMergeStandardDrop[];
  /** Merged BookingPitchExample rows to drop instead of moving. */
  dropPitchExamples: PlaceMergeStandardDrop[];
  /**
   * Move the merged waivers as inactive (the survivor has an active waiver
   * and stays authoritative). False: they move with isActive as it was.
   */
  deactivateMergedWaivers: boolean;
  /**
   * End (revokedAt = `now`) every merged grant that is not yet revoked: the
   * owners are not compatible, so a former owner's grants do not carry.
   */
  revokeMergedGrants: boolean;
  /**
   * The calendars a merged WHOLE-PLACE grant (calendarId null, not revoked)
   * is split onto: one grant per calendar the merged place brought, so it
   * never widens to the survivor's own rooms. Empty: nothing is split (see
   * `revokeWholePlaceGrants`).
   */
  splitWholePlaceGrantsOnto: string[];
  /**
   * End (revokedAt = `now`) every merged WHOLE-PLACE grant not yet revoked.
   * Core sets it when the merged place brought no calendar to split onto:
   * moved as is, a calendarId-null grant would cover every survivor room,
   * which nobody granted. The ids join `bookingGrantsRevoked`.
   */
  revokeWholePlaceGrants: boolean;
  /** The clock for `revokeMergedGrants` / `revokeWholePlaceGrants`. */
  now: Date;
}

/** A JSON snapshot of a row the merge deleted or dropped, for the audit row. */
export type PlaceMergeRowSnapshot = Record<string, unknown>;

/** Ids per table (full lists: the audit row is the reversal record). */
export interface MovePlaceOperationsResult {
  bookingHolds: string[];
  bookingHoldsCalendarRepointed: string[];
  bookingHoldsSpaceRepointed: string[];
  bookingRequests: string[];
  bookingRequestsCalendarRepointed: string[];
  bookingRequestsSpaceRepointed: string[];
  agreements: string[];
  bookingGrants: string[];
  bookingGrantsCalendarRepointed: string[];
  /**
   * Grants ended by `revokeMergedGrants` or `revokeWholePlaceGrants`; their
   * prior revokedAt was null.
   */
  bookingGrantsRevoked: string[];
  /**
   * Each split whole-place grant: its row before the split (snapshot), the
   * calendar it was narrowed to, the new grant ids per extra calendar, and
   * the holds whose grantId moved to the new grant of their calendar.
   */
  bookingGrantsSplit: {
    original: PlaceMergeRowSnapshot;
    keptOnCalendarId: string;
    created: { id: string; calendarId: string }[];
    holdsRepointed: { holdId: string; fromGrantId: string; toGrantId: string }[];
  }[];
  waivers: string[];
  /** Each moved waiver's isActive before the merge (reversal record). */
  waiverStates: { id: string; wasActive: boolean }[];
  /** Waivers the move set inactive (`deactivateMergedWaivers`). */
  waiversDeactivated: string[];
  posReaders: string[];
  layouts: string[];
  calendarAvailability: string[];
  calendarAvailabilityCalendarRepointed: string[];
  bookingStandardItems: string[];
  bookingStandardItemsDropped: PlaceMergeRowSnapshot[];
  bookingPitchExamples: string[];
  bookingPitchExamplesDropped: PlaceMergeRowSnapshot[];
  calendarsReparented: string[];
  spacesReparented: string[];
  /** CalendarSpace rows created on the survivor (folded joins, primary moves). */
  calendarSpaceJoinsCreated: { id: string; calendarId: string; spaceId: string }[];
  /** CalendarSpace rows deleted because they pointed at the folded Main Space. */
  calendarSpaceJoinsDeleted: PlaceMergeRowSnapshot[];
  /** Re-parented calendars whose primary space was the folded Main Space. */
  primarySpaceRepointedCalendars: string[];
  /** Events on a re-parented calendar (for the reindex marks). */
  eventsOnReparentedCalendars: string[];
  series: string[];
  templates: string[];
  occurrences: string[];
  /** The folded (deleted) merged default calendar, its joins included. */
  deletedCalendar: PlaceMergeRowSnapshot | null;
  /** The folded (deleted) merged Main Space. */
  deletedSpace: PlaceMergeRowSnapshot | null;
}

export interface PlaceMergeRepo {
  /**
   * Lock both places for the rest of the transaction: `SELECT … FOR UPDATE`
   * on the Place rows, then their Calendar rows, then their Space rows, then
   * the live and confirmed BookingHold rows on `lineKeys` only (the hold
   * lines core already advisory-locked; line by line, each in id order),
   * then their PlaceWaiver rows, then their PLACE EntityPage rows, each set
   * in id order so two merges of the same pair cannot deadlock; then the
   * booking-standards advisory locks
   * (`booking_standards:<table>:<ownerType>:<ownerId>:<intent>`, the keys
   * replace-all takes) for both places and both default calendars, every
   * intent, in sorted key order. A row lock blocks any insert that
   * references the row by FK (an Event, a BookingHold on a calendar or
   * space) until commit. The standards locks protect only saves that commit
   * before the merge: a save already waiting on the lock can still write to
   * an owner the merge deleted (follow-up, manage-booking-standards should
   * re-check its owner after taking the lock).
   */
  lockForMerge(input: {
    placeIds: readonly string[];
    lineKeys: readonly { calendarId: string; date: string }[];
  }): Promise<void>;
  /**
   * The hold lines a fold would touch: for every calendar-day with a live or
   * confirmed hold on the merged DEFAULT calendar, that day on both default
   * calendars. Empty when either place has no default calendar. Read without
   * row locks; core takes the line advisory locks (`bookingHolds.lockLine`)
   * on these keys BEFORE `lockForMerge`, then re-reads under the row locks
   * and retries if a new day appeared.
   */
  listFoldLineKeys(input: {
    survivorId: string;
    mergedId: string;
  }): Promise<{ calendarId: string; date: string }[]>;
  /** One side of the merge; null when the place does not exist. */
  getSide(placeId: string): Promise<PlaceMergeSide | null>;
  count(input: PlaceMergeCountsInput): Promise<PlaceMergeCounts>;
  /** Write the survivor columns core chose. A no-op for an empty patch. */
  fillFields(placeId: string, patch: PlaceMergeFillPatch): Promise<void>;
  /**
   * Re-point every placeId / subject reference from the merged place to the
   * survivor (spec FR-003), dropping the merged row on a unique collision
   * (PlaceReviewSession token, pending EntityReport per reporter,
   * FeaturedItem). Event.venueConfirmedPlaceId moves with Event.placeId.
   * Embed collisions are a refusal in core, never handled here.
   */
  repointPlaceRows(input: RepointPlaceRowsInput): Promise<RepointPlaceRowsResult>;
  /**
   * Move the merged place's booking and operations rows (spec FR-003b): holds,
   * booking requests, grants, availability and calendar-owned standards on the
   * merged default calendar / Main Space go to the survivor's; every other
   * merged calendar and space moves whole; place-scoped rows (agreements,
   * waivers, readers, layouts, place-owned standards) re-point placeId;
   * series / template / occurrence location JSON is rewritten. Run AFTER
   * `repointPlaceRows` (events must leave the folded calendar first) and
   * BEFORE `deletePlace`. Nothing here cascades: every row is moved first.
   */
  moveOperations(input: MovePlaceOperationsInput): Promise<MovePlaceOperationsResult>;
  /**
   * Move follows, event notices and slug history from one EntityPage to
   * another, dropping the source's follow / notice where the target already
   * has one for the same person / event (spec FR-004).
   */
  repointPageRows(input: {
    fromPageId: string;
    toPageId: string;
  }): Promise<RepointPageRowsResult>;
  /** Give a PLACE EntityPage to another place (the survivor had none). */
  transferPage(input: { pageId: string; toPlaceId: string }): Promise<void>;
  /** Delete one EntityPage; blocks, theme and draft cascade. */
  deletePage(pageId: string): Promise<void>;
  /**
   * Make the place's PlaceStats row stale so the scheduled recompute
   * rebuilds it first. A no-op when the place has no row (the sweep already
   * picks up a place with no row).
   */
  markPlaceStatsStale(placeId: string): Promise<void>;
  /** Delete the place's derived rows: PlaceStats and ReviewAggregate(PLACE). */
  deleteDerivedRows(placeId: string): Promise<void>;
  /** Hard-delete the Place row; its remaining FK children cascade. */
  deletePlace(placeId: string): Promise<void>;
}
