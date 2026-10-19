"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { BottomSheet, NextLinkAnchor, Popover, Text } from "@th/ui";
import { Copy, Download, ExternalLink, Globe, Pencil, Repeat } from "lucide-react";

import { Mono } from "./Mono";
import {
  formatMonthDay,
  formatRespondBy,
  formatShortDay,
  formatSold,
  formatTimeRange,
  isEvent,
  tzMismatch,
  venueLocalTime,
} from "./helpers";
import { CAL_BORDER_SOFT, CAL_MUTED, CAL_PEEK_SHADOW } from "./status-colors";
import type {
  CalendarEventItem,
  CalendarHoldItem,
  CalendarHoldLineMate,
  CalendarItem,
  CalendarPeekVariant,
} from "./types";
import { useCalendarLabels } from "./use-calendar-labels";
import { HoldTag, StatusTag } from "./view-shared";

/**
 * Where focus returns on close. A function is resolved at close time, so a
 * mount whose trigger can be re-rendered between open and close still lands
 * on the live element.
 */
export type ReturnFocusTarget = HTMLElement | null | (() => HTMLElement | null);

export type CalendarPeekProps = {
  item: CalendarItem;
  /**
   * The chip / row this peek belongs to, as a live DOM node. It is NEVER
   * rendered here: the popover positions against it in place, so the chip
   * keeps its identity, focus and DOM position when the peek opens.
   */
  anchorElement: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  variant: CalendarPeekVariant;
  timezone: string;
  viewerTimezone: string;
  /** Below 600px the peek is a bottom sheet instead of a popover. */
  sheet?: boolean;
  onDownloadIcs?: (item: CalendarEventItem) => void;
  returnFocusTo?: ReturnFocusTarget;
};

function resolveTarget(target: ReturnFocusTarget | undefined): HTMLElement | null {
  if (!target) return null;
  return typeof target === "function" ? target() : target;
}

function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <Mono size="xs" upper tone="muted" style={{ paddingTop: 2 }}>
        {label}
      </Mono>
      <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>{children}</span>
    </>
  );
}

