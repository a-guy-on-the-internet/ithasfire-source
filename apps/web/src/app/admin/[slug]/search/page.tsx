"use client";

/**
 * Admin Search Page — /admin/:slug/search?search=&type=&status=&date=&from=&to=&category=&uncat=
 *
 * Live, org-scoped search across Events (incl. drafts), Attendees (order
 * buyers, incl. guests), Venues, and — for an id-shaped query — a single Order
 * (FR-012). Uses `search.adminOrgSearch`, which hits live repos rather than the
 * public discovery projection, so drafts and guest buyers are visible.
 *
 * ## Facet parity + URL sync (FR-011)
 *
 * The same status / date / category facets the ⌘K overlay has, driven by the
 * SAME model (`spotlight-admin-facets.ts`) and serialised through the SAME
 * writer (`appendAdminFacetParams`), so "View all" hands off pre-filtered and
 * back/forward restores exactly what was on screen.
 *
 * ## push, never replace
 *
 * Every control on this page is DISCRETE — status, date mode, category, type,
 * and a search box that commits on submit rather than per keystroke. The repo
 * convention (`app/search/_components/search-url.ts`, `diffIsContinuousOnly`)
 * is that a discrete action pushes so Back restores it, and only CONTINUOUS
 * controls (that page's radius slider, its per-keystroke query) replace. This
 * bar has no continuous control, so `commit` always pushes — which is also
 * what FR-011 requires when it says back/forward works. If a per-keystroke
 * commit is ever added here, THAT is the one that should replace; do not
 * demote the facets with it.
 *
 * ## Single writer
 *
 * There is deliberately NO "state changed → write the URL" effect. That shape
 * loops (parse → state → build → replace → parse) and, worse, races
 * back/forward: the effect runs with the new `searchParams` but the
 * pre-adoption state and pushes the old state straight back over the
 * navigation. Instead `commit()` is the one writer — it sets state and writes
 * the URL together at the call site — and the only effect goes URL → state,
 * where `adminSearchStateEquals` makes every URL this page wrote itself a
 * no-op.
 */

