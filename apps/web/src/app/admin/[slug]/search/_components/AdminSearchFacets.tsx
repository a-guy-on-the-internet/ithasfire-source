"use client";

/**
 * AdminSearchFacets — the facet bar for /admin/[slug]/search (FR-011).
 *
 * ## Why this is not `SpotlightAdminFacets`
 *
 * The MODEL is shared verbatim (`spotlight-admin-facets.ts` — same state, same
 * `buildAdminFacetInput`, same URL param writer), and so are the pill styles,
 * so the two surfaces stay visually and behaviourally identical. Only the
 * PRESENTATION differs, and deliberately:
 *
 * The overlay hides its options behind three trigger pills because ten option
 * pills wrap to three lines inside a 640px panel that also has to hold the
 * results. This page is the admin content column — it has the width for the
 * options inline, and on a results page the whole point is that the current
 * filter state is legible at a glance rather than one click away behind
 * "Status: Drafts". The overlay's expander is a compromise for a small
 * surface; inheriting it here would import the compromise without the reason.
 *
 * Category is the exception: the platform taxonomy runs to a dozen-plus
 * entries, which is a wall of pills on any width, so it stays a native select
 * (which also gets keyboard, type-ahead and mobile pickers for free).
 */

import { useId, useMemo, useState, type CSSProperties } from "react";
import { SlidersHorizontal } from "lucide-react";
import { useLocale, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { withCategoryDisplayNames } from "@/lib/category-display-name";
import { styles } from "@/components/search/spotlight-styles";
import {
  ADMIN_DATE_FACETS,
  ADMIN_DATE_LABEL_KEY,
  ADMIN_GROUPS,
  ADMIN_GROUP_LABEL_KEY,
  ADMIN_STATUS_FACETS,
  ADMIN_STATUS_LABEL_KEY,
  ADMIN_UNCATEGORISED_LABEL_KEY,
  EMPTY_ADMIN_FACETS,
  buildAdminDateRange,
  hasActiveAdminFacets,
  type AdminDateFacet,
  type AdminGroup,
  type AdminStatusFacet,
} from "@/components/search/spotlight-admin-facets";
import { ACCENT_TEXT, STRUCTURAL } from "@/lib/design-tokens";

import type { AdminSearchUrlState } from "../_lib/admin-search-url";

export type AdminSearchFacetsProps = {
  state: AdminSearchUrlState;
  onChange: (next: AdminSearchUrlState) => void;
  /**
   * Whether the status/date/category rows apply at all. False when the entity
   * pill is pinned to Attendees or Venues — those groups take no facets, and a
   * greyed-out row still implies these filters mean something for them.
   */
  facetsApply: boolean;
  isMobile: boolean;
};

export function AdminSearchFacets({
  state,
  onChange,
  facetsApply,
  isMobile,
}: AdminSearchFacetsProps) {
  const t = useTranslations();
  const idBase = useId();
  const panelId = `${idBase}-panel`;

  /**
   * On a phone the inline bar is nine wrapped rows — measured at 320x640 its
   * last control sits at y=754, i.e. the FILTER BAR ALONE IS TALLER THAN THE
   * SCREEN, and no result is reachable without scrolling past a full viewport
   * of chrome on a page whose whole job is showing results.
   *
   * So the bar collapses behind one disclosure at narrow widths only. Desktop
   * keeps it inline: there the width genuinely earns the legibility, which is
   * why this is not the overlay's expander applied everywhere. Same precedent
   * the spec sanctions ("following the geo-panel expander pattern"), applied
   * only where the space actually demands it.
   */
  const [expanded, setExpanded] = useState(false);
  const showRows = !isMobile || expanded;

  const pillStyle = useMemo<CSSProperties>(
    () => ({ ...styles.pill, ...(isMobile ? styles.pillMobile : {}) }),
    [isMobile],
  );

  // Only reach for the taxonomy when the category control is actually on
  // screen — the same gate the overlay applies.
  const categoriesQuery = trpc.categories.list.useQuery(undefined, {
    staleTime: 5 * 60_000,
    enabled: facetsApply,
  });
  const locale = useLocale();
  const categories = useMemo(
    () =>
      withCategoryDisplayNames(categoriesQuery.data?.categories ?? [], locale),
    [categoriesQuery.data, locale],
  );

  const { facets } = state;
  const anythingActive = state.group !== null || hasActiveAdminFacets(facets);

  const setGroup = (group: AdminGroup | null) => onChange({ ...state, group });

  const setStatus = (status: AdminStatusFacet) =>
    onChange({ ...state, facets: { ...facets, status } });

  const setDate = (date: AdminDateFacet) =>
    onChange({
      ...state,
      facets: {
        ...facets,
        date,
        // Freeze "now" at selection time — a per-render `Date.now()` would
        // re-key the tRPC query on every tick and refetch in a loop.
        dateAnchorMs:
          date === "UPCOMING" || date === "PAST" ? Date.now() : null,
        ...(date === "CUSTOM" ? {} : { customFrom: "", customTo: "" }),
      },
    });

  const setCategory = (categoryId: string | null) =>
    onChange({ ...state, facets: { ...facets, categoryId } });

  /**
   * Toggles INDEPENDENTLY of the select — the two arms compose, so "Music"
   * plus this is "Music or uncategorised", and this alone is "only
   * uncategorised". It cannot be an `<option>`: a single-select could only
   * ever express one of the two.
   */
  const toggleUncategorised = () =>
    onChange({
      ...state,
      facets: { ...facets, includeUncategorised: !facets.includeUncategorised },
    });

  /**
   * How many facets are actually FILTERING, for the collapsed label. A blank
   * "Custom range" is a mode with no bound, so it is deliberately not counted
   * — badging it would claim a filter the results do not reflect.
   *
   * Category counts ONCE however many of its arms are lit: this badge counts
   * facets, not selections, and "Music + Uncategorised" is one category filter.
   */
  const activeFacetCount =
    (state.group !== null ? 1 : 0) +
    (facets.status !== "ALL" ? 1 : 0) +
    (buildAdminDateRange(facets) ? 1 : 0) +
    (facets.categoryId || facets.includeUncategorised ? 1 : 0);

  return (
    <div style={barStyle} data-testid="admin-search-facets">
      {isMobile && (
        <div style={rowStyle}>
          <button
            type="button"
            style={{
              ...pillStyle,
              // Accent FILL + its white ink (5.92:1). The count has to be
              // legible while collapsed, and this is the same treatment the
              // overlay gives an active facet trigger.
              ...(activeFacetCount > 0 ? styles.pillAccent : {}),
            }}
            aria-expanded={expanded}
            aria-controls={expanded ? panelId : undefined}
            onClick={() => setExpanded((prev) => !prev)}
            data-testid="admin-facet-toggle"
          >
            <SlidersHorizontal size={12} strokeWidth={2.5} aria-hidden />
            {/* The count is IN the label, not a separate badge: arriving from
                a "View all" hand-off or a shared link means filters the user
                did not set themselves, and a collapsed bar that said only
                "Filters" would hide exactly the state they most need. */}
            {String(t("spotlight.facetsToggle", { count: activeFacetCount }))}
          </button>
        </div>
      )}

      {showRows && (
        <div id={panelId} style={panelStyle} data-testid="admin-facet-panel">
          <FacetRow
            id={`${idBase}-type`}
            label={String(t("spotlight.facetType"))}
            isMobile={isMobile}
          >
            <FacetPill
              testId="admin-facet-type-all"
              label={String(t("spotlight.filterAll"))}
              active={state.group === null}
              pillStyle={pillStyle}
              onPress={() => setGroup(null)}
            />
            {ADMIN_GROUPS.map((group) => (
              <FacetPill
                key={group}
                testId={`admin-facet-type-${group}`}
                label={String(t(ADMIN_GROUP_LABEL_KEY[group]))}
                active={state.group === group}
                pillStyle={pillStyle}
                onPress={() => setGroup(state.group === group ? null : group)}
              />
            ))}
          </FacetRow>

          {facetsApply && (
            <>
              <FacetRow
                id={`${idBase}-status`}
                label={String(t("spotlight.facetStatus"))}
                isMobile={isMobile}
              >
                {ADMIN_STATUS_FACETS.map((option) => (
                  <FacetPill
                    key={option}
                    testId={`admin-facet-status-${option}`}
                    label={String(t(ADMIN_STATUS_LABEL_KEY[option]))}
                    active={facets.status === option}
                    pillStyle={pillStyle}
                    onPress={() => setStatus(option)}
                  />
                ))}
              </FacetRow>

              <FacetRow
                id={`${idBase}-date`}
                label={String(t("spotlight.facetDate"))}
                isMobile={isMobile}
              >
                {ADMIN_DATE_FACETS.map((option) => (
                  <FacetPill
                    key={option}
                    testId={`admin-facet-date-${option}`}
                    label={String(t(ADMIN_DATE_LABEL_KEY[option]))}
                    active={facets.date === option}
                    pillStyle={pillStyle}
                    onPress={() => setDate(option)}
                  />
                ))}
                {facets.date === "CUSTOM" && (
                  <span style={dateFieldsStyle}>
                    <DateField
                      label={String(t("spotlight.dateFrom"))}
                      value={facets.customFrom}
                      max={facets.customTo || undefined}
                      testId="admin-facet-date-from"
                      isMobile={isMobile}
                      onChange={(customFrom) =>
                        onChange({
                          ...state,
                          facets: { ...facets, customFrom },
                        })
                      }
                    />
                    <DateField
                      label={String(t("spotlight.dateTo"))}
                      value={facets.customTo}
                      min={facets.customFrom || undefined}
                      testId="admin-facet-date-to"
                      isMobile={isMobile}
                      onChange={(customTo) =>
                        onChange({ ...state, facets: { ...facets, customTo } })
                      }
                    />
                  </span>
                )}
              </FacetRow>

              <div style={rowStyle}>
                <label style={selectLabelStyle}>
                  <span style={labelTextStyle}>
                    {String(t("spotlight.facetCategory"))}
                  </span>
                  <select
                    value={facets.categoryId ?? ""}
                    onChange={(e) => setCategory(e.target.value || null)}
                    style={{
                      ...selectStyle,
                      ...(isMobile ? { minHeight: 44 } : {}),
                    }}
                    data-testid="admin-facet-category"
                  >
                    <option value="">
                      {String(t("spotlight.categoryAll"))}
                    </option>
                    {categories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                </label>
                {/* A peer of the categories in the same row, not a control of
                    its own: "uncategorised" is one more thing the category
                    facet can select, it just cannot live INSIDE a single-select
                    because it composes with whatever that select holds. */}
                <FacetPill
                  testId="admin-facet-uncategorised"
                  label={String(t(ADMIN_UNCATEGORISED_LABEL_KEY))}
                  active={facets.includeUncategorised}
                  pillStyle={pillStyle}
                  onPress={toggleUncategorised}
                />
              </div>
            </>
          )}

          {/* Outside the `facetsApply` block on purpose: pinning a non-event pill
          hides the status/date/category rows, and if the only way to clear
          them lived in there, a filter the user cannot SEE would also be a
          filter they cannot CLEAR. */}
          {anythingActive && (
            <div style={rowStyle}>
              <button
                type="button"
                style={{
                  ...pillStyle,
                  // `border` shorthand, never `borderColor` longhand beside it —
                  // mixing the two makes React warn ("Removing a style property
                  // during rerender…") and drop the colour on every toggle.
                  border: `1px solid ${STRUCTURAL}`,
                  color: "var(--color, #211C16)",
                }}
                onClick={() =>
                  onChange({
                    ...state,
                    group: null,
                    facets: EMPTY_ADMIN_FACETS,
                  })
                }
                data-testid="admin-facet-clear-all"
              >
                {String(t("spotlight.clearFilters"))}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

AdminSearchFacets.displayName = "AdminSearchFacets";

// ── Row primitives ───────────────────────────────────────────────────────────

function FacetRow({
  id,
  label,
  isMobile,
  children,
}: {
  id: string;
  label: string;
  isMobile: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        ...rowStyle,
        ...(isMobile ? { alignItems: "flex-start" } : {}),
      }}
      role="group"
      aria-labelledby={id}
    >
      <span id={id} style={labelTextStyle}>
        {label}
      </span>
      {children}
    </div>
  );
}

/**
 * A real `<button>` with `aria-pressed` (NFR-003) — the active state is not
 * conveyed by colour alone, and on touch the pill grows to the 44px floor via
 * `styles.pillMobile` rather than shrinking the type.
 */
function FacetPill({
  testId,
  label,
  active,
  pillStyle,
  onPress,
}: {
  testId: string;
  label: string;
  active: boolean;
  pillStyle: CSSProperties;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      style={{ ...pillStyle, ...(active ? styles.pillActive : {}) }}
      aria-pressed={active}
      onClick={onPress}
      data-testid={testId}
    >
      {label}
    </button>
  );
}

/**
 * Native `<input type="date">` — the same choice the consumer search page and
 * the overlay make. The OS picker beats a custom wheel on every platform and
 * brings locale + a11y with it.
 */
function DateField({
  label,
  value,
  min,
  max,
  testId,
  isMobile,
  onChange,
}: {
  label: string;
  value: string;
  min?: string;
  max?: string;
  testId: string;
  isMobile: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label style={dateFieldStyle}>
      <span style={labelTextStyle}>{label}</span>
      <input
        type="date"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(e.target.value)}
        style={{
          ...styles.facetDateInput,
          ...(isMobile ? styles.facetDateInputMobile : {}),
        }}
        data-testid={testId}
      />
    </label>
  );
}

// ── Styles (page idiom: inline CSSProperties, tokens only) ───────────────────

const barStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: "12px 0 16px",
  marginBottom: 24,
  borderTop: "1px solid var(--borderColor, #211C16)",
  borderBottom: "1px solid var(--borderColor, #211C16)",
};

/** The rows themselves — one column, whether inline (desktop) or disclosed. */
const panelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  flexWrap: "wrap",
};

const labelTextStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 900,
  textTransform: "uppercase",
  letterSpacing: "0.14em",
  // Accent as INK → the #B93312 rung. `ACCENT` (#E2481D) at 10px is ~3.6:1.
  color: ACCENT_TEXT,
  minWidth: 68,
};

const dateFieldsStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  gap: 8,
  flexWrap: "wrap",
};

const dateFieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  minWidth: 0,
};

const selectLabelStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  // A flex item's default `min-width: auto` refuses to shrink below its
  // content, so without these the label + select pushed past a 320px viewport
  // (measured: right edge 336px) and widened the whole document — which then
  // made every `width: 100%` element, including the shell's bottom nav, report
  // an overflow it had not caused.
  minWidth: 0,
  maxWidth: "100%",
};

const selectStyle: CSSProperties = {
  padding: "6px 10px",
  // Montserrat is the house UI face. (The `Inter` fallbacks in
  // `spotlight-styles.ts` are pre-existing and deliberately left alone — this
  // is the correct value, not a third convention.)
  fontFamily: "var(--font-body, Montserrat, sans-serif)",
  fontSize: 12,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--color, #211C16)",
  backgroundColor: "var(--surface, #FDFAF3)",
  border: "1px solid var(--borderColor, #211C16)",
  borderRadius: 0,
  // Prefer 180px (the taxonomy's longest label needs it on desktop) but stay
  // shrinkable: a hard `minWidth` here is what overflowed 320px. `flex-basis`
  // expresses the preference; `min-width: 0` lets the flex algorithm win when
  // the viewport can't afford it.
  flex: "1 1 180px",
  minWidth: 0,
  maxWidth: "100%",
};
