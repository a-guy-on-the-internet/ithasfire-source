"use client";

/**
 * UniversalSearchPage — Unified multi-modal search with stacked result sections.
 *
 * Layout:
 *   Search bar (shared query)
 *   Scope radiogroup — All / Events / People / Groups / Places. The ONE
 *     result-narrowing control; it drives the tRPC query and the `type` URL
 *     param. (There used to be a second "result tab" strip that re-sliced the
 *     same results post-fetch. Two overlapping narrowing mechanisms is one too
 *     many, so it is gone.)
 *   ┌── facet rail (desktop, persistent) ──┬── toolbar: count + sort ───────┐
 *   │  Category · Date · Price · Distance  │  active filter chips          │
 *   │                                      │  results ····· sticky map     │
 *   └──────────────────────────────────────┴───────────────────────────────┘
 *   On mobile the rail's contents move into a bottom sheet behind a Filters
 *   button — SAME component (`SearchFacetRail`), two mount points.
 *
 * APPLY MODEL SPLITS BY VIEWPORT. Desktop applies a facet edit immediately
 * (the price inputs settle for `PRICE_COMMIT_DELAY_MS` first, so a keystroke
 * is not a request); mobile holds edits as drafts inside the sheet until its
 * commit button, because a phone cannot show the result list changing under
 * the sheet anyway. `applied` is the committed snapshot the query reads on
 * both.
 *
 * A single `search.autocomplete` call fetches all entity types. Event-specific
 * filters (category, dateRange, freeOnly) are passed unconditionally — the
 * Meilisearch adapter scopes them to events via `(type != "event" OR ...)`
 * filter clauses. Results are partitioned client-side by type.
 *
 * Swiss International Style: no border-radius, Montserrat type,
 * orange (#FF5721) action, steel blue (#35589A) structure.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { searchPriceLabel } from "./search-price-label";
import { useRouter } from "@bprogress/next/app";
import {
  ArrowRight,
  MapPin,
  Navigation,
  X,
  SlidersHorizontal,
  ArrowUpDown,
  Calendar,
  User,
  Building2,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  Alert,
  BottomSheet,
  Button,
  Chip,
  Lineup,
  LineupRow,
  SegmentedControl,
  StyledSelect,
  Text,
  useListingPriceWords,
  useLocale,
  useTranslations,
  type UnifiedSearchSuggestion,
} from "@th/ui";

import type { EventSearchSuggestion } from "@/server/event-search";
import { trpc } from "@/trpc";
import { withCategoryDisplayNames } from "@/lib/category-display-name";
import { keepPreviousData } from "@tanstack/react-query";
import { SearchBar } from "@/components/search/SearchBar";
import {
  buildSearchQueryString,
  diffIsCategoryOnly,
  diffIsContinuousOnly,
  diffIsNearMeResolution,
  normalizeQueryString,
  parseSearchParams,
  writeSearchUrl,
  type SearchScope,
} from "./search-url";
import {
  availableSorts,
  reconcileSort,
  scopeForSort,
  toServerSort,
  type SortId,
} from "./search-sort";
import {
  categoryFilterInput,
  pruneCategorySelection,
  shownCategorySlugs,
  unavailableCategoryNoticeKind,
  type UnavailableCategoryNoticeKind,
} from "./search-category-filter";
import { useUserLocation } from "@/hooks/user-location/useUserLocation";
import { useImperial } from "@/hooks/useImperial";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useMinViewportWidth } from "@/hooks/useMinViewportWidth";
import {
  RADIUS_MIN_KM,
  RADIUS_MAX_KM,
  RADIUS_STEP_KM,
  DEFAULT_RADIUS_KM,
  RADIUS_WORLDWIDE_KM,
  SLIDER_MAX_KM,
  formatRadiusLabel,
  isWorldwideRadius,
  kmToSliderValue,
  normalizeRadiusForUnit,
  radiusSliderConfig,
  sliderValueToKm,
} from "@/lib/search/radius";
import { SearchResultsMap } from "./SearchResultsMap";
import { SearchMapLegend, SearchMapPrivateNote } from "./SearchMapOverlays";
import {
  countPrivateVenues,
  mapItemKey,
  parseMapItemKey,
  toEventMapItem,
  toVenueMapItem,
  type SearchMapItem,
  type SearchMapKind,
  type VenueMapSource,
} from "./search-map-items";
import { SearchFacetRail, type FacetDraft } from "./SearchFacetRail";
import { nextScopeForKey, scopeRadioDomId } from "./search-scope-nav";
import { facetDiffKind, facetsAreEmpty } from "./search-facet-apply";
import { chipActivation } from "./chip-keyboard";
import { type PlaceDetail } from "@/components/maps/LocationAutocomplete";
import {
  setContextQuery,
  useContextQuery,
} from "@/components/search/spotlight-store";
import {
  ACCENT,
  ACCENT_FILL,
  DANGER,
  FOREGROUND,
  MUTED,
  MUTED_TEXT,
  ON_ACCENT_FILL,
  STRUCTURAL,
} from "@/lib/design-tokens";
import { SaveHeart } from "@/components/saves/SaveHeart";
import { useEventSaves } from "@/components/saves/useEventSaves";

// ── Constants ────────────────────────────────────────────────────────────────

const MIN_QUERY_LENGTH = 2;
const QUERY_LIMIT = 50;
const MAX_QUERY_OFFSET = 1000;
const SEARCH_PATH = "/search";

/**
 * How long a continuous facet edit settles before desktop commits it.
 *
 * Only the price inputs are continuous — every other facet is a discrete
 * toggle (a category checkbox, a date preset, the free switch) and commits on
 * the spot. Without this, typing "1", "12", "125" into Min fires three result
 * sets. Mirrors the 250 ms the radius slider already uses and the 700 ms the
 * query input uses; a typed number sits between a drag and a sentence.
 */
const PRICE_COMMIT_DELAY_MS = 400;

// ── Width budget ─────────────────────────────────────────────────────────────
// Every number here is measured against the SHELL's usable content box, not
// the viewport: AppShell caps at SHELL_MAX_WIDTH 1440 and pads 32px each side,
// and `page.tsx` hands that whole 1376 to this component. Getting this wrong
// is not a cosmetic bug — the previous pass computed page widths of 1004/1400
// inside a PageContainer still clamped at its 896 default, so the rail ate the
// results column and, with the map up, left two ~294px panes.

/** Persistent desktop facet rail width — matches `SearchFacetRail`'s `f.rail`. */
const FACET_RAIL_WIDTH = 260;

/** Gap between the rail and the results column — matches `layout.shell`. */
const SHELL_GAP = 24;

/** The shell's usable content width (SHELL_MAX_WIDTH 1440 − 2 × 32 gutter). */
const SHELL_CONTENT_MAX = 1376;

/**
 * Narrowest a result list may get before it stops reading as a list, and
 * narrowest a map may get before it stops being worth the pixels. These are
 * REAL floors: `s.leftCol` / `s.mapPane` carry them as `minWidth`, and
 * `s.body` wraps, so if the arithmetic below is ever wrong the map drops
 * BELOW the list instead of both silently crushing.
 */
const RESULTS_MIN_WIDTH = 380;
const MAP_MIN_WIDTH = 340;

/**
 * Viewport at which the facet rail appears. Deliberately the same 960 as
 * `useIsCompactViewport` / the shell's bottom-nav breakpoint: below it the
 * product is already in compact chrome, and that is exactly where the rail
 * should be a bottom sheet instead. Leaves 1376−64=896 → 612 for the results.
 */
const RAIL_MIN_VIEWPORT = 960;

/**
 * Viewport at which the sticky map pane can sit BESIDE the rail and the list.
 * Two `flex: 1 1 0` panes split evenly, so the requirement is
 * `2 × RESULTS_MIN_WIDTH + SHELL_GAP` inside the results column:
 * 380·2 + 24 = 784, plus rail 260 + 24 = 1068 of content, plus the shell's
 * 64px of gutter = 1132. 1200 clears it with room, splitting ~414 each.
 * Below this the map is still reachable — it moves to the List/Map toggle.
 */
const MAP_PANE_MIN_VIEWPORT = 1200;

/** DOM id of the mobile Filters button — the sheet returns focus to it. */
const FILTERS_TOGGLE_ID = "search-filters-toggle";

/** Focusable descendants inside the mobile filters sheet, for the focus trap. */
const FOCUSABLE_SELECTOR =
  'a[href],button:not([disabled]):not([tabindex="-1"]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

// `useLayoutEffect` on the client, `useEffect` on the server — silences React's
// SSR useLayoutEffect warning. Mirrors the repo pattern (CityMarquee).
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

// Sticky offset for the desktop results map — clears the sticky glass navbar
// (~72px) so the map pane never slides under it as the list scrolls.
const MAP_STICKY_TOP = 88;

/** Clamp a candidate radius (km) into the slider's real-distance bounds. */
const clampRadiusKm = (km: number): number =>
  Math.max(RADIUS_MIN_KM, Math.min(RADIUS_MAX_KM, km));

/** Great-circle distance between two coords, in km (map "search this area" gate). */
function distanceKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ── Inline-CSS token strings ─────────────────────────────────────────────────
// This page renders raw style={{}} objects (no Tamagui styled()), so it
// references the theme's CSS variables with design-token fallbacks instead of
// scattering duplicate hex literals (design-system v2 page pass).
const FONT_BODY = "var(--th-font-body, 'Montserrat', sans-serif)";
// These constants ARE `var(--token, #stubFallback)` strings now (see @/lib/design-tokens), so they
// no longer need a second var() wrapper — that only produced `var(--color, var(--color, …))`.
const VAR_INK = FOREGROUND;
const VAR_MUTED = MUTED_TEXT;
// Ink, NOT the soft `BORDER` constant: this page wants v2's hard content edge. (`BORDER` maps to
// `borderColorSoft`; its old #D4D4D4 was serving as the fallback for an INK var, which is what a
// first paint would have rendered.)
const VAR_BORDER = "var(--borderColor, #211C16)";
// Was `var(--accentHard, ${STRUCTURAL_HARD})` — a fallback of #000000 for a token whose Stub value
// is #B93312, so first paint rendered black where the hydrated theme paints burnt orange.
const VAR_ACCENT_HARD = "var(--accentHard, #B93312)";
const VAR_DANGER = DANGER;
// Paired "on" foregrounds — themed fills must use the theme's on-token so a
// preset/theme that changes the fill keeps a compliant label color.
// (`VAR_ON_ACCENT` is gone: its only consumer moved to ACCENT_FILL + ON_ACCENT_FILL. It was
// `var(--onBrandSecondary, ${FOREGROUND})` — an INK fallback for a token whose Stub value is
// WHITE, so SSR painted ink and hydration flipped it. Both ends failed AA on `ACCENT` anyway.)
const VAR_ON_STRUCTURE = "var(--onStructure, #FDFAF3)";

// Radius constants + display/label helpers are shared with the Surprise Me
// (/lucky) page so the two distance controls cannot drift apart.

// ── Types ────────────────────────────────────────────────────────────────────

// Sort ids, labels, scope rules and the server mapping live in ./search-sort
// so this page and the server route cannot drift. The local list this replaces
// carried a "Featured" option that was never implemented — it fell through the
// client-side sort switch and rendered as "Date: latest".
type SortOption = SortId;

type GeoLocation = { lat: number; lng: number; label: string };

// `SearchScope` (query-narrowing entity type) is defined in ./search-url and
// imported above so the URL parser/serialiser and this component can't drift.

// Scope → search-bar placeholder / aria-label i18n keys. Keeps the input copy
// in step with the active scope chip ("Search places…" when scoped to places).
const SCOPE_PLACEHOLDER_KEY: Record<SearchScope, string> = {
  all: "search.placeholderAll",
  event: "search.placeholderEvents",
  human: "search.placeholderPeople",
  organization: "search.placeholderGroups",
  place: "search.placeholderPlaces",
};

const SCOPE_PLACEHOLDER_LABEL_KEY: Record<SearchScope, string> = {
  all: "search.placeholderAllLabel",
  event: "search.placeholderEventsLabel",
  human: "search.placeholderPeopleLabel",
  organization: "search.placeholderGroupsLabel",
  place: "search.placeholderPlacesLabel",
};

/**
 * The scope row — the page's single result-narrowing control.
 *
 * Order and labels are fixed. `place` reads "Places", the product's word for
 * the entity; the Places result section below matches.
 */
const SCOPE_OPTIONS: readonly {
  id: SearchScope;
  label: string;
  icon?: LucideIcon;
}[] = [
  { id: "all", label: "All" },
  { id: "event", label: "Events", icon: Calendar },
  { id: "human", label: "People", icon: User },
  { id: "organization", label: "Groups", icon: Building2 },
  { id: "place", label: "Places", icon: MapPin },
];

export type UniversalSearchPageProps = {
  initialQuery: string;
  initialNearMe?: boolean;
  initialRadiusKm?: number;
  initialGeoLocation?: GeoLocation | null;
  initialSort?: SortOption;
  initialCategories?: string[];
  initialScope?: SearchScope;
};

// ── Styles ───────────────────────────────────────────────────────────────────

