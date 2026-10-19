"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { Bookmark, Check, Lock } from "lucide-react";
import { useFormatters, useTranslations } from "@th/ui";

import { holdPositionKey } from "./booking-holds";
import {
  describeHoldDay,
  holdGridMoveForKey,
  monthReadsAllDark,
  moveHoldFocus,
  type HoldDayCell,
  type HoldMonth,
  type HoldSelection,
} from "./hold-date-grid";
import styles from "./HoldDatePicker.module.css";

// ─────────────────────────────────────────────────────────────────────────────
// THE MONTH — one tab stop, a roving tabindex, and a cell that says what you
// would be joining BEFORE you click it.
//
// EVERY CUE IS DOUBLE-CODED. Selection is `aria-pressed` + an accent fill + a
// check; a taken night is an ink fill + a lock + the word "Taken"; a dark
// night is a hatch + the word "Dark"; the act's asked-for dates carry a corner
// notch AND a sentence in the accessible name. Nothing in this grid is legible
// only in colour.
//
// UNAVAILABLE CELLS STAY FOCUSABLE. They carry `aria-disabled` rather than
// `disabled`, because a `disabled` button drops out of the roving sequence and
// a keyboard user would arrow into a hole. Landing on a taken night is also
// how you read WHY it is taken — the rail names the show.
//
// A DARK NIGHT IS NOT UNAVAILABLE (owner ruling 2026-08-31). It is pressable,
// carries `aria-pressed`, and keeps its hatch THROUGH selection so an unusual
// pick never stops looking unusual. Its accessible name leads with "venue
// dark" so it can never be taken by accident, and the cell's own label stays
// the word "Dark" rather than the offer — the offer is in the name, the rail
// and the tray, and the one thing worth the four characters in the cell is
// that the venue is shut.
//
// ARROWS CROSS THE MONTH. `onNavigate` hands the parent a date that may be
// outside the rendered month; the parent pages to it and bumps `focusNonce`,
// which is what re-takes DOM focus after the new month renders. Without that
// nonce the focused cell unmounts mid-paging and focus falls to <body>.
// ─────────────────────────────────────────────────────────────────────────────

/** A Sunday, purely as a seed for locale-correct weekday names. */
const WEEKDAY_SEED = Date.UTC(2021, 7, 1, 12);

export type HoldMonthGridProps = {
  month: HoldMonth;
  selection: HoldSelection;
  /** The one cell in the tab order. */
  focusDate: string;
  /** Bumped by the parent whenever DOM focus should be re-taken. */
  focusNonce: number;
  /** Dates the last `placeMany` refused — marked so they can be swapped. */
  failedDates: ReadonlySet<string>;
  onNavigate: (date: string, extend: boolean) => void;
  onActivate: (date: string, extend: boolean) => void;
  disabled?: boolean;
  testIdBase: string;
};

export function HoldMonthGrid({
  month,
  selection,
  focusDate,
  focusNonce,
  failedDates,
  onNavigate,
  onActivate,
  disabled = false,
  testIdBase,
}: HoldMonthGridProps) {
  const t = useTranslations();
  const fmt = useFormatters();
  const gridRef = useRef<HTMLDivElement | null>(null);

  const weekdayNames = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) =>
        fmt.dateTime(new Date(WEEKDAY_SEED + i * 86_400_000), {
          weekday: "short",
          timeZone: "UTC",
        }),
      ),
    [fmt],
  );

  const monthLabel = useMemo(
    () =>
      fmt.dateTime(new Date(`${month.firstDate}T12:00:00Z`), {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      }),
    [fmt, month.firstDate],
  );

  const dayLabel = useCallback(
    (date: string) =>
      fmt.dateTime(new Date(`${date}T12:00:00Z`), {
        weekday: "long",
        day: "numeric",
        month: "long",
        timeZone: "UTC",
      }),
    [fmt],
  );

  const ordinal = useCallback(
    (position: number) =>
      String(t(holdPositionKey(position), { position: String(position) })),
    [t],
  );

  // When EVERY day the word could sit on is dark, the per-cell "Dark" is
  // noise (availability-onboarding FR-006 `note:`): the hatch and the legend
  // already carry it, and 31 repetitions of one word read as a broken grid
  // rather than an unconfigured venue. Only the WORD goes — the hatch, the
  // legend entry and the "venue dark" accessible name are untouched, and the
  // word returns on any month where days differ.
  const suppressDarkWord = useMemo(
    () => monthReadsAllDark(month.cells),
    [month.cells],
  );

  // Focus follows the parent's nonce, never a render. Skipping nonce 0 is what
  // keeps the picker from stealing focus the moment it mounts.
  useEffect(() => {
    if (focusNonce === 0) return;
    const cell = gridRef.current?.querySelector<HTMLButtonElement>(
      `[data-date="${focusDate}"]`,
    );
    cell?.focus();
  }, [focusDate, focusNonce]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-date]");
      const date = target?.dataset.date;
      if (!date) return;

      const move = holdGridMoveForKey(event.key);
      if (move) {
        event.preventDefault();
        onNavigate(moveHoldFocus(date, move), event.shiftKey);
        return;
      }
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        onActivate(date, event.shiftKey);
      }
    },
    [onActivate, onNavigate],
  );

  return (
    <div
      ref={gridRef}
      role="grid"
      aria-label={String(t("admin.bkHoldPickGridLabel", { month: monthLabel }))}
      aria-disabled={disabled || undefined}
      className={styles.weeks}
      onKeyDown={onKeyDown}
      data-testid={`${testIdBase}-grid`}
    >
      <div role="row" className={styles.dowRow}>
        {weekdayNames.map((name) => (
          <div key={name} role="columnheader" className={styles.dow}>
            {name}
          </div>
        ))}
      </div>

      {month.weeks.map((week, weekIndex) => (
        <div role="row" className={styles.week} key={week.find(Boolean)?.date ?? weekIndex}>
          {week.map((cell, dayIndex) =>
            cell === null ? (
              <div
                role="gridcell"
                className={styles.pad}
                key={`pad-${weekIndex}-${dayIndex}`}
              />
            ) : (
              <div role="gridcell" className={styles.cell} key={cell.date}>
                <DayButton
                  cell={cell}
                  selected={selection.dates.includes(cell.date)}
                  failed={failedDates.has(cell.date)}
                  tabbable={cell.date === focusDate}
                  disabled={disabled}
                  suppressDarkWord={suppressDarkWord}
                  dayLabel={dayLabel}
                  ordinal={ordinal}
                  onActivate={onActivate}
                  testIdBase={testIdBase}
                />
              </div>
            ),
          )}
        </div>
      ))}
    </div>
  );
}

