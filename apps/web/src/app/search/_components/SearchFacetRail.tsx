"use client";

/**
 * SearchFacetRail — the ONE implementation of /search's facet controls.
 *
 * Rendered twice-but-never-at-once: as a persistent left rail on desktop
 * (`variant="rail"`) and as the body of the mobile filters bottom sheet
 * (`variant="sheet"`). Keeping a single component is the point — the previous
 * design had the same four facets living inside a toggle-only panel, and any
 * mobile treatment would have forked them.
 *
 * Facet order is deliberate and fixed: Category → Date → Price → Distance,
 * most-used first (Baymard's "order facets by expected use, not by internal
 * grouping"). Do not reorder without a product decision.
 *
 * Apply model lives in the PARENT, not here. This component is controlled: it
 * reports every edit through `onChange` and renders whatever `draft` says.
 * On desktop the parent commits instantly (debounced for the price inputs);
 * on mobile it holds the draft until the sheet's commit button.
 *
 * Distance is the exception and does NOT ride the draft: geo + radius already
 * have their own commit paths (the radius has a 250 ms settle, the location
 * re-centres the results map), so they are wired straight through to the
 * parent's live handlers on both viewports.
 */

import { useMemo, type CSSProperties, type ReactNode } from "react";
import {
  Calendar,
  CalendarRange,
  Clapperboard,
  DollarSign,
  Dumbbell,
  HeartHandshake,
  MapPin,
  Mic,
  Music,
  Navigation,
  Palette,
  Presentation,
  Sparkles,
  Tag,
  Users,
  UtensilsCrossed,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  Checkbox,
  Chip,
  RangeSlider,
  Separator,
  Spinner,
  Text,
  useTranslations,
} from "@th/ui";

import LocationAutocomplete, {
  type PlaceDetail,
} from "@/components/maps/LocationAutocomplete";
import {
  datePresetsFor,
  detectActivePreset,
  type DatePresetId,
} from "./search-dates";
import { DANGER, FOREGROUND, MUTED_TEXT } from "@/lib/design-tokens";
import { chipActivation } from "./chip-keyboard";

// ── Tokens ───────────────────────────────────────────────────────────────────
// This surface renders raw style objects (no Tamagui styled()), so it reads the
// theme's CSS variables with the Stub value as the SSR fallback — same contract
// as the page it lives in.
const VAR_INK = FOREGROUND;
const VAR_MUTED = MUTED_TEXT;
const VAR_BORDER = "var(--borderColor, #211C16)";
const VAR_DANGER = DANGER;
const FIELD_FILL = "color-mix(in srgb, var(--color, #211C16) 4%, transparent)";

/**
 * Category slug → Lucide icon. Anything not mapped falls back to the generic
 * Tag icon so newly-added taxonomy still renders without a code change.
 */
const CATEGORY_ICONS: Record<string, LucideIcon> = {
  music: Music,
  nightlife: Sparkles,
  "food-drink": UtensilsCrossed,
  community: Users,
  "film-media": Clapperboard,
  "arts-culture": Palette,
  "sports-fitness": Dumbbell,
  "conference-workshop": Presentation,
  "support-recovery": HeartHandshake,
  "open-mics": Mic,
};

/** Preset copy. The windows themselves live in ./search-dates. */
const DATE_PRESET_LABELS: Record<DatePresetId, string> = {
  today: "Today",
  "this-weekend": "This weekend",
  "next-7": "Next 7 days",
  "this-month": "This month",
};

// ── Types ────────────────────────────────────────────────────────────────────

/** The event-only facet values the parent commits as one snapshot. */
export type FacetDraft = {
  categories: string[];
  dateFrom: string;
  dateTo: string;
  freeOnly: boolean;
  priceMin: string;
  priceMax: string;
};

export type SearchFacetRailProps = {
  /** `rail` = persistent desktop column; `sheet` = mobile bottom-sheet body. */
  variant: "rail" | "sheet";
  /** Taxonomy for the Category facet. */
  categoryOptions: readonly { slug: string; name: string }[];
  categoriesLoading: boolean;
  draft: FacetDraft;
  onChange: (patch: Partial<FacetDraft>) => void;
  /**
   * Event-only facets (category / date / price) are meaningless once the scope
   * narrows to people / groups / venues — Distance still applies to all four
   * entity types, so it renders regardless.
   */
  showEventFacets: boolean;

  // ── Distance (live, not part of the draft — see the file header) ──
  geoLabel: string | null;
  locationQuery: string;
  onLocationQueryChange: (value: string) => void;
  onLocationSelect: (place: PlaceDetail) => void;
  onUseMyLocation: () => void;
  onClearLocation: () => void;
  locating: boolean;
  locationError: boolean;
  radiusLabel: string;
  radiusSliderValue: number;
  radiusSliderConfig: { min: number; max: number; step: number };
  onRadiusSliderChange: (value: number) => void;
};

