/**
 * Pure helpers for the calendar browse view of the embed ticket widget
 * (pattern: ../../book/[embedId]/_components/booking-widget-helpers.ts —
 * decision logic extracted so it's testable without rendering the widget).
 */

import type { CSSProperties } from "react";
import {
  renderListingPrice,
  type ListingPrice,
  type ListingPriceWords,
} from "@th/types/money";

import type {
  CalendarEventItem,
  CalendarEventStatus,
} from "@/app/admin/[slug]/_components/calendar";

import { embedPlaceLine } from "./embed-helpers";

/**
 * The four theme knobs an organiser can override via embed URL params — the
 * shape `useEmbedThemeOverrides` resolves. Null = "not overridden" (keep the
 * default palette).
 */
export type EmbedCalendarThemeOverrides = {
  brandColor: string | null;
  bg: string | null;
  fontColor: string | null;
  accentColor: string | null;
};

/**
 * Bridge the embed theme-override CSS vars (`--hf-*`, set on `<html>` by
 * `useEmbedThemeOverrides`) onto the semantic vars the SHARED calendar engine
 * actually paints with, so brand/accent/text/background customization reaches
 * the calendar (the engine paints `var(--<token>, <stub value>)` throughout —
 * never the `--hf-*` overrides).
 *
 * Only vars for ACTIVE overrides are emitted, so un-overridden knobs keep the
 * default palette and admin usage (which never sets `--hf-*`) is untouched.
 * The `--hf-*` contract is what hosts are told to depend on; this map is the
 * seam that follows the engine when its markup changes.
 *
 * Mapping — retargeted for the DS v3 engine (event-calendar-redesign FR-021):
 * - `brandColor` → the engine's STRUCTURAL frame: its 2px outer border and
 *   the 2px baseline under the weekday header (`--borderColor` /
 *   `--borderColorStrong`). The old engine painted a filled brand header bar
 *   and needed `--surfaceStrong` plus the luminance-picked `--hf-on-brand`
 *   label to stay legible on it; the redesigned header is unfilled mono type
 *   on a rule, so the brand knob moves to the rule and NO text sits on a
 *   brand fill any more. `--onStructure` is deliberately NOT remapped FROM THE
 *   BRAND: the engine uses it for the TODAY square's numeral over an INK fill,
 *   so pointing it at `--hf-on-brand` (picked against the BRAND, not the ink)
 *   could paint ink on ink. It rides the TEXT knob instead — see below.
 * - `accentColor` → the "today" wash, the now-line and PUBLISHED chips
 *   (`--accent` / `--accentSoft`). Unchanged. `--focus` (the focus ring)
 *   stays on the DS value on purpose: it must stay visible as a ring, which
 *   an arbitrary host hex cannot be trusted to do. `--accentText` (text links:
 *   "+N more", "Show all hours") never takes the raw accent either — see
 *   `fontColor` below.
 * - `fontColor` → on-paper text: `--color` (chip titles, date numerals) and
 *   the muted pair `--muted` / `--colorMuted` (weekday heads, times, meta).
 *   It ALSO carries `--onStructure`, because `--color` is not only ink-on-
 *   paper here: the TODAY square and the selected dot-grid day fill a block
 *   WITH it and print their numeral in `--onStructure`. Bridged to
 *   `--hf-on-text`, the luminance-picked companion the hook derives from the
 *   same hex, so `?bg=111111&fontColor=FFFFFF` gets an ink numeral on its
 *   white block instead of the stub's near-white one (~1.02:1, invisible).
 *   NOT `var(--hf-bg)`: with `bg` unset that custom property is never
 *   registered and the declaration resolves to nothing.
 *   It carries `--structure` for the same reason, in the same branch: the
 *   engine's other `--onStructure` site is `.th-cal-action:hover`, which pairs
 *   the two (ink fill, paper label). Bridging only the foreground left a
 *   white-`fontColor` host with the stub's ink fill under its own ink label —
 *   1.05:1 — reachable the moment any `.th-cal-action` renders in public mode.
 *   `--structure` IS the ink `--color` is on this surface, so it rides the same
 *   knob and the pair always travels together (design-system-v2: migrate a fill
 *   and its foreground as a unit), instead of resting on a runtime coupling
 *   ("every action site happens to be internal-gated") held together by a
 *   comment.
 *   And `--accentText`, to `--hf-link`: the DS link rung is picked for cream,
 *   so under a light host text colour (a dark website) "+N more" read at
 *   about 2:1. `--hf-link` is the brand hue moved toward the text colour until
 *   it clears AA (embed-host-vars.ts), so the link still reads as a link.
 * - `bg` → the calendar surface. Applied BOTH as the wrapper `background` and
 *   as `--surface`, because the engine paints its own frame fill now (the old
 *   embed calendar rendered `transparent`, so the wrapper alone was enough).
 */