import { useSearchParams, useParams, usePathname } from "next/navigation";
import { useRouter } from "@bprogress/next/app";
import {
  Suspense,
  useCallback,
  useState,
  useEffect,
  useId,
  useMemo,
  useRef,
} from "react";
import { Search, Calendar, Users, MapPin, Receipt } from "lucide-react";
import { keepPreviousData } from "@tanstack/react-query";
import { useFormatters, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { SearchBar } from "@/components/search/SearchBar";
import { styles } from "@/components/search/spotlight-styles";
import { useCurrentAdminOwner } from "@/hooks/useCurrentAdminOwner";
import { useIsMobile } from "@/hooks/useIsMobile";
import { ACCENT, ACCENT_TEXT, STRUCTURAL } from "@/lib/design-tokens";
import {
  setContextQuery,
  useContextQuery,
} from "@/components/search/spotlight-store";
import {
  EVENT_STATUS_LABEL_KEY,
  buildAdminFacetInput,
  hasActiveAdminFacets,
  type AdminEventStatus,
  type AdminGroup,
} from "@/components/search/spotlight-admin-facets";
import {
  adminOrderRowHref,
  formatOrderRowDetail,
  formatOrderRowStatus,
  formatOrderRowTitle,
} from "@/components/search/admin-order-row";

import { AdminSearchFacets } from "./_components/AdminSearchFacets";
import {
  adminSearchStateEquals,
  buildAdminSearchQueryString,
  parseAdminSearchParams,
  type AdminSearchUrlState,
} from "./_lib/admin-search-url";

/** Matches the overlay's `MIN_QUERY_LENGTH` so the two agree on "searching". */
const MIN_QUERY_LENGTH = 2;

/** Per-group cap. The spec's ceiling for the full page; the overlay uses 10. */
const PAGE_RESULT_LIMIT = 50;

// ── Inner component (reads searchParams inside Suspense) ─────────────────────

function AdminSearchInner() {
  const searchParams = useSearchParams();
  const params = useParams<{ slug: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const t = useTranslations();
  const { dateTime: formatDate, currency: formatCurrency } = useFormatters();
  const isMobile = useIsMobile();

  const orgSlug = params?.slug ?? "";
  const searchParamsString = searchParams.toString();

  // ── URL-synced state ───────────────────────────────────────────────
  const [state, setState] = useState<AdminSearchUrlState>(() =>
    parseAdminSearchParams(searchParams),
  );

  /**
   * URL → state. Fires on deep-link mount and on back/forward. It is a NO-OP
   * for every URL this page wrote itself (`commit` round-trips exactly), which
   * is what keeps the two directions from ping-ponging.
   */
  useEffect(() => {
    const parsed = parseAdminSearchParams(
      new URLSearchParams(searchParamsString),
    );
    setState((prev) => (adminSearchStateEquals(prev, parsed) ? prev : parsed));
  }, [searchParamsString]);

  /** The single writer: state and URL move together, or not at all. */
  const commit = useCallback(
    (next: AdminSearchUrlState) => {
      setState(next);
      const qs = buildAdminSearchQueryString({
        state: next,
        preserved: searchParamsString,
      });
      if (qs === searchParamsString) return;
      const url = qs ? `${pathname}?${qs}` : pathname;
      router.push(url, { scroll: false });
    },
    [pathname, router, searchParamsString],
  );

  // ── Search input ───────────────────────────────────────────────────
  // Typing updates state only; the URL is written on submit (Enter) or on any
  // facet change, which carries the current query along. Same as the page has
  // always behaved — a `router.replace` per keystroke is not an improvement.
  const setSearchValue = useCallback((value: string) => {
    setState((prev) => ({ ...prev, query: value }));
    const trimmed = value.trim();
    if (trimmed.length > 0) setContextQuery("admin", trimmed);
  }, []);

  const handleSubmit = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;
      setContextQuery("admin", trimmed);
      commit({ ...state, query: trimmed });
    },
    [commit, state],
  );

  /**
   * The spotlight overlay and this page share one admin query. Adopt CHANGES
   * to it — the ref skips the mount run so a stale store value can never win
   * over the query the user actually deep-linked to.
   */
  const storeQuery = useContextQuery("admin");
  const lastStoreQuery = useRef(storeQuery);
  useEffect(() => {
    if (lastStoreQuery.current === storeQuery) return;
    lastStoreQuery.current = storeQuery;
    if (!storeQuery) return;
    setState((prev) =>
      prev.query.trim() === storeQuery ? prev : { ...prev, query: storeQuery },
    );
  }, [storeQuery]);

  // ── Owner scope ────────────────────────────────────────────────────
  const { currentOwner } = useCurrentAdminOwner(orgSlug);

  const ownerScope = useMemo(() => {
    if (!currentOwner) return null;
    return currentOwner.kind === "org"
      ? { ownerType: "ORGANIZATION" as const, ownerId: currentOwner.orgId }
      : { ownerType: "HUMAN" as const, ownerId: currentOwner.humanId };
  }, [currentOwner]);

  // ── Facets → query input ───────────────────────────────────────────
  const trimmedQuery = state.query.trim();

  /**
   * Facets are EVENTS-ONLY. Pinned to Attendees or Venues, the events group
   * isn't fetched at all, so a `statuses` key would ride the wire meaning
   * nothing under a lit "Drafts" pill. Same gate the overlay applies: the rows
   * are hidden and the keys are stripped, but the STATE survives in the URL so
   * going back to All restores it.
   */
  const facetsApply = state.group === null || state.group === "event";

  // Never sent as empty arrays — a cleared facet drops its key entirely (the
  // input schema marks every array facet `.nonempty()`).
  const facetInput = useMemo(
    () => (facetsApply ? buildAdminFacetInput(state.facets) : {}),
    [facetsApply, state.facets],
  );
  const facetsActive = facetsApply && hasActiveAdminFacets(state.facets);

  /**
   * FR-005 applies here too: "Drafts" with an empty box is a filtered browse,
   * not an idle page. Events only — `facetsApply` above is what stops
   * "Attendees + Drafts + empty box" from becoming an unfiltered buyer dump.
   */
  const facetOnlyIntent =
    facetsActive && trimmedQuery.length < MIN_QUERY_LENGTH;
  const isSearching =
    trimmedQuery.length >= MIN_QUERY_LENGTH || facetOnlyIntent;

  const types = useMemo<AdminGroup[] | undefined>(() => {
    if (facetOnlyIntent) return ["event"];
    return state.group ? [state.group] : undefined;
  }, [facetOnlyIntent, state.group]);

  const { data, isFetching } = trpc.search.adminOrgSearch.useQuery(
    {
      ownerType: ownerScope?.ownerType ?? "ORGANIZATION",
      ownerId: ownerScope?.ownerId ?? "",
      query: trimmedQuery,
      limit: PAGE_RESULT_LIMIT,
      ...(types ? { types } : {}),
      ...facetInput,
    },
    {
      enabled: isSearching && !!ownerScope,
      staleTime: 30_000,
      // NFR-004: a facet flip must never blank the list.
      placeholderData: keepPreviousData,
    },
  );

  const events = data?.events ?? [];
  const attendees = data?.attendees ?? [];
  const venues = data?.venues ?? [];
  /**
   * FR-012 / NFR-002. `order` is null for all four no-result reasons — not
   * id-shaped, no match, actor lacks finance access, group filtered out — and
   * they are indistinguishable ON PURPOSE. A null order renders NOTHING: no
   * "no order found", no "you don't have permission". Either message would
   * turn a tenancy guarantee back into an existence oracle.
   */
  const order = data?.order ?? null;

  const counts = data?.counts;
  const shownResults =
    events.length + attendees.length + venues.length + (order ? 1 : 0);
  const isLoading = isSearching && isFetching && shownResults === 0;

  /**
   * Never claim a total LOWER than the rows on screen.
   *
   * `total` is the whole-scope count and should always be ≥ `shown`. When it
   * is not, the header prints a number the user can sit and count against —
   * "0 attendees" over a visible attendee row is not a subtle inconsistency,
   * it is the search visibly lying, and it discredits every other number
   * beside it. Clamping to `shown` invents nothing: those rows are on screen,
   * so "at least this many exist" is provably true.
   *
   * This is a display guard, not a workaround — it neither hides nor fixes a
   * backend disagreement (one is live right now: `listForOrg` matches order
   * identifiers while `countDistinctBuyersForOwner` does not, so an id-shaped
   * query yields `attendees {shown: 1, total: 0}`). It only stops the UI from
   * repeating an impossible claim.
   */
  const displayTotal = (shown: number, total: number | undefined) =>
    total == null ? undefined : Math.max(shown, total);

  /**
   * Header count for a group whose `shown` and `total` are the SAME UNIT
   * (events, venues): the scope total, or "20 of 200" when the page is capped.
   * A bare "200" over twenty rows reads as a bug, and the pre-Phase-B
   * `count={events.length}` — a page length saturating at `limit` — was the
   * opposite lie. NOT for attendees; see `ResultSection`.
   */
  const sameUnitCountText = useCallback(
    (shown: number, rawTotal: number | undefined) => {
      const total = displayTotal(shown, rawTotal);
      if (total == null) return undefined;
      return total > shown
        ? String(t("spotlight.shownOfTotal", { shown, total }))
        : String(total);
    },
    [t],
  );

  /**
   * Polite announcement once the list settles (NFR-003).
   *
   * Two rules beyond "read the totals":
   *  - The ORDER group counts. Without it a finance admin who pastes an order
   *    id — where the order row is the only result — is told "0 events, 0
   *    attendees, 0 venues" over a visible row. The overlay already announces
   *    its order group, and the two surfaces must not disagree about what
   *    settled.
   *  - A group the user filtered out via `types` is SKIPPED, not announced as
   *    zero. The backend honestly reports `{shown: 0, total: 0}` for a group
   *    whose query never ran; reading that out as "0 venues" describes a
   *    search nobody asked for.
   *
   * NFR-002 holds: a null order contributes NOTHING, so "no finance access",
   * "no match" and "not id-shaped" all produce the identical announcement.
   */
  const announcement = useMemo(() => {
    if (!counts || shownResults === 0) return "";
    const includes = (group: AdminGroup) => !types || types.includes(group);
    return [
      ...(order ? [t("spotlight.countOrders", { count: 1 })] : []),
      ...(includes("event")
        ? [
            t("spotlight.countEvents", {
              count: displayTotal(events.length, counts.events.total),
            }),
          ]
        : []),
      ...(includes("attendee")
        ? [
            t("spotlight.countAttendees", {
              count: displayTotal(attendees.length, counts.attendees.total),
            }),
          ]
        : []),
      ...(includes("venue")
        ? [
            t("spotlight.countVenues", {
              count: displayTotal(venues.length, counts.venues.total),
            }),
          ]
        : []),
    ]
      .map(String)
      .join(", ");
  }, [
    counts,
    order,
    events.length,
    attendees.length,
    venues.length,
    shownResults,
    types,
    t,
  ]);

  return (
    <div style={{ padding: "48px 0" }}>
      {/* ── Header ──────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 24,
          borderBottom: `2px solid ${STRUCTURAL}`,
          paddingBottom: 16,
        }}
      >
        <span
          style={{
            fontWeight: 900,
            fontSize: 14,
            color: ACCENT_TEXT,
            letterSpacing: "0.04em",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          03.
        </span>
        <Search size={24} strokeWidth={2.5} color={STRUCTURAL} />
        <h1
          style={{
            fontSize: 22,
            fontWeight: 900,
            textTransform: "uppercase",
            letterSpacing: "-0.02em",
            margin: 0,
            color: "var(--color, #211C16)",
          }}
        >
          {String(t("spotlight.title"))}
        </h1>
      </div>

      {/* ── Search bar ──────────────────────────────────────── */}
      <div style={{ marginBottom: 12 }}>
        <SearchBar
          value={state.query}
          onChangeValue={setSearchValue}
          onSubmit={handleSubmit}
          placeholder={String(t("spotlight.adminPlaceholder"))}
          height={48}
          testId="admin-search-form"
          ariaLabel={String(t("spotlight.adminPlaceholder"))}
        />
      </div>

      {/* ── Facets (FR-011) ─────────────────────────────────── */}
      <AdminSearchFacets
        state={state}
        onChange={commit}
        facetsApply={facetsApply}
        isMobile={isMobile}
      />

      {/* ── States ──────────────────────────────────────────── */}
      {!isSearching && (
        <p
          style={{
            fontSize: 14,
            color: "var(--colorMuted, #5C544A)",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            fontWeight: 600,
          }}
        >
          {String(t("spotlight.adminIdleHint"))}
        </p>
      )}

      {isLoading && (
        <p
          style={{
            fontSize: 14,
            fontWeight: 500,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: STRUCTURAL,
          }}
          data-testid="admin-search-loading"
        >
          {String(t("spotlight.searching"))}
        </p>
      )}

      {isSearching && !isLoading && shownResults === 0 && (
        <div style={{ padding: "32px 0" }} data-testid="admin-search-empty">
          <p
            style={{
              fontSize: 16,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "-0.01em",
              color: "var(--color, #211C16)",
              margin: "0 0 8px 0",
            }}
          >
            {String(t("spotlight.noResults"))}
          </p>
          <p
            style={{
              fontSize: 14,
              color: "var(--colorMuted, #5C544A)",
              margin: 0,
            }}
          >
            {String(t("spotlight.noResultsHint"))}
          </p>
        </div>
      )}

      {/* ── Results (grouped) ───────────────────────────────── */}
      {shownResults > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          {/* Order leads — someone who pasted an order id wants that answer
              first, not below a list of loosely-matching events. */}
          {order && (
            <ResultSection
              label={String(t("spotlight.adminTypeOrder"))}
              icon={Receipt}
              shown={1}
            >
              <ResultRow
                href={adminOrderRowHref(orgSlug, order)}
                title={formatOrderRowTitle(order)}
                // Status goes in the right column, like the event rows below —
                // the detail line is one ellipsised run, and a DISPUTED order
                // must not lose its annotation to a 320px clip.
                subtitle={formatOrderRowStatus(order, t)}
                detail={formatOrderRowDetail(order, {
                  currency: formatCurrency,
                  dateTime: formatDate,
                })}
                testId="admin-search-order-row"
              />
            </ResultSection>
          )}

          <ResultSection
            label={String(t("spotlight.adminTypeEvents"))}
            icon={Calendar}
            shown={events.length}
            countText={sameUnitCountText(events.length, counts?.events.total)}
          >
            {events.map((event) => (
              <ResultRow
                key={`event-${event.id}`}
                href={`/admin/${orgSlug}/events/${event.id}`}
                title={event.title ?? String(t("spotlight.untitledEvent"))}
                subtitle={
                  event.status !== "PUBLISHED"
                    ? String(
                        t(
                          EVENT_STATUS_LABEL_KEY[
                            event.status as AdminEventStatus
                          ],
                        ),
                      )
                    : null
                }
                detail={
                  event.startsAt
                    ? formatDate(new Date(event.startsAt), {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })
                    : null
                }
              />
            ))}
          </ResultSection>

          <ResultSection
            label={String(t("spotlight.adminTypeAttendees"))}
            icon={Users}
            shown={attendees.length}
            /**
             * The TOTAL alone — never `shown of total`. `shown` counts buyers
             * deduped from a page of ORDERS; `total` counts distinct buyers in
             * the whole scope. An org with 137 matching buyers whose 20 most
             * recent orders all belong to one repeat customer would render
             * "1 of 137", which is not a truncation, it is two different units
             * divided by each other.
             *
             * `countTotal` ("137 total"), not `countAttendees` ("137
             * attendees"): the section header already says ATTENDEES, so the
             * noun was pure repetition, and it sat oddly beside its siblings'
             * "20 of 200". "total" does the job the "of" form does for them —
             * marks the number as scope-wide rather than a count of the rows
             * below. Do NOT "fix" this into a fraction; see above.
             */
            countText={
              counts
                ? String(
                    t("spotlight.countTotal", {
                      count: displayTotal(
                        attendees.length,
                        counts.attendees.total,
                      ),
                    }),
                  )
                : undefined
            }
          >
            {attendees.map((attendee, i) => {
              const filter = attendee.email ?? attendee.name ?? "";
              const eventsLine = [
                ...attendee.eventTitles,
                ...(attendee.moreCount > 0
                  ? [
                      String(
                        t("spotlight.moreEvents", {
                          count: attendee.moreCount,
                        }),
                      ),
                    ]
                  : []),
              ].join(", ");
              /**
               * FR-013. `orderCount` covers ALL of this buyer's COMPLETED
               * orders under this owner — not the rows on this page, and not
               * their held or cancelled carts. Hence "purchases": the list
               * itself is unfiltered (an organiser must still be able to find
               * a cart-abandoner), so calling the aggregate "orders" would put
               * "0 orders" on a buyer who is visibly in the orders-derived
               * attendee list.
               *
               * The zero case is rendered, deliberately. "0 purchases" is the
               * whole signal for a cart-abandoner; hiding it would make them
               * indistinguishable from a buyer whose count simply hadn't
               * loaded. `lastOrderAt` is correctly null there, so the date
               * segment drops itself.
               */
              const meta = [
                String(
                  t("spotlight.attendeePurchases", {
                    count: attendee.orderCount,
                  }),
                ),
                ...(attendee.lastOrderAt
                  ? [
                      String(
                        t("spotlight.attendeeLastPurchase", {
                          date: formatDate(new Date(attendee.lastOrderAt), {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          }),
                        }),
                      ),
                    ]
                  : []),
              ].join(" · ");
              return (
                <ResultRow
                  key={`attendee-${attendee.buyerHumanId ?? attendee.email ?? i}`}
                  href={`/admin/${orgSlug}/orders?q=${encodeURIComponent(filter)}`}
                  title={
                    attendee.name ??
                    attendee.email ??
                    String(t("spotlight.guestBuyer"))
                  }
                  subtitle={attendee.email}
                  detail={eventsLine || null}
                  meta={meta}
                />
              );
            })}
          </ResultSection>

          <ResultSection
            label={String(t("spotlight.adminTypeVenues"))}
            icon={MapPin}
            shown={venues.length}
            countText={sameUnitCountText(venues.length, counts?.venues.total)}
          >
            {venues.map((venue) => (
              <ResultRow
                key={`venue-${venue.id}`}
                href={`/admin/${orgSlug}/places`}
                title={venue.name}
                subtitle={venue.address}
              />
            ))}
          </ResultSection>
        </div>
      )}

      <div
        style={styles.srOnly}
        role="status"
        aria-live="polite"
        data-testid="admin-search-announcement"
      >
        {announcement}
      </div>
    </div>
  );
}

