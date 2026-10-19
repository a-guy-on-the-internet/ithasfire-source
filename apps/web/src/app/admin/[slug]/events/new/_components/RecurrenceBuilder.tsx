"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { styled, useTheme, XStack, YStack } from "tamagui";
import { Repeat, Info, Lock } from "lucide-react";

import { NextLinkAnchor, Text, useFormatters, useTranslations } from "@th/ui";

import { toIsoInTimeZone } from "./event-builder-helpers";
import { FieldLabel, NativeDateTimeInput } from "./_form-bits";
import {
  COUNT_MAX,
  COUNT_MIN,
  DEFAULT_COUNT,
  ENUMERATION_CAP,
  INTERVAL_MAX,
  INTERVAL_MIN,
  WEEKDAYS,
  buildConfigFromState,
  clampInt,
  configsEqual,
  defaultBuilderState,
  degradeMonthlySelection,
  deriveStateFromValue,
  enumerateOccurrences,
  isWeekdayPinned,
  monthlyNthForSchedule,
  monthlyPresetLocalOrdinal,
  startWeekdayForSchedule,
  toggleWeekday,
  withStartDayIncluded,
  type BuilderState,
  type CustomUnit,
  type DeriveContext,
  type EndMode,
  type RecurrenceConfig,
  type RepeatSelectValue,
  type Weekday,
} from "./recurrence-helpers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { RecurrenceConfig } from "./recurrence-helpers";

export type RecurrenceBuilderProps = {
  /** Whether recurrence is enabled (select ≠ "Doesn't repeat"). */
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  /** The current recurrence configuration (when enabled). */
  value: RecurrenceConfig | null;
  onChange: (config: RecurrenceConfig | null) => void;
  /** The event start (datetime-local wall clock) — drives presets + dtstart. */
  eventStartsAt?: string;
  /**
   * IANA timezone of the event. Used to compute the schedule's RRULE tokens
   * on the backend's basis (event-timezone wall clock → UTC weekday/ordinal)
   * instead of the browser's. Falls back to browser-local interpretation
   * when omitted.
   */
  eventTimezone?: string;
  /**
   * When provided, the builder renders an inline copy of the event's start
   * date/time above the rule's own fields.
   *
   * It is the SAME field as the one in Essentials, not a second source of
   * truth: the caller must hand over the same setter it gives the Essentials
   * input, so either place edits one piece of state. Purely a convenience —
   * the start is what the rule is built from (`eventStartsAt` feeds
   * `startWeekdayForSchedule`, `monthlyNthForSchedule` and the dtstart), and
   * an organizer editing the schedule should not have to scroll back up to
   * change it.
   *
   * Omit the prop and nothing renders, which is how the community-listing
   * schedule page keeps its single start field.
   */
  onEventStartsAtChange?: (value: string | undefined) => void;
  /**
   * When provided, the builder is in edit mode for an existing series.
   * Displays a contextual banner; the save flow goes through updateEventSeries.
   */
  seriesId?: string | null;
  /**
   * Href of the per-series Dates management page. Rendered as a link in the
   * edit-mode banner so organizers can hop from the schedule editor to the
   * occurrence list (recurring-series redesign Phase 2).
   */
  manageDatesHref?: string;
  /**
   * Offer "Ends — never" alongside After-N and On-date. Default `false`, so
   * the ticketed event builder is untouched: a show series always ends.
   *
   * Turned on by the community-listing schedule surface
   * (`/moderate/listings/[eventId]/schedule`), where an open-ended rule is the
   * normal case and forcing a bound onto it would retire the series. See
   * {@link EndMode}.
   */
  allowNeverEnds?: boolean;
  /**
   * Message-key overrides for the OCCURRENCE NOUN — the word after the
   * "After [N]" field, and the count/last-occurrence clauses in the summary
   * sentence.
   *
   * The builder's own copy says "shows", which is right for a ticketed series
   * and wrong for a community RSVP listing, where an occurrence is a date
   * nobody buys a ticket to. Omit the prop and every string is exactly the one
   * that shipped.
   */
  occurrenceCopyKeys?: OccurrenceCopyKeys;
};

/** See {@link RecurrenceBuilderProps.occurrenceCopyKeys}. */
export type OccurrenceCopyKeys = {
  /** Plural noun after the "After [N]" count field. `{count}`. */
  unit: string;
  /** The count clause in the summary sentence. `{count}`. */
  total: string;
  /** The same clause when the enumeration hit its cap. `{count}`. */
  totalCapped: string;
  /** The final-occurrence clause in the summary sentence. `{date}`. */
  last: string;
  /**
   * The consequence caption under the summary band (`{count}` = occurrences
   * beyond the event's own date), or `null` to omit it — for a surface that
   * states the consequences itself, in its own terms, somewhere the reader
   * cannot miss them.
   */
  consequence: string | null;
};

const PREVIEW_CHIP_COUNT = 5;

