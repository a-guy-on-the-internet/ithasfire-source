"use client";

/**
 * SpotlightAdminFacets — admin-only facet row for the ⌘K overlay (FR-004).
 *
 * Three trigger pills (Status / Date / Category) that expand a single shared
 * panel underneath, following the geo-panel expander pattern already in
 * `SpotlightSearch`. Ten option pills inline on one row would wrap to three
 * lines at 640px and read as a wall at 320px; the trigger carries its active
 * value ("Status: Drafts") so the state stays legible without opening.
 *
 * Every facet here is EVENTS-ONLY — `searchOrgAdmin` forwards them to
 * `events.listByOwner` and leaves the attendees/venues groups alone.
 *
 * The facet MODEL (state shape, tRPC-input mapping, URL param names) lives in
 * the React-free `./spotlight-admin-facets` module so `/admin/[slug]/search`
 * can share it without importing this overlay; it is re-exported here so the
 * Phase A import path keeps working.
 */

import { useCallback, useId, useMemo, useState, type CSSProperties } from "react";
import { Calendar, SlidersHorizontal, Tag, X } from "lucide-react";
import { useLocale, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { withCategoryDisplayNames } from "@/lib/category-display-name";

import {
  ADMIN_DATE_FACETS,
  ADMIN_DATE_LABEL_KEY,
  ADMIN_STATUS_FACETS,
  ADMIN_STATUS_LABEL_KEY,
  ADMIN_UNCATEGORISED_LABEL_KEY,
  buildAdminDateRange,
  type AdminDateFacet,
  type AdminFacetState,
  type AdminStatusFacet,
} from "./spotlight-admin-facets";
import { styles } from "./spotlight-styles";

export * from "./spotlight-admin-facets";

// ── Component ────────────────────────────────────────────────────────────────

type OpenFacet = "status" | "date" | "category" | null;

export type SpotlightAdminFacetsProps = {
  state: AdminFacetState;
  onChange: (next: AdminFacetState) => void;
  isMobile: boolean;
};

export function SpotlightAdminFacets({
  state,
  onChange,
  isMobile,
}: SpotlightAdminFacetsProps) {
  const t = useTranslations();
  const panelId = useId();
  const [open, setOpen] = useState<OpenFacet>(null);

  const pillStyle = useMemo<CSSProperties>(
    () => ({ ...styles.pill, ...(isMobile ? styles.pillMobile : {}) }),
    [isMobile],
  );
  const clearStyle = useMemo<CSSProperties>(
    () => ({
      ...styles.geoClearButton,
      ...(isMobile ? styles.geoClearButtonMobile : {}),
    }),
    [isMobile],
  );

  const statusActive = state.status !== "ALL";
  const dateRange = buildAdminDateRange(state);
  const dateActive = Boolean(dateRange);
  // ONE facet with two arms: a concrete category, "uncategorised", or both.
  const categoryActive = Boolean(state.categoryId) || state.includeUncategorised;

  // Only reach for the taxonomy when the user actually opens the category
  // panel (or already has one selected and needs its name rendered).
  const categoriesQuery = trpc.categories.list.useQuery(undefined, {
    staleTime: 5 * 60_000,
    enabled: open === "category" || state.categoryId !== null,
  });
  const locale = useLocale();
  const categories = useMemo(
    () =>
      withCategoryDisplayNames(categoriesQuery.data?.categories ?? [], locale),
    [categoriesQuery.data, locale],
  );
  const selectedCategoryName = useMemo(
    () => categories.find((c) => c.id === state.categoryId)?.name ?? null,
    [categories, state.categoryId],
  );

  const toggleOpen = useCallback((facet: Exclude<OpenFacet, null>) => {
    setOpen((prev) => (prev === facet ? null : facet));
  }, []);

  /**
   * Picking an option collapses the expander. Without this, the moment anyone
   * touches a facet they carry the trigger row PLUS six option pills for the
   * rest of the session — strictly more chrome than inline pills would have
   * cost, which is the whole reason the expander exists.
   */
  const setStatus = useCallback(
    (status: AdminStatusFacet) => {
      onChange({ ...state, status });
      setOpen(null);
    },
    [onChange, state],
  );

  const setDate = useCallback(
    (date: AdminDateFacet) => {
      onChange({
        ...state,
        date,
        // Freeze "now" at selection time — a per-render `Date.now()` would
        // re-key the query on every tick.
        dateAnchorMs:
          date === "UPCOMING" || date === "PAST" ? Date.now() : null,
        ...(date === "CUSTOM" ? {} : { customFrom: "", customTo: "" }),
      });
      // CUSTOM is the exception: the from/to inputs live in this panel, so
      // collapsing would yank them out from under the user mid-task.
      if (date !== "CUSTOM") setOpen(null);
    },
    [onChange, state],
  );

  const setCategory = useCallback(
    (categoryId: string | null) => {
      onChange({ ...state, categoryId });
      setOpen(null);
    },
    [onChange, state],
  );

  /**
   * Toggles INDEPENDENTLY of `categoryId` — the two compose ("Music" plus this
   * is "Music or uncategorised"). It also does not collapse the panel: picking
   * a category is a choice that ends the interaction, whereas this is the one
   * option someone is likely to add to a selection they just made.
   */
  const toggleUncategorised = useCallback(() => {
    onChange({ ...state, includeUncategorised: !state.includeUncategorised });
  }, [onChange, state]);

  const clearStatus = useCallback(() => setStatus("ALL"), [setStatus]);
  const clearDate = useCallback(() => setDate("ANY"), [setDate]);
  /** Clears BOTH arms — a facet you cannot see must not be a facet you cannot clear. */
  const clearCategory = useCallback(() => {
    onChange({ ...state, categoryId: null, includeUncategorised: false });
    setOpen(null);
  }, [onChange, state]);

  const statusLabel = String(t(ADMIN_STATUS_LABEL_KEY[state.status]));
  const dateLabel = String(t(ADMIN_DATE_LABEL_KEY[state.date]));
  const uncategorisedLabel = String(t(ADMIN_UNCATEGORISED_LABEL_KEY));

  /**
   * The trigger's value line. Both arms can be on at once, so this is a list,
   * not a single name — "Category: Music, Uncategorised" is the honest summary
   * of a filter that matches both.
   */
  const categoryValueLabel = useMemo(() => {
    const parts = [
      ...(selectedCategoryName ? [selectedCategoryName] : []),
      ...(state.includeUncategorised ? [uncategorisedLabel] : []),
    ];
    return parts.length > 0 ? parts.join(", ") : null;
  }, [selectedCategoryName, state.includeUncategorised, uncategorisedLabel]);

  return (
    <>
      <div style={styles.facetRow} data-testid="spotlight-facet-row">
        <FacetTrigger
          testId="spotlight-facet-status"
          icon={SlidersHorizontal}
          label={String(t("spotlight.facetStatus"))}
          value={statusActive ? statusLabel : null}
          active={statusActive}
          expanded={open === "status"}
          panelId={panelId}
          pillStyle={pillStyle}
          onPress={() => toggleOpen("status")}
        />
        {statusActive && (
          <ClearFacetButton
            testId="spotlight-facet-status-clear"
            label={String(
              t("spotlight.facetClear", {
                facet: String(t("spotlight.facetStatus")),
              }),
            )}
            style={clearStyle}
            onPress={clearStatus}
          />
        )}

        <FacetTrigger
          testId="spotlight-facet-date"
          icon={Calendar}
          label={String(t("spotlight.facetDate"))}
          value={dateActive ? dateLabel : null}
          active={dateActive}
          expanded={open === "date"}
          panelId={panelId}
          pillStyle={pillStyle}
          onPress={() => toggleOpen("date")}
        />
        {dateActive && (
          <ClearFacetButton
            testId="spotlight-facet-date-clear"
            label={String(
              t("spotlight.facetClear", {
                facet: String(t("spotlight.facetDate")),
              }),
            )}
            style={clearStyle}
            onPress={clearDate}
          />
        )}

        <FacetTrigger
          testId="spotlight-facet-category"
          icon={Tag}
          label={String(t("spotlight.facetCategory"))}
          value={categoryValueLabel}
          active={categoryActive}
          expanded={open === "category"}
          panelId={panelId}
          pillStyle={pillStyle}
          onPress={() => toggleOpen("category")}
        />
        {categoryActive && (
          <ClearFacetButton
            testId="spotlight-facet-category-clear"
            label={String(
              t("spotlight.facetClear", {
                facet: String(t("spotlight.facetCategory")),
              }),
            )}
            style={clearStyle}
            onPress={clearCategory}
          />
        )}
      </div>

      {open !== null && (
        <div
          id={panelId}
          style={styles.facetPanel}
          data-testid="spotlight-facet-panel"
        >
          {open === "status" && (
            <div style={styles.facetOptionRow} role="group" aria-label={String(t("spotlight.facetStatus"))}>
              {ADMIN_STATUS_FACETS.map((option) => (
                <OptionPill
                  key={option}
                  testId={`spotlight-status-${option}`}
                  label={String(t(ADMIN_STATUS_LABEL_KEY[option]))}
                  active={state.status === option}
                  pillStyle={pillStyle}
                  onPress={() => setStatus(option)}
                />
              ))}
            </div>
          )}

          {open === "date" && (
            <>
              <div style={styles.facetOptionRow} role="group" aria-label={String(t("spotlight.facetDate"))}>
                {ADMIN_DATE_FACETS.map((option) => (
                  <OptionPill
                    key={option}
                    testId={`spotlight-date-${option}`}
                    label={String(t(ADMIN_DATE_LABEL_KEY[option]))}
                    active={state.date === option}
                    pillStyle={pillStyle}
                    onPress={() => setDate(option)}
                  />
                ))}
              </div>
              {state.date === "CUSTOM" && (
                <div style={{ display: "flex", gap: 8 }}>
                  <DateField
                    label={String(t("spotlight.dateFrom"))}
                    value={state.customFrom}
                    max={state.customTo || undefined}
                    testId="spotlight-date-from"
                    isMobile={isMobile}
                    onChange={(customFrom) => onChange({ ...state, customFrom })}
                  />
                  <DateField
                    label={String(t("spotlight.dateTo"))}
                    value={state.customTo}
                    min={state.customFrom || undefined}
                    testId="spotlight-date-to"
                    isMobile={isMobile}
                    onChange={(customTo) => onChange({ ...state, customTo })}
                  />
                </div>
              )}
            </>
          )}

          {open === "category" && (
            <div style={styles.facetScroll} role="group" aria-label={String(t("spotlight.facetCategory"))}>
              {/* "All categories" is the absence of BOTH arms — with
                  "Uncategorised" on it is emphatically not "all", so it must
                  not read as selected, and pressing it clears both. */}
              <OptionPill
                testId="spotlight-category-all"
                label={String(t("spotlight.categoryAll"))}
                active={state.categoryId === null && !state.includeUncategorised}
                pillStyle={pillStyle}
                onPress={clearCategory}
              />
              {/* A peer of the categories, sitting where an "N/A" entry in the
                  taxonomy would — but a TOGGLE, because it composes with a
                  selected category rather than replacing it. */}
              <OptionPill
                testId="spotlight-category-uncategorised"
                label={uncategorisedLabel}
                active={state.includeUncategorised}
                pillStyle={pillStyle}
                onPress={toggleUncategorised}
              />
              {categories.map((category) => (
                <OptionPill
                  key={category.id}
                  testId={`spotlight-category-${category.slug}`}
                  label={category.name}
                  active={state.categoryId === category.id}
                  pillStyle={pillStyle}
                  onPress={() => setCategory(category.id)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}

SpotlightAdminFacets.displayName = "SpotlightAdminFacets";

// ── Row primitives ───────────────────────────────────────────────────────────

function FacetTrigger({
  testId,
  icon: Icon,
  label,
  value,
  active,
  expanded,
  panelId,
  pillStyle,
  onPress,
}: {
  testId: string;
  icon: typeof Calendar;
  label: string;
  value: string | null;
  active: boolean;
  expanded: boolean;
  panelId: string;
  pillStyle: CSSProperties;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      style={{ ...pillStyle, ...(active ? styles.pillAccent : {}) }}
      // Active state was conveyed by colour alone before NFR-003.
      aria-pressed={active}
      aria-expanded={expanded}
      aria-controls={expanded ? panelId : undefined}
      onClick={onPress}
      data-testid={testId}
    >
      <Icon size={12} strokeWidth={2.5} aria-hidden />
      {value ? `${label}: ${value}` : label}
    </button>
  );
}

function OptionPill({
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

function ClearFacetButton({
  testId,
  label,
  style,
  onPress,
}: {
  testId: string;
  label: string;
  style: CSSProperties;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      style={style}
      aria-label={label}
      onClick={onPress}
      data-testid={testId}
    >
      <X size={12} strokeWidth={2.5} aria-hidden />
    </button>
  );
}

/**
 * Native `<input type="date">` — the same choice the consumer search page
 * makes (`UniversalSearchPage`'s NativeDateField). The OS picker is faster on
 * every platform than a custom wheel and gets locale + a11y for free.
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
    <label style={styles.facetDateField}>
      <span style={styles.geoLabel}>{label}</span>
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
