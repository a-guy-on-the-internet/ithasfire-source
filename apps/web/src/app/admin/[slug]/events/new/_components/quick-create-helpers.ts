/**
 * Pure helpers for the quick-create page (event-builder regroup FR-301):
 * `/admin/:slug/events/new` is a focused 3-field form (title / starts-at /
 * venue) that creates a DRAFT via the SAME `createEventForHuman` /
 * `createEventForOrg` procedures the full builder saves through, then routes
 * to the event's Build surface.
 *
 * The payload mirrors what EventBuilder's save path would have sent for a
 * brand-new event with only the essentials filled in:
 * - location: a linked Place id, a fully geocoded freeform address (same
 *   branch as `handleSave`'s locationPayload), or `{}` — "no location", which
 *   `locationSchema` pins as a valid state. The venue is OPTIONAL here (owner
 *   ruling 2026-09-08): this picker only lists venues the organiser owns, so a
 *   third party names someone else's venue in the full builder, where the
 *   "All venues" search and the booking cascade live;
 * - visibility: omitted → server default `EXACT` with no reveal config
 *   (FR-103: new events default to "exact address, shown immediately");
 * - endsAt: starts + 2h (the default the old imperative
 *   `useCreateDraftEvent` draft used; the builder's own end-date nudge takes
 *   over from there);
 * - content: the empty default body.
 *
 * Pure (no React) so validation + payload construction are unit-testable
 * without rendering the form.
 */

import type { LocationState } from "./LocationSection";
import type { QuickCreatePrefill } from "@/lib/quick-create-prefill";
import { toIsoInTimeZone } from "./event-builder-helpers";

/** Default event length for a quick-created draft: 2 hours. */
export const QUICK_CREATE_DEFAULT_DURATION_MS = 2 * 60 * 60 * 1000;

export type QuickCreateFieldErrors = {
  title?: "required";
  startsAt?: "required";
  /**
   * Never "required" — the venue is optional. `unresolved` means the address
   * box holds typed text that was never picked from the suggestions (no
   * coordinates), or "use my location" dropped coordinates that never got an
   * address back from the reverse geocoder — either way the save would drop
   * the location on the floor.
   */
  venue?: "unresolved";
};

/**
 * A venue counts exactly like the builder's save path persists one: a linked
 * Ithas Fire Place, or a freeform address with coordinates. Truthiness (not
 * `!= null`) on lat/lng deliberately mirrors `handleSave` / `mapReadinessInput`
 * so this gate never diverges from what actually gets persisted.
 */
export function hasQuickCreateVenue(location: LocationState): boolean {
  return Boolean(
    location.thPlaceId ||
      (location.addressText && location.lat && location.lng),
  );
}

/**
 * Title and start are required (FR-301); the venue is not. Returns per-field
 * errors.
 *
 * An empty venue is a legitimate "pick it in the builder". What IS flagged is
 * a HALF venue — something the organiser asked for that the save would
 * silently throw away (the payload builder emits `{}` for anything short of
 * a linked Place or address + coordinates):
 *  - `addressSearch` (the raw text in the address box; address mode only —
 *    pass `""` in My Places mode) holds typed text that never became a pick;
 *  - the location carries coordinates with no `addressText` — "use my
 *    location" writes lat/lng first and the address only once the reverse
 *    geocode answers, which it may never do.
 */
export function validateQuickCreate(args: {
  title: string;
  startsAt: string | undefined;
  location: LocationState;
  addressSearch?: string;
}): QuickCreateFieldErrors {
  const errors: QuickCreateFieldErrors = {};
  if (!args.title.trim()) errors.title = "required";
  if (!args.startsAt) errors.startsAt = "required";
  const { location } = args;
  const hasCoordinatesOnly =
    location.lat != null && location.lng != null && !location.addressText;
  if (
    (args.addressSearch?.trim() || hasCoordinatesOnly) &&
    !hasQuickCreateVenue(location)
  ) {
    errors.venue = "unresolved";
  }
  return errors;
}

export type QuickCreateLocationPayload = {
  placeId?: string;
  addressText?: string;
  lat?: number;
  lng?: number;
  locality?: string;
  region?: string;
  countryCode?: string;
  postalCode?: string;
};