const WEEKDAY_LABEL_KEYS: Record<Weekday, string> = {
  MO: "admin.rbMon",
  TU: "admin.rbTue",
  WE: "admin.rbWed",
  TH: "admin.rbThu",
  FR: "admin.rbFri",
  SA: "admin.rbSat",
  SU: "admin.rbSun",
};

/**
 * Weekday-free preset labels, for the window where there is no start to name a
 * weekday from (`presetLabels` is null).
 *
 * A `<select>` whose `value` matches none of its options displays its FIRST
 * option instead — so dropping the preset options while `state.select` still
 * held one made the control read "Doesn't repeat" above an open, fully
 * configured series. Keeping the held value's option mounted under a generic
 * label is what stops the select from claiming a value it does not hold.
 * Partial by design: "none" and "custom" have their own permanent options.
 */
const PLAIN_PRESET_LABEL_KEYS: Partial<Record<RepeatSelectValue, string>> = {
  weekly: "admin.rbPresetWeeklyPlain",
  biweekly: "admin.rbPresetBiweeklyPlain",
  monthly: "admin.rbPresetMonthlyPlain",
};

const ORDINAL_KEYS: Record<number, string> = {
  1: "communityCreate.ord1",
  2: "communityCreate.ord2",
  3: "communityCreate.ord3",
  4: "communityCreate.ord4",
  5: "communityCreate.ord5",
};

// ---------------------------------------------------------------------------
// Styled components
// ---------------------------------------------------------------------------

const SectionContainer = styled(YStack, {
  gap: 16,
});

const InfoBox = styled(YStack, {
  gap: 6,
  paddingVertical: 12,
  paddingHorizontal: 16,
  backgroundColor: "$surfaceMuted",
  borderWidth: 1,
  borderColor: "$borderColor",
});

/** Accent-left-border summary band — strict Swiss, no radius, no shadow. */
const SummaryBand = styled(YStack, {
  gap: 8,
  paddingVertical: 12,
  paddingHorizontal: 16,
  backgroundColor: "$surfaceMuted",
  borderLeftWidth: 4,
  borderLeftColor: "$accent",
});

const DateChip = styled(XStack, {
  borderWidth: 1,
  borderColor: "$borderColor",
  backgroundColor: "$surface",
  paddingHorizontal: 8,
  paddingVertical: 4,
  alignItems: "center",
});

/**
 * Square, token-driven native controls — mirrors CommunityQuickCreateForm /
 * RecurrenceFields. Fallbacks are the Stub values: the CSS vars are only
 * mirrored onto <body> once ActiveThemeInjector runs, so the fallback is
 * what SSR/first paint renders.
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

const numberInputStyle: React.CSSProperties = {
  ...selectStyle,
  width: 72,
  cursor: "text",
};

const radioStyle: React.CSSProperties = {
  width: 16,
  height: 16,
  margin: 0,
  flexShrink: 0,
  accentColor: "var(--accent, #E2481D)",
  cursor: "pointer",
};

/** Raw RRULE strings are genuine code — system mono stack, never a webfont. */
const monoStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono, monospace)",
};

/** Date chips are UI text — Montserrat, digits aligned via tabular-nums. */
const chipDateStyle: React.CSSProperties = {
  fontVariantNumeric: "tabular-nums",
};

/**
 * AA-safe day chip (accent fill can't carry small text — use the ladder).
 *
 * `pinned` is the event's own weekday: it stays selected no matter what, so
 * it must LOOK non-interactive (padlock glyph + default cursor) rather than
 * looking like every other selected chip and swallowing the click.
 */
