"use client";

import type { CSSProperties } from "react";

import { OverflowTooltip } from "@th/ui";

/**
 * The box the rail's context title lives in — and the whole reason this file
 * exists.
 *
 * The rail (`NavigationRailFrame`) has NO width of its own: it is a
 * `flexShrink: 0` item with an `auto` basis, so its used width is the
 * max-content width of whatever it contains. Every nav label is short and
 * bounded, so that normally lands on 271px. An event title is neither.
 *
 * The title used to be `<Text truncate maxWidth="100%">`, and that is a
 * CIRCLE, not a constraint: `maxWidth: 100%` resolves against a parent whose
 * own width was derived from this very text, so the cap always equalled the
 * full title and the ellipsis never engaged. Measured at a 1280px viewport
 * with an 84-character title: rail 643.6px (up from 271.3px), leaving the
 * event builder 604.4px instead of 976.7px — and the title still not clipped
 * (scrollWidth 612 === clientWidth 612).
 *
 * `contain: inline-size` is what breaks the circle. The box's inline size is
 * computed as if it had no contents, so the title contributes ZERO to the
 * rail's max-content width and the rail sizes off its nav labels alone;
 * `width: 100%` then hands it the rail's real width back at layout time, and
 * the clip finally has something definite to clip against (measured after:
 * rail 271.3px at any title length, scrollWidth 612 > clientWidth 239).
 *
 * Same idiom, same reason, as `DESKTOP_TITLE_STYLE` in `BuilderHeaderBar` —
 * which was added for the downstream half of this exact bug.
 *
 * Deliberately NOT a fixed rail width: the rail's width is derived from its
 * content today, and pinning it in pixels would break that for every locale
 * whose nav labels run longer than English's.
 */
export const RAIL_CONTEXT_TITLE_BOX_STYLE: CSSProperties = {
  width: "100%",
  minWidth: 0,
  contain: "inline-size",
};

export type RailContextTitleProps = {
  /** Full, unabbreviated title. Never pre-truncate this. */
  title: string;
  testId?: string;
};

/**
 * The event/place name at the top of an admin context rail: one line, clipped
 * with an ellipsis, with the full value on hover — and only on hover when it
 * is ACTUALLY clipped, which `OverflowTooltip` measures for itself. That
 * reveal is the reason for `OverflowTooltip` over a bare `<Text truncate>`:
 * the rail is ~240px of usable width, so a long title loses most of itself to
 * the clip and needs somewhere to be read in full.
 *
 * The full string stays in the DOM (the clip is visual), so the accessible
 * name a screen reader announces is the whole title, not the ellipsised one.
 * `placement="right"` points the bubble into the content area rather than
 * back over the rail it came from.
 */
export function RailContextTitle({ title, testId }: RailContextTitleProps) {
  return (
    <div style={RAIL_CONTEXT_TITLE_BOX_STYLE} data-testid={testId}>
      <OverflowTooltip
        text={title}
        fontSize={13}
        weight="bold"
        placement="right"
      />
    </div>
  );
}

RailContextTitle.displayName = "RailContextTitle";
