import { addressVenueChanged } from "@th/core/use-cases/community/_shared/venue-moved";
import type { ProseMirrorDoc } from "@th/schema";

import { getAppErrorCode } from "@/lib/app-error";
import { getInvalidFieldsMeta } from "@/lib/suggestion-error";

import {
  formatRowDate,
  formatRowTime,
} from "../../[id]/dates/_components/series-dates-helpers";

import { toIsoInTimeZone } from "./event-builder-helpers";
import type { LocationState } from "./LocationSection";

/**
 * Pure helpers for the EventBuilder's COMMUNITY mode — authoring an ownerless
 * community listing in the real builder instead of the retired standalone
 * form.
 *
 * Kept free of React so the mapping between builder state and the FR-007
 * whitelist (`community.updateListing`'s `fields`) is unit-testable without
 * mounting a 3,900-line component.
 *
 * ## Why the whitelist is retyped here
 *
 * It is NOT retyped. {@link CommunityUpdateFields} is deliberately a narrow
 * hand-written shape rather than an import of the core's
 * `CommunityEditableFieldValues`, because the wire form differs: instants go
 * over tRPC as ISO STRINGS (the core schema accepts `Date | string`), and the
 * builder never proposes `null` for the geo group. The one thing that must not
 * drift — the KEY SET — is pinned by
 * `community-builder.helpers.test.ts`'s exhaustive-key assertion against
 * `SUGGESTION_EDITABLE_FIELDS`.
 */

/**
 * The whitelisted field diff `community.updateListing` accepts, in the shape
 * the builder puts on the wire. Every key here is in the core's
 * `SUGGESTION_EDITABLE_FIELDS`; sending anything else rejects the WHOLE payload
 * with `EDIT_SUGGESTION_INVALID_FIELDS` / `unsupported_fields`.
 */
export type CommunityUpdateFields = {
  title?: string;
  content?: unknown;
  startsAt?: string;
  endsAt?: string;
  timezone?: string;
  addressText?: string;
  countryCode?: string;
  region?: string | null;
  locality?: string | null;
  postalCode?: string | null;
  lat?: number;
  lng?: number;
  categoryId?: string | null;
  heroImageId?: string | null;
  ageLimit?: number | null;
  /**
   * The place link — NOT a suggestion field (the exhaustive-key guard never
   * sees it: the builder only emits it when the link changes). The server
   * takes it out of the diff before the whitelist runs:
   * a uuid LINKS (address/geo copied from the place, any sent alongside are
   * ignored); `null` UNLINKS (address kept unless new address fields ride in
   * the same diff). See {@link buildCommunityUpdateFields}.
   */
  placeId?: string | null;
};

export type BuildCommunityUpdateFieldsInput = {
  title: string;
  /** `datetime-local` reading, interpreted in `timezone`. */
  startsAtLocal: string;
  /** `datetime-local` reading, interpreted in `timezone`. */
  endsAtLocal: string;
  timezone: string;
  location: LocationState;
  bodyContent: ProseMirrorDoc;
  /** Body block id — passed in so the caller owns nanoid (keeps this pure). */
  bodyBlockId: string;
  categoryId: string | null;
  /**
   * `undefined` = the hero is untouched by this save. `null` = the moderator
   * removed it. A string = a freshly uploaded image to link.
   */
  heroImageId?: string | null;
  /**
   * Which MATERIAL groups this save is allowed to put on the wire. Both
   * default to `true`, which is byte-for-byte the pre-2026-09-16 payload — the
   * DRAFT path never passes this.
   *
   * A live listing does. See {@link diffCommunityMaterialGroups} for why
   * sending an unchanged group is not free there.
   */
  include?: CommunityMaterialGroups;
  /**
   * The place the listing is linked to AS STORED (`getEventForEdit.placeId`),
   * compared against `location.thPlaceId` to decide whether the link changed.
   * Omitted or null = the stored listing is unlinked.
   */
  savedPlaceId?: string | null;
};

/**
 * The two FR-013 material groups, mirroring the core's `SCHEDULE_GROUP_FIELDS`
 * (startsAt/endsAt) and `GEO_GROUP_FIELDS` (the address + pin). Everything else
 * in the whitelist — title, body, category, hero, age limit, timezone — is
 * non-material and notifies nobody.
 */
export type CommunityMaterialGroups = {
  schedule: boolean;
  venue: boolean;
};

