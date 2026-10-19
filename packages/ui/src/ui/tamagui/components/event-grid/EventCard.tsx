"use client";

import { memo, useMemo, useCallback, useRef } from "react";
import { Platform } from "react-native";
import {
  Calendar,
  Heart,
  Lock,
  MapPin,
  ClipboardList,
  Repeat,
} from "lucide-react";
import {
  Stack,
  XStack,
  YStack,
  getVariableValue,
  styled,
  type GetProps,
  useTheme,
  useThemeName,
} from "tamagui";

import {
  elevationTokens,
  type ElevationThemeName,
} from "../../tokens/elevation";
import { monoScale } from "../../tokens/typography";
import { Button } from "../forms/Button";
import { CardSurface } from "../display/Card";
import { Text } from "../typography/Text";
import { ClaimedBar } from "../events/ClaimedBar";
import { DateStub } from "../events/DateStub";
import { MetaList, type MetaListItem } from "../events/MetaList";
import { PRICE_BLOCK_HEIGHT, PriceBlock } from "../events/PriceBlock";
import { useTranslations } from "../../../../locale";
import { isWeb } from "./constants";
import { EventCardImage } from "./EventCardImage";
import { EventCardPriceReveal } from "./EventCardPriceReveal";
import { deriveCardStamp } from "./card-stamp";
import type { EventSummary, EventGridRenderContext } from "./types";
import { listingPriceText, useListingPriceWords } from "./use-listing-price-words";
import {
  DEFAULT_MEDIA_ASPECT_RATIO,
  getEventCardSizeConfig,
  getEventCardMediaDimensions,
  getEventCardMinHeight,
  type EventCardSize,
} from "./sizes";

/**
 * The scrim under the poster's title.
 *
 * The DS runs `transparent → ink 88%`. This adds a MID STOP at 55%, and that
 * is the difference between "usually legible" and legible.
 *
 * A pure two-stop ramp is near-transparent exactly where the first line of the
 * title sits, so on a bright photo the top line rides on the upload while the
 * bottom line rides on ink — the failure that got option A rejected at Gate 5.
 * Holding 55% from the title's top edge puts every line on at least
 * `ink@55%`, while the 92% floor at the bottom keeps the mono line solid.
 * Visually it is the same gradient; it just stops lying about the top third.
 *
 * The mid stop is anchored in PX, not at 38%, and the px is the scrim's own
 * `paddingTop` ($6 = 32) — so the floor is reached exactly where type begins,
 * whatever the scrim's height happens to be. It was 38% back when the title
 * always took two lines and the scrim was always ~116px tall, where 38% IS
 * 44px. Now the title takes one to three and the scrim clears the price block,
 * so a percentage stop slid down the ramp every time the scrim grew.
 *
 * Measured by sampling the composited ground under each title line in the
 * running grid, with every poster's upload forced to PURE WHITE (the worst
 * case an organizer can hand us) and the type hidden so the sample is the
 * ground and not the glyphs. `$onScrim` against that ground, first
 * title line, brightest pixel in the band:
 *
 *   shipped, 38% stop, 2-line title  — 2.41:1   (mean 3.36:1)
 *   38% stop, 3-line title           — 2.03:1   (mean 2.71:1)   ← the regress
 *   32px stop, 1-, 2- and 3-line     — 3.66:1   (mean 3.97–4.03:1)
 *
 * Anchored, the number stops moving with the title's length. It is still under
 * 4.5:1 on that synthetic white ground — a PRE-EXISTING gap this change
 * narrows rather than opens, and one that cannot be closed without deepening
 * the resting poster's whole tone, which is a design decision and not a
 * bug fix. The HOVER state, where the ledger's prices are read, measures
 * 10.0:1 or better; see POSTER_SCRIM_DEEP.
 */
const POSTER_SCRIM =
  "linear-gradient(to bottom, transparent 0px, color-mix(in srgb, var(--scrim, #211C16) 55%, transparent) 32px, color-mix(in srgb, var(--scrim, #211C16) 92%, transparent) 100%)";

/**
 * The scrim's hover state — a SECOND ramp that fades in over the first.
 *
 * Why a second layer and not a second value on the same element: a
 * `background-image` does not transition. Animating the gradient string is a
 * snap, not a deepen. So this rides a `::before` on the scrim at `opacity: 0`
 * and the `:has()` rule takes it to 1 over 200ms — which is a property that
 * does transition.
 *
 * Why it starts 96px ABOVE the scrim (`top: -96px`, and the stops are in PX so
 * they keep their meaning as the scrim's height changes): the ledger makes the
 * scrim taller, which walks the title UP into the part of `POSTER_SCRIM` that
 * is still near-transparent — the exact failure the 55% mid-stop was added to
 * fix. Holding a floor from the scrim's own top edge answers that, but a floor
 * that begins AT the edge draws a horizontal seam across the photograph. The
 * 96px of overhang is where the fade happens, over art the scrim was not
 * covering anyway.
 *
 * Composited over `POSTER_SCRIM` (both are translucent, so the effective ink is
 * `1 - (1-a₁)(1-a₂)`), the worst case is the title's top line over a
 * pure-white upload. MEASURED from a real render rather than derived from these
 * numbers — brightest ground pixel under each line, type hidden, every poster's
 * upload forced to white:
 *
 *   title  10.18:1 at 1440px · 10.02:1 at 320px
 *   rule   11.85:1 / 12.16:1
 *   rows   12.03:1 rising to 14.34:1 down the stack
 */
const POSTER_SCRIM_DEEP =
  "linear-gradient(to bottom, transparent 0px, color-mix(in srgb, var(--scrim, #211C16) 65%, transparent) 96px, color-mix(in srgb, var(--scrim, #211C16) 82%, transparent) 100%)";

// ── Card reveal animation (web only) ──────────────────────────────────────
const revealStyleTagId = "event-card-reveal-animations";

if (
  isWeb &&
  typeof document !== "undefined" &&
  !document.getElementById(revealStyleTagId)
) {
  const style = document.createElement("style");
  style.id = revealStyleTagId;
  style.innerHTML = `
    @keyframes eventCardReveal {
      from {
        opacity: 0;
        transform: translateY(12px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
    /* v2 .democard: hover eases the accent border + 3px lift over --t-base
       (~160ms ease-out) instead of snapping. Declared on the base state so
       the Tamagui-compiled :hover rule (borderColor $accent + translateY -3)
       animates. Kept off the reveal's mount keyframe (which drives transform
       on its own — transition only reacts to style-driven changes). */
    .event-card-reveal {
      transition:
        border-color var(--motion-fast, 180ms) ease-out,
        transform var(--motion-fast, 180ms) ease-out;
    }
    @media (prefers-reduced-motion: reduce) {
      .event-card-reveal {
        animation: none !important;
        transition: none !important;
      }
    }
    /* ── The poster's hover state: "the ledger" ──────────────────────────

       What was here before: a rule that faded the ENTIRE scrim's contents to
       opacity 0 whenever the price drawer opened, because the drawer was an
       opaque cream panel sliding up through the title. Hovering a card made it
       forget its own name at the moment you were reading it, which is not a
       trade a discovery grid gets to make.

       So the drawer is gone from the poster. The tiers now print INSIDE the
       scrim, in normal flow, under a 2px accent rule — the fine print at the
       bottom of a gig flyer. Nothing overlaps, so nothing has to yield: the
       title stays, and its clamp goes from three lines to six while the
       ledger is open.

       Three things key off the ledger's STATE through :has(), all of them
       pure CSS so a 12-card grid re-renders nothing on hover. The ledger
       stays mounted once it has data (see EventCardPriceReveal.tsx), so the
       hooks are its state, not its presence:

         [data-state="open"]     — open now. Drives the deepen and the
                                   title's max-height, both of which
                                   TRANSITION, so closing reverses them.
         .evt-tier-ledger--raised — open, or still collapsing. Holds the
                                   six-line clamp until the title's
                                   max-height is back at three lines.

       All three halves of the gesture — the ledger's grid track, the deepen
       and the title — run on --motion-base with --motion-ease-standard, so
       they read as one move rather than a layout jump with a fade on top.

       Where :has() is unsupported every rule below simply never matches and
       the poster keeps its resting state — the ledger still opens, just
       without the deepen or the longer title. */

    /* 1. The scrim deepens.

       A background-image DOES NOT TRANSITION, so the deeper ramp cannot live
       on the scrim itself — it would snap. It rides a pseudo-element instead
       and we animate opacity, which does. z-index: -1 inside the scrim's
       own stacking context (it is positioned with z-index: 1) puts the layer
       above the scrim's background and below its type.

       top: -96px is the fade's runway: see POSTER_SCRIM_DEEP. */
    .is_EventCardFeatureScrim::before {
      content: "";
      position: absolute;
      top: -96px;
      right: 0;
      bottom: 0;
      left: 0;
      z-index: -1;
      pointer-events: none;
      opacity: 0;
      background-image: ${POSTER_SCRIM_DEEP};
      transition: opacity var(--motion-base, 220ms)
        var(--motion-ease-standard, ease);
    }
    .is_EventCardImageContainer:has(.evt-tier-ledger[data-state="open"])
      .is_EventCardFeatureScrim::before {
      opacity: 1;
    }

    /* 2. The title un-clamps — and ONLY the raised value lives here.

       The RESTING clamp stays an inline style (POSTER_TITLE_CLAMP), because
       this stylesheet does not exist during SSR: the tag is created behind a
       typeof-document guard, so a clamp declared here is simply absent from
       the server-rendered HTML. A long title would paint
       unclamped on first load and, since the scrim is bottom-anchored and
       grows UPWARD to hold every line, snap back a line or two when the
       chunk evaluates. A layout shift at rest, on the busiest page there is.

       Which leaves the constraint the other way round: a stylesheet cannot
       override an inline style without !important, so the raised clamp takes
       it. That is the whole reason the word appears here. The class on the
       title is now just the :has() hook.

       A line clamp does not interpolate, so on its own the raise is a
       one-frame jump of up to three lines. max-height carries the motion
       instead: it rests at exactly three lines (1lh is the title's own
       line-height, so the $sm rung is covered) — the height the inline clamp
       already gives it, so this rule changes nothing at rest or on SSR — and
       transitions to six alongside the ledger. The clamp is raised for the
       whole of both transitions (the --raised class outlives the open state
       by the collapse's duration), so what grows and shrinks is the box, and
       the ellipsis comes back only once the box is three lines tall again. */
    .is_EventCardFeatureScrim .evt-poster-title {
      max-height: 3lh;
      transition: max-height var(--motion-base, 220ms)
        var(--motion-ease-standard, ease);
    }
    .is_EventCardImageContainer:has(.evt-tier-ledger[data-state="open"])
      .is_EventCardFeatureScrim
      .evt-poster-title {
      max-height: 6lh;
    }
    .is_EventCardImageContainer:has(.evt-tier-ledger--raised)
      .is_EventCardFeatureScrim
      .evt-poster-title {
      -webkit-line-clamp: 6 !important;
    }

    @media (prefers-reduced-motion: reduce) {
      .is_EventCardFeatureScrim::before,
      .is_EventCardFeatureScrim .evt-poster-title {
        transition: none !important;
      }
    }
  `;
  document.head.appendChild(style);
}

