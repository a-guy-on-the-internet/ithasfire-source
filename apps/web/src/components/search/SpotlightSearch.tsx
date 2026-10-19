"use client";

/**
 * SpotlightSearch — Full-screen search overlay (⌘+K)
 *
 * A context-aware search overlay that adapts to the current route:
 *   - consumer: searches events, people, places, organisations
 *     (`search.autocomplete` — the public Meilisearch discovery projection)
 *   - admin: searches events (incl. DRAFTS), attendees and venues inside ONE
 *     org/human scope (`search.adminOrgSearch` — live repos)
 *   - platform: falls through to the consumer search on purpose (FR-010) —
 *     it queries the public projection, where the consumer labels are accurate
 *
 * Renders as a fixed overlay with backdrop, search input, filter pills,
 * grouped results, and full keyboard navigation.
 *
 * ── Swiss International Style ──────────────────────────────────────────
 *   No border-radius. Thick structural borders. Uppercase labels.
 *   Orange for action, structural ink for structure.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { keepPreviousData } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import { useRouter } from "@bprogress/next/app";
import {
  Search,
  X,
  Calendar,
  MapPin,
  User,
  Users,
  Building2,
  ArrowRight,
  Navigation,
  Crosshair,
  Receipt,
} from "lucide-react";
import {
  useFormatters,
  useNotify,
  useTranslations,
  type UnifiedSearchSuggestion,
} from "@th/ui";
import { guardedNavigate } from "@/hooks/navigation-guard";
import { useSurpriseMe } from "@/hooks/useSurpriseMe";
import { useCyclingPlaceholder } from "@/hooks/useCyclingPlaceholder";
import { ACCENT, ACCENT_FILL, ON_ACCENT_FILL, STRUCTURAL } from "@/lib/design-tokens";
import { trpc } from "@/trpc";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useUserLocation } from "@/hooks/user-location/useUserLocation";
import { useImperial } from "@/hooks/useImperial";
import { useCurrentAdminOwner } from "@/hooks/useCurrentAdminOwner";
import { SpotlightAdminFacets } from "./SpotlightAdminFacets";
import {
  EMPTY_ADMIN_FACETS,
  EVENT_STATUS_LABEL_KEY,
  ADMIN_GROUPS,
  ADMIN_GROUP_LABEL_KEY,
  ADMIN_RESULT_GROUP_LABEL_KEY,
  appendAdminFacetParams,
  buildAdminFacetInput,
  hasActiveAdminFacets,
  type AdminEventStatus,
  type AdminFacetState,
  type AdminGroup,
  type AdminResultGroup,
} from "./spotlight-admin-facets";
import {
  adminOrderRowHref,
  formatOrderRowSubtitle,
  formatOrderRowTitle,
} from "./admin-order-row";
import { styles } from "./spotlight-styles";
import {
  DEFAULT_RADIUS_KM,
  formatRadiusLabel,
  isWorldwideRadius,
  kmToSliderValue,
  normalizeRadiusForUnit,
  radiusSliderConfig,
  sliderValueToKm,
} from "@/lib/search/radius";
import LocationAutocomplete, {
  type PlaceDetail,
} from "@/components/maps/LocationAutocomplete";

import {
  useSpotlightSnapshot,
  closeSpotlight,
  setContextQuery,
  detectSearchContext,
} from "./spotlight-store";

// ── Constants ────────────────────────────────────────────────────────────────

const MIN_QUERY_LENGTH = 2;
const AUTOCOMPLETE_LIMIT = 8;
/**
 * Admin per-group cap. `adminOrgSearch` applies `limit` to EACH of its three
 * repo queries, so 10 is up to 30 rows in a 560px-tall overlay — dense enough
 * to be useful, well under the spec's ≤50 spotlight ceiling, and "View all"
 * hands off to /admin/[slug]/search (limit 50) for the long tail.
 */
const ADMIN_RESULT_LIMIT = 10;
const DEBOUNCE_MS = 700;

/** Duration (ms) for the open/close animation. */
const ANIMATION_MS = 200;

// ── Geo radius ───────────────────────────────────────────────────────────────
// Distance constants + label/sentinel logic come from the shared radius module
// so the overlay search, the full search filter, and the Surprise Me page never
// drift. 5–500 km are real distances; the top stop ("Worldwide") drops the geo
// filter entirely. There is no "nationwide" concept.
/**
 * The slider fires onChange dozens of times per drag, and each change re-keys
 * the tRPC query (fresh fetch + reordered list). Hold the fetch back so the
 * thumb stays responsive while the results section settles instead of
 * flickering on every tick.
 */
const GEO_RADIUS_DEBOUNCE_MS = 800;

// ── Type metadata ────────────────────────────────────────────────────────────

const TYPE_ICON: Record<string, typeof Calendar> = {
  event: Calendar,
  human: User,
  place: MapPin,
  organization: Building2,
};

/**
 * Consumer/platform entity labels. These were hardcoded English literals
 * sitting next to translated chrome, so an es user read "Todo" beside
 * "Events" (FR-009). The en strings are byte-identical to what shipped.
 */
const TYPE_LABEL_KEY: Record<SuggestionType, string> = {
  event: "spotlight.typeEvents",
  human: "spotlight.typePeople",
  place: "spotlight.typePlaces",
  organization: "spotlight.typeGroups",
};

/** Announcement keys for the polite live region (NFR-003). */
const TYPE_COUNT_KEY: Record<SuggestionType, string> = {
  event: "spotlight.countEvents",
  human: "spotlight.countPeople",
  place: "spotlight.countPlaces",
  organization: "spotlight.countGroups",
};

/**
 * Admin context groups — the three `search.adminOrgSearch` actually owns.
 * "Groups" is gone: org documents were never org-scoped (the Meili org filter
 * only constrains event docs), so that pill returned GLOBAL organisations and
 * dead-ended at /settings.
 */
const ADMIN_RESULT_GROUP_ICON: Record<AdminResultGroup, typeof Calendar> = {
  order: Receipt,
  event: Calendar,
  attendee: Users,
  venue: MapPin,
};

const ADMIN_RESULT_GROUP_COUNT_KEY: Record<AdminResultGroup, string> = {
  order: "spotlight.countOrders",
  event: "spotlight.countEvents",
  attendee: "spotlight.countAttendees",
  venue: "spotlight.countVenues",
};


// ── Admin row model ──────────────────────────────────────────────────────────

/**
 * `search.adminOrgSearch` returns four differently-shaped results, none of
 * which is a `UnifiedSearchSuggestion`. This is the row model the overlay
 * renders and navigates on.
 */
type AdminRow =
  | {
      kind: "event";
      /** React key — never the raw id, so the groups can't collide. */
      key: string;
      id: string;
      title: string;
      subtitle: string | null;
    }
  | {
      kind: "attendee";
      key: string;
      title: string;
      subtitle: string | null;
      /** What /orders?q= filters on — the email when the buyer has one. */
      filterValue: string;
    }
  | { kind: "venue"; key: string; title: string; subtitle: string | null }
  | {
      kind: "order";
      key: string;
      title: string;
      subtitle: string | null;
      /** Pre-resolved by `adminOrderRowHref` — see its note on `?q=`. */
      href: string;
    };

type Translate = ReturnType<typeof useTranslations>;
type FormatDate = ReturnType<typeof useFormatters>["dateTime"];

/**
 * Event row subtitle: the STATUS when it isn't PUBLISHED (the whole point of
 * the backend switch — a draft must be visibly a draft) plus the date.
 *
 * The date goes through the translator's formatter, not
 * `toLocaleDateString(undefined, …)` — the latter reads the BROWSER locale,
 * which would print an English month inside the one feature whose point
 * (FR-009) is that the app locale drives what the user reads.
 */
