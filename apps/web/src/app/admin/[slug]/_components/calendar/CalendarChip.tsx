"use client";

import { forwardRef, type CSSProperties, type MouseEvent } from "react";
import { Text, Tooltip } from "@th/ui";
import { AlertTriangle, Globe, Repeat } from "lucide-react";

import { Mono } from "./Mono";
import {
  chipAccessibleName,
  formatRespondBy,
  formatTime,
  isSoldOut,
  tzMismatch,
  venueLocalTime,
} from "./helpers";
import {
  CAL_BORDER,
  CAL_DASHED_OUTLINE,
  CAL_SOLD_OUT_BAR,
  CAL_SOLD_OUT_BG,
  CAL_SURFACE,
  CAL_WARNING,
  STATUS_BAR,
  STATUS_BG,
} from "./status-colors";
import type { CalendarItem, CalendarMode } from "./types";
import { useCalendarLabels } from "./use-calendar-labels";

export type CalendarChipProps = {
  item: CalendarItem;
  /** Paint zone. */
  timezone: string;
  viewerTimezone: string;
  mode: CalendarMode;
  /** Month chips stack in a cell; week chips are positioned blocks (via `style`). */
  density: "month" | "week";
  onPress?: (item: CalendarItem, anchor: HTMLButtonElement, renderKey: string) => void;
  /** Positioning for week blocks — merged over the chip's own layout. */
  style?: CSSProperties;
  /** A midnight-crossing continuation painted into the next column / cell. */
  continuation?: boolean;
  /** True while THIS render's peek is open. */
  expanded?: boolean;
  /** Set when pressing opens a peek — drives `aria-haspopup`. */
  hasPopup?: boolean;
  /**
   * Unique per rendered chip (`helpers.renderKeyFor`). Defaults to the item
   * id for a standalone chip; the views always pass one.
   */
  renderKey?: string;
  /** Test id override (`helpers.chipTestId`) — the primary render keeps the bare id. */
  testId?: string;
  /**
   * Week only: this block is cascaded over one beneath it (left offset > 0).
   * Draws a 2px paper edge on its left so the two read as separate cards.
   */
  separated?: boolean;
  /**
   * FR-023 price copy for the WEEK block's third line. The WEEK VIEW decides
   * whether the block can carry it (see `WEEK_PRICE_MIN_*` there) and passes
   * null when it cannot; the chip additionally refuses it at `density
   * === "month"`, so a month chip can never show price even if a future
   * caller passes one. Null / empty renders NOTHING — no blank line.
   */
  priceLine?: string | null;
};

/**
 * Week blocks OVERLAP (the 0 / 34 / 68% cascade), so their fill has to be
 * opaque or three same-time shows paint their text through one another —
 * "2:28 PM 2:28PM 2:28PM" superimposed, which is what shipped. The status
 * tint is a 10%-alpha wash by design (correct in the month grid, where chips
 * stack and never overlap), so the week composites it over paper instead of
 * over whatever is beneath: an opaque `background-color` plus the tint as a
 * one-stop gradient in `background-image`.
 */
function opaqueTint(tint: string): CSSProperties {
  return { backgroundColor: CAL_SURFACE, backgroundImage: `linear-gradient(${tint}, ${tint})` };
}

/**
 * One calendar item as a real <button> (FR-013 / FR-016): status fill + 3px
 * status bar, time row with the series / timezone / conflict glyphs, title.
 * Unconfirmed listings (venue-confirmation spec) and holds drop the fill for
 * a dashed ink outline; a confirmed hold is solid; a challenged hold borrows
 * the warning hue and carries its respond-by. Accessible name is
 * "{time} {title}".
 */