const getRevealStyle = (index: number): Record<string, unknown> | undefined =>
  isWeb
    ? {
        animationName: "eventCardReveal",
        animationDuration: "0.4s",
        animationTimingFunction: "cubic-bezier(0.25, 0.46, 0.45, 0.94)",
        animationFillMode: "backwards",
        animationDelay: `${Math.min(index * 60, 600)}ms`,
      }
    : undefined;

// Web: let long event titles wrap across up to 2 lines then ellipsis, rather
// than a single-line mid-word cut at narrow widths (390px QA). overflow-wrap
// breaks an over-long single token; word-break:normal keeps ordinary words
// whole. Native keeps the 1-line `truncate` (no line-clamp support).
const TWO_LINE_TITLE_CLAMP: Record<string, unknown> | undefined = isWeb
  ? {
      display: "-webkit-box",
      WebkitBoxOrient: "vertical",
      WebkitLineClamp: 2,
      overflow: "hidden",
      overflowWrap: "anywhere",
      wordBreak: "normal",
    }
  : undefined;

/**
 * The POSTER's clamp — three lines, not two.
 *
 * The poster's title sits in a bottom-anchored scrim with the art's whole
 * height above it, so it can afford a third line where the ticket's fixed body
 * cannot. It stays an INLINE style for the same reason the ticket's does: the
 * stylesheet that raises it on hover is injected client-side and does not
 * exist during SSR, so a clamp declared only there renders unclamped on first
 * paint and then snaps. Inline is the SSR-correct home for a resting value.
 */
const POSTER_TITLE_CLAMP: Record<string, unknown> | undefined = isWeb
  ? { ...TWO_LINE_TITLE_CLAMP, WebkitLineClamp: 3 }
  : undefined;

const EventCardSurface = styled(CardSurface, {
  name: "EventCardSurface",
  padding: 0,
  overflow: "hidden",
  gap: 0,
  borderRadius: 0,
  width: "100%",
  flexShrink: 0,
  // v2 .democard: background is `surface` (#FDFAF3 on Stub), NOT `background`
  // (#F6F0E4, the page). CardSurface inherits Tamagui Card's `$background`,
  // which made the card the exact same colour as the page behind it — the
  // frame read as a bare border with no panel.
  backgroundColor: "$surface",
  // The card is a TICKET, and a ticket is a cut edge: 2px of full structural
  // ink all the way round (DS `.if-ecard`), not the soft 40% hairline this
  // carried while it was a generic panel. The hairline survives exactly one
  // place on the card — the rule above the foot, which is an internal
  // division rather than the object's outline.
  borderColor: "$borderColor",
  // v2 section-06 card hover: accent border + 3px lift. `y` is Tamagui's
  // translate shorthand (compiles to transform) — the prior `translateY` key
  // wasn't recognized, so the lift never rendered (only the border changed).
  hoverStyle: {
    y: isWeb ? -3 : 0,
    borderColor: "$accent",
  },
  focusStyle: {
    outlineWidth: 2,
    outlineColor: "$focus",
    outlineStyle: "solid",
    outlineOffset: 2,
  },

  variants: {
    /**
     * The die-cut path moves the frame — background, outline and the clip —
     * onto the two `CutPane`s, because the notch has to be cut out of the
     * thing that draws the edge. What is left here is a transparent wrapper
     * whose only job is to carry the `drop-shadow` (see the render) and the
     * hover lift. `overflow` must go visible or it would clip the panes'
     * masked corners back to a square.
     */
    cut: {
      true: {
        backgroundColor: "transparent",
        borderWidth: 0,
        overflow: "visible",
        hoverStyle: { y: isWeb ? -3 : 0 },
      },
      false: {},
    },
  } as const,

  defaultVariants: { cut: false },
});

const ContentStack = styled(YStack, {
  name: "EventCardContent",
  // v2 section-06 card body: padding $5 (24px), gap $3 (12px). Was $4/$2.5 —
  // and $2.5 is not a real space token (the scale is integer-only), so it
  // collapsed toward 0 and the body had almost no vertical rhythm.
  padding: "$5",
  gap: "$3",
  width: "100%",

  variants: {
    dense: {
      // Dense list rows keep a tighter body; $2 is a real token (8px) —
      // the prior $1.5 hit the same fractional-token collapse.
      true: {
        padding: "$3",
        gap: "$2",
      },
    },
  } as const,
});

const MetaRow = styled(XStack, {
  name: "EventCardMetaRow",
  alignItems: "center",
  // $2 (8px), matching MetaListRow — the prior $1.5 was not a real space
  // token (scale is integer-only) and collapsed to a zero gap.
  gap: "$2",
});

const FavoriteButtonContainer = styled(Stack, {
  name: "EventCardFavoriteContainer",
  position: "absolute",
  top: "$3",
  right: "$3",
  zIndex: 1,
});

const FavoriteIconWrapper = styled(Stack, {
  name: "EventCardFavoriteIconWrapper",
  alignItems: "center",
  justifyContent: "center",
  pointerEvents: "none",
  userSelect: "none",
});

// v2 section-06 corner category tag: flush top-left, bg-colored with
// structural (soft) right/bottom borders — reads as part of the card frame,
// not a floating pill. Padding 6×11 is the v2 spec literal (off-scale).
const BadgeContainer = styled(Stack, {
  name: "EventCardBadgeContainer",
  position: "absolute",
  top: 0,
  left: 0,
  zIndex: 1,
  backgroundColor: "$background",
  borderRightWidth: 2,
  borderBottomWidth: 2,
  borderColor: "$borderColorSoft",
  paddingVertical: 6,
  paddingHorizontal: 11,
});

/**
 * The art window's ratios.
 *
 * `3/2` landscape for the ticket, `2/3` portrait for the poster. Both are
 * fixed by the object, not by the upload — see the note at the render.
 */
const CARD_ART_ASPECT_RATIO = DEFAULT_MEDIA_ASPECT_RATIO;
const FEATURE_ASPECT_RATIO = 2 / 3;

const HorizontalLayout = styled(XStack, {
  name: "EventCardHorizontalLayout",
  width: "100%",
  alignItems: "stretch",
});

// ── Ticket chrome ─────────────────────────────────────────────────────────
//
// The browse card, the wallet row and the printed ticket are ONE object at
// three sizes (DS D-091). What makes that legible is not a resemblance
// engineered later — it is that the card literally carries a ticket's parts:
// a tear, its die-cuts, and a foot with a serial and a price block. Match
// `Ticket.tsx` / `TicketWalletCard.tsx`, which landed this way first.

/** Die-cut radius. Matches `TicketStub` and the DS card tier (14px across). */
const HOLE_R = 7;

/**
 * The tear.
 *
 * A zero-height rule between the art and the body, carrying only a dashed TOP
 * border. Every side is pinned explicitly: setting `borderStyle` without
 * widths lets Tamagui's 3px default in on the other three, which renders a
 * dashed box instead of a single dashed line — the exact fault documented on
 * `Ticket.tsx`'s stub column.
 *
 * `zIndex` lifts it (and its holes) above the art panel so the tear reads as
 * cut THROUGH the card rather than butted against the image.
 */
const Perforation = styled(Stack, {
  name: "EventCardPerforation",
  position: "relative",
  width: "100%",
  height: 0,
  flexShrink: 0,
  zIndex: 2,
  borderTopWidth: 2,
  borderRightWidth: 0,
  borderBottomWidth: 0,
  borderLeftWidth: 0,
  borderColor: "$borderColor",
  borderStyle: "dashed",
});