/**
 * Map builder state onto the `community.updateListing` whitelist.
 *
 * Three rules this encodes, each of which is a server rejection if broken:
 *
 * 1. **lat/lng travel together.** `parseSuggestionFields` rejects a diff
 *    carrying exactly one of them (`lat_lng_must_pair`). An un-geocoded
 *    address therefore contributes NO geo fields at all rather than a lone
 *    `addressText` — the caller gates on {@link communityLocationIsPinned}
 *    before ever getting here.
 * 2. **`endsAt` is non-nullable** in the whitelist, so an empty end time is
 *    omitted (leaving the stored value) rather than sent as null.
 * 3. **The diff is never empty.** `title`, `timezone` and `content` are always
 *    present, so `empty_diff` is unreachable from this builder — including
 *    when `include` drops BOTH material groups.
 * 4. **A group the caller excludes is absent, not null.** `include` governs
 *    only whether the group rides along; the values themselves are unchanged.
 * 5. **A linked location sends no address.** `location.thPlaceId` set means
 *    the place is the address: a NEW link sends `placeId` alone, the stored
 *    link sends nothing (the server refuses address fields on a linked listing
 *    without `placeId: null`). Leaving a link sends `placeId: null`, plus the
 *    typed address when `include.venue`. A link change rides whatever
 *    `include` says: `include` is about the address moving, and the server
 *    decides the notice from the columns the link actually moves.
 */
export function buildCommunityUpdateFields(
  input: BuildCommunityUpdateFieldsInput,
): CommunityUpdateFields {
  const {
    title,
    startsAtLocal,
    endsAtLocal,
    timezone,
    location,
    bodyContent,
    bodyBlockId,
    categoryId,
    heroImageId,
    include = { schedule: true, venue: true },
    savedPlaceId,
  } = input;

  const fields: CommunityUpdateFields = {
    title: title.trim(),
    timezone,
    content: {
      layoutId: "default" as const,
      blocks: [{ id: bodyBlockId, type: "richText" as const, doc: bodyContent }],
    },
  };

  if (include.schedule) {
    if (startsAtLocal) {
      fields.startsAt = toIsoInTimeZone(startsAtLocal, timezone);
    }
    if (endsAtLocal) {
      fields.endsAt = toIsoInTimeZone(endsAtLocal, timezone);
    }
  }

  const linkedPlaceId = location.thPlaceId ?? null;
  const storedPlaceId = savedPlaceId ?? null;
  if (linkedPlaceId) {
    // Rule 5: the place supplies the address. Never send geo with a link.
    if (linkedPlaceId !== storedPlaceId) fields.placeId = linkedPlaceId;
  } else {
    if (storedPlaceId) fields.placeId = null;
    if (include.venue) {
      Object.assign(fields, buildCommunityGeoFields(location));
    }
  }

  fields.categoryId = categoryId ?? null;

  if (heroImageId !== undefined) {
    fields.heroImageId = heroImageId;
  }

  return fields;
}

/**
 * The geo half of the whitelist, built from builder state — the ONE place the
 * address/pin mapping lives, so {@link diffCommunityMaterialGroups} compares
 * exactly the values {@link buildCommunityUpdateFields} would send. A separate
 * comparison would be free to drift, and the thing it would drift about is
 * whether attendees get told the venue moved.
 *
 * Empty for an un-geocoded address: `parseSuggestionFields` rejects a diff
 * carrying one of lat/lng without the other (`lat_lng_must_pair`), so a
 * half-filled location contributes nothing rather than a lone `addressText`.
 */
export function buildCommunityGeoFields(
  location: LocationState,
): Pick<
  CommunityUpdateFields,
  | "addressText"
  | "lat"
  | "lng"
  | "countryCode"
  | "region"
  | "locality"
  | "postalCode"
> {
  if (!communityLocationIsPinned(location)) return {};

  return {
    addressText: location.addressText!.trim(),
    lat: location.lat!,
    lng: location.lng!,
    // Omitted rather than nulled when absent: `countryCode` is non-nullable in
    // the whitelist, so "unknown" has to mean "don't touch it".
    ...(location.countryCode
      ? { countryCode: location.countryCode.toUpperCase() }
      : {}),
    region: location.region?.trim() || null,
    locality: location.locality?.trim() || null,
    postalCode: location.postalCode?.trim() || null,
  };
}

/** The stored listing a live save is diffed against (`getEventForEdit`). */
export type CommunitySavedSnapshot = {
  startsAt?: string | Date | null;
  endsAt?: string | Date | null;
  addressText?: string | null;
  lat?: number | null;
  lng?: number | null;
  countryCode?: string | null;
  region?: string | null;
  locality?: string | null;
  postalCode?: string | null;
  /** The stored place link; null/absent = unlinked. */
  placeId?: string | null;
};

