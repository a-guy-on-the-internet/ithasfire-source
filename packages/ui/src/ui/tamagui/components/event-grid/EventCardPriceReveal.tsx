"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Stack, XStack, YStack } from "tamagui";
import { formatPriceCents } from "@th/types/money";

import { useTranslations } from "../../../../locale";
import { Text } from "../typography/Text";
import { isWeb } from "./constants";

// ─────────────────────────────────────────────────────────────────────────────
// Data contract (mirrors `events.ticketTiersForCard`)
// ─────────────────────────────────────────────────────────────────────────────

export interface EventCardTier {
  id: string;
  name: string;
  /**
   * Fee-inclusive buyer total in cents, or `null` when the event's admission
   * tax is unresolved (checkout resolves it live). Null renders FACE value, not
   * a fabricated inclusive figure — mirrors the badge's null guard. A free tier
   * is `0`, which renders "Free".
   */
  buyerTotalCents: number | null;
  /** Face value in cents — always present, so a row always has a figure. */
  faceCents: number;
  soldOut: boolean;
  /**
   * Is this tier inside its sales window right now (FR-010)? Resolved
   * SERVER-side against the injected clock at the same instant as the price
   * beside it — never re-derived here from the browser's clock.
   *
   * OPTIONAL, defaulting to on-sale: a payload from before FR-010, a story or a
   * fixture omits it and renders exactly as it did, which is also what every
   * unwindowed tier gets.
   */
  onSale?: boolean;
}

export interface EventCardTiersResult {
  tiers: EventCardTier[] | undefined;
  isPending: boolean;
  isError: boolean;
}

/**
 * App-injected data source for the reveal panel. `@th/ui` is transport-agnostic,
 * so the tRPC hook lives in the consuming app (`apps/web`) and is handed down
 * through {@link TicketTierRevealProvider}. `enabled` MUST gate the fetch so it
 * fires lazily on hover-intent, never on grid render.
 */
export type UseEventCardTiers = (
  eventId: string,
  enabled: boolean,
) => EventCardTiersResult;

const TicketTierRevealContext = createContext<UseEventCardTiers | null>(null);

export interface TicketTierRevealProviderProps {
  useEventCardTiers: UseEventCardTiers;
  children: ReactNode;
}

/**
 * Supplies the lazy tier-fetching hook to every `EventCard` beneath it. Mount it
 * once, high in the app tree (alongside the tRPC provider). Where it is absent —
 * native, embeds, Storybook — the reveal panel is simply never rendered.
 */
export function TicketTierRevealProvider({
  useEventCardTiers,
  children,
}: TicketTierRevealProviderProps): ReactNode {
  return (
    <TicketTierRevealContext.Provider value={useEventCardTiers}>
      {children}
    </TicketTierRevealContext.Provider>
  );
}

const useTicketTierRevealSource = (): UseEventCardTiers | null =>
  useContext(TicketTierRevealContext);

// ─────────────────────────────────────────────────────────────────────────────
// Money formatting — `formatPriceCents` is the canonical COMPACT price helper
// from `@th/types/money`, the same one the card badge uses
// (`event-summary-mapper.ts`), so the panel and the badge cannot disagree on
// rendering.
//
// CURRENCY: defaults to USD. `EventCardTier` mirrors `events.ticketTiersForCard`
// and that projection carries no currency today, so there is nothing to thread.
// Making this honest for a non-USD event needs `currency` added to the
// `ticketTiersForCard` output shape and forwarded onto `EventCardTier` — a
// transport-level plumbing change, deliberately not made here.
// ─────────────────────────────────────────────────────────────────────────────

const formatTierPrice = (tier: EventCardTier): string => {
  // Null buyer total ⇒ tax unresolved ⇒ show face value, never a fabricated
  // inclusive number. Free ($0) ⇒ "Free" (matches the badge's wording).
  const cents = tier.buyerTotalCents ?? tier.faceCents;
  if (cents === 0) return "Free";
  return formatPriceCents(cents);
};