function EventPeekBody({
  item,
  variant,
  timezone,
  viewerTimezone,
  titleId,
  onDownloadIcs,
}: {
  item: CalendarEventItem;
  variant: CalendarPeekVariant;
  timezone: string;
  viewerTimezone: string;
  titleId: string;
  onDownloadIcs?: (item: CalendarEventItem) => void;
}) {
  const labels = useCalendarLabels();
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  const mismatch = tzMismatch(item, viewerTimezone);
  const editHref = item.href?.series ?? item.href?.edit;
  const publicHref = item.href?.public;
  const kicker = `${formatShortDay(item.startsAt, timezone, labels)} · ${formatTimeRange(item.startsAt, item.endsAt, timezone).replace("–", " – ")}`;

  // The "Copied" flash must not fire on an unmounted peek.
  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  const copyLink = useCallback(() => {
    if (!publicHref) return;
    const url =
      typeof window !== "undefined" && publicHref.startsWith("/")
        ? `${window.location.origin}${publicHref}`
        : publicHref;
    const clipboard = navigator.clipboard;
    if (!clipboard) return;
    clipboard
      .writeText(url)
      .then(() => {
        setCopied(true);
        if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
        copiedTimer.current = window.setTimeout(() => setCopied(false), 1500);
      })
      // A denied clipboard shows nothing — the label simply stays "Copy link".
      .catch(() => {});
  }, [publicHref]);

  return (
    <>
      <Mono size="xs" upper tone="muted" data-testid="calendar-peek-kicker">
        {kicker}
      </Mono>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, justifyContent: "space-between" }}>
        <Text variant="span" id={titleId} fontSize={16} lineHeight={20} weight="bold" style={{ minWidth: 0 }}>
          {item.title}
        </Text>
        <StatusTag status={item.status} />
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "88px minmax(0, 1fr)",
          rowGap: 6,
          columnGap: 12,
          alignItems: "start",
        }}
      >
        {item.venueName && (
          <KeyValue label={labels.keys.venue}>
            <Text variant="bodySmall" truncate>
              {item.venueName}
            </Text>
          </KeyValue>
        )}
        {mismatch && (
          <KeyValue label={labels.keys.local}>
            <Globe size={12} aria-hidden style={{ color: CAL_MUTED, flexShrink: 0 }} />
            <Mono size="md" data-testid="calendar-peek-local">
              {venueLocalTime(item)}
            </Mono>
          </KeyValue>
        )}
        {(item.totalCapacity != null || item.ticketsSold != null) && (
          <KeyValue label={item.totalCapacity == null ? labels.keys.going : labels.keys.sold}>
            <Mono size="lg" data-testid="calendar-peek-sold">
              {formatSold(item)}
            </Mono>
          </KeyValue>
        )}
        {item.occurrence && (
          <KeyValue label={labels.keys.date}>
            <Mono size="md" data-testid="calendar-peek-occurrence">
              {labels.occurrenceOf(item.occurrence.index, item.occurrence.total)}
            </Mono>
            <Repeat size={12} aria-hidden style={{ color: CAL_MUTED, flexShrink: 0 }} />
          </KeyValue>
        )}
        {item.seriesId && (
          <KeyValue label={labels.keys.series}>
            {item.href?.series ? (
              <NextLinkAnchor
                href={item.href.series}
                className="th-cal-textlink"
                data-testid="calendar-peek-series"
              >
                <Text variant="bodySmall" tone="inherit" truncate>
                  {item.seriesName ?? labels.series}
                </Text>
              </NextLinkAnchor>
            ) : (
              <Text variant="bodySmall" truncate>
                {item.seriesName ?? labels.series}
              </Text>
            )}
          </KeyValue>
        )}
        {item.ownerName && (
          <KeyValue label={labels.keys.owner}>
            <Text variant="bodySmall" truncate>
              {item.ownerName}
            </Text>
          </KeyValue>
        )}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
          paddingTop: 12,
          borderTop: `1px solid ${CAL_BORDER_SOFT}`,
        }}
      >
        {editHref && (
          <NextLinkAnchor
            href={editHref}
            className="th-cal-action"
            data-variant="primary"
            data-testid="calendar-peek-edit"
          >
            <Pencil size={12} aria-hidden />
            {labels.edit}
          </NextLinkAnchor>
        )}
        {publicHref && (
          <NextLinkAnchor
            href={publicHref}
            target="_blank"
            rel="noreferrer"
            className="th-cal-action"
            data-testid="calendar-peek-public"
          >
            {labels.publicPage}
            <ExternalLink size={12} aria-hidden />
          </NextLinkAnchor>
        )}
        {publicHref && (
          <button
            type="button"
            className="th-cal-action"
            data-icon-only="true"
            aria-label={copied ? labels.copied : labels.copyLink}
            data-testid="calendar-peek-copy"
            onClick={copyLink}
          >
            <Copy size={14} aria-hidden />
          </button>
        )}
        {variant === "place" && item.href?.booking && (
          <NextLinkAnchor
            href={item.href.booking}
            className="th-cal-action"
            data-testid="calendar-peek-booking"
          >
            {labels.openBooking}
          </NextLinkAnchor>
        )}
        {onDownloadIcs && (
          <button
            type="button"
            className="th-cal-action"
            data-variant="ghost"
            data-icon-only="true"
            aria-label={labels.downloadIcs}
            data-testid="calendar-peek-ics"
            onClick={() => onDownloadIcs(item)}
            style={{ marginLeft: "auto" }}
          >
            <Download size={14} aria-hidden />
          </button>
        )}
      </div>
    </>
  );
}

function HoldPeekBody({
  item,
  timezone,
  titleId,
}: {
  item: CalendarHoldItem;
  timezone: string;
  titleId: string;
}) {
  const labels = useCalendarLabels();
  const line: CalendarHoldLineMate[] =
    item.lineMates && item.lineMates.length > 0
      ? item.lineMates
      : [
          {
            position: item.position,
            title: item.title,
            status: item.status,
            respondBy: item.respondBy,
            placedAt: item.placedAt,
          },
        ];
  const when = item.endsAt
    ? formatTimeRange(item.startsAt, item.endsAt, timezone).replace("–", " – ")
    : null;
  const kicker = [formatShortDay(item.startsAt, timezone, labels), when, item.spaceName]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <Mono size="xs" upper tone="muted" data-testid="calendar-peek-kicker">
        {kicker}
      </Mono>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
        <Text variant="span" id={titleId} fontSize={16} lineHeight={20} weight="bold">
          {labels.holdLine}
        </Text>
        <Mono size="xs" tone="muted">
          {labels.holdCount(line.length)}
        </Mono>
      </div>

      <div style={{ display: "flex", flexDirection: "column" }} data-testid="calendar-peek-hold-line">
        {line.map((mate) => {
          const challenged = mate.status === "CHALLENGED";
          const sub = challenged
            ? mate.respondBy
              ? labels.respondBy(formatRespondBy(mate.respondBy, timezone, labels))
              : labels.holdStatuses.CHALLENGED
            : mate.placedAt
              ? labels.placed(formatMonthDay(mate.placedAt, timezone, labels))
              : null;
          return (
            <div
              key={mate.position}
              data-testid={`calendar-peek-hold-${mate.position}`}
              style={{
                display: "grid",
                gridTemplateColumns: "32px minmax(0, 1fr) auto",
                alignItems: "center",
                columnGap: 8,
                padding: "8px 0",
                borderBottom: `1px solid ${CAL_BORDER_SOFT}`,
              }}
            >
              <Mono size="md">{`#${mate.position}`}</Mono>
              <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <Text variant="bodySmall" weight="semibold" truncate>
                  {mate.title}
                </Text>
                {sub && (
                  <Mono size="xs" tone={challenged ? "warning" : "muted"}>
                    {sub}
                  </Mono>
                )}
              </span>
              <HoldTag status={mate.status} />
            </div>
          );
        })}
      </div>

      {item.bookingHref && (
        <div style={{ display: "flex", paddingTop: 4 }}>
          <NextLinkAnchor
            href={item.bookingHref}
            className="th-cal-action"
            data-testid="calendar-peek-booking"
          >
            {labels.openBooking}
          </NextLinkAnchor>
        </div>
      )}
    </>
  );
}