export const CalendarChip = forwardRef<HTMLButtonElement, CalendarChipProps>(
  function CalendarChip(
    {
      item,
      timezone,
      viewerTimezone,
      mode,
      density,
      onPress,
      style,
      continuation = false,
      expanded,
      hasPopup = false,
      renderKey,
      testId,
      separated = false,
      priceLine,
    },
    ref,
  ) {
    const labels = useCalendarLabels();
    const key = renderKey ?? item.id;
    // Computed before the name so the announced label can carry the same
    // "Sold out" the chip paints — `aria-label` replaces the button's text.
    const soldOut = item.kind === "event" && mode === "public" && isSoldOut(item);
    const name = chipAccessibleName(item, timezone, labels, soldOut ? labels.soldOut : null);
    const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      onPress?.(item, event.currentTarget, key);
    };
    const base: CSSProperties = {
      display: "flex",
      flexDirection: "column",
      gap: 1,
      padding: "3px 6px",
      width: "100%",
      minWidth: 0,
      maxWidth: "100%",
      overflow: "hidden",
      borderRadius: 0,
      textAlign: "left",
      cursor: onPress ? "pointer" : "default",
      ...style,
    };
    // Row 1 is a deliberate OFF-LADDER mono pair (10px / 0.4px), not a rung:
    // the `xs` rung's 2.5px tracking makes "10:30 PM" wider than a 120px week
    // column can afford next to three glyphs, and the `lg` rung's 13px is too
    // tall for a 22px block. Same pair in both densities — the week block only
    // differs in its positioning (`style`), not its type.
    const week = density === "week";
    // The paper edge between a block and the one it cascades over.
    const separator = separated ? `-2px 0 0 0 ${CAL_SURFACE}` : null;
    const timeSize = 10;
    const timeTracking = 0.4;
    const glyph = 10;
    const popupProps = hasPopup
      ? { "aria-haspopup": "dialog" as const, "aria-expanded": Boolean(expanded) }
      : {};

    if (item.kind === "hold") {
      const challenged = item.status === "CHALLENGED";
      const confirmed = item.status === "CONFIRMED";
      const border = confirmed
        ? `2px solid ${CAL_BORDER}`
        : challenged
          ? `2px dashed ${CAL_WARNING}`
          : CAL_DASHED_OUTLINE;
      // FR-016: the respond-by rides the chip while the hold is challenged.
      const row = confirmed
        ? labels.holdConfirmedTag(item.position)
        : challenged
          ? item.respondBy
            ? labels.holdChallengedTag(item.position, formatRespondBy(item.respondBy, timezone, labels))
            : labels.holdChallengedTag(item.position, labels.holdStatuses.CHALLENGED)
          : labels.holdTag(item.position);
      return (
        <button
          ref={ref}
          type="button"
          className="th-cal-btn th-cal-chip"
          data-testid={testId ?? `calendar-hold-chip-${item.id}`}
          data-kind="hold"
          data-density={density}
          data-hold-status={item.status}
          data-render-key={key}
          aria-label={name}
          {...popupProps}
          onClick={handleClick}
          style={{
            ...base,
            border,
            ...(week ? { backgroundColor: CAL_SURFACE } : { background: "transparent" }),
            ...(separator ? { boxShadow: separator } : {}),
          }}
        >
          <span style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
            {challenged && (
              <AlertTriangle
                size={glyph}
                color={CAL_WARNING}
                role="img"
                aria-label={labels.holdStatuses.CHALLENGED}
                style={{ flexShrink: 0 }}
              />
            )}
            <Mono
              fontSize={timeSize}
              letterSpacing={timeTracking}
              lineHeight={13}
              tone={challenged ? "warning" : "muted"}
              truncate
              data-testid={`${testId ?? `calendar-hold-chip-${item.id}`}-row`}
            >
              {row}
            </Mono>
          </span>
          <Text
            variant="span"
            fontSize={12}
            lineHeight={15}
            weight="semibold"
            tone="muted"
            truncate
          >
            {item.title}
          </Text>
        </button>
      );
    }

    const unconfirmed = item.venueConfirmed === false;
    // The block has room for exactly ONE line under the title, so the three
    // candidates are ranked rather than stacked: an unconfirmed booking is an
    // action the venue owes, "Sold out" changes whether the reader should
    // click at all, and price is the nice-to-have. The UNCONFIRMED word is
    // internal vocabulary — the dashed frame still marks the chip in public
    // mode, but the tag itself never reaches a third-party page.
    const thirdLine: "unconfirmed" | "soldOut" | "price" | null =
      unconfirmed && mode === "internal"
        ? "unconfirmed"
        : soldOut
          ? "soldOut"
          : week && priceLine
            ? "price"
            : null;
    const mismatch = tzMismatch(item, viewerTimezone);
    const repeat = Boolean(item.seriesId || item.occurrence);
    const inkTone = unconfirmed ? "muted" : "default";
    const chipTestId = testId ?? `calendar-event-chip-${item.id}`;
    // The conflict ring is an INSET box-shadow, never `outline`, so the
    // focus-visible ring in calendar.css survives.
    const conflictRing = item.conflict ? `inset 0 0 0 1px ${CAL_WARNING}` : null;
    const shadow = [conflictRing, separator].filter(Boolean).join(", ");
    // Sold out mutes the FRAME — the tint and the 3px bar go neutral — and
    // leaves the title and time at full ink. Dimming the whole button (the
    // `opacity: 0.55` this replaced) took the 12px semibold title to 3.77:1
    // on paper, below AA, on the one surface where the rule fires: a public
    // embed on someone else's page.
    const tint = soldOut ? CAL_SOLD_OUT_BG : STATUS_BG[item.status];
    const bar = soldOut ? CAL_SOLD_OUT_BAR : STATUS_BAR[item.status];
    const frame: CSSProperties = unconfirmed
      ? {
          border: CAL_DASHED_OUTLINE,
          ...(week ? { backgroundColor: CAL_SURFACE } : { background: "transparent" }),
          ...(shadow ? { boxShadow: shadow } : {}),
        }
      : {
          ...(week ? opaqueTint(tint) : { background: tint }),
          borderLeft: `3px solid ${bar}`,
          ...(shadow ? { boxShadow: shadow } : {}),
        };

    return (
      <button
        ref={ref}
        type="button"
        className="th-cal-btn th-cal-chip"
        data-testid={chipTestId}
        data-kind="event"
        data-density={density}
        data-status={item.status}
        data-render-key={key}
        data-unconfirmed={unconfirmed ? "true" : undefined}
        data-conflict={item.conflict ? "true" : undefined}
        data-sold-out={soldOut ? "true" : undefined}
        data-continuation={continuation ? "true" : undefined}
        aria-label={name}
        {...popupProps}
        onClick={handleClick}
        style={{ ...base, ...frame }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
          {item.conflict && (
            <AlertTriangle
              size={glyph}
              color={CAL_WARNING}
              role="img"
              aria-label={labels.doubleBooked}
              style={{ flexShrink: 0 }}
            />
          )}
          {repeat && (
            <Repeat
              size={glyph}
              aria-hidden
              style={{ flexShrink: 0, color: "currentColor" }}
            />
          )}
          {mismatch && (
            <Tooltip
              anchor={
                <span
                  role="img"
                  aria-label={labels.venueLocal(venueLocalTime(item))}
                  style={{ display: "inline-flex", flexShrink: 0 }}
                >
                  <Globe size={glyph} aria-hidden style={{ color: "currentColor" }} />
                </span>
              }
              placement="top"
            >
              {labels.venueLocal(venueLocalTime(item))}
            </Tooltip>
          )}
          <Mono
            fontSize={timeSize}
            letterSpacing={timeTracking}
            lineHeight={13}
            tone={inkTone}
            truncate
          >
            {continuation ? labels.continued : formatTime(item.startsAt, timezone)}
          </Mono>
        </span>
        <Text
          variant="span"
          fontSize={12}
          lineHeight={15}
          weight="semibold"
          tone={inkTone}
          truncate
        >
          {item.title}
        </Text>
        {thirdLine === "unconfirmed" && (
          <Mono
            size="2xs"
            upper
            fontSize={9}
            tone="muted"
            truncate
            data-testid={`${chipTestId}-unconfirmed`}
          >
            {labels.unconfirmed}
          </Mono>
        )}
        {thirdLine === "soldOut" && (
          <Mono
            size="2xs"
            upper
            fontSize={9}
            tone="muted"
            truncate
            data-testid={`${chipTestId}-sold-out`}
          >
            {labels.soldOut}
          </Mono>
        )}
        {/* Price is a NUMBER, not a label: mono but never uppercased, so
            "From $15" stays "From $15". */}
        {thirdLine === "price" && (
          <Mono
            size="2xs"
            fontSize={9}
            tone="muted"
            truncate
            data-testid={`${chipTestId}-price`}
          >
            {priceLine}
          </Mono>
        )}
      </button>
    );
  },
);