// ── Styles ───────────────────────────────────────────────────────────────────

const f = {
  // Deliberately NOT sticky. A sticky rail has to cap its height and scroll
  // internally, which turns it into a scroll container that clips the location
  // autocomplete's dropdown — and the Distance facet is the LAST one, so the
  // dropdown lands exactly where the clipping is worst. The rail scrolling
  // with the page is also what every listings sidebar does.
  rail: {
    display: "flex",
    flexDirection: "column",
    gap: 28,
    flex: "0 0 260px",
    width: 260,
    minWidth: 0,
    alignSelf: "stretch",
    paddingRight: 20,
    borderRight: `2px solid ${VAR_BORDER}`,
  } satisfies CSSProperties,

  sheet: {
    display: "flex",
    flexDirection: "column",
    gap: 28,
    width: "100%",
    minWidth: 0,
  } satisfies CSSProperties,

  facet: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
  } satisfies CSSProperties,

  facetHeader: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    color: VAR_MUTED,
  } satisfies CSSProperties,

  stack: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    minWidth: 0,
  } satisfies CSSProperties,

  chipRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
    alignItems: "center",
  } satisfies CSSProperties,

  fieldRow: {
    display: "flex",
    gap: 8,
    alignItems: "flex-start",
    minWidth: 0,
  } satisfies CSSProperties,

  hint: {
    margin: 0,
    fontSize: 13,
    color: VAR_MUTED,
  } satisfies CSSProperties,

  error: {
    margin: 0,
    fontSize: 13,
    color: VAR_DANGER,
  } satisfies CSSProperties,

  orRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  } satisfies CSSProperties,

  orLine: {
    flex: 1,
    height: 1,
    backgroundColor: VAR_BORDER,
  } satisfies CSSProperties,

  radiusRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  } satisfies CSSProperties,

  skeleton: {
    display: "block",
    height: 18,
    width: "100%",
  } satisfies CSSProperties,
} as const;

// ── Facet frame ──────────────────────────────────────────────────────────────
// A labelled group, not a landmark: `role="group"` + an accessible name so a
// screen reader announces "Category, group" when entering the controls.

function Facet({
  icon: Icon,
  label,
  testId,
  children,
}: {
  icon: LucideIcon;
  label: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <div role="group" aria-label={label} style={f.facet} data-testid={testId}>
      <div style={f.facetHeader}>
        <Icon size={12} strokeWidth={2} aria-hidden />
        <Text variant="overline" tone="muted">
          {label}
        </Text>
      </div>
      <Separator testId={`${testId}-rule`} />
      {children}
    </div>
  );
}

// ── Component ────────────────────────────────────────────────────────────────

