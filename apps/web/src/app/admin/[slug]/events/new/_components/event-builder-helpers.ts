import type { AddressRevealPreset, EventLocationMode } from "@th/types";

import { zonedWallClockToInstant } from "@/lib/template-shift-offset";

// ── Location-precision slider mapping ────────────────────────────────────────
//
// MOVED to `@/lib/location/obfuscation-radius` — the venue editor drives the
// same column now (place-address-withholding) and both surfaces must share one
// stop table. Re-exported here so the builder's existing imports (and its
// helper test) keep resolving from where they always did.
export {
  MIN_RADIUS_METERS,
  MAX_RADIUS_METERS,
  RADIUS_SLIDER_STOPS,
  HIDDEN_SLIDER_POSITION,
  radiusForSliderPosition,
  sliderPositionForRadius,
} from "@/lib/location/obfuscation-radius";

/**
 * Stored instant → `<input type="datetime-local">` reading in `timeZone`
 * (the browser's zone when omitted).
 *
 * This is the READ half of the builder's time round-trip and it is DST-exact
 * by construction: `Intl` is asked to format a real instant, so it applies
 * whichever offset was actually in force — there is no offset to guess. The
 * WRITE half is {@link toIsoInTimeZone}, which does have to solve for the
 * offset; the two are only symmetric because that one brackets the transition.
 *
 * The single irreducible asymmetry is the repeated hour at a fall-back: two
 * distinct instants format to the SAME reading here, and the write half has to
 * pick one (it picks the earlier). A `datetime-local` string carries no offset,
 * so no implementation of this pair can do better — pinned in
 * `__tests__/event-builder-helpers.dst.test.ts`.
 */
export const toDateTimeLocalValue = (
  value: Date | string | null | undefined,
  timeZone?: string,
): string => {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
};

export const toPickerIsoValue = (
  value: Date | string | null | undefined,
  timeZone?: string,
): string | undefined => {
  const localValue = toDateTimeLocalValue(value, timeZone);
  return localValue ? new Date(localValue).toISOString() : undefined;
};

/**
 * Is this an IANA zone id the runtime actually knows?
 *
 * Mirrors the check in `ticket-type-schedule.ts`, and for the same reason:
 * {@link zonedWallClockToInstant} DEGRADES an unrecognized zone to UTC (right
 * for its volunteer-draft caller — a still-editable draft beats no draft) and
 * that default is wrong for an event's start time, where it would silently
 * store a show up to 14 hours out with nothing on screen to show for it.
 */
export const isKnownTimeZone = (timeZone: string): boolean => {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
};

/**
 * Resolve an organizer's wall clock to the instant it names in `timeZone`.
 *
 * `value` is either a `datetime-local` reading (`YYYY-MM-DDTHH:mm`) or a full
 * ISO instant produced by {@link toPickerIsoValue} — i.e. a wall clock that was
 * stamped onto the BROWSER's zone by the date picker. The `length > 16` branch
 * unwraps that second form back to a bare wall clock (in the browser's zone,
 * which is where the picker put it) before it is resolved against the EVENT's
 * zone. That two-step is the picker's contract and is unchanged here.
 *
 * DST: the conversion goes through {@link zonedWallClockToInstant}, the repo's
 * bracketing resolver in `src/lib/template-shift-offset.ts`. It probes the zone
 * a day either side of the naive instant, so it sees the offsets on BOTH sides
 * of any transition and filters the candidates by reading each one back.
 *
 * This function previously probed the zone ONCE, at the naive-UTC instant, and
 * was therefore an hour wrong for any reading whose naive instant fell on the
 * far side of a transition — verified before the fix: Chicago "2026-11-01T03:30"
 * resolved to 08:30Z instead of 09:30Z, and Sydney "2026-04-04T20:00" to 10:00Z
 * instead of 09:00Z. Both hemispheres, both directions. Since the builder
 * prefills from the stored instant and re-resolves on EVERY save, that also
 * moved a published show by an hour on a save that never touched the time
 * field. Pinned in `__tests__/event-builder-helpers.dst.test.ts`.
 *
 * Two edge readings, both pinned by test:
 *  - GAP (a spring-forward wall clock that never happens): resolved with the
 *    PRE-transition offset, landing one transition step later on the clock —
 *    what ECMAScript's own local-time handling does with an impossible reading.
 *  - AMBIGUOUS (a fall-back wall clock that happens twice): resolved to the
 *    FIRST (earlier) occurrence.
 *
 * @throws RangeError when `timeZone` is not a zone id the runtime knows. That
 * is deliberate — see {@link isKnownTimeZone}; it is also what this function
 * did before the fix, since `Intl.DateTimeFormat` throws on an unknown zone,
 * so no caller's contract moves.
 */
export const toIsoInTimeZone = (value: string, timeZone: string): string => {
  const normalized = value.length > 16 ? toDateTimeLocalValue(value) : value;
  const [datePart, timePart] = normalized.split("T");
  if (!datePart || !timePart) return new Date(value).toISOString();

  if (!isKnownTimeZone(timeZone)) {
    throw new RangeError(`Invalid time zone specified: ${timeZone}`);
  }

  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute] = timePart.split(":").map(Number);

  return zonedWallClockToInstant(
    {
      year: year as number,
      month: month ?? 1,
      day: day ?? 1,
      hour: hour ?? 0,
      minute: minute ?? 0,
    },
    timeZone,
  ).toISOString();
};

export const getPreviewDateTimeIso = (
  value: string | undefined,
  timeZone: string,
): string | undefined => {
  return value ? toIsoInTimeZone(value, timeZone) : value;
};