const s = {
  root: {
    width: "100%",
    maxWidth: 720,
    marginLeft: "auto",
    marginRight: "auto",
    display: "flex",
    flexDirection: "column",
    gap: 32,
  } satisfies CSSProperties,

  heading: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    borderBottom: `2px solid ${VAR_BORDER}`,
    paddingBottom: 16,
  } satisfies CSSProperties,

  headingRow: {
    display: "flex",
    alignItems: "baseline",
    gap: 8,
  } satisfies CSSProperties,

  headingTitle: {
    fontFamily: FONT_BODY,
    fontSize: 22,
    fontWeight: 900,
    textTransform: "uppercase" as const,
    letterSpacing: "-0.02em",
    color: VAR_INK,
    margin: 0,
  } satisfies CSSProperties,

  headingSubtitle: {
    fontFamily: FONT_BODY,
    fontSize: 12,
    fontWeight: 600,
    textTransform: "uppercase" as const,
    letterSpacing: "0.1em",
    color: VAR_MUTED,
    margin: 0,
  } satisfies CSSProperties,

  chipRow: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: 8,
    alignItems: "center",
  } satisfies CSSProperties,

  // ── Section header (stacked results) ─────────────────────────────────
  sectionHeader: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    borderBottom: `2px solid ${VAR_BORDER}`,
    paddingBottom: 10,
  } satisfies CSSProperties,

  sectionTitle: {
    fontFamily: FONT_BODY,
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase" as const,
    letterSpacing: "0.1em",
    color: VAR_INK,
    margin: 0,
  } satisfies CSSProperties,

  sectionCount: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 20,
    height: 20,
    padding: "0 5px",
    fontFamily: FONT_BODY,
    fontSize: 10,
    fontWeight: 700,
    // The #B93312 rung + white (5.92:1). At 10px/700 this is the smallest text on the page, so it
    // needs the rung most: on `ACCENT` (#E2481D) it failed in BOTH states — white 4.06:1 once
    // hydrated, ink 4.17:1 at SSR — and flashed between them, since the old fallback was ink for a
    // token whose Stub value is white.
    backgroundColor: ACCENT_FILL,
    color: ON_ACCENT_FILL,
    borderRadius: 0,
  } satisfies CSSProperties,

  sectionCountMuted: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 20,
    height: 20,
    padding: "0 5px",
    fontFamily: FONT_BODY,
    fontSize: 10,
    fontWeight: 700,
    // The previous `--borderColorStrong` resolves close to white in the
    // dark theme, so the badge collided with the page text and was invisible.
    // Use a low-alpha white fill with muted text instead — reads as "0" on
    // any theme without nuking contrast.
    backgroundColor: "rgba(33,28,22,0.08)",
    color: VAR_MUTED,
    borderRadius: 0,
  } satisfies CSSProperties,

  resultList: {
    display: "flex",
    flexDirection: "column",
    gap: 0,
  } satisfies CSSProperties,

  resultItem: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "12px 16px",
    fontFamily: FONT_BODY,
    fontSize: 15,
    fontWeight: 500,
    color: VAR_INK,
    textDecoration: "none",
    borderBottom: `1px solid ${VAR_BORDER}`,
    cursor: "pointer",
    background: "none",
    border: "none",
    borderBottomWidth: 1,
    borderBottomStyle: "solid" as const,
    borderBottomColor: VAR_BORDER,
    textAlign: "left" as const,
    width: "100%",
  } satisfies CSSProperties,

  resultTitle: {
    flex: 1,
    fontFamily: FONT_BODY,
    fontSize: 15,
    fontWeight: 500,
  } satisfies CSSProperties,

  // Avatar / icon disc that sits at the start of People / Org / Place rows
  // so the result type reads at a glance — paired with the section header
  // icon it gives the buckets visual identity instead of a sparse text wall.
  resultAvatar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 36,
    height: 36,
    flexShrink: 0,
    fontFamily: FONT_BODY,
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: "0.04em",
    color: VAR_INK,
    border: `2px solid ${VAR_BORDER}`,
  } satisfies CSSProperties,

  // Two-line label column — title on top, secondary metadata below.
  // Lets us show both `name` and `@handle` / `city` without colliding.
  resultLabelCol: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    flex: 1,
    minWidth: 0,
  } satisfies CSSProperties,

  resultMeta: {
    fontFamily: FONT_BODY,
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: "0.02em",
    color: VAR_MUTED,
    textOverflow: "ellipsis" as const,
    overflow: "hidden" as const,
    whiteSpace: "nowrap" as const,
  } satisfies CSSProperties,

  emptyState: {
    padding: "16px 0",
    fontFamily: FONT_BODY,
    fontSize: 14,
    color: VAR_MUTED,
    textTransform: "uppercase" as const,
    letterSpacing: "0.06em",
    fontWeight: 600,
    margin: 0,
  } satisfies CSSProperties,

  sectionWrapper: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  } satisfies CSSProperties,

  // ── Two-column body (results + sticky map) ───────────────────────────
  // `body` is the flex ROW only when the map pane is present; otherwise the
  // page renders as a single centered reading column exactly as before.
  //
  // `flexWrap` + the real `minWidth`s on the two children are the safety net
  // under MAP_PANE_MIN_VIEWPORT: if the width budget is ever wrong, the map
  // WRAPS below the list rather than the two of them compressing into a pair
  // of unreadable ~294px columns, which is what shipped before.
  body: {
    display: "flex",
    flexDirection: "row",
    flexWrap: "wrap" as const,
    gap: 24,
    alignItems: "flex-start",
    width: "100%",
  } satisfies CSSProperties,
  bodySingle: {
    width: "100%",
  } satisfies CSSProperties,

  // Left column keeps the current ~720px reading width; the map takes the
  // rest. `leftColFull` reproduces today's single-column stack (gap 32).
  leftCol: {
    display: "flex",
    flexDirection: "column",
    gap: 32,
    flex: "1 1 0",
    minWidth: RESULTS_MIN_WIDTH,
    maxWidth: 720,
  } satisfies CSSProperties,
  leftColFull: {
    display: "flex",
    flexDirection: "column",
    gap: 32,
    width: "100%",
  } satisfies CSSProperties,

  // Sticky map pane — hard content edge, stays in view while the list scrolls.
  mapPane: {
    flex: "1 1 0",
    // A real floor, not `0`. The previous pass claimed a "320px floor" in a
    // comment while setting minWidth: 0, so nothing enforced it.
    minWidth: MAP_MIN_WIDTH,
    alignSelf: "stretch",
  } satisfies CSSProperties,
  mapSticky: {
    position: "sticky",
    top: MAP_STICKY_TOP,
    height: `calc(100vh - ${MAP_STICKY_TOP + 24}px)`,
    minHeight: 420,
    border: `2px solid ${VAR_BORDER}`,
    overflow: "hidden",
  } satisfies CSSProperties,

  // Floating "Search this area" affordance, centered near the top of the map.
  searchAreaBtn: {
    position: "absolute",
    top: 12,
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 5,
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 14px",
    fontFamily: FONT_BODY,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase" as const,
    color: VAR_ON_STRUCTURE,
    background: VAR_ACCENT_HARD,
    border: `2px solid ${VAR_ACCENT_HARD}`,
    borderRadius: 0,
    cursor: "pointer",
    boxShadow: "0 2px 8px rgba(33,28,22,0.28)",
  } satisfies CSSProperties,

  // Brief post-click flash on the list card whose pin was clicked.
  cardFlash: {
    outline: `2px solid ${VAR_ACCENT_HARD}`,
    outlineOffset: -2,
    background: MUTED,
  } satisfies CSSProperties,

  // ── Mobile full-bleed map view ───────────────────────────────────────
  mobileMapWrap: {
    position: "relative",
    width: "100%",
    height: "calc(100vh - 240px)",
    minHeight: 420,
    border: `2px solid ${VAR_BORDER}`,
    overflow: "hidden",
  } satisfies CSSProperties,

  // Bottom card surfaced on pin tap — the app's card language (hard ink edge).
  mobileMapCard: {
    position: "absolute",
    left: 12,
    right: 12,
    bottom: 12,
    zIndex: 6,
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    padding: 14,
    background: "var(--background, #FDFAF3)",
    border: `2px solid ${VAR_BORDER}`,
    boxShadow: "0 4px 16px rgba(33,28,22,0.28)",
  } satisfies CSSProperties,
  mobileMapCardBody: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    flex: 1,
    minWidth: 0,
  } satisfies CSSProperties,
  mobileMapCardTitle: {
    fontFamily: FONT_BODY,
    fontSize: 14,
    fontWeight: 700,
    letterSpacing: "0.01em",
    color: VAR_INK,
    margin: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  } satisfies CSSProperties,
  mobileMapCardVenue: {
    fontFamily: FONT_BODY,
    fontSize: 12,
    fontWeight: 600,
    color: VAR_MUTED,
    margin: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  } satisfies CSSProperties,
  mobileMapCardLink: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    marginTop: 4,
    fontFamily: FONT_BODY,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase" as const,
    color: VAR_ACCENT_HARD,
    textDecoration: "none",
  } satisfies CSSProperties,
  mobileMapCardClose: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 28,
    height: 28,
    background: "none",
    border: `1px solid ${VAR_BORDER}`,
    borderRadius: 0,
    color: VAR_MUTED,
    cursor: "pointer",
  } satisfies CSSProperties,
} as const;

/**
 * Layout styles for the restructured shell. Kept out of `s` on purpose: that
 * object is the page's legacy inline-CSS grab-bag and is being shrunk, not
 * grown. New structure goes here; new *content* styling should reach for a
 * `@th/ui` primitive instead of either object.
 */
const layout = {
  // ── Shell: persistent facet rail (desktop) + results column ─────────
  // GRID would be wrong here: nothing has to align across rows, and the rail
  // is a fixed-width sibling of a fluid column. Flex, per the v2 rule.
  shell: {
    display: "flex",
    flexDirection: "row",
    flexWrap: "wrap" as const,
    gap: 24,
    alignItems: "flex-start",
    width: "100%",
  } satisfies CSSProperties,

  // Everything right of the rail: toolbar, active-filter chips, results, map.
  //
  // `minWidth: 0`, NOT RESULTS_MIN_WIDTH. This column renders at every tier,
  // including the sheet tier on a 320px phone, where the shell's content box is
  // ~256–288px after gutters. A 380px floor here cannot be rescued by
  // `flexWrap` — wrapping moves items onto new lines, it never shrinks one
  // below its own min-width, and below the rail breakpoint this is the only
  // child so there is nothing to wrap against. The floor would simply overflow
  // the page sideways. RESULTS_MIN_WIDTH belongs ONLY to the two panes inside
  // `s.body`, which exist solely at >= MAP_PANE_MIN_VIEWPORT where the width
  // budget already clears it.
  main: {
    display: "flex",
    flexDirection: "column",
    gap: 24,
    flex: "1 1 0",
    minWidth: 0,
  } satisfies CSSProperties,

  // Result count + sort (+ the mobile Filters trigger). Wraps rather than
  // overflowing — at 320px the count and the sort select stack.
  toolbar: {
    display: "flex",
    flexWrap: "wrap" as const,
    alignItems: "center",
    gap: 12,
    borderBottom: `2px solid ${VAR_BORDER}`,
    paddingBottom: 12,
  } satisfies CSSProperties,

  // Pushes the sort control to the trailing edge without a margin between
  // siblings (auto-margin pinning is the sanctioned exception).
  toolbarSpacer: {
    marginLeft: "auto",
  } satisfies CSSProperties,

  // "You have edits the results do not reflect yet." A dot, not a label:
  // accent is a graphic value here, well inside the 3:1 non-text floor and
  // nowhere near the 5%-of-viewport budget.
  pendingDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
    backgroundColor: ACCENT,
    flexShrink: 0,
  } satisfies CSSProperties,

  // The search input keeps a reading width even when the shell grows to fit
  // rail + list + map, so it never stretches to 1400px of empty field.
  searchBar: {
    width: "100%",
    maxWidth: 720,
  } satisfies CSSProperties,
} as const;

// ── Hover/focus helper (avoids inline handler duplication) ───────────────────
// Shared by mouse AND keyboard-focus handlers so the row highlight has
// focus parity with hover (design-system v2 accessibility rule).

function applyHover(e: React.SyntheticEvent<Element>, on: boolean) {
  // MUTED is already `var(--surfaceMuted, #EFE7D6)`; the old wrapper's #F5F5F5 fallback was a cool
  // grey standing in for a warm-paper token.
  (e.currentTarget as HTMLElement).style.backgroundColor = on
    ? MUTED
    : "transparent";
}

// ── Avatar helpers ───────────────────────────────────────────────────────────
// The unified search payload doesn't include image URLs for people / orgs,
// so we synthesize a colored disc with the entity's initials. Keeps the row
// recognisable at a glance without an extra round-trip per result.

function getInitials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

// Deterministic color per name so the same person/org always draws the same
// disc — small consistency cue when scanning long lists.
const AVATAR_COLORS = [
  "#35589A",
  "#7A5AF8",
  "#1F8B6B",
  "#B8541E",
  "#A02D6E",
  "#266D8B",
  "#7C5A24",
  "#2B6F47",
];
function avatarColor(seed: string | null | undefined): string {
  if (!seed) return AVATAR_COLORS[0]!;
  let hash = 0;
  for (let i = 0; i < seed.length; i++)
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]!;
}

// ── Pagination controls ──────────────────────────────────────────────────────
// Per-section prev/next + "Page X of Y". Used inside each result section so
// 50 events don't drown out the 3 places the user actually wants. Hidden
// when totalPages <= 1 — no chrome when there's nothing to navigate.