// ── Section + row primitives (mirror consumer search visual language) ────────

/**
 * `shown` gates rendering; the COUNT is passed in pre-rendered.
 *
 * That split is deliberate. Whether "shown of total" is even a meaningful
 * sentence depends on the group, and only the call site knows: for events and
 * venues the two numbers are the same unit (rows of the same thing), so a
 * fraction is honest. For attendees they are NOT — `shown` is buyers deduped
 * from a page of ORDERS, `total` is distinct buyers in the whole scope — so
 * "1 of 137" is arithmetic on two different units and reads as a bug in the
 * search. Handing this primitive a `total` and letting it decide would put the
 * choice exactly where the unit is unknown.
 */
function ResultSection({
  label,
  icon: Icon,
  shown,
  countText,
  children,
}: {
  label: string;
  icon: typeof Calendar;
  shown: number;
  /** Pre-translated count for the header. Omitted → no count is rendered. */
  countText?: string;
  children: React.ReactNode;
}) {
  const headingId = useId();
  if (shown === 0) return null;
  return (
    // Labelled BY the visible heading rather than an aria-label duplicate of
    // it — the page is a document with sections, not the overlay's listbox.
    <section aria-labelledby={headingId}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 8,
          paddingBottom: 6,
          borderBottom: `1px solid var(--borderColor, #211C16)`,
        }}
      >
        <Icon size={14} strokeWidth={2.5} color={ACCENT_TEXT} />
        <h2
          id={headingId}
          style={{
            fontSize: 11,
            fontWeight: 800,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            // Accent as INK → the #B93312 rung; `ACCENT` at 11px is ~3.6:1.
            color: ACCENT_TEXT,
            margin: 0,
          }}
        >
          {label}
        </h2>
        {countText && (
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: "var(--colorMuted, #5C544A)",
              fontVariantNumeric: "tabular-nums",
            }}
            data-testid="admin-search-section-count"
          >
            {countText}
          </span>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
        {children}
      </div>
    </section>
  );
}