export function calendarThemeBridgeStyle(
  o: EmbedCalendarThemeOverrides,
): CSSProperties {
  const style: Record<string, string> = {};
  if (o.brandColor) {
    style["--borderColor"] = "var(--hf-brand)";
    style["--borderColorStrong"] = "var(--hf-brand)";
  }
  if (o.accentColor) {
    style["--accent"] = "var(--hf-accent)";
    style["--accentSoft"] = "var(--hf-accent-soft)";
  }
  if (o.fontColor) {
    style["--color"] = "var(--hf-text)";
    style["--muted"] = "var(--hf-text-muted)";
    style["--colorMuted"] = "var(--hf-text-muted)";
    style["--structure"] = "var(--hf-text)";
    style["--onStructure"] = "var(--hf-on-text)";
    style["--accentText"] = "var(--hf-link)";
  }
  if (o.bg) {
    style["--surface"] = "var(--hf-bg)";
    style.background = "var(--hf-bg)";
  }
  return style as CSSProperties;
}

/**
 * "Date N of M" for an EventDate-expanded occurrence (FR-003), as
 * `embeds.getCalendarEvents` emits it; null for a single-date or series event.
 */
export type EmbedCalendarOccurrence = {
  index: number;
  total: number;
  eventDateId: string;
};

/**
 * One event as delivered by `embeds.getCalendarEvents`. Dates may arrive as
 * ISO strings or revived `Date`s depending on the transformer, so the browse
 * view normalizes with `new Date(...)` before handing them to the engine.
 */
export type EmbedCalendarEvent = {
  id: string;
  title: string | null;
  startsAt: string | Date | null;
  endsAt: string | Date | null;
  status: string;
  slug: string | null;
  /**
   * The place name the List view's cards print first (the search index's
   * label, sent only for an event whose public location is exact; null on
   * calendar and single-event embeds). Optional because a cached payload may
   * predate it (read as null).
   */
  placeLabel?: string | null;
  location: string | null;
  city: string | null;
  region: string | null;
  /** The event's stored IANA zone (`Event.timezone`, FR-001). */
  timezone: string;
  /** One row per SCHEDULED EventDate for a multi-date listing (FR-003). */
  occurrence: EmbedCalendarOccurrence | null;
  /**
   * Server-computed hint mirroring what `embeds.getEventDetail` /
   * `embeds.createGuestCheckout` will ACCEPT (see
   * get-embed-calendar-events.ts). Never a substitute for the server check —
   * it only decides which click affordance we offer.
   */
  checkoutEligible: boolean;
  /**
   * FR-022. Server-computed: no ticket type on this date can still be sold.
   * OPTIONAL only until the core widening lands on
   * `embeds.getCalendarEvents` — the field is already agreed as
   * `soldOut: boolean` and this mount reads it under that exact name, so the
   * two meet with no further change here. Tighten to required once the read
   * emits it.
   */
  soldOut?: boolean;
  /**
   * FR-023. Ready-to-paint price copy for the WEEK block's third line
   * ("$25", "From $15", "Free", "Free+"), or null when nothing is on sale
   * (ticketless, or every tier outside its sales window). Optional for the
   * same reason as `soldOut`; the agreed name is `priceLabel: string | null`.
   */
  priceLabel?: string | null;
  /**
   * The same price as data (`resolveListingPrice`). When present (`null`
   * included) the week row words it in the viewer's language — "Desde $15",
   * "Gratis", "Paga lo que quieras" — instead of printing the English
   * `priceLabel`. Absent on a payload from before it shipped.
   */
  listingPrice?: ListingPrice | null;
};

export type CalendarEventClickAction = "checkout" | "linkOut";

// ─────────────────────────────────────────────────────────────────────────────
// Payload → engine items (public mode)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The only status an unauthenticated calendar may paint. Every leg of
 * `getEmbedCalendarEvents` is PUBLISHED-only by construction (NFR-001 puts
 * the gate at the read); this is the belt to that braces — a widened read can
 * never leak a DRAFT chip onto a third-party page through this mount. It is a
 * BACKSTOP, never the gate, so it stays exactly as narrow as the read.
 */
const PUBLIC_EMBED_STATUSES = new Set<CalendarEventStatus>(["PUBLISHED"]);

function toDate(value: string | Date | null): Date | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Place line for an event row: the List view's rule (`embedPlaceLine`: place
 * name, then address, then "city, region", then city), so one event reads the
 * same in both views. Feeds the engine's `venueName`.
 *
 * Where the List card says "Place TBA", this returns `null` instead: the day
 * list and peek hide the line when `venueName` is unset, and the agenda joins
 * it with " · ", so a filler string would repeat down a tight list of rows
 * (the spec is "place if the data has it"). A region alone ("TN") is not a
 * place, so it is omitted here as the List omits it.
 */
export function buildVenueLabel(
  e: Pick<EmbedCalendarEvent, "placeLabel" | "location" | "city" | "region">,
): string | null {
  return embedPlaceLine({
    placeLabel: e.placeLabel,
    addressText: e.location,
    locality: e.city,
    region: e.region,
  });
}