// ─────────────────────────────────────────────────────────────────────────────
// Motion
//
// `panel` — a mount keyframe (plays on appear, unlike a transition) slides the
// panel up over the art.
//
// `ledger` — ONE gesture, driven by TRANSITIONS on a state attribute, never by
// mount. It used to mount on open and unmount on close, so the bottom-anchored
// scrim gained the ledger's whole height in a single frame: the title jumped
// 52px up (176px for a long title over six tiers — measured per frame) and
// snapped back down on leave with no exit at all. Now the ledger stays mounted
// once it has data and its height interpolates:
//
//   - The wrapper is a one-row grid whose track goes `0fr → 1fr`; the clip
//     inside it is `min-height: 0; overflow: hidden`, so the row's height
//     follows the track frame by frame. The same pattern as the order-detail
//     header in `apps/web/src/app/globals.css`.
//   - The scrim's deepen (`EventCard.tsx`) and the title's 3 → 6 line growth
//     run on the SAME duration and easing, so the three read as one move, and
//     closing reverses all three.
//   - The rows still PRINT — a 4px fade-up, staggered 16ms apart via
//     `:nth-child` (CSS, so a 12-card grid re-renders nothing to animate) — but
//     as transitions keyed to the state, so they also un-print on close.
//
// CLOSED MEANS CLOSED: zero height, `aria-hidden`, `pointer-events: none`,
// and `visibility: hidden` once the collapse has finished (the visibility flip
// is delayed by the motion duration so the rows are still there to watch
// leave). Nothing in the ledger is focusable in either state.
//
// The `[data-state="closed"]` rows sit at `opacity: 0`. The CSS guard in
// `EventCardPriceReveal.test.tsx` that forbids hiding the poster's content
// exempts exactly that shape: a ledger-internal subject under the CLOSED
// anchor — a collapsed, aria-hidden, zero-height ledger has nothing to show.
//
// The wrapper's `margin-top` cancels the scrim's flex `gap` (`$2`), so a
// collapsed ledger adds nothing to the resting poster; the rows' `padding-top`
// puts that gap back, plus the 4px the ledger always sat below the meta line.
//
// Reduced motion collapses both variants to an instant reveal.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How long the ledger's collapse runs, in ms. The title keeps its six-line
 * clamp for this long after close, so the clamp drops back to three only once
 * the title's `max-height` has finished shrinking to three lines — dropping it
 * at the START would snap the title short in one frame, the very jump this
 * replaces.
 *
 * RESTATES `--motion-base`, the duration every part of the gesture uses. That
 * token is defined in `apps/web/src/app/globals.css` (`:root`, beside
 * `--motion-fast`), mirroring `apps/web/src/lib/motion/index.ts`; this package
 * cannot read either. Change the token and change this with it. The
 * stylesheets here carry the same number as their `var(--motion-base, 220ms)`
 * fallback, and `EventCardPriceReveal.test.tsx` fails if every one of those
 * fallbacks stops agreeing with this constant.
 */
export const LEDGER_MOTION_MS = 220;

const panelStyleTagId = "event-card-price-reveal";