function ResultRow({
  href,
  title,
  subtitle,
  detail,
  meta,
  testId,
}: {
  href: string;
  title: string;
  subtitle?: string | null;
  detail?: string | null;
  /** Right-column second line — FR-013's order count / last order date. */
  meta?: string | null;
  testId?: string;
}) {
  return (
    <a
      href={href}
      data-testid={testId}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 16px",
        minHeight: 48,
        fontSize: 15,
        fontWeight: 500,
        color: "var(--color, #211C16)",
        textDecoration: "none",
        borderBottom: `1px solid var(--borderColor, #211C16)`,
        borderLeft: `3px solid transparent`,
        transition:
          "background-color 150ms ease-out, border-left-color 150ms ease-out",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.backgroundColor =
          "var(--surfaceMuted, #EFE7D6)";
        (e.currentTarget as HTMLElement).style.borderLeftColor = ACCENT;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.backgroundColor = "transparent";
        (e.currentTarget as HTMLElement).style.borderLeftColor = "transparent";
      }}
      onFocus={(e) => {
        (e.currentTarget as HTMLElement).style.backgroundColor =
          "var(--surfaceMuted, #EFE7D6)";
        (e.currentTarget as HTMLElement).style.borderLeftColor = ACCENT;
      }}
      onBlur={(e) => {
        (e.currentTarget as HTMLElement).style.backgroundColor = "transparent";
        (e.currentTarget as HTMLElement).style.borderLeftColor = "transparent";
      }}
    >
      <span
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 2,
          flex: 1,
          minWidth: 0,
        }}
      >
        <span
          style={{
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {title}
        </span>
        {detail && (
          <span
            style={{
              fontSize: 12,
              fontWeight: 500,
              color: "var(--colorMuted, #5C544A)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {detail}
          </span>
        )}
      </span>
      {(subtitle || meta) && (
        <span
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: 2,
            flexShrink: 0,
            maxWidth: "45%",
          }}
        >
          {subtitle && (
            <span
              style={{
                fontSize: 13,
                color: "var(--colorMuted, #5C544A)",
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                fontWeight: 600,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxWidth: "100%",
              }}
            >
              {subtitle}
            </span>
          )}
          {meta && (
            <span
              style={{
                fontSize: 11,
                color: "var(--colorMuted, #5C544A)",
                fontWeight: 600,
                fontVariantNumeric: "tabular-nums",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxWidth: "100%",
              }}
            >
              {meta}
            </span>
          )}
        </span>
      )}
    </a>
  );
}


// ── Page export (wrapped in Suspense for useSearchParams) ────────────────────

function AdminSearchFallback() {
  const t = useTranslations();
  return (
    <div style={{ padding: "48px 0" }}>
      <p
        style={{
          fontSize: 14,
          fontWeight: 500,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: STRUCTURAL,
        }}
      >
        {String(t("spotlight.loading"))}
      </p>
    </div>
  );
}

export default function AdminSearchPage() {
  return (
    <Suspense fallback={<AdminSearchFallback />}>
      <AdminSearchInner />
    </Suspense>
  );
}
