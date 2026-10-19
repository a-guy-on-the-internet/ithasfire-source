import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@th/trpc";

// ─────────────────────────────────────────────────────────────────────────────
// Copy for the "Merge into…" dialog (merge-duplicate-places FR-008). Every map
// is keyed by the server's own enum, so a new blocker, warning, moved table or
// fill field fails typecheck here until it has words.
// ─────────────────────────────────────────────────────────────────────────────

export type PlaceMergePreview =
  inferRouterOutputs<AppRouter>["platform"]["previewPlaceMerge"];
export type PlaceMergeBlocker = PlaceMergePreview["blockers"][number];
export type PlaceMergeWarning = PlaceMergePreview["warnings"][number];
type BlockerCode = PlaceMergeBlocker["code"];
type WarningCode = PlaceMergeWarning["code"];
type MoveKey = keyof PlaceMergePreview["moves"];
type FillField = PlaceMergePreview["filledFields"][number];
type RenameKind = PlaceMergePreview["renames"][number]["kind"];

/** The `meta.reason` a rolled-back merge carries: safe to run again. */
export const PLACE_MERGE_RETRY = "PLACE_MERGE_RETRY";
/** The `meta.reason` a refused merge carries (with `meta.blockers`). */
export const PLACE_MERGE_BLOCKED = "PLACE_MERGE_BLOCKED";

/** One line per blocker; each key takes `{count}`. */
export const BLOCKER_COPY: Record<BlockerCode, string> = {
  HAS_ACTIVE_VERIFICATION_REQUEST: "admin.ppMergeBlockVerificationRequest",
  VERIFICATION_ABOVE_SURVIVOR: "admin.ppMergeBlockVerificationAbove",
  OWNER_CONFLICT: "admin.ppMergeBlockOwnerConflict",
  EMBED_COLLISION: "admin.ppMergeBlockEmbedCollision",
  LOCATION_PRIVACY_DIFFERS: "admin.ppMergeBlockLocationPrivacy",
  COMMUNITY_LISTINGS_CONSENT_DIFFERS: "admin.ppMergeBlockCommunityConsent",
  SURVIVOR_NOT_ACTIVE: "admin.ppMergeBlockSurvivorNotActive",
  DEFAULT_PAYOUT_TERMS_CONFLICT: "admin.ppMergeBlockPayoutTerms",
  BOOKING_HOLDS_OVERLAP: "admin.ppMergeBlockHoldsOverlap",
  BOOKING_REQUESTS_OPEN_DUPLICATE: "admin.ppMergeBlockRequestsDuplicate",
  // Takes `{limit}` too; the dialog lists `arrivalAreas` under it.
  ARRIVAL_AREA_LIMIT: "admin.ppMergeBlockArrivalAreaLimit",
};

type BlockerArrivalArea = NonNullable<PlaceMergeBlocker["arrivalAreas"]>[number];

/** Each named area's kind, in the ARRIVAL_AREA_LIMIT list. */
export const ARRIVAL_AREA_KIND_COPY: Record<BlockerArrivalArea["kind"], string> = {
  PARKING: "admin.ppMergeArrivalAreaKindParking",
  ACCESSIBLE_DROP_OFF: "admin.ppMergeArrivalAreaKindDropOff",
  LOAD_IN: "admin.ppMergeArrivalAreaKindLoadIn",
};

/** Which place each named area is on, in the ARRIVAL_AREA_LIMIT list. */
export const ARRIVAL_AREA_SIDE_COPY: Record<BlockerArrivalArea["side"], string> = {
  survivor: "admin.ppMergeArrivalAreaSideSurvivor",
  merged: "admin.ppMergeArrivalAreaSideMerged",
};

/**
 * One line per warning; each key takes `{count}`. OWNERSHIP_TRANSFERS also
 * takes `{merged}`, `{survivor}`, `{requests}` and `{agreements}`.
 */
export const WARNING_COPY: Record<WarningCode, string> = {
  AVAILABILITY_OVERLAP: "admin.ppMergeWarnAvailabilityOverlap",
  PLACE_WIDE_AVAILABILITY_MOVED: "admin.ppMergeWarnPlaceWideAvailability",
  HOLDS_SAME_NIGHT: "admin.ppMergeWarnHoldsSameNight",
  BOOKING_STANDARDS_REPLACED: "admin.ppMergeWarnStandardsReplaced",
  NAMES_SUFFIXED: "admin.ppMergeWarnNamesSuffixed",
  WAIVER_BECOMES_ACTIVE: "admin.ppMergeWarnWaiverActive",
  WAIVERS_DEACTIVATED: "admin.ppMergeWarnWaiversDeactivated",
  PAYOUT_DEFAULTS_NOT_CARRIED: "admin.ppMergeWarnPayoutDefaults",
  GRANTS_ENDED: "admin.ppMergeWarnGrantsEnded",
  GRANTS_SPLIT: "admin.ppMergeWarnGrantsSplit",
  OWNERSHIP_TRANSFERS: "admin.ppMergeWarnOwnershipTransfers",
  // The pin case; `warningCopyKey` picks the no-pin line.
  EVENT_ARRIVAL_AREAS_SWITCH_OFF: "admin.ppMergeWarnEventArrivalAreasOff",
  MERGED_PLACE_AREAS_BECOME_PUBLIC: "admin.ppMergeWarnMergedAreasBecomePublic",
};