/**
 * Preset shown in the editor. A null preset only occurs on legacy rows that
 * predate the mandatory-reveal model — display the spec default (DAY_BEFORE).
 * As long as the control is untouched, the save path sends `undefined` and the
 * server preserves the stored reveal date (see resolveAddressRevealSaveInput),
 * so this display fallback never overwrites data by itself.
 */
export const getEditableAddressRevealPreset = (
  preset: AddressRevealPreset | null | undefined,
): AddressRevealPreset => {
  return preset ?? "DAY_BEFORE";
};

type ResolveAddressRevealSaveInputArgs = {
  visibilityMode: EventLocationMode;
  selectedPreset: AddressRevealPreset;
  selectedCustomAt: string;
  eventTimezone: string;
  existingVisibilityMode?: EventLocationMode | null;
  existingPreset?: AddressRevealPreset | null;
  hasPresetBeenTouched: boolean;
};

export const resolveAddressRevealSaveInput = ({
  visibilityMode,
  selectedPreset,
  selectedCustomAt,
  eventTimezone,
  existingVisibilityMode,
  existingPreset,
  hasPresetBeenTouched,
}: ResolveAddressRevealSaveInputArgs): {
  addressRevealPreset: AddressRevealPreset | undefined;
  addressRevealAt: string | null;
} => {
  // EXACT events carry no reveal config — the server nulls both fields.
  if (visibilityMode !== "OBSCURED") {
    return {
      addressRevealPreset: undefined,
      addressRevealAt: null,
    };
  }

  // Legacy OBSCURED rows may predate the mandatory-preset model (null preset).
  // While the control is untouched, send `undefined` so the server preserves
  // the stored reveal date as CUSTOM (or applies its DAY_BEFORE default)
  // instead of overwriting it with whatever the UI happens to display —
  // see resolveAddressReveal in save-event-shared.ts. There is NO 'never
  // reveal': every OBSCURED event resolves to a concrete addressRevealAt.
  const preserveLegacyStoredReveal =
    existingVisibilityMode === "OBSCURED" &&
    existingPreset == null &&
    !hasPresetBeenTouched;

  if (preserveLegacyStoredReveal) {
    return {
      addressRevealPreset: undefined,
      addressRevealAt: null,
    };
  }

  return {
    addressRevealPreset: selectedPreset,
    addressRevealAt:
      selectedPreset === "CUSTOM" && selectedCustomAt
        ? toIsoInTimeZone(selectedCustomAt, eventTimezone)
        : null,
  };
};

/** Subset of the builder's local location state the publish pre-flight reads. */
export type BuilderLocationState = {
  thPlaceId?: string | null;
  addressText?: string | null;
  lat?: number | null;
  lng?: number | null;
};

/** Subset of the persisted event record the publish pre-flight reads. */
export type SavedEventLocation =
  | {
      placeId?: string | null;
      savedLocationId?: string | null;
      addressText?: string | null;
    }
  | null
  | undefined;

/**
 * True when the builder shows a chosen location that hasn't been persisted to
 * the event record yet. Publish reads the saved record, so publishing in this
 * state fails the server's EVENT_LOCATION_REQUIRED precondition even though a
 * location is visible — callers should prompt the user to Save first rather
 * than surface that misleading "add a location" error.
 *
 * The local-side check mirrors what `handleSave` actually persists (a Place id,
 * or a freeform address with coordinates), and the saved-side check mirrors the
 * server precondition (`placeId || savedLocationId || addressText`) so the gate
 * never diverges from it. Extracted as a pure function so it's unit-testable
 * without rendering the whole builder.
 */
export const isLocationUnsaved = (
  local: BuilderLocationState,
  saved: SavedEventLocation,
): boolean => {
  // Truthy (not `!= null`) to match `handleSave`'s persistence condition — a
  // 0/0 coordinate isn't sent there, so the gate must agree to avoid a
  // "save first" prompt with nothing to save.
  const hasLocal = Boolean(
    local.thPlaceId || (local.addressText && local.lat && local.lng),
  );
  const savedHasLocation = Boolean(
    saved?.placeId || saved?.savedLocationId || saved?.addressText,
  );
  return hasLocal && !savedHasLocation;
};

/**
 * True when a `datetime-local` start string resolves to a moment before `now`.
 * The native control pins `min` to "now", but a typed value can still land in
 * the past and the server doesn't reject it, so publish validates with this to
 * surface a clear message. Empty / unparseable values return false — emptiness
 * is handled by the separate required-field validation.
 *
 * The string is a wall-clock value in the event's timezone, so it's resolved
 * through `toIsoInTimeZone` before comparison — comparing the raw string with
 * `new Date()` would parse it in the *browser's* timezone and mis-judge the
 * past/future boundary for organizers in a different zone.
 */
export const isStartInPast = (
  startsAtLocal: string | undefined,
  eventTimezone: string,
  now: number = Date.now(),
): boolean => {
  if (!startsAtLocal) return false;
  // Reject values the parser can't read before handing to toIsoInTimeZone,
  // which would otherwise throw on an invalid Date.
  if (Number.isNaN(new Date(startsAtLocal).getTime())) return false;
  const startMs = new Date(
    toIsoInTimeZone(startsAtLocal, eventTimezone),
  ).getTime();
  if (Number.isNaN(startMs)) return false;
  return startMs < now;
};

// (The tab-bar helpers — nextInRing, OPS_TAB_ROUTE_SEGMENTS, getOpsTabHref —
// were removed with the temporary tab bar (FR-207): the ops surfaces live at
// their own routes and are reached from the contextual admin rail.)