/**
 * Mirrors EventBuilder `handleSave`'s locationPayload branch exactly: a
 * linked Place sends only the UUID; a freeform address sends the geocoded
 * fields (optional ones only when present); nothing chosen sends `{}`, the
 * wire's "no location" (`locationSchema` in save-event-shared accepts it and
 * `normalizeLocation` reads it as `kind: "none"`).
 */
export function buildQuickCreateLocationPayload(
  location: LocationState,
): QuickCreateLocationPayload {
  const payload: QuickCreateLocationPayload = {};
  if (location.thPlaceId) {
    payload.placeId = location.thPlaceId;
  } else if (location.addressText && location.lat && location.lng) {
    payload.addressText = location.addressText;
    payload.lat = location.lat;
    payload.lng = location.lng;
    if (location.locality) payload.locality = location.locality;
    if (location.region) payload.region = location.region;
    if (location.countryCode) payload.countryCode = location.countryCode;
    if (location.postalCode) payload.postalCode = location.postalCode;
  }
  return payload;
}

export type QuickCreatePlacementPayload = {
  calendarId?: string;
  spaceId?: string;
};

/**
 * Venue-hierarchy placement to send with the save (FR-011).
 *
 * The placement belongs to the VENUE the calendar cell lives on. If the
 * organiser changed the venue picker away from the prefilled place — or
 * switched to a freeform address entirely — the carried `calendarId`/`spaceId`
 * point at ANOTHER place's rows, and the save path rejects them
 * (`CALENDAR_NOT_FOUND` / `SPACE_NOT_FOUND`, the cross-place isolation
 * invariant). So we DROP the placement instead of sending a payload that is
 * guaranteed to fail: changing the venue is a legitimate act, not an error.
 *
 * Same rule when there was no prefilled place to begin with: a hand-edited
 * `?calendarId=` with no `?placeId=` carries no proof it belongs anywhere.
 */
export function resolveQuickCreatePlacement(args: {
  prefill: QuickCreatePrefill;
  location: LocationState;
}): QuickCreatePlacementPayload {
  const { prefill, location } = args;
  if (!prefill.placeId || location.thPlaceId !== prefill.placeId) {
    return {};
  }
  return {
    ...(prefill.calendarId ? { calendarId: prefill.calendarId } : {}),
    ...(prefill.spaceId ? { spaceId: prefill.spaceId } : {}),
  };
}

export type QuickCreateSaveInput = {
  title: string;
  startsAt: string;
  endsAt: string;
  location: QuickCreateLocationPayload;
  timezone: string;
  content: { layoutId: "default"; blocks: never[] };
  clientKey: string;
} & QuickCreatePlacementPayload;

/**
 * The full mutation input (minus the org id, which the org variant spreads
 * on top). `startsAtLocal` is the raw `datetime-local` string; it is
 * interpreted in `timezone` — the same `toIsoInTimeZone` basis the builder
 * saves with.
 */
export function buildQuickCreateSaveInput(args: {
  title: string;
  startsAtLocal: string;
  timezone: string;
  location: LocationState;
  clientKey: string;
  /**
   * The calendar cell's context (FR-011), when the organiser arrived from one.
   * Contributes `calendarId`/`spaceId` ONLY while the venue still matches —
   * see {@link resolveQuickCreatePlacement}.
   */
  prefill?: QuickCreatePrefill;
}): QuickCreateSaveInput {
  const startsAtIso = toIsoInTimeZone(args.startsAtLocal, args.timezone);
  const endsAtIso = new Date(
    new Date(startsAtIso).getTime() + QUICK_CREATE_DEFAULT_DURATION_MS,
  ).toISOString();
  return {
    title: args.title.trim(),
    startsAt: startsAtIso,
    endsAt: endsAtIso,
    location: buildQuickCreateLocationPayload(args.location),
    timezone: args.timezone,
    content: { layoutId: "default", blocks: [] },
    clientKey: args.clientKey,
    ...resolveQuickCreatePlacement({
      prefill: args.prefill ?? {},
      location: args.location,
    }),
  };
}