function Pagination({
  page,
  totalPages,
  onChange,
  pageSize,
  pageSizeOptions,
  onPageSizeChange,
  testId,
}: {
  page: number;
  totalPages: number;
  onChange: (next: number) => void;
  /** Optional — when provided, renders a "Per page" selector alongside the
   * prev/next controls so the user can widen or narrow the results window
   * without diving into a separate filter panel. */
  pageSize?: number;
  pageSizeOptions?: readonly number[];
  onPageSizeChange?: (size: number) => void;
  testId?: string;
}) {
  // Hide entirely when there's nothing to navigate AND no page-size knob.
  // The page-size selector alone is still useful (lets the user pre-set the
  // window size), so don't bail when only totalPages === 1.
  if (totalPages <= 1 && pageSize === undefined) return null;
  const btnBase: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    padding: "6px 10px",
    fontFamily: FONT_BODY,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: VAR_INK,
    background: "transparent",
    border: `1px solid ${VAR_BORDER}`,
    cursor: "pointer",
  };
  const btnDisabled: CSSProperties = {
    opacity: 0.35,
    cursor: "not-allowed",
  };
  const goPrev = () => onChange(Math.max(1, page - 1));
  const goNext = () => onChange(Math.min(totalPages, page + 1));
  const labelStyle: CSSProperties = {
    fontFamily: FONT_BODY,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: VAR_MUTED,
  };
  return (
    <div
      data-testid={testId}
      style={{
        display: "flex",
        justifyContent: "flex-end",
        alignItems: "center",
        gap: 8,
        padding: "8px 0 0",
        flexWrap: "wrap",
      }}
    >
      {pageSize !== undefined && pageSizeOptions && onPageSizeChange && (
        <label
          style={{
            ...labelStyle,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          Per page
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            data-testid={testId ? `${testId}-page-size` : undefined}
            style={{
              fontFamily: FONT_BODY,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              padding: "4px 8px",
              background: "transparent",
              color: VAR_INK,
              border: `1px solid ${VAR_BORDER}`,
              cursor: "pointer",
            }}
          >
            {pageSizeOptions.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      )}
      {totalPages > 1 && (
        <>
          <span style={labelStyle}>
            Page {page} of {totalPages}
          </span>
          <button
            type="button"
            aria-label="Previous page"
            disabled={page <= 1}
            onClick={goPrev}
            style={{ ...btnBase, ...(page <= 1 ? btnDisabled : null) }}
          >
            <ChevronLeft size={12} />
            Prev
          </button>
          <button
            type="button"
            aria-label="Next page"
            disabled={page >= totalPages}
            onClick={goNext}
            style={{ ...btnBase, ...(page >= totalPages ? btnDisabled : null) }}
          >
            Next
            <ChevronRight size={12} />
          </button>
        </>
      )}
    </div>
  );
}

// ── Component ────────────────────────────────────────────────────────────────

export function UniversalSearchPage({
  initialQuery,
  initialNearMe = false,
  initialRadiusKm,
  initialGeoLocation = null,
  initialSort,
  initialCategories,
  initialScope,
}: UniversalSearchPageProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const t = useTranslations();
  // Result-row prices in the viewer's language ("Gratis", "Paga lo que quieras").
  const priceWords = useListingPriceWords();
  const [imperial] = useImperial();
  const isMobile = useIsMobile();

  // ── What fits ────────────────────────────────────────────────────────
  // Three layouts, chosen by MEASURED width rather than hoped-for width. The
  // panes drop as the window narrows; they never compress into each other.
  //
  //   ≥1200  rail · results · sticky map pane
  //   ≥960   rail · results          (map moves to the List/Map toggle)
  //   <960   sheet · results         (rail moves to the bottom sheet)
  //
  // Both hooks assume desktop before `matchMedia` reports, matching every
  // other viewport hook in the app, so the common case does not reflow.
  // Declared up here because the apply model reads `showRail` — instant on the
  // rail, draft-and-commit in the sheet — long before the map derivations.
  const hasRailRoom = useMinViewportWidth(RAIL_MIN_VIEWPORT);
  const hasMapPaneRoom = useMinViewportWidth(MAP_PANE_MIN_VIEWPORT);

  /** The rail viewport; everything narrower puts the facets in a bottom sheet. */
  const showRail = hasRailRoom;

  // ── Bidirectional URL sync: single-writer bookkeeping ────────────────
  // `lastSyncedRef` holds the querystring the component itself is
  // responsible for — set both when the OUTBOUND effect writes the URL and
  // when the INBOUND effect reconciles state from an external URL change
  // (popstate / shared link). It is the one guard that distinguishes
  // "the URL changed because of us" (skip) from "the URL changed under us"
  // (reconcile). Seeded to the mount querystring so mount is a no-op.
  const searchParamsString = searchParams?.toString() ?? "";
  const lastSyncedRef = useRef<string>(searchParamsString);
  // Latest querystring, readable inside the outbound effect WITHOUT making
  // `searchParams` an outbound dependency (which would let an inbound
  // navigation retrigger the outbound writer and fight Back/Forward).
  const searchParamsStringRef = useRef(searchParamsString);
  searchParamsStringRef.current = searchParamsString;

  // ── Shared search query (synced with spotlight store) ───────────────
  const storeQuery = useContextQuery("consumer");
  const [searchValue, setSearchValueLocal] = useState(
    initialQuery || storeQuery,
  );
  const trimmedQuery = searchValue.trim();
  const hasQueryInput = trimmedQuery.length > 0;
  const hasTextQuery = trimmedQuery.length >= MIN_QUERY_LENGTH;

  // ── Debounced query (fires tRPC 700ms after typing stops) ────────
  // Matches the Spotlight palette so the perceived feel is consistent
  // across the two surfaces.
  const [debouncedQuery, setDebouncedQuery] = useState(trimmedQuery);
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(trimmedQuery), 700);
    return () => clearTimeout(id);
  }, [trimmedQuery]);
  const hasDebouncedQuery = debouncedQuery.length >= MIN_QUERY_LENGTH;
  const hasSettledDebouncedQuery =
    hasDebouncedQuery && debouncedQuery === trimmedQuery;
  // The /search page also runs the query when there's no text — that's
  // the "browse all events" landing experience. The unified-search
  // backend allows empty queries and returns the filter-matching set.
  const shouldFetchResults = hasDebouncedQuery || trimmedQuery.length === 0;
  // True from the first keystroke until the debounce settles. Drives the
  // skeleton loader so feedback is instantaneous instead of waiting on the
  // 700ms debounce + fetch round-trip.
  const isTyping = trimmedQuery.length > 0 && trimmedQuery !== debouncedQuery;

  // Two-way sync: update the spotlight store whenever the user types.
  const setSearchValue = useCallback((value: string) => {
    setSearchValueLocal(value);
    const trimmed = value.trim();
    if (trimmed.length > 0) setContextQuery("consumer", trimmed);
  }, []);

  // Sync from store → local when spotlight updates the consumer query externally
  // (e.g. user searched via ⌘+K and hit Enter to land here).
  useEffect(() => {
    if (storeQuery && storeQuery !== searchValue.trim()) {
      setSearchValueLocal(storeQuery);
    }
    // Only react to storeQuery changes, not searchValue (avoid loops)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeQuery]);

  // ── Geo state ───────────────────────────────────────────────────────
  const [geoLocation, setGeoLocation] = useState<GeoLocation | null>(
    initialGeoLocation,
  );
  const [radiusKm, setRadiusKm] = useState<number>(
    initialRadiusKm &&
      initialRadiusKm >= RADIUS_MIN_KM &&
      initialRadiusKm <= SLIDER_MAX_KM
      ? initialRadiusKm
      : DEFAULT_RADIUS_KM,
  );
  const [locationQuery, setLocationQuery] = useState(
    initialGeoLocation?.label ?? "",
  );
  const [showLocationInput, setShowLocationInput] = useState(
    initialNearMe || !!initialGeoLocation,
  );
  const [pendingBrowserLocation, setPendingBrowserLocation] =
    useState(initialNearMe);

  // Committed radius — what the query/URL actually use. The slider can fire
  // onValueChange dozens of times during a single drag, and each change
  // re-keys the query (which clears accumulated results + fires a fresh tRPC
  // fetch), so slider-driven changes settle for 250ms before committing.
  const [committedRadiusKm, setCommittedRadiusKm] = useState(radiusKm);
  useEffect(() => {
    const id = setTimeout(() => setCommittedRadiusKm(radiusKm), 250);
    return () => clearTimeout(id);
  }, [radiusKm]);
  // Instant commit — for discrete actions that change center AND radius as
  // one gesture ("search this area", inbound URL reconcile). Letting those
  // ride the debounce fires one query with the new center but the stale
  // radius, flashing wrong results (and, pre-fix, unmounting the map).
  const setRadiusKmNow = useCallback((km: number) => {
    setRadiusKm(km);
    setCommittedRadiusKm(km);
  }, []);
  const committedIsWorldwide = isWorldwideRadius(committedRadiusKm);

  const {
    coords,
    loading: locationLoading,
    error: locationError,
    request: requestLocation,
  } = useUserLocation();

  // When the page loads with `?near=1`, kick off the geolocation prompt
  // so the user actually sees a "Use my location" flow instead of just
  // an opaque empty state.
  useEffect(() => {
    if (!pendingBrowserLocation) return;
    if (coords || locationLoading || locationError) return;
    requestLocation();
  }, [
    pendingBrowserLocation,
    coords,
    locationLoading,
    locationError,
    requestLocation,
  ]);

  // Auto-set location when browser coords resolve
  useEffect(() => {
    if (locationLoading || !coords) return;
    if (pendingBrowserLocation && showLocationInput && !geoLocation) {
      setGeoLocation({
        lat: coords.lat,
        lng: coords.lng,
        label: String(t("search.myLocation")),
      });
      setPendingBrowserLocation(false);
    }
  }, [
    coords,
    locationLoading,
    pendingBrowserLocation,
    showLocationInput,
    geoLocation,
    t,
  ]);

  const radiusDisplayLabel = useMemo(
    () => formatRadiusLabel(radiusKm, { imperial, t }),
    [radiusKm, imperial, t],
  );

  // Slider widget presents unit-appropriate stops (mi grid for imperial); state
  // stays canonical km (and so does the URL param / geoFilter). When the unit
  // flips (async auto-detect or a manual toggle elsewhere) snap the current km
  // onto the new unit's grid. Ref-guarded so it never runs on mount (won't
  // stomp a URL-provided ?radius=) or loop.
  const prevImperial = useRef(imperial);
  useEffect(() => {
    if (prevImperial.current === imperial) return;
    prevImperial.current = imperial;
    setRadiusKm((km) => normalizeRadiusForUnit(km, imperial));
  }, [imperial]);

  const sliderConfig = radiusSliderConfig(imperial);

  const geoFilter = useMemo(() => {
    if (!geoLocation) return undefined;
    // "Worldwide" means all events globally — drop the geo filter entirely
    // rather than sending a fake radius (which the schema rejects and which is
    // semantically wrong anyway). Every other value is a real distance (5–500).
    if (committedIsWorldwide) return undefined;
    return {
      lat: geoLocation.lat,
      lng: geoLocation.lng,
      radiusKm: committedRadiusKm,
    };
  }, [geoLocation, committedRadiusKm, committedIsWorldwide]);

  // `canSearch` gates the events results UI. With the new "browse all"
  // path, we also want to render results when the user has *no* query —
  // empty query is a legitimate browse intent, not just a noop. We still
  // hide the events list when the user is mid-typing a 1-char query
  // (waiting for the 2-char minimum to feel typeahead-y).
  const canSearch = hasTextQuery || trimmedQuery.length === 0;

  // ── Sort & panel state (events section only) ─────────────────────────
  // Default sort: when caller passed a specific sort (e.g. "popularity" from
  // the home "View all popular events" link), honor it; otherwise default
  // to "date_asc" when there's no text query (so /search renders all
  // upcoming events soonest-first), or "relevance" when the user is
  // actively searching.
  const [sortBy, setSortBy] = useState<SortOption>(
    initialSort ??
      (initialQuery.trim().length >= MIN_QUERY_LENGTH
        ? "relevance"
        : "date_asc"),
  );
  // ── Mobile filters sheet ─────────────────────────────────────────────
  // Mobile-only. Desktop has no toggle at all: the facet rail is persistent,
  // which is the whole point of the rail. `sheetRef` scopes the focus trap;
  // `sheetWasOpenRef` is how focus gets handed back to the trigger on close
  // without also firing on the initial (closed) render.
  const [filtersSheetOpen, setFiltersSheetOpen] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const sheetWasOpenRef = useRef(false);

  // ── Search scope ─────────────────────────────────────────────────────
  // Mirrors the spotlight's type-pill UX: lets the user explicitly narrow
  // the *query* (not just the post-fetch tab view) to a single entity
  // type. When set, we pass `types: [scope]` to the unified search so
  // the API doesn't bother computing the other buckets. Seeded from the URL
  // (`?type=`) so deep links can land pre-scoped.
  const [searchScope, setSearchScope] = useState<SearchScope>(
    initialScope ?? "all",
  );

  // Whether event-only filters (category, date, price) are relevant for the
  // current scope. When the user has narrowed to people / orgs / places, the
  // event configurator is meaningless and its filters must not be sent.
  const eventsInScope = searchScope === "all" || searchScope === "event";

  // Which sort options this scope + location state can honour. Distance is
  // hidden without a coordinate (the adapters silently degrade it to date
  // order), and a non-event scope has nothing but relevance to offer.
  const offeredSorts = useMemo(
    () => availableSorts(searchScope, geoLocation !== null),
    [searchScope, geoLocation],
  );

  // ── Results map interaction state (desktop) ──────────────────────────
  // `highlightedId` syncs list-card hover → pin highlight. `flashCardId`
  // flashes the list card whose pin was clicked. `pendingArea` holds the
  // last USER-driven map viewport so we can offer "Search this area".
  // TODO(perf): hover setHighlightedId re-renders the full page (up to
  // `resultsPerPage` rows). Only the map consumes `highlightedId`; isolate
  // it into a memoized map-pane child (or a ref/emitter) so hover doesn't
  // reconcile the list. Deferred — a clean isolation is a moderate refactor
  // of the row + save-heart overlay; stability first.
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [flashCardId, setFlashCardId] = useState<string | null>(null);
  const [pendingArea, setPendingArea] = useState<{
    center: { lat: number; lng: number };
    radiusKm: number;
  } | null>(null);
  // Mobile-only: list vs. full-bleed map view, and the pin whose bottom card
  // is currently open. Desktop ignores both (it uses the sticky map pane).
  const [mobileView, setMobileView] = useState<"list" | "map">("list");
  const [selectedMapEventId, setSelectedMapEventId] = useState<string | null>(
    null,
  );

  // Stable DOM anchors for each rendered event card so a pin click can scroll
  // the matching card into view.
  // Keyed by map-item key (`event:<id>` / `venue:<id>`).
  const cardRefs = useRef<Map<string, HTMLElement>>(new Map());
  const registerCardRef = useCallback(
    (key: string, el: HTMLElement | null) => {
      if (el) cardRefs.current.set(key, el);
      else cardRefs.current.delete(key);
    },
    [],
  );
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
    },
    [],
  );

  // ── Per-section pagination ───────────────────────────────────────────
  // Each result bucket pages independently so 50 events don't drown out
  // the 3 places the user actually wants to scan. Reset to page 1 any
  // time the committed query / tab changes — keeps users from landing on
  // page 4 of yesterday's results.
  const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;
  const [resultsPerPage, setResultsPerPage] = useState<number>(20);
  const [eventsPage, setEventsPage] = useState(1);
  const [peoplePage, setPeoplePage] = useState(1);
  const [orgsPage, setOrgsPage] = useState(1);
  const [placesPage, setPlacesPage] = useState(1);

  // ── Event filter state ──────────────────────────────────────────────
  // Categories are multi-select — the API accepts an array of tag slugs and
  // OR's them together. Tokens (chips) imply this UX, and forcing a single
  // pick made discoverability worse for buyers who want "music OR comedy".
  // Seeded from the URL (`?category=music,comedy`). The `applied` snapshot
  // below is initialised from this same state value, so a deep-linked
  // category filters results on first load — not just the draft.
  const [selectedCategories, setSelectedCategories] = useState<string[]>(
    initialCategories ?? [],
  );
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [freeOnly, setFreeOnly] = useState(false);
  // Price range — buyer-facing all-in dollars. Empty string means unbounded
  // on that side. Plumbed into the search call as `priceRange.minCents` /
  // `maxCents` (* 100). Disabled while `freeOnly` is on since it's
  // contradictory.
  const [priceMin, setPriceMin] = useState("");
  const [priceMax, setPriceMax] = useState("");

  // ── Applied filters ──────────────────────────────────────────────────
  // `applied` is the COMMITTED snapshot: the tRPC query, the request key and
  // the outbound URL writer all read it, never the draft. What differs by
  // viewport is only how fast a draft becomes an applied value.
  //
  //  • Desktop — a facet edit commits immediately (see the auto-commit effect
  //    below). Instant feedback is the entire reason a persistent rail is
  //    worth its width; an Apply button next to an always-visible rail is a
  //    second click for nothing.
  //  • Mobile — edits stay drafts inside the bottom sheet until its commit
  //    button, because the sheet covers the list the edit would change.
  //
  // The sort control commits on both (it lives in the toolbar, not the sheet),
  // and geo/radius never entered this snapshot at all — they have their own
  // commit paths.
  type AppliedFilters = {
    sortBy: SortOption;
    selectedCategories: string[];
    dateFrom: string;
    dateTo: string;
    freeOnly: boolean;
    priceMin: string;
    priceMax: string;
  };
  const initialApplied: AppliedFilters = {
    sortBy,
    selectedCategories,
    dateFrom,
    dateTo,
    freeOnly,
    priceMin,
    priceMax,
  };
  const [applied, setApplied] = useState<AppliedFilters>(initialApplied);

  /**
   * Selecting a sort ALSO sets the scope when the sort is event-only.
   *
   * Every non-relevance mode orders on an event column, so a mixed-type result
   * set would not interleave — venues and artists would all sink below the
   * events. The transport enforces this server-side (`scopeSortToEvents`);
   * moving the scope chip here keeps the UI honest about what the server is
   * going to do rather than showing "All" beside date-ordered event results.
   *
   * Sort commits on the spot on BOTH viewports. It lives in the results
   * toolbar, not in the mobile filter sheet, so there is no draft surface it
   * could be pending inside — a sort control that visibly changed but left the
   * list in the old order would be a bug, not a draft.
   */
  const handleSelectSort = useCallback((next: SortId) => {
    setSortBy(next);
    setApplied((prev) =>
      prev.sortBy === next ? prev : { ...prev, sortBy: next },
    );
    setSearchScope((scope) => scopeForSort(next, scope));
  }, []);

  /**
   * Drop a sort that the current scope + location can no longer honour.
   *
   * Two ways in: the user clears their location while sorted by Nearest, or
   * they switch the scope chip to Places while sorted by price. Leaving the
   * stale value selected would label the results with an ordering the server
   * is not applying. Both the draft and the committed value are reset, so the
   * panel and the results agree.
   */
  useEffect(() => {
    const hasGeo = geoLocation !== null;
    setSortBy((current) => reconcileSort(current, searchScope, hasGeo));
    setApplied((current) => {
      const next = reconcileSort(current.sortBy, searchScope, hasGeo);
      return next === current.sortBy ? current : { ...current, sortBy: next };
    });
  }, [searchScope, geoLocation]);

  /** The draft the facet rail / sheet renders and edits. */
  const facetDraft = useMemo<FacetDraft>(
    () => ({
      categories: selectedCategories,
      dateFrom,
      dateTo,
      freeOnly,
      priceMin,
      priceMax,
    }),
    [selectedCategories, dateFrom, dateTo, freeOnly, priceMin, priceMax],
  );

  /** One patch handler for every facet — the rail reports partial edits. */
  const handleFacetChange = useCallback((patch: Partial<FacetDraft>) => {
    if (patch.categories !== undefined) setSelectedCategories(patch.categories);
    if (patch.dateFrom !== undefined) setDateFrom(patch.dateFrom);
    if (patch.dateTo !== undefined) setDateTo(patch.dateTo);
    if (patch.freeOnly !== undefined) setFreeOnly(patch.freeOnly);
    if (patch.priceMin !== undefined) setPriceMin(patch.priceMin);
    if (patch.priceMax !== undefined) setPriceMax(patch.priceMax);
  }, []);

  /**
   * What kind of difference is pending between the draft and `applied`.
   *
   * The comparison itself lives in ./search-facet-apply, pure and unit-tested
   * — including the order-insensitive category compare, without which
   * unticking and re-ticking a category leaves a "pending change" that never
   * settles. `sortBy` is deliberately NOT a term: `handleSelectSort` writes
   * the draft and the snapshot in one go, so it can never be pending.
   */
  const facetDiff = useMemo(
    () =>
      facetDiffKind(facetDraft, {
        categories: applied.selectedCategories,
        dateFrom: applied.dateFrom,
        dateTo: applied.dateTo,
        freeOnly: applied.freeOnly,
        priceMin: applied.priceMin,
        priceMax: applied.priceMax,
      }),
    [facetDraft, applied],
  );
  const hasUnappliedChanges = facetDiff !== "none";

  /**
   * Commit the draft.
   *
   * The `facetDiff` guard is not an optimisation. `applied`'s OBJECT IDENTITY
   * keys the effect that resets pagination, so reallocating it for an
   * unchanged draft silently throws away every accumulated Load-more page —
   * which is exactly what "open the sheet, change nothing, press Show results"
   * used to do.
   */
  const handleApplyFilters = useCallback(() => {
    if (facetDiff === "none") return;
    setApplied({
      sortBy,
      selectedCategories,
      dateFrom,
      dateTo,
      freeOnly,
      priceMin,
      priceMax,
    });
  }, [
    facetDiff,
    sortBy,
    selectedCategories,
    dateFrom,
    dateTo,
    freeOnly,
    priceMin,
    priceMax,
  ]);

  /**
   * Clear every facet — the mobile sheet's secondary action.
   *
   * Clears the DRAFT and the SNAPSHOT together, so it is decisive at any
   * moment rather than a revert that is greyed out precisely when a reader
   * with three active filters reaches for it. Geo is not touched: it has its
   * own Clear inside the Distance facet and its own chip in the filter row.
   */
  const clearFacets = useCallback(() => {
    setSelectedCategories([]);
    setDateFrom("");
    setDateTo("");
    setFreeOnly(false);
    setPriceMin("");
    setPriceMax("");
    setApplied((prev) =>
      prev.selectedCategories.length === 0 &&
      prev.dateFrom === "" &&
      prev.dateTo === "" &&
      !prev.freeOnly &&
      prev.priceMin === "" &&
      prev.priceMax === ""
        ? prev
        : {
            ...prev,
            selectedCategories: [],
            dateFrom: "",
            dateTo: "",
            freeOnly: false,
            priceMin: "",
            priceMax: "",
          },
    );
  }, []);

  /** Nothing left for Clear to do — gates the sheet's secondary button. */
  const facetsAllClear = facetsAreEmpty(facetDraft) && facetsAreEmpty({
    categories: applied.selectedCategories,
    dateFrom: applied.dateFrom,
    dateTo: applied.dateTo,
    freeOnly: applied.freeOnly,
    priceMin: applied.priceMin,
    priceMax: applied.priceMax,
  });

  /**
   * DESKTOP INSTANT APPLY.
   *
   * A discrete edit (a category checkbox, a date preset, the free toggle)
   * commits on the spot. A continuous one — only the price bounds moved —
   * settles first: `handleApplyFilters` changes identity on every keystroke,
   * so each character restarts the timer instead of queueing a request.
   * Once it commits, `facetDiff` goes to "none" and the effect re-runs into
   * its own early return; no loop.
   *
   * Only the rail viewport runs this. Below RAIL_MIN_VIEWPORT the draft
   * belongs to the sheet and its commit button.
   */
  useEffect(() => {
    if (!showRail) return;
    if (facetDiff === "none") return;
    if (facetDiff === "discrete") {
      handleApplyFilters();
      return;
    }
    const id = setTimeout(handleApplyFilters, PRICE_COMMIT_DELAY_MS);
    return () => clearTimeout(id);
  }, [showRail, facetDiff, handleApplyFilters]);

  // ── Categories query (public, cached) ──────────────────────────────
  const locale = useLocale();
  const categoriesQuery = trpc.categories.list.useQuery(undefined, {
    staleTime: 5 * 60_000,
  });
  // Names in the viewer's language for the facet and the applied chips; the
  // filter itself travels by slug.
  const categories = useMemo(
    () =>
      withCategoryDisplayNames(categoriesQuery.data?.categories ?? [], locale),
    [categoriesQuery.data, locale],
  );
  // The applied categories the page SHOWS (chips, filter count). Once the
  // active list has loaded, a slug that is not in it (unknown, deleted or
  // inactive) is left out: the server drops it from the search too, so a chip
  // for it would name a filter that is not applied. This covers the frames
  // between the list loading and the prune below taking the slug out of state.
  const shownAppliedCategories = useMemo(
    () =>
      shownCategorySlugs(
        applied.selectedCategories,
        categoriesQuery.data
          ? categoriesQuery.data.categories.map((c) => c.slug)
          : null,
      ),
    [applied.selectedCategories, categoriesQuery.data],
  );

  // ── Prune categories that are no longer available ───────────────────
  // A bookmarked `?category=` can name a category that has since been switched
  // off or deleted. The server already ignores it; here the slug is taken out
  // of the draft and the applied snapshot, so the outbound URL sync rewrites
  // the address without it (a category-only diff, hence a `replace`) and the
  // reader is told why the filter is gone.
  //
  // Only a list the server RETURNED prunes anything: `null` while it loads and
  // after a failed request, so neither strips a valid category.
  const prunableCategorySlugs = useMemo(
    () =>
      categoriesQuery.isSuccess
        ? categoriesQuery.data.categories.map((c) => c.slug)
        : null,
    [categoriesQuery.isSuccess, categoriesQuery.data],
  );
  /**
   * The notice a prune left behind, with the filter state it was shown for.
   * Any later change to that state (a tick, a typed query, Clear all, a Back
   * navigation that brings other categories) retires it.
   *
   * Location and sort are deliberately not part of the signature: both can
   * settle on their own after mount (`?near=me` resolving, the sort reconcile
   * that follows it), and that would take the notice away before it was read.
   */
  const [unavailableCategoryNotice, setUnavailableCategoryNotice] = useState<{
    kind: UnavailableCategoryNoticeKind;
    signature: string;
  } | null>(null);
  const noticeSignatureFor = useCallback(
    (draftCategories: readonly string[], appliedCategories: readonly string[]) =>
      JSON.stringify([
        searchValue,
        searchScope,
        draftCategories,
        appliedCategories,
        dateFrom,
        dateTo,
        freeOnly,
        priceMin,
        priceMax,
      ]),
    [searchValue, searchScope, dateFrom, dateTo, freeOnly, priceMin, priceMax],
  );
  const noticeSignature = noticeSignatureFor(
    selectedCategories,
    applied.selectedCategories,
  );
  useEffect(() => {
    const draftPrune = pruneCategorySelection(
      selectedCategories,
      prunableCategorySlugs,
    );
    const appliedPrune = pruneCategorySelection(
      applied.selectedCategories,
      prunableCategorySlugs,
    );
    if (!draftPrune && !appliedPrune) {
      // Nothing to prune, which is also where this effect lands on the render
      // after it pruned: no loop. Retire a notice the reader has moved on from.
      setUnavailableCategoryNotice((current) =>
        current && current.signature !== noticeSignature ? null : current,
      );
      return;
    }
    const keptDraft = draftPrune ? draftPrune.kept : selectedCategories;
    const keptApplied = appliedPrune
      ? appliedPrune.kept
      : applied.selectedCategories;
    if (draftPrune) setSelectedCategories(keptDraft);
    if (appliedPrune) {
      setApplied((prev) => ({ ...prev, selectedCategories: keptApplied }));
    }
    setUnavailableCategoryNotice({
      kind: unavailableCategoryNoticeKind(keptApplied),
      signature: noticeSignatureFor(keptDraft, keptApplied),
    });
  }, [
    selectedCategories,
    applied.selectedCategories,
    prunableCategorySlugs,
    noticeSignature,
    noticeSignatureFor,
  ]);
  // Compared at render as well, so the notice is gone in the same frame as the
  // edit that retires it instead of one effect later.
  const shownUnavailableCategoryNotice =
    unavailableCategoryNotice?.signature === noticeSignature
      ? unavailableCategoryNotice.kind
      : null;

  /** Number of active panel filters (category, date, free) — excludes geo.
   * Counts the *applied* set so the chip badge reflects what the result
   * list is actually showing, not what the user is mid-typing. */
  const panelFilterCount = useMemo(() => {
    let c = 0;
    if (shownAppliedCategories.length > 0) c += 1;
    if (applied.dateFrom || applied.dateTo) c += 1;
    if (applied.freeOnly) c += 1;
    if (
      !applied.freeOnly &&
      (applied.priceMin !== "" || applied.priceMax !== "")
    )
      c += 1;
    return c;
  }, [applied, shownAppliedCategories]);

  // Every active-filter chip removes itself from BOTH the draft and the
  // applied snapshot, so an X takes effect on the spot on either viewport —
  // a chip that needed a second Apply press would be a chip that lied.
  // (These never TOGGLE: toggling could re-ADD a value the reader had already
  // un-checked in an uncommitted mobile draft.)

  const removeAppliedCategory = useCallback((slug: string) => {
    setSelectedCategories((prev) => prev.filter((c) => c !== slug));
    setApplied((prev) => ({
      ...prev,
      selectedCategories: prev.selectedCategories.filter((c) => c !== slug),
    }));
  }, []);

  const removeAppliedDateRange = useCallback(() => {
    setDateFrom("");
    setDateTo("");
    setApplied((prev) => ({ ...prev, dateFrom: "", dateTo: "" }));
  }, []);

  const removeAppliedFreeOnly = useCallback(() => {
    setFreeOnly(false);
    setApplied((prev) => ({ ...prev, freeOnly: false }));
  }, []);

  const removeAppliedPriceRange = useCallback(() => {
    setPriceMin("");
    setPriceMax("");
    setApplied((prev) => ({ ...prev, priceMin: "", priceMax: "" }));
  }, []);

  // ── Bidirectional URL sync ───────────────────────────────────────────
  // Two cooperating effects with `lastSyncedRef` as the single-writer guard:
  //
  //  • INBOUND (URL → state): fires when `searchParams` changes. If the new
  //    querystring is one WE wrote (`=== lastSyncedRef.current`) it's a no-op;
  //    otherwise the change came from outside (browser Back/Forward, a pasted
  //    link) so we reconcile local state FROM the URL and adopt it as the
  //    synced value. It never writes the URL, so it can't fight navigation.
  //
  //  • OUTBOUND (state → URL): fires when the owned state changes. It reads
  //    the current querystring from a ref (NOT a dependency) so an inbound
  //    navigation can't retrigger it. It serialises state, preserving `sort`
  //    and any non-owned keys, and writes only when the result differs from
  //    both the live URL and the last value we synced — `push` for discrete
  //    changes, `replace` for continuous typing.
  useEffect(() => {
    const incoming = searchParams?.toString() ?? "";
    if (incoming === lastSyncedRef.current) return;

    // External navigation → reconcile local state from the URL.
    const next = parseSearchParams(searchParams);
    setSearchScope(next.scope);
    setSearchValueLocal(next.query);
    setDebouncedQuery(next.query);
    setSelectedCategories(next.categories);
    setApplied((prev) => ({ ...prev, selectedCategories: next.categories }));
    setGeoLocation(next.geo);
    setRadiusKmNow(next.radiusKm ?? DEFAULT_RADIUS_KM);
    setPendingBrowserLocation(next.nearMe);
    setShowLocationInput(next.nearMe || next.geo !== null);
    setLocationQuery(next.geo?.label ?? "");

    lastSyncedRef.current = incoming;
  }, [searchParams, setRadiusKmNow]);

  useEffect(() => {
    const current = searchParamsStringRef.current;
    const desired = buildSearchQueryString({
      query: debouncedQuery,
      scope: searchScope,
      categories: applied.selectedCategories,
      geo: geoLocation,
      // Committed so a slider drag collapses to its settled value (matches
      // the query, which also reads committedRadiusKm) instead of writing a
      // URL per tick.
      radiusKm: committedRadiusKm,
      nearMe: pendingBrowserLocation,
      preserved: current,
    });

    // URL already reflects intended state (e.g. just after an inbound
    // reconcile, or on mount): adopt it and don't navigate.
    if (desired === current) {
      lastSyncedRef.current = desired;
      return;
    }
    // We already asked the router for this exact querystring.
    if (desired === lastSyncedRef.current) return;

    // `replace` (no history entry) for:
    //  • continuous changes — typing, radius drag;
    //  • CATEGORY-only changes. The rail applies instantly now, with no Apply
    //    button left to coalesce the ticks, so five checkboxes would push five
    //    entries and cost five Back presses to leave /search. Back should mean
    //    "the page before this search"; the filter chips are the in-page undo;
    //  • pure canonicalization of an inbound/mount value we've adopted but not
    //    yet written (`current === lastSyncedRef.current` AND `desired` is
    //    just the normalized form of `current`);
    //  • resolving `?near=1` into coordinates. `near=1` is an intent, not a
    //    destination: pushing the coords URL would leave Back on `?near=1`,
    //    which re-resolves and pushes again, trapping the reader.
    // Everything else is a discrete user action (scope, geo add/clear) → push.
    //
    // A `replace` is written with the native History API, not the router, so
    // it costs no RSC request and no page-level commit (see `writeSearchUrl`).
    // `lastSyncedRef` is set first, so when Next folds the new URL back into
    // `useSearchParams` the inbound effect sees our own value and skips.
    const isNormalizingAdoptedValue =
      current === lastSyncedRef.current &&
      desired === normalizeQueryString(current, DEFAULT_RADIUS_KM);
    const method =
      diffIsContinuousOnly(current, desired) ||
      diffIsCategoryOnly(current, desired) ||
      diffIsNearMeResolution(current, desired) ||
      isNormalizingAdoptedValue
        ? "replace"
        : "push";
    lastSyncedRef.current = desired;
    writeSearchUrl({
      method,
      href: `${pathname}${desired ? `?${desired}` : ""}`,
      router,
      history: window.history,
    });
  }, [
    debouncedQuery,
    searchScope,
    applied.selectedCategories,
    geoLocation,
    committedRadiusKm,
    pendingBrowserLocation,
    pathname,
    router,
  ]);

  // ── tRPC: unified search (all entity types in one call) ────────────
  // Event-specific filters (category, dates, freeOnly) are passed
  // unconditionally — the Meilisearch adapter scopes them to events via
  // `(type != "event" OR ...)` filter clauses.

  // ── Pagination state ────────────────────────────────────────────────
  const [accumulatedSuggestions, setAccumulatedSuggestions] = useState<
    UnifiedSearchSuggestion[]
  >([]);
  const [committedEstimatedTotal, setCommittedEstimatedTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const lastCommittedPageRef = useRef<string | null>(null);
  const pendingOffsetRef = useRef<number | null>(null);
  const previousOffsetRef = useRef(0);

  // Reset accumulated results when query/filters change
  useEffect(() => {
    setAccumulatedSuggestions([]);
    setCommittedEstimatedTotal(0);
    setOffset(0);
    setIsLoadingMore(false);
    lastCommittedPageRef.current = null;
    pendingOffsetRef.current = null;
    previousOffsetRef.current = 0;
  }, [debouncedQuery, applied, searchScope]);

  // Reset when geoFilter values change (geoFilter is a new object every render)
  const geoKey = geoFilter
    ? `${geoFilter.lat},${geoFilter.lng},${geoFilter.radiusKm}`
    : "";
  useEffect(() => {
    setAccumulatedSuggestions([]);
    setCommittedEstimatedTotal(0);
    setOffset(0);
    setIsLoadingMore(false);
    lastCommittedPageRef.current = null;
    pendingOffsetRef.current = null;
    previousOffsetRef.current = 0;
  }, [geoKey]);

  // Identity of the current RESULT SET. Any change resets pagination and the
  // accumulated list. `sortBy` belongs here now that the server does the
  // ordering — without it, changing sort mid-scroll would append freshly
  // re-ordered page-0 rows onto the tail of the old order.
  const requestKey = `${debouncedQuery}|${searchScope}|${applied.selectedCategories.join(",")}|${applied.dateFrom}|${applied.dateTo}|${applied.freeOnly ? "1" : "0"}|${applied.priceMin}-${applied.priceMax}|${geoKey}|${applied.sortBy}`;

  const unifiedQuery = trpc.search.autocomplete.useQuery(
    {
      query: debouncedQuery,
      limit: QUERY_LIMIT,
      offset,
      ...(geoFilter ? { geo: geoFilter } : {}),
      ...(searchScope !== "all" ? { types: [searchScope] } : {}),
      // The ordering now happens in the DATABASE, over the whole result set.
      // It used to be a client-side sort of the ~50 rows already loaded, which
      // made "Price: low to high" mean "cheapest of what is on screen".
      sort: toServerSort(applied.sortBy),
      // Only ever surface directory-listed places. The backend scopes this to
      // `(type != "place" OR listedInDirectory = true)`, so events/people/orgs
      // are unaffected — this applies whether browsing or text-searching.
      listedInDirectoryOnly: true,
      // Event-only filters are meaningless outside the events scope; omitting
      // them keeps the API from filtering people / orgs / places against them.
      // A category goes as `categorySlugs` (gated on the server against the
      // active categories), never as a free-form tag.
      ...categoryFilterInput({
        eventsInScope,
        selectedCategories: applied.selectedCategories,
      }),
      ...(eventsInScope && (applied.dateFrom || applied.dateTo)
        ? {
            // BOTH bounds parse as LOCAL time. A bare `YYYY-MM-DD` is UTC
            // midnight per spec, so `new Date(dateFrom)` on the `from` side
            // paired with an explicit `T23:59:59` on the `to` side put the two
            // ends of one window on different bases — west of Greenwich the
            // lower bound silently slid a day early. The date fields and the
            // presets both produce local calendar dates (see ./search-dates),
            // so local is the basis that matches what the reader picked.
            dateRange: {
              ...(applied.dateFrom
                ? {
                    from: new Date(
                      applied.dateFrom + "T00:00:00",
                    ).toISOString(),
                  }
                : {}),
              ...(applied.dateTo
                ? { to: new Date(applied.dateTo + "T23:59:59").toISOString() }
                : {}),
            },
          }
        : {}),
      ...(eventsInScope && applied.freeOnly ? { freeOnly: true } : {}),
      ...(eventsInScope &&
      !applied.freeOnly &&
      (applied.priceMin !== "" || applied.priceMax !== "")
        ? {
            priceRange: {
              ...(applied.priceMin !== ""
                ? { minCents: Math.round(Number(applied.priceMin) * 100) }
                : {}),
              ...(applied.priceMax !== ""
                ? { maxCents: Math.round(Number(applied.priceMax) * 100) }
                : {}),
            },
          }
        : {}),
    },
    {
      enabled: shouldFetchResults,
      staleTime: 30_000,
      placeholderData: keepPreviousData,
    },
  );

  // Accumulate suggestions when new data arrives
  useEffect(() => {
    if (unifiedQuery.isPlaceholderData) return;
    if (!unifiedQuery.data?.suggestions) return;

    const pageKey = `${requestKey}|${offset}`;
    if (lastCommittedPageRef.current === pageKey) return;

    const newSuggestions = unifiedQuery.data
      .suggestions as UnifiedSearchSuggestion[];
    if (offset === 0) {
      setAccumulatedSuggestions(newSuggestions);
    } else {
      setAccumulatedSuggestions((prev) => {
        const seen = new Set(prev.map((item) => `${item.type}:${item.id}`));
        const appended = newSuggestions.filter((item) => {
          const key = `${item.type}:${item.id}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        return [...prev, ...appended];
      });
    }
    lastCommittedPageRef.current = pageKey;
    setCommittedEstimatedTotal(unifiedQuery.data.estimatedTotalHits ?? 0);
    pendingOffsetRef.current = null;
    setIsLoadingMore(false);
  }, [unifiedQuery.data, unifiedQuery.isPlaceholderData, offset, requestKey]);

  useEffect(() => {
    if (!unifiedQuery.isError || pendingOffsetRef.current === null) return;
    setOffset(previousOffsetRef.current);
    pendingOffsetRef.current = null;
    setIsLoadingMore(false);
  }, [unifiedQuery.isError]);

  const hasMore =
    accumulatedSuggestions.length < committedEstimatedTotal &&
    offset < MAX_QUERY_OFFSET;

  const handleLoadMore = useCallback(() => {
    if (offset >= MAX_QUERY_OFFSET) return;
    const nextOffset = Math.min(offset + QUERY_LIMIT, MAX_QUERY_OFFSET);
    previousOffsetRef.current = offset;
    pendingOffsetRef.current = nextOffset;
    setIsLoadingMore(true);
    setOffset(nextOffset);
  }, [offset]);

  const allSuggestions = accumulatedSuggestions;

  const eventResults = useMemo<EventSearchSuggestion[]>(() => {
    // Render any event-typed suggestions we have. Used to early-return []
    // unless `hasDebouncedQuery` was true; that gating predates the
    // browse-all path and was silently dropping the 50+ events that come
    // back from the empty-query fetch on /search.
    return allSuggestions
      .filter((s) => s.type === "event")
      .map((s) => ({
        eventId: s.eventId ?? s.id,
        title: s.title,
        subtitle: s.subtitle ?? null,
        helper: s.helper ?? null,
        slug: s.slug ?? null,
        badges: [],
        lowestPriceCents: (s as any).lowestPriceCents ?? null,
        lowestBuyerTotalCents: (s as any).lowestBuyerTotalCents ?? null,
        paidTierCount: (s as any).paidTierCount ?? 0,
        hasFreeTier: (s as any).hasFreeTier === true,
        hasPayWhatYouWantTier: (s as any).hasPayWhatYouWantTier === true,
        currency: (s as any).currency ?? null,
        lat: (s as any).lat ?? null,
        lng: (s as any).lng ?? null,
        // How the map may draw that point (pin vs approximate circle).
        locationIsExact:
          (s as { locationIsExact?: boolean }).locationIsExact === true,
        locationRadiusMeters:
          (s as { locationRadiusMeters?: number | null })
            .locationRadiusMeters ?? null,
      }))
      .filter((r) => Boolean(r.eventId && r.title));
  }, [allSuggestions]);

  // ── Event order ───────────────────────────────────────────────────────
  // The server orders the rows (see `sort:` on the query above), so the list
  // arrives already sorted and is passed straight through.
  //
  // This was a client-side `useMemo` that re-sorted the accumulated page
  // window. It could only ever order the rows already fetched, so every mode
  // was wrong past the first page — and it had two bugs of its own: it
  // branched on `applied.sortBy` but compared on the UNCOMMITTED `sortBy`, and
  // `featured` matched no branch, so it fell through to the date comparator
  // and silently rendered as "Date: latest".
  const sortedEvents = eventResults;

  // ── Results map: events AND venues, one map, two layers ─────────────
  // Every coordinate is the server's public projection (redacted at index
  // time); `search-map-items` only decides how to DRAW it — a mark for an
  // exact location, a circle at the published radius for an approximate one,
  // nothing for a hidden one.
  const places = useMemo(
    () => allSuggestions.filter((s) => s.type === "place"),
    [allSuggestions],
  );
  const venuesInScope = searchScope === "all" || searchScope === "place";
  const mapInScope = eventsInScope || searchScope === "place";

  const mapItems = useMemo<SearchMapItem[]>(() => {
    const out: SearchMapItem[] = [];
    if (eventsInScope) {
      for (const e of sortedEvents) {
        const item = toEventMapItem(
          e as unknown as Parameters<typeof toEventMapItem>[0],
        );
        if (item) out.push(item);
      }
    }
    if (venuesInScope) {
      for (const p of places) {
        const item = toVenueMapItem(p as unknown as VenueMapSource);
        if (item) out.push(item);
      }
    }
    return out;
  }, [sortedEvents, places, eventsInScope, venuesInScope]);

  // Venues in the results that keep their location private — left off the
  // map, and counted in the line under it.
  const privateVenueCount = useMemo(
    () =>
      venuesInScope
        ? countPrivateVenues(places as unknown as VenueMapSource[])
        : 0,
    [places, venuesInScope],
  );

  // Legend chips (All scope only — the one scope that draws both layers).
  const [mapLayers, setMapLayers] = useState<Record<SearchMapKind, boolean>>({
    event: true,
    venue: true,
  });
  const showMapLegend = searchScope === "all";
  // A scope with one layer always draws it; the toggles only apply in All.
  // Memoized: the map treats a new object as a layer change (and closes any
  // open popup), so a fresh literal per render would close it on every render.
  const effectiveMapLayers = useMemo(
    () => (showMapLegend ? mapLayers : { event: true, venue: true }),
    [showMapLegend, mapLayers],
  );
  const toggleMapLayer = useCallback((kind: SearchMapKind) => {
    setMapLayers((cur) => ({ ...cur, [kind]: !cur[kind] }));
  }, []);

  const mapLabels = useMemo(
    () => ({
      map: String(t("search.mapLabel")),
      approxArea: String(t("search.mapApproxArea")),
      kickerEvent: String(t("search.mapKickerEvent")),
      kickerVenue: String(t("search.mapKickerVenue")),
      viewEvent: String(t("search.mapViewEvent")),
      viewVenue: String(t("search.mapViewVenue")),
    }),
    [t],
  );

  // Legend chips + the private-venues line, shared by both map mounts. The
  // line yields to the mobile bottom card (they share the map's bottom edge).
  const mapOverlays = (touch: boolean) => (
    <>
      {showMapLegend && (
        <SearchMapLegend
          counts={{ event: sortedEvents.length, venue: places.length }}
          layers={mapLayers}
          onToggle={toggleMapLayer}
          labels={{
            group: String(t("search.mapLayersLabel")),
            event: String(t("search.mapLayerEvents")),
            venue: String(t("search.mapLayerVenues")),
          }}
          touch={touch}
        />
      )}
      {privateVenueCount > 0 &&
        effectiveMapLayers.venue &&
        !(touch && selectedMapEventId) && (
          <SearchMapPrivateNote
            text={String(
              t("search.mapVenuesPrivate", { count: privateVenueCount }),
            )}
          />
        )}
    </>
  );

  // Memoized center so the map's fly-to effect only fires when the chosen
  // geo location actually changes (a fresh object every render would re-fly).
  const mapCenter = useMemo(
    () => (geoLocation ? { lat: geoLocation.lat, lng: geoLocation.lng } : null),
    [geoLocation],
  );

  /**
   * Scope radiogroup keyboard model. The pure part lives in
   * ./search-scope-nav; a `null` result means the key is not ours, and NOT
   * calling preventDefault on it is what keeps Tab working.
   */
  const handleScopeKeyDown = useCallback(
    (event: { key: string; preventDefault: () => void }) => {
      const next = nextScopeForKey(searchScope, event.key);
      if (!next) return;
      event.preventDefault();
      setSearchScope(next);
      document.getElementById(scopeRadioDomId(next))?.focus();
    },
    [searchScope],
  );

  /** "2026-09-01 – 2026-09-07" / "From …" / "Until …" for the date chip. */
  const appliedDateLabel = useMemo(() => {
    const { dateFrom: from, dateTo: to } = applied;
    if (!from && !to) return null;
    if (from && to) return `${from} – ${to}`;
    return from ? `From ${from}` : `Until ${to}`;
  }, [applied]);

  /** "$10 – $40" / "From $10" / "Up to $40" for the applied-price chip. */
  const appliedPriceLabel = useMemo(() => {
    if (applied.freeOnly) return null;
    const { priceMin: min, priceMax: max } = applied;
    if (min === "" && max === "") return null;
    if (min !== "" && max !== "") return `$${min} – $${max}`;
    return min !== "" ? `From $${min}` : `Up to $${max}`;
  }, [applied]);

  // Show the sticky map pane in an event-bearing scope when at least one
  // result has coordinates OR a geo filter is active. The geo case is
  // load-bearing: a "search this area" (or any located search) that comes back
  // empty must keep the map mounted so the user can pan back and re-search —
  // unmounting it stranded them with a "Map area" filter and no map to fix it.
  const hasMappableResults =
    mapItems.length > 0 || geoLocation !== null || privateVenueCount > 0;
  // `showRail` is redundant while MAP_PANE_MIN_VIEWPORT > RAIL_MIN_VIEWPORT,
  // and stated anyway: it is what makes the `pageMaxWidth` branches below
  // exhaustive, and it keeps the two breakpoints movable independently.
  const showMap =
    showRail && hasMapPaneRoom && mapInScope && hasMappableResults;

  /**
   * The List/Map segmented control — the map's home whenever the sticky pane
   * has nowhere to sit. It used to be mobile-only, which meant that between
   * the two breakpoints a reader with a location had no map at all; offering
   * it exactly when the pane is absent keeps the map reachable at every width.
   */
  const canToggleMap = !showMap && mapInScope && hasMappableResults;
  const mapViewActive = canToggleMap && mobileView === "map";

  /**
   * Page width budget, in the shell's content box (see SHELL_CONTENT_MAX).
   *
   *  • no rail  → 720, the original single reading column.
   *  • rail     → 720 + rail + gap, so the results keep that reading width.
   *  • rail+map → the whole content box; `s.leftCol` and `s.mapPane` split
   *               what is left after the rail, both above their real floors.
   */
  const pageMaxWidth = showRail
    ? showMap
      ? SHELL_CONTENT_MAX
      : 720 + FACET_RAIL_WIDTH + SHELL_GAP
    : 720;

  // The mark backing the open bottom card (mobile map view), by key.
  const selectedMapItem = useMemo(
    () =>
      selectedMapEventId
        ? (mapItems.find((i) => i.key === selectedMapEventId) ?? null)
        : null,
    [selectedMapEventId, mapItems],
  );

  // Fall back to the list if the map view is no longer valid (results emptied,
  // scope changed, viewport widened past mobile) so a stale "map" never shows
  // an empty surface. Also drops any open bottom card on the way out.
  useEffect(() => {
    if (mobileView === "map" && !canToggleMap) {
      setMobileView("list");
      setSelectedMapEventId(null);
    }
  }, [mobileView, canToggleMap]);

  // Any change to the applied geo location invalidates a stale "search this
  // area" prompt (the map flies to the new center; nothing to re-search).
  useEffect(() => {
    setPendingArea(null);
  }, [geoLocation]);

  // "Search this area" gate: only after a USER pan/zoom (pendingArea set) AND
  // the new frame differs meaningfully from the applied geo center / radius.
  // With no active location, any user move is meaningful.
  const showSearchArea = useMemo(() => {
    if (!pendingArea) return false;
    if (!geoLocation) return true;
    const movedKm = distanceKm(pendingArea.center, geoLocation);
    const nextRadius = clampRadiusKm(Math.round(pendingArea.radiusKm));
    const radiusChanged = Math.abs(nextRadius - radiusKm) >= RADIUS_STEP_KM;
    return movedKm > 2 || radiusChanged;
  }, [pendingArea, geoLocation, radiusKm]);

  // Apply the map's current frame as the active geo filter — re-runs search
  // bound to what the user is looking at, and surfaces it in the geo control.
  // We set `geoLocation` to the map's REPORTED center; SearchResultsMap keeps
  // the current zoom when the new `center` is ~the current map center (this
  // exact case), so the frame the user searched stays the frame they see.
  const applySearchArea = useCallback(() => {
    if (!pendingArea) return;
    const { center, radiusKm: r } = pendingArea;
    // TODO i18n
    setGeoLocation({ lat: center.lat, lng: center.lng, label: "Map area" });
    // Instant commit: center + radius change as ONE action — a debounced
    // radius would fire the first query with the stale radius.
    setRadiusKmNow(clampRadiusKm(Math.round(r)));
    setShowLocationInput(true);
    // TODO i18n
    setLocationQuery("Map area");
    setPendingArea(null);
  }, [pendingArea, setRadiusKmNow]);

  // Pin click. On MOBILE (map view) → surface a bottom card for that event;
  // there's no visible list to scroll. On DESKTOP → jump the list to the page
  // holding that event (keeping ALL pins on the map), then flash it; the scroll
  // happens in a layout effect below, once the target card has mounted.
  const handlePinClick = useCallback(
    (key: string) => {
      // Branch on WHICH MAP is on screen, not on viewport width. The full-bleed
      // map view hides the list, so "jump the list to that event" has nothing
      // to jump; the bottom card is the only affordance there. This used to
      // test `isMobile`, which was the same thing only while the full-bleed
      // view was mobile-only — it is now offered up to the map-pane
      // breakpoint, where that test would have silently scrolled a hidden list.
      if (mapViewActive) {
        setSelectedMapEventId(key);
        return;
      }
      const parsed = parseMapItemKey(key);
      if (!parsed) return;
      if (parsed.kind === "event") {
        const idx = sortedEvents.findIndex((e) => e.eventId === parsed.id);
        if (idx >= 0) setEventsPage(Math.floor(idx / resultsPerPage) + 1);
      } else {
        const idx = places.findIndex((p) => p.id === parsed.id);
        if (idx >= 0) setPlacesPage(Math.floor(idx / resultsPerPage) + 1);
      }
      setFlashCardId(key);
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
      flashTimeoutRef.current = setTimeout(() => setFlashCardId(null), 1600);
    },
    [mapViewActive, sortedEvents, places, resultsPerPage],
  );

  // Scroll the flashed card into view once it's in the DOM. Keyed on the page
  // too, so a pin whose card lives on another page scrolls after the page
  // switch mounts it. Guarded: no-op until the ref exists (or flash cleared).
  useIsomorphicLayoutEffect(() => {
    if (!flashCardId) return;
    const el = cardRefs.current.get(flashCardId);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [flashCardId, eventsPage, placesPage]);

  const people = useMemo(
    () => allSuggestions.filter((s) => s.type === "human"),
    [allSuggestions],
  );
  const orgs = useMemo(
    () => allSuggestions.filter((s) => s.type === "organization"),
    [allSuggestions],
  );
  // Per-section pagination — slice each result array to the active page
  // window. Total-page math here so the section render is a one-liner.
  const paged = <T,>(items: T[], page: number) => {
    const totalPages = Math.max(1, Math.ceil(items.length / resultsPerPage));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const start = (safePage - 1) * resultsPerPage;
    return {
      slice: items.slice(start, start + resultsPerPage),
      totalPages,
      safePage,
    };
  };
  const eventsPaged = paged(sortedEvents, eventsPage);
  // Save-heart state for the visible page of event results — one batched
  // savedState call per ≤50 ids, never per-row (signed-out short-circuits).
  const { isSaved: isEventSaved, toggleSave: toggleEventSave } = useEventSaves(
    eventsPaged.slice.map((e) => e.eventId),
  );
  const peoplePaged = paged(people, peoplePage);
  const orgsPaged = paged(orgs, orgsPage);
  const placesPaged = paged(places, placesPage);

  // Reset all section pages whenever the committed query / filters change
  // so the user lands on page 1 of fresh results, not page 4 of stale ones.
  useEffect(() => {
    setEventsPage(1);
    setPeoplePage(1);
    setOrgsPage(1);
    setPlacesPage(1);
  }, [debouncedQuery, geoFilter, applied, resultsPerPage, searchScope]);

  // ── Handlers ─────────────────────────────────────────────────────────
  const handleFormSubmit = useCallback(() => {
    if (!canSearch) return;
    // Submit only flushes the debounced query so the committed value takes
    // effect immediately (no waiting on the 700ms debounce). The outbound
    // URL effect is the single writer — it serialises the resulting state
    // (preserving geo the user just added and `sort`) into one navigation.
    setDebouncedQuery(trimmedQuery);
  }, [canSearch, trimmedQuery]);

  const handleClearSearch = useCallback(() => {
    // Full reset → bare /search. Reset all owned state (query, scope,
    // categories, geo, radius) so the outbound URL effect writes an empty
    // querystring in a single push. No imperative router call here — the
    // effect owns navigation, which avoids racing it (dropping/resurrecting
    // geo).
    setSearchValue("");
    setDebouncedQuery("");
    setSearchScope("all");
    setGeoLocation(null);
    setLocationQuery("");
    setPendingBrowserLocation(false);
    setShowLocationInput(false);
    setRadiusKm(DEFAULT_RADIUS_KM);
    setSelectedCategories([]);
    setDateFrom("");
    setDateTo("");
    setFreeOnly(false);
    // Price drafts too. This used to clear only the `applied` copies below,
    // which left the Filters panel showing a populated price field with
    // "Apply" lit right after the user cleared — one press resurrected the
    // filter they had just cleared, and the chip was already gone.
    setPriceMin("");
    setPriceMax("");
    // Sort is a preserved URL passthrough, not owned by the sync — leave
    // sortBy / applied.sortBy as-is so state stays consistent with the URL.
    setApplied((prev) => ({
      ...prev,
      selectedCategories: [],
      dateFrom: "",
      dateTo: "",
      freeOnly: false,
      priceMin: "",
      priceMax: "",
    }));
  }, [setSearchValue]);

  /** True when pressing "Clear search" would actually change something.
   * Mirrors the body of `handleClearSearch` term-for-term: every piece of
   * state that handler resets appears here, and nothing it leaves alone does.
   * Notably `sortBy` / `applied.sortBy` are absent (a preserved URL
   * passthrough the reset deliberately keeps). Without this
   * the chip rendered unconditionally — `canSearch` is true in every state —
   * so a pristine /search showed a control with nothing to clear.
   *
   * `radiusKm` is the one thing the reset touches that is deliberately NOT a
   * term. Without a `geoLocation` the radius reaches nothing the reader can
   * see: `geoFilter` is undefined, and `buildSearchQueryString` only writes
   * `radius` inside the geo block. It would also have re-broken the chip on
   * every imperial browser — the unit auto-detect resolves after mount and
   * snaps the default 50 km onto the mile grid (48 km), so `radiusKm !==
   * DEFAULT_RADIUS_KM` is permanently true there. When geo IS set the
   * `geoLocation` term already covers it.
   */
  const hasClearableState = useMemo(() => {
    if (searchValue !== "" || debouncedQuery !== "") return true;
    if (searchScope !== "all") return true;
    if (geoLocation) return true;
    if (locationQuery !== "") return true;
    if (pendingBrowserLocation || showLocationInput) return true;
    if (selectedCategories.length > 0) return true;
    if (dateFrom !== "" || dateTo !== "" || freeOnly) return true;
    if (applied.selectedCategories.length > 0) return true;
    if (applied.dateFrom !== "" || applied.dateTo !== "" || applied.freeOnly)
      return true;
    if (priceMin !== "" || priceMax !== "") return true;
    if (applied.priceMin !== "" || applied.priceMax !== "") return true;
    return false;
  }, [
    searchValue,
    debouncedQuery,
    searchScope,
    geoLocation,
    locationQuery,
    pendingBrowserLocation,
    showLocationInput,
    selectedCategories,
    dateFrom,
    dateTo,
    freeOnly,
    priceMin,
    priceMax,
    applied,
  ]);

  // ── Mobile filters sheet: open / commit / dismiss ────────────────────
  //
  // DISMISSING KEEPS THE DRAFT. It used to revert, which made every accidental
  // dismissal destructive — and one was very easy to trigger: pressing Escape
  // to close the location suggestion list also reached the sheet's
  // window-level Escape listener, so a reader who had ticked a category, a
  // date preset and a price ceiling lost all three to a keypress aimed at a
  // dropdown. (That leak is fixed at the source too — `LocationAutocomplete`
  // now consumes the keys it handles.) Re-opening restores the draft; the
  // Filters button carries a pending marker meanwhile; Clear is the explicit
  // way to throw the draft away.
  const openFiltersSheet = useCallback(() => setFiltersSheetOpen(true), []);

  const dismissFiltersSheet = useCallback(() => setFiltersSheetOpen(false), []);

  const commitFiltersSheet = useCallback(() => {
    // `handleApplyFilters` is already a no-op for an unchanged draft, so
    // committing an untouched sheet cannot reset pagination.
    handleApplyFilters();
    setFiltersSheetOpen(false);
  }, [handleApplyFilters]);

  /**
   * Crossing INTO the rail viewport with the sheet open.
   *
   * `{!showRail && <BottomSheet …>}` unmounts the sheet, which would otherwise
   * leave `filtersSheetOpen` true as invisible state: narrowing again would
   * re-open it unprompted, and `sheetWasOpenRef` would send focus to a
   * `#search-filters-toggle` that no longer exists. Close it here.
   *
   * The pending draft is intentionally left alone. Above the breakpoint the
   * rail IS the draft surface and the desktop effect applies it — which is the
   * desktop contract, not a silent commit of something the reader hid away.
   */
  useEffect(() => {
    if (!showRail) return;
    sheetWasOpenRef.current = false;
    setFiltersSheetOpen((open) => (open ? false : open));
  }, [showRail]);

  const handleUseMyLocation = useCallback(() => {
    if (coords) {
      setGeoLocation({
        lat: coords.lat,
        lng: coords.lng,
        label: String(t("search.myLocation")),
      });
      setLocationQuery("");
      setPendingBrowserLocation(false);
    } else {
      setShowLocationInput(true);
      setPendingBrowserLocation(true);
      requestLocation();
    }
  }, [coords, requestLocation, t]);

  const handleLocationSelect = useCallback(
    (place: PlaceDetail) => {
      if (place.lat != null && place.lng != null) {
        setGeoLocation({
          lat: place.lat,
          lng: place.lng,
          label:
            place.formattedAddress ??
            place.name ??
            String(t("search.selectedLocation")),
        });
      }
    },
    [t],
  );

  const handleClearLocation = useCallback(() => {
    setGeoLocation(null);
    setLocationQuery("");
    setRadiusKm(DEFAULT_RADIUS_KM);
    setPendingBrowserLocation(false);
  }, []);

  // Only show the loading spinner when there are no results to display yet.
  // If SSR provided initialResults we can show those immediately while the
  // client-side query refreshes in the background.
  const isLoading =
    hasSettledDebouncedQuery &&
    (unifiedQuery.isLoading || unifiedQuery.isFetching) &&
    sortedEvents.length === 0;

  /**
   * True once the CURRENT query has actually come back with data.
   *
   * Deliberately NOT derived from `isLoading`. That flag is gated on
   * `hasSettledDebouncedQuery`, which requires a text query of at least
   * MIN_QUERY_LENGTH — so on the BROWSE path (empty query) it is permanently
   * `false`, and `!isLoading` is permanently `true`. Any empty state gated on
   * `!isLoading` therefore renders during the whole browse round-trip, telling
   * the reader "No people yet. Check back soon." about a platform that simply
   * has not answered yet. Browse is exactly the path the People / Groups
   * buckets exist to serve, so the guard has to hold there.
   */
  const resultsAreSettled = unifiedQuery.isSuccess && !unifiedQuery.isFetching;
  // Surface query failures explicitly. Previously the page conflated "errored"
  // with "no results match" and rendered a misleading empty-state — making
  // server-side regressions (Zod output validation, transient 500s) invisible.
  const isErrored = hasDebouncedQuery && unifiedQuery.isError;
  const displayedCount =
    sortedEvents.length + people.length + orgs.length + places.length;
  const totalResults =
    committedEstimatedTotal > 0 ? committedEstimatedTotal : displayedCount;
  /**
   * Toolbar result count. `showingNResults` renders "Showing 42 results";
   * it is suppressed while typing or loading so a stale number never sits
   * above a skeleton.
   */
  const resultCountLabel =
    canSearch && !isLoading && !isTyping
      ? String(t("search.showingNResults", { count: totalResults }))
      : null;

  /** Filters trigger label — carries the APPLIED count, not the draft's. */
  const filtersButtonLabel =
    panelFilterCount > 0
      ? `${String(t("search.filters"))} · ${panelFilterCount}`
      : String(t("search.filters"));

  /**
   * The mobile sheet's commit label. The count is the CURRENTLY APPLIED
   * result set — the honest number we have without a second speculative
   * query for the draft — so it doubles as "close and go look at these".
   * Falls back to the plain verb whenever no count is settled yet.
   */
  const sheetCommitLabel =
    resultCountLabel && totalResults > 0
      ? `Show ${totalResults} ${totalResults === 1 ? "result" : "results"}`
      : "Show results";

  // ── Mobile filters sheet: focus management ───────────────────────────
  // The DS BottomSheet gives us Escape, the backdrop and the scroll lock, but
  // not a trap — so a dialog left untrapped would let Tab walk into the result
  // list behind it. Move focus in on open, cycle it inside, hand it back to
  // the trigger on close.

  useEffect(() => {
    if (!filtersSheetOpen) return;
    const node = sheetRef.current;
    if (!node) return;
    const first = node.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (first ?? node).focus();
  }, [filtersSheetOpen]);

  useEffect(() => {
    if (filtersSheetOpen) {
      sheetWasOpenRef.current = true;
      return;
    }
    if (!sheetWasOpenRef.current) return;
    sheetWasOpenRef.current = false;
    document.getElementById(FILTERS_TOGGLE_ID)?.focus();
  }, [filtersSheetOpen]);

  const handleSheetKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== "Tab") return;
    const node = sheetRef.current;
    if (!node) return;
    const items = Array.from(
      node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    );
    if (items.length === 0) {
      // Nothing to move to — keep focus on the dialog rather than letting Tab
      // escape to the list underneath.
      event.preventDefault();
      node.focus();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === node)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  // ── Navigate to entity ────────────────────────────────────────────────
  const navigateToEntity = useCallback(
    (item: UnifiedSearchSuggestion) => {
      switch (item.type) {
        case "organization":
          if (item.slug) router.push(`/orgs/${item.slug}`);
          else router.push(`/search?search=${encodeURIComponent(item.title)}`);
          break;
        case "human":
          // `profileSlug` is the /humans entity-page slug. `username` is a
          // Better Auth handle the /humans loader can NOT resolve (page
          // slugs are `{name}-{id8}`, disjoint from usernames), so a
          // missing profileSlug falls through to a title search, not a 404.
          if (item.profileSlug) router.push(`/humans/${item.profileSlug}`);
          else router.push(`/search?search=${encodeURIComponent(item.title)}`);
          break;
        case "place":
          // Same shape as the human case: `pageSlug` is the entity-page slug
          // `/places/[slug]` resolves on, and a place's only slug. (A place
          // suggestion used to also carry `Place.slug`, a multi-segment
          // DIRECTORY key this single-segment route could not match; that
          // column is deprecated and off the payload.) A venue with no entity
          // page still resolves by id.
          if (item.pageSlug) router.push(`/places/${item.pageSlug}`);
          else router.push(`/places/id/${item.placeId}`);
          break;
        default:
          break;
      }
    },
    [router],
  );

  // ── Render ───────────────────────────────────────────────────────────
  return (
    <div style={{ ...s.root, maxWidth: pageMaxWidth }}>
      {/* ── Page heading ─────────────────────────────────────────────── */}
      <div style={s.heading}>
        <div style={s.headingRow}>
          {/* Swiss numbered kicker — v2 Text variant (decorative index) */}
          <Text variant="kicker" tone="accent" weight="bold" aria-hidden>
            01.
          </Text>
          <h1 style={s.headingTitle}>Search</h1>
        </div>
        <p style={s.headingSubtitle}>Events, people, groups &amp; places</p>
      </div>

      {/* ── Search bar ─────────────────────────────────────────────────── */}
      <div style={layout.searchBar}>
        <SearchBar
          value={searchValue}
          onChangeValue={setSearchValue}
          onSubmit={handleFormSubmit}
          placeholder={String(t(SCOPE_PLACEHOLDER_KEY[searchScope]))}
          ariaLabel={String(t(SCOPE_PLACEHOLDER_LABEL_KEY[searchScope]))}
          height={48}
          testId="universal-search-form"
        />
      </div>

      {/* ── Scope ────────────────────────────────────────────────────────
      THE result-narrowing control. It re-scopes the QUERY (not a post-fetch
      slice), drives the `type` URL param, and is what the sort model couples
      to. A WAI-ARIA radiogroup rather than a tab strip because picking a
      scope changes what is fetched, not which panel is shown — and a wrapping
      chip row rather than a SegmentedControl because five uppercase labels do
      not fit one 320px line. */}
      <div
        role="radiogroup"
        aria-label="Result type"
        style={s.chipRow}
        data-testid="search-scope-chips"
        onKeyDown={handleScopeKeyDown}
      >
        {SCOPE_OPTIONS.map(({ id, label, icon: Icon }) => {
          const active = searchScope === id;
          return (
            <Chip
              key={id}
              id={scopeRadioDomId(id)}
              role="radio"
              aria-checked={active}
              // Roving tabindex — the whole group is ONE tab stop.
              tabIndex={active ? 0 : -1}
              tone={active ? "info" : "neutral"}
              variant={active ? "filled" : "outline"}
              size="sm"
              {...(Icon ? { icon: <Icon size={12} aria-hidden /> } : {})}
              interactive
              onPress={() => setSearchScope(id)}
              data-testid={`search-scope-${id}`}
            >
              {label}
            </Chip>
          );
        })}
      </div>

      {/* ── Shell: persistent facet rail (desktop) + results column ────── */}
      <div style={layout.shell}>
        {showRail && (
          <SearchFacetRail
            variant="rail"
            categoryOptions={categories}
            categoriesLoading={categoriesQuery.isLoading}
            draft={facetDraft}
            onChange={handleFacetChange}
            showEventFacets={eventsInScope}
            geoLabel={geoLocation?.label ?? null}
            locationQuery={locationQuery}
            onLocationQueryChange={setLocationQuery}
            onLocationSelect={handleLocationSelect}
            onUseMyLocation={handleUseMyLocation}
            onClearLocation={handleClearLocation}
            locating={locationLoading}
            locationError={Boolean(locationError)}
            radiusLabel={radiusDisplayLabel}
            radiusSliderValue={kmToSliderValue(radiusKm, imperial)}
            radiusSliderConfig={sliderConfig}
            onRadiusSliderChange={(v) => setRadiusKm(sliderValueToKm(v, imperial))}
          />
        )}

        <div style={layout.main}>
          {/* ── Toolbar: filters trigger (mobile) · count · sort ───────── */}
          <div style={layout.toolbar} data-testid="search-toolbar">
            {!showRail && (
              <Button
                id={FILTERS_TOGGLE_ID}
                size="$3"
                variant="secondary"
                onPress={openFiltersSheet}
                aria-haspopup="dialog"
                aria-expanded={filtersSheetOpen}
                // Dismissing the sheet keeps the draft, so the trigger has to
                // say so — otherwise pending edits are invisible state. The
                // visible label stays inside the accessible name (WCAG 2.5.3).
                aria-label={
                  hasUnappliedChanges
                    ? `${filtersButtonLabel}, unapplied changes`
                    : undefined
                }
                data-testid="search-filters-toggle"
              >
                <SlidersHorizontal size={14} strokeWidth={2} aria-hidden />
                {filtersButtonLabel}
                {hasUnappliedChanges && (
                  <span aria-hidden style={layout.pendingDot} />
                )}
              </Button>
            )}

            {resultCountLabel && (
              <Text variant="overline" tone="muted" testId="search-result-count">
                {resultCountLabel}
              </Text>
            )}

            {/* Sort is offered only where it means something: a non-event
            scope has nothing but relevance, and rendering a menu of one is
            worse than rendering none. */}
            {offeredSorts.length > 1 && (
              <div style={layout.toolbarSpacer}>
                <StyledSelect<SortId>
                  // Reconcile at RENDER, not only in the effect. `offeredSorts`
                  // is a useMemo on [scope, geo] but `sortBy` is corrected by an
                  // effect on the same deps, so for one frame the value could
                  // be an option that is no longer offered — StyledSelect has
                  // nothing to match and paints its placeholder. Same function
                  // the effect uses, so the two cannot disagree.
                  value={reconcileSort(sortBy, searchScope, geoLocation !== null)}
                  options={offeredSorts.map((o) => ({
                    value: o.id,
                    label: o.label,
                  }))}
                  onChange={handleSelectSort}
                  size="sm"
                  icon={<ArrowUpDown size={14} aria-hidden />}
                  ariaLabel={String(t("search.sort"))}
                  selectId="search-sort-select"
                  testId="search-sort-select"
                />
              </div>
            )}
          </div>

          {/* A category from the link was pruned (see the prune effect). It is
          information, not an error, and it sits outside the chip row because
          after the prune there may be nothing left for that row to show. */}
          {shownUnavailableCategoryNotice && (
            <Alert
              tone="info"
              compact
              fullWidth
              role="status"
              data-testid="search-category-unavailable-notice"
              description={String(
                t(
                  shownUnavailableCategoryNotice === "all"
                    ? "search.categoryUnavailableAll"
                    : "search.categoryUnavailableSome",
                ),
              )}
            />
          )}

          {/* ── Active filter chips ────────────────────────────────────────
          Every applied narrowing, individually removable, in one row.
          Pressing a chip removes that one filter from BOTH the draft and the
          applied snapshot, so it lands immediately on either viewport — a
          chip that needed a second Apply press would be a chip that lied.
          Geo rides here too even though it is not part of `applied`: to the
          reader it is just another filter.

          The row also carries Clear all, which is why it renders for a bare
          text query with no chips — the search box has no clear button of its
          own, so this is the only way out of a query without backspacing. */}
          {hasClearableState && (
            <div style={s.chipRow} data-testid="search-active-filters">
              {eventsInScope &&
                shownAppliedCategories.map((slug) => {
                  const cat = categories.find((c) => c.slug === slug);
                  const name = cat?.name ?? slug;
                  const remove = () => removeAppliedCategory(slug);
                  return (
                    <Chip
                      key={`active-cat-${slug}`}
                      tone="info"
                      variant="outline"
                      size="sm"
                      icon={<X size={12} aria-hidden />}
                      interactive
                      aria-label={String(
                        t("search.removeCategoryFilter", { category: name }),
                      )}
                      onPress={remove}
                      {...chipActivation(remove)}
                      data-testid={`active-category-chip-${slug}`}
                    >
                      {name}
                    </Chip>
                  );
                })}

              {eventsInScope && appliedDateLabel && (
                <Chip
                  tone="neutral"
                  variant="outline"
                  size="sm"
                  icon={<X size={12} aria-hidden />}
                  interactive
                  // WCAG 2.5.3 Label in Name: the accessible name has to
                  // CONTAIN the visible text, so a voice-control user can say
                  // what they can see. Hence "Remove filter: <the chip>".
                  aria-label={`Remove filter: ${appliedDateLabel}`}
                  onPress={removeAppliedDateRange}
                  {...chipActivation(removeAppliedDateRange)}
                  data-testid="active-date-chip"
                >
                  {appliedDateLabel}
                </Chip>
              )}

              {eventsInScope && applied.freeOnly && (
                <Chip
                  tone="neutral"
                  variant="outline"
                  size="sm"
                  icon={<X size={12} aria-hidden />}
                  interactive
                  aria-label={`Remove filter: ${String(t("search.freeOnly"))}`}
                  onPress={removeAppliedFreeOnly}
                  {...chipActivation(removeAppliedFreeOnly)}
                  data-testid="active-free-chip"
                >
                  {String(t("search.freeOnly"))}
                </Chip>
              )}

              {eventsInScope && appliedPriceLabel && (
                <Chip
                  tone="neutral"
                  variant="outline"
                  size="sm"
                  icon={<X size={12} aria-hidden />}
                  interactive
                  aria-label={`Remove filter: ${appliedPriceLabel}`}
                  onPress={removeAppliedPriceRange}
                  {...chipActivation(removeAppliedPriceRange)}
                  data-testid="active-price-chip"
                >
                  {appliedPriceLabel}
                </Chip>
              )}

              {geoLocation && (
                <Chip
                  tone="neutral"
                  variant="outline"
                  size="sm"
                  icon={<X size={12} aria-hidden />}
                  interactive
                  // The visible text is "<place> · <radius>", so the whole of
                  // it goes in the name (WCAG 2.5.3) — a voice-control reader
                  // says what they can see, radius included.
                  aria-label={`Remove filter: ${geoLocation.label} · ${radiusDisplayLabel}`}
                  onPress={handleClearLocation}
                  {...chipActivation(handleClearLocation)}
                  data-testid="active-location-chip"
                >
                  {`${geoLocation.label} · ${radiusDisplayLabel}`}
                </Chip>
              )}

              {hasClearableState && (
                <Chip
                  tone="danger"
                  variant="outline"
                  size="sm"
                  icon={<X size={12} aria-hidden />}
                  interactive
                  onPress={handleClearSearch}
                  {...chipActivation(handleClearSearch)}
                  data-testid="search-clear-all"
                >
                  Clear all
                </Chip>
              )}
            </div>
          )}

          {/* ── Results body: list (left) + sticky map (right, desktop) ──
          `body` is the flex ROW only when the map pane is present; otherwise
          the list is full-width. */}
          <div style={showMap ? s.body : s.bodySingle}>
            <div style={showMap ? s.leftCol : s.leftColFull}>
              {/* ── Mobile list/map toggle (mobile + event scope + plottable) ────
              A radiogroup, not a tablist: this picks a rendering of the SAME
              results, and the DS SegmentedControl already ships the roving
              tabindex + arrow-key model. TODO i18n on the two labels. */}
              {canToggleMap && (
                <SegmentedControl
                  options={[
                    { value: "list", label: "List" },
                    { value: "map", label: "Map" },
                  ]}
                  value={mobileView}
                  onChange={(next) => {
                    setMobileView(next);
                    if (next === "list") setSelectedMapEventId(null);
                  }}
                  ariaLabel="Results view"
                  fullWidth
                  testIdBase="mobile-view"
                />
              )}

              {/* ── Mobile full-bleed map view ────────────────────────────────── */}
              {mapViewActive && (
                <div style={s.mobileMapWrap} data-testid="mobile-map-view">
                  <SearchResultsMap
                    items={mapItems}
                    layers={effectiveMapLayers}
                    center={mapCenter}
                    onItemClick={handlePinClick}
                    onViewportChange={setPendingArea}
                    labels={mapLabels}
                    disablePopup
                  />
                  {mapOverlays(true)}
                  {showSearchArea && (
                    <button
                      type="button"
                      style={{
                        ...s.searchAreaBtn,
                        ...(showMapLegend ? { top: 60 } : null),
                      }}
                      onClick={applySearchArea}
                      data-testid="search-this-area-mobile"
                    >
                      {/* TODO i18n */}
                      <Navigation size={13} strokeWidth={2.5} aria-hidden />
                      Search this area
                    </button>
                  )}
                  {selectedMapItem && (
                    <div style={s.mobileMapCard} data-testid="mobile-map-card">
                      {selectedMapItem.kind === "venue" && (
                        <span
                          aria-hidden
                          style={{
                            ...s.resultAvatar,
                            backgroundColor: avatarColor(selectedMapItem.id),
                          }}
                        >
                          <MapPin size={16} />
                        </span>
                      )}
                      <div style={s.mobileMapCardBody}>
                        <p style={s.mobileMapCardTitle}>{selectedMapItem.title}</p>
                        {(selectedMapItem.subtitle ||
                          selectedMapItem.precision !== "exact") && (
                          <p style={s.mobileMapCardVenue}>
                            {[
                              selectedMapItem.subtitle,
                              selectedMapItem.precision !== "exact"
                                ? String(t("search.mapApproxArea"))
                                : null,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                        )}
                        {selectedMapItem.href && (
                          <a
                            href={selectedMapItem.href}
                            style={s.mobileMapCardLink}
                            data-testid="mobile-map-card-link"
                          >
                            {String(
                              t(
                                selectedMapItem.kind === "venue"
                                  ? "search.mapViewVenue"
                                  : "search.mapViewEvent",
                              ),
                            )}
                            <ArrowRight size={13} strokeWidth={2.5} aria-hidden />
                          </a>
                        )}
                      </div>
                      <button
                        type="button"
                        style={s.mobileMapCardClose}
                        onClick={() => setSelectedMapEventId(null)}
                        aria-label="Close" /* TODO i18n */
                        data-testid="mobile-map-card-close"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* The stacked result list — hidden while the mobile map view is open
              (they'd otherwise both be long). Desktop is unaffected. */}
              {!mapViewActive && (
                <>
                  {/* ══════════════════════════════════════════════════════════════ */}
                  {/* ── Section 1: EVENTS (always visible) ───────────────────────── */}
                  {/* ══════════════════════════════════════════════════════════════ */}
                  {(searchScope === "all" || searchScope === "event") && (
                      <div style={s.sectionWrapper} data-testid="section-events">
                        <div style={s.sectionHeader}>
                          <Calendar size={14} color={ACCENT} />
                          <h2 style={s.sectionTitle}>Events</h2>
                          {canSearch && !isLoading && (
                            <span
                              style={
                                sortedEvents.length > 0
                                  ? s.sectionCount
                                  : s.sectionCountMuted
                              }
                            >
                              {sortedEvents.length}
                            </span>
                          )}
                        </div>

                        {/* Event results */}
                        {hasQueryInput && !hasTextQuery && (
                          <p style={s.emptyState}>
                            {String(t("search.minCharsHint"))}
                          </p>
                        )}

                        {/* Error state — never silently render "0 results" when the query
                actually errored. The global query logger captures the
                stack/Sentry side; this banner is the user-facing surface. */}
                        {isErrored && !isTyping && (
                          <div
                            data-testid="search-error"
                            role="alert"
                            style={{
                              padding: "12px 16px",
                              border: `2px solid ${VAR_DANGER}`,
                              borderLeft: `4px solid ${VAR_DANGER}`,
                              fontFamily: FONT_BODY,
                              fontSize: 13,
                              color: VAR_INK,
                              display: "flex",
                              flexDirection: "column",
                              gap: 8,
                            }}
                          >
                            <strong
                              style={{
                                fontSize: 11,
                                letterSpacing: "0.08em",
                                textTransform: "uppercase",
                              }}
                            >
                              Search failed
                            </strong>
                            <span style={{ color: VAR_MUTED }}>
                              Something went wrong on our side. The error has been
                              reported — please try again or refresh.
                            </span>
                          </div>
                        )}

                        {/* Skeleton loader — fires the moment the user starts typing and
                persists through the debounce + fetch. Stale results are hidden
                via `!isTyping` on the success branch so the skeleton owns the
                area without flicker. */}
                        {hasTextQuery && (isLoading || isTyping) && !isErrored && (
                          <div
                            style={s.resultList}
                            aria-busy
                            data-testid="search-events-skeleton"
                          >
                            {[0, 1, 2, 3].map((i) => (
                              <div
                                key={i}
                                style={{
                                  ...s.resultItem,
                                  cursor: "default",
                                  pointerEvents: "none",
                                }}
                              >
                                <span
                                  className="th-skeleton"
                                  style={{
                                    display: "block",
                                    height: 16,
                                    width: `${72 - i * 9}%`,
                                    marginBottom: 8,
                                  }}
                                />
                                <span
                                  className="th-skeleton"
                                  style={{
                                    display: "block",
                                    height: 12,
                                    width: `${52 - i * 7}%`,
                                  }}
                                />
                              </div>
                            ))}
                          </div>
                        )}

                        {hasSettledDebouncedQuery &&
                          !isLoading &&
                          !isTyping &&
                          !isErrored &&
                          sortedEvents.length === 0 && (
                            <p style={s.emptyState}>
                              {String(
                                t("search.noEventsMatch", { query: trimmedQuery }),
                              )}
                            </p>
                          )}

                        {/* Browse-all empty state — distinguish "no events anywhere" from
                "no events within your radius." When a geo filter is active and
                zero events came back, surface the radius as the likely cause
                and offer a one-click way to widen it. */}
                        {!hasQueryInput &&
                          !isLoading &&
                          !isTyping &&
                          !isErrored &&
                          sortedEvents.length === 0 &&
                          (geoFilter ? (
                            <div
                              style={{
                                ...s.emptyState,
                                display: "flex",
                                flexDirection: "column",
                                alignItems: "center",
                                gap: 12,
                              }}
                            >
                              <span>
                                No events within {radiusDisplayLabel} of{" "}
                                {geoLocation?.label ?? "your location"}.
                              </span>
                              {/* v2: legacy accent-outline fake button → secondary Button
                          atom; trailing arrow = direction (color from the atom). */}
                              <Button
                                size="$4"
                                variant="secondary"
                                onPress={() => setRadiusKmNow(RADIUS_WORLDWIDE_KM)}
                              >
                                Show all events worldwide
                                <ArrowRight
                                  size={16}
                                  strokeWidth={2.5}
                                  aria-hidden
                                />
                              </Button>
                            </div>
                          ) : (
                            <p style={s.emptyState}>
                              No events yet. Check back soon.
                            </p>
                          ))}

                        {canSearch &&
                          !isLoading &&
                          !isTyping &&
                          !isErrored &&
                          sortedEvents.length > 0 && (
                            <Lineup
                              key={requestKey}
                              className="th-stagger-fade"
                            >
                              {eventsPaged.slice.map((event) => {
                                const badges = (
                                  event as unknown as { badges?: string[] }
                                ).badges;
                                const hasPasswordBadge = badges?.some((b) =>
                                  b.toLowerCase().includes("password"),
                                );
                                const hasApplicationBadge = badges?.some((b) =>
                                  b.toLowerCase().includes("application"),
                                );
                                // Prefer the canonical slug; fall back to the eventId
                                // (the /events route resolves UUIDs and redirects to the
                                // canonical slug). Avoids silently routing back to /search
                                // when an event hasn't been assigned a slug yet.
                                const href = event.slug
                                  ? `/events/${event.slug}`
                                  : event.eventId
                                    ? `/events/${event.eventId}`
                                    : SEARCH_PATH;
                                // LineupRow price slot: the shared all-in label ("Free",
                                // "Free+", "Pay what you want", or "$X" with no
                                // "From"/"+", like the site cards), worded in the
                                // viewer's language. Null = no price slot rendered.
                                const priceLabel =
                                  searchPriceLabel(
                                    event as unknown as Parameters<
                                      typeof searchPriceLabel
                                    >[0],
                                    priceWords,
                                  ) ?? undefined;
                                // Search events carry no structured/compact start time, so
                                // the when-column is omitted and the venue + server-format
                                // date string (`helper`) fold into the muted subtitle.
                                const subtitle =
                                  [event.subtitle, event.helper]
                                    .filter(Boolean)
                                    .join(" · ") || undefined;
                                // Gate badges (dead today — mapping sends badges:[]) map to
                                // the mono category chip if they ever populate; password
                                // wins over application.
                                const gateLabel = hasPasswordBadge
                                  ? String(t("search.badgePassword"))
                                  : hasApplicationBadge
                                    ? String(t("search.badgeApplication"))
                                    : undefined;

                                return (
                                  /* The save heart is a SIBLING overlay of the row anchor —
                             <button> inside <a> is invalid HTML. */
                                  <div
                                    key={event.eventId}
                                    ref={(el) =>
                                      registerCardRef(
                                        mapItemKey("event", event.eventId),
                                        el,
                                      )
                                    }
                                    data-event-id={event.eventId}
                                    // TODO(perf): setHighlightedId re-renders the full page;
                                    // isolate highlight state into a memoized map-pane child.
                                    onMouseEnter={() =>
                                      setHighlightedId(
                                        mapItemKey("event", event.eventId),
                                      )
                                    }
                                    onMouseLeave={() =>
                                      setHighlightedId((cur) =>
                                        cur ===
                                        mapItemKey("event", event.eventId)
                                          ? null
                                          : cur,
                                      )
                                    }
                                    style={{
                                      position: "relative",
                                      scrollMarginTop: MAP_STICKY_TOP + 16,
                                      transition: "outline-color 200ms ease",
                                      ...(flashCardId ===
                                      mapItemKey("event", event.eventId)
                                        ? s.cardFlash
                                        : null),
                                    }}
                                  >
                                    <LineupRow
                                      name={event.title}
                                      subtitle={subtitle}
                                      category={gateLabel}
                                      price={priceLabel}
                                      compact={isMobile}
                                      href={href}
                                      // Reserve room for the absolutely-placed save heart.
                                      paddingRight={52}
                                      testId={`event-result-${event.eventId}`}
                                    />
                                    <SaveHeart
                                      saved={isEventSaved(event.eventId)}
                                      onToggle={() =>
                                        toggleEventSave(event.eventId)
                                      }
                                      testId={`event-result-${event.eventId}-save`}
                                      style={{
                                        position: "absolute",
                                        top: "50%",
                                        right: 4,
                                        transform: "translateY(-50%)",
                                      }}
                                    />
                                  </div>
                                );
                              })}
                            </Lineup>
                          )}
                        <Pagination
                          page={eventsPaged.safePage}
                          totalPages={eventsPaged.totalPages}
                          onChange={setEventsPage}
                          pageSize={resultsPerPage}
                          pageSizeOptions={PAGE_SIZE_OPTIONS}
                          onPageSizeChange={setResultsPerPage}
                          testId="events-pagination"
                        />
                      </div>
                    )}

                  {/* ══════════════════════════════════════════════════════════════ */}
                  {/* ── Section 2: PEOPLE (staggered fade-in on new search) ────────── */}
                  {/* ══════════════════════════════════════════════════════════════ */}
                  {/* `hasTextQuery` alone used to gate this, which meant
                  scoping to People with no query rendered NOTHING under a
                  toolbar reading "Showing 12 results" — one click away now
                  that scope is the only narrowing control. A narrowed scope IS
                  a browse intent, same as the Events and Places sections. */}
                  {(searchScope === "all" || searchScope === "human") &&
                    (hasTextQuery || searchScope === "human") &&
                    !isTyping &&
                    people.length > 0 && (
                      <div style={s.sectionWrapper} data-testid="section-people">
                        <div style={s.sectionHeader}>
                          <User size={14} color={STRUCTURAL} />
                          <h2 style={s.sectionTitle}>People</h2>
                          <span style={s.sectionCount}>{people.length}</span>
                        </div>

                        <div
                          key={requestKey}
                          className="th-stagger-fade"
                          style={s.resultList}
                        >
                          {peoplePaged.slice.map((item, i) => {
                            const username = (item as { username?: string | null })
                              .username;
                            const meta = username
                              ? `@${username}`
                              : (item.subtitle ?? null);
                            return (
                              <button
                                key={`human-${item.id ?? i}`}
                                type="button"
                                style={{
                                  ...s.resultItem,
                                  ...(isMobile && {
                                    flexDirection: "column" as const,
                                    alignItems: "flex-start" as const,
                                    gap: 6,
                                  }),
                                }}
                                onClick={() => navigateToEntity(item)}
                                onMouseEnter={(e) => applyHover(e, true)}
                                onMouseLeave={(e) => applyHover(e, false)}
                                onFocus={(e) => applyHover(e, true)}
                                onBlur={(e) => applyHover(e, false)}
                              >
                                <span
                                  aria-hidden
                                  style={{
                                    ...s.resultAvatar,
                                    borderRadius: "50%",
                                    backgroundColor: avatarColor(item.id),
                                  }}
                                >
                                  {getInitials(item.title)}
                                </span>
                                <span style={s.resultLabelCol}>
                                  <span style={s.resultTitle}>{item.title}</span>
                                  {meta && <span style={s.resultMeta}>{meta}</span>}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                        <Pagination
                          page={peoplePaged.safePage}
                          totalPages={peoplePaged.totalPages}
                          onChange={setPeoplePage}
                          pageSize={resultsPerPage}
                          pageSizeOptions={PAGE_SIZE_OPTIONS}
                          onPageSizeChange={setResultsPerPage}
                          testId="people-pagination"
                        />
                      </div>
                    )}

                  {/* ══════════════════════════════════════════════════════════════ */}
                  {/* ── Section 3: ORGANISERS (staggered fade-in on new search) ───── */}
                  {/* ══════════════════════════════════════════════════════════════ */}
                  {(searchScope === "all" || searchScope === "organization") &&
                    (hasTextQuery || searchScope === "organization") &&
                    !isTyping &&
                    orgs.length > 0 && (
                      <div style={s.sectionWrapper} data-testid="section-orgs">
                        <div style={s.sectionHeader}>
                          <Building2 size={14} color={STRUCTURAL} />
                          <h2 style={s.sectionTitle}>Groups</h2>
                          <span style={s.sectionCount}>{orgs.length}</span>
                        </div>

                        <div
                          key={requestKey}
                          className="th-stagger-fade"
                          style={s.resultList}
                        >
                          {orgsPaged.slice.map((item, i) => {
                            const slug = (item as { slug?: string | null }).slug;
                            const meta = slug
                              ? `@${slug}`
                              : (item.subtitle ?? null);
                            return (
                              <button
                                key={`org-${item.id ?? i}`}
                                type="button"
                                style={{
                                  ...s.resultItem,
                                  ...(isMobile && {
                                    flexDirection: "column" as const,
                                    alignItems: "flex-start" as const,
                                    gap: 6,
                                  }),
                                }}
                                onClick={() => navigateToEntity(item)}
                                onMouseEnter={(e) => applyHover(e, true)}
                                onMouseLeave={(e) => applyHover(e, false)}
                                onFocus={(e) => applyHover(e, true)}
                                onBlur={(e) => applyHover(e, false)}
                              >
                                <span
                                  aria-hidden
                                  style={{
                                    ...s.resultAvatar,
                                    // Squared corners for orgs to differentiate from
                                    // the round people avatars at a glance.
                                    backgroundColor: avatarColor(item.id),
                                  }}
                                >
                                  <Building2 size={16} />
                                </span>
                                <span style={s.resultLabelCol}>
                                  <span style={s.resultTitle}>{item.title}</span>
                                  {meta && <span style={s.resultMeta}>{meta}</span>}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                        <Pagination
                          page={orgsPaged.safePage}
                          totalPages={orgsPaged.totalPages}
                          onChange={setOrgsPage}
                          pageSize={resultsPerPage}
                          pageSizeOptions={PAGE_SIZE_OPTIONS}
                          onPageSizeChange={setResultsPerPage}
                          testId="orgs-pagination"
                        />
                      </div>
                    )}

                  {/* ══════════════════════════════════════════════════════════════ */}
                  {/* ── Section 4: PLACES (staggered fade-in on new search) ────────── */}
                  {/* ══════════════════════════════════════════════════════════════ */}
                  {(searchScope === "all" || searchScope === "place") &&
                    canSearch &&
                    !isTyping &&
                    places.length > 0 && (
                      <div style={s.sectionWrapper} data-testid="section-places">
                        <div style={s.sectionHeader}>
                          <MapPin size={14} color={STRUCTURAL} />
                          <h2 style={s.sectionTitle}>Places</h2>
                          <span style={s.sectionCount}>{places.length}</span>
                        </div>

                        <div
                          key={requestKey}
                          className="th-stagger-fade"
                          style={s.resultList}
                        >
                          {placesPaged.slice.map((item, i) => {
                            const city = (item as { city?: string | null }).city;
                            const meta = city ?? item.subtitle ?? null;
                            // Same key the map uses for this venue's mark, so a
                            // row hover highlights it and a mark click flashes
                            // this row.
                            const mapKey = mapItemKey("venue", item.id);
                            const unhighlight = () =>
                              setHighlightedId((cur) =>
                                cur === mapKey ? null : cur,
                              );
                            return (
                              <button
                                key={`place-${item.id ?? i}`}
                                ref={(el) => registerCardRef(mapKey, el)}
                                type="button"
                                data-place-id={item.id}
                                style={{
                                  ...s.resultItem,
                                  ...(isMobile && {
                                    flexDirection: "column" as const,
                                    alignItems: "flex-start" as const,
                                    gap: 6,
                                  }),
                                  scrollMarginTop: MAP_STICKY_TOP + 16,
                                  ...(flashCardId === mapKey ? s.cardFlash : null),
                                }}
                                onClick={() => navigateToEntity(item)}
                                onMouseEnter={(e) => {
                                  applyHover(e, true);
                                  setHighlightedId(mapKey);
                                }}
                                onMouseLeave={(e) => {
                                  applyHover(e, false);
                                  unhighlight();
                                }}
                                onFocus={(e) => {
                                  applyHover(e, true);
                                  setHighlightedId(mapKey);
                                }}
                                onBlur={(e) => {
                                  applyHover(e, false);
                                  unhighlight();
                                }}
                              >
                                <span
                                  aria-hidden
                                  style={{
                                    ...s.resultAvatar,
                                    backgroundColor: avatarColor(item.id),
                                  }}
                                >
                                  <MapPin size={16} />
                                </span>
                                <span style={s.resultLabelCol}>
                                  <span style={s.resultTitle}>{item.title}</span>
                                  {meta && <span style={s.resultMeta}>{meta}</span>}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                        <Pagination
                          page={placesPaged.safePage}
                          totalPages={placesPaged.totalPages}
                          onChange={setPlacesPage}
                          pageSize={resultsPerPage}
                          pageSizeOptions={PAGE_SIZE_OPTIONS}
                          onPageSizeChange={setResultsPerPage}
                          testId="places-pagination"
                        />
                      </div>
                    )}

                  {/* Places browse-all empty state — mirrors the events section so an
              empty-query browse (or a place-scoped search) still shows a clear
              "nothing here" message instead of a blank gap. */}
                  {/* Empty states for the narrowed scopes. A scope chip is one
                  click, so every bucket the reader can land on alone has to be
                  able to say "nothing here" — and say WHICH kind of nothing:
                  an empty shelf reads differently from a search that missed.
                  (In the "all" scope only Places shows one, on the browse-all
                  landing; three stacked empties there would be noise.) */}
                  {searchScope === "human" &&
                    canSearch &&
                    resultsAreSettled &&
                    !isTyping &&
                    !isErrored &&
                    people.length === 0 && (
                      <EmptyBucket
                        icon={User}
                        title="People"
                        message={emptyBucketMessage("people", trimmedQuery)}
                        testId="section-people-empty"
                      />
                    )}

                  {searchScope === "organization" &&
                    canSearch &&
                    resultsAreSettled &&
                    !isTyping &&
                    !isErrored &&
                    orgs.length === 0 && (
                      <EmptyBucket
                        icon={Building2}
                        title="Groups"
                        message={emptyBucketMessage("groups", trimmedQuery)}
                        testId="section-orgs-empty"
                      />
                    )}

                  {(searchScope === "all" || searchScope === "place") &&
                    (searchScope === "place" || !hasTextQuery) &&
                    canSearch &&
                    resultsAreSettled &&
                    !isTyping &&
                    !isErrored &&
                    places.length === 0 && (
                      <EmptyBucket
                        icon={MapPin}
                        title="Places"
                        message={emptyBucketMessage("places", trimmedQuery)}
                        testId="section-places-empty"
                      />
                    )}

                  {/* ── Load more ───────────────────────────────────────────────── */}
                  {canSearch && hasMore && (
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "center",
                        padding: "16px 0",
                      }}
                    >
                      <Button
                        size="$4"
                        variant="secondary"
                        onPress={handleLoadMore}
                        disabled={isLoadingMore}
                        data-testid="load-more-results"
                      >
                        {isLoadingMore ? "Loading..." : "Load more results"}
                      </Button>
                    </div>
                  )}
                </>
              )}
            </div>
            {/* ── Sticky results map (desktop only) ────────────────────── */}
            {showMap && (
              <div style={s.mapPane} data-testid="search-map-pane">
                <div style={s.mapSticky}>
                  <SearchResultsMap
                    items={mapItems}
                    layers={effectiveMapLayers}
                    center={mapCenter}
                    highlightedKey={highlightedId}
                    onItemClick={handlePinClick}
                    onViewportChange={setPendingArea}
                    labels={mapLabels}
                  />
                  {mapOverlays(false)}
                  {showSearchArea && (
                    <button
                      type="button"
                      style={{
                        ...s.searchAreaBtn,
                        ...(showMapLegend ? { top: 52 } : null),
                      }}
                      onClick={applySearchArea}
                      data-testid="search-this-area"
                    >
                      {/* TODO i18n */}
                      <Navigation size={13} strokeWidth={2.5} aria-hidden />
                      Search this area
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Filters sheet (below the rail viewport) ────────────────────────
      Same `SearchFacetRail` the desktop column renders, moved into a sheet.
      Mounted only when the rail is not, so the two can never both exist
      (duplicate ids / duplicate accessible names). The DS BottomSheet handles
      Escape, backdrop dismissal, the portal and the scroll lock; the dialog
      role, the label and the focus trap are wired here. Dismissal KEEPS the
      draft — see `dismissFiltersSheet`. */}
      {!showRail && (
        <BottomSheet open={filtersSheetOpen} onClose={dismissFiltersSheet}>
          <BottomSheet.Panel maxHeightVh={88}>
            <div
              ref={sheetRef}
              role="dialog"
              aria-modal="true"
              aria-label={String(t("search.filters"))}
              tabIndex={-1}
              onKeyDown={handleSheetKeyDown}
              style={{
                display: "flex",
                flexDirection: "column",
                flex: 1,
                minHeight: 0,
                outline: "none",
              }}
              data-testid="search-filters-sheet"
            >
              <BottomSheet.Header
                title={String(t("search.filters"))}
                onClose={dismissFiltersSheet}
              />
              <BottomSheet.Body>
                <SearchFacetRail
                  variant="sheet"
                  categoryOptions={categories}
                  categoriesLoading={categoriesQuery.isLoading}
                  draft={facetDraft}
                  onChange={handleFacetChange}
                  showEventFacets={eventsInScope}
                  geoLabel={geoLocation?.label ?? null}
                  locationQuery={locationQuery}
                  onLocationQueryChange={setLocationQuery}
                  onLocationSelect={handleLocationSelect}
                  onUseMyLocation={handleUseMyLocation}
                  onClearLocation={handleClearLocation}
                  locating={locationLoading}
                  locationError={Boolean(locationError)}
                  radiusLabel={radiusDisplayLabel}
                  radiusSliderValue={kmToSliderValue(radiusKm, imperial)}
                  radiusSliderConfig={sliderConfig}
                  onRadiusSliderChange={(v) =>
                    setRadiusKm(sliderValueToKm(v, imperial))
                  }
                />
              </BottomSheet.Body>
              <BottomSheet.Footer>
                {/* "Clear", not "Reset". Reset only undid UNCOMMITTED edits,
                which meant a reader who opened the sheet with three filters
                already applied — the exact moment you reach for it — found it
                greyed out. Clear wipes the draft and the applied snapshot
                together, so it is live whenever anything is set. */}
                <Button
                  size="$3"
                  variant="secondary"
                  onPress={clearFacets}
                  disabled={facetsAllClear}
                  data-testid="filter-clear-facets"
                >
                  Clear
                </Button>
                <Button
                  size="$3"
                  variant="primary"
                  flex={1}
                  onPress={commitFiltersSheet}
                  data-testid="filter-apply"
                >
                  {sheetCommitLabel}
                </Button>
              </BottomSheet.Footer>
            </div>
          </BottomSheet.Panel>
        </BottomSheet>
      )}
    </div>
  );
}

UniversalSearchPage.displayName = "UniversalSearchPage";

// ── Empty result bucket ──────────────────────────────────────────────────────
// One renderer for "this section has nothing", so the three narrowable buckets
// cannot drift into three different treatments.

/**
 * A miss and an empty shelf are different facts and must not share a sentence.
 * "No venues yet. Check back soon." told a reader whose query simply matched
 * nothing that the platform has no venues at all.
 */
function emptyBucketMessage(noun: string, query: string): string {
  return query
    ? `No ${noun} match "${query}".`
    : `No ${noun} yet. Check back soon.`;
}

function EmptyBucket({
  icon: Icon,
  title,
  message,
  testId,
}: {
  icon: LucideIcon;
  title: string;
  message: string;
  testId: string;
}) {
  return (
    <div style={s.sectionWrapper} data-testid={testId}>
      <div style={s.sectionHeader}>
        <Icon size={14} color={STRUCTURAL} aria-hidden />
        <h2 style={s.sectionTitle}>{title}</h2>
      </div>
      <p style={s.emptyState}>{message}</p>
    </div>
  );
}
