"use client";

import { useCallback, useMemo } from "react";
import { XStack, YStack } from "tamagui";
import { Repeat } from "lucide-react";

import { Text, useFormatters, useTranslations } from "@th/ui";

import {
  weekdayOfLocal,
} from "@/lib/recurrence/build-recurrence-schedule";
import {
  nthWeekdayOfMonth,
  type MonthlyMode,
  type Weekday,
} from "@/lib/recurrence/build-rrule";

import { Field, FieldLabel, NativeDateTimeInput } from "../../_components/_form-bits";

export type RecurrenceFreq = "NONE" | "WEEKLY" | "MONTHLY";

/** Serialisable "Repeats" section state, owned by the parent form. */
export type RecurrenceUiState = {
  freq: RecurrenceFreq;
  /** "Every N weeks/months". */
  interval: number;
  /** WEEKLY only, Monday-first order maintained on toggle. */
  byWeekday: Weekday[];
  /** MONTHLY only. */
  monthlyMode: MonthlyMode;
  /** "YYYY-MM-DD" from the native date input, "" when unset. */
  untilLocal: string;
};

export const emptyRecurrence: RecurrenceUiState = {
  freq: "NONE",
  interval: 1,
  byWeekday: [],
  monthlyMode: "DAY_OF_MONTH",
  untilLocal: "",
};

const WEEKDAYS: readonly Weekday[] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

const WEEKDAY_LABEL_KEYS: Record<Weekday, string> = {
  MO: "admin.rbMon",
  TU: "admin.rbTue",
  WE: "admin.rbWed",
  TH: "admin.rbThu",
  FR: "admin.rbFri",
  SA: "admin.rbSat",
  SU: "admin.rbSun",
};

const ORDINAL_KEYS = [
  "communityCreate.ord1",
  "communityCreate.ord2",
  "communityCreate.ord3",
  "communityCreate.ord4",
  "communityCreate.ord5",
] as const;

/**
 * Square, token-driven native select — mirrors CommunityQuickCreateForm.
 *
 * Fallbacks are the Stub values: `--color`/`--surface`/`--borderColor` are not
 * declared in globals.css `:root`, they're only mirrored onto <body> once
 * ActiveThemeInjector runs — so the fallback is what first paint renders.
 */
const selectStyle: React.CSSProperties = {
  width: "100%",
  minHeight: 44,
  padding: "10px 12px",
  fontSize: 14,
  fontFamily: "inherit",
  color: "var(--color, #211C16)",
  background: "var(--surface, #FDFAF3)",
  border: "1px solid var(--borderColor, #211C16)",
  borderRadius: 0,
  cursor: "pointer",
};

export type RecurrenceFieldsProps = {
  value: RecurrenceUiState;
  onChange: (next: RecurrenceUiState) => void;
  /** First-occurrence wall-time from the form ("YYYY-MM-DDTHH:mm"). */
  startsAtLocal: string;
  /** Timezone the local values are interpreted in (for preview only). */
  timezone: string;
  /** Localized validation message to surface under the section, if any. */
  error?: string | null;
  disabled?: boolean;
};

/**
 * "Repeats" section for the community listing form (recurring-dates spec,
 * slice 4). Structured inputs (frequency, weekday(s), interval, monthly mode,
 * end date) that the parent compiles into an RRULE `recurrenceSchedule` on
 * submit. "Does not repeat" (the default) sends nothing — single-date,
 * unchanged behavior.
 */