function formatEventSubtitle(
  event: { status: AdminEventStatus; startsAt: Date | string | null },
  t: Translate,
  formatDate: FormatDate,
): string | null {
  const parts: string[] = [];
  if (event.status !== "PUBLISHED") {
    parts.push(String(t(EVENT_STATUS_LABEL_KEY[event.status])));
  }
  if (event.startsAt) {
    const date = new Date(event.startsAt);
    if (!Number.isNaN(date.getTime())) {
      parts.push(
        formatDate(date, {
          month: "short",
          day: "numeric",
          year: "numeric",
        }),
      );
    }
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

// ── Component ────────────────────────────────────────────────────────────────

type SuggestionType = "event" | "human" | "place" | "organization";

const FILTER_OPTIONS: SuggestionType[] = [
  "event",
  "human",
  "place",
  "organization",
];

export function SpotlightSearch() {
  const { isOpen, consumerQuery, adminQuery, platformQuery } =
    useSpotlightSnapshot();
  const pathname = usePathname();
  const appRouter = useRouter();
  // Every navigation the palette makes (Enter on a row is not a link click)
  // goes through the page's unsaved-changes guard, if one is mounted.
  const router = useMemo(
    () => ({
      push: (href: string) => guardedNavigate(() => appRouter.push(href)),
    }),
    [appRouter],
  );
  const t = useTranslations();
  const { dateTime: formatDate, currency: formatCurrency } = useFormatters();
  const isMobile = useIsMobile();
  const { toast } = useNotify();
  const { roll, isRolling } = useSurpriseMe();

  const context = useMemo(() => detectSearchContext(pathname), [pathname]);

  // Read the query for the current context so spotlight opens with it.
  const contextQuery = useMemo(() => {
    if (context === "admin") return adminQuery;
    if (context === "platform") return platformQuery;
    return consumerQuery;
  }, [context, consumerQuery, adminQuery, platformQuery]);

  // ── Admin scope (org / human) ──────────────────────────────────────
  const adminSlug = useMemo(() => {
    if (context !== "admin") return "";
    const match = pathname.match(/^\/admin\/([^/]+)/);
    return match?.[1] ?? "";
  }, [context, pathname]);

  const { currentOwner: adminOwner } = useCurrentAdminOwner(adminSlug);

  /**
   * `search.adminOrgSearch`'s owner scope — the SAME mapping
   * /admin/[slug]/search performs, so the overlay and the full page agree on
   * what exists. (The old `{ orgId, publishedOnly: false }` shape belonged to
   * `unifiedSearch.autocompleteAdmin`, whose corpus — the discovery projection
   * — structurally never contained a draft to unhide.)
   */
  const adminOwnerScope = useMemo(() => {
    if (context !== "admin" || !adminOwner) return null;
    return adminOwner.kind === "org"
      ? { ownerType: "ORGANIZATION" as const, ownerId: adminOwner.orgId }
      : { ownerType: "HUMAN" as const, ownerId: adminOwner.humanId };
  }, [context, adminOwner]);

  // ── Local state ────────────────────────────────────────────────────
  const [query, setQuery] = useState(contextQuery);
  const [debouncedQuery, setDebouncedQuery] = useState(contextQuery);
  const [activeFilter, setActiveFilter] = useState<SuggestionType | null>(null);
  const [activeAdminGroup, setActiveAdminGroup] = useState<AdminGroup | null>(
    null,
  );
  const [adminFacets, setAdminFacets] =
    useState<AdminFacetState>(EMPTY_ADMIN_FACETS);
  const [activeIndex, setActiveIndex] = useState(-1);

  const isAdmin = context === "admin";
  const listboxId = useId();

  // ── Cycling placeholder (consumer/platform only) ───────────────────
  // Advertise the three entity types the consumer search spans by cycling the
  // empty-state placeholder events → venues → people. Admin search spans a
  // different set (orders / attendees), so it keeps its static placeholder.
  const isConsumerContext = context !== "admin";
  const cyclingPhrases = useMemo(
    () => [
      String(t("search.placeholderEvents")),
      String(t("search.placeholderVenues")),
      String(t("search.placeholderPeople")),
    ],
    [t],
  );
  // Only feed values while the overlay is open and the box is empty, so the
  // interval isn't running app-wide behind a closed overlay and the placeholder
  // yields to what the user is typing.
  const queryIsEmpty = query.trim().length === 0;
  const cyclingPlaceholder = useCyclingPlaceholder(
    isOpen && isConsumerContext && queryIsEmpty ? cyclingPhrases : [],
  );

  // ── Animation state ────────────────────────────────────────────────
  // `mounted` keeps the DOM alive while the exit animation plays out.
  // `animIn` drives the CSS transition: false → opening (pre-enter),
  // true → visible, false again → closing.
  const [mounted, setMounted] = useState(false);
  const [animIn, setAnimIn] = useState(false);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The pending enter-transition frame (outer or inner rAF — only one is ever
  // outstanding). Cancelled on close: a ⌘K⌘K faster than two frames would
  // otherwise land `setAnimIn(true)` AFTER the close set it false, leaving a
  // closed overlay visible and clickable (`pointerEvents` follows `animIn`)
  // until the exit timer unmounts it.
  const enterFrameRef = useRef<number | null>(null);

  useEffect(() => {
    if (isOpen) {
      // Opening: mount immediately, kick the enter transition next frame.
      if (exitTimerRef.current) {
        clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
      setMounted(true);
      // Double-rAF ensures the browser paints the initial (hidden) frame
      // before we flip to the visible state, so the transition fires.
      enterFrameRef.current = requestAnimationFrame(() => {
        enterFrameRef.current = requestAnimationFrame(() => {
          enterFrameRef.current = null;
          setAnimIn(true);
        });
      });
    } else {
      // Closing: start the exit transition, unmount after it finishes. Not
      // gated on `mounted`: this closure's `mounted` can still read false when
      // a close lands before the open's `setMounted(true)` render committed,
      // and skipping here then left the overlay mounted (invisible, but an
      // `aria-modal` dialog in the DOM) with no timer to remove it. With
      // nothing mounted the timer below is a no-op `setMounted(false)`.
      if (enterFrameRef.current !== null) {
        cancelAnimationFrame(enterFrameRef.current);
        enterFrameRef.current = null;
      }
      setAnimIn(false);
      exitTimerRef.current = setTimeout(() => {
        setMounted(false);
        exitTimerRef.current = null;
      }, ANIMATION_MS + 20);
    }
    return () => {
      if (exitTimerRef.current) {
        clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
      if (enterFrameRef.current !== null) {
        cancelAnimationFrame(enterFrameRef.current);
        enterFrameRef.current = null;
      }
    };
  }, [isOpen]); // intentionally only depends on isOpen

  // ── Geo state ──────────────────────────────────────────────────────
  const [showGeoPanel, setShowGeoPanel] = useState(false);
  const [geoLocation, setGeoLocation] = useState<{
    lat: number;
    lng: number;
    label: string;
  } | null>(null);
  const [geoRadiusKm, setGeoRadiusKm] = useState(DEFAULT_RADIUS_KM);
  const [locationQuery, setLocationQuery] = useState("");
  const [imperial, toggleImperial] = useImperial();
  const {
    coords: browserCoords,
    loading: geoLoading,
    error: geoError,
    request: requestGeo,
  } = useUserLocation();

  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Sync query from the store when opening.
  useEffect(() => {
    if (isOpen) {
      setQuery(contextQuery);
      setDebouncedQuery(contextQuery);
      setActiveIndex(-1);
      // The component instance never unmounts (it returns null when closed),
      // so facet state would otherwise outlive the session that set it: a
      // Monday-morning "Upcoming" anchor still means `startsAt >= Mon 09:00`
      // on Wednesday, and ⌘K on an empty box would open straight into a
      // filtered browse instead of the idle hint.
      setAdminFacets(EMPTY_ADMIN_FACETS);
    }
  }, [isOpen, contextQuery]);

  // Seat focus in the input once the portal has actually COMMITTED. This used
  // to be a double-rAF fired from the open effect above, racing the
  // `setMounted(true)` render the animation effect kicks off in the same pass:
  // whenever that render took longer than two frames (a dev build, a slow
  // phone, 320px every time when measured) `inputRef.current` was still null,
  // and the overlay opened with focus left on <body>. Keyed on `mounted`, this
  // runs after the commit that created the input; on a reopen during the exit
  // animation `mounted` is already true and `isOpen` re-runs it.
  useEffect(() => {
    if (!isOpen || !mounted) return;
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [isOpen, mounted]);

  // The context `query` was typed in. Captured while the overlay is OPEN so a
  // later navigation cannot re-attribute it: `query` is local state that
  // survives a close (only OPEN resets it), so an effect keyed on `context`
  // would re-run on the admin→consumer switch and copy the admin query into
  // the consumer slot. Verified: searching "ORD-4F2A refund" in admin and
  // taking the switcher's exit-to-attendee put that string in the PUBLIC
  // navbar.
  const queryContextRef = useRef(context);
  useEffect(() => {
    if (isOpen) queryContextRef.current = context;
  }, [isOpen, context]);

  // Persist the last typed query when the spotlight closes so the navbar and
  // other UI can display the user's most recent search. We trim the value and
  // avoid writing empty strings. Fires ONLY on the open→closed edge, never on
  // an unrelated re-render, so the write happens once with the context the
  // user actually typed in.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const closing = wasOpenRef.current && !isOpen;
    wasOpenRef.current = isOpen;
    if (!closing) return;
    const trimmed = query.trim();
    if (trimmed.length > 0) {
      setContextQuery(queryContextRef.current, trimmed);
    }
  }, [isOpen, query]);

  // Return focus where it came from. The overlay is an aria-modal dialog, so
  // closing it must not drop focus on <body>: opened from the navbar trigger,
  // focus goes back to the trigger; opened with ⌘K over the alerts panel, it
  // goes back into the panel (whose boundary trap would otherwise have to
  // fish it out of the page on the next Tab). Captured synchronously on open,
  // before the post-mount effect's rAF seats focus in the input. Only restored while
  // focus is still ours (in the overlay, or fallen to <body>) — a close
  // caused by focusing something else leaves that choice alone.
  const backdropRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (isOpen) {
      const active = document.activeElement;
      returnFocusRef.current =
        active instanceof HTMLElement && active !== document.body
          ? active
          : null;
      return;
    }
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    if (!target || !target.isConnected) return;
    const active = document.activeElement;
    const focusIsOurs =
      !active ||
      active === document.body ||
      !!backdropRef.current?.contains(active);
    if (focusIsOurs) target.focus({ preventScroll: true });
  }, [isOpen]);

  // Lock body scroll when open.
  useEffect(() => {
    if (!isOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isOpen]);

  // ── Debounced search query ─────────────────────────────────────────
  const handleQueryChange = useCallback((value: string) => {
    setQuery(value);
    setActiveIndex(-1);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(value.trim());
    }, DEBOUNCE_MS);
  }, []);

  // Cleanup debounce on unmount.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // ── Geo handlers ───────────────────────────────────────────────────
  const handleToggleGeoPanel = useCallback(() => {
    setShowGeoPanel((prev) => !prev);
  }, []);

  const handleUseMyLocation = useCallback(() => {
    if (browserCoords) {
      setGeoLocation({
        lat: browserCoords.lat,
        lng: browserCoords.lng,
        label: "My location",
      });
      setLocationQuery("");
    } else {
      requestGeo();
    }
  }, [browserCoords, requestGeo]);

  // When browser coords resolve after request, set location
  useEffect(() => {
    if (!geoLoading && browserCoords && showGeoPanel && !geoLocation) {
      setGeoLocation({
        lat: browserCoords.lat,
        lng: browserCoords.lng,
        label: "My location",
      });
    }
  }, [browserCoords, geoLoading, showGeoPanel, geoLocation]);

  const handleLocationSelect = useCallback((place: PlaceDetail) => {
    if (place.lat != null && place.lng != null) {
      setGeoLocation({
        lat: place.lat,
        lng: place.lng,
        label: place.formattedAddress ?? place.name ?? "Selected location",
      });
    }
  }, []);

  const handleClearGeo = useCallback(() => {
    setGeoLocation(null);
    setLocationQuery("");
  }, []);

  const radiusDisplayLabel = useMemo(
    () => formatRadiusLabel(geoRadiusKm, { imperial, t }),
    [geoRadiusKm, imperial, t],
  );

  // Slider widget presents unit-appropriate stops (mi grid for imperial); state
  // stays canonical km (and so does the geoFilter). When the unit flips (async
  // auto-detect or the km/mi toggle below) snap the current km onto the new
  // unit's grid. Ref-guarded so it never runs on mount or loops.
  const prevImperial = useRef(imperial);
  useEffect(() => {
    if (prevImperial.current === imperial) return;
    prevImperial.current = imperial;
    setGeoRadiusKm((km) => normalizeRadiusForUnit(km, imperial));
  }, [imperial]);

  const sliderConfig = radiusSliderConfig(imperial);

  // ── tRPC query ─────────────────────────────────────────────────────
  const trimmed = debouncedQuery.trim();

  // ── Admin facets (FR-004/FR-005) ───────────────────────────────────
  /**
   * Facets are EVENTS-ONLY. When the entity pill is pinned to attendees or
   * venues the events group isn't fetched at all, so a `statuses` key would
   * ride the wire meaning nothing while the UI showed a lit "Status: Drafts"
   * above rows it never touched. Gate the whole facet surface on this: the row
   * is hidden, the keys are stripped, and the "View all" hand-off drops them
   * too. The facet STATE survives — go back to All/Events and it's still set.
   */
  const facetsApply =
    isAdmin && (activeAdminGroup === null || activeAdminGroup === "event");

  // Never sent as empty arrays — a cleared facet drops its key (the input
  // schema marks every array facet `.nonempty()`).
  const adminFacetInput = useMemo(
    () => (facetsApply ? buildAdminFacetInput(adminFacets) : {}),
    [facetsApply, adminFacets],
  );
  const adminFacetsActive = facetsApply && hasActiveAdminFacets(adminFacets);

  /**
   * Facet-only intent: "Drafts" with an empty box is a filtered browse, the
   * same way a picked location already is. Attendees/venues stay query-driven,
   * so this fetches events ONLY — and `facetsApply` above is what keeps
   * "Attendees + Drafts + empty box" from becoming an unfiltered order dump.
   */
  const facetOnlyIntent =
    adminFacetsActive && trimmed.length < MIN_QUERY_LENGTH;

  /**
   * A picked location is a CONSUMER intent only (FR-007).
   *
   * `geoLocation` is state on an overlay that never unmounts, so it survives a
   * client navigation out of consumer context. Un-gated it meant: pick a
   * location, walk into /admin/{slug}/*, open ⌘K, type nothing — and
   * `adminOrgSearch` fired with an empty query and no `types`, dumping the
   * org's events, buyers and venues on open. The geo pill is already hidden in
   * admin, so the user could not even see what was driving it.
   */
  const geoIsIntent = !isAdmin && !!geoLocation;

  // With an empty box a picked location browses by distance (proximity orders
  // the rows within each type and the types interleave), so sliding the radius
  // re-queries even before the user types anything.
  const isSearching =
    trimmed.length >= MIN_QUERY_LENGTH || geoIsIntent || facetOnlyIntent;

  // Debounce the radius so a drag doesn't spam the backend / thrash the list.
  const debouncedRadiusKm = useDebouncedValue(geoRadiusKm, GEO_RADIUS_DEBOUNCE_MS);

  // Map the slider position to a real query filter:
  //   - "Worldwide" → drop the geo filter entirely (all events globally),
  //     rather than sending a fake radius that scopes results to a city.
  //   - anything else → the literal radius (5–500 km).
  const geoFilter = useMemo(() => {
    if (!geoLocation) return undefined;
    if (isWorldwideRadius(debouncedRadiusKm)) return undefined;
    return {
      lat: geoLocation.lat,
      lng: geoLocation.lng,
      radiusKm: debouncedRadiusKm,
    };
  }, [geoLocation, debouncedRadiusKm]);

  /**
   * Consumer/platform input — UNCHANGED (NFR-005 pins it byte-identical).
   * The admin path needs a different shape entirely, so it builds its own
   * object below rather than spreading onto this one.
   */
  const baseSearchInput = useMemo(
    () => ({
      query: trimmed,
      limit: AUTOCOMPLETE_LIMIT,
      ...(activeFilter ? { types: [activeFilter] } : {}),
      ...(geoFilter ? { geo: geoFilter } : {}),
    }),
    [trimmed, activeFilter, geoFilter],
  );

  const consumerSearchQuery = trpc.search.autocomplete.useQuery(
    baseSearchInput,
    {
      enabled: isOpen && isSearching && context !== "admin",
      staleTime: 30_000,
      placeholderData: keepPreviousData,
    },
  );

  /**
   * Result groups to fetch. A deselected pill's repo query genuinely does not
   * fire; "All" omits the key entirely (never `["event","attendee","venue"]`,
   * and never `[]` — the schema rejects an empty array).
   */
  const adminTypes = useMemo<AdminGroup[] | undefined>(() => {
    if (!isAdmin) return undefined;
    if (facetOnlyIntent) return ["event"];
    return activeAdminGroup ? [activeAdminGroup] : undefined;
  }, [isAdmin, facetOnlyIntent, activeAdminGroup]);

  const adminSearchInput = useMemo(
    () => ({
      ownerType: adminOwnerScope?.ownerType ?? ("ORGANIZATION" as const),
      ownerId: adminOwnerScope?.ownerId ?? "",
      query: trimmed,
      limit: ADMIN_RESULT_LIMIT,
      ...(adminTypes ? { types: adminTypes } : {}),
      ...adminFacetInput,
    }),
    [adminOwnerScope, trimmed, adminTypes, adminFacetInput],
  );

  const adminSearchQuery = trpc.search.adminOrgSearch.useQuery(
    adminSearchInput,
    {
      enabled: isOpen && isSearching && isAdmin && !!adminOwnerScope,
      staleTime: 30_000,
      // NFR-004: a facet flip must never blank the list.
      placeholderData: keepPreviousData,
    },
  );

  const searchQuery = isAdmin ? adminSearchQuery : consumerSearchQuery;

  const suggestions = useMemo<UnifiedSearchSuggestion[]>(() => {
    if (isAdmin) return [];
    return (consumerSearchQuery.data?.suggestions ??
      []) as UnifiedSearchSuggestion[];
  }, [isAdmin, consumerSearchQuery.data]);

  // ── Grouped results ────────────────────────────────────────────────
  const groupedResults = useMemo(() => {
    const groups = new Map<SuggestionType, UnifiedSearchSuggestion[]>();
    for (const s of suggestions) {
      const list = groups.get(s.type) ?? [];
      list.push(s);
      groups.set(s.type, list);
    }
    return groups;
  }, [suggestions]);

  // Flat list for keyboard navigation.
  const flatResults = useMemo(() => {
    const flat: UnifiedSearchSuggestion[] = [];
    for (const [, items] of groupedResults) {
      flat.push(...items);
    }
    return flat;
  }, [groupedResults]);

  // ── Admin rows ─────────────────────────────────────────────────────
  // `adminOrgSearch` returns three typed arrays, not `{ suggestions }` — map
  // them onto a local row model rather than bending them into the consumer's
  // `UnifiedSearchSuggestion` (whose fields simply don't line up).
  const adminGroups = useMemo<
    { group: AdminResultGroup; rows: AdminRow[] }[]
  >(() => {
    if (!isAdmin) return [];
    const data = adminSearchQuery.data;
    if (!data) return [];

    /**
     * FR-012. `order` is null for ALL FOUR no-result reasons on purpose (not
     * id-shaped / no match / actor lacks finance / group filtered out) — they
     * are indistinguishable by design (NFR-002). A null order therefore renders
     * NOTHING: no "no order found", no "you can't see orders". Adding either
     * message would turn a security property back into an oracle.
     */
    const orders: AdminRow[] = data.order
      ? [
          {
            kind: "order" as const,
            key: `order:${data.order.id}`,
            title: formatOrderRowTitle(data.order),
            subtitle: formatOrderRowSubtitle(data.order, t, {
              currency: formatCurrency,
              dateTime: formatDate,
            }),
            href: adminOrderRowHref(adminSlug, data.order),
          },
        ]
      : [];

    const events: AdminRow[] = data.events.map((event) => ({
      kind: "event" as const,
      key: `event:${event.id}`,
      id: event.id,
      title: event.title ?? String(t("spotlight.untitledEvent")),
      subtitle: formatEventSubtitle(event, t, formatDate),
    }));

    /**
     * Row key. Guest buyers do NOT lack a `buyerHumanId` — `Order.buyerHumanId`
     * is `String` (NOT NULL) with a required `buyer Human` relation
     * (`packages/db/prisma/order.prisma:9,99`), so a guest checkout still
     * creates a Human row. (An earlier comment here claimed the opposite and
     * misdescribed the data model.)
     *
     * The trailing `index` is therefore what actually guarantees uniqueness,
     * and it alone would do. The `?? email:` arm is kept because
     * `searchOrgAdminOutputSchema` still types `buyerHumanId` as nullable —
     * it is defensive against a shape the schema currently forbids, and it
     * keeps a hypothetical null from stringifying into the key as `"null"`.
     */
    const attendees: AdminRow[] = data.attendees.flatMap((attendee, index) => {
      const label = attendee.name ?? attendee.email;
      if (!label) return [];
      const eventsLine = [
        ...attendee.eventTitles,
        ...(attendee.moreCount > 0
          ? [String(t("spotlight.moreEvents", { count: attendee.moreCount }))]
          : []),
      ].join(", ");
      return [
        {
          kind: "attendee" as const,
          key: `attendee:${attendee.buyerHumanId ?? `email:${attendee.email ?? ""}`}:${index}`,
          title: label,
          // A nameless buyer already IS their email in the title — don't
          // print it twice.
          subtitle:
            [attendee.email === label ? null : attendee.email, eventsLine]
              .filter(Boolean)
              .join(" · ") || null,
          // The orders list filters on the email when there is one — it is the
          // identifier a guest buyer actually has.
          filterValue: attendee.email ?? label,
        },
      ];
    });

    const venues: AdminRow[] = data.venues.map((venue) => ({
      kind: "venue" as const,
      key: `venue:${venue.id}`,
      title: venue.name,
      subtitle: venue.address,
    }));

    return (
      [
        // Order leads: someone who pasted an order id wants that answer
        // immediately, not below a list of loosely-matching events.
        { group: "order" as const, rows: orders },
        { group: "event" as const, rows: events },
        { group: "attendee" as const, rows: attendees },
        { group: "venue" as const, rows: venues },
      ] satisfies { group: AdminResultGroup; rows: AdminRow[] }[]
    ).filter((g) => g.rows.length > 0);
  }, [
    isAdmin,
    adminSearchQuery.data,
    adminSlug,
    t,
    formatDate,
    formatCurrency,
  ]);

  /** Flat, in render order — arrow keys traverse every group exactly as today. */
  const adminRows = useMemo(
    () => adminGroups.flatMap((g) => g.rows),
    [adminGroups],
  );

  const rowCount = isAdmin ? adminRows.length : flatResults.length;

  // ── Navigation handlers ────────────────────────────────────────────
  const navigateToSuggestion = useCallback(
    (suggestion: UnifiedSearchSuggestion) => {
      closeSpotlight();
      setContextQuery(context, query);

      // ── Consumer / platform context: route to public pages ───
      // (Admin no longer routes through here — see `navigateToAdminRow`.)
      switch (suggestion.type) {
        case "event":
          if (suggestion.slug) {
            router.push(`/events/${suggestion.slug}`);
          } else {
            router.push(
              `/search?search=${encodeURIComponent(suggestion.title)}`,
            );
          }
          break;
        case "organization":
          if (suggestion.slug) {
            router.push(`/orgs/${suggestion.slug}`);
          } else {
            router.push(
              `/search?search=${encodeURIComponent(suggestion.title)}`,
            );
          }
          break;
        case "human":
          // `profileSlug` is the /humans entity-page slug (the index only
          // contains humans with entity pages). `username` is a Better Auth
          // handle the /humans loader can NOT resolve (page slugs are
          // `{name}-{id8}`, disjoint from usernames), so a missing
          // profileSlug falls through to search rather than a 404.
          if (suggestion.profileSlug) {
            router.push(`/humans/${suggestion.profileSlug}`);
          } else {
            router.push(
              `/search?search=${encodeURIComponent(suggestion.title)}`,
            );
          }
          break;
        case "place":
          // Exactly the human case above: `pageSlug` is the /places
          // entity-page slug, the only value the single-segment
          // `/places/[slug]` route resolves on, and a place's only slug. (This
          // branch used to route on `Place.slug`, a multi-segment DIRECTORY
          // key (`us/tn/x--a1b2c3d4e5`) that route can NOT match — the source
          // of its dead links. That column is deprecated and off the payload.)
          // A venue with no entity page still has a working id page, so fall
          // through to that rather than to a bare search.
          if (suggestion.pageSlug) {
            router.push(`/places/${suggestion.pageSlug}`);
          } else {
            router.push(`/places/id/${suggestion.placeId}`);
          }
          break;
      }
    },
    [context, query, router],
  );

  /**
   * Admin result routing. The attendee row lands on the orders list
   * pre-filtered — the exact hand-off /admin/[slug]/search already uses, and
   * what the old `broadcasts ? /audiences : /dashboard` fallback was gesturing
   * at without ever getting there.
   */
  const navigateToAdminRow = useCallback(
    (row: AdminRow) => {
      closeSpotlight();
      setContextQuery("admin", query);
      if (!adminSlug) return;

      switch (row.kind) {
        case "order":
          router.push(row.href);
          return;
        case "event":
          router.push(`/admin/${adminSlug}/events/${row.id}`);
          return;
        case "attendee":
          router.push(
            `/admin/${adminSlug}/orders?q=${encodeURIComponent(row.filterValue)}`,
          );
          return;
        case "venue":
          router.push(`/admin/${adminSlug}/places`);
          return;
      }
    },
    [adminSlug, query, router],
  );

  const activateRow = useCallback(
    (index: number) => {
      if (index < 0) return;
      if (isAdmin) {
        const row = adminRows[index];
        if (row) navigateToAdminRow(row);
        return;
      }
      const suggestion = flatResults[index];
      if (suggestion) navigateToSuggestion(suggestion);
    },
    [isAdmin, adminRows, flatResults, navigateToAdminRow, navigateToSuggestion],
  );

  const handleFullSearch = useCallback(() => {
    const trimmed = query.trim();
    // Facet-only intent is a real intent: without this an admin browsing
    // "Drafts" with an empty box would click "View all" and get nothing.
    if (!trimmed && !geoIsIntent && !adminFacetsActive) return;
    closeSpotlight();
    if (trimmed) {
      setContextQuery(context, trimmed);
    }

    // Build URL params including geo if set
    const params = new URLSearchParams();
    if (trimmed) params.set("search", trimmed);
    // Same gate: otherwise a stale consumer location writes near/place/lat/
    // lng/radius into the ADMIN search URL, where the page's builder faithfully
    // preserves them as foreign keys for the rest of the session.
    if (geoIsIntent && geoLocation) {
      params.set("near", "1");
      params.set("place", geoLocation.label);
      params.set("lat", String(geoLocation.lat));
      params.set("lng", String(geoLocation.lng));
      params.set("radius", String(geoRadiusKm));
    }

    // Route to context-appropriate search page.
    if (context === "admin") {
      // Extract org slug from pathname.
      const match = pathname.match(/^\/admin\/([^/]+)/);
      const slug = match?.[1];
      if (slug) {
        const adminParams = new URLSearchParams(params);
        // Carry the active facets across (consumed in Phase B; harmless
        // extras until then). `facetsApply` gates them the same way the wire
        // does, so Phase B never receives `?type=attendee&status=DRAFT`.
        appendAdminFacetParams(
          adminParams,
          facetsApply ? adminFacets : EMPTY_ADMIN_FACETS,
          activeAdminGroup,
        );
        router.push(`/admin/${slug}/search?${adminParams.toString()}`);
        return;
      }
    }

    // Always route to the unified /search page (geo or not).
    const qs = params.toString();
    router.push(`/search${qs ? `?${qs}` : ""}`);
  }, [
    query,
    geoLocation,
    geoIsIntent,
    geoRadiusKm,
    context,
    pathname,
    router,
    adminFacets,
    adminFacetsActive,
    activeAdminGroup,
    facetsApply,
  ]);

  // ── Surprise me ────────────────────────────────────────────────────
  // Roll a random published event and go there. Scoped to the current
  // search context: an active keyword and/or a picked location narrow the
  // roll, so "Surprise me" respects whatever the user has already dialed in.
  const handleSurprise = useCallback(async () => {
    const q = query.trim();
    const filters = {
      ...(q ? { q } : {}),
      ...(geoFilter ? { near: geoFilter } : {}),
    };
    // Close first so the overlay gets out of the way while we navigate.
    closeSpotlight();
    const outcome = await roll(filters);
    if (outcome.status === "no-event") {
      toast.info({
        id: "spotlight-surprise-no-event",
        title: "Nothing to surprise you with yet",
        message: "There are no published events to pick from right now.",
      });
    } else if (outcome.status === "error") {
      toast.danger({
        id: "spotlight-surprise-error",
        title: "Could not pick an event",
        message: "Something went wrong. Please try again.",
      });
    }
  }, [query, geoFilter, roll, toast]);

  // ── Keyboard navigation ────────────────────────────────────────────
  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      const count = rowCount;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setActiveIndex((prev) => (prev < count - 1 ? prev + 1 : 0));
          break;
        case "ArrowUp":
          e.preventDefault();
          setActiveIndex((prev) => (prev > 0 ? prev - 1 : count - 1));
          break;
        case "Enter":
          e.preventDefault();
          if (activeIndex >= 0 && activeIndex < count) {
            activateRow(activeIndex);
          } else {
            handleFullSearch();
          }
          break;
        case "Escape":
          e.preventDefault();
          closeSpotlight();
          break;
        case "Tab": {
          // Cycle the CURRENT CONTEXT's pill set — admin has three groups, not
          // the module-level four, and indexing the wrong list strands the user
          // on a pill that doesn't render.
          e.preventDefault();
          if (isAdmin) {
            const currentIdx = activeAdminGroup
              ? ADMIN_GROUPS.indexOf(activeAdminGroup)
              : -1;
            const nextIdx = e.shiftKey
              ? currentIdx <= 0
                ? -1
                : currentIdx - 1
              : currentIdx + 1;
            setActiveAdminGroup(
              nextIdx < 0 || nextIdx >= ADMIN_GROUPS.length
                ? null
                : ADMIN_GROUPS[nextIdx],
            );
            break;
          }
          const currentIdx = activeFilter
            ? FILTER_OPTIONS.indexOf(activeFilter)
            : -1;
          const nextIdx = e.shiftKey
            ? currentIdx <= 0
              ? -1
              : currentIdx - 1
            : currentIdx + 1;
          setActiveFilter(
            nextIdx < 0 || nextIdx >= FILTER_OPTIONS.length
              ? null
              : FILTER_OPTIONS[nextIdx],
          );
          break;
        }
      }
    },
    [
      rowCount,
      activeIndex,
      activateRow,
      handleFullSearch,
      activeFilter,
      activeAdminGroup,
      isAdmin,
    ],
  );

  // A facet flip can shrink the list under the cursor. Drop the highlight
  // rather than leave aria-activedescendant pointing at a row that's gone.
  useEffect(() => {
    if (activeIndex >= rowCount) setActiveIndex(-1);
  }, [activeIndex, rowCount]);

  // Scroll active result into view.
  useEffect(() => {
    if (activeIndex < 0 || !resultsRef.current) return;
    const items = resultsRef.current.querySelectorAll("[data-spotlight-item]");
    items[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  // ── Backdrop click ─────────────────────────────────────────────────
  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      closeSpotlight();
    }
  }, []);

  // ── Render ──────────────────────────────────────────────────────────
  if (!mounted) return null;

  // `isTyping` is true between the moment the user enters a non-empty query
  // and the moment the debounce settles. We surface the loading state during
  // this window — the user wants visible feedback the instant they start
  // typing rather than waiting on the debounce + fetch round-trip.
  const isTyping =
    query.trim().length > 0 && query.trim() !== debouncedQuery.trim();
  const isLoading = isTyping || (isSearching && searchQuery.isFetching);
  const hasResults = rowCount > 0;
  // Hide stale results while typing so the loader takes over cleanly.
  const showResults = hasResults && !isTyping;
  const showEmpty = isSearching && !isLoading && !hasResults;
  const showIdle = !isLoading && !isSearching;

  /** Polite count announcement, emitted once the list settles (NFR-003). */
  const announcement = !showResults
    ? ""
    : (isAdmin
        ? adminGroups.map((g) =>
            String(
              t(ADMIN_RESULT_GROUP_COUNT_KEY[g.group], {
                count: g.rows.length,
              }),
            ),
          )
        : Array.from(groupedResults.entries()).map(([type, items]) =>
            String(t(TYPE_COUNT_KEY[type], { count: items.length })),
          )
      ).join(", ");

  // Clamp at the point of computation, not just in the reset effect below —
  // a facet flip that shrinks the list would otherwise point
  // aria-activedescendant at a removed row for one paint.
  const activeRowId =
    activeIndex >= 0 && activeIndex < rowCount
      ? `${listboxId}-row-${activeIndex}`
      : undefined;

  const pillStyle: CSSProperties = {
    ...styles.pill,
    ...(isMobile ? styles.pillMobile : {}),
  };

  return createPortal(
    <>
      {/* Keyframes for loading + result-list transitions. */}
      <style>{`
				@keyframes spotlight-pulse {
					0%, 100% { opacity: 0.3; }
					50% { opacity: 1; }
				}
				@keyframes spotlight-slide-in {
					from { opacity: 0; transform: translateY(-6px); }
					to   { opacity: 1; transform: translateY(0); }
				}
				@keyframes spotlight-shimmer {
					0%   { background-position: -200% 0; }
					100% { background-position: 200% 0; }
				}
				.spotlight-results-anim > * {
					animation: spotlight-slide-in 220ms cubic-bezier(0.4, 0, 0.2, 1) both;
				}
				.spotlight-results-anim > *:nth-child(2) { animation-delay: 30ms; }
				.spotlight-results-anim > *:nth-child(3) { animation-delay: 60ms; }
				.spotlight-results-anim > *:nth-child(4) { animation-delay: 90ms; }
				.spotlight-skeleton {
					background: linear-gradient(
						90deg,
						rgba(33,28,22,0.04) 0%,
						rgba(33,28,22,0.10) 50%,
						rgba(33,28,22,0.04) 100%
					);
					background-size: 200% 100%;
					animation: spotlight-shimmer 1.4s ease-in-out infinite;
				}
				@media (prefers-reduced-motion: reduce) {
					.spotlight-results-anim > *,
					.spotlight-skeleton {
						animation: none !important;
					}
				}
			`}</style>

      <div
        style={{
          ...styles.backdrop,
          // On mobile, kill the padding so the sheet hits the viewport
          // edges; on desktop keep the floating-card gutter.
          ...(isMobile ? { padding: 0, paddingTop: 0 } : {}),
          opacity: animIn ? 1 : 0,
          transition: `opacity ${ANIMATION_MS}ms ease`,
          pointerEvents: animIn ? "auto" : "none",
        }}
        ref={backdropRef}
        onClick={handleBackdropClick}
        role="dialog"
        aria-modal="true"
        aria-label={String(t("spotlight.title"))}
        data-testid="spotlight-backdrop"
      >
        <div
          style={{
            ...styles.panel,
            // Full-screen on mobile (no floating card; behaves like
            // a native search sheet). Floating card on desktop.
            ...(isMobile
              ? {
                  maxWidth: "100%",
                  maxHeight: "100dvh",
                  height: "100dvh",
                  borderWidth: 0,
                }
              : {}),
            opacity: animIn ? 1 : 0,
            transform: animIn
              ? "translateY(0)"
              : isMobile
                ? "translateY(8px)"
                : "translateY(-16px) scale(0.98)",
            transition: `opacity ${ANIMATION_MS}ms cubic-bezier(0.4,0,0.2,1), transform ${ANIMATION_MS}ms cubic-bezier(0.4,0,0.2,1)`,
          }}
          data-testid="spotlight-panel"
        >
          {/* ── Input row ────────────────────────────────────────── */}
          <div style={styles.inputRow}>
            <Search size={18} color={STRUCTURAL} strokeWidth={2.5} />
            <input
              ref={inputRef}
              style={styles.input}
              type="text"
              value={query}
              onChange={(e) => handleQueryChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                // Consumer/platform: cycle events → venues → people while the
                // box is empty; fall back to the static copy otherwise.
                isConsumerContext && queryIsEmpty && cyclingPlaceholder
                  ? cyclingPlaceholder
                  : isMobile
                    ? String(t("spotlight.searchShort"))
                    : String(
                        t(
                          context === "admin"
                            ? "spotlight.adminPlaceholder"
                            : "spotlight.placeholder",
                        ),
                      )
              }
              // Keep the accessible name stable so the animating placeholder is
              // never re-announced as the input's name.
              aria-label={String(
                t(
                  context === "admin"
                    ? "spotlight.adminPlaceholder"
                    : "search.placeholderCycleLabel",
                ),
              )}
              data-testid="spotlight-input"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              // Combobox pattern: the input owns focus, the listbox below is
              // driven by aria-activedescendant (rows are not tab stops).
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={showResults}
              aria-controls={showResults ? listboxId : undefined}
              aria-activedescendant={showResults ? activeRowId : undefined}
            />
            {isLoading && (
              <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
                <div style={{ ...styles.loadingDot, animationDelay: "0ms" }} />
                <div
                  style={{ ...styles.loadingDot, animationDelay: "150ms" }}
                />
                <div
                  style={{ ...styles.loadingDot, animationDelay: "300ms" }}
                />
              </div>
            )}
            <button
              type="button"
              style={styles.closeButton}
              onClick={() => closeSpotlight()}
              aria-label={String(t("spotlight.close"))}
              data-testid="spotlight-close"
            >
              <X size={16} strokeWidth={2.5} />
            </button>
          </div>

          {/* ── Entity pills ─────────────────────────────────────── */}
          <div style={styles.pillsRow}>
            <button
              type="button"
              style={{
                ...pillStyle,
                ...((isAdmin ? activeAdminGroup : activeFilter) === null
                  ? styles.pillActive
                  : {}),
              }}
              aria-pressed={(isAdmin ? activeAdminGroup : activeFilter) === null}
              onClick={() =>
                isAdmin ? setActiveAdminGroup(null) : setActiveFilter(null)
              }
              data-testid="spotlight-filter-all"
            >
              {String(t("spotlight.filterAll"))}
            </button>

            {isAdmin
              ? ADMIN_GROUPS.map((group) => {
                  const Icon = ADMIN_RESULT_GROUP_ICON[group];
                  const isActive = activeAdminGroup === group;
                  return (
                    <button
                      key={group}
                      type="button"
                      style={{
                        ...pillStyle,
                        ...(isActive ? styles.pillActive : {}),
                      }}
                      aria-pressed={isActive}
                      onClick={() =>
                        setActiveAdminGroup(isActive ? null : group)
                      }
                      data-testid={`spotlight-filter-${group}`}
                    >
                      <Icon size={12} strokeWidth={2.5} aria-hidden />
                      {String(t(ADMIN_GROUP_LABEL_KEY[group]))}
                    </button>
                  );
                })
              : FILTER_OPTIONS.map((type) => {
                  const Icon = TYPE_ICON[type] ?? Search;
                  const isActive = activeFilter === type;
                  return (
                    <button
                      key={type}
                      type="button"
                      style={{
                        ...pillStyle,
                        ...(isActive ? styles.pillActive : {}),
                      }}
                      aria-pressed={isActive}
                      onClick={() => setActiveFilter(isActive ? null : type)}
                      data-testid={`spotlight-filter-${type}`}
                    >
                      <Icon size={12} strokeWidth={2.5} aria-hidden />
                      {String(t(TYPE_LABEL_KEY[type]))}
                    </button>
                  );
                })}

            {/* Location toggle pill — consumer/platform only (FR-007). Geo is
                org-implicit in admin, and the live-repo backend has no geo
                filter to honour anyway. The divider goes with it. */}
            {!isAdmin && (
              <>
                <span
                  style={{
                    width: 1,
                    height: 20,
                    backgroundColor: "var(--borderColor, #211C16)",
                    flexShrink: 0,
                  }}
                />
                <button
                  type="button"
                  style={{
                    ...pillStyle,
                    ...(showGeoPanel || geoLocation ? styles.pillActive : {}),
                    ...(geoLocation
                      ? {
                          // #B93312 rung + white (5.92:1); the geo pill carries a label, so #E2481D
                          // (white 4.06:1) is under AA.
                          backgroundColor: ACCENT_FILL,
                          border: `1px solid ${ACCENT_FILL}`,
                          color: ON_ACCENT_FILL,
                        }
                      : {}),
                  }}
                  aria-pressed={Boolean(geoLocation)}
                  aria-expanded={showGeoPanel}
                  onClick={handleToggleGeoPanel}
                  data-testid="spotlight-geo-toggle"
                >
                  <Crosshair size={12} strokeWidth={2.5} aria-hidden />
                  {geoLocation
                    ? geoLocation.label
                    : String(t("spotlight.location"))}
                </button>
              </>
            )}
          </div>

          {/* ── Admin facet row (FR-004) ───────────────────────────
              Hidden — not disabled — when the pill is pinned to attendees or
              venues: a greyed-out row still implies these filters mean
              something for those groups, and they don't. */}
          {facetsApply && (
            <SpotlightAdminFacets
              state={adminFacets}
              onChange={setAdminFacets}
              isMobile={isMobile}
            />
          )}

          {/* ── Location / radius panel ─────────────────────────── */}
          {!isAdmin && showGeoPanel && (
            <div style={styles.geoPanel} data-testid="spotlight-geo-panel">
              {!geoLocation ? (
                <>
                  {/* "Use my location" row */}
                  <div style={styles.geoPanelRow}>
                    <button
                      type="button"
                      style={{
                        ...pillStyle,
                        gap: 6,
                      }}
                      onClick={handleUseMyLocation}
                      data-testid="spotlight-use-my-location"
                    >
                      {geoLoading ? (
                        <span style={{ display: "flex", gap: 3 }}>
                          <span
                            style={{
                              ...styles.loadingDot,
                              animationDelay: "0ms",
                            }}
                          />
                          <span
                            style={{
                              ...styles.loadingDot,
                              animationDelay: "150ms",
                            }}
                          />
                        </span>
                      ) : (
                        <Navigation size={12} strokeWidth={2.5} />
                      )}
                      {geoLoading
                        ? String(t("search.locating"))
                        : String(t("search.useMyLocation"))}
                    </button>
                    {geoError && (
                      <span style={{ fontSize: 11, color: "#cc3333" }}>
                        {String(t("search.locationUnavailable"))}
                      </span>
                    )}
                  </div>

                  {/* Divider */}
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 8 }}
                  >
                    <div
                      style={{
                        flex: 1,
                        height: 1,
                        backgroundColor: "var(--borderColor, #211C16)",
                      }}
                    />
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        textTransform: "uppercase",
                        letterSpacing: "0.1em",
                        color: "var(--colorMuted, #5C544A)",
                      }}
                    >
                      {String(t("search.or"))}
                    </span>
                    <div
                      style={{
                        flex: 1,
                        height: 1,
                        backgroundColor: "var(--borderColor, #211C16)",
                      }}
                    />
                  </div>

                  {/* Location autocomplete */}
                  <LocationAutocomplete
                    value={locationQuery}
                    onChange={setLocationQuery}
                    onSelect={handleLocationSelect}
                    placeholder={String(t("search.locationPlaceholder"))}
                    testIdBase="spotlight-location"
                  />
                </>
              ) : (
                <>
                  {/* Active location + clear */}
                  <div style={styles.geoPanelRow}>
                    <span style={styles.geoLabel}>
                      {String(t("search.locationFilter"))}
                    </span>
                    <span style={styles.geoLocationBadge}>
                      <MapPin size={12} strokeWidth={2.5} />
                      {geoLocation.label}
                    </span>
                    <button
                      type="button"
                      style={{
                        ...styles.geoClearButton,
                        ...(isMobile ? styles.geoClearButtonMobile : {}),
                      }}
                      onClick={handleClearGeo}
                      aria-label={String(t("spotlight.clearLocation"))}
                      data-testid="spotlight-clear-geo"
                    >
                      <X size={12} strokeWidth={2.5} />
                    </button>
                  </div>

                  {/* Radius slider */}
                  <div style={styles.geoPanelRow}>
                    <span style={styles.geoLabel}>
                      {String(t("search.radius"))}
                    </span>
                    {/* Widget stops follow the active unit (mi grid for
                        imperial); state stays canonical km via
                        kmToSliderValue/sliderValueToKm. aria-valuetext makes the
                        screen reader announce the unit-aware value. */}
                    <input
                      type="range"
                      min={sliderConfig.min}
                      max={sliderConfig.max}
                      step={sliderConfig.step}
                      value={kmToSliderValue(geoRadiusKm, imperial)}
                      onChange={(e) =>
                        setGeoRadiusKm(
                          sliderValueToKm(Number(e.target.value), imperial),
                        )
                      }
                      style={styles.geoSlider}
                      aria-label={String(t("search.radius"))}
                      aria-valuetext={radiusDisplayLabel}
                      data-testid="spotlight-radius-slider"
                    />
                    <span style={styles.geoRadiusValue}>
                      {radiusDisplayLabel}
                    </span>
                    <button
                      type="button"
                      style={styles.unitToggle}
                      onClick={toggleImperial}
                      aria-label={String(
                        t(
                          imperial
                            ? "spotlight.unitToKilometres"
                            : "spotlight.unitToMiles",
                        ),
                      )}
                      title={String(t("spotlight.unitToggleTitle"))}
                      data-testid="spotlight-unit-toggle"
                    >
                      {imperial ? "mi" : "km"}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── Results area ─────────────────────────────────────── */}
          <div style={styles.resultsArea} ref={resultsRef}>
            {/* Idle state — hints */}
            {showIdle && (
              <div style={styles.emptyState}>
                <Search size={24} color={STRUCTURAL} strokeWidth={1.5} />
                <div style={styles.emptyTitle}>
                  {String(t("spotlight.idleTitle"))}
                </div>
                <div style={styles.emptyHint}>
                  {String(
                    t(
                      context === "admin"
                        ? "spotlight.adminIdleHint"
                        : "spotlight.idleHint",
                    ),
                  )}
                </div>
              </div>
            )}

            {/* Loading state — clean skeleton rows. Activates the moment
								the user starts typing and persists through the debounce +
								fetch, so there's no flicker between "typing" and
								"fetching". `showResults` already gates stale results off
								while typing, so the skeleton owns the area on its own. */}
            {isLoading && !showResults && (
              <div data-testid="spotlight-loading">
                <div style={{ ...styles.groupHeader, opacity: 0.6 }}>
                  <span
                    className="spotlight-skeleton"
                    style={{ display: "inline-block", height: 10, width: 80 }}
                  />
                </div>
                {[0, 1, 2, 3].map((i) => (
                  <div
                    key={i}
                    style={{
                      ...styles.resultItem,
                      cursor: "default",
                      pointerEvents: "none",
                    }}
                  >
                    <div style={styles.resultIcon}>
                      <span
                        className="spotlight-skeleton"
                        style={{ display: "block", width: 16, height: 16 }}
                      />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span
                        className="spotlight-skeleton"
                        style={{
                          display: "block",
                          height: 13,
                          width: `${70 - i * 10}%`,
                          marginBottom: 6,
                        }}
                      />
                      <span
                        className="spotlight-skeleton"
                        style={{
                          display: "block",
                          height: 10,
                          width: `${50 - i * 8}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Empty state */}
            {showEmpty && (
              <div style={styles.emptyState} data-testid="spotlight-empty">
                <Search
                  size={24}
                  color="var(--colorMuted, #5C544A)"
                  strokeWidth={1.5}
                />
                <div style={styles.emptyTitle}>
                  {String(t("spotlight.noResults"))}
                </div>
                <div style={styles.emptyHint}>
                  {String(t("spotlight.noResultsHint"))}
                </div>
              </div>
            )}

            {/* Grouped results — keyed on the resolved query so each new
                search retriggers the staggered slide-in.

                The rows carried role="option" with no listbox ancestor
                (invalid). The list itself is now the listbox, each group is a
                role="group" inside it, and aria-activedescendant on the input
                tracks the arrow-key row (NFR-003). */}
            {showResults && (
              <div
                className="spotlight-results-anim"
                key={debouncedQuery}
                id={listboxId}
                role="listbox"
                aria-label={String(t("spotlight.resultsLabel"))}
              >
                {isAdmin
                  ? adminGroups.map(({ group, rows }) => {
                      const groupLabel = String(
                        t(ADMIN_RESULT_GROUP_LABEL_KEY[group]),
                      );
                      const Icon = ADMIN_RESULT_GROUP_ICON[group];
                      return (
                        <div key={group} role="group" aria-label={groupLabel}>
                          <div style={styles.groupHeader} aria-hidden>
                            {groupLabel}
                          </div>
                          {rows.map((row) => {
                            const rowIndex = adminRows.indexOf(row);
                            const isActive = rowIndex === activeIndex;
                            return (
                              <div
                                key={row.key}
                                id={`${listboxId}-row-${rowIndex}`}
                                style={{
                                  ...styles.resultItem,
                                  ...(isActive ? styles.resultItemActive : {}),
                                }}
                                onClick={() => navigateToAdminRow(row)}
                                onMouseEnter={() => setActiveIndex(rowIndex)}
                                data-spotlight-item
                                data-testid={`spotlight-result-${row.key}`}
                                role="option"
                                aria-selected={isActive}
                              >
                                <div style={styles.resultIcon}>
                                  <Icon size={16} strokeWidth={2} aria-hidden />
                                </div>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={styles.resultTitle}>
                                    {row.title}
                                  </div>
                                  {row.subtitle && (
                                    <div
                                      style={{
                                        ...styles.resultSubtitle,
                                        ...styles.resultSubtitleClamp,
                                      }}
                                    >
                                      {row.subtitle}
                                    </div>
                                  )}
                                </div>
                                {isActive && (
                                  <ArrowRight
                                    size={14}
                                    color={ACCENT}
                                    strokeWidth={2.5}
                                    aria-hidden
                                  />
                                )}
                              </div>
                            );
                          })}
                        </div>
                      );
                    })
                  : Array.from(groupedResults.entries()).map(([type, items]) => {
                      const groupLabel = String(t(TYPE_LABEL_KEY[type]));
                      return (
                        <div key={type} role="group" aria-label={groupLabel}>
                          <div style={styles.groupHeader} aria-hidden>
                            {groupLabel}
                          </div>
                          {items.map((item) => {
                            const itemIndex = flatResults.indexOf(item);
                            const isActive = itemIndex === activeIndex;
                            const Icon = TYPE_ICON[item.type] ?? Search;

                            return (
                              <div
                                key={item.id}
                                id={`${listboxId}-row-${itemIndex}`}
                                style={{
                                  ...styles.resultItem,
                                  ...(isActive ? styles.resultItemActive : {}),
                                }}
                                onClick={() => navigateToSuggestion(item)}
                                onMouseEnter={() => setActiveIndex(itemIndex)}
                                data-spotlight-item
                                data-testid={`spotlight-result-${item.id}`}
                                role="option"
                                aria-selected={isActive}
                              >
                                <div style={styles.resultIcon}>
                                  <Icon size={16} strokeWidth={2} aria-hidden />
                                </div>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={styles.resultTitle}>
                                    {item.title}
                                  </div>
                                  {item.subtitle && (
                                    <div style={styles.resultSubtitle}>
                                      {item.subtitle}
                                    </div>
                                  )}
                                </div>
                                {isActive && (
                                  <ArrowRight
                                    size={14}
                                    color={ACCENT}
                                    strokeWidth={2.5}
                                    aria-hidden
                                  />
                                )}
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
              </div>
            )}
          </div>

          {/* Polite count announcement — the visual group headers are
              aria-hidden, so this is how a screen reader learns what
              settled (NFR-003). */}
          <div
            style={styles.srOnly}
            role="status"
            aria-live="polite"
            data-testid="spotlight-announcement"
          >
            {announcement}
          </div>

          {/* ── Footer ─────────────────────────────────────────────
					    Desktop: keyboard shortcut hints on the left, compact
					    "View all" button on the right (only when relevant).
					    Mobile: keyboard hints are dead weight (no keyboard
					    visible, no esc key). Replace with a full-width
					    primary "View all results" button so the user can
					    bail out to the full search results page from the
					    sheet — and keep the same affordance even before
					    they've typed a query, since on mobile the nav
					    hints take up the entire row otherwise. */}
          <div
            style={{
              ...styles.footer,
              ...(isMobile
                ? { padding: 12, gap: 8, flexDirection: "column" as const }
                : {}),
            }}
          >
            {!isMobile ? (
              <div style={styles.kbdRow}>
                <kbd style={styles.kbd}>↑↓</kbd>
                <span>{String(t("spotlight.kbdNavigate"))}</span>
                <kbd style={styles.kbd}>↵</kbd>
                <span>{String(t("spotlight.kbdSelect"))}</span>
                <kbd style={styles.kbd}>esc</kbd>
                <span>{String(t("spotlight.kbdClose"))}</span>
              </div>
            ) : null}

            {isMobile ? (
              <>
                {/* "Surprise me" rolls a random PUBLISHED event out of global
                    discovery — a pure consumer affordance (FR-007). */}
                {!isAdmin && (
                  <button
                    type="button"
                    style={{
                      ...styles.footerActionSecondary,
                      width: "100%",
                      justifyContent: "center",
                      padding: "14px 16px",
                      fontSize: 13,
                      letterSpacing: "0.08em",
                      minHeight: 48,
                    }}
                    onClick={handleSurprise}
                    disabled={isRolling}
                    data-testid="spotlight-surprise"
                  >
                    {String(t("spotlight.surprise"))}
                  </button>
                )}
                <button
                  type="button"
                  style={{
                    ...styles.footerAction,
                    width: "100%",
                    justifyContent: "center",
                    padding: "14px 16px",
                    fontSize: 13,
                    letterSpacing: "0.08em",
                    minHeight: 48,
                  }}
                  onClick={handleFullSearch}
                  data-testid="spotlight-full-search"
                >
                  {String(t("spotlight.viewAll"))}
                  <ArrowRight size={14} strokeWidth={2.5} aria-hidden />
                </button>
              </>
            ) : (
              <div
                style={{ display: "flex", alignItems: "center", gap: 8 }}
              >
                {!isAdmin && (
                  <button
                    type="button"
                    style={styles.footerActionSecondary}
                    onClick={handleSurprise}
                    disabled={isRolling}
                    data-testid="spotlight-surprise"
                  >
                    {String(t("spotlight.surprise"))}
                  </button>
                )}
                {isSearching && (
                  <button
                    type="button"
                    style={styles.footerAction}
                    onClick={handleFullSearch}
                    data-testid="spotlight-full-search"
                  >
                    {String(t("spotlight.viewAll"))}
                    <ArrowRight size={12} strokeWidth={2.5} aria-hidden />
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}

SpotlightSearch.displayName = "SpotlightSearch";
