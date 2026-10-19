"use client";

import { useCallback, type KeyboardEvent } from "react";
import { Search } from "lucide-react";

import { NextLinkAnchor, Text, useTranslations } from "@th/ui";
import {
  openSpotlight,
  useContextQuery,
} from "@/components/search/spotlight-store";
import { categoryLinkSlugs } from "@/i18n/public-paths";
import { usePublicLinks } from "@/i18n/use-public-links";
import { STRUCTURAL } from "@/lib/design-tokens";
import { useBrowseCategoryList } from "./useCategoryBrowse";
import { useDirectoryPlaceCount } from "./useDirectoryPlaceCount";
import { useHeroEvents } from "./useHeroEvents";

// ─────────────────────────────────────────────────────────────────────────────
// S1 Open — "Statement Hero + search object" (Design System v2 §8; design
// system folder DECISIONS.md D-136).
//
// D-136: "A display headline gets the full container, not a hero column."
// The previous shape was the §8 alternative — Split Hero + data rail — which
// boxed an --fs-display headline into the ~1fr column left of a fixed 340px
// rail. The rail is gone. The headline now owns the full shell band, and the
// lede and the find object form a row beneath it:
//
//   kicker row  : 01. · NEAR YOU / EVERYWHERE [· M VENUES] [· N EVENTS THIS WEEK]
//   h1          : full width, two lines, line 2 accent
//   .hh-row     : lede (1fr)  |  find object (1.1fr)
//                                 search trigger → Spotlight
//                                 category chips (links, wrapping — D-138)
//
// ── "No number, no band" (§8 S5 — still the rule here) ─────────────────────
// The kicker's two counts render ONLY when each is real and > 0. Each segment
// gates on ITS OWN query: zero and loading both collapse that segment away —
// never a skeleton, never a "0" — and when both are absent the kicker is the
// bare location label. The product is launching thin; the hero must not
// assert inventory it does not have.
//
// Order is venues → events (the durable thing before the perishable one).
// With coords both are drawn on the SAME circle (`NEARBY_RADIUS_KM`,
// useHeroEvents.ts), so "Near You · 12 venues · 3 events this week" is one
// scope. Without coords the venues count is the whole directory and the
// events count is the continental-US overview box — see the note in
// useDirectoryPlaceCount.ts.
//
// No CTAs live here. The S6 convert band (HostConvertBand) owns conversion;
// the hero's one job is orientation + finding something.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Most category chips the hero shows, taken in sortOrder from the categories
 * whose page lists something (`categories.listBrowsable`).
 */
const CATEGORY_CHIP_COUNT = 6;

// ── Styles ───────────────────────────────────────────────────────────────────

const BODY_FONT = "var(--th-font-body, 'Montserrat', sans-serif)";
const MONO_FONT = "var(--font-mono, ui-monospace, monospace)";

/**
 * Layout/interaction CSS. Lives in a real stylesheet rather than inline styles
 * because none of this is expressible inline: the v2 grid must collapse by
 * RE-DECLARING `grid-template-columns` at a media query (§5, "never by hiding
 * content"), and the controls need :hover / :focus-visible /
 * prefers-reduced-motion.
 *
 * It is rendered as a <style> element inside the component's JSX (not injected
 * from an effect, the way CityMarquee does its keyframes) so it is present in
 * the SSR HTML: this CSS is layout-critical, and a post-paint injection would
 * flash a broken grid. HomeHero renders at most once per page, so there is
 * nothing to dedupe.
 *
 * Every var() carries the STUB hex as its fallback — Stub is the shipped
 * default theme and the fallback is what first paint renders before
 * ActiveThemeInjector mirrors the theme onto <body>. An Ember (navy) fallback
 * here would flash dark.
 */