/**
 * Punch hole — the ONE sanctioned circular exception in this system.
 *
 * It is a HOLE, not a dot drawn on the card: it carries the page's own colour,
 * and it straddles the card's edge so `EventCardSurface`'s `overflow: hidden`
 * throws the outer half away. What survives is a half-circle notch whose curve
 * carries the card's own 2px outline — the edge running *around* the bite.
 *
 * `Ticket.tsx` cuts its die-cuts with a CSS mask instead, so a `drop-shadow`
 * traces the bite. That path needs to know where the tear is in advance, and
 * it can: its stub is a fixed width. Here the tear sits at the bottom of an
 * aspect-ratio art panel whose height is only known at layout, so there is no
 * mask position to write. This is the same clipped fallback `Ticket.tsx` uses
 * for its stacked rendering, and the offset shadow stays a box shadow.
 */
const PunchHole = styled(Stack, {
  name: "EventCardPunchHole",
  position: "absolute",
  top: -HOLE_R,
  width: HOLE_R * 2,
  height: HOLE_R * 2,
  borderRadius: 999,
  borderWidth: 2,
  borderColor: "$borderColor",
  backgroundColor: "$background",
  zIndex: 2,
});

// ── The die-cut, cut for real (web) ───────────────────────────────────────
//
// `Ticket.tsx` cuts its notches with a CSS mask, so they are genuine
// transparency and a `filter: drop-shadow()` traces the bite. The card could
// not do that while its frame was ONE box: the mask would need the tear's y,
// and the tear sits under an aspect-ratio art panel whose height is only known
// at layout.
//
// Splitting the frame into two stacked panes removes the need to know it. Each
// pane cuts its own corners, and a corner is addressable as a PERCENTAGE —
// `0% 100%` on the art, `0% 0%` on the body — which needs no measurement and
// stays correct at any card width. The two half-notches meet at the tear.
//
// Native keeps the painted-hole path below: no CSS masks, no drop-shadow.
const CUT_CARD_CLASS = "th-ecard-cut";
const CUT_PANE_CLASS = "th-ecard-pane";

/**
 * Test hook. jsdom applies none of Tamagui's class-based styling, so the arcs
 * are only assertable by presence and count — four per cut card, two per pane.
 */
/**
 * Horizontal offset for the arcs.
 *
 * The mask cuts against the BORDER box (`mask-origin` is border-box), but an
 * absolutely-positioned child offsets from the PADDING box — inside the pane's
 * 2px side border. At a bare `-HOLE_R` the ring therefore sits 2px inboard of
 * the hole the mask cut, and the notch renders as two curves 2px apart instead
 * of one. The panes draw no border at the tear, so the vertical offset needs no
 * such correction.
 */
const CUT_ARC_X = HOLE_R + 2;

const cutArcProps = isWeb
  ? ({ "data-th-cut-arc": "true" } as Record<string, unknown>)
  : {};
let cutRuleInjected = false;

/**
 * The frame's hover/focus ink now lives on two panes instead of the surface,
 * and a Tamagui `hoverStyle` cannot reach a descendant. One injected rule does,
 * and it costs no re-render on hover — which matters at 12+ cards per grid.
 */
const ensureCutHoverRule = () => {
  if (!isWeb || typeof document === "undefined") return;
  if (cutRuleInjected || document.getElementById("th-ecard-cut")) {
    cutRuleInjected = true;
    return;
  }
  const style = document.createElement("style");
  style.id = "th-ecard-cut";
  style.innerHTML = `
    .${CUT_CARD_CLASS}:hover .${CUT_PANE_CLASS},
    .${CUT_CARD_CLASS}:focus-visible .${CUT_PANE_CLASS} {
      border-color: var(--accent);
    }
  `;
  document.head.appendChild(style);
  cutRuleInjected = true;
};

/**
 * Two radial gradients — transparent inside `r`, opaque outside — at the two
 * corners of one pane's tear edge. `mask-composite: intersect` keeps a pixel
 * only if BOTH layers keep it; the default `add` would union the opaque halves
 * and cut nothing.
 */
const cutMask = (edge: "top" | "bottom", r: number) => {
  const y = edge === "bottom" ? "100%" : "0%";
  const layer = (x: string) =>
    `radial-gradient(circle ${r}px at ${x} ${y}, transparent ${r}px, #000 ${r}px)`;
  const image = `${layer("0")}, ${layer("100%")}`;
  return {
    maskImage: image,
    WebkitMaskImage: image,
    maskComposite: "intersect",
    WebkitMaskComposite: "source-in",
  } as Record<string, string>;
};

/**
 * One half of the card's frame. Between them they draw the outline the surface
 * used to draw alone, and neither draws an edge at the tear — the art pane's
 * dashed bottom border IS the tear.
 */
const CutPane = styled(YStack, {
  name: "EventCardCutPane",
  position: "relative",
  width: "100%",
  backgroundColor: "$surface",
  borderColor: "$borderColor",
  borderLeftWidth: 2,
  borderRightWidth: 2,
  overflow: "hidden",

  variants: {
    pane: {
      art: {
        borderTopWidth: 2,
        // No edge at the tear: `CutTear` draws it, dashed, as a sibling.
        // A `borderStyle` here would dash all four sides — RNW takes one value
        // for the box, which is the fault already documented on `Perforation`.
        borderBottomWidth: 0,
        flexShrink: 0,
      },
      body: {
        borderTopWidth: 0,
        borderBottomWidth: 2,
        flexGrow: 1,
      },
    },
  } as const,
});

/**
 * The tear between the panes: a zero-height rule carrying only a dashed top
 * border, inset by the hole radius at each end so the dashes stop at the bites
 * rather than running across them.
 */
const CutTear = styled(Stack, {
  name: "EventCardCutTear",
  width: "auto",
  height: 0,
  marginHorizontal: HOLE_R,
  flexShrink: 0,
  zIndex: 3,
  borderTopWidth: 2,
  borderRightWidth: 0,
  borderBottomWidth: 0,
  borderLeftWidth: 0,
  borderColor: "$borderColor",
  borderStyle: "dashed",
});

/**
 * The ring that carries the card's outline around the bite.
 *
 * No fill: the pane's mask has already removed the card where the hole is, so
 * a fill would paint a disc straight back into the gap. Only the stroke is
 * wanted, and only the half of it inside the pane — which the pane's own
 * `overflow: hidden` is what leaves behind.
 */
const CutArc = styled(Stack, {
  name: "EventCardCutArc",
  position: "absolute",
  width: HOLE_R * 2,
  height: HOLE_R * 2,
  borderRadius: 999,
  borderWidth: 2,
  borderColor: "$borderColor",
  backgroundColor: "transparent",
  zIndex: 2,
});

/**
 * The foot — serial left, price block right, pinned to the bottom.
 *
 * `marginTop: auto` is what aligns feet across a grid row: cards are
 * equal-height siblings, so the slack pools above the foot rather than under
 * the body.
 *
 * The rule above it is the hairline (`$borderColorSoft`), deliberately not the
 * structural ink of the frame — it divides the ticket, it does not outline it.
 */
const CardFoot = styled(XStack, {
  name: "EventCardFoot",
  width: "100%",
  alignItems: "stretch",
  marginTop: "auto",
  borderTopWidth: 1,
  borderTopColor: "$borderColorSoft",
});

const SerialCell = styled(XStack, {
  name: "EventCardSerial",
  flex: 1,
  minWidth: 0,
  alignItems: "center",
  paddingVertical: "$2",
  paddingHorizontal: "$4",
});

/**
 * The feature poster's scrim.
 *
 * This is the system's ONE sanctioned gradient (DS D-097). It exists only
 * because `variant="feature"` reverses type out over an organizer's photo, and
 * that is the single slot where a curator has picked the event and can vouch
 * for the image. Anywhere else a gradient is still a bug — including the
 * default card, which is why the default never puts text on the upload.
 */
// ── The poster (Gate-5 option A) ──────────────────────────────────────────

/** Portrait. The unit of option A is the image, and the image is a poster. */
const POSTER_ASPECT_RATIO = 2 / 3;

/**
 * The poster's ratio on a phone.
 *
 * 2:3 is right on a desktop grid, where a card is one of four and its height
 * is bounded by its neighbours. On a single-column 320px layout the same ratio
 * makes one card 444px of art — most of the viewport for one event, so the
 * grid stops reading as a grid and becomes a slideshow you scroll.
 *
 * 4:5 keeps the card unmistakably portrait while giving back ~75px, which is
 * the difference between one card per screen and seeing the next one start.
 * `$sm` (≤640) rather than `$xs`: this config declares `xs` before `sm`, so
 * `sm` wins at every width `xs` covers and an `$xs` rule would never apply.
 */
const POSTER_ASPECT_RATIO_COMPACT = 4 / 5;

/**
 * Room the price block occupies in the art's bottom-right corner.
 *
 * MEASURED — `getBoundingClientRect()` on `[data-testid$="-price"]` in the
 * running grid returns 96×60. The height is `PriceBlock`'s own box: two
 * `paddingVertical: "$3"` (12+12) + the 21px amount line + the 3px gap + the
 * 12px label line — DERIVED, not restated: it is `PRICE_BLOCK_HEIGHT`, the
 * sum of the metrics `PriceBlock` renders with, so a line-height change there
 * moves this with it. It read 56 here for as long as the drawer existed, so the
 * drawer's `bottomOffset` cut 4px into the block it was there to clear.
 *
 * Both numbers are constants rather than a measurement at runtime because the
 * layout that consumes them happens before anything is on screen: the drawer
 * opens above the block, and the poster's scrim stops its whole content column
 * above it.
 *
 * A constant is only safe because the poster pins `PriceBlock` to one line
 * per row (its `nowrap` prop). A wrapped amount would make the real block
 * taller than 60 and print the ledger's bottom rows under it — see the prop's
 * note in `PriceBlock.tsx`, and the guard in its tests.
 *
 * 60 is the LABELLED block. The sold-out branch passes no label, so that block
 * is 45px and the clearance is ~15px generous there. Deliberate: one constant
 * that is never too small beats two that can each drift.
 */