if (
  isWeb &&
  typeof document !== "undefined" &&
  !document.getElementById(panelStyleTagId)
) {
  const style = document.createElement("style");
  style.id = panelStyleTagId;
  style.innerHTML = `
    @keyframes eventCardPriceRevealIn {
      from { transform: translateY(100%); }
      to   { transform: translateY(0); }
    }
    .evt-price-panel {
      animation: eventCardPriceRevealIn var(--motion-fast, 180ms)
        var(--motion-ease-decelerate, ease-out) both;
    }
    .evt-tier-ledger {
      display: grid;
      grid-template-rows: 0fr;
      margin-top: calc(-1 * var(--t-space-2, 8px));
      pointer-events: none;
      transition: grid-template-rows var(--motion-base, 220ms)
        var(--motion-ease-standard, ease);
    }
    .evt-tier-ledger[data-state="open"] {
      grid-template-rows: 1fr;
    }
    .evt-tier-ledger__clip {
      min-height: 0;
      overflow: hidden;
      visibility: visible;
      transition: visibility 0s linear 0s;
    }
    .evt-tier-ledger[data-state="closed"] .evt-tier-ledger__clip {
      visibility: hidden;
      transition: visibility 0s linear var(--motion-base, 220ms);
    }
    .evt-tier-ledger__rows {
      padding-top: calc(var(--t-space-2, 8px) + 4px);
    }
    .evt-tier-ledger__rows > * {
      opacity: 1;
      transform: translateY(0);
      transition:
        opacity var(--motion-fast, 180ms) var(--motion-ease-decelerate, ease-out),
        transform var(--motion-fast, 180ms) var(--motion-ease-decelerate, ease-out);
    }
    .evt-tier-ledger[data-state="closed"] .evt-tier-ledger__rows > * {
      opacity: 0;
      transform: translateY(4px);
      transition-delay: 0ms;
    }
    .evt-tier-ledger__rows > *:nth-child(1) { transition-delay: 0ms; }
    .evt-tier-ledger__rows > *:nth-child(2) { transition-delay: 16ms; }
    .evt-tier-ledger__rows > *:nth-child(3) { transition-delay: 32ms; }
    .evt-tier-ledger__rows > *:nth-child(4) { transition-delay: 48ms; }
    .evt-tier-ledger__rows > *:nth-child(5) { transition-delay: 64ms; }
    /* Six delays: the rule plus MAX_VISIBLE_LEDGER_TIERS plus "+N more".
       Raising either cap past four means adding rungs here, or the extra rows
       land on the LAST declared delay and the stagger flattens at the bottom —
       which looks like a dropped frame, not like a shorter list. The last row
       lands at 80 + 180 = 260ms, the top of the gesture's budget. */
    .evt-tier-ledger__rows > *:nth-child(6) { transition-delay: 80ms; }
    @media (prefers-reduced-motion: reduce) {
      .evt-price-panel { animation: none !important; }
      .evt-tier-ledger,
      .evt-tier-ledger__clip,
      .evt-tier-ledger[data-state="closed"] .evt-tier-ledger__clip,
      .evt-tier-ledger__rows > * {
        animation: none !important;
        transition: none !important;
      }
    }
  `;
  document.head.appendChild(style);
}

const supportsHoverPointer = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(hover: hover) and (pointer: fine)").matches;

const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Run `cb` after the browser has painted at least one frame. Two
 * `requestAnimationFrame`s, because one runs BEFORE the next style recalc: a
 * ledger inserted closed and flipped open inside the same frame never has a
 * computed `0fr` to transition FROM, and simply appears. Falls back to a
 * timeout where rAF is missing (some test environments).
 */
const afterNextPaint = (cb: () => void): (() => void) => {
  if (typeof requestAnimationFrame !== "function") {
    const id = setTimeout(cb, 32);
    return () => clearTimeout(id);
  }
  let inner = 0;
  const outer = requestAnimationFrame(() => {
    inner = requestAnimationFrame(cb);
  });
  return () => {
    cancelAnimationFrame(outer);
    if (inner) cancelAnimationFrame(inner);
  };
};

const MORE_TIERS_KEY = "eventCard.moreTiers";

const formatMoreLabel = (
  t: ReturnType<typeof useTranslations>,
  count: number,
): string => {
  const label = t(MORE_TIERS_KEY, { count });
  return label && label !== MORE_TIERS_KEY ? label : `+${count}`;
};

const HOVER_INTENT_MS = 120;
/**
 * Rows the PANEL prints before it starts counting. Equal to the ledger's cap
 * below today, which makes the variant ternary inert — kept as two names
 * because they answer to different constraints (this one to a drawer's own
 * height, that one to the art's) and will not necessarily move together.
 */
const MAX_VISIBLE_TIERS = 4;

/**
 * Rows the LEDGER prints before it starts counting.
 *
 * The ledger costs a poster real estate the panel did not: it stacks under a
 * title that un-clamps while open, inside a scrim that grows UPWARD from the
 * art's bottom edge. So "how many fit" is a question about the art's height,
 * and it was answered by MEASURING the running grid with the tier payload
 * stubbed to seven — not by arithmetic. Open scrim height, against the art:
 *
 *   1440px, 2:3 card (art 492px) — 252px with a one-line title, 298px at
 *     three lines, 344px with the title at its six-line hover clamp.
 *   320px, 4:5 card (art 355px)  — 249px / 289px / 329px for the same three.
 *
 * Nothing overflows the art at either size, so four fits — and four is also
 * the panel's cap, so one event hovered on a poster and on a ticket lists the
 * same rows. The fifth is where it would start to go: at 320px a three-line
 * title with four rows already covers 81% of the art, and that is the hover
 * state of a card whose whole job at rest is being a photograph.
 */