/**
 * What a live save would change, in two readings that differ on purpose:
 *
 * - `schedule` / `venue` — what the server will NOTIFY for (FR-013), and so
 *   what the live-save confirm lists. The confirm must not promise a notice
 *   the server will not send.
 * - `include` — which groups ride on the wire
 *   ({@link buildCommunityUpdateFields}'s `include`). The address group rides
 *   whenever any of its values differs, so a corrected postcode or a
 *   reformatted street line is saved even though it tells nobody.
 *
 * `venue` implies `include.venue`; the reverse does not hold.
 */
export type CommunityLiveSaveDiff = CommunityMaterialGroups & {
  include: CommunityMaterialGroups;
};

/**
 * Which groups this save would actually change, and which of those notify.
 *
 * ## Why the builder has to know this
 *
 * The builder sends the whole form every time. The server reads a schedule
 * change off the KEY SET it receives, so a live listing whose moderator fixed
 * one typo used to arrive carrying `startsAt`, `endsAt` and the seven geo keys
 * unchanged, and `recordCommunityEditApplied` mailed everyone who RSVP'd or
 * saved the event, twice, about nothing. Feeding `include` back into
 * {@link buildCommunityUpdateFields} keeps the sent key set honest.
 *
 * ## Venue: the pin or the street line
 *
 * The server's venue rule is `addressVenueChanged`: the pin moves more than
 * 50 m (or appears or disappears), OR the normalized street line differs, for
 * a first link to a place and for a typed address alike; a move from one
 * place to another is always a venue change. Re-picking the
 * same address from the suggestions returns a pin a few metres off and its
 * own formatting: those values are sent (`include.venue`) but are no venue
 * change (`venue`), so no confirm row and no notice. The building next door,
 * or a reverse geocode of an unchanged pin naming a different street address,
 * IS a venue change. This module calls the server's own function, so the two
 * cannot disagree.
 *
 * Schedule comparison is EXACT, by instant — deliberately not rounded to the
 * minute the `datetime-local` control can express. A stored start with a
 * non-zero seconds component really would be rewritten by a save, and the
 * server really would notify for it. Over-warning is the safe side there.
 *
 * `null` saved state (the edit read has not landed) reports everything
 * changed: the caller has nothing to compare against, and the safe default on
 * a live listing is to send both groups and show the confirm.
 */
export function diffCommunityMaterialGroups(args: {
  startsAtLocal: string;
  endsAtLocal: string;
  timezone: string;
  location: LocationState;
  saved: CommunitySavedSnapshot | null | undefined;
}): CommunityLiveSaveDiff {
  const { startsAtLocal, endsAtLocal, timezone, location, saved } = args;
  if (!saved) {
    return {
      schedule: true,
      venue: true,
      include: { schedule: true, venue: true },
    };
  }

  const schedule =
    (startsAtLocal !== "" &&
      !sameInstant(toIsoInTimeZone(startsAtLocal, timezone), saved.startsAt)) ||
    (endsAtLocal !== "" &&
      !sameInstant(toIsoInTimeZone(endsAtLocal, timezone), saved.endsAt));

  const venue = communityVenueChange(location, saved);
  return {
    schedule,
    venue: venue.moves,
    include: { schedule, venue: venue.send },
  };
}

/**
 * The venue (address) group: whether its values are sent, and whether the
 * venue moves, place link included.
 *
 * - Linked to the STORED place: nothing is sent and nothing moves.
 * - Linked to a DIFFERENT place: the server copies the place's address
 *   itself (`placeId` rides regardless of `include`). Moving from one stored
 *   place to another always moves: places share street lines and pins (three
 *   rooms at 1 Cannery Row). A FIRST link (the listing was unlinked) moves
 *   when `addressVenueChanged` says so (the place's pin and address text
 *   against the stored ones). A picked item with no pin (a withheld venue's
 *   redacted read) is unknown here and counts as a move: over-warning is the
 *   safe side.
 * - Unlinked (leaving a link included): the typed address is sent when any
 *   geo value differs from the stored columns, and moves when
 *   `addressVenueChanged` says so. Leaving a link at the same address sends
 *   nothing, so the save carries `placeId: null` alone.
 */