/**
 * The line for one warning. EVENT_ARRIVAL_AREAS_SWITCH_OFF has two: far from
 * the survivor's pin, or the survivor has no pin at all (every area counts).
 */
export function warningCopyKey(warning: PlaceMergeWarning): string {
  if (
    warning.code === "EVENT_ARRIVAL_AREAS_SWITCH_OFF" &&
    warning.survivorHasPin === false
  ) {
    return "admin.ppMergeWarnEventArrivalAreasOffNoPin";
  }
  return WARNING_COPY[warning.code];
}

/**
 * How each moved-table count reads. `move`: rows that go to the place that
 * stays. `sub`: a part of the `move` row above it ("of which…"), indented so
 * it never reads as a sibling to add up. `drop`: rows the merge does not carry
 * (ones the survivor already has, ended grants); their keys take `{name}`, the
 * survivor. `note`: a yes/no fact, one line without a number. `hidden`: an
 * internal subset that tells an admin nothing (key unused).
 */
export type MoveCopy =
  | { key: string; kind: "move" | "sub" | "drop" | "note" }
  | { key: null; kind: "hidden" };

export const MOVE_COPY: Record<MoveKey, MoveCopy> = {
  events: { key: "admin.ppMergeMoveEvents", kind: "move" },
  // Must stay right after `events`: it renders as that row's "of which".
  venueConfirmedEvents: {
    key: "admin.ppMergeMoveConfirmedEvents",
    kind: "sub",
  },
  // Which calendar/space the moved events sit on: plumbing, not news.
  eventsOnDefaultCalendar: { key: null, kind: "hidden" },
  eventsOnMainSpace: { key: null, kind: "hidden" },
  attendeeReviews: { key: "admin.ppMergeMoveAttendeeReviews", kind: "move" },
  postEventPrompts: { key: "admin.ppMergeMoveReviewPrompts", kind: "move" },
  membershipBenefits: { key: "admin.ppMergeMoveBenefits", kind: "move" },
  savedLocations: { key: "admin.ppMergeMoveSavedLocations", kind: "move" },
  placeReviews: { key: "admin.ppMergeMovePlaceReviews", kind: "move" },
  placeReviewSessions: {
    key: "admin.ppMergeMoveReviewSessions",
    kind: "move",
  },
  placeReviewSessionsDropped: {
    key: "admin.ppMergeDropReviewSessions",
    kind: "drop",
  },
  volunteerAsks: { key: "admin.ppMergeMoveVolunteerAsks", kind: "move" },
  entityReports: { key: "admin.ppMergeMoveReports", kind: "move" },
  entityReportsDropped: { key: "admin.ppMergeDropReports", kind: "drop" },
  featuredItems: { key: "admin.ppMergeMoveFeatured", kind: "move" },
  featuredItemsDropped: { key: "admin.ppMergeDropFeatured", kind: "drop" },
  embeds: { key: "admin.ppMergeMoveEmbeds", kind: "move" },
  verificationRequests: {
    key: "admin.ppMergeMoveVerificationRequests",
    kind: "move",
  },
  follows: { key: "admin.ppMergeMoveFollows", kind: "move" },
  followsDropped: { key: "admin.ppMergeDropFollows", kind: "drop" },
  eventNotices: { key: "admin.ppMergeMoveEventNotices", kind: "move" },
  eventNoticesDropped: { key: "admin.ppMergeDropEventNotices", kind: "drop" },
  pageSlugHistory: { key: "admin.ppMergeMoveOldAddresses", kind: "move" },
  ownerships: { key: "admin.ppMergeMoveOwners", kind: "move" },
  ownershipsDropped: { key: "admin.ppMergeDropOwners", kind: "drop" },
  bookingRequests: { key: "admin.ppMergeMoveBookingRequests", kind: "move" },
  agreements: { key: "admin.ppMergeMoveAgreements", kind: "move" },
  bookingGrants: { key: "admin.ppMergeMoveGrants", kind: "move" },
  waivers: { key: "admin.ppMergeMoveWaivers", kind: "move" },
  posReaders: { key: "admin.ppMergeMoveCardReaders", kind: "move" },
  layouts: { key: "admin.ppMergeMoveSeatMaps", kind: "move" },
  calendarAvailability: {
    key: "admin.ppMergeMoveAvailability",
    kind: "move",
  },
  bookingHolds: { key: "admin.ppMergeMoveHolds", kind: "move" },
  calendarsReparented: { key: "admin.ppMergeMoveCalendars", kind: "move" },
  spacesReparented: { key: "admin.ppMergeMoveSpaces", kind: "move" },
  defaultCalendarFolded: {
    key: "admin.ppMergeNoteCalendarFolded",
    kind: "note",
  },
  bookingStandardItems: { key: "admin.ppMergeMoveStandards", kind: "move" },
  bookingStandardItemsDropped: {
    key: "admin.ppMergeDropStandards",
    kind: "drop",
  },
  bookingPitchExamples: {
    key: "admin.ppMergeMovePitchExamples",
    kind: "move",
  },
  bookingPitchExamplesDropped: {
    key: "admin.ppMergeDropPitchExamples",
    kind: "drop",
  },
  series: { key: "admin.ppMergeMoveSeries", kind: "move" },
  templates: { key: "admin.ppMergeMoveTemplates", kind: "move" },
  occurrences: { key: "admin.ppMergeMoveOccurrences", kind: "move" },
  bookingGrantsRevoked: { key: "admin.ppMergeDropGrantsEnded", kind: "drop" },
  bookingGrantsSplit: { key: "admin.ppMergeMoveGrantsSplit", kind: "move" },
  imageModerationRecords: {
    key: "admin.ppMergeMoveImageRecords",
    kind: "move",
  },
  arrivalAreas: { key: "admin.ppMergeMoveArrivalAreas", kind: "move" },
};