const POSTER_PRICE_BLOCK_H = PRICE_BLOCK_HEIGHT;
const POSTER_PRICE_BLOCK_W = 96;

/**
 * The date stamp notched into the top-left corner.
 *
 * Paper punched into the photograph, carrying the frame's own 2px ink on the
 * two edges that meet the image — the same corner treatment as the ticket's
 * category tag, which is what keeps the two variants recognisably one system.
 */
const PosterStamp = styled(YStack, {
  name: "EventCardPosterStamp",
  position: "absolute",
  top: 0,
  left: 0,
  zIndex: 2,
  alignItems: "center",
  justifyContent: "center",
  backgroundColor: "$background",
  borderRightWidth: 2,
  borderBottomWidth: 2,
  borderColor: "$borderColor",
  paddingVertical: 8,
  paddingHorizontal: 12,
});

/**
 * The price, notched into the art's bottom-right corner.
 *
 * The mirror of the date stamp: stamp punched into the top-left, price into
 * the bottom-right, both carrying the frame's 2px ink on the two edges that
 * meet the image. When and how much are the two facts someone scans a
 * discovery grid for, so they get the two corners.
 *
 * It stays put while the hover drawer is open — the drawer breaks the price
 * into tiers, it does not replace it.
 */
const PosterPrice = styled(Stack, {
  name: "EventCardPosterPrice",
  position: "absolute",
  right: 0,
  bottom: 0,
  zIndex: 3,
  borderTopWidth: 2,
  borderLeftWidth: 2,
  borderColor: "$borderColor",
});


const FeatureScrim = styled(YStack, {
  name: "EventCardFeatureScrim",
  position: "absolute",
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: 1,
  gap: "$2",
  paddingTop: "$6",
  paddingHorizontal: "$4",
  paddingBottom: "$4",
});

export type EventCardLayout = "vertical" | "horizontal";

/**
 * `poster` (default) — Gate-5 option A. Portrait 2:3 art is the unit, with a
 * date stamp notched into the top-left corner, the title reversed out over the
 * bottom, and a single mono line of chrome beneath. Reads like a stapled gig
 * poster, and a browse grid reads like a wall of flyers.
 *
 * The two objections that option A originally lost on are answered in the
 * rendering rather than by avoiding it:
 *
 * 1. *"Contrast becomes conditional on the upload."* The art panel's ground is
 *    INK, always — the photo sits on top of it rather than being it — every
 *    upload is normalised through the system's duotone, and the scrim carries a
 *    floor (see `POSTER_SCRIM`) instead of fading from fully transparent. White
 *    type over the title band clears AA against the worst-case bright photo.
 * 2. *"A card with no photo stops reading as anything."* It reads as a poster
 *    with no photo: the same ink panel, the initials ghosted into it, the same
 *    stamp and the same chrome line. Nothing is conditional on the image
 *    existing.
 *
 * `ticket` — option B: landscape 3:2 art above a perforation with die-cuts,
 * mono chrome below, serial and price in the foot. Kept because the wallet row
 * and the printed PDF are still tickets, so a surface that wants the browse
 * card to match those can ask for it.
 */
export type EventCardVariant = "poster" | "ticket";

type EventCardBaseProps = Omit<
  GetProps<typeof EventCardSurface>,
  "children" | "onPress"
>;

export interface EventCardProps extends EventCardBaseProps {
  event: EventSummary;
  layout?: EventCardLayout;
  /**
   * Poster (default) or ticket — see `EventCardVariant`. Ignored by the
   * `horizontal` layout and by `dense` rows, which are different density tiers
   * and have their own shape.
   */
  variant?: EventCardVariant;
  size?: EventCardSize;
  showFavorite?: boolean;
  showBadge?: boolean;
  /**
   * Compact treatment for full-width list rows: caps the image to a fixed
   * thumbnail width, tightens content padding/gap, and hides the redundant
   * "View details" button (the whole card is clickable).
   */
  dense?: boolean;
  /**
   * Percent claimed (0–100) for the v2 claimed-bar slot. Optional and hidden
   * by default — pages opt in when they have the data. Never renders at ≤ 0.
   */
  claimedPercent?: number;
  /** Localized "NN% claimed" label override for the claimed bar. */
  claimedLabel?: string;
  /**
   * Fill for the tear's punch holes. They ARE the surface showing through, so
   * this must match whatever the card sits on — the default `$background` is
   * only correct on the page canvas. Pass `$surface` (etc.) when the grid is
   * inside a panel; a mismatch turns each die-cut back into a dot.
   */
  holeColor?: GetProps<typeof Stack>["backgroundColor"];
  onPress?: (event: EventSummary) => void;
  onFavoriteToggle?: (
    event: EventSummary,
    nextFavoriteState: boolean,
    context: EventGridRenderContext,
  ) => void;
  renderContext?: EventGridRenderContext;
  testIdBase?: string;
  qaId?: string;
  favoriteIconStrokeWidth?: number;
}

const resolveAutomationProps = (testId?: string, qaId?: string) => {
  if (isWeb) {
    return {
      ...(testId ? { "data-testid": testId } : {}),
      ...(qaId ? { "data-qa": qaId } : {}),
    } as Record<string, unknown>;
  }

  return {
    ...(testId ? { testID: testId } : {}),
    ...(qaId ? { accessibilityLabel: qaId } : {}),
  } as Record<string, unknown>;
};