const HERO_CSS = `
.hh-section {
  width: 100%;
  border-bottom: 2px solid ${STRUCTURAL};
}
/* The hero sits DIRECTLY on the app shell's horizontal grid — the one band the
   navbar row, #main-content and the footer wordmark already share
   (shell-metrics.ts: 1440 cap, 32px gutter, 16px at and below 640). It used to
   nest a SECOND container in here — max-width 1200, margin auto, its own 32/16
   padding — so the hero double-guttered at every width. v2 §5: "Nesting
   containers is a smell." Only the VERTICAL rhythm is the hero's to set. */
.hh-container {
  box-sizing: border-box;
  width: 100%;
  padding: 72px 0; /* $8 — the horizontal gutter belongs to the shell */
  display: flex;
  flex-direction: column;
  gap: 24px; /* $5 */
}
@media (max-width: 899px) {
  .hh-container { padding: 32px 0; gap: 20px; } /* $6 */
}

/* ── Kicker ──────────────────────────────────────────────────────────────── */
.hh-kicker-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px; /* $2 */
}
/* A count segment is its separator + label as ONE flex item. With two
   segments the row wraps at 390 and, as separate items, the "·" was stranded
   at the end of line one ("… 505 VENUES ·" / "12 EVENTS THIS WEEK") — it reads
   as a typo. Bound together, a wrap always carries the dot onto the next
   line with the words it introduces. */
.hh-kicker-seg {
  display: inline-flex;
  align-items: center;
  gap: 8px; /* $2 — same rhythm as the row */
  white-space: nowrap;
}

/* ── Headline ────────────────────────────────────────────────────────────── */
.hh-headline {
  display: flex;
  flex-direction: column;
  margin: 0;
  /* Sized against the COLUMN, not the viewport: the shell's gutter steps at
     641, so the column is not a constant fraction of vw. D-136 gives the
     headline the whole shell band at every width:
       column = min(1440, vw) - 2 * gutter   (gutter 32 >= 641, 16 below)
     Line 2 is the ACCENT line and the longer of the two, so it alone drives
     both ramps — line 1 runs 0.376–0.451 of the column across 320→1920 in
     both locales and never comes near the edge. Line 2 renders at 1.1x
     --hh-line, so its advance is (ratio x 1.1) x --hh-line. Ratios MEASURED
     in the running app with Montserrat 900 loaded (document.fonts.check(
     "900 100px Montserrat") true), flat from 20px to 200px — i.e. linear:

       en  "SOMETHING"   -0.045em   6.108x  →  6.719x --hh-line
       en  "GO DO"       -0.038em   3.401x
       es  "HACER ALGO"  -0.045em   6.635x  →  7.299x --hh-line
       es  "SAL A"       -0.038em   2.996x

     SPANISH is 8.6% wider and rides higher everywhere, so it — not English —
     decides whether anything overflows; both bands below are quoted for it
     too. Everything here was read out of a live page.

     ── The scrollbar hazard: why <=899 is NOT tuned to the 85% target ─────
     --hh-line comes from vw, which INCLUDES a classic scrollbar; the column
     it is sized against is content width, which does not. On Windows/Linux
     the real column is 15–17px narrower than the numbers below while
     --hh-line is unchanged. globals.css puts overflow-x: clip on the body,
     so the failure mode is a SILENTLY CLIPPED final letter with no scrollbar
     to reveal it — invisible on macOS overlay scrollbars and in DevTools
     emulation. The <=899 ramp therefore carries deliberate headroom (~84% in
     English, not 85%) so that the tightest fit anywhere — Spanish at 641 —
     keeps 19.1px of slack. The >=900 band needs no such margin: its column
     is >=836px and its slack >=64px, out of a scrollbar's reach.
     The structurally correct fix, if anyone revisits this, is to make the
     shell band a container-query context and size the ramp in 100cqw, which
     measures the content box and so cannot see the scrollbar at all.

     Desktop (>=900) holds a FLAT 85%, and the 174px cap lands on the shell's
     own 1440 cap, so the ratio never decays the way the previous, longer
     headline's did (that one fell to 0.679 by 1440):
       900 → 0.850 · 1024 → 0.850 · 1280 → 0.850 · 1440 → 0.850 · 1920 → 0.850
       es: 0.923 at every one of them
     The cap engages AT 1440 (1439 → 173.93px, 1440 → 174px). Above it the
     column and --hh-line are both frozen, so the ratio is frozen with them.

     Mobile (<=899) holds ~84% on phones:
       320 → 0.844 · 375 → 0.843 · 390 → 0.843 · 480 → 0.843 · 640 → 0.843
       es: 0.916 at every one of them
     At 641 the shell's gutter doubles, taking 32px out of the column in one
     step, and the ratio jumps for the 641→876 band:
       641 → 0.890 · 700 → 0.886 · 768 → 0.882 · 876 → 0.877
       es: 641 → 0.967 (19.1px of slack, the tightest anywhere) · 768 → 0.958
     No overflow, and one coefficient cannot serve both sides of that step.
     The previous headline had the same artefact and hit 0.983 there.

     The 106px cap engages at 877 and walks the tablet band back down onto
     the desktop ratio, so the 899/900 handoff is CONTINUOUS: 106.00px at
     899, 105.75px at 900. That is what this cap is for — it stops the
     one-column headline outgrowing the two-column one across the breakpoint.
     A 110px cap would never engage in this band at all (L tops out at
     108.83px at 899) and would leave a 3.08px step at the handoff — 2.8%
     of the 899 size.

     The 32px floor is for sub-320 widths we do not otherwise support; it
     engages at 287. Once L is pinned at 32 the line stops shrinking while
     the column keeps going, so the two eventually cross: below 247 English
     CLIPS ("SOMETHING" has no break opportunity, and overflow-x: clip eats
     the tail), while below 266 Spanish WRAPS to two lines instead, because
     "HACER ALGO" has a space to break at. Both are under the 320 floor. (At
     280 the page overflows by 2px in Spanish, but the offender there is the
     S6 convert band, not the hero: line 2 is at 0.942 of its column.)

     Retune by MEASURING, in BOTH locales, if the headline copy or the shell
     gutters change. */
  --hh-line: clamp(32px, calc(12.55vw - 4px), 106px);
}
@media (min-width: 900px) {
  .hh-headline { --hh-line: min(calc(12.65vw - 8.1px), 174px); }
}
.hh-line {
  font-family: ${BODY_FONT};
  font-weight: 900;
  text-transform: uppercase;
  line-height: 0.92;
  margin: 0;
}
.hh-line-1 {
  font-size: var(--hh-line);
  letter-spacing: -0.038em;
  color: var(--color, #211C16);
}
/* Accent line runs 10% larger than line 1, expressed relatively so a single
   var drives both. At the desktop cap that pair is 174 / 191.4px. */
.hh-line-2 {
  font-size: calc(var(--hh-line) * 1.1);
  letter-spacing: -0.045em;
  color: var(--brandSecondary, #E2481D);
}

/* ── Row beneath the headline: lede | find object ───────────────────────── */
/* Asymmetric on purpose (§5: never 50/50 unless truly equal) — the find
   object carries a 56px field plus a chip row and needs the wider cell.
   D-133: every fr track is minmax(0, Nfr). */
.hh-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr);
  gap: 32px 48px; /* $6 / $7 */
  align-items: start;
}
/* min-width:0 is load-bearing: a grid item defaults to min-width:auto, so a
   cell would refuse to shrink below its min-content width and push the whole
   grid past the viewport. */
.hh-row > * { min-width: 0; }
@media (max-width: 899px) {
  .hh-row { grid-template-columns: minmax(0, 1fr); gap: 24px; } /* $5 */
}

.hh-lede {
  font-family: ${BODY_FONT};
  font-size: 16px;
  font-weight: 400;
  line-height: 1.5;
  max-width: 460px; /* v2: "LEDE <=460PX" */
  margin: 0;
  color: var(--colorMuted, #5C544A);
}
@media (max-width: 899px) {
  .hh-lede { font-size: 14px; }
}

/* ── Find object ─────────────────────────────────────────────────────────── */
.hh-find {
  display: flex;
  flex-direction: column;
  gap: 16px; /* $4 */
}
/* The hero's search OBJECT. This is content, not chrome, so it takes the
   structural 2px ink edge — not the navbar trigger's 1px soft-chrome hairline
   (NavbarSearch.tsx), which is the frame around the work. */
.hh-search {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 12px; /* $3 */
  width: 100%;
  height: 56px;
  padding: 0 16px; /* $4 */
  border: 2px solid var(--borderColor, #211C16);
  border-radius: 0;
  background-color: var(--surface, #FDFAF3);
  cursor: pointer;
  transition: border-color 160ms ease-out;
}
.hh-search:hover { border-color: var(--accent, #E2481D); }
.hh-search:focus-visible {
  outline: 2px solid var(--accent, #E2481D);
  outline-offset: 2px;
}
.hh-search > svg { flex-shrink: 0; }
.hh-search-label {
  flex: 1 1 auto;
  min-width: 0;
  font-family: ${BODY_FONT};
  font-size: 14px;
  font-weight: 400;
  line-height: 1.3;
  color: var(--colorMuted, #5C544A);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
@media (max-width: 899px) {
  .hh-search { height: 48px; }
}

/* Chips WRAP — never a horizontal drag rail (D-138). */
.hh-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px; /* $2 */
}
/* Outline-neutral chip as a LINK. The label is the anchor's accessible name,
   so it must clear 4.5:1 on $surface: $colorMuted (#5C544A) is 6.6:1, and the
   hover flips it to ink. The rest border is $borderColor (ink), the same edge
   CategoryChip uses further down the page — $borderColorSoft (rgba .3) is
   ~1.9:1 on $surface, under the 3:1 non-text floor for a control's boundary.
   Hover = accent border + ink text, background UNCHANGED —
   CategoryBrowseSection's CategoryChip explains why a hover FILL is a trap
   here: a $surfaceStrong fill is ink on Stub, the same value as the label,
   and the chip vanished at 1.00:1. */
.hh-chip {
  box-sizing: border-box;
  min-height: 44px; /* touch target floor (§9) */
  padding: 0 14px;
  border: 1px solid var(--borderColor, #211C16);
  border-radius: 0;
  background-color: var(--surface, #FDFAF3);
  transition: border-color 160ms ease-out;
}
.hh-chip-label {
  font-family: ${MONO_FONT};
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  line-height: 1.2;
  color: var(--colorMuted, #5C544A);
  transition: color 160ms ease-out;
}
.hh-chip:hover { border-color: var(--accent, #E2481D); }
.hh-chip:hover .hh-chip-label { color: var(--color, #211C16); }
.hh-chip:focus-visible {
  outline: 2px solid var(--accent, #E2481D);
  outline-offset: 2px;
}
@media (prefers-reduced-motion: reduce) {
  .hh-search,
  .hh-chip,
  .hh-chip-label { transition: none; }
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// HomeHero — main export
// ─────────────────────────────────────────────────────────────────────────────

export type HomeHeroProps = {
  /** Visitor coordinates — scopes the kicker's count. Null when unknown. */
  coords?: { lat: number; lng: number } | null;
  /**
   * Page-global ordinal for the numbered kicker (zero-padded, e.g. "01.").
   * HomeLayout computes this top-to-bottom over the bands that actually
   * render a numbered kicker.
   */
  sectionNumber?: number;
};

export function HomeHero({ coords = null, sectionNumber = 1 }: HomeHeroProps) {
  const t = useTranslations();

  const { count, isLoading, isCapped } = useHeroEvents(coords);
  const { count: venueCount, isLoading: venuesLoading } =
    useDirectoryPlaceCount(coords);
  const { categories } = useBrowseCategoryList();
  // On /es the chips open the Spanish category pages (spanish-seo FR-006).
  const links = usePublicLinks();

  // Consumer surface: read the consumer slot, not the shared `lastQuery`
  // mirror, which carries whatever was typed last in ANY context.
  const consumerQuery = useContextQuery("consumer");

  // ── Search trigger ─────────────────────────────────────────────────────
  const handleSearchOpen = useCallback(() => {
    openSpotlight();
  }, []);

  const handleSearchKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openSpotlight();
    }
  }, []);

  const searchLabel = String(t("search.searchEventsArtistsVenues"));
  // WCAG 2.5.3: the accessible name must contain the visible text. When the
  // box echoes the consumer slot's last query, the name carries it too.
  const searchName = consumerQuery
    ? `${searchLabel} — ${consumerQuery}`
    : searchLabel;

  // "No number, no band": each count is a claim, so it only renders when it is
  // real. Loading and zero both drop that segment; when both drop, the kicker
  // is the bare location label. The two gates are INDEPENDENT — a venue count
  // that has landed renders while the events query is still in flight, and
  // vice versa. At the query ceiling the events hook reports `isCapped` and
  // the kicker says "50+" — a flat "50 events" would be a claim the capped
  // query cannot back. (The venue count is a true COUNT, not a capped list
  // length, so it has no such branch.)
  const showVenues = !venuesLoading && venueCount > 0;
  const showCount = !isLoading && count > 0;
  const countKey = isCapped
    ? "home.heroKickerCountCapped"
    : "home.heroKickerCount";

  const chipCategories = categories.slice(0, CATEGORY_CHIP_COUNT);

  return (
    <section className="hh-section" aria-labelledby="home-hero-heading">
      <style dangerouslySetInnerHTML={{ __html: HERO_CSS }} />

      <div className="hh-container">
        {/* Section label — Swiss numbered kicker (v2 Text variant) */}
        <div className="hh-kicker-row">
          <Text variant="kicker" tone="accent" weight="bold" aria-hidden>
            {`${String(sectionNumber).padStart(2, "0")}.`}
          </Text>
          <Text variant="kicker" tone="muted" weight="bold">
            {coords
              ? String(t("home.heroLocationNearYou"))
              : String(t("home.heroLocationEverywhere"))}
          </Text>
          {/* Segments in a fixed order — venues, then events — each carrying
              its own leading separator so any subset composes without a
              dangling "·". The separators are ornament: aria-hidden, so AT
              reads "Near You 12 venues 3 events this week". */}
          {showVenues && (
            <span className="hh-kicker-seg">
              <Text variant="kicker" tone="muted" weight="bold" aria-hidden>
                ·
              </Text>
              <Text variant="kicker" tone="muted" weight="bold">
                {String(t("home.heroKickerVenues", { count: venueCount }))}
              </Text>
            </span>
          )}
          {showCount && (
            <span className="hh-kicker-seg">
              <Text variant="kicker" tone="muted" weight="bold" aria-hidden>
                ·
              </Text>
              <Text variant="kicker" tone="muted" weight="bold">
                {String(t(countKey, { count }))}
              </Text>
            </span>
          )}
        </div>

        {/* Headline — the page's single h1, full container width (D-136) */}
        <h1 className="hh-headline" id="home-hero-heading">
          <span className="hh-line hh-line-1">
            {String(t("home.heroTitle"))}
          </span>
          {/* Separates the two lines in the h1's TEXT content, so the
              accessible name is "Go do Something" and not
              "Go doSomething". Costs nothing visually: a whitespace-only
              anonymous flex item is not rendered (CSS Flexbox §4). */}
          {" "}
          <span className="hh-line hh-line-2">
            {String(t("home.heroTitleAccent"))}
          </span>
        </h1>

        <div className="hh-row">
          {/* ── Left: lede ─────────────────────────────────────────────── */}
          <p className="hh-lede">{String(t("home.heroSubtitle"))}</p>

          {/* ── Right: find object ─────────────────────────────────────── */}
          <div className="hh-find">
            {/* Opens the Spotlight overlay on every breakpoint. The accessible
                name lives on the container's stable aria-label; the visible
                string echoes the consumer slot's last query when there is
                one. */}
            <div
              className="hh-search"
              role="button"
              tabIndex={0}
              aria-label={searchName}
              data-testid="home-search-trigger"
              onClick={handleSearchOpen}
              onKeyDown={handleSearchKeyDown}
            >
              {/* Lucide is a plain SVG — it can't read a Tamagui token, so we
                  feed the $colorMuted token through its CSS custom property. */}
              <Search
                size={18}
                color="var(--colorMuted, #5C544A)"
                strokeWidth={2}
                aria-hidden
              />
              <span className="hh-search-label">
                {consumerQuery || searchLabel}
              </span>
            </div>

            {/* Category LINKS (navigation, not tabs), only categories whose
                page lists something (owner ruling 2026-10-14). Absent while
                the list is loading or empty — no skeleton and no empty group
                announced to AT; it appears once there is something to browse.
                House shows lives in the footer, not here: a fixed chip would
                lead to an empty page whenever it had nothing. */}
            {chipCategories.length > 0 && (
              <div
                className="hh-chips"
                role="group"
                aria-label={String(t("home.heroBrowseLabel"))}
              >
                {chipCategories.map((category) => (
                  <NextLinkAnchor
                    key={category.id}
                    href={links.path({
                      kind: "category",
                      slugs: categoryLinkSlugs(category),
                    })}
                    className="hh-chip"
                  >
                    <span className="hh-chip-label">{category.name}</span>
                  </NextLinkAnchor>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

HomeHero.displayName = "HomeHero";