export function SearchFacetRail({
  variant,
  categoryOptions,
  categoriesLoading,
  draft,
  onChange,
  showEventFacets,
  geoLabel,
  locationQuery,
  onLocationQueryChange,
  onLocationSelect,
  onUseMyLocation,
  onClearLocation,
  locating,
  locationError,
  radiusLabel,
  radiusSliderValue,
  radiusSliderConfig: slider,
  onRadiusSliderChange,
}: SearchFacetRailProps) {
  const t = useTranslations();

  // One clock reading per render, shared by the chip list and the highlight,
  // so the two can never disagree about which windows exist right now.
  const now = new Date();

  // `datePresetsFor` drops any preset whose window duplicates an earlier one
  // — "This weekend" on a Sunday, "This month" on the last of the month. See
  // ./search-dates for why that matters to the highlight.
  const datePresets = datePresetsFor(now).map(({ id, range }) => ({
    id,
    range,
    label: DATE_PRESET_LABELS[id],
  }));

  // Recomputed on every change so editing the From/To fields into a
  // recognisable window also lights the matching preset chip.
  const activePreset = useMemo(
    () => detectActivePreset(draft.dateFrom, draft.dateTo, new Date()),
    [draft.dateFrom, draft.dateTo],
  );

  const toggleCategory = (slug: string, checked: boolean) =>
    onChange({
      categories: checked
        ? [...draft.categories, slug]
        : draft.categories.filter((c) => c !== slug),
    });

  return (
    <div
      style={variant === "rail" ? f.rail : f.sheet}
      data-testid={
        variant === "rail" ? "search-facet-rail" : "search-facet-sheet-body"
      }
    >
      {showEventFacets && (
        <>
          {/* ── 1. Category ───────────────────────────────────────────── */}
          {/* "Category" rather than the existing `search.allCategories`
              ("All categories") — as a facet HEADING that string reads like a
              control that selects everything, which is not what it is. */}
          <Facet icon={Tag} label="Category" testId="facet-category">
            {categoriesLoading ? (
              <div style={f.stack} aria-busy data-testid="facet-category-loading">
                {[0, 1, 2, 3].map((i) => (
                  <span key={i} className="th-skeleton" style={f.skeleton} />
                ))}
              </div>
            ) : categoryOptions.length === 0 ? (
              <p style={f.hint}>No categories yet.</p>
            ) : (
              <div style={f.stack} data-testid="category-list">
                {categoryOptions.map((cat) => {
                  const Icon = CATEGORY_ICONS[cat.slug] ?? Tag;
                  return (
                    <Checkbox
                      key={cat.slug}
                      size="sm"
                      checked={draft.categories.includes(cat.slug)}
                      onCheckedChange={(next) =>
                        toggleCategory(cat.slug, next === true)
                      }
                      testIdBase={`category-${cat.slug}`}
                      label={
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 8,
                            minWidth: 0,
                          }}
                        >
                          <Icon
                            size={14}
                            strokeWidth={2}
                            aria-hidden
                            style={{ flexShrink: 0 }}
                          />
                          {cat.name}
                        </span>
                      }
                    />
                  );
                })}
              </div>
            )}
          </Facet>

          {/* ── 2. Date ───────────────────────────────────────────────── */}
          <Facet
            icon={Calendar}
            label={String(t("search.dateRange"))}
            testId="facet-date"
          >
            <div style={f.chipRow}>
              {datePresets.map(({ id, label, range }) => {
                const active = activePreset === id;
                const toggle = () => {
                  if (active) {
                    onChange({ dateFrom: "", dateTo: "" });
                    return;
                  }
                  onChange({ dateFrom: range.from, dateTo: range.to });
                };
                return (
                  <Chip
                    key={id}
                    tone={active ? "info" : "neutral"}
                    variant={active ? "filled" : "outline"}
                    size="sm"
                    interactive
                    icon={<CalendarRange size={12} aria-hidden />}
                    role="button"
                    aria-pressed={active}
                    onPress={toggle}
                    {...chipActivation(toggle)}
                    data-testid={`date-preset-${id}`}
                  >
                    {label}
                  </Chip>
                );
              })}
            </div>

            <div style={f.stack}>
              <NativeDateField
                label={String(t("search.dateFrom"))}
                value={draft.dateFrom}
                onChange={(v) => onChange({ dateFrom: v })}
                max={draft.dateTo || undefined}
                testId="filter-date-from"
              />
              <NativeDateField
                label={String(t("search.dateTo"))}
                value={draft.dateTo}
                onChange={(v) => onChange({ dateTo: v })}
                min={draft.dateFrom || undefined}
                testId="filter-date-to"
              />
            </div>
          </Facet>

          {/* ── 3. Price ──────────────────────────────────────────────── */}
          <Facet icon={DollarSign} label="Price" testId="facet-price">
            <Checkbox
              size="sm"
              checked={draft.freeOnly}
              onCheckedChange={(next) => onChange({ freeOnly: next === true })}
              testIdBase="filter-free-only"
              label={String(t("search.freeOnly"))}
            />
            {draft.freeOnly ? (
              <p style={f.hint}>
                Range disabled while &ldquo;{String(t("search.freeOnly"))}
                &rdquo; is on.
              </p>
            ) : (
              <div style={f.fieldRow}>
                <NativeNumberField
                  label="Min ($)"
                  value={draft.priceMin}
                  onChange={(v) => onChange({ priceMin: v })}
                  testId="filter-price-min"
                />
                <NativeNumberField
                  label="Max ($)"
                  value={draft.priceMax}
                  onChange={(v) => onChange({ priceMax: v })}
                  testId="filter-price-max"
                />
              </div>
            )}
          </Facet>
        </>
      )}

      {/* ── 4. Distance ─────────────────────────────────────────────── */}
      <Facet
        icon={MapPin}
        label={String(t("search.locationFilter"))}
        testId="facet-distance"
      >
        {geoLabel ? (
          <>
            <p style={{ ...f.hint, color: VAR_INK, fontWeight: 600 }}>
              {geoLabel}
            </p>
            <div style={f.radiusRow}>
              <Text variant="overline" tone="muted">
                {String(t("search.radius"))}
              </Text>
              <Text variant="overline" testId="radius-value">
                {radiusLabel}
              </Text>
            </div>
            <RangeSlider
              min={slider.min}
              max={slider.max}
              step={slider.step}
              value={radiusSliderValue}
              onValueChange={onRadiusSliderChange}
              label={String(t("search.radius"))}
              valueText={radiusLabel}
              testId="radius-slider"
            />
            <div style={f.chipRow}>
              <Chip
                tone="danger"
                variant="outline"
                size="sm"
                icon={<X size={12} aria-hidden />}
                interactive
                onPress={onClearLocation}
                {...chipActivation(onClearLocation)}
                data-testid="clear-location"
              >
                {String(t("search.clearLocation"))}
              </Chip>
            </div>
          </>
        ) : (
          <>
            <div style={f.chipRow}>
              <Chip
                tone="neutral"
                variant="outline"
                size="sm"
                icon={
                  locating ? (
                    <Spinner
                      size="sm"
                      screenReaderLabel={String(t("search.locating"))}
                    />
                  ) : (
                    <Navigation size={14} aria-hidden />
                  )
                }
                interactive
                onPress={onUseMyLocation}
                {...chipActivation(onUseMyLocation)}
                data-testid="use-my-location"
              >
                {locating
                  ? String(t("search.locating"))
                  : String(t("search.useMyLocation"))}
              </Chip>
            </div>

            {locationError && (
              <p style={f.error} role="status">
                {String(t("search.locationUnavailable"))}
              </p>
            )}

            <div style={f.orRow} aria-hidden>
              <span style={f.orLine} />
              <Text variant="overline" tone="muted">
                {String(t("search.or"))}
              </Text>
              <span style={f.orLine} />
            </div>

            <LocationAutocomplete
              value={locationQuery}
              onChange={onLocationQueryChange}
              onSelect={onLocationSelect}
              placeholder={String(t("search.locationPlaceholder"))}
              testIdBase="search-location"
            />
          </>
        )}
      </Facet>
    </div>
  );
}