/**
 * Fill fields collapse to what an admin recognises: the address moves as one
 * group (with its timezone and tax cache), the website with its source.
 */
export const FILL_COPY: Record<FillField, string> = {
  address: "admin.ppMergeFillAddress",
  addrLine1: "admin.ppMergeFillAddress",
  addrLine2: "admin.ppMergeFillAddress",
  city: "admin.ppMergeFillAddress",
  region: "admin.ppMergeFillAddress",
  postcode: "admin.ppMergeFillAddress",
  country: "admin.ppMergeFillAddress",
  addressHash: "admin.ppMergeFillAddress",
  lat: "admin.ppMergeFillAddress",
  lng: "admin.ppMergeFillAddress",
  timezone: "admin.ppMergeFillAddress",
  admissionTaxRateBps: "admin.ppMergeFillAddress",
  taxRateSource: "admin.ppMergeFillAddress",
  taxRateFetchedAt: "admin.ppMergeFillAddress",
  capacity: "admin.ppMergeFillCapacity",
  phone: "admin.ppMergeFillPhone",
  locationLabel: "admin.ppMergeFillLocationLabel",
  website: "admin.ppMergeFillWebsite",
  websiteSource: "admin.ppMergeFillWebsite",
  defaultPrimaryPayoutTermsId: "admin.ppMergeFillDefaultDeals",
  defaultResalePayoutTermsId: "admin.ppMergeFillDefaultDeals",
};

export const RENAME_KIND_COPY: Record<RenameKind, string> = {
  calendar: "admin.ppMergeRenameCalendar",
  space: "admin.ppMergeRenameSpace",
  layout: "admin.ppMergeRenameSeatMap",
};

export const FINAL_NOTE_COPY: Record<PlaceMergePreview["pageAction"], string> =
  {
    MOVE_TO_SURVIVOR_PAGE: "admin.ppMergeFinalRedirect",
    TRANSFER_PAGE: "admin.ppMergeFinalTransfer",
    NONE: "admin.ppMergeFinalNone",
  };

export type MoveRow = { key: string; count: number; sub?: boolean };

/** Moved rows split into what moves, what is not carried, and plain notes. */
export function summarizeMoves(moves: PlaceMergePreview["moves"]): {
  moved: MoveRow[];
  dropped: MoveRow[];
  notes: string[];
} {
  const moved: MoveRow[] = [];
  const dropped: MoveRow[] = [];
  const notes: string[] = [];
  for (const field of Object.keys(MOVE_COPY) as MoveKey[]) {
    const count = moves[field];
    const copy = MOVE_COPY[field];
    if (!count || copy.kind === "hidden") continue;
    if (copy.kind === "note") notes.push(copy.key);
    else if (copy.kind === "drop") dropped.push({ key: copy.key, count });
    else moved.push({ key: copy.key, count, sub: copy.kind === "sub" });
  }
  return { moved, dropped, notes };
}

/** Fill fields as unique labels, in first-seen order. */
export function summarizeFilled(filled: readonly FillField[]): string[] {
  return [...new Set(filled.map((f) => FILL_COPY[f]))];
}

/** The `meta.reason` on a tRPC error, when the server put one there. */
export function getErrorReason(err: unknown): string | null {
  const reason = (err as { data?: { meta?: { reason?: unknown } | null } })
    ?.data?.meta?.reason;
  return typeof reason === "string" ? reason : null;
}
