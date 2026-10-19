"use client";

/**
 * ShiftAnchorFields — the "Starts / By / Lasts" control for a volunteer shift
 * preset (FR-017).
 *
 * A preset used to be pure wall clock: "Load-in 16:00" is right for a 19:00
 * show and schedules load-in two hours AFTER the doors on a 14:00 matinee.
 * The anchor fixes that — a shift can be pinned to the event's start, the
 * event's end, or a fixed clock time, with a signed offset, so "load-in, three
 * hours before the show" survives contact with any showtime.
 *
 * Shared on purpose: the org template editor and the staff pack editor render
 * the same three fields against the same {@link ShiftDraftFields} shape. The
 * caller keeps ownership of the clock-time inputs, which only apply in
 * `WALL_CLOCK` mode.
 *
 * The preview is the point of the control. It resolves the preset — through
 * the very same {@link resolveTemplateShift} the apply flow uses, never a
 * parallel implementation — against every target the caller hands in. The
 * template editor passes two CONTRASTING showtimes so a wrong anchor is
 * visible before saving; the event composer passes the real event.
 */

import { useMemo, useRef, useState } from "react";
import { XStack, YStack } from "tamagui";
import { Text, TextInput, useFormatters, useTranslations } from "@th/ui";

import {
  MAX_ANCHOR_OFFSET_MINUTES,
  resolveTemplateShift,
  shiftDraftDurationMinutes,
  splitMinutesToHoursAndMinutes,
  withShiftDraftDurationMinutes,
  type ShiftDraftFields,
  type ShiftResolutionTarget,
  type TemplateShiftAnchor,
  type TemplateShiftUnavailableReason,
} from "@/lib/template-shift-offset";

// ─────────────────────────────────────────────────────────────────────────────
// Native control styling — matches the design system's TextInput chrome
// (40px, 1px ink border, radius 0). Same values as the sibling editors.
// ─────────────────────────────────────────────────────────────────────────────

const NATIVE_SELECT_STYLE: React.CSSProperties = {
  height: 40,
  padding: "0 12px",
  border: "1px solid var(--borderColor, #211C16)",
  borderRadius: 0,
  backgroundColor: "var(--surface, #FDFAF3)",
  color: "var(--color, #211C16)",
  fontFamily: "inherit",
  fontSize: 14,
  width: "100%",
  boxSizing: "border-box",
};

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ShiftAnchorPreviewTarget {
  id: string;
  /** Short human label for the column, e.g. "8:00 PM show". */
  label: string;
  target: ShiftResolutionTarget;
  /**
   * Force the calendar date into the preview. Off for the illustrative
   * showtimes (their date is fictional and would read as a promise); on for a
   * real event, where the organizer is picking a concrete shift.
   */
  alwaysShowDate?: boolean;
}

export interface ShiftAnchorFieldsProps {
  fields: ShiftDraftFields;
  onChange: (patch: Partial<ShiftDraftFields>) => void;
  disabled?: boolean;
  /** Prefix for `data-testid` / `aria-label` uniqueness across sibling rows. */
  testIdBase: string;
  /**
   * Restrict the Starts options. The event shift composer omits `WALL_CLOCK`:
   * that row already has concrete date-time inputs, so a second "clock time"
   * mode would be two controls writing the same instants.
   */
  anchorOptions?: TemplateShiftAnchor[];
}