function communityVenueChange(
  location: LocationState,
  saved: CommunitySavedSnapshot,
): { send: boolean; moves: boolean } {
  const linkedPlaceId = location.thPlaceId ?? null;
  if (linkedPlaceId) {
    const storedPlaceId = saved.placeId ?? null;
    if (linkedPlaceId === storedPlaceId) {
      return { send: false, moves: false };
    }
    // `saved.placeId` is the stored link, `location.thPlaceId` the current
    // pick. A stored link that differs is a move from one place to another:
    // always a venue change, as on the server (`applyPlaceLink`).
    const moves =
      storedPlaceId !== null ||
      location.lat == null ||
      location.lng == null
        ? true
        : addressVenueChanged(saved, {
            lat: location.lat,
            lng: location.lng,
            addressText: location.addressText,
            postalCode: location.postalCode,
          });
    return { send: moves, moves };
  }
  const geo = buildCommunityGeoFields(location);
  const send = (Object.keys(geo) as Array<keyof typeof geo>).some(
    (key) => !sameGeoValue(geo[key], saved[key]),
  );
  // `geo` carries a pin whenever it is non-empty (`communityLocationIsPinned`).
  const moves = send && addressVenueChanged(saved, geo);
  return { send, moves };
}

/** Two date-likes naming the same moment. A missing side never matches. */
function sameInstant(
  proposed: string,
  stored: string | Date | null | undefined,
): boolean {
  if (stored == null) return false;
  const a = Date.parse(proposed);
  const b = stored instanceof Date ? stored.getTime() : Date.parse(stored);
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}

/**
 * One geo field, compared the way the column stores it: the builder's `null`
 * for a blank optional and the read's `null`/`undefined` are the same absence.
 */
function sameGeoValue(
  proposed: string | number | null | undefined,
  stored: string | number | null | undefined,
): boolean {
  const left = proposed ?? null;
  const right = stored ?? null;
  return left === right;
}

/**
 * A community listing needs a real pin: `createCommunityListing` requires
 * `addressText` + `lat` + `lng` + `countryCode` because an ownerless listing
 * has no Place and no saved-location fallback for map/discovery surfaces.
 *
 * For a TYPED address only. `thPlaceId` is not consulted, and the builder
 * skips this check for a linked location: the server copies the address from
 * the place and refuses a withholding or unpinned venue with its own reason
 * (`PLACE_WITHHOLDS_ADDRESS` / `PLACE_LOCATION_INCOMPLETE`).
 */
export function communityLocationIsPinned(location: LocationState): boolean {
  return Boolean(
    location.addressText?.trim() && location.lat != null && location.lng != null,
  );
}

/** The event is an ownerless community listing (vs an owned, ticketable one). */
export function isCommunityStewardship(
  stewardship: string | null | undefined,
): boolean {
  return stewardship === "COMMUNITY";
}

/**
 * The three statuses in which a community listing can no longer be saved.
 * `updateListing` refuses each with a status-specific code
 * (ARCHIVED → `EVENT_ARCHIVED`; CANCELLED / COMPLETED → `EVENT_NOT_EDITABLE`).
 */
export const COMMUNITY_LOCKED_STATUSES = [
  "CANCELLED",
  "COMPLETED",
  "ARCHIVED",
] as const;

export type CommunityLockedStatus = (typeof COMMUNITY_LOCKED_STATUSES)[number];

/**
 * The status a community listing is locked in, or `null` when it is editable.
 *
 * PUBLISHED is EDITABLE as of 2026-09-16 — `community.updateListing` takes a
 * live listing now, so the builder opens one as a real form. What it will not
 * take is a listing in one of its three end states: rewriting a cancelled,
 * completed or archived listing would rewrite history for everyone already
 * holding a notice about it. Those get the read-only surface instead of a form
 * whose Save answers CONFLICT.
 *
 * Returns the status rather than a boolean so the notice can name it — a
 * cancelled listing and an archived one are different facts to a moderator,
 * and "you cannot edit this" is not one of them.
 *
 * Owned events are never locked here: the ticketed builder has its own status
 * rules and this must stay inert for it.
 */
export function communityLockedStatus(
  stewardship: string | null | undefined,
  status: string | null | undefined,
): CommunityLockedStatus | null {
  if (!isCommunityStewardship(stewardship)) return null;
  return (COMMUNITY_LOCKED_STATUSES as readonly string[]).includes(
    status ?? "",
  )
    ? (status as CommunityLockedStatus)
    : null;
}

/** A live listing: saving one is public immediately and may notify people. */
export function communityIsLive(
  stewardship: string | null | undefined,
  status: string | null | undefined,
): boolean {
  return isCommunityStewardship(stewardship) && status === "PUBLISHED";
}

/**
 * "FRI AUG 1 · 8:00 PM – 11:00 PM" — the schedule as the confirm dialog shows
 * it, in the listing's own timezone (the same reading the Dates page gives).
 *
 * The end carries its own date when it lands on a different day, because a
 * bare "– 1:00 AM" beside an 8:00 PM start reads as a show that ran backwards.
 */