/**
 * The zone the embed grid paints in (FR-018: place and embed always paint in
 * the venue's zone, never the viewer's). The payload carries no venue-level
 * zone, so the MODE of the per-event zones stands in for it: for the common
 * case — one venue, or one org's home city — every row agrees, and for a
 * multi-city org the majority zone is the one that needs the fewest mismatch
 * glyphs. Ties go to whichever zone appeared first, and the payload is
 * soonest-first, so the answer is deterministic and server-stable.
 */
export function resolveEmbedPaintZone(
  events: readonly Pick<EmbedCalendarEvent, "timezone">[],
  fallback: string,
): string {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (!e.timezone) continue;
    counts.set(e.timezone, (counts.get(e.timezone) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  // Insertion order = payload order, so the first-seen zone wins a tie.
  for (const [zone, count] of counts) {
    if (count > bestCount) {
      best = zone;
      bestCount = count;
    }
  }
  return best ?? fallback;
}

export type EmbedCalendarItems = {
  /** What the engine paints, in payload order. */
  items: CalendarEventItem[];
  /** Engine item id → the payload row it came from (click resolution). */
  sources: Map<string, EmbedCalendarEvent>;
};

/**
 * Project the embed payload onto the engine's public-mode items.
 *
 * A multi-date listing arrives as several rows sharing one event `id`
 * (FR-003), and the engine keys every chip, render key and peek on
 * `CalendarItem.id` — so each occurrence gets its own composite id while
 * `eventId` stays the parent's. `sources` maps back, which keeps the click
 * contract on the EXACT occurrence that was pressed (its `checkoutEligible`
 * is clamped per night, so a past night of a future listing links out even
 * when the next night is buyable).
 *
 * `soldOut` and `priceLabel` come STRAIGHT off the row (FR-022 / FR-023):
 * both are server-computed, and `soldOut` is passed through undefined-and-all
 * so a payload that predates the core widening falls back to the engine's
 * sold/capacity derivation rather than asserting "not sold out".
 *
 * Deliberately unset: `ticketsSold` / `totalCapacity` — an unauthenticated
 * surface has no business carrying the house count, and `soldOut` is the only
 * part of it a buyer needs. `href` — public mode never opens a peek, so there
 * is no link for the engine to mint.
 */
export function buildEmbedCalendarItems(
  events: readonly EmbedCalendarEvent[],
  opts: {
    untitledLabel: string;
    /** The viewer's language for the price line. English when omitted. */
    priceWords?: ListingPriceWords;
  },
): EmbedCalendarItems {
  const items: CalendarEventItem[] = [];
  const sources = new Map<string, EmbedCalendarEvent>();
  for (const e of events) {
    const status = e.status as CalendarEventStatus;
    if (!PUBLIC_EMBED_STATUSES.has(status)) continue;
    const startsAt = toDate(e.startsAt);
    // Without a start there is no cell to paint — same drop the old grid made.
    if (!startsAt) continue;
    const id = e.occurrence ? `${e.id}:${e.occurrence.eventDateId}` : e.id;
    if (sources.has(id)) continue;
    sources.set(id, e);
    items.push({
      kind: "event",
      id,
      eventId: e.id,
      title: e.title ?? opts.untitledLabel,
      status,
      startsAt,
      endsAt: toDate(e.endsAt),
      timezone: e.timezone,
      venueName: buildVenueLabel(e) ?? undefined,
      occurrence: e.occurrence
        ? { index: e.occurrence.index, total: e.occurrence.total }
        : null,
      soldOut: e.soldOut,
      priceLabel: calendarPriceLine(e, opts.priceWords),
    });
  }
  return { items, sources };
}

/**
 * The week row's price line in the viewer's language. `listingPrice` (data)
 * wins whenever the payload carries it; an older payload falls back to the
 * English `priceLabel`.
 */
function calendarPriceLine(
  e: EmbedCalendarEvent,
  words: ListingPriceWords | undefined,
): string | null {
  if (e.listingPrice !== undefined) {
    return e.listingPrice ? renderListingPrice(e.listingPrice, words) : null;
  }
  return e.priceLabel ?? null;
}

/**
 * Routes a calendar event click:
 * - `embed.linkOut` → ALWAYS out to ithasfire.com (the embed is a discovery
 *   surface; mirrors EmbedEventGrid's linkOut behavior).
 * - event not checkout-eligible (human-subject embeds, venue-scoped foreign
 *   events) → out to ithasfire.com, where checkout always works.
 * - unknown event (clicked id missing from the payload — shouldn't happen,
 *   the calendar renders from the same payload) → fail safe to the canonical
 *   event page rather than an in-iframe detail the server may reject.
 * - otherwise → the in-iframe detail → checkout flow.
 *
 * "linkOut" must be opened via
 * `window.open(url, "_blank", "noopener,noreferrer")` — never by navigating
 * the iframe itself.
 */
export function resolveCalendarEventClick(args: {
  linkOut: boolean;
  event: Pick<EmbedCalendarEvent, "checkoutEligible"> | undefined;
}): CalendarEventClickAction {
  if (args.linkOut) return "linkOut";
  if (!args.event) return "linkOut";
  return args.event.checkoutEligible ? "checkout" : "linkOut";
}
