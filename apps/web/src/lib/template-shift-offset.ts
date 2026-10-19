/**
 * Helpers for editing volunteer-template shifts in the UI.
 *
 * Templates store start/end as time-of-day (minute-of-day, 0–1439) plus
 * a day offset from the event date. The editor exposes those as a
 * native `<input type="time">` (HH:MM) and a "day" dropdown. When the
 * user picks an end-time earlier than start, the helper marks the shift
 * as wrapping past midnight (`endsNextDay`).
 */

export interface ShiftDraftFields {
  id: string;
  label: string;
  /**
   * "HH:MM" — what `<input type="time">` round-trips.
   *
   * On an ANCHORED preset these two stop naming a wall clock and carry only
   * the shift's DURATION (`end - start`, plus a day when it wraps). They are
   * still stored, so flipping the anchor back to "clock time" restores the
   * original times rather than losing them — the invariant stated on
   * `roleTemplateShiftDraftSchema.anchor`.
   */
  startTime: string;
  endTime: string;
  /** Day offset from the event date, e.g. -1 = day before, 0 = event day, 1 = day after. */
  dayOffset: string;
  capacity: string;
  /** What the start is measured from. Defaults to `WALL_CLOCK`. */
  anchor: TemplateShiftAnchor;
  /** Signed minutes from the anchor, as typed. Forced to 0 on `WALL_CLOCK`. */
  offsetMinutes: string;
  /**
   * Which way the offset points, HELD independently of its sign.
   *
   * EDITOR STATE, never sent to the server — {@link parseShiftDraftFields}
   * ignores it and reads the sign of `offsetMinutes`, which stays the single
   * source of truth for what gets saved.
   *
   * It lives on the draft ROW rather than inside `ShiftAnchorFields` because a
   * magnitude legitimately passes through zero (clearing the hours box to
   * retype it is the ordinary way to edit a number) and `-0` stringifies to
   * `"0"` — so at exactly `0` the sign says nothing and the direction has to be
   * remembered. Component-local `useState` remembered it only for as long as
   * the component stayed mounted: `InlineShiftComposer`'s "Time it from the
   * event" panel unmounts the control on Cancel while the fields survive in the
   * parent, and reopening re-seeded the direction to "after" — a direction the
   * organizer never chose, silently turning "load-out 3h before doors" into 3h
   * after. Undefined = derive from the sign (the seeded-from-server case).
   */
  offsetDirection?: "before" | "after";
}

export interface ParsedShiftDraft {
  label: string;
  startMinuteOfDay: number;
  endMinuteOfDay: number;
  startDayOffset: number;
  endsNextDay: boolean;
  capacity: number | null;
  anchor: TemplateShiftAnchor;
  offsetMinutes: number;
}

export type ShiftDraftFieldError =
  | "label_required"
  | "start_invalid"
  | "end_invalid"
  | "ends_equal_start"
  | "day_offset_invalid"
  | "capacity_invalid"
  | "offset_invalid";

export interface ShiftDraftErrors {
  label?: ShiftDraftFieldError;
  startTime?: ShiftDraftFieldError;
  endTime?: ShiftDraftFieldError;
  dayOffset?: ShiftDraftFieldError;
  capacity?: ShiftDraftFieldError;
  offsetMinutes?: ShiftDraftFieldError;
}

const newDraftId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `template-shift-${Math.random().toString(36).slice(2, 10)}`;

const MIN_DAY_OFFSET = -7;
const MAX_DAY_OFFSET = 14;
const MINUTES_PER_DAY = 24 * 60;

/**
 * Offset cap, mirroring `MAX_ANCHOR_OFFSET_MINUTES` in
 * `packages/core/src/use-cases/volunteering/schemas.ts`. Anything beyond a day
 * is `startDayOffset`'s job, and the cap is what stops a minutes-vs-seconds
 * typo scheduling a shift twelve days early.
 */
export const MAX_ANCHOR_OFFSET_MINUTES = MINUTES_PER_DAY;

/**
 * The wall clock an anchored preset carries when the organizer never set one.
 *
 * An anchored preset still needs a `startMinuteOfDay` (the schema requires it,
 * and it is what the times round-trip back to if the anchor is switched off),
 * but the editor hides the clock fields in anchored mode — so an empty row
 * would fail validation against a field that is not on screen. Noon is the
 * neutral carrier: it never wraps a same-day duration past midnight.
 */