const dayChipStyle = (
  active: boolean,
  pinned: boolean,
): React.CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 4,
  minWidth: 44,
  minHeight: 44,
  padding: "0 8px",
  borderRadius: 0,
  border: `2px solid ${
    active ? "var(--accent, #E2481D)" : "var(--borderColor, #211C16)"
  }`,
  background: active ? "var(--brandSecondaryHover, #B93312)" : "transparent",
  color: active ? "var(--onBrandSecondary, #FFFFFF)" : "var(--color, #211C16)",
  fontFamily: "Montserrat, sans-serif",
  fontSize: 13,
  fontWeight: 700,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  cursor: pinned ? "default" : "pointer",
  transition: "background-color 0.15s, color 0.15s",
});

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RecurrenceBuilder({
  enabled: _enabled,
  onEnabledChange,
  value,
  onChange,
  eventStartsAt,
  eventTimezone,
  onEventStartsAtChange,
  seriesId,
  manageDatesHref,
  allowNeverEnds = false,
  occurrenceCopyKeys,
}: RecurrenceBuilderProps) {
  const theme = useTheme();
  const t = useTranslations();
  const fmt = useFormatters();
  // The builder can be mounted twice (page + EventEditorSheet), so the
  // caption's id must be instance-scoped or aria-describedby would resolve to
  // whichever copy rendered first.
  const pinnedDayNoteId = useId();
  // Same reason as `pinnedDayNoteId`: two mounted builders must not share the
  // id their start field points `aria-describedby` at.
  const startsAtHintId = useId();

  // ── Basis derivation ────────────────────────────────────────────────────
  // ONE basis: the event timezone's local calendar day. The backend now
  // evaluates BYDAY/BYSETPOS in the event timezone too, so the token the
  // RRULE carries and the label the organizer reads are the same weekday.
  // (This used to be two bases with a shift between them — see the module
  // header of recurrence-helpers.ts for why, and why it is gone.)
  const startDay = useMemo(
    () =>
      eventStartsAt
        ? startWeekdayForSchedule(eventStartsAt, eventTimezone)
        : null,
    [eventStartsAt, eventTimezone],
  );
  const monthlyNth = useMemo(
    () =>
      eventStartsAt
        ? monthlyNthForSchedule(eventStartsAt, eventTimezone)
        : null,
    [eventStartsAt, eventTimezone],
  );
  /**
   * The organizer-facing name for the very same weekday `startDay` holds.
   * Kept as its own binding because the UI copy talks about the organizer's
   * day; it is NOT a second basis.
   */
  const localDay = startDay;

  const dtstartIso = useMemo(() => {
    if (!eventStartsAt) return null;
    try {
      return eventTimezone
        ? toIsoInTimeZone(eventStartsAt, eventTimezone)
        : new Date(eventStartsAt).toISOString();
    } catch {
      const d = new Date(eventStartsAt);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
  }, [eventStartsAt, eventTimezone]);

  // The ordinal the monthly preset labels, read from the dtstart instant in
  // the event timezone. Null (preset suppressed, stored rules prefill as raw
  // Custom) only when that instant is unusable.
  const monthlyPresetOrdinal = useMemo(() => {
    if (!startDay || monthlyNth == null || !dtstartIso) return null;
    return monthlyPresetLocalOrdinal({ dtstartIso, eventTimezone });
  }, [startDay, monthlyNth, dtstartIso, eventTimezone]);

  const ctx: DeriveContext = useMemo(
    () => ({
      startDay,
      monthlyNth,
      dtstartIso,
      eventTimezone,
      monthlyPresetAvailable: monthlyPresetOrdinal != null,
      allowNeverEnds,
    }),
    [
      startDay,
      monthlyNth,
      dtstartIso,
      eventTimezone,
      monthlyPresetOrdinal,
      allowNeverEnds,
    ],
  );

  // ── Internal state ──────────────────────────────────────────────────────
  const [state, setState] = useState<BuilderState>(() =>
    value
      ? deriveStateFromValue(value, ctx)
      : defaultBuilderState(localDay, allowNeverEnds),
  );

  /**
   * Whether the organizer has interacted with the section. While untouched,
   * NO emission happens (a stored non-canonical rule is never rewritten and
   * an incomplete derived state never clears a server config) — with one
   * exception: when the event start itself changes, a stale non-null config
   * is refreshed so its BYDAY/BYSETPOS keep matching the new start.
   */
  const touchedRef = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  // Sync internal state when a config arrives from outside (edit-mode
  // prefill / server refresh). Skips our own emissions round-tripping back.
  const valueKey = value
    ? `${value.rrule}|${value.until ?? ""}|${value.count ?? ""}`
    : "";
  useEffect(() => {
    if (!value) return;
    if (
      configsEqual(
        buildConfigFromState(stateRef.current, ctxRef.current),
        value,
      )
    ) {
      return;
    }
    setState(deriveStateFromValue(value, ctxRef.current));
    // Intentionally keyed on the value identity only — including `state`
    // would let a stale prop revert in-flight user edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueKey]);

  // If the event time change removes the monthly preset's honest label
  // while it is selected, degrade to raw Custom carrying the current token
  // rule — otherwise the <option> unmounts under a dangling select value
  // and the summary sentence goes empty.
  useEffect(() => {
    setState((s) => degradeMonthlySelection(s, ctxRef.current));
  }, [ctx]);

  // Keep the custom weekly set legal when the event's start day changes
  // (LABEL basis — the pinned chip is the organizer's local day).
  useEffect(() => {
    if (!localDay) return;
    setState((s) => {
      // An EMPTY set is legal on the wire (BYDAY is omitted and the rule
      // expands on the dtstart weekday anyway) but it makes the picker LIE:
      // every chip renders unchecked, nothing is pinned, and the caption
      // can't appear — while the summary and the emitted rule both say
      // "every Wednesday". Reachable by toggling a day on/off BEFORE a start
      // date exists, then entering one. Seeding converges this with what
      // deriveStateFromValue already does for a loaded BYDAY-less weekly
      // rule, so prefill and interaction no longer diverge.
      if (s.byday.length === 0) return { ...s, byday: [localDay] };
      const next = withStartDayIncluded(s.byday, localDay);
      return next === s.byday ? s : { ...s, byday: next };
    });
  }, [localDay]);

  // Single emission path: rebuild the config whenever state or the
  // event-start basis changes and hand it up when it differs from what the
  // parent holds (the equality check terminates the loop once the prop
  // catches up).
  useEffect(() => {
    const next = buildConfigFromState(state, ctx);
    if (configsEqual(next, value ?? null)) return;
    if (!touchedRef.current) {
      // Untouched: only the dtstart-refresh case may emit (event start
      // changed under a loaded config — its BYDAY/BYSETPOS would go stale).
      // Everything else — canonicalization rewrites, derived incomplete
      // states — stays silent so a passive save round-trips verbatim.
      const dtstartChanged =
        value != null && next != null && value.dtstart !== next.dtstart;
      if (!dtstartChanged) return;
    }
    onChange(next);
  }, [state, ctx, value, onChange]);

  // ── Handlers ────────────────────────────────────────────────────────────
  const handleSelectChange = useCallback(
    (next: RepeatSelectValue) => {
      touchedRef.current = true;
      onEnabledChange(next !== "none");
      setState((s) => ({
        ...s,
        select: next,
        byday:
          next === "custom" &&
          s.raw == null &&
          s.unit === "weeks" &&
          s.byday.length === 0 &&
          localDay
            ? [localDay]
            : s.byday,
      }));
    },
    [onEnabledChange, localDay],
  );

  const handleIntervalChange = useCallback((rawValue: string) => {
    touchedRef.current = true;
    const n = parseInt(rawValue, 10);
    setState((s) => ({
      ...s,
      raw: null,
      interval: Number.isFinite(n)
        ? clampInt(n, INTERVAL_MIN, INTERVAL_MAX)
        : INTERVAL_MIN,
    }));
  }, []);

  const handleUnitChange = useCallback(
    (unit: CustomUnit) => {
      touchedRef.current = true;
      setState((s) => ({
        ...s,
        raw: null,
        unit,
        byday:
          unit === "weeks" && s.byday.length === 0 && localDay
            ? [localDay]
            : s.byday,
      }));
    },
    [localDay],
  );

  const handleDayToggle = useCallback(
    (day: Weekday) => {
      // The event's own local day can't be deselected — the schedule must
      // always include the event's own start or the backend rejects it
      // (EVENT_START_NOT_IN_SCHEDULE). The chip renders as visibly pinned so
      // this refusal is explained rather than silent.
      if (isWeekdayPinned(day, stateRef.current.byday, localDay)) return;
      touchedRef.current = true;
      setState((s) => {
        const next = toggleWeekday(s.byday, day, localDay);
        return next === s.byday ? s : { ...s, raw: null, byday: next };
      });
    },
    [localDay],
  );

  const handleEndModeChange = useCallback((endMode: EndMode) => {
    touchedRef.current = true;
    setState((s) => ({ ...s, endMode }));
  }, []);

  const handleCountChange = useCallback((rawValue: string) => {
    touchedRef.current = true;
    // Keep the raw string — clamping per keystroke turns typing "10" into
    // "20" (the intermediate "1" clamps to COUNT_MIN). Clamped at emit.
    setState((s) => ({ ...s, count: rawValue }));
  }, []);

  const handleCountBlur = useCallback(() => {
    setState((s) => {
      const n = parseInt(s.count, 10);
      const normalized = String(
        Number.isFinite(n) ? clampInt(n, COUNT_MIN, COUNT_MAX) : DEFAULT_COUNT,
      );
      return normalized === s.count ? s : { ...s, count: normalized };
    });
  }, []);

  const handleUntilChange = useCallback((rawValue: string) => {
    touchedRef.current = true;
    setState((s) => ({ ...s, until: rawValue }));
  }, []);

  // ── Derived render data ─────────────────────────────────────────────────
  const config = useMemo(() => buildConfigFromState(state, ctx), [state, ctx]);

  const occurrences = useMemo(
    () =>
      config
        ? enumerateOccurrences(
            config.rrule,
            config.dtstart,
            config.until,
            ENUMERATION_CAP,
            eventTimezone,
          )
        : [],
    [config, eventTimezone],
  );

  // Full weekday name for preset labels ("Every Friday"). Derived from
  // `localDay` — the same value the RRULE token comes from — rather than
  // re-slicing the raw prop, so the label cannot disagree with the rule if a
  // caller ever passes a zone-qualified `eventStartsAt` (slicing would then
  // read the UTC date). Formatted at UTC midnight of a date KNOWN to have
  // that weekday, so Intl reads exactly that calendar day.
  const localDayName = useMemo(() => {
    if (!localDay) return null;
    // 2024-01-01 was a Monday; step to the target weekday.
    const anchor = new Date(
      Date.UTC(2024, 0, 1 + WEEKDAYS.indexOf(localDay)),
    );
    try {
      return fmt.dateTime(anchor, { weekday: "long", timeZone: "UTC" });
    } catch {
      return null;
    }
  }, [localDay, fmt]);

  const ordinalLabel = useCallback(
    (nth: number): string =>
      nth === -1
        ? String(t("admin.rbLast"))
        : String(t(ORDINAL_KEYS[nth] ?? "communityCreate.ord1")),
    [t],
  );

  const presetLabels = useMemo(() => {
    if (!localDayName || !startDay) return null;
    return {
      weekly: String(t("admin.rbPresetWeekly", { weekday: localDayName })),
      biweekly: String(t("admin.rbPresetBiweekly", { weekday: localDayName })),
      // Ordinal comes from what the token rule ACTUALLY does in local terms
      // (null = no honest label → preset suppressed).
      monthly:
        monthlyPresetOrdinal != null
          ? String(
              t("admin.rbPresetMonthly", {
                ordinal: ordinalLabel(monthlyPresetOrdinal),
                weekday: localDayName,
              }),
            )
          : null,
    };
  }, [localDayName, startDay, monthlyPresetOrdinal, ordinalLabel, t]);

  // Natural-language rule sentence for the summary band.
  const ruleText = useMemo(() => {
    switch (state.select) {
      case "weekly":
        return presetLabels?.weekly ?? "";
      case "biweekly":
        return presetLabels?.biweekly ?? "";
      case "monthly":
        return presetLabels?.monthly ?? "";
      case "custom": {
        if (state.raw != null) return state.raw;
        if (state.unit === "days") {
          return String(
            t("admin.rbSummaryDaily", { interval: state.interval }),
          );
        }
        if (state.unit === "weeks") {
          // State stores LABEL days — render them directly.
          const effective = withStartDayIncluded(state.byday, localDay);
          const shown =
            effective.length > 0 ? effective : localDay ? [localDay] : [];
          const days = WEEKDAYS.filter((d) => shown.includes(d))
            .map((d) => String(t(WEEKDAY_LABEL_KEYS[d])))
            .join(", ");
          return String(
            t("admin.rbSummaryWeekly", { interval: state.interval, days }),
          );
        }
        return String(
          t("admin.rbSummaryMonthly", { interval: state.interval }),
        );
      }
      default:
        return "";
    }
  }, [state, presetLabels, localDay, t]);

  const total = occurrences.length;
  const lastDate = total > 0 ? occurrences[total - 1] : undefined;
  const draftCount = Math.max(0, total - 1);

  const formatOccurrence = useCallback(
    (d: Date, withYear: boolean) =>
      fmt.dateTime(d, {
        weekday: "short",
        month: "short",
        day: "numeric",
        ...(withYear ? { year: "numeric" as const } : {}),
        ...(eventTimezone ? { timeZone: eventTimezone } : {}),
      }),
    [fmt, eventTimezone],
  );

  const summaryLine = useMemo(() => {
    if (!config || total === 0 || !lastDate) return ruleText;
    const first = occurrences[0]!;
    const yearOf = (d: Date) =>
      fmt.dateTime(d, {
        year: "numeric",
        ...(eventTimezone ? { timeZone: eventTimezone } : {}),
      });
    // An OPEN-ENDED rule also fills the enumeration cap, so it takes the
    // capped phrasing — and it must never print a "last" clause at all: the
    // 100th enumerated occurrence is where the preview stopped, not where the
    // schedule stops, and naming it puts an end date on a rule that has none.
    const openEnded = state.endMode === "never";
    const capped =
      total === ENUMERATION_CAP && (state.endMode === "until" || openEnded);
    const showsText = capped
      ? String(
          t(occurrenceCopyKeys?.totalCapped ?? "admin.rbSummaryShowsCapped", {
            count: total,
          }),
        )
      : String(
          t(occurrenceCopyKeys?.total ?? "admin.rbSummaryShows", {
            count: total,
          }),
        );
    if (openEnded) {
      return `${ruleText}, ${showsText}`;
    }
    const lastText = String(
      t(occurrenceCopyKeys?.last ?? "admin.rbSummaryLastShow", {
        date: formatOccurrence(lastDate, yearOf(lastDate) !== yearOf(first)),
      }),
    );
    return `${ruleText}, ${showsText} — ${lastText}`;
  }, [
    config,
    total,
    lastDate,
    occurrences,
    ruleText,
    state.endMode,
    formatOccurrence,
    fmt,
    eventTimezone,
    occurrenceCopyKeys,
    t,
  ]);

  const chipDates = useMemo(
    () =>
      occurrences
        .slice(0, PREVIEW_CHIP_COUNT)
        .map((d) => formatOccurrence(d, false)),
    [occurrences, formatOccurrence],
  );
  const moreCount = Math.max(0, total - PREVIEW_CHIP_COUNT);

  /**
   * Why the event's own weekday chip refuses to come off. Rendered next to
   * the picker AND used as the chip's `title` — the pinning is a real
   * backend constraint (EVENT_START_NOT_IN_SCHEDULE), so the honest fix is
   * to make it legible, not to let the organizer build a schedule the save
   * would reject. Null when nothing is pinned (no start date yet).
   */
  const pinnedDayExplanation = useMemo(() => {
    if (!localDay || !state.byday.includes(localDay)) return null;
    return String(
      t("admin.rbDayAlwaysIncludedNote", {
        weekday: String(t(WEEKDAY_LABEL_KEYS[localDay])),
      }),
    );
  }, [localDay, state.byday, t]);

  const untilInputValue = state.until.includes("T")
    ? state.until.slice(0, 10)
    : state.until;

  const countForPlural = (() => {
    const n = parseInt(state.count, 10);
    return Number.isFinite(n) ? n : DEFAULT_COUNT;
  })();

  /**
   * The consequence caption's message key, or `null` to omit it. Resolved
   * here rather than inline so the "caller explicitly said null" case cannot
   * be collapsed by a `??` into the default key.
   */
  const consequenceKey: string | null = occurrenceCopyKeys
    ? occurrenceCopyKeys.consequence
    : seriesId
      ? "admin.rbConsequenceEdit"
      : "admin.rbConsequence";

  const active = state.select !== "none";
  /**
   * The generic label for a preset the select still holds while there is no
   * start to name its weekday. Null whenever `presetLabels` can render the
   * day-labelled options, so the two can never both be mounted.
   */
  const plainPresetKey = presetLabels
    ? null
    : (PLAIN_PRESET_LABEL_KEYS[state.select] ?? null);
  /**
   * Whether the start field's hint earns its place.
   *
   * Off for a raw rule, whose pattern the start does NOT build (see the note
   * at the hint itself), and off while there is no usable start, where the
   * summary band's `rbAddStartDate` is already saying the same sentence in the
   * imperative. Two lines that end "the repeat pattern is built from it" read
   * as noise exactly when the organizer needs the one instruction that matters.
   */
  const showStartsHint = state.raw == null && dtstartIso != null;
  const showCustomPanel = state.select === "custom";
  const showDayPicker =
    showCustomPanel && state.unit === "weeks" && state.raw == null;

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <SectionContainer data-testid="recurrence-section">
      <XStack gap={12} alignItems="center">
        <Repeat size={16} color={theme.colorMuted?.val} aria-hidden />
        <FieldLabel>{String(t("admin.rbRepeats"))}</FieldLabel>
      </XStack>

      <YStack gap={16} maxWidth={520}>
        {/* Edit-mode banner */}
        {seriesId && (
          <InfoBox>
            <XStack gap={8} alignItems="center" flexWrap="wrap">
              <Info size={14} color={theme.colorMuted?.val} aria-hidden />
              <Text variant="bodySmall" tone="muted" flex={1} minWidth={200}>
                {String(t("admin.rbEditingSeriesNote"))}
              </Text>
              {manageDatesHref && (
                <NextLinkAnchor
                  href={manageDatesHref}
                  textDecorationLine="none"
                  display="inline-flex"
                  focusVisibleStyle={{
                    outlineWidth: 2,
                    outlineStyle: "solid",
                    outlineColor: "$accent",
                    outlineOffset: 2,
                  }}
                  data-testid="recurrence-manage-dates"
                >
                  <Text
                    variant="bodySmall"
                    weight="bold"
                    color="$accentText"
                    textTransform="uppercase"
                    letterSpacing={0.6}
                    fontSize={11}
                    tag="span"
                  >
                    {String(t("admin.sdManageDates"))}
                  </Text>
                </NextLinkAnchor>
              )}
            </XStack>
          </InfoBox>
        )}

        {/* REPEATS select — the select IS the enable toggle */}
        <select
          value={state.select}
          onChange={(e) =>
            handleSelectChange(e.target.value as RepeatSelectValue)
          }
          aria-label={String(t("admin.rbRepeats"))}
          style={selectStyle}
          data-testid="recurrence-repeats-select"
        >
          <option value="none">{String(t("admin.rbDoesNotRepeat"))}</option>
          {presetLabels ? (
            <>
              <option value="weekly">{presetLabels.weekly}</option>
              <option value="biweekly">{presetLabels.biweekly}</option>
              {presetLabels.monthly && (
                <option value="monthly">{presetLabels.monthly}</option>
              )}
            </>
          ) : (
            // Exactly ONE option per value: the generic label appears only in
            // place of the day-labelled one, and only for the value the select
            // is actually holding. See PLAIN_PRESET_LABEL_KEYS.
            plainPresetKey && (
              <option value={state.select}>{String(t(plainPresetKey))}</option>
            )
          )}
          <option value="custom">{String(t("admin.rbCustom"))}</option>
        </select>

        {/* The event's own start, mirrored here so the rule's first date can be
            changed without scrolling back to Essentials. Same state, same
            setter — see `onEventStartsAtChange`. Only once a repeat is picked:
            with "Doesn't repeat" selected there is no rule for it to anchor.
            Deliberately NO `min`: an existing series being edited can start in
            the past, and clamping to now would freeze the field. */}
        {onEventStartsAtChange && active && (
          <YStack gap={6} data-testid="recurrence-event-starts">
            <FieldLabel>{String(t("admin.ebStarts"))}</FieldLabel>
            <NativeDateTimeInput
              type="datetime-local"
              value={eventStartsAt ?? ""}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                onEventStartsAtChange(e.target.value || undefined)
              }
              aria-label={String(t("admin.ebStarts"))}
              aria-describedby={showStartsHint ? startsAtHintId : undefined}
              data-testid="recurrence-event-starts-at"
            />
            {/* Both of the hint's sentences hold for every rule the structured
                builder emits, and NEITHER holds for a stored advanced rule:
                `state.raw` passes through verbatim (buildConfigFromState), so
                moving the start does not rewrite the pattern, and the start may
                end up off the schedule entirely (the save is then refused with
                EVENT_START_NOT_IN_SCHEDULE). `rbCustomRawNote` below already
                says the rule is advanced, so the hint is suppressed rather
                than replaced. `aria-describedby` above drops with it:
                pointing it at an id nothing renders is worse than no
                description. See `showStartsHint` for the second case it is
                off in. */}
            {showStartsHint && (
              <Text
                variant="caption"
                tone="muted"
                id={startsAtHintId}
                data-testid="recurrence-event-starts-hint"
              >
                {String(t("admin.rbStartsHint"))}
              </Text>
            )}
          </YStack>
        )}

        {active && (
          <YStack gap={16} data-testid="recurrence-config">
            {/* ── Custom panel (inline expand, flat Swiss section) ── */}
            {showCustomPanel && (
              <YStack gap={12} data-testid="recurrence-custom-panel">
                {state.raw != null && (
                  <Text variant="caption" tone="muted" style={monoStyle}>
                    {String(t("admin.rbCustomRawNote", { rule: state.raw }))}
                  </Text>
                )}
                <YStack gap={6}>
                  <FieldLabel>{String(t("admin.rbRepeatEvery"))}</FieldLabel>
                  <XStack gap={8} alignItems="center">
                    <input
                      type="number"
                      min={INTERVAL_MIN}
                      max={INTERVAL_MAX}
                      step={1}
                      inputMode="numeric"
                      value={String(state.interval)}
                      onChange={(e) => handleIntervalChange(e.target.value)}
                      aria-label={String(t("admin.rbRepeatEvery"))}
                      style={numberInputStyle}
                      data-testid="recurrence-interval"
                    />
                    <select
                      value={state.unit}
                      onChange={(e) =>
                        handleUnitChange(e.target.value as CustomUnit)
                      }
                      aria-label={String(t("admin.rbRepeatEvery"))}
                      style={{ ...selectStyle, width: "auto", minWidth: 130 }}
                      data-testid="recurrence-unit"
                    >
                      <option value="days">
                        {String(
                          t("admin.rbUnitDays", { count: state.interval }),
                        )}
                      </option>
                      <option value="weeks">
                        {String(
                          t("admin.rbUnitWeeks", { count: state.interval }),
                        )}
                      </option>
                      <option value="months">
                        {String(
                          t("admin.rbUnitMonths", { count: state.interval }),
                        )}
                      </option>
                    </select>
                  </XStack>
                </YStack>

                {/* Weekday chips — LABEL basis (tokens derived at emit) */}
                {showDayPicker && (
                  <YStack gap={6}>
                    <FieldLabel>{String(t("admin.rbRepeatOn"))}</FieldLabel>
                    <XStack
                      gap={6}
                      flexWrap="wrap"
                      role="group"
                      aria-label={String(t("admin.rbRepeatOn"))}
                      data-testid="recurrence-day-picker"
                    >
                      {WEEKDAYS.map((day) => {
                        const isActive = state.byday.includes(day);
                        const pinned = isWeekdayPinned(
                          day,
                          state.byday,
                          localDay,
                        );
                        const dayLabel = String(t(WEEKDAY_LABEL_KEYS[day]));
                        return (
                          <button
                            key={day}
                            type="button"
                            role="checkbox"
                            aria-checked={isActive}
                            aria-disabled={pinned || undefined}
                            aria-label={
                              pinned
                                ? String(
                                    t("admin.rbDayAlwaysIncluded", {
                                      weekday: dayLabel,
                                    }),
                                  )
                                : dayLabel
                            }
                            // Associated with the visible caption below
                            // rather than a `title`: tooltips are unreachable
                            // by keyboard and touch, and the caption already
                            // carries the same sentence permanently.
                            aria-describedby={
                              pinned && pinnedDayExplanation
                                ? pinnedDayNoteId
                                : undefined
                            }
                            onClick={() => handleDayToggle(day)}
                            style={dayChipStyle(isActive, pinned)}
                            data-testid={`recurrence-day-${day.toLowerCase()}`}
                          >
                            {dayLabel}
                            {pinned && (
                              <Lock
                                size={11}
                                color="currentColor"
                                aria-hidden
                                data-testid="recurrence-day-locked-icon"
                              />
                            )}
                          </button>
                        );
                      })}
                    </XStack>
                    {pinnedDayExplanation && (
                      <Text
                        variant="caption"
                        tone="muted"
                        id={pinnedDayNoteId}
                        data-testid="recurrence-day-locked-note"
                      >
                        {pinnedDayExplanation}
                      </Text>
                    )}
                  </YStack>
                )}
              </YStack>
            )}

            {/* ── Ends chooser (presets and custom alike) ── */}
            <YStack gap={8}>
              <FieldLabel>{String(t("admin.rbEnds"))}</FieldLabel>
              {/* Opt-in, and FIRST when present: on a surface that offers it,
                  open-ended is the resting state of the schedule, not an
                  afterthought below two bounded options. Absent entirely when
                  the prop is off, so the ticketed builder's chooser is the
                  same two rows it has always been. */}
              {allowNeverEnds && (
                <XStack
                  tag="label"
                  gap={10}
                  alignItems="center"
                  flexWrap="wrap"
                  minHeight={44}
                >
                  <input
                    type="radio"
                    name="recurrence-end-mode"
                    checked={state.endMode === "never"}
                    onChange={() => handleEndModeChange("never")}
                    style={radioStyle}
                    data-testid="recurrence-end-never"
                  />
                  <Text variant="bodySmall">
                    {String(t("admin.rbEndsNever"))}
                  </Text>
                </XStack>
              )}
              <XStack tag="label" gap={10} alignItems="center" flexWrap="wrap">
                <input
                  type="radio"
                  name="recurrence-end-mode"
                  checked={state.endMode === "count"}
                  onChange={() => handleEndModeChange("count")}
                  style={radioStyle}
                  data-testid="recurrence-end-after"
                />
                <Text variant="bodySmall">
                  {String(t("admin.rbEndsAfter"))}
                </Text>
                <input
                  type="number"
                  min={COUNT_MIN}
                  max={COUNT_MAX}
                  step={1}
                  inputMode="numeric"
                  value={state.count}
                  onChange={(e) => handleCountChange(e.target.value)}
                  onBlur={handleCountBlur}
                  disabled={state.endMode !== "count"}
                  aria-label={String(t("admin.rbEndsAfter"))}
                  style={{
                    ...numberInputStyle,
                    opacity: state.endMode === "count" ? 1 : 0.5,
                  }}
                  data-testid="recurrence-count"
                />
                <Text variant="bodySmall">
                  {String(
                    t(occurrenceCopyKeys?.unit ?? "admin.rbEndsAfterShows", {
                      count: countForPlural,
                    }),
                  )}
                </Text>
              </XStack>
              <XStack tag="label" gap={10} alignItems="center" flexWrap="wrap">
                <input
                  type="radio"
                  name="recurrence-end-mode"
                  checked={state.endMode === "until"}
                  onChange={() => handleEndModeChange("until")}
                  style={radioStyle}
                  data-testid="recurrence-end-on"
                />
                <Text variant="bodySmall">
                  {String(t("admin.rbEndsOnDate"))}
                </Text>
                <NativeDateTimeInput
                  type="date"
                  value={untilInputValue}
                  min={eventStartsAt?.slice(0, 10) ?? undefined}
                  disabled={state.endMode !== "until"}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    handleUntilChange(e.target.value)
                  }
                  opacity={state.endMode === "until" ? 1 : 0.5}
                  aria-label={String(t("admin.rbEndDate"))}
                  data-testid="recurrence-until"
                />
              </XStack>
            </YStack>

            {/* ── Summary band ── */}
            <SummaryBand data-testid="recurrence-summary">
              <XStack gap={8} alignItems="flex-start">
                <XStack paddingTop={2}>
                  <Info size={14} color={theme.colorMuted?.val} aria-hidden />
                </XStack>
                <Text
                  variant="bodySmall"
                  flex={1}
                  data-testid="recurrence-summary-text"
                  {...(state.raw != null ? { style: monoStyle } : {})}
                >
                  {summaryLine}
                </Text>
              </XStack>

              {config && chipDates.length > 0 && (
                <XStack
                  gap={6}
                  flexWrap="wrap"
                  alignItems="center"
                  data-testid="recurrence-preview-dates"
                >
                  {chipDates.map((label, i) => (
                    <DateChip key={`${label}-${i}`}>
                      <Text fontSize={12} style={chipDateStyle}>
                        {label}
                      </Text>
                    </DateChip>
                  ))}
                  {moreCount > 0 && (
                    <Text variant="caption" tone="muted">
                      {String(t("admin.rbPreviewMore", { count: moreCount }))}
                    </Text>
                  )}
                </XStack>
              )}

              {config ? (
                // `consequence: null` OMITS the caption — an explicit choice
                // by the caller, so it cannot be reached by a `??` falling
                // through to the default key.
                consequenceKey === null ? null : (
                  <Text variant="caption" tone="muted">
                    {String(t(consequenceKey, { count: draftCount }))}
                  </Text>
                )
              ) : (
                // A null config has more than one cause, and the end-date one
                // is not the most common: with no usable start,
                // `buildConfigFromState` bails on `!ctx.dtstartIso` before it
                // ever looks at the end mode, and the band used to tell the
                // organizer to choose an end date they had already chosen.
                // Keyed off `dtstartIso` rather than `eventStartsAt` so a start
                // the builder cannot read is named too, since that lands in the
                // same branch for the same reason.
                <Text
                  variant="caption"
                  color="$warning"
                  data-testid="recurrence-incomplete-note"
                >
                  {String(
                    t(
                      dtstartIso
                        ? "admin.rbChooseEndDate"
                        : "admin.rbAddStartDate",
                    ),
                  )}
                </Text>
              )}
            </SummaryBand>
          </YStack>
        )}
      </YStack>
    </SectionContainer>
  );
}

export default RecurrenceBuilder;