const MAX_VISIBLE_LEDGER_TIERS = 4;

// ─────────────────────────────────────────────────────────────────────────────
// Reveal component
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How the tiers are drawn.
 *
 * `panel` (default) — the original: a cream `$surface` drawer, absolutely
 * positioned, sliding up over the art. Still what the TICKET variant and every
 * non-poster caller get.
 *
 * `ledger` — no surface at all. The rows print in normal flow beneath an accent
 * rule, reversed out over the poster's own scrim, like the fine print at the
 * bottom of a gig flyer. It exists because the panel was the one thing on a
 * poster made of a material the poster does not use, and because clearing room
 * for it meant blanking the title — so hovering a card made it forget its own
 * name at the exact moment you were reading it. Now hover is the state where
 * the card tells you MORE: the title's clamp goes from three lines to six and
 * the tiers print underneath.
 */
export type EventCardPriceRevealVariant = "panel" | "ledger";

export interface EventCardPriceRevealProps {
  eventId: string;
  /**
   * Ref to the card's root (the link). Hover/focus/Escape are bound here so the
   * whole card is the trigger and the panel — a descendant — stays open while the
   * pointer is anywhere inside it (WCAG 1.4.13 "hoverable").
   */
  cardRef: RefObject<HTMLElement | null>;
  /** See {@link EventCardPriceRevealVariant}. */
  variant?: EventCardPriceRevealVariant;
  /**
   * Distance from the art panel's bottom edge, in px. `panel` only.
   *
   * The poster parks a price block in that corner and keeps it visible while
   * the drawer is open — the drawer breaks the price down, it does not replace
   * it — so the panel opens ABOVE the block rather than over it. The ticket
   * has nothing there and passes nothing.
   */
  bottomOffset?: number;
  testId?: string;
}

/**
 * A card's ticket tiers, revealed on pointer hover-intent or keyboard focus.
 * Pointer-only progressive enhancement — never rendered on native, and gated to
 * `(hover: hover) and (pointer: fine)` on web.
 *
 * Two renderings, one behaviour: hover-intent, focus, Escape, the lazy-fetch
 * latch and the `shouldReveal` gate are shared verbatim by both variants — only
 * the markup at the bottom forks.
 *
 * Display-only: `pointerEvents: none`, so it never swallows the card's primary
 * navigation and carries no separately-focusable rows (a nested-link a11y trap).
 */
export function EventCardPriceReveal(
  props: EventCardPriceRevealProps,
): ReactNode {
  const useEventCardTiers = useTicketTierRevealSource();
  // No provider (native / embed / Storybook) ⇒ no panel. Provider presence is
  // stable for a mount, so this early return keeps hook order consistent.
  if (!isWeb || !useEventCardTiers) return null;
  return (
    <EventCardPriceRevealInner
      {...props}
      useEventCardTiers={useEventCardTiers}
    />
  );
}

