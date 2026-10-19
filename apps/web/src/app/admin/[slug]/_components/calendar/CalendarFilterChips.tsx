"use client";

import type { ReactNode } from "react";
import { StyledSelect, Text } from "@th/ui";

import { Mono } from "./Mono";
import {
  CalendarFilterCheck,
  CalendarFilterDivider,
  CalendarFilterGroup,
  CalendarFilterMenu,
} from "./CalendarFilterMenu";
import {
  CAL_BORDER,
  CAL_BORDER_SOFT,
  STATUS_BAR,
  STATUS_BG,
} from "./status-colors";
import type {
  CalendarEventStatus,
  CalendarFilterOptions,
  CalendarFilters,
} from "./types";
import { useCalendarLabels } from "./use-calendar-labels";

const STATUS_ORDER: CalendarEventStatus[] = [
  "PUBLISHED",
  "DRAFT",
  "COMPLETED",
  "CANCELLED",
];

/** Above this many owners the chips become one menu (they wrapped to 3 rows). */
export const OWNER_CHIP_LIMIT = 3;

export type CalendarFilterChipsProps = {
  filters: CalendarFilters;
  onChange: (filters: CalendarFilters) => void;
  options: CalendarFilterOptions;
  /**
   * The engine's own box is under 600px — the WHOLE row collapses into one
   * "Filters" trigger. Measured on the engine, not the viewport (the admin
   * rail makes the window width a liar).
   */
  narrow?: boolean;
};

function ChipLabel({ children }: { children: string }) {
  // Same label grammar as SegmentedControl's segments — Montserrat 700,
  // uppercase, +1 tracking; the colour tracks the chip's pressed state.
  return (
    <Text
      variant="span"
      fontSize={11}
      lineHeight={14}
      letterSpacing={1}
      textTransform="uppercase"
      weight="bold"
      tone="inherit"
    >
      {children}
    </Text>
  );
}

function Divider() {
  return (
    <span
      aria-hidden
      style={{ width: 1, alignSelf: "stretch", minHeight: 20, background: CAL_BORDER_SOFT }}
    />
  );
}

function StatusSwatch({ status }: { status: CalendarEventStatus }) {
  return (
    <span
      aria-hidden
      style={{
        width: 10,
        height: 10,
        flexShrink: 0,
        background: STATUS_BG[status],
        borderLeft: `3px solid ${STATUS_BAR[status]}`,
      }}
    />
  );
}

function HoldSwatch() {
  return (
    <span
      aria-hidden
      style={{
        width: 10,
        height: 10,
        flexShrink: 0,
        border: `1.5px dashed ${CAL_BORDER}`,
      }}
    />
  );
}

/**
 * How many facets are narrowed relative to the mount's defaults — the "· 2"
 * on the collapsed trigger. Without `options.defaults` the neutral state is
 * "everything on", which is the honest reading for a mount that never told
 * us otherwise.
 */
export function activeFilterCount(
  filters: CalendarFilters,
  options: CalendarFilterOptions,
): number {
  const owners = options.owners ?? [];
  const defaultStatuses =
    options.defaults?.statuses ?? new Set<CalendarEventStatus>(STATUS_ORDER);
  const defaultHolds = options.defaults?.showHolds !== false;
  let count = 0;
  const sameStatuses =
    filters.statuses.size === defaultStatuses.size &&
    [...filters.statuses].every((s) => defaultStatuses.has(s));
  if (!sameStatuses) count += 1;
  // An empty set is "every owner" (see `allOwnersOn`), so it is not a
  // narrowing and must not put a badge on the trigger.
  if (
    filters.owners &&
    filters.owners.size > 0 &&
    owners.some((o) => !filters.owners!.has(o.key))
  ) {
    count += 1;
  }
  if (filters.seriesId && filters.seriesId !== "all") count += 1;
  if (options.holds && (filters.showHolds !== false) !== defaultHolds) count += 1;
  return count;
}

