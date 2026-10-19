"use client";

import { XStack, YStack, styled } from "tamagui";
import { NextLinkAnchor, Text } from "@th/ui";
import {
  ArrowUpDown,
  Bookmark,
  BookmarkCheck,
  BookmarkX,
  CalendarCheck,
  CalendarClock,
  CalendarPlus,
  CalendarX,
  Check,
  CircleCheck,
  Clock,
  Eye,
  FileCheck,
  FileText,
  FileX,
  Send,
  Timer,
  Undo2,
  UserCheck,
  X,
  type LucideIcon,
} from "lucide-react";

import type {
  BookingEntryIcon,
  BookingSystemEntryView,
} from "./booking-system-entry";

// ─────────────────────────────────────────────────────────────────────────────
// ONE LEDGER LINE.
//
// THE SHAPE IS THE SIGNAL. Every human message in this thread is a bordered,
// filled box; a system entry is the absence of one — an unboxed line hung off a
// hairline spine, in muted type, with a glyph. Nothing here is aligned
// mine/theirs, because an entry has no side: it is the platform recording what
// happened, and a reader should be able to tell that from ten feet away without
// reading a word.
//
// Strict Swiss (this is content, not chrome): square, hairline rule, no
// shadow, no pill. The spine is `$borderColorSoft` rather than `$accent` —
// entries repeat, and a stack of accent rails would blow the ≤5% accent budget
// on a busy thread. Accent appears exactly once per entry, on the link label,
// and as `accentText` (raw `accent` has no AA foreground at label size).
//
// TEXT-ONLY LINK, deliberately. A `styled(Button)` with `tag="span"` still
// emits `role="button" tabindex="0"`, so a Button inside this anchor would nest
// an interactive element in a link and put two tab stops on one rectangle —
// the trap `OpenAgreementButton` documents at length. A ledger line wants a
// text link anyway; the 44px touch target rides the wrapper.
// ─────────────────────────────────────────────────────────────────────────────

const ICONS: Record<BookingEntryIcon, LucideIcon> = {
  send: Send,
  eye: Eye,
  clock: Clock,
  undo: Undo2,
  check: Check,
  x: X,
  file: FileText,
  fileCheck: FileCheck,
  fileX: FileX,
  calendarPlus: CalendarPlus,
  calendarClock: CalendarClock,
  calendarCheck: CalendarCheck,
  calendarX: CalendarX,
  circleCheck: CircleCheck,
  hold: Bookmark,
  holdReorder: ArrowUpDown,
  holdClock: Timer,
  holdX: BookmarkX,
  holdCheck: BookmarkCheck,
  assigned: UserCheck,
};

/** Hairline spine binds consecutive entries into one column of record. */
const EntryRow = styled(XStack, {
  gap: 8,
  alignItems: "flex-start",
  paddingVertical: 8,
  paddingLeft: 12,
  borderLeftWidth: 2,
  borderLeftColor: "$borderColorSoft",
  minWidth: 0,
});

/**
 * `flexBasis: 0` + explicit `flexShrink`, never `flex: 1` + `minWidth`:
 * Tamagui inherits RN's `flexShrink: 0`, so the shorthand would let a long
 * sentence push the row past its container at 320px instead of wrapping.
 */
const EntryBody = styled(YStack, {
  gap: 2,
  flexBasis: 0,
  flexGrow: 1,
  flexShrink: 1,
  minWidth: 0,
});

/** Wrapper carries the 44px touch target; the label itself stays text-sized. */
const LinkTarget = styled(XStack, {
  alignItems: "center",
  minHeight: 44,
});

export function BookingSystemEntryRow({
  view,
  timestamp,
  /** `/agreements/{id}` or the event editor — already resolved by the caller. */
  href,
  linkLabel,
  testId,
}: {
  view: BookingSystemEntryView;
  timestamp: string;
  href: string | null;
  linkLabel: string | null;
  testId: string;
}) {
  const Icon = ICONS[view.icon];

  return (
    <EntryRow data-testid={testId}>
      <Icon
        size={13}
        strokeWidth={2}
        aria-hidden
        style={{ opacity: 0.65, flexShrink: 0, marginTop: 3 }}
      />
      <EntryBody>
        <Text variant="bodySmall" tone="muted">
          {view.text}
        </Text>
        {view.detail ? (
          <Text
            variant="caption"
            tone="muted"
            style={{ whiteSpace: "pre-wrap" }}
            data-testid={`${testId}-detail`}
          >
            {view.detail}
          </Text>
        ) : null}
        {/* Meta line: when, by which side, and the one thing there is to open.
            Wraps rather than shrinks — see EntryBody. */}
        <XStack gap="$3" alignItems="center" flexWrap="wrap" minWidth={0}>
          <Text
            variant="caption"
            tone="muted"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {timestamp}
          </Text>
          {view.actorLabel ? (
            <Text variant="caption" tone="muted">
              {view.actorLabel}
            </Text>
          ) : null}
          {href && linkLabel ? (
            <NextLinkAnchor href={href} data-testid={`${testId}-link`}>
              <LinkTarget>
                <Text
                  variant="caption"
                  weight="bold"
                  color="$accentText"
                  textTransform="uppercase"
                  letterSpacing={1}
                >
                  {linkLabel}
                </Text>
              </LinkTarget>
            </NextLinkAnchor>
          ) : null}
        </XStack>
      </EntryBody>
    </EntryRow>
  );
}