function DayButton({
  cell,
  selected,
  failed,
  tabbable,
  disabled,
  suppressDarkWord,
  dayLabel,
  ordinal,
  onActivate,
  testIdBase,
}: {
  cell: HoldDayCell;
  selected: boolean;
  failed: boolean;
  tabbable: boolean;
  disabled: boolean;
  /** The whole month is dark, so the per-cell word is noise. See the grid. */
  suppressDarkWord: boolean;
  dayLabel: (date: string) => string;
  ordinal: (position: number) => string;
  onActivate: (date: string, extend: boolean) => void;
  testIdBase: string;
}) {
  const t = useTranslations();
  const described = describeHoldDay(cell);

  // ── The sentence, and its four-character echo in the cell ────────────────
  let state: string;
  let short: string | null = null;
  let offer = false;
  switch (described.kind) {
    case "past":
      state = String(t("admin.bkHoldPickDayPast"));
      break;
    case "dark":
      // "venue dark" LEADS the sentence: the night is takeable, but nobody
      // should reach the offer without hearing the warning first.
      state =
        described.lineLength === 0
          ? String(t("admin.bkHoldPickDayDarkFree"))
          : String(
              t("admin.bkHoldPickDayDarkLine", {
                count: described.lineLength,
                position: ordinal(described.offered),
              }),
            );
      short = suppressDarkWord ? null : String(t("admin.bkHoldPickShortDark"));
      break;
    case "taken":
      state = described.label
        ? String(t("admin.bkHoldPickDayTaken", { label: described.label }))
        : String(t("admin.bkHoldPickDayTakenUnnamed"));
      short = String(t("admin.bkHoldPickShortTaken"));
      break;
    case "held":
      state = String(
        t("admin.bkHoldPickDayHeld", { position: ordinal(described.position) }),
      );
      short = String(t("admin.bkHoldPickShortHeld"));
      break;
    case "open":
      state =
        described.lineLength === 0
          ? String(t("admin.bkHoldPickDayOpen"))
          : String(
              t("admin.bkHoldPickDayLine", {
                count: described.lineLength,
                position: ordinal(described.offered),
              }),
            );
      // An empty night says nothing: "you'd be 1st" on twenty cells is noise,
      // and the legend plus the accessible name already carry it. The offer is
      // printed exactly where it is a decision — a night with a line, or one
      // this press is about to join.
      if (described.lineLength > 0 || selected) {
        short = String(
          t("admin.bkHoldPickShortOffer", { position: ordinal(described.offered) }),
        );
        offer = true;
      }
      break;
  }

  const name = [
    `${dayLabel(cell.date)} — ${state}`,
    cell.challenged ? String(t("admin.bkHoldPickDayChallenged")) : null,
    cell.preferred ? String(t("admin.bkHoldPickDayAsked")) : null,
    failed ? String(t("admin.bkHoldPickDayFailed")) : null,
  ]
    .filter(Boolean)
    .join(". ");

  const interactive = cell.selectable && !disabled;

  return (
    <button
      type="button"
      className={styles.day}
      data-date={cell.date}
      data-status={cell.status}
      data-selected={selected || undefined}
      data-held={cell.minePosition !== null || undefined}
      data-preferred={cell.preferred || undefined}
      data-testid={`${testIdBase}-day-${cell.date}`}
      tabIndex={tabbable ? 0 : -1}
      aria-label={name}
      aria-pressed={cell.selectable ? selected : undefined}
      aria-disabled={interactive ? undefined : true}
      onClick={(event) => {
        if (!interactive) return;
        onActivate(cell.date, event.shiftKey);
      }}
    >
      <span className={styles.dayNum}>{cell.dayOfMonth}</span>
      {short ? (
        <span className={`${styles.dayState}${offer ? ` ${styles.dayOffer}` : ""}`} aria-hidden>
          {short}
        </span>
      ) : null}
      {cell.line.length > 0 && cell.status !== "taken" ? (
        <span className={styles.ticks} aria-hidden>
          {cell.line.slice(0, 4).map((hold) => (
            <i
              key={hold.id}
              className={`${styles.tick}${hold.status === "CHALLENGED" ? ` ${styles.tickChallenged}` : ""}`}
            />
          ))}
        </span>
      ) : null}
      {selected ? (
        <span className={styles.dayGlyph} aria-hidden>
          <Check size={11} strokeWidth={2.5} />
        </span>
      ) : cell.status === "taken" ? (
        <span className={styles.dayGlyph} aria-hidden>
          <Lock size={11} strokeWidth={2} />
        </span>
      ) : cell.minePosition !== null ? (
        <span className={styles.dayGlyph} aria-hidden>
          <Bookmark size={11} strokeWidth={2} />
        </span>
      ) : null}
    </button>
  );
}