/**
 * The filter row under the toolbar (FR-015) — the legend's replacement.
 *
 * Three densities, because the row must never outgrow the calendar it filters
 * (a six-entity dashboard wrapped the chips onto three rows at 1440px and six
 * at 320px):
 *
 *  - **≥600px, ≤3 owners** — status chips, owner chips, the Holds chip and
 *    the series select, all inline. Four status chips fit one row.
 *  - **≥600px, >3 owners** — the owner chips collapse into ONE menu labelled
 *    "All owners" / the single owner's name / "{n} owners".
 *  - **<600px** — the whole row collapses into one 44px "Filters" trigger
 *    (with "· {n}" once a facet is off its default) opening a panel with
 *    status, owners, holds and series. Nothing else renders at that width.
 *
 * Every control keeps its original test id and `aria-pressed` grammar
 * wherever it lands. 28px chips, 2px borders, radius 0.
 */
export function CalendarFilterChips({
  filters,
  onChange,
  options,
  narrow = false,
}: CalendarFilterChipsProps) {
  const labels = useCalendarLabels();
  const owners = options.owners ?? [];
  const series = options.series ?? [];

  const toggleStatus = (status: CalendarEventStatus) => {
    const next = new Set(filters.statuses);
    if (next.has(status)) next.delete(status);
    else next.add(status);
    onChange({ ...filters, statuses: next });
  };

  // An absent set — and an EMPTY one — mean "every owner". An empty set used
  // to read as "match nothing", which painted "Nothing scheduled" over a full
  // fetch the moment the reader unticked the last owner.
  const allOwnersOn = !filters.owners || filters.owners.size === 0;
  const ownerOn = (key: string) => allOwnersOn || filters.owners!.has(key);
  const toggleOwner = (key: string) => {
    const all = owners.map((o) => o.key);
    const next = new Set(allOwnersOn ? all : filters.owners!);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    const everyOwner = all.every((k) => next.has(k));
    onChange({ ...filters, owners: everyOwner || next.size === 0 ? undefined : next });
  };

  const holdsOn = filters.showHolds !== false;
  const selectedOwners = owners.filter((o) => ownerOn(o.key));
  const ownerMenuLabel = allOwnersOn
    ? labels.allOwners
    : selectedOwners.length === 1
      ? (selectedOwners[0]?.label ?? labels.allOwners)
      : labels.ownerCount(selectedOwners.length);

  const statusChips = STATUS_ORDER.map((status) => (
    <button
      key={status}
      type="button"
      className="th-cal-btn th-cal-filter"
      aria-pressed={filters.statuses.has(status)}
      data-testid={`calendar-filter-status-${status.toLowerCase()}`}
      onClick={() => toggleStatus(status)}
    >
      <StatusSwatch status={status} />
      <ChipLabel>{labels.statuses[status]}</ChipLabel>
    </button>
  ));

  const ownerChips = owners.map((owner) => (
    <button
      key={owner.key}
      type="button"
      className="th-cal-btn th-cal-filter"
      aria-pressed={ownerOn(owner.key)}
      data-testid={`calendar-filter-owner-${owner.key}`}
      onClick={() => toggleOwner(owner.key)}
    >
      <ChipLabel>{owner.label}</ChipLabel>
    </button>
  ));

  const ownerChecks = owners.map((owner) => (
    <CalendarFilterCheck
      key={owner.key}
      label={owner.label}
      checked={ownerOn(owner.key)}
      onToggle={() => toggleOwner(owner.key)}
      testId={`calendar-filter-owner-${owner.key}`}
    />
  ));

  const holdsChip = (
    <button
      type="button"
      className="th-cal-btn th-cal-filter"
      aria-pressed={holdsOn}
      data-testid="calendar-filter-holds"
      onClick={() => onChange({ ...filters, showHolds: !holdsOn })}
    >
      <HoldSwatch />
      <ChipLabel>{labels.holds}</ChipLabel>
    </button>
  );

  const seriesSelect = (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
      <Mono size="xs" upper tone="muted">
        {labels.series}
      </Mono>
      <StyledSelect
        size="sm"
        borderRadius={0}
        height={28}
        minHeight={28}
        ariaLabel={labels.series}
        testId="calendar-filter-series"
        value={filters.seriesId ?? "all"}
        onChange={(value) => onChange({ ...filters, seriesId: value })}
        options={[
          { value: "all", label: labels.allSeries },
          ...series.map((s) => ({ value: s.id, label: s.name })),
        ]}
      />
    </label>
  );

  const rowStyle = {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
    padding: "10px 16px",
    borderBottom: `1px solid ${CAL_BORDER_SOFT}`,
    minWidth: 0,
    maxWidth: "100%",
  } as const;

  // ── Collapsed: one trigger, everything inside the panel ──────────────────
  if (narrow) {
    const count = activeFilterCount(filters, options);
    return (
      <div
        role="group"
        aria-label={labels.filtersGroup}
        data-testid="calendar-filters"
        style={rowStyle}
      >
        <CalendarFilterMenu
          testId="calendar-filters-menu"
          height={44}
          active={count > 0}
          label={count > 0 ? labels.filtersWithCount(count) : labels.filters}
          panelLabel={labels.filtersGroup}
        >
          <CalendarFilterGroup label={labels.status}>
            {STATUS_ORDER.map((status) => (
              <CalendarFilterCheck
                key={status}
                label={labels.statuses[status]}
                checked={filters.statuses.has(status)}
                onToggle={() => toggleStatus(status)}
                swatch={<StatusSwatch status={status} />}
                testId={`calendar-filter-status-${status.toLowerCase()}`}
              />
            ))}
          </CalendarFilterGroup>

          {owners.length > 1 && (
            <>
              <CalendarFilterDivider />
              <CalendarFilterGroup label={labels.owners}>{ownerChecks}</CalendarFilterGroup>
            </>
          )}

          {options.holds && (
            <>
              <CalendarFilterDivider />
              <CalendarFilterGroup label={labels.holds}>
                <CalendarFilterCheck
                  label={labels.holds}
                  checked={holdsOn}
                  onToggle={() => onChange({ ...filters, showHolds: !holdsOn })}
                  swatch={<HoldSwatch />}
                  testId="calendar-filter-holds"
                />
              </CalendarFilterGroup>
            </>
          )}

          {series.length > 0 && (
            <>
              <CalendarFilterDivider />
              <CalendarFilterGroup label={labels.series}>{seriesSelect}</CalendarFilterGroup>
            </>
          )}
        </CalendarFilterMenu>
      </div>
    );
  }

  // ── Inline row ──────────────────────────────────────────────────────────
  let ownerSlot: ReactNode = null;
  if (owners.length > OWNER_CHIP_LIMIT) {
    ownerSlot = (
      <>
        <Divider />
        <CalendarFilterMenu
          testId="calendar-owner-menu"
          active={!allOwnersOn}
          label={ownerMenuLabel}
          panelLabel={labels.owners}
        >
          <CalendarFilterGroup label={labels.owners}>{ownerChecks}</CalendarFilterGroup>
        </CalendarFilterMenu>
      </>
    );
  } else if (owners.length > 1) {
    ownerSlot = (
      <>
        <Divider />
        {ownerChips}
      </>
    );
  }

  return (
    <div
      role="group"
      aria-label={labels.filtersGroup}
      data-testid="calendar-filters"
      style={rowStyle}
    >
      {statusChips}
      {ownerSlot}
      {options.holds && (
        <>
          <Divider />
          {holdsChip}
        </>
      )}
      {series.length > 0 && (
        <>
          <Divider />
          {seriesSelect}
        </>
      )}
    </div>
  );
}