export const ANCHORED_CARRIER_START_TIME = "12:00";

export function emptyShiftDraftFields(): ShiftDraftFields {
  return {
    id: newDraftId(),
    label: "",
    startTime: "",
    endTime: "",
    dayOffset: "0",
    capacity: "",
    anchor: "WALL_CLOCK",
    offsetMinutes: "0",
  };
}

/** Convert a stored minute-of-day (0–1439) into the `HH:MM` form used by `<input type="time">`. */
export function minuteOfDayToTime(minuteOfDay: number): string {
  if (
    !Number.isFinite(minuteOfDay) ||
    minuteOfDay < 0 ||
    minuteOfDay >= MINUTES_PER_DAY
  ) {
    return "";
  }
  const h = Math.floor(minuteOfDay / 60);
  const m = minuteOfDay - h * 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function timeToMinuteOfDay(time: string): number | null {
  const match = /^([0-2]\d):([0-5]\d)$/.exec(time);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isInteger(h) || h < 0 || h > 23) return null;
  if (!Number.isInteger(m) || m < 0 || m > 59) return null;
  return h * 60 + m;
}

/**
 * Validate + parse a single draft row. Returns the parsed payload on
 * success or a structured error on failure. Error codes map to locale
 * keys in the editor.
 */
export function parseShiftDraftFields(
  fields: ShiftDraftFields,
):
  | { ok: true; value: ParsedShiftDraft }
  | { ok: false; errors: ShiftDraftErrors } {
  const errors: ShiftDraftErrors = {};

  const label = fields.label.trim();
  if (label.length === 0) errors.label = "label_required";

  const start = timeToMinuteOfDay(fields.startTime);
  if (start === null) errors.startTime = "start_invalid";

  const end = timeToMinuteOfDay(fields.endTime);
  if (end === null) errors.endTime = "end_invalid";

  if (start !== null && end !== null && start === end) {
    // 0-length shifts make no sense and we don't have a "24-hour" toggle in the editor yet.
    errors.endTime = "ends_equal_start";
  }

  const dayOffsetRaw = fields.dayOffset.trim();
  const dayOffset = dayOffsetRaw === "" ? 0 : Number(dayOffsetRaw);
  if (
    !Number.isFinite(dayOffset) ||
    !Number.isInteger(dayOffset) ||
    dayOffset < MIN_DAY_OFFSET ||
    dayOffset > MAX_DAY_OFFSET
  ) {
    errors.dayOffset = "day_offset_invalid";
  }

  let capacity: number | null = null;
  const capStr = fields.capacity.trim();
  if (capStr !== "") {
    const n = Number(capStr);
    if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
      errors.capacity = "capacity_invalid";
    } else {
      capacity = n;
    }
  }

  // `offsetMinutes` is forced to 0 on a WALL_CLOCK preset rather than
  // validated: the server schema refuses a non-zero offset there ("there is
  // exactly one representation of no offset"), and a value left behind from a
  // previous anchor must not come back to life when the anchor is switched.
  const anchor = fields.anchor ?? "WALL_CLOCK";
  let offsetMinutes = 0;
  if (anchor !== "WALL_CLOCK") {
    const offsetRaw = (fields.offsetMinutes ?? "").trim();
    const parsed = offsetRaw === "" ? 0 : Number(offsetRaw);
    if (
      !Number.isFinite(parsed) ||
      !Number.isInteger(parsed) ||
      parsed < -MAX_ANCHOR_OFFSET_MINUTES ||
      parsed > MAX_ANCHOR_OFFSET_MINUTES
    ) {
      errors.offsetMinutes = "offset_invalid";
    } else {
      offsetMinutes = parsed;
    }
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  const startMin = start as number;
  const endMin = end as number;
  const endsNextDay = endMin < startMin;

  return {
    ok: true,
    value: {
      label,
      startMinuteOfDay: startMin,
      endMinuteOfDay: endMin,
      startDayOffset: dayOffset,
      endsNextDay,
      capacity,
      anchor,
      offsetMinutes,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Duration editing (the "Lasts" field)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The duration a draft row currently describes, in minutes, or null when the
 * time fields aren't both valid yet.
 *
 * Anchored or not, the duration is always `end - start` (wrapping past
 * midnight) — which is exactly what {@link templateShiftDurationMinutes}
 * computes off the stored record. The editor shows it as "Lasts" in anchored
 * mode, where the two clock fields are otherwise meaningless to the organizer.
 *
 * `start === end` is NULL here, not 1440. {@link templateShiftDurationMinutes}
 * wraps a non-positive difference by a day because a STORED row can only have
 * got there by wrapping; a DRAFT row reaches it by the organizer typing the
 * same time twice, which {@link parseShiftDraftFields} rejects as
 * `ends_equal_start`. Reporting "24 h 0 min" for a row that cannot save — with
 * the clock fields hidden in anchored mode — is a confident lie about a value
 * the organizer has no way to see, let alone fix.
 */
export function shiftDraftDurationMinutes(
  fields: Pick<ShiftDraftFields, "startTime" | "endTime">,
): number | null {
  const start = timeToMinuteOfDay(fields.startTime);
  const end = timeToMinuteOfDay(fields.endTime);
  if (start === null || end === null) return null;
  if (start === end) return null;
  return templateShiftDurationMinutes({
    startMinuteOfDay: start,
    endMinuteOfDay: end,
    endsNextDay: end < start,
  });
}

/**
 * Set a draft row's duration by moving its END time, keeping the start.
 *
 * Returns the `{ startTime, endTime }` patch to apply. When the row has no
 * usable start yet (the anchored case, where the clock fields are hidden) it
 * seeds {@link ANCHORED_CARRIER_START_TIME} so the row still validates against
 * a schema that requires both minute-of-day columns.
 *
 * A duration of a whole day or more is clamped to 23:59, matching the
 * `endMinuteOfDay !== startMinuteOfDay` rule the server enforces — the editor
 * has no 24-hour toggle.
 *
 * The floor is 1 minute for the same reason: a 0-length shift is not
 * representable. **Callers must not treat "both boxes empty" as a request for
 * 0** — this function would answer with 1 minute and write `12:01` into the end
 * time, which reads back as "0 h 1 min" and poisons the next keystroke
 * (`3` hours then saves 3 h 01, not 3 h 00). `ShiftAnchorFields` holds the raw
 * hours/minutes text and simply does not commit while the pair totals zero.
 */
export function withShiftDraftDurationMinutes(
  fields: Pick<ShiftDraftFields, "startTime" | "endTime">,
  durationMinutes: number,
): { startTime: string; endTime: string } {
  const startTime =
    timeToMinuteOfDay(fields.startTime) === null
      ? ANCHORED_CARRIER_START_TIME
      : fields.startTime;
  const start = timeToMinuteOfDay(startTime) as number;

  const safeDuration = Math.min(
    Math.max(Math.trunc(durationMinutes), 1),
    MINUTES_PER_DAY - 1,
  );
  const end = (start + safeDuration) % MINUTES_PER_DAY;
  return { startTime, endTime: minuteOfDayToTime(end) };
}

/** Split a minute total into whole hours + remaining minutes, for two inputs. */
export function splitMinutesToHoursAndMinutes(total: number): {
  hours: number;
  minutes: number;
} {
  const abs = Math.abs(Math.trunc(total));
  return { hours: Math.floor(abs / 60), minutes: abs % 60 };
}

/** A calendar date + wall-clock reading, as observed in some IANA zone. */
interface ZonedWallClock {
  year: number;
  /** 1-12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const zonedFormatterCache = new Map<string, Intl.DateTimeFormat>();

function buildZonedFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = zonedFormatterCache.get(timeZone);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = buildZonedFormatter(timeZone);
  } catch {
    // `Intl.DateTimeFormat` throws RangeError on an unrecognized zone id. This
    // code runs inside the template-apply success handler — i.e. *after* the
    // roles were created server-side — so throwing would leave the organizer
    // with roles and silently no shift drafts. Degrade to UTC: the drafts still
    // render and stay editable. `Event.timezone` is validated upstream, so this
    // is purely defensive.
    formatter = buildZonedFormatter("UTC");
  }
  zonedFormatterCache.set(timeZone, formatter);
  return formatter;
}

/** Read an instant as a wall-clock reading in `timeZone`. */
function readZonedWallClock(
  instantMs: number,
  timeZone: string,
): ZonedWallClock {
  const parts = zonedFormatter(timeZone).formatToParts(new Date(instantMs));
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part ? Number(part.value) : 0;
  };
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/**
 * UTC offset of `timeZone` at `instantMs`, in milliseconds
 * (e.g. -18_000_000 for US Central during daylight time).
 */
function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const wall = readZonedWallClock(instantMs, timeZone);
  const wallAsUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  // instantMs always carries 0 milliseconds here; floor anyway so a caller
  // passing sub-second precision can't skew the offset.
  return wallAsUtc - Math.floor(instantMs / 1000) * 1000;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Does `instantMs` read back in `timeZone` as exactly the wall clock we asked for? */
function readsBackAs(
  instantMs: number,
  wall: Omit<ZonedWallClock, "second">,
  timeZone: string,
): boolean {
  const readBack = readZonedWallClock(instantMs, timeZone);
  return (
    readBack.year === wall.year &&
    readBack.month === wall.month &&
    readBack.day === wall.day &&
    readBack.hour === wall.hour &&
    readBack.minute === wall.minute
  );
}

/**
 * Resolve a wall-clock reading in `timeZone` to the instant it names.
 *
 * We're solving `instant = naiveUtc - offset(instant)`, and the offset depends
 * on the instant. Rather than iterating towards a fixed point (which probes the
 * zone at `naiveUtc` interpreted as an instant — that lands *before* the
 * transition for negative-offset zones but *after* it for positive-offset ones,
 * inverting both DST branches), we **bracket** the transition:
 *
 * zone offsets run from -12:00 (Etc/GMT+12) to +14:00 (Pacific/Kiritimati) —
 * comfortably under a day — so the instant we want always lies inside
 * `[naiveUtc - 1d, naiveUtc + 1d]`. Probing the zone at both ends of that window
 * yields the offsets on either side of whatever transition could apply, and the
 * true offset is necessarily one of the two. That makes the candidate instants
 * an exhaustive solution set — no iteration, and no sensitivity to the sign of
 * the offset. (It assumes at most one transition inside a 48-hour window; no
 * zone in tzdata has ever had two, including the four-a-year Ramadan zones like
 * Africa/Casablanca.)
 *
 * Both DST edges then resolve with the offset in effect **before** the
 * transition, which is what ECMAScript's `UTC(t)` does and therefore what
 * `new Date(y, m, d, h, min)` did pre-FR-006 (NFR-001):
 *
 * - Fall-back overlap (the reading happens twice): both candidates read back
 *   correctly; `Math.min` takes the earlier one — the pre-transition occurrence.
 * - Spring-forward gap (the reading never happens): neither candidate reads
 *   back, so we fall through to the pre-transition offset. The result lands one
 *   transition-step *later* on the wall clock than asked (02:30 on a US
 *   spring-forward day resolves to the instant that reads 03:30).
 *
 * At most one candidate can be valid at a spring-forward edge and both can be
 * valid only at a fall-back edge, so `Math.min` is never picking between two
 * genuinely different intents. Off a transition the two probes report the same
 * offset and there is a single candidate.
 *
 * EXPORTED (2026-08-11) for the ticket-type scheduled price change
 * (time-based-ticket-pricing FR-007), which resolves an organizer's wall clock
 * against `Event.timezone`. The event builder's own `toIsoInTimeZone` probes
 * the zone ONCE, at `naiveUtc`, and is therefore an hour wrong for any reading
 * on the far side of a transition on the transition day — verified: Chicago
 * "2026-11-01T03:30" resolves to 08:30Z (02:30 CST) instead of 09:30Z, and
 * Sydney "2026-04-04T20:00" to 10:00Z instead of 09:00Z. A price flip must not
 * inherit that, hence this bracketing implementation is the shared one.
 * Additive change only — no existing caller's behaviour moves.
 */
export function zonedWallClockToInstant(
  wall: Omit<ZonedWallClock, "second">,
  timeZone: string,
): Date {
  const naiveUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    0,
    0,
  );

  const offsetBefore = zoneOffsetMs(naiveUtc - DAY_MS, timeZone);
  const offsetAfter = zoneOffsetMs(naiveUtc + DAY_MS, timeZone);
  const candidates =
    offsetBefore === offsetAfter
      ? [naiveUtc - offsetBefore]
      : [naiveUtc - offsetBefore, naiveUtc - offsetAfter];

  const valid = candidates.filter((instant) =>
    readsBackAs(instant, wall, timeZone),
  );

  return new Date(
    valid.length > 0 ? Math.min(...valid) : naiveUtc - offsetBefore,
  );
}

/** Shift a calendar date by whole days, free of any timezone. */
function addCalendarDays(
  date: { year: number; month: number; day: number },
  days: number,
): { year: number; month: number; day: number } {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/**
 * Split a minute-of-day into a day carry plus an hour/minute reading.
 *
 * `roleTemplateShiftDraftSchema` clamps stored presets to 0–1439, so the carry
 * is always 0 for real data; it stays because it's free and keeps a hypothetical
 * out-of-range value resolving to a real wall clock rather than one `Date.UTC`
 * normalizes behind the read-back check. A non-finite value is deliberately
 * **not** coerced — it propagates to an invalid Date and throws `RangeError`,
 * matching what the pre-FR-006 `setMinutes(NaN)` + `toISOString()` did instead
 * of silently materializing 00:00.
 */
function splitMinuteOfDay(minuteOfDay: number): {
  dayCarry: number;
  hour: number;
  minute: number;
} {
  const whole = Math.trunc(minuteOfDay);
  const dayCarry = Math.floor(whole / MINUTES_PER_DAY);
  const withinDay = whole - dayCarry * MINUTES_PER_DAY;
  return {
    dayCarry,
    hour: Math.floor(withinDay / 60),
    minute: withinDay % 60,
  };
}

/**
 * The instant at which it is 12:00 today in `timeZone`.
 *
 * Used as the reference when an event has no `startsAt`. It must be noon in the
 * **event's** zone rather than the browser's: `materializeTemplateShift` re-reads
 * the reference instant's calendar day in `timeZone`, and browser-local noon
 * lands on the neighbouring calendar day whenever the two zones are more than
 * 12 hours apart (a browser on Asia/Tokyo, +9, applying to an America/Chicago
 * event, -6, is 15 hours out). Anchoring to the event zone's own "today" makes
 * the round trip exact for every offset.
 *
 * @param now injectable for tests; defaults to the current instant.
 */
export function zonedNoonToday(timeZone: string, now: Date = new Date()): Date {
  const today = readZonedWallClock(now.getTime(), timeZone);
  return zonedWallClockToInstant(
    {
      year: today.year,
      month: today.month,
      day: today.day,
      hour: 12,
      minute: 0,
    },
    timeZone,
  );
}

/**
 * Materialize template offsets into concrete ISO `startsAt`/`endsAt`
 * against a reference timestamp (the event date or "today" fallback).
 *
 * Resolution happens in the **event's** timezone (`Event.timezone`), not the
 * browser's: we read the reference instant's calendar day in `timeZone`, add
 * `startDayOffset` days, and stamp the stored time-of-day as a wall clock in
 * that same zone. The end gets one more day when `endsNextDay` is true. An
 * organizer working from a different timezone than the venue therefore still
 * schedules "doors at 18:00" for 18:00 at the venue.
 *
 * Returns ISO 8601 instants (UTC). The composer converts those to the
 * `<input type="datetime-local">` format itself, so the contract with
 * `InlineShiftComposer` is unchanged — only the instants moved.
 *
 * @param timeZone IANA zone id, e.g. "America/Chicago".
 */
export function materializeTemplateShift(
  reference: Date,
  shift: {
    startMinuteOfDay: number;
    endMinuteOfDay: number;
    startDayOffset: number;
    endsNextDay: boolean;
  },
  timeZone: string,
): { startsAt: string; endsAt: string } {
  const referenceDay = readZonedWallClock(reference.getTime(), timeZone);
  const startDay = addCalendarDays(referenceDay, shift.startDayOffset);

  const startTime = splitMinuteOfDay(shift.startMinuteOfDay);
  const endTime = splitMinuteOfDay(shift.endMinuteOfDay);

  const start = zonedWallClockToInstant(
    {
      ...addCalendarDays(startDay, startTime.dayCarry),
      hour: startTime.hour,
      minute: startTime.minute,
    },
    timeZone,
  );

  const endDayCarry = (shift.endsNextDay ? 1 : 0) + endTime.dayCarry;
  const end = zonedWallClockToInstant(
    {
      ...addCalendarDays(startDay, endDayCarry),
      hour: endTime.hour,
      minute: endTime.minute,
    },
    timeZone,
  );

  return { startsAt: start.toISOString(), endsAt: end.toISOString() };
}

// ─────────────────────────────────────────────────────────────────────────────
// Anchored resolution (FR-005)
// ─────────────────────────────────────────────────────────────────────────────

/** Mirrors the Prisma `VolunteerShiftAnchor` enum. */
export type TemplateShiftAnchor = "WALL_CLOCK" | "EVENT_START" | "EVENT_END";

export interface AnchoredShiftFields {
  startMinuteOfDay: number;
  endMinuteOfDay: number;
  startDayOffset: number;
  endsNextDay: boolean;
  /** Omitted = WALL_CLOCK, i.e. exactly the pre-anchor behaviour. */
  anchor?: TemplateShiftAnchor;
  /** Signed minutes from the anchor. Ignored when the anchor is WALL_CLOCK. */
  offsetMinutes?: number;
}

/**
 * Everything a preset can be resolved against.
 *
 * `startsAt` / `endsAt` describe the OCCURRENCE the shift is being applied to,
 * and the caller is responsible for passing the right pair:
 *
 * - A plain event → `Event.startsAt` / `Event.endsAt`, both required columns,
 *   so both anchors always resolve.
 * - A recurring occurrence → `EventDate.startsAt` / `EventDate.endsAt`, and
 *   `EventDate.endsAt` is NULLABLE.
 *
 * When the occurrence has no end, an EVENT_END preset has nothing to resolve
 * against and {@link resolveTemplateShift} says so. It does NOT fall back to
 * the parent `Event.endsAt`: that would invent a shift time from a DIFFERENT
 * date — a 23:00 finish borrowed from another night's show — and write it as
 * if it were real. Callers must not paper over the `ok: false` by supplying
 * the parent event's end here.
 */
export interface ShiftResolutionTarget {
  /** IANA zone id of the venue, e.g. "America/Chicago". */
  timeZone: string;
  /** Calendar-day reference for WALL_CLOCK presets (occurrence date, or "today"). */
  reference: Date;
  /** The occurrence's start instant, or null when unknown. */
  startsAt: Date | null;
  /** The occurrence's end instant, or null (recurring occurrences may omit it). */
  endsAt: Date | null;
}

/** Why an anchored preset could not be resolved. Rendered as the disabled reason. */
export type TemplateShiftUnavailableReason =
  | "missing_event_start"
  | "missing_event_end";

export type ResolvedTemplateShift =
  | { ok: true; startsAt: string; endsAt: string }
  | { ok: false; reason: TemplateShiftUnavailableReason };

const MS_PER_MINUTE = 60 * 1000;

/**
 * A preset's duration, in minutes.
 *
 * On an anchored preset the stored `startMinuteOfDay` / `endMinuteOfDay` stop
 * naming wall-clock times and carry only the LENGTH of the shift — the anchor
 * positions the start, and the shift keeps its duration (the invariant stated
 * on `VolunteerRoleTemplateShift.offsetMinutes` in the schema). Anchoring the
 * end independently would let "doors −1h to close +1h" silently invert on a
 * short set.
 *
 * `endsNextDay` adds the day. A stored row with `end < start` and the flag
 * unset shouldn't exist (`upsertRoleTemplateShifts` infers it), but if one
 * does, wrapping it is the only reading that yields a forward-going shift.
 */
export function templateShiftDurationMinutes(shift: {
  startMinuteOfDay: number;
  endMinuteOfDay: number;
  endsNextDay: boolean;
}): number {
  let duration =
    Math.trunc(shift.endMinuteOfDay) -
    Math.trunc(shift.startMinuteOfDay) +
    (shift.endsNextDay ? MINUTES_PER_DAY : 0);
  if (duration <= 0) duration += MINUTES_PER_DAY;
  return duration;
}

/**
 * Move an instant by whole CALENDAR days in `timeZone`, keeping the wall
 * clock. "+1 day" at a venue means the same time tomorrow at that venue, which
 * is 23, 24 or 25 hours depending on DST — not a fixed 86 400 000 ms.
 *
 * `days === 0` returns the instant untouched rather than round-tripping it
 * through a wall clock. That matters at a fall-back overlap, where two
 * instants read as the same wall clock and re-resolving would snap to the
 * earlier one, silently moving a correctly-anchored shift by an hour.
 */
function addZonedCalendarDays(
  instant: Date,
  days: number,
  timeZone: string,
): Date {
  if (days === 0) return instant;
  const wall = readZonedWallClock(instant.getTime(), timeZone);
  return zonedWallClockToInstant(
    {
      ...addCalendarDays(wall, days),
      hour: wall.hour,
      minute: wall.minute,
    },
    timeZone,
  );
}

/**
 * Resolve a template shift preset to concrete instants, honouring its anchor
 * (FR-005).
 *
 * - **WALL_CLOCK** (default): delegates to {@link materializeTemplateShift}
 *   unchanged — `offsetMinutes` is ignored and `startMinuteOfDay` is stamped
 *   on the reference day exactly as before. This path is byte-identical to the
 *   pre-anchor behaviour and is covered by the legacy-equivalence matrix
 *   (NFR-001).
 * - **EVENT_START / EVENT_END**: the start is the occurrence's start (or end)
 *   plus the signed `offsetMinutes`, and the shift keeps its stored duration.
 *   A −180 preset is 17:00 for a 20:00 show and 11:00 for a 14:00 matinee.
 *
 * `startDayOffset` applies in ALL THREE cases, and means the same thing in
 * each: whole calendar days at the venue. For WALL_CLOCK it shifts the day the
 * time-of-day is stamped on; for an anchored preset it shifts the ALREADY
 * RESOLVED instant by that many venue days, keeping its wall clock across DST.
 * So EVENT_START −60 with `startDayOffset` +1 is "an hour before the show,
 * tomorrow" — the load-out crew arriving the next day at the same relative
 * hour. It is applied AFTER the offset, deliberately: the offset is a duration
 * measured from the show, the day offset is a calendar move, and doing it the
 * other way round would make a −20h offset silently cross the same midnight
 * twice.
 *
 * The unresolvable case is REPRESENTED, not guessed. An EVENT_END preset on an
 * occurrence with no end time returns `{ ok: false, reason:
 * "missing_event_end" }` so the caller can disable the row with a stated
 * reason. See {@link ShiftResolutionTarget} for why falling back to the parent
 * event's end is wrong.
 */
export function resolveTemplateShift(
  shift: AnchoredShiftFields,
  target: ShiftResolutionTarget,
): ResolvedTemplateShift {
  const anchor = shift.anchor ?? "WALL_CLOCK";

  if (anchor === "WALL_CLOCK") {
    return {
      ok: true,
      ...materializeTemplateShift(target.reference, shift, target.timeZone),
    };
  }

  const anchorInstant =
    anchor === "EVENT_START" ? target.startsAt : target.endsAt;
  if (!anchorInstant) {
    return {
      ok: false,
      reason:
        anchor === "EVENT_START" ? "missing_event_start" : "missing_event_end",
    };
  }

  const offsetMinutes = Math.trunc(shift.offsetMinutes ?? 0);
  const anchored = new Date(
    anchorInstant.getTime() + offsetMinutes * MS_PER_MINUTE,
  );
  const start = addZonedCalendarDays(
    anchored,
    Math.trunc(shift.startDayOffset),
    target.timeZone,
  );
  const end = new Date(
    start.getTime() + templateShiftDurationMinutes(shift) * MS_PER_MINUTE,
  );

  return { ok: true, startsAt: start.toISOString(), endsAt: end.toISOString() };
}