export function RecurrenceFields({
  value,
  onChange,
  startsAtLocal,
  timezone,
  error,
  disabled,
}: RecurrenceFieldsProps) {
  const t = useTranslations();
  const fmt = useFormatters();

  const startDay = startsAtLocal ? startsAtLocal.slice(0, 10) : undefined;
  const startWeekday = startsAtLocal ? weekdayOfLocal(startsAtLocal) : null;

  // Cap the horizon at ~12 months (the server materialises no further).
  const maxUntil = useMemo(() => {
    if (!startDay) return undefined;
    const d = new Date(`${startDay}T00:00`);
    if (Number.isNaN(d.getTime())) return undefined;
    d.setFullYear(d.getFullYear() + 1);
    return d.toISOString().slice(0, 10);
  }, [startDay]);

  const handleFreq = useCallback(
    (freq: RecurrenceFreq) => {
      if (freq === "WEEKLY" && value.byWeekday.length === 0 && startWeekday) {
        onChange({ ...value, freq, byWeekday: [startWeekday] });
        return;
      }
      onChange({ ...value, freq });
    },
    [onChange, value, startWeekday],
  );

  const toggleWeekday = useCallback(
    (day: Weekday) => {
      const has = value.byWeekday.includes(day);
      const next = has
        ? value.byWeekday.filter((d) => d !== day)
        : [...value.byWeekday, day];
      const ordered = WEEKDAYS.filter((w) => next.includes(w));
      onChange({ ...value, byWeekday: ordered });
    },
    [onChange, value],
  );

  const handleInterval = useCallback(
    (raw: string) => {
      const n = Number.parseInt(raw, 10);
      onChange({ ...value, interval: Number.isFinite(n) && n > 0 ? n : 1 });
    },
    [onChange, value],
  );

  // ── Monthly mode labels reflect the chosen start date ────────────────────
  const monthDay = startDay ? Number(startDay.slice(8, 10)) : null;
  const nthPosition = useMemo(() => {
    if (!startDay) return null;
    const wall = new Date(`${startDay}T00:00:00Z`);
    return Number.isNaN(wall.getTime()) ? null : nthWeekdayOfMonth(wall);
  }, [startDay]);

  const positionLabel =
    nthPosition && nthPosition >= 1 && nthPosition <= 5
      ? String(t(ORDINAL_KEYS[nthPosition - 1]))
      : "";
  const weekdayLabel = startWeekday
    ? String(t(WEEKDAY_LABEL_KEYS[startWeekday]))
    : "";

  // ── Plain-language preview ───────────────────────────────────────────────
  const preview = useMemo(() => {
    if (value.freq === "NONE") return null;

    let summary = "";
    if (value.freq === "WEEKLY") {
      const days = (
        value.byWeekday.length > 0
          ? value.byWeekday
          : startWeekday
            ? [startWeekday]
            : []
      )
        .map((d) => String(t(WEEKDAY_LABEL_KEYS[d])))
        .join(", ");
      if (!days) return null;
      summary = String(
        t("communityCreate.repeatPreviewWeekly", {
          interval: value.interval,
          days,
        }),
      );
    } else if (value.monthlyMode === "NTH_WEEKDAY") {
      if (!positionLabel || !weekdayLabel) return null;
      summary = String(
        t("communityCreate.repeatPreviewMonthlyNth", {
          interval: value.interval,
          position: positionLabel,
          weekday: weekdayLabel,
        }),
      );
    } else {
      if (!monthDay) return null;
      summary = String(
        t("communityCreate.repeatPreviewMonthlyDay", {
          interval: value.interval,
          day: monthDay,
        }),
      );
    }

    if (value.untilLocal) {
      const untilDate = new Date(`${value.untilLocal}T00:00`);
      if (!Number.isNaN(untilDate.getTime())) {
        const date = fmt.dateTime(untilDate, {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        return String(
          t("communityCreate.repeatPreviewUntil", { summary, date }),
        );
      }
    }
    return summary;
  }, [
    value,
    startWeekday,
    positionLabel,
    weekdayLabel,
    monthDay,
    t,
    fmt,
  ]);

  const showWeekly = value.freq === "WEEKLY";
  const showMonthly = value.freq === "MONTHLY";
  const showRepeat = value.freq !== "NONE";

  return (
    <Field>
      <XStack gap="$2" alignItems="center">
        <Repeat size={16} aria-hidden />
        <FieldLabel>{String(t("communityCreate.repeatsLabel"))}</FieldLabel>
      </XStack>

      <select
        value={value.freq}
        onChange={(e) => handleFreq(e.target.value as RecurrenceFreq)}
        disabled={disabled}
        aria-label={String(t("communityCreate.repeatsLabel"))}
        style={selectStyle}
        data-testid="community-repeat-freq"
      >
        <option value="NONE">
          {String(t("communityCreate.repeatNone"))}
        </option>
        <option value="WEEKLY">
          {String(t("communityCreate.repeatWeekly"))}
        </option>
        <option value="MONTHLY">
          {String(t("communityCreate.repeatMonthly"))}
        </option>
      </select>

      {showWeekly && (
        <YStack gap={6}>
          <FieldLabel>{String(t("communityCreate.repeatOn"))}</FieldLabel>
          <XStack
            gap={6}
            flexWrap="wrap"
            role="group"
            aria-label={String(t("communityCreate.repeatOn"))}
            data-testid="community-repeat-weekdays"
          >
            {WEEKDAYS.map((day) => {
              const active = value.byWeekday.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  role="checkbox"
                  aria-checked={active}
                  aria-label={String(t(WEEKDAY_LABEL_KEYS[day]))}
                  onClick={() => toggleWeekday(day)}
                  disabled={disabled}
                  data-testid={`community-repeat-day-${day.toLowerCase()}`}
                  style={{
                    minWidth: 44,
                    minHeight: 44,
                    padding: "0 8px",
                    borderRadius: 0,
                    // Raw <button> can't take Tamagui $tokens — read the theme
                    // CSS vars, with the Stub values as the SSR/first-paint
                    // fallback.
                    border: `2px solid ${
                      active
                        ? "var(--accent, #E2481D)"
                        : "var(--borderColor, #211C16)"
                    }`,
                    background: active
                      ? "var(--brandSecondaryHover, #B93312)"
                      : "transparent",
                    color: active
                      ? "var(--onBrandSecondary, #FFFFFF)"
                      : "var(--color, #211C16)",
                    fontFamily: "Montserrat, sans-serif",
                    fontSize: 13,
                    fontWeight: 700,
                    letterSpacing: "0.04em",
                    textTransform: "uppercase",
                    cursor: disabled ? "not-allowed" : "pointer",
                    transition: "background-color 0.15s, color 0.15s",
                  }}
                >
                  {String(t(WEEKDAY_LABEL_KEYS[day]))}
                </button>
              );
            })}
          </XStack>
        </YStack>
      )}

      {showMonthly && (
        <YStack gap={6}>
          <FieldLabel>{String(t("communityCreate.repeatOn"))}</FieldLabel>
          <select
            value={value.monthlyMode}
            onChange={(e) =>
              onChange({
                ...value,
                monthlyMode: e.target.value as MonthlyMode,
              })
            }
            disabled={disabled}
            aria-label={String(t("communityCreate.repeatOn"))}
            style={selectStyle}
            data-testid="community-repeat-monthly-mode"
          >
            <option value="DAY_OF_MONTH">
              {monthDay
                ? String(t("communityCreate.monthlyOnDay", { day: monthDay }))
                : String(t("communityCreate.monthlyOnDayGeneric"))}
            </option>
            <option value="NTH_WEEKDAY">
              {positionLabel && weekdayLabel
                ? String(
                    t("communityCreate.monthlyOnNth", {
                      position: positionLabel,
                      weekday: weekdayLabel,
                    }),
                  )
                : String(t("communityCreate.monthlyOnNthGeneric"))}
            </option>
          </select>
        </YStack>
      )}

      {showRepeat && (
        <XStack gap="$3" flexWrap="wrap" alignItems="flex-end">
          <YStack gap={6} minWidth={180}>
            <FieldLabel>{String(t("communityCreate.repeatEvery"))}</FieldLabel>
            <XStack gap="$2" alignItems="center">
              <input
                type="number"
                min={1}
                max={showWeekly ? 52 : 12}
                step={1}
                inputMode="numeric"
                value={String(value.interval)}
                onChange={(e) => handleInterval(e.target.value)}
                disabled={disabled}
                aria-label={String(t("communityCreate.repeatEvery"))}
                data-testid="community-repeat-interval"
                style={{ ...selectStyle, width: 72, cursor: "text" }}
              />
              <Text variant="bodySmall" tone="muted">
                {String(
                  t(
                    showWeekly
                      ? "communityCreate.repeatWeeksUnit"
                      : "communityCreate.repeatMonthsUnit",
                    { count: value.interval },
                  ),
                )}
              </Text>
            </XStack>
          </YStack>

          <YStack gap={6} flex={1} minWidth={200}>
            <FieldLabel>{String(t("communityCreate.repeatEndsLabel"))}</FieldLabel>
            <NativeDateTimeInput
              type="date"
              value={value.untilLocal}
              min={startDay}
              max={maxUntil}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                onChange({ ...value, untilLocal: e.target.value })
              }
              aria-label={String(t("communityCreate.repeatEndsLabel"))}
              data-testid="community-repeat-until"
            />
          </YStack>
        </XStack>
      )}

      {showRepeat && preview ? (
        <Text
          variant="caption"
          tone="muted"
          data-testid="community-repeat-preview"
        >
          {preview}
        </Text>
      ) : null}

      {error ? (
        <Text variant="caption" tone="error" role="alert">
          {error}
        </Text>
      ) : null}
    </Field>
  );
}

RecurrenceFields.displayName = "RecurrenceFields";