SearchFacetRail.displayName = "SearchFacetRail";

// ── NativeDateField ─────────────────────────────────────────────────────────
// Thin wrapper around <input type="date">: the OS picker is faster on every
// platform than a custom wheel and gets locale + accessibility for free.

function NativeDateField({
  label,
  value,
  onChange,
  min,
  max,
  testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  min?: string;
  max?: string;
  testId: string;
}) {
  return (
    <label
      style={{
        flex: 1,
        // Without min-width: 0 the native date input refuses to shrink below
        // its intrinsic width (calendar icon + placeholder), so it overflows a
        // 260px rail. `box-sizing` keeps the padding inside the slot.
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <Text variant="overline" tone="muted">
        {label}
      </Text>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        min={min}
        max={max}
        data-testid={testId}
        style={{
          width: "100%",
          minWidth: 0,
          boxSizing: "border-box",
          minHeight: 44,
          padding: "10px 12px",
          fontFamily: "inherit",
          fontSize: 14,
          color: VAR_INK,
          background: FIELD_FILL,
          border: `1px solid ${VAR_BORDER}`,
          borderRadius: 0,
        }}
      />
    </label>
  );
}

// ── NativeNumberField ───────────────────────────────────────────────────────
// Same pattern as NativeDateField, for the price-range min/max inputs.

function NativeNumberField({
  label,
  value,
  onChange,
  testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  testId: string;
}) {
  return (
    <label
      style={{
        flex: 1,
        // See NativeDateField — same shrink-in-flex-row issue applies.
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <Text variant="overline" tone="muted">
        {label}
      </Text>
      <input
        type="number"
        inputMode="numeric"
        min={0}
        step={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="—"
        data-testid={testId}
        style={{
          width: "100%",
          minWidth: 0,
          boxSizing: "border-box",
          minHeight: 44,
          padding: "10px 12px",
          fontFamily: "inherit",
          fontSize: 14,
          color: VAR_INK,
          background: FIELD_FILL,
          border: `1px solid ${VAR_BORDER}`,
          borderRadius: 0,
        }}
      />
    </label>
  );
}