function EventCardPriceRevealInner({
  eventId,
  cardRef,
  variant = "panel",
  bottomOffset = 0,
  testId,
  useEventCardTiers,
}: EventCardPriceRevealProps & {
  useEventCardTiers: UseEventCardTiers;
}): ReactNode {
  const [open, setOpen] = useState(false);
  // Latches true the first time the panel opens and never resets. Decouples
  // "should the query exist" from "is the panel visible": re-hovering a card
  // toggles `open`, but `fetchEnabled` stays true, so the react-query observer
  // never goes disabled→enabled again — no refetch on re-hover (staleTime alone
  // is not enough; an enabled toggle can still trigger a fetch). It never fires
  // on grid render because it only latches once `open` first becomes true.
  const [fetchEnabled, setFetchEnabled] = useState(false);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);

  const doOpen = useCallback(() => {
    clearHoverTimer();
    setFetchEnabled(true);
    setOpen(true);
  }, [clearHoverTimer]);

  const close = useCallback(() => {
    clearHoverTimer();
    setOpen(false);
  }, [clearHoverTimer]);

  useEffect(() => {
    const node = cardRef.current;
    if (!node) return;
    // Tamagui forwards `ref` to an INNER node, while `role="link"` / `tabindex`
    // land on the outer focusable element. `focusin` bubbles UP, so a listener
    // on the inner node never sees the card's focus (this is exactly why hover
    // worked but keyboard focus didn't). Bind to the real focusable ancestor.
    const card =
      (node.closest?.("[role='link']") as HTMLElement | null) ?? node;

    const handleMouseEnter = () => {
      // Pointer-only: a coarse/hover-less device never opens on hover.
      if (!supportsHoverPointer()) return;
      clearHoverTimer();
      // Hover-intent delay: a mouse sweeping across a dense grid shouldn't fire.
      hoverTimerRef.current = setTimeout(doOpen, HOVER_INTENT_MS);
    };
    const handleMouseLeave = () => {
      close();
    };
    const handleFocusIn = () => {
      // Keyboard focus opens immediately (no intent delay). NOT gated on
      // `supportsHoverPointer()` — a keyboard user is not a pointer, and the
      // spec requires focus to be a first-class trigger.
      doOpen();
    };
    const handleFocusOut = (event: FocusEvent) => {
      // Focus moving to another element still inside the card (e.g. the favorite
      // button) must not dismiss — avoids an open/close flicker.
      const next = event.relatedTarget as Node | null;
      if (next && card.contains(next)) return;
      close();
    };

    card.addEventListener("mouseenter", handleMouseEnter);
    card.addEventListener("mouseleave", handleMouseLeave);
    card.addEventListener("focusin", handleFocusIn);
    card.addEventListener("focusout", handleFocusOut);

    return () => {
      card.removeEventListener("mouseenter", handleMouseEnter);
      card.removeEventListener("mouseleave", handleMouseLeave);
      card.removeEventListener("focusin", handleFocusIn);
      card.removeEventListener("focusout", handleFocusOut);
      clearHoverTimer();
    };
  }, [cardRef, clearHoverTimer, doOpen, close]);

  // Escape (WCAG 1.4.13 "dismissible"). Bound on `document`, not the card:
  // `keydown` routes to `document.activeElement` and bubbles from there, so on
  // the HOVER-opened path — where focus is still on `body`, not the card — a
  // listener on the card element never sees the keystroke. Only active while
  // open, so it never intercepts Escape for anything else.
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, close]);

  // Lazy fetch: `fetchEnabled` is the intent latch. On grid render every card is
  // closed and unlatched, so nothing fetches until the pointer/keyboard first
  // expresses intent — then it stays cached across re-hovers.
  const { tiers } = useEventCardTiers(eventId, fetchEnabled);
  const t = useTranslations();

  const maxVisible =
    variant === "ledger" ? MAX_VISIBLE_LEDGER_TIERS : MAX_VISIBLE_TIERS;
  const visibleTiers = useMemo(
    () => (tiers ? tiers.slice(0, maxVisible) : []),
    [tiers, maxVisible],
  );
  const moreCount = tiers ? tiers.length - visibleTiers.length : 0;

  // Only reveal when there is something the badge doesn't already say: more than
  // one tier, or a single tier that cannot be bought right now — sold out, or
  // outside its sales window, in which case the badge quotes no price at all. A
  // lone available tier equal to the badge adds nothing.
  const onlyTier = tiers?.length === 1 ? tiers[0] : undefined;
  const shouldReveal =
    tiers != null &&
    (tiers.length > 1 ||
      (onlyTier != null && (onlyTier.soldOut || onlyTier.onSale === false)));

  // ── Ledger motion state ────────────────────────────────────────────────
  //
  // `armed` — the ledger has been on screen CLOSED for at least one painted
  // frame, so flipping it open has a `0fr` to transition from. On the first
  // hover the tiers land after `open` is already true; without this the
  // ledger would mount open and pop in at full height.
  //
  // `ledgerMounted` — gated on the intent latch as well as on data. With
  // `enabled: false` react-query still hands back CACHED data, so an event
  // listed twice on a page, or a grid revisited inside the cache window, has
  // `tiers` before anyone has hovered anything. Without the latch the closed
  // ledger would mount on grid render: zero-height and fetching nothing, but
  // still a node the old contract promised would not exist before intent.
  const isLedger = variant === "ledger";
  const ledgerMounted = isLedger && fetchEnabled && shouldReveal;
  const [armed, setArmed] = useState(false);
  // Disarm whenever the ledger is gone. A refetch can pull it out from under
  // an open card (`shouldReveal` goes false) and a later one put it back;
  // still armed, it would remount straight into `data-state="open"` and pop
  // in at full height. Derived during render, like `wasExpanded` below, so the
  // remount's first commit is already closed.
  if (!ledgerMounted && armed) setArmed(false);
  useEffect(() => {
    if (!ledgerMounted || armed) return;
    return afterNextPaint(() => setArmed(true));
  }, [ledgerMounted, armed]);

  const expanded = open && ledgerMounted && armed;

  // `settling` — the ledger just closed and its collapse is still running.
  // The title keeps its raised clamp until it ends; see LEDGER_MOTION_MS.
  // Derived during render (not in an effect) so the raise and the collapse
  // start in the same commit, with no one-frame gap between them.
  const [settling, setSettling] = useState(false);
  const [wasExpanded, setWasExpanded] = useState(false);
  if (expanded !== wasExpanded) {
    setWasExpanded(expanded);
    setSettling(!expanded && !prefersReducedMotion());
  }
  useEffect(() => {
    if (!settling) return;
    const id = setTimeout(() => setSettling(false), LEDGER_MOTION_MS);
    return () => clearTimeout(id);
  }, [settling]);

  const testIdProps = testId
    ? ({ "data-testid": testId } as Record<string, unknown>)
    : {};

  // `eventCard.moreTiers` lives in the WEB app's catalog, not this package's
  // `en.json`. Without the app's locale provider the translator falls back to
  // the package catalog and returns the KEY itself — which would print
  // "eventCard.moreTiers" on the poster. The bare count is the honest floor.
  const moreLabel = moreCount > 0 ? formatMoreLabel(t, moreCount) : null;

  if (isLedger) {
    // No intent yet, no data yet, or nothing the badge does not already say:
    // nothing to print, so nothing mounts. Once there IS something, the ledger stays
    // mounted and opens and closes by state, never by mount.
    if (!ledgerMounted) return null;
    return (
      // Plain elements for the two motion layers: the grid track and the clip
      // are pure CSS mechanism (see the stylesheet above), and this component
      // is web-only by construction — `EventCardPriceReveal` returns null
      // before reaching here anywhere else.
      <div
        className={`evt-tier-ledger${settling || expanded ? " evt-tier-ledger--raised" : ""}`}
        data-state={expanded ? "open" : "closed"}
        aria-hidden={expanded ? undefined : true}
        {...testIdProps}
      >
        <div className="evt-tier-ledger__clip">
          <YStack
            className="evt-tier-ledger__rows"
            // NORMAL FLOW. No `position`, no `backgroundColor`, no border box:
            // the ledger is printed on the scrim the card already has, so there
            // is no second material on the poster and nothing has to be blanked
            // to make room for it. The scrim grows upward from the art's bottom
            // edge to take it — now over the length of the transition rather
            // than in one frame.
            width="100%"
            gap={4}
            // No right-hand reservation for the corner price block: the
            // poster's scrim already stops its whole content column above it,
            // so nothing in here is ever level with it. See the
            // `paddingBottom` note on `FeatureScrim` in `EventCard.tsx`.
            pointerEvents="none"
          >
            {/*
          The flame rule — legal here and ONLY here in this block, because a
          2px rule is non-text and answers to the 3:1 graphic floor rather than
          the 4.5:1 text floor the same hue fails.

          `$brandSecondary`, not `$accent`. They are the identical hex in Stub
          and Ember, so the approved look is unchanged, but on Swiss `accent`
          IS the steel-blue — the same value as the old ground — where the rule
          measured 1.00:1. On `$scrim` the flame clears the floor in all three
          (4.17 / 5.42 / 5.61).

          It is NOT always the same fill as the price block notched into the
          corner of the same card: in Stub, `PriceBlock` moves a paid block
          down to `$brandSecondaryHover` (#B93312) so its small white type
          clears AA, while this rule stays on `$brandSecondary` (#E2481D). The
          two agree in Swiss and Ember only.
        */}
            <Stack
              height={2}
              backgroundColor="$brandSecondary"
              {...(isWeb ? { "aria-hidden": true } : {})}
            />
            {visibleTiers.map((tier) => {
              // Same two facts, same single treatment as the panel — see the note
              // on the panel's rows below. STRIKETHROUGH IS ONLY FOR SOLD OUT.
              const dimmed = tier.soldOut || tier.onSale === false;
              const struck = tier.soldOut;
              // The scrim's own two foreground rungs. NOT `$colorMuted` (2.06:1 on
              // ink — invisible, not dim) and NOT `$colorMutedInverted`, which
              // means "muted on `backgroundInverted`" and only coincides with this
              // in Stub: on Ember it is #707070, which measured 1.22:1 on the
              // rendered poster. `$onScrimMuted` is defined against `$scrim` in
              // every theme (8.24 / 7.96 / 7.47).
              const rowColor = dimmed ? "$onScrimMuted" : "$onScrim";
              return (
                <XStack
                  key={tier.id}
                  alignItems="baseline"
                  justifyContent="space-between"
                  gap="$2"
                  width="100%"
                >
                  <Text
                    variant="span"
                    fontFamily="$mono"
                    fontSize={10}
                    lineHeight={15}
                    letterSpacing={1.4}
                    weight="medium"
                    textTransform="uppercase"
                    truncate
                    flexShrink={1}
                    color={rowColor}
                    {...(struck ? { textDecorationLine: "line-through" } : {})}
                  >
                    {tier.name}
                  </Text>
                  <Text
                    variant="span"
                    fontFamily="$mono"
                    fontSize={11}
                    lineHeight={15}
                    letterSpacing={0.4}
                    weight="semibold"
                    flexShrink={0}
                    color={rowColor}
                    style={{ fontVariantNumeric: "tabular-nums" }}
                    {...(struck ? { textDecorationLine: "line-through" } : {})}
                  >
                    {formatTierPrice(tier)}
                  </Text>
                </XStack>
              );
            })}
            {moreCount > 0 ? (
              <Text
                variant="span"
                fontFamily="$mono"
                fontSize={9}
                lineHeight={13}
                letterSpacing={2}
                weight="semibold"
                textTransform="uppercase"
                color="$onScrimMuted"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {moreLabel}
              </Text>
            ) : null}
          </YStack>
        </div>
      </div>
    );
  }

  if (!open || !shouldReveal) return null;

  return (
    <YStack
      className="evt-price-panel"
      position="absolute"
      left={0}
      right={0}
      bottom={bottomOffset}
      zIndex={2}
      pointerEvents="none"
      backgroundColor="$surface"
      borderTopWidth={2}
      borderColor="$borderColorSoft"
      paddingVertical="$2"
      paddingHorizontal="$3"
      gap={4}
      {...testIdProps}
    >
      {visibleTiers.map((tier) => {
        // Two different "you can't buy this" facts, one visual treatment.
        // STRIKETHROUGH IS ONLY FOR SOLD OUT: struck text reads as gone, which
        // is wrong for a tier that opens on Friday — that one is dimmed but
        // intact, because it is still a real future offer.
        const unavailable = tier.soldOut || tier.onSale === false;
        const dimmed = unavailable;
        const struck = tier.soldOut;
        return (
          <XStack
            key={tier.id}
            alignItems="center"
            justifyContent="space-between"
            gap="$3"
            width="100%"
          >
            <YStack flex={1} minWidth={0}>
              <Text
                variant="span"
                weight="semibold"
                fontSize={11}
                lineHeight={16}
                letterSpacing={1}
                textTransform="uppercase"
                truncate
                color={dimmed ? "$colorMuted" : "$color"}
                {...(struck ? { textDecorationLine: "line-through" } : {})}
              >
                {tier.name}
              </Text>
            </YStack>
            <Text
              variant="span"
              fontSize={11}
              lineHeight={16}
              letterSpacing={1}
              weight="bold"
              flexShrink={0}
              style={{ fontVariantNumeric: "tabular-nums" }}
              color={dimmed ? "$colorMuted" : "$color"}
              {...(struck ? { textDecorationLine: "line-through" } : {})}
            >
              {formatTierPrice(tier)}
            </Text>
          </XStack>
        );
      })}
      {moreCount > 0 ? (
        <Text
          variant="span"
          weight="semibold"
          fontSize={10}
          lineHeight={14}
          letterSpacing={1.5}
          textTransform="uppercase"
          color="$colorMuted"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {moreLabel}
        </Text>
      ) : null}
    </YStack>
  );
}