export function formatCommunityScheduleWindow(args: {
  start: Date;
  end: Date | null;
  timeZone: string;
  locale: string;
}): string {
  const { start, end, timeZone, locale } = args;
  const startDate = formatRowDate(start, timeZone, locale);
  const startLabel = `${startDate} · ${formatRowTime(start, timeZone, locale)}`;
  if (!end) return startLabel;

  const endDate = formatRowDate(end, timeZone, locale);
  const endTime = formatRowTime(end, timeZone, locale);
  return endDate === startDate
    ? `${startLabel} – ${endTime}`
    : `${startLabel} – ${endDate} · ${endTime}`;
}

/**
 * The address as the confirm dialog shows it.
 *
 * `addressText` alone is not enough: the geo group counts as moved when ANY of
 * its seven fields changes, so a corrected locality or postal code with an
 * unchanged street line would render "Now: X / After saving: X" — a diff that
 * shows no difference. The structured parts are appended, and only the ones
 * the street line does not already contain (a geocoded `addressText` usually
 * carries the city and state, and repeating them reads as a stutter).
 *
 * Empty string when there is nothing to show; the caller supplies its own
 * "not set" copy rather than this inventing a sentence.
 */
export function formatCommunityAddressLabel(parts: {
  addressText?: string | null;
  locality?: string | null;
  region?: string | null;
  postalCode?: string | null;
}): string {
  const base = parts.addressText?.trim() ?? "";
  const haystack = base.toLowerCase();
  const extras = [parts.locality, parts.region, parts.postalCode]
    .map((value) => value?.trim() ?? "")
    .filter((value) => value !== "" && !haystack.includes(value.toLowerCase()));
  return [base, ...extras].filter((value) => value !== "").join(" · ");
}

/** Builder field ids a whitelist rejection can be anchored to. */
export type CommunityAnchorField = "title" | "startsAt" | "endsAt";

/**
 * Resolve an `EDIT_SUGGESTION_INVALID_FIELDS` rejection into the builder field
 * it belongs to, so the message lands next to the offending control instead of
 * in a toast the reader has to map back onto a form by themselves.
 *
 * Returns `null` when the rejection is about something the builder has no
 * anchor for (the body, the geo group, the hero) — the caller then shows it in
 * the form-level banner.
 */
export function anchorCommunityFieldError(
  error: unknown,
): { field: CommunityAnchorField; messageKey: string } | null {
  const meta = getInvalidFieldsMeta(error);
  if (!meta) return null;

  if (meta.reason === "ends_before_starts") {
    return { field: "endsAt", messageKey: "suggestEdit.errEndsBeforeStarts" };
  }

  const anchorable: readonly CommunityAnchorField[] = [
    "title",
    "startsAt",
    "endsAt",
  ];
  const hit = meta.fields?.find((name): name is CommunityAnchorField =>
    (anchorable as readonly string[]).includes(name),
  );
  if (!hit) return null;

  return {
    field: hit,
    messageKey:
      meta.reason === "blocked_content"
        ? "suggestEdit.errBlockedContent"
        : "errors.editSuggestionInvalidFields",
  };
}

/** `meta.reason` on an `INVALID_INPUT` place-link refusal → its message key. */
const PLACE_LINK_REFUSAL_KEYS: Readonly<Record<string, string>> = {
  PLACE_WITHHOLDS_ADDRESS: "communityBuilder.errPlaceWithholdsAddress",
  PLACE_LOCATION_INCOMPLETE: "communityBuilder.errPlaceLocationIncomplete",
};

/**
 * The message key for a place link the server refused as `INVALID_INPUT`
 * (`resolveListingPlaceLocation`): the venue withholds its address, or has no
 * full address and pin. `null` for anything else.
 *
 * Needed because `INVALID_INPUT` alone resolves to the generic invalid-input
 * copy, which tells the moderator nothing about the venue. The other place
 * refusals (`PLACE_NOT_FOUND` / `PLACE_ARCHIVED` / `PLACE_NOT_ACTIVE`) carry
 * their own codes and already resolve to `errors.*` copy through
 * `normalizeError`.
 */
export function communityPlaceRefusalMessageKey(error: unknown): string | null {
  if (getAppErrorCode(error) !== "INVALID_INPUT") return null;
  const reason = getInvalidFieldsMeta(error)?.reason;
  return (reason && PLACE_LINK_REFUSAL_KEYS[reason]) || null;
}
