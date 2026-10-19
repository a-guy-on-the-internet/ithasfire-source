"use client";

import { Badge, useTranslations } from "@th/ui";
import { MessageSquare } from "lucide-react";

export interface UnreadMessagesBadgeProps {
  /**
   * `unreadMessageCount` off a `BookingRequestSummary` — messages on this
   * request authored by the OTHER side (counterparty + SYSTEM) that this
   * viewer has not read. Always a number.
   */
  count: number;
  /**
   * testID base of the surrounding row. The badge appends `-unread`, matching
   * the convention `BookingThread` already uses for its in-thread chip.
   */
  testIdBase: string;
  /**
   * Escape hatch for stacking contexts. In a `YStack` the default
   * `alignItems: stretch` blows the chip out to the full column width, where it
   * reads as a banner with a centred label rather than a chip — pass
   * `"flex-start"` there. Deliberately NOT baked in: in the row clusters this
   * sits in an `XStack` with `alignItems: center`, and `flex-start` would
   * top-align it against the buttons beside it.
   */
  alignSelf?: "flex-start" | "center";
}

/**
 * The unread-reply signal on a booking-request LIST row.
 *
 * WHY IT EXISTS: a reply used to be invisible from every list surface. The
 * only unread chip lived inside `BookingThread`, where "mounting IS reading"
 * clears it before it can be perceived — so both sides had to open every
 * request one at a time to discover a message had arrived.
 *
 * RENDERS NOTHING AT 0, deliberately. The server's `unreadMessageCount`
 * degrades to 0 when the count lookup itself fails (see `resolveUnreadCounts`
 * in `list-booking-requests.ts`), so 0 is ambiguous between "quiet" and "we
 * didn't look". Both must read as a calm row — never as an empty chip, and
 * never as "0".
 *
 * VISUAL: `solid`, not the `soft` every status chip uses. Every soft tone is
 * already spoken for by the request's own lifecycle (PENDING=warning,
 * VIEWED=info, ACCEPTED=success, rest=neutral), so tone alone cannot separate
 * "you have mail" from "this request is viewed" — VIEWED is literally the same
 * `info` hue, and `VIEWED` + unread is the MODAL pairing (you opened it, they
 * replied), not an edge case. What separates them is FILL WEIGHT, verified in
 * the browser rather than argued: the status chip is a 12%-alpha tint with a
 * hairline border and a blue label; this one is a flat block of the full info
 * accent with a white label (measured 6.97:1) and a white message icon — the
 * only icon on the row. Same hue ties them to the same request; the inversion
 * says they are different KINDS of fact. Do not "fix" the shared hue by
 * inventing a fifth tone: that reads as a fifth STATUS, which is the thing
 * this must not be.
 *
 * ACCESSIBILITY: `role="img"` + `aria-label` makes the icon+count cluster one
 * atomic announcement. Without it the row announces "3", which tells a
 * screen-reader user nothing — the icon carrying the meaning is exactly the
 * part they cannot see.
 */
export function UnreadMessagesBadge({
  count,
  testIdBase,
  alignSelf,
}: UnreadMessagesBadgeProps) {
  const t = useTranslations();
  // `!(count > 0)`, NOT `count <= 0`: the comparison form lets `undefined`
  // through (`undefined <= 0` is false), and `undefined` is precisely what a
  // row builder that forgot the field would hand us. That renders a real chip
  // labelled "undefined unread" with the accessible name "NaN unread messages"
  // — ICU interpolates `undefined` verbatim and plural-selects `other` for a
  // non-finite value, so nothing throws. The negated form also eats NaN/null.
  if (!(count > 0)) return null;
  return (
    <Badge
      tone="info"
      variant="solid"
      size="sm"
      alignSelf={alignSelf}
      leadingIcon={<MessageSquare aria-hidden />}
      role="img"
      aria-label={String(t("booking.threadUnreadA11y", { count }))}
      data-testid={`${testIdBase}-unread`}
      flexShrink={0}
    >
      {String(t("booking.threadUnread", { count }))}
    </Badge>
  );
}