export interface ShiftAnchorPreviewProps {
  fields: ShiftDraftFields;
  previewTargets: ShiftAnchorPreviewTarget[];
  testIdBase: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sample showtimes — the two contrasting previews (FR-017)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A FIXED reference day, deliberately not "today".
 *
 * The two sample showtimes exist to contrast 20:00 against 14:00, not to
 * predict a date. Deriving them from `new Date()` would render a different
 * string on the server and the client and trip a hydration mismatch, for a
 * date the preview then hides anyway.
 */
const SAMPLE_DAY = { year: 2026, month: 6, day: 13 } as const;

function sampleInstant(hour: number): Date {
  return new Date(SAMPLE_DAY.year, SAMPLE_DAY.month - 1, SAMPLE_DAY.day, hour);
}

/**
 * "8:00 PM show" and "2:00 PM matinee" — the pair from the spec's acceptance
 * criteria (an EVENT_START −180 preset must read 17:00 against one and 11:00
 * against the other).
 *
 * Resolved in the BROWSER's zone: there is no venue in the template editor, and
 * the labels are the browser's own wall clock, so the two must agree.
 */
export function useSampleShowtimeTargets(): ShiftAnchorPreviewTarget[] {
  const t = useTranslations();
  return useMemo(() => {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const build = (
      id: string,
      label: string,
      startHour: number,
      endHour: number,
    ): ShiftAnchorPreviewTarget => {
      const startsAt = sampleInstant(startHour);
      return {
        id,
        label,
        target: {
          timeZone,
          reference: startsAt,
          startsAt,
          endsAt: sampleInstant(endHour),
        },
      };
    };
    return [
      build(
        "evening",
        String(t("admin.volunteerShiftAnchorSampleEvening")),
        20,
        23,
      ),
      build(
        "matinee",
        String(t("admin.volunteerShiftAnchorSampleMatinee")),
        14,
        16,
      ),
    ];
  }, [t]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Copy helpers
// ─────────────────────────────────────────────────────────────────────────────

export function shiftAnchorUnavailableMessage(
  t: ReturnType<typeof useTranslations>,
  reason: TemplateShiftUnavailableReason,
): string {
  return String(
    t(
      reason === "missing_event_start"
        ? "admin.volunteerShiftAnchorMissingEventStart"
        : "admin.volunteerShiftAnchorMissingEventEnd",
    ),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

const ANCHOR_ORDER: TemplateShiftAnchor[] = [
  "WALL_CLOCK",
  "EVENT_START",
  "EVENT_END",
];

const ANCHOR_LABEL_KEY: Record<TemplateShiftAnchor, string> = {
  WALL_CLOCK: "admin.volunteerShiftAnchorWallClock",
  EVENT_START: "admin.volunteerShiftAnchorEventStart",
  EVENT_END: "admin.volunteerShiftAnchorEventEnd",
};

const MAX_OFFSET_HOURS = Math.floor(MAX_ANCHOR_OFFSET_MINUTES / 60);

/**
 * `withShiftDraftDurationMinutes` clamps a duration to 23:59 (the schema has no
 * 24-hour shift), so anything past 23 in the hours box silently snaps. Cap it
 * at the input instead, the way the offset twin already caps at
 * {@link MAX_OFFSET_HOURS}.
 */
const MAX_DURATION_HOURS = 23;

function clampOffsetMinutes(minutes: number): number {
  if (minutes > MAX_ANCHOR_OFFSET_MINUTES) return MAX_ANCHOR_OFFSET_MINUTES;
  if (minutes < -MAX_ANCHOR_OFFSET_MINUTES) return -MAX_ANCHOR_OFFSET_MINUTES;
  return minutes;
}

function parseNumberField(value: string): number {
  const trimmed = value.trim();
  if (trimmed === "") return 0;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.trunc(n);
}

/**
 * What a numeric box is allowed to HOLD while the user is mid-edit.
 *
 * Only digits survive, so an empty box stays empty (the whole point — see
 * {@link ShiftAnchorFields}'s duration handling) while a stray paste of "abc"
 * can't be echoed back at the user as if it were a number.
 */
function sanitizeNumberText(value: string): string {
  return value.replace(/[^0-9]/g, "");
}

export function ShiftAnchorFields({
  fields,
  onChange,
  disabled,
  testIdBase,
  anchorOptions = ANCHOR_ORDER,
}: ShiftAnchorFieldsProps) {
  const t = useTranslations();

  const anchor = fields.anchor ?? "WALL_CLOCK";
  const isAnchored = anchor !== "WALL_CLOCK";

  const offsetSigned = Number(fields.offsetMinutes || "0");
  const offsetValue = Number.isFinite(offsetSigned) ? offsetSigned : 0;
  const offsetParts = splitMinutesToHoursAndMinutes(offsetValue);

  /**
   * The before/after direction is HELD, not recovered from the sign — and held
   * on the CALLER'S row (`ShiftDraftFields.offsetDirection`), not in this
   * component.
   *
   * A magnitude legitimately passes through zero — clearing the hours box to
   * retype it is the ordinary way to edit a number — and `-0` stringifies to
   * `"0"`, so `value < 0` reads false on the next render. Deriving the select
   * from the sign therefore flipped it to "after" mid-edit and saved
   * `EVENT_START +30` where the organizer had said "30 minutes before": an hour
   * out, in the wrong direction, from the one control whose entire job is
   * getting that right.
   *
   * Holding it in `useState` here fixed that only while the component stayed
   * mounted. `InlineShiftComposer` unmounts it on Cancel and keeps `fields` in
   * the parent, so reopening re-seeded "after" over a chosen "before". The
   * direction now outlives the component because it rides with the row.
   *
   * A signed value still wins when it HAS a sign, so an offset arriving from
   * outside (a row seeded from the server, an anchor restored below) is read
   * from the data rather than from a stale held value.
   */
  const heldDirection: "before" | "after" =
    fields.offsetDirection ?? (offsetValue < 0 ? "before" : "after");
  const offsetDirection: "before" | "after" =
    offsetValue < 0 ? "before" : offsetValue > 0 ? "after" : heldDirection;

  /**
   * The offset the row carried when it was last flipped to `WALL_CLOCK`.
   *
   * `parseShiftDraftFields` already forces the offset to 0 on a wall-clock
   * preset at the parse boundary, so the editor does not have to destroy the
   * value to satisfy the server — and an organizer who taps "clock time" to see
   * what it looks like should get their "3 hours before" back when they tap
   * away from it, not a silent `+0`.
   */
  const stashedOffset = useRef<string | null>(null);

  const durationMinutes = shiftDraftDurationMinutes(fields);
  const durationParts = splitMinutesToHoursAndMinutes(durationMinutes ?? 0);

  /**
   * Raw text for the two duration boxes while the pair does not yet describe a
   * saveable duration — i.e. the "clear it to retype it" gesture.
   *
   * Committing 0 straight through was the bug: `withShiftDraftDurationMinutes`
   * has to clamp to 1 minute (a 0-length shift is not representable), so
   * clearing the HOURS box rewrote `endTime` to `12:01` and the MINUTES box
   * silently re-rendered as `1`. Typing `3` next produced 181 minutes and the
   * preset saved as 3 h 01. Holding the text and committing nothing until the
   * pair totals at least a minute leaves the stored duration untouched instead.
   *
   * `null` = nothing held; the boxes read straight off the row. Cleared on an
   * anchor change so a mode switch that reseeds the duration is never masked.
   */
  const [durationText, setDurationText] = useState<{
    hours: string;
    minutes: string;
  } | null>(null);

  const shownDurationHours = durationText?.hours ?? String(durationParts.hours);
  const shownDurationMinutes =
    durationText?.minutes ?? String(durationParts.minutes);
  const durationPending = durationText !== null;

  const setOffset = (
    hours: number,
    minutes: number,
    dir: "before" | "after",
  ) => {
    const magnitude = clampOffsetMinutes(hours * 60 + minutes);
    const signed = dir === "before" ? -magnitude : magnitude;
    onChange({ offsetMinutes: String(signed), offsetDirection: dir });
  };

  const setDurationFromText = (hoursRaw: string, minutesRaw: string) => {
    const hoursText = sanitizeNumberText(hoursRaw);
    const minutesText = sanitizeNumberText(minutesRaw);
    const hours = Math.min(parseNumberField(hoursText), MAX_DURATION_HOURS);
    const minutes = Math.min(parseNumberField(minutesText), 59);
    const total = hours * 60 + minutes;

    if (total <= 0) {
      // Transient: hold the keystroke, write nothing.
      setDurationText({ hours: hoursText, minutes: minutesText });
      return;
    }

    setDurationText(null);
    onChange(withShiftDraftDurationMinutes(fields, total));
  };

  /**
   * Switching TO an anchored mode seeds a duration when the row has none yet,
   * so the preview has something to show and the row validates against a
   * schema that still requires both minute-of-day columns — and restores an
   * offset stashed on the way out to WALL_CLOCK.
   *
   * Switching back to WALL_CLOCK still zeroes the stored field: the server
   * refuses a non-zero offset there, and "exactly one representation of no
   * offset" is the invariant on `ShiftDraftFields.offsetMinutes`. The value is
   * kept beside the field, not in it.
   */
  const setAnchor = (next: TemplateShiftAnchor) => {
    // A mode switch can reseed the duration; a held keystroke must not mask it.
    setDurationText(null);

    if (next === "WALL_CLOCK") {
      stashedOffset.current = fields.offsetMinutes;
      // `offsetDirection` deliberately survives: it is editor state, the server
      // never sees it, and it is what makes the round trip back to an anchored
      // mode restore "3 hours BEFORE" rather than a silent "+3 hours".
      onChange({ anchor: next, offsetMinutes: "0" });
      return;
    }

    const patch: Partial<ShiftDraftFields> = { anchor: next };

    const stashed = stashedOffset.current;
    stashedOffset.current = null;
    // Only when the field is genuinely at zero — an EVENT_START → EVENT_END
    // switch keeps whatever the organizer typed since.
    if (stashed !== null && offsetValue === 0) patch.offsetMinutes = stashed;

    if (durationMinutes === null) {
      Object.assign(patch, withShiftDraftDurationMinutes(fields, 120));
    }
    onChange(patch);
  };

  return (
    <XStack gap="$3" flexWrap="wrap" alignItems="flex-end">
      <YStack width={220} minWidth={220} gap="$1">
        <Text variant="label">
          {String(t("admin.volunteerShiftAnchorLabel"))}
        </Text>
        <select
          value={anchor}
          onChange={(e) => setAnchor(e.target.value as TemplateShiftAnchor)}
          disabled={disabled}
          aria-label={String(t("admin.volunteerShiftAnchorLabel"))}
          data-testid={`${testIdBase}-anchor`}
          style={NATIVE_SELECT_STYLE}
        >
          {anchorOptions.map((option) => (
            <option key={option} value={option}>
              {String(t(ANCHOR_LABEL_KEY[option]))}
            </option>
          ))}
        </select>
      </YStack>

      {isAnchored ? (
        <>
          <YStack gap="$1">
            <Text variant="label">
              {String(t("admin.volunteerShiftAnchorOffsetLabel"))}
            </Text>
            <XStack gap="$2" alignItems="center" flexWrap="wrap">
              <TextInput
                value={String(offsetParts.hours)}
                onChangeText={(value) =>
                  setOffset(
                    Math.min(parseNumberField(value), MAX_OFFSET_HOURS),
                    offsetParts.minutes,
                    offsetDirection,
                  )
                }
                inputMode="numeric"
                disabled={disabled}
                containerWidth={64}
                aria-label={String(t("admin.volunteerShiftAnchorOffsetHours"))}
                testId={`${testIdBase}-offset-hours`}
              />
              <Text variant="caption" tone="muted">
                {String(t("admin.volunteerShiftAnchorUnitHours"))}
              </Text>
              <TextInput
                value={String(offsetParts.minutes)}
                onChangeText={(value) =>
                  setOffset(
                    offsetParts.hours,
                    Math.min(parseNumberField(value), 59),
                    offsetDirection,
                  )
                }
                inputMode="numeric"
                disabled={disabled}
                containerWidth={64}
                aria-label={String(
                  t("admin.volunteerShiftAnchorOffsetMinutes"),
                )}
                testId={`${testIdBase}-offset-minutes`}
              />
              <Text variant="caption" tone="muted">
                {String(t("admin.volunteerShiftAnchorUnitMinutes"))}
              </Text>
              <select
                value={offsetDirection}
                onChange={(e) =>
                  setOffset(
                    offsetParts.hours,
                    offsetParts.minutes,
                    e.target.value as "before" | "after",
                  )
                }
                disabled={disabled}
                aria-label={String(
                  t("admin.volunteerShiftAnchorDirectionLabel"),
                )}
                data-testid={`${testIdBase}-offset-direction`}
                style={{ ...NATIVE_SELECT_STYLE, width: 120 }}
              >
                <option value="before">
                  {String(t("admin.volunteerShiftAnchorDirectionBefore"))}
                </option>
                <option value="after">
                  {String(t("admin.volunteerShiftAnchorDirectionAfter"))}
                </option>
              </select>
            </XStack>
          </YStack>

          <YStack gap="$1">
            <Text variant="label">
              {String(t("admin.volunteerShiftAnchorDurationLabel"))}
            </Text>
            <XStack gap="$2" alignItems="center" flexWrap="wrap">
              <TextInput
                value={shownDurationHours}
                onChangeText={(value) =>
                  setDurationFromText(value, shownDurationMinutes)
                }
                inputMode="numeric"
                disabled={disabled}
                containerWidth={64}
                aria-label={String(
                  t("admin.volunteerShiftAnchorDurationHours"),
                )}
                testId={`${testIdBase}-duration-hours`}
              />
              <Text variant="caption" tone="muted">
                {String(t("admin.volunteerShiftAnchorUnitHours"))}
              </Text>
              <TextInput
                value={shownDurationMinutes}
                onChangeText={(value) =>
                  setDurationFromText(shownDurationHours, value)
                }
                inputMode="numeric"
                disabled={disabled}
                containerWidth={64}
                aria-label={String(
                  t("admin.volunteerShiftAnchorDurationMinutes"),
                )}
                testId={`${testIdBase}-duration-minutes`}
              />
              <Text variant="caption" tone="muted">
                {String(t("admin.volunteerShiftAnchorUnitMinutes"))}
              </Text>
            </XStack>
            {/*
              The boxes total zero, so nothing was committed and the preview is
              still showing the PREVIOUS duration. Say so, rather than let the
              two disagree in silence.
            */}
            {durationPending ? (
              <Text
                variant="caption"
                tone="muted"
                data-testid={`${testIdBase}-duration-pending`}
              >
                {String(t("admin.volunteerShiftAnchorDurationRequired"))}
              </Text>
            ) : null}
          </YStack>
        </>
      ) : null}
    </XStack>
  );
}

/**
 * The resolved preview — rendered SEPARATELY from the controls so the caller
 * can keep it last, below its own clock/day/capacity fields, instead of
 * printing a result above the inputs that produce it.
 */
export function ShiftAnchorPreview({
  fields,
  previewTargets,
  testIdBase,
}: ShiftAnchorPreviewProps) {
  const t = useTranslations();
  const fmt = useFormatters();

  if (previewTargets.length === 0) return null;

  const anchor = fields.anchor ?? "WALL_CLOCK";
  const offsetSigned = Number(fields.offsetMinutes || "0");
  const offsetValue = Number.isFinite(offsetSigned) ? offsetSigned : 0;
  const durationMinutes = shiftDraftDurationMinutes(fields);

  return (
    <YStack
      gap="$1"
      borderTopWidth={1}
      borderTopColor="$borderColorSoft"
      paddingTop="$2"
      data-testid={`${testIdBase}-preview`}
    >
      <Text variant="label" tone="muted">
        {String(t("admin.volunteerShiftAnchorPreviewLabel"))}
      </Text>
      {previewTargets.map((previewTarget) => (
        <AnchorPreviewRow
          key={previewTarget.id}
          previewTarget={previewTarget}
          fields={fields}
          anchor={anchor}
          offsetMinutes={offsetValue}
          durationMinutes={durationMinutes}
          fmt={fmt}
          t={t}
          testId={`${testIdBase}-preview-${previewTarget.id}`}
        />
      ))}
    </YStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Preview row
// ─────────────────────────────────────────────────────────────────────────────

function calendarDayKey(instant: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(instant);
  } catch {
    // Unknown zone id — Intl throws RangeError. The key is only used to decide
    // whether to print a date, so degrading to "same day" is harmless.
    return "";
  }
}

function AnchorPreviewRow({
  previewTarget,
  fields,
  anchor,
  offsetMinutes,
  durationMinutes,
  fmt,
  t,
  testId,
}: {
  previewTarget: ShiftAnchorPreviewTarget;
  fields: ShiftDraftFields;
  anchor: TemplateShiftAnchor;
  offsetMinutes: number;
  durationMinutes: number | null;
  fmt: ReturnType<typeof useFormatters>;
  t: ReturnType<typeof useTranslations>;
  testId: string;
}) {
  const { target } = previewTarget;

  const startMinuteOfDay = timeFieldToMinuteOfDay(fields.startTime);
  const endMinuteOfDay = timeFieldToMinuteOfDay(fields.endTime);
  const dayOffset = Number(fields.dayOffset || "0");

  const resolved =
    startMinuteOfDay === null ||
    endMinuteOfDay === null ||
    !Number.isFinite(dayOffset) ||
    (anchor !== "WALL_CLOCK" && durationMinutes === null)
      ? null
      : resolveTemplateShift(
          {
            startMinuteOfDay,
            endMinuteOfDay,
            startDayOffset: Math.trunc(dayOffset),
            endsNextDay: endMinuteOfDay < startMinuteOfDay,
            anchor,
            offsetMinutes,
          },
          target,
        );

  const renderInstant = (iso: string): string => {
    const instant = new Date(iso);
    const anchorDay = target.startsAt ?? target.reference;
    const showDate =
      previewTarget.alwaysShowDate === true ||
      calendarDayKey(instant, target.timeZone) !==
        calendarDayKey(anchorDay, target.timeZone);
    try {
      return fmt.dateTime(instant, {
        ...(showDate
          ? { month: "short" as const, day: "numeric" as const }
          : {}),
        hour: "numeric",
        minute: "2-digit",
        timeZone: target.timeZone,
      });
    } catch {
      return "";
    }
  };

  return (
    <XStack gap="$3" flexWrap="wrap" alignItems="baseline" data-testid={testId}>
      <Text variant="caption" tone="muted" style={{ minWidth: 140 }}>
        {previewTarget.label}
      </Text>
      {resolved === null ? (
        <Text variant="caption" tone="muted">
          {String(t("admin.volunteerShiftAnchorPreviewIncomplete"))}
        </Text>
      ) : resolved.ok ? (
        <Text variant="caption" style={{ fontVariantNumeric: "tabular-nums" }}>
          {`${renderInstant(resolved.startsAt)} → ${renderInstant(resolved.endsAt)}`}
        </Text>
      ) : (
        <Text variant="caption" tone="error">
          {shiftAnchorUnavailableMessage(t, resolved.reason)}
        </Text>
      )}
    </XStack>
  );
}

/** Local `HH:MM` → minute-of-day, mirroring the lib's private parser. */
function timeFieldToMinuteOfDay(value: string): number | null {
  const match = /^([0-2]\d):([0-5]\d)$/.exec(value);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}
