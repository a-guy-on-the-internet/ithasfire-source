// ─────────────────────────────────────────────────────────────────────────────
// Availability onboarding — pure helpers (availability-onboarding spec,
// FR-001 / FR-002).
//
// A Place with ZERO CalendarAvailability rows computes every day as `closed`,
// which makes a venue that turned on booking requests silently uncontactable —
// the public form's required "preferred dates" field has no attainable value.
// The word for that state is UNCONFIGURED ("never set hours"), which is a
// different sentence from "dark" ("deliberately closed that day") and must
// never be rendered as one.
//
// The detector is ONE server read, `places.getAvailabilitySetupState`
// (authed, owner-gated):
//
//   { configured: boolean, calendarCount: number, defaultCalendarId: string | null }
//
// exposed once and consumed by every surface — the warning under the booking
// toggle, the hours modal, the bookings-workspace banner. Nothing re-derives
// it client-side, so the surfaces can never disagree about whether the venue
// is reachable.
//
// Presets seed rows THROUGH `places.upsertCalendarAvailability` — the same
// full-PUT write path the hours editor commits on blur (see
// venue-calendars-helpers.ts). No bulk endpoint, no bypassed validation, and
// every seeded row is immediately editable in the editor below the presets.
// ─────────────────────────────────────────────────────────────────────────────

import {
  WEEKDAY_ORDER,
  hoursUpsertFields,
  type AvailabilityScope,
  type AvailabilityUpsertFields,
} from "./venue-calendars-helpers";

/**
 * Shape of `places.getAvailabilitySetupState` (availability-onboarding spec,
 * `detector.placement`). Mirrored here so the pure helpers stay testable while
 * the router procedure is being built in parallel.
 */
export type AvailabilitySetupState = {
  configured: boolean;
  calendarCount: number;
  defaultCalendarId: string | null;
};

export type HoursPresetId =
  | "evenings_thu_sat"
  | "evenings_wed_sun"
  | "every_night"
  | "weekends";

export type HoursPreset = {
  id: HoursPresetId;
  /** i18n key for the visible label. */
  labelKey: string;
  /** Weekdays in JS `getDay()` numbering (0 = Sunday). */
  days: readonly number[];
  startTime: string;
  endTime: string;
};

/**
 * The four starter schedules (spec FR-002 `presets.set`). Times are the
 * editor's own "HH:MM" strings; `every_night` ends at 02:00 DELIBERATELY —
 * a night that runs past midnight is one night, and the editors' overnight
 * helper (`isOvernight`) already renders it with a "next day" marker.
 */
export const HOURS_PRESETS: readonly HoursPreset[] = [
  {
    id: "evenings_thu_sat",
    labelKey: "admin.calHoursPresetThuSat",
    days: [4, 5, 6],
    startTime: "19:00",
    endTime: "00:00",
  },
  {
    id: "evenings_wed_sun",
    labelKey: "admin.calHoursPresetWedSun",
    days: [3, 4, 5, 6, 0],
    startTime: "19:00",
    endTime: "00:00",
  },
  {
    id: "every_night",
    labelKey: "admin.calHoursPresetEveryNight",
    days: [...WEEKDAY_ORDER],
    startTime: "18:00",
    endTime: "02:00",
  },
  {
    id: "weekends",
    labelKey: "admin.calHoursPresetWeekends",
    days: [6, 0],
    startTime: "12:00",
    endTime: "00:00",
  },
];

/**
 * Full-PUT create payloads for one preset — one row per weekday, in
 * Monday-first order so the writes land in the order the editor lists days.
 * Each payload goes through `hoursUpsertFields`, which is what pins
 * `isOpen: true`, `date: null`, and the scope-on-create semantics the editor's
 * own writes obey.
 */
export function presetUpsertFields(
  preset: HoursPreset,
  scope: AvailabilityScope,
): AvailabilityUpsertFields[] {
  const order = WEEKDAY_ORDER as readonly number[];
  return [...preset.days]
    .sort((a, b) => order.indexOf(a) - order.indexOf(b))
    .map((dayOfWeek) =>
      hoursUpsertFields({
        scope,
        dayOfWeek,
        startTime: preset.startTime,
        endTime: preset.endTime,
      }),
    );
}

/**
 * Presets are offered ONLY while the detector says unconfigured (spec FR-002
 * `presets.rules`). `undefined` (query not answered yet) offers nothing — a
 * preset that replaced a venue's real hours because the read was still in
 * flight would be a data-loss bug, so absence of an answer means absence of
 * presets.
 */
export function shouldOfferPresets(
  state: AvailabilitySetupState | undefined,
): boolean {
  return state !== undefined && !state.configured;
}

/**
 * The scope the modal opens on (spec FR-002 `scope_opened`): the place's
 * default calendar when one exists, else the place-wide `null` scope — one
 * row set that covers every calendar, the honest default for a venue that has
 * not thought about streams yet.
 */
export function setupScope(
  state: AvailabilitySetupState | undefined,
): AvailabilityScope {
  return state?.defaultCalendarId ?? null;
}

/**
 * FR-001: the warning renders only when the venue is (a) actually accepting
 * requests — verified AND toggled on — and (b) known-unconfigured. While the
 * detector query is unanswered (`state === undefined`) nothing renders: a
 * warning that flashes and retracts teaches the reader to ignore it.
 */
export function shouldShowHoursWarning(args: {
  accepts: boolean;
  isVerified: boolean;
  state: AvailabilitySetupState | undefined;
}): boolean {
  return (
    args.accepts &&
    args.isVerified &&
    args.state !== undefined &&
    !args.state.configured
  );
}