export const EventCard = memo<EventCardProps>(
  ({
    event,
    layout = "vertical",
    variant = "poster",
    showFavorite = true,
    showBadge = true,
    claimedPercent,
    claimedLabel,
    holeColor,
    onPress,
    onFavoriteToggle,
    renderContext = { index: 0 },
    testIdBase,
    qaId,
    disabled,
    size = "md",
    dense = false,
    favoriteIconStrokeWidth = 2.5,
    ...rest
  }) => {
    // Web-only ref to the card's root (the link) so the price-reveal panel can
    // bind hover/focus/Escape to the whole card. Unused on native.
    const cardRef = useRef<HTMLElement | null>(null);
    const automationId = testIdBase ?? `event-card-${event.id}`;
    const automationQa = qaId ?? automationId;
    const layoutAutomationId = `${automationId}-layout`;
    const layoutAutomationQa = `${automationQa}-layout`;
    const isNative = Platform.OS !== "web";
    const theme = useTheme();
    const themeName = useThemeName();
    // v2 .democard box-shadow: --shadow-card. Stub is a hard offset print-style
    // shadow; Ember/Swiss are flat ("none" — borders carry structure there).
    const shadow = useMemo(() => {
      const elevation =
        elevationTokens[themeName as ElevationThemeName] ??
        elevationTokens.ember;
      return elevation.card;
    }, [themeName]);
    const t = useTranslations();
    const isHorizontalLayout = layout === "horizontal";
    const sizeConfig = useMemo(() => getEventCardSizeConfig(size), [size]);
    const mediaDimensions = useMemo(
      () => getEventCardMediaDimensions(size, layout),
      [layout, size],
    );
    const cardMinHeight = useMemo(
      () => getEventCardMinHeight(size, layout),
      [layout, size],
    );
    // v2 corner tag: bg-colored container, tone carried by the kicker text
    // color (accent by default; hot/cold keep their status hue).
    const badgeTextTone = useMemo(() => {
      switch (event.badge?.tone) {
        case "hot":
          return "error" as const;
        case "cold":
          return "info" as const;
        default:
          return "accent" as const;
      }
    }, [event.badge?.tone]);

    const handlePress = useCallback(() => {
      if (disabled) {
        return;
      }
      onPress?.(event);
    }, [disabled, event, onPress]);

    const handleFavoritePress = useCallback(
      (pressEvent: unknown) => {
        if (
          typeof (pressEvent as { stopPropagation?: () => void })
            ?.stopPropagation === "function"
        ) {
          (pressEvent as { stopPropagation: () => void }).stopPropagation();
        }
        if (disabled) {
          return;
        }
        if (!onFavoriteToggle) {
          return;
        }
        onFavoriteToggle(event, !event.favorite, renderContext);
      },
      [disabled, event, onFavoriteToggle, renderContext],
    );

    type ThemeColorKey = keyof typeof theme;

    type FavoriteButtonVisualState = {
      backgroundColor: string;
      borderColor: string;
      borderWidth: number;
      hoverBackground: string;
      hoverBorder: string;
      pressBackground: string;
      pressBorder: string;
      outlineColor: string;
      iconColorKey: ThemeColorKey;
      iconFill: "currentColor" | "none";
      iconStrokeWidth: number;
    };

    const favoriteLabel = event.favorite
      ? String(t("eventCard.removeFromFavorites"))
      : String(t("eventCard.addToFavorites"));

    const resolvedFavoriteStrokeWidth = useMemo(
      () => Math.min(6, Math.max(0.5, favoriteIconStrokeWidth)),
      [favoriteIconStrokeWidth],
    );

    const favoriteButtonVisuals = useMemo<FavoriteButtonVisualState>(() => {
      if (event.favorite) {
        return {
          backgroundColor: "transparent",
          borderColor: "transparent",
          borderWidth: 0,
          hoverBackground: "transparent",
          hoverBorder: "transparent",
          pressBackground: "transparent",
          pressBorder: "transparent",
          outlineColor: "$accent",
          iconColorKey: "accent",
          iconFill: "currentColor",
          iconStrokeWidth: resolvedFavoriteStrokeWidth,
        };
      }

      return {
        backgroundColor: "transparent",
        borderColor: "transparent",
        borderWidth: 0,
        hoverBackground: "transparent",
        hoverBorder: "transparent",
        pressBackground: "transparent",
        pressBorder: "transparent",
        outlineColor: "$accent",
        iconColorKey: "brandSecondary",
        iconFill: "none",
        iconStrokeWidth: resolvedFavoriteStrokeWidth,
      };
    }, [event.favorite, resolvedFavoriteStrokeWidth]);

    const favoriteIconColor = useMemo(() => {
      const variable = theme[favoriteButtonVisuals.iconColorKey];
      return getVariableValue(variable ?? favoriteButtonVisuals.iconColorKey);
    }, [favoriteButtonVisuals.iconColorKey, theme]);

    // Dense list rows pin the art to an 80px thumbnail, so the full-size
    // favorite button covered half of it. Dense moves the heart out of the art
    // panel and into the row's right-hand action cluster (beside the chevron),
    // at a size that sits with the price text rather than shouting over it.
    const favoriteButtonSize = dense ? 32 : sizeConfig.favoriteButtonSize;
    const favoriteIconSize = useMemo(
      () => Math.max(16, Math.round(favoriteButtonSize * 0.58)),
      [favoriteButtonSize],
    );

    const cardRole = isWeb && onPress ? "link" : undefined;
    const accessibilityState =
      isNative && onPress
        ? { busy: false, disabled: Boolean(disabled) }
        : undefined;
    const mutedIconColor = useMemo(() => {
      const variable = theme.colorMuted;
      return getVariableValue(variable ?? "$colorMuted");
    }, [theme]);

    const gateLabel = useMemo(() => {
      if (!event.gateType || event.gateType === "NONE") return null;
      if (event.gateType === "PASSWORD")
        return { text: String(t("eventCard.gatePassword")), Icon: Lock };
      if (event.gateType === "APPLICATION")
        return {
          text: String(t("eventCard.gateApplication")),
          Icon: ClipboardList,
        };
      return null;
    }, [event.gateType, t]);

    const recurringLabel = event.isRecurring
      ? String(t("events.recurringBadge"))
      : null;

    // v2 section-06 metalist: accent dot = time, structure dot = place.
    const metaItems = useMemo<MetaListItem[]>(
      () => [
        { kind: "time", label: event.date },
        ...(event.venue
          ? [{ kind: "place" as const, label: event.venue }]
          : []),
      ],
      [event.date, event.venue],
    );

    /**
     * The no-photo fallback: the event's initials, set huge and ghosted into
     * the corner of the art window.
     *
     * A ticket has to survive having no art at all — most organizers upload
     * nothing — and an empty grey rectangle is not a ticket, it is a missing
     * image. Two characters, from the first two words of the title.
     */
    const initials = useMemo(() => {
      const words = event.title
        .split(/\s+/)
        .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
        .filter(Boolean);
      const [first, second] = words;
      if (!first) return undefined;
      const letters = (
        second ? `${first.slice(0, 1)}${second.slice(0, 1)}` : first.slice(0, 2)
      ).toUpperCase();
      return letters || undefined;
    }, [event.title]);

    // Free events wear the amber support fill — driven by the structured
    // `event.isFree` flag set in the transport event-summary-mapper (RSVP or a
    // free-only tier set), no price-label string-matching.
    const isFreeEvent = event.isFree === true;

    const isSoldOut = event.soldOut === true;

    // Sold out HIDES the claimed bar (DS D-093). "100% claimed" beside a sold
    // out block is the same fact twice, and the bar is an urgency device for
    // something you can still act on.
    const showClaimedBar =
      typeof claimedPercent === "number" && claimedPercent > 0 && !isSoldOut;

    // The poster is a vertical-layout treatment — a dense row and a horizontal
    // carousel card are different density tiers with their own shape.
    //
    // It does NOT require art. The panel is ink either way (see `ground`), so
    // a card with no upload is a poster with no photograph rather than a
    // broken one: same stamp, same reversed title, same chrome line, initials
    // ghosted into the ground where the picture would have been.
    const isFeature = variant === "poster" && !isHorizontalLayout && !dense;

    /**
     * The masked die-cut needs CSS masks and `filter: drop-shadow()`, and it
     * needs a tear to cut through. Native, the poster (art runs straight into
     * its foot) and the dense/horizontal rows have one or the other missing, so
     * they keep the painted-hole path.
     */
    const canCut = isWeb && !isHorizontalLayout && !dense && !isFeature;
    if (canCut) ensureCutHoverRule();

    /**
     * The card's ONE date derivation (`deriveCardStamp`): the poster's corner
     * stamp, the Date Stub's DOW / DD / MO and the poster meta line's time.
     *
     * Every part is read in the EVENT's zone (`event.timezone`, or
     * `DEFAULT_VENUE_TIMEZONE` when the producer has none), never the
     * renderer's. So the stamp, the stub and the meta line agree, and the
     * server's HTML matches the browser's first render in any viewer zone.
     * `event.date` agrees too: the DB-backed and search-backed mappers send
     * the zone `date` was formatted in. A
     * renderer-local stamp was React #418 on every home load outside UTC.
     *
     * The Date Stub takes its parts from HERE rather than calling
     * `formatStubDateParts`, whose fallback for an absent zone is UTC (right
     * for a server-rendered PNG): beside a `date` formatted in the venue
     * default it would put the stub a day ahead for every evening show.
     *
     * No `startsAt`, no stamp. The poster is complete without it, and a
     * guessed date on a ticket-shaped object is worse than none.
     */
    const stamp = useMemo(
      () => deriveCardStamp(event.startsAt, event.timezone),
      [event.startsAt, event.timezone],
    );

    /**
     * The poster's one meta line: TIME first, then where.
     *
     * Time leads because the line truncates from the end and the venue does
     * not. `event.venue` is a full street address on most surfaces
     * ("319 Scholes St, Brooklyn, NY 11206"), so venue-first pushed the start
     * time off the end of every card — the poster showed a day in the corner
     * and no hour anywhere.
     *
     * The day is deliberately absent: the stamp already carries it, and
     * repeating it is the same field twice on one card. When there is no
     * instant to derive a time from, the line falls back to the display date
     * so the card still says when.
     */
    const posterMeta = useMemo(
      () =>
        [stamp?.time ?? event.date, event.venue].filter(Boolean).join(" · "),
      [event.date, event.venue, stamp],
    );

    /**
     * The serial in the foot.
     *
     * Flavour, not data — it is the ticket's "No. 001984", and its job is to
     * make the card read as a printed object. Derived from the event id rather
     * than plumbed: it must be stable across renders and identical on server
     * and client (anything random here is a hydration mismatch), and there is
     * no order behind a browse card to carry a real number.
     */
    const serial = useMemo(() => {
      if (event.serial) return event.serial;
      const tail = event.id.replace(/[^a-zA-Z0-9]/g, "").slice(-6);
      return tail ? tail.toUpperCase().padStart(6, "0") : null;
    }, [event.id, event.serial]);

    // The price in the viewer's language. `listingPrice` (data from the
    // transport mapper) is worded here — "Gratis", "Paga lo que quieras" —
    // and wins over the English `priceLabel`, which is only printed for a
    // producer that sent no `listingPrice`. Null is the "See details"
    // placeholder, in any language.
    const priceWords = useListingPriceWords();
    const priceText = listingPriceText(event, priceWords);

    // The price block's two halves. The amount arrives formatted (the shared
    // listing rule decides it), so this only decides which block it sits in —
    // it never re-formats money.
    const footPrice = useMemo(() => {
      if (isSoldOut) {
        return {
          amount: String(t("eventCard.soldOut")),
          label: undefined,
          free: false,
          soldOut: true,
        };
      }
      // No price ("See details", the mapper's "we don't know") — a
      // placeholder in an accent block would advertise a price that does not
      // exist.
      if (!priceText) return null;
      // "From" qualifies an amount. "From Pay what you want" / "From Free+"
      // read as nonsense, so those two prices stand alone.
      const standalone =
        event.listingPrice?.kind === "payWhatYouWant" ||
        event.listingPrice?.kind === "freePlus";
      return {
        amount: priceText,
        label: standalone
          ? undefined
          : String(t(isFreeEvent ? "eventCard.rsvp" : "eventCard.priceFrom")),
        free: isFreeEvent,
        soldOut: false,
      };
    }, [priceText, isFreeEvent, isSoldOut, event.listingPrice?.kind, t]);

    // The horizontal (carousel) card hands 40% of its width to the art panel,
    // so its body is much narrower than the vertical card's at the same card
    // width — and narrower still on a phone, where EventGrid caps the card to
    // the track. At 330px that left ~150px of body, which clipped ordinary
    // titles ("Logan Square DIY Showcase") at the 2-line clamp. Give that case
    // the $5 padding back as $3 and step the title down a rung. The vertical
    // grid card is full-width on a phone and keeps the v2 spec untouched.
    const tightBodyProps =
      isHorizontalLayout && !dense
        ? {
            stack: { $sm: { padding: "$3" as const } },
            title: { $sm: { fontSize: 16, lineHeight: 20 } },
          }
        : { stack: undefined, title: undefined };

    // One definition, two homes: overlaid on the art panel for the grid /
    // carousel card, inline in the action cluster for dense list rows. The
    // overlay call site passes the absolute-positioning props it always had, so
    // the non-dense render is unchanged.
    const renderFavoriteButton = (extraProps?: Record<string, unknown>) =>
      showFavorite && onFavoriteToggle ? (
        <Button
          variant="ghost"
          size="$2"
          icon
          accessibilityLabel={favoriteLabel}
          backgroundColor={favoriteButtonVisuals.backgroundColor}
          borderColor={favoriteButtonVisuals.borderColor}
          borderWidth={favoriteButtonVisuals.borderWidth}
          hoverStyle={{
            backgroundColor: favoriteButtonVisuals.hoverBackground,
            borderColor: favoriteButtonVisuals.hoverBorder,
          }}
          pressStyle={{
            backgroundColor: favoriteButtonVisuals.pressBackground,
            borderColor: favoriteButtonVisuals.pressBorder,
            scale: 0.96,
          }}
          focusStyle={{
            outlineColor: favoriteButtonVisuals.outlineColor,
            outlineWidth: 2,
            outlineStyle: "solid",
          }}
          width={favoriteButtonSize}
          height={favoriteButtonSize}
          paddingHorizontal="$2"
          paddingVertical="$2"
          {...(isNative
            ? { accessibilityState: { pressed: event.favorite } }
            : ({ "aria-pressed": event.favorite } as Record<string, unknown>))}
          onPress={handleFavoritePress}
          {...extraProps}
        >
          <FavoriteIconWrapper style={{ color: favoriteIconColor }}>
            <Heart
              size={favoriteIconSize}
              strokeWidth={favoriteButtonVisuals.iconStrokeWidth}
              absoluteStrokeWidth
              stroke="currentColor"
              fill={favoriteButtonVisuals.iconFill}
              aria-hidden
            />
          </FavoriteIconWrapper>
        </Button>
      ) : null;

    const overlaidFavoriteButton =
      showFavorite && onFavoriteToggle && !dense ? (
        <FavoriteButtonContainer>
          {renderFavoriteButton(
            isHorizontalLayout
              ? {
                  alignSelf: "flex-end",
                  top: "$2",
                  right: "$2",
                  zIndex: 1,
                  position: "absolute",
                }
              : undefined,
          )}
        </FavoriteButtonContainer>
      ) : null;

    const content = dense ? (
      <ContentStack dense>
        <XStack alignItems="center" gap="$3" width="100%">
          <YStack flex={1} gap="$1" minWidth={0}>
            <Text
              variant="h6"
              weight="bold"
              truncate={!isWeb}
              // h6 is 18px, sized for a full-width card body. In a dense row
              // the title column is only ~230px on a phone, so 18px clipped
              // ordinary event names ("Live Music on Red River") at the 2-line
              // clamp. One step down clears all but the longest.
              // Only `$sm` — the media config declares xs before sm, so a
              // narrower `$xs` rung would be overridden by sm at every width
              // it covers. Verified by measuring: $xs never applied.
              $sm={{ fontSize: 16, lineHeight: 20 }}
              style={TWO_LINE_TITLE_CLAMP}
              testId={`${automationId}-title`}
              qaId={`${automationQa}-title`}
            >
              {event.title}
            </Text>

            <XStack alignItems="center" gap="$2" flexWrap="wrap" rowGap="$1">
              <MetaRow>
                <Calendar size={12} color={mutedIconColor} aria-hidden />
                <Text variant="caption" tone="muted">
                  {event.date}
                </Text>
              </MetaRow>
              {/* `maxWidth={320}` was a fixed cap, so on a 320px viewport the
                  address ran 17px past the card's own right edge instead of
                  ellipsing — the row could not shrink below a desktop-sized
                  number. Shrink to the space actually available instead;
                  `minWidth: 0` is what lets a flex child go below its content
                  width so `truncate`'s ellipsis can engage. */}
              <MetaRow flexShrink={1} minWidth={0}>
                <MapPin size={12} color={mutedIconColor} aria-hidden />
                <Text
                  variant="caption"
                  tone="muted"
                  truncate
                  flexShrink={1}
                  minWidth={0}
                >
                  {event.venue}
                </Text>
              </MetaRow>
              {gateLabel ? (
                <MetaRow>
                  <gateLabel.Icon
                    size={12}
                    color={mutedIconColor}
                    aria-hidden
                  />
                  <Text variant="caption" tone="muted">
                    {gateLabel.text}
                  </Text>
                </MetaRow>
              ) : null}
              {recurringLabel ? (
                <MetaRow>
                  <Repeat size={12} color={mutedIconColor} aria-hidden />
                  <Text variant="caption" tone="muted">
                    {recurringLabel}
                  </Text>
                </MetaRow>
              ) : null}
            </XStack>
          </YStack>

          <XStack alignItems="center" gap="$2" flexShrink={0}>
            {/* Suppress the "See details" placeholder — the whole row is a
                link, so a placeholder price earns nothing. Render only real
                price labels (Free, $X, Sold out, etc.) so titles get the
                horizontal room they need on narrow viewports.

                No chevron here. It was decorative (`aria-hidden`) on a row
                that is ALREADY an anchor, and at 390px it cost the title 18px
                plus its gap out of a column measured at just 135px — the
                title then needed three lines against a two-line clamp and
                ellipsed mid-name ("BROOKLYN WAREHOUSE…"). The name is what
                people scan by, so it gets the width. */}
            {priceText ? (
              <Text variant="bodySmall" weight="bold">
                {priceText}
              </Text>
            ) : null}
            {renderFavoriteButton()}
          </XStack>
        </XStack>
      </ContentStack>
    ) : (
      <ContentStack
        minHeight={sizeConfig.contentMinHeight}
        flex={1}
        {...tightBodyProps.stack}
      >
        <Text
          variant="h6"
          weight="bold"
          truncate={!isWeb}
          // v2 .democard h4 tracking (+0.3) — variant h6 sits at -0.1.
          letterSpacing={0.3}
          style={TWO_LINE_TITLE_CLAMP}
          testId={`${automationId}-title`}
          qaId={`${automationQa}-title`}
          {...tightBodyProps.title}
        >
          {event.title}
        </Text>

        {/* v2 section-06 metalist (dots + tracked meta text) for the core
            time/place meta.
            Gate + recurring stay as icon rows below — app-specific status not
            in the doc's two-row metalist. */}
        <YStack gap={6}>
          <MetaList items={metaItems} truncate />
          {gateLabel ? (
            <MetaRow>
              <gateLabel.Icon size={14} color={mutedIconColor} aria-hidden />
              <Text variant="caption" tone="muted">
                {gateLabel.text}
              </Text>
            </MetaRow>
          ) : null}
          {recurringLabel ? (
            <MetaRow>
              <Repeat size={14} color={mutedIconColor} aria-hidden />
              <Text variant="caption" tone="muted">
                {recurringLabel}
              </Text>
            </MetaRow>
          ) : null}
        </YStack>

        {showClaimedBar ? (
          <ClaimedBar
            percent={claimedPercent ?? 0}
            label={claimedLabel}
            marginTop={4}
            testId={`${automationId}-claimed`}
          />
        ) : null}

      </ContentStack>
    );

    const layoutAutomationProps = resolveAutomationProps(
      layoutAutomationId,
      layoutAutomationQa,
    );

    /**
     * The ticket's foot. Serial on the left, price block hard against the
     * right edge — the two things that make a card, a wallet row and a printed
     * ticket read as one object.
     *
     * It replaces the old full-width "View details" button. That button was
     * never a control: the whole card is already the link, so it rendered a
     * button inside a link (invalid, and a second tab stop to the same place),
     * and the DS card has no CTA — the foot is what closes it.
     */
    // The poster has no foot at all: its price is the corner block on the
    // art and its status rides the scrim, so nothing hangs below the image.
    const foot =
      !dense && !isFeature && (serial || footPrice) ? (
        <CardFoot
          {...resolveAutomationProps(
            `${automationId}-foot`,
            `${automationQa}-foot`,
          )}
        >
          <SerialCell>
            {serial ? (
              <Text
                variant="overline"
                fontSize={9}
                lineHeight={12}
                letterSpacing={2}
                tone="muted"
                truncate
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {String(t("eventCard.serial", { serial }))}
              </Text>
            ) : null}
          </SerialCell>
          {footPrice ? (
            <PriceBlock
              amount={footPrice.amount}
              label={footPrice.label}
              free={footPrice.free}
              soldOut={footPrice.soldOut}
              testId={`${automationId}-price`}
            />
          ) : null}
        </CardFoot>
      ) : null;

    /**
     * The corner price block's content. Same source as the ticket's foot
     * block, so a card cannot quote two different prices in two places.
     */
    const posterPrice = isFeature && (footPrice || isSoldOut)
      ? isSoldOut
        ? {
            amount: String(t("eventCard.soldOut")),
            label: undefined,
            free: false,
            soldOut: true,
          }
        : footPrice
      : null;

    const posterPriceText = isSoldOut
      ? String(t("eventCard.soldOut"))
      : footPrice
        ? `${footPrice.label ?? ""} ${footPrice.amount}`.trim()
        : null;

    /**
     * The poster's status line: everything the poster still owes the reader
     * that the title, the stamp and the price block do not already say. Gate
     * first, then recurring, then a price only when there is no corner block.
     *
     * The ticket carries the gate ("Password" / "By application") and
     * "Recurring" as icon rows in its body. The poster has no body, and
     * dropping them silently would mean a gated event advertising itself as an
     * ordinary one — the reader finds out at the door. They ride a mono line
     * instead, and on an embed list that line is the ONLY sign a card is
     * gated, so it prints at the meta line's full strength (see the status
     * `Text` in `FeatureScrim`). A poster with no upload prints the same
     * string as `DateStub`'s note.
     */
    const posterStatusText = [
      gateLabel?.text,
      recurringLabel,
      // Only when the corner block is NOT carrying it — otherwise the card
      // prints its own price twice.
      posterPrice ? null : posterPriceText,
      showClaimedBar
        ? (claimedLabel ?? `${Math.round(claimedPercent ?? 0)}% claimed`)
        : null,
    ]
      .filter(Boolean)
      .join(" · ");

    /**
     * ── The Date Stub: the default artwork for an event with no poster ──────
     *
     * Same artifact as the Open Graph PNG at `/og/event/<slug>`, rebuilt in
     * Tamagui so it follows the viewer's theme (see `DateStub`). It stands in
     * for a missing UPLOAD, which is most events — organizers overwhelmingly
     * upload nothing — so this is the art most cards in a grid actually show.
     *
     * Two modes, because the two card organisms answer different questions:
     *
     *   TICKET — the body below the art already prints the title and a meta
     *     list, so the stub is a decorative restatement and the art window is a
     *     3:2 landscape box. `md` ramp.
     *
     *   POSTER — `isFeature ? null : content`: the poster renders NO body, and
     *     its title and meta live on the art inside `FeatureScrim`, with the
     *     date stamped in the corner. The stub replaces that whole treatment
     *     rather than stacking under it (the scrim's reversed-out ink would be
     *     illegible over the stub's paper body, and the corner stamp would
     *     print the date a second time 20px from the stub's own numeral). So in
     *     stub mode the poster suppresses both, and the stub inherits exactly
     *     what they were saying: `posterMeta` as the place line, the status
     *     line as the note, and the accessibility tree unchanged — the column
     *     is hidden the same way `PosterStamp` already is, the body is not.
     *     `lg` ramp, sized for the 2:3 box's narrow 34% column.
     *
     * Keyed on `event.media` being ABSENT, not on the image having failed:
     * suppressing the poster's chrome has to be decidable at render time. The
     * stub itself is always mounted BENEATH the image, so a 404'd upload still
     * degrades to it (see `EventCardImage`'s `fallback`).
     */
    const posterStub = isFeature && !event.media;

    /**
     * The tear, with a die-cut at each end.
     *
     * Rendered as a sibling between the art and the body rather than as a
     * border on either, so the holes can hang off both sides of the card and
     * be clipped by the frame.
     */
    const perforation = (
      <Perforation aria-hidden={isWeb ? true : undefined}>
        <PunchHole
          left={-HOLE_R}
          {...(holeColor ? { backgroundColor: holeColor } : {})}
          {...(isWeb ? { "data-th-punch-hole": "true" } : {})}
        />
        <PunchHole
          right={-HOLE_R}
          {...(holeColor ? { backgroundColor: holeColor } : {})}
          {...(isWeb ? { "data-th-punch-hole": "true" } : {})}
        />
      </Perforation>
    );

    const denseThumbWidth = size === "sm" ? 64 : size === "lg" ? 96 : 80;
    const horizontalMinHeight = dense ? undefined : cardMinHeight;
    const thumbStackProps = dense
      ? ({
          width: denseThumbWidth,
          maxWidth: denseThumbWidth,
          minWidth: denseThumbWidth,
          flexShrink: 0,
          alignSelf: "stretch",
        } as const)
      : ({
          flexBasis: "40%",
          maxWidth: "40%",
          flexShrink: 0,
          alignSelf: "stretch",
          minHeight: cardMinHeight,
        } as const);

    const horizontalChildren = (
      <HorizontalLayout
        minHeight={horizontalMinHeight}
        alignItems="stretch"
        {...layoutAutomationProps}
      >
        <Stack {...thumbStackProps}>
          <EventCardImage
            media={event.media}
            minHeight={dense ? undefined : cardMinHeight}
            flex={1}
            enforceAspectRatio={false}
            /*
             * The Date Stub, TORN. This thumb is 64-96px wide when dense (and
             * ~40% of the card otherwise), far too narrow for the 34%-column
             * split — so it takes the date column alone, filling the slot.
             *
             * Fully decorative: unlike the poster, this row prints the title,
             * the date and the venue as real text inches to the right. What it
             * replaces is an empty `$surfaceMuted` panel, which is a quarter of
             * every posterless row at a 320px viewport, where the grid resolves
             * to this layout.
             */
            fallback={
              <DateStub
                layout="column"
                date={stamp?.stubParts ?? null}
                size="md"
                testId={`${automationId}-date-stub`}
              />
            }
          >
            {showBadge && event.badge ? (
              <BadgeContainer>
                <Text variant="kicker" tone={badgeTextTone}>
                  {event.badge.text}
                </Text>
              </BadgeContainer>
            ) : null}
            {overlaidFavoriteButton}
          </EventCardImage>
        </Stack>
        <YStack flex={1} minWidth={0} minHeight={dense ? undefined : cardMinHeight}>
          {content}
          {foot}
        </YStack>
      </HorizontalLayout>
    );

    const verticalArt = (
        <EventCardImage
          media={event.media}
          // The art panel is a FIXED 3:2 landscape box, cover-cropped — it is
          // not sized by the upload. A ticket's art window is part of the
          // object, so an organizer's portrait photo cannot make one card in
          // the row a different shape from its neighbours. `feature` is the
          // one exception: its whole point is the portrait poster.
          // No `maxHeight` here. It used to cap the panel at the height 3:2
          // implies for the card's NOMINAL width (272px → 181px), which is not
          // the width an auto-fill track actually hands it (332px here). The
          // cap won, and the "3:2" window rendered 328×181 — 1.81:1. The ratio
          // is the whole point of the art window, so the ratio governs and the
          // panel is however tall the real width makes it.
          {...(isFeature
            ? {
                aspectRatio: POSTER_ASPECT_RATIO,
                $sm: { aspectRatio: POSTER_ASPECT_RATIO_COMPACT },
                flexGrow: 1,
                ground: "ink" as const,
              }
            : { aspectRatio: CARD_ART_ASPECT_RATIO })}
          fallbackText={initials}
          /*
           * ── The Date Stub: the default artwork for an event with no poster.
           *
           * The TICKET only. The poster (`isFeature`) already has a designed
           * no-art treatment — ink ground, ghosted initials, corner date stamp,
           * title and meta reversed out over a scrim — and the stub would land
           * UNDER all of it: the scrim would swallow the stub's body, and the
           * corner stamp and the stub's own numeral would print the same date
           * twice, 20px apart. One no-art treatment per organism.
           *
           * Horizontal / dense rows are excluded by construction: their thumb
           * is 64-96px wide, where a 34% column is ~25px and the composition
           * stops being legible. They keep the plain panel.
           */
          fallback={
            isFeature ? (
              posterStub ? (
                <DateStub
                  date={stamp?.stubParts ?? null}
                  title={event.title}
                  // What `FeatureScrim` was printing: time first, then where.
                  venueLine={posterMeta}
                  note={posterStatusText || null}
                  // The card has no other body — the stub is the carrier, so it
                  // stays in the accessibility tree (its date column does not).
                  decorative={false}
                  size="lg"
                  testId={`${automationId}-date-stub`}
                  // The title MOVED here from `FeatureScrim`; the published
                  // hook moves with it rather than disappearing.
                  titleTestId={`${automationId}-title`}
                />
              ) : undefined
            ) : (
              <DateStub
                date={stamp?.stubParts ?? null}
                title={event.title}
                venueLine={event.venue}
                size="md"
                testId={`${automationId}-date-stub`}
              />
            )
          }
        >
          {/* The poster puts the date in the corner stamp, so the category tag
              would be a second thing notched into the same corner. The ticket
              keeps the tag; the poster keeps the stamp. */}
          {showBadge && event.badge && !isFeature ? (
            <BadgeContainer>
              <Text variant="kicker" tone={badgeTextTone}>
                {event.badge.text}
              </Text>
            </BadgeContainer>
          ) : null}
          {isFeature && stamp && !posterStub ? (
            <PosterStamp
              {...(isWeb ? { "aria-hidden": true } : {})}
            >
              <Text
                variant="span"
                fontFamily="$mono"
                fontSize={9}
                lineHeight={11}
                weight="bold"
                letterSpacing={2}
                textTransform="uppercase"
                tone="accent"
                textAlign="center"
              >
                {stamp.month}
              </Text>
              <Text
                variant="span"
                fontFamily="$heading"
                fontSize={22}
                lineHeight={24}
                weight="black"
                letterSpacing={-1}
                textAlign="center"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {stamp.day}
              </Text>
            </PosterStamp>
          ) : null}
          {overlaidFavoriteButton}
          {isFeature && !posterStub ? (
            // Option A's reversed-out block: title over a single mono line of
            // where-and-when. Everything the picture cannot say, said on the
            // picture — with a scrim that guarantees it stays readable.
            <FeatureScrim
              // The corner price block is cleared VERTICALLY, not horizontally.
              //
              // It used to be cleared horizontally: 108px of `paddingRight` on
              // the whole scrim, so every line paid for a block that is 60px
              // tall in a scrim several times that. The title — at the top, and
              // the thing people are actually reading — lost 108px of a 328px
              // track to something it never came near. Measured in the running
              // 4-up grid: a 204px title track, with 5 of 15 titles clipped.
              //
              // Dropping the reservation without replacing it is worse, not
              // better: the block sits in the bottom-RIGHT, so the last line of
              // every one of those 15 titles then ran under an opaque slab and
              // lost its final word, which reads as a clipping bug rather than
              // as a layer. (Measured: 15 of 15 title boxes overlapping the
              // block by 80×22px.)
              //
              // So the scrim's content column stops ABOVE the block instead.
              // One rule, no per-line exceptions, nothing overlaps: the title
              // gets the full 296px, the meta line stops truncating the street
              // address, the ledger's tier names get the full width, and the
              // block reads as a price tab notched under the caption.
              {...(posterPrice
                ? { paddingBottom: POSTER_PRICE_BLOCK_H + 8 }
                : {})}
              {...(isWeb
                ? ({ style: { backgroundImage: POSTER_SCRIM } } as Record<
                    string,
                    unknown
                  >)
                : { backgroundColor: "$scrim", opacity: 0.92 })}
            >
              <Text
                variant="span"
                fontFamily="$heading"
                fontSize={19}
                lineHeight={23}
                // A phone card is ~40px narrower AND shorter, so the desktop
                // display size ate the scrim. One rung down keeps two lines
                // fitting without the title becoming the whole card.
                $sm={{ fontSize: 16, lineHeight: 20 }}
                weight="bold"
                letterSpacing={-0.3}
                textTransform="uppercase"
                color="$onScrim"
                // Three lines inline (SSR-correct), and a class so the
                // hover rule in the injected tag can raise it to six. The
                // raise carries !important because that is the only way a
                // stylesheet beats an inline value.
                style={POSTER_TITLE_CLAMP}
                {...(isWeb ? { className: "evt-poster-title" } : {})}
                testId={`${automationId}-title`}
                qaId={`${automationQa}-title`}
              >
                {event.title}
              </Text>
              {/* One line, not the dotted meta list: on a poster the dots are
                  another mark competing with the photograph. */}
              <Text
                variant="span"
                fontFamily="$mono"
                {...monoScale.sm}
                lineHeight={14}
                textTransform="uppercase"
                color="$onScrim"
                truncate
              >
                {posterMeta}
              </Text>
              {/*
                Status and scarcity ride INSIDE the scrim rather than in a bar
                beneath the art, and that is a sizing decision as much as a
                visual one.

                The art is a fixed-ratio box, so anything printed on it costs
                the card no height at all — every poster in the grid is exactly
                the same size whether or not it is gated, recurring or filling
                up. A bar below the art does the opposite: the grid runs
                `grid-auto-rows: 1fr`, so ONE gated card added its bar's height
                to every row on the page. On a phone that was ~37px per card
                for a line most cards did not even have.

                Same rung, same ink as the meta line above it (`monoScale.sm`,
                full `$onScrim`). It used to print a step smaller (9.5px, with
                the `2xs` size but `sm` tracking) at `opacity: 0.75`, which is
                how the one line that says "By application" or "Password"
                became the dimmest thing on the card. Measured the same way as
                POSTER_SCRIM (uploads forced to pure white, type hidden,
                brightest ground pixel under the line), worst case a one-line
                title: 3.70:1 dimmed, 5.08:1 at full strength.
              */}
              {posterStatusText ? (
                <Text
                  variant="span"
                  fontFamily="$mono"
                  {...monoScale.sm}
                  lineHeight={14}
                  textTransform="uppercase"
                  color="$onScrim"
                  truncate
                  style={{ fontVariantNumeric: "tabular-nums" }}
                  testId={`${automationId}-status`}
                >
                  {posterStatusText}
                </Text>
              ) : null}
              {/* THE LEDGER — the poster's hover state.

                  Last child, inside the scrim, so the open order reads title →
                  meta → status → rule → tiers. It brings no surface of its
                  own: the scrim it is printed on is the one the poster already
                  had, deepened. Nothing overlaps the title, so nothing has to
                  hide it. */}
              {isWeb ? (
                <EventCardPriceReveal
                  eventId={event.id}
                  cardRef={cardRef}
                  variant="ledger"
                  testId={`${automationId}-tier-reveal`}
                />
              ) : null}
            </FeatureScrim>
          ) : null}
          {isFeature && posterPrice ? (
            <PosterPrice>
              <PriceBlock
                amount={posterPrice.amount}
                label={posterPrice.label}
                free={posterPrice.free}
                soldOut={posterPrice.soldOut}
                // One line per row: POSTER_PRICE_BLOCK_H is only true then.
                nowrap
                minWidth={POSTER_PRICE_BLOCK_W}
                testId={`${automationId}-price`}
              />
            </PosterPrice>
          ) : null}
          {/* Web-only price-reveal for everything that is NOT a scrimmed
              poster — the ticket variant, and the poster that fell back to a
              date stub because it has no image. Those have no scrim to print a
              ledger on, so they keep the slide-up drawer. No-op without a
              TicketTierRevealProvider (native, embeds, Storybook). */}
          {isWeb && !dense && !(isFeature && !posterStub) ? (
            <EventCardPriceReveal
              eventId={event.id}
              cardRef={cardRef}
              // Open ABOVE the corner price block rather than over it.
              bottomOffset={
                isFeature && posterPrice ? POSTER_PRICE_BLOCK_H : 0
              }
              testId={`${automationId}-tier-reveal`}
            />
          ) : null}
        </EventCardImage>
    );

    // `flexGrow` (not `flex`) so this only ever claims *free* space: when the
    // surface is content-height (its default) there is none and this is inert,
    // but when a grid row stretches the card to match its tallest sibling, the
    // slack reaches ContentStack's `flex={1}` instead of pooling as dead space
    // under the body.
    const verticalChildren = (
      <YStack
        width="100%"
        // The poster imposes NO min-height: its height IS the art's ratio plus
        // whatever chrome it earned. `cardMinHeight` is art-height + body-height
        // computed from the TICKET's landscape maths, so on a poster it was
        // pure surplus — the art absorbed it through `flexGrow` and rendered at
        // 0.737 instead of the 4:5 it asked for, making every phone card ~40px
        // taller than it needed to be.
        minHeight={isFeature ? undefined : cardMinHeight}
        flexGrow={1}
        {...layoutAutomationProps}
      >
        {canCut ? (
          <>
            {/* Each pane cuts its own two corners; the halves meet at the tear
                and the wrapper's drop-shadow traces the pair as one bite. */}
            <CutPane
              pane="art"
              className={CUT_PANE_CLASS}
              {...({ style: cutMask("bottom", HOLE_R) } as Record<string, unknown>)}
            >
              {verticalArt}
              <CutArc left={-CUT_ARC_X} bottom={-HOLE_R} {...cutArcProps} />
              <CutArc right={-CUT_ARC_X} bottom={-HOLE_R} {...cutArcProps} />
            </CutPane>
            <CutTear />
            <CutPane
              pane="body"
              className={CUT_PANE_CLASS}
              {...({ style: cutMask("top", HOLE_R) } as Record<string, unknown>)}
            >
              <CutArc left={-CUT_ARC_X} top={-HOLE_R} {...cutArcProps} />
              <CutArc right={-CUT_ARC_X} top={-HOLE_R} {...cutArcProps} />
              {content}
              {foot}
            </CutPane>
          </>
        ) : (
          <>
            {verticalArt}
            {/* The tear only exists where there is a body to tear off. The
                poster runs art straight into its foot. */}
            {isFeature ? null : perforation}
            {isFeature ? null : content}
            {foot}
          </>
        )}
      </YStack>
    );

    const cardChildren = isHorizontalLayout
      ? horizontalChildren
      : verticalChildren;

    const revealStyle = getRevealStyle(renderContext.index);
    const mergedStyle = {
      ...(onPress ? { cursor: "pointer" } : undefined),
      ...revealStyle,
      // Web-only: multi-part CSS shadow strings don't map to React Native, and
      // CardSurface hard-sets `elevation: 0 / shadowColor: transparent` — an
      // inline style is what overrides that compiled class.
      //
      // On the cut path it becomes a `drop-shadow` instead. A box-shadow
      // follows the border BOX, so it would run straight past the notches and
      // the offset copy would be a plain rectangle with two bites missing from
      // the card in front of it. `drop-shadow` traces the rendered alpha, so
      // the shadow gets the same bite the mask cut. The token is a hard offset
      // with no blur and no spread ("4px 4px 0 <ink>"), which is exactly the
      // subset `drop-shadow()` accepts.
      ...(isWeb && shadow !== "none"
        ? canCut
          ? { filter: `drop-shadow(${shadow})` }
          : { boxShadow: shadow }
        : {}),
    };

    return (
      <EventCardSurface
        ref={cardRef}
        disabled={disabled}
        onPress={onPress ? handlePress : undefined}
        role={cardRole}
        accessibilityRole={cardRole}
        accessibilityLabel={event.title}
        tabIndex={onPress ? 0 : undefined}
        cut={canCut}
        className={
          isWeb
            ? canCut
              ? `event-card-reveal ${CUT_CARD_CLASS}`
              : "event-card-reveal"
            : undefined
        }
        style={Object.keys(mergedStyle).length > 0 ? mergedStyle : undefined}
        {...(accessibilityState ? { accessibilityState } : {})}
        {...resolveAutomationProps(automationId, automationQa)}
        {...(rest as Record<string, unknown>)}
      >
        {cardChildren}
      </EventCardSurface>
    );
  },
);

EventCard.displayName = "EventCard";