function PeekPanel({
  item,
  variant,
  timezone,
  viewerTimezone,
  onClose,
  onDownloadIcs,
  returnFocusTo,
  sheet,
}: Omit<CalendarPeekProps, "anchorElement" | "open">) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const returnRef = useRef<ReturnFocusTarget | undefined>(returnFocusTo);
  returnRef.current = returnFocusTo;
  // Tracked by events, not read at unmount: by the time the cleanup runs the
  // panel is already out of the DOM and `document.activeElement` is the body.
  const focusWithin = useRef(false);

  // Focus moves into the peek on open, and back to the chip on close ONLY if
  // the peek still held it — a reader who tabbed elsewhere keeps their place.
  useEffect(() => {
    panelRef.current?.focus();
    return () => {
      if (!focusWithin.current) return;
      resolveTarget(returnRef.current)?.focus?.();
    };
  }, []);

  // Outside click closes the popover form; the sheet's backdrop does its own.
  useEffect(() => {
    if (sheet) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (resolveTarget(returnRef.current)?.contains(target)) return;
      onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [onClose, sheet]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    }
  };
  const onFocus = () => {
    focusWithin.current = true;
  };
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next && panelRef.current?.contains(next)) return;
    focusWithin.current = false;
  };

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-labelledby={titleId}
      tabIndex={-1}
      className="th-cal-peek"
      data-testid="calendar-peek"
      data-kind={item.kind}
      data-sheet={sheet ? "true" : undefined}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onBlur={onBlur}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 16,
        outline: "none",
        minWidth: 0,
      }}
    >
      {isEvent(item) ? (
        <EventPeekBody
          item={item}
          variant={variant}
          timezone={timezone}
          viewerTimezone={viewerTimezone}
          titleId={titleId}
          onDownloadIcs={onDownloadIcs}
        />
      ) : (
        <HoldPeekBody item={item} timezone={timezone} titleId={titleId} />
      )}
    </div>
  );
}

/**
 * The item peek (FR-014), internal mode only. Desktop: a 328px Popover on the
 * chip — 2px ink border, radius 0, an offset hard shadow. Below 600px: a
 * bottom sheet. Event peeks carry the key/value grid and the Edit / Public
 * page / Copy link / ICS actions (Edit on a series occurrence goes to the
 * series editor); hold peeks are reduced to the line and "Open booking".
 * The engine mounts exactly ONE of these, next to the pressed chip.
 */
export function CalendarPeek({
  anchorElement,
  open,
  sheet = false,
  ...rest
}: CalendarPeekProps) {
  if (sheet) {
    if (!open) return null;
    return (
      <BottomSheet open onClose={rest.onClose}>
        <BottomSheet.Panel>
          <BottomSheet.Body padding={0} gap={0}>
            <PeekPanel {...rest} sheet />
          </BottomSheet.Body>
        </BottomSheet.Panel>
      </BottomSheet>
    );
  }
  return (
    <Popover
      open={open}
      anchorElement={anchorElement}
      placement="bottom-start"
      offset={8}
      matchAnchorWidth={false}
      contentProps={{
        width: 328,
        maxWidth: "calc(100vw - 16px)",
        borderWidth: 2,
        borderColor: "$borderColor",
        backgroundColor: "$surface",
        style: { boxShadow: CAL_PEEK_SHADOW },
      }}
    >
      {open ? <PeekPanel {...rest} sheet={false} /> : null}
    </Popover>
  );
}
