"use client";

import { useMemo, type CSSProperties, type MouseEvent } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { styled, XStack, YStack } from "tamagui";

import {
  Badge,
  DataTable,
  Text,
  useTranslations,
  type DataTableColumn,
} from "@th/ui";

import { useIsMobile } from "@/hooks/useIsMobile";
import { ACCENT_TEXT, STRUCTURAL } from "@/lib/design-tokens";

import {
  fixedPriceText,
  rowCheckboxLabel,
  rowTitleText,
  seatCheckboxLabel,
  seatPriceSectionDomId,
  seatRemarkText,
  seatStatusText,
  sectionPriceText,
  type FormatCents,
  type SeatPriceTranslate,
} from "./seat-price-labels";
import type {
  RowGroupModel,
  SeatModel,
  SectionModel,
} from "./seat-price-model";
import type { SeatPriceViewProps } from "./seat-price-views";

export type SeatPriceListProps = SeatPriceViewProps & {
  /** Sections whose seats are showing. A 300-seat section stays shut until asked for. */
  openSectionIds: ReadonlySet<string>;
  onToggleSection: (sectionId: string) => void;
  /** Say "not on the map" on a section with no layout glyphs. Off until the Map view exists. */
  showMapHints: boolean;
};

/**
 * The section band: name, counts and the section price with the ticket type
 * it comes from. It is the disclosure button for the section's seats, so a
 * long section collapses to one line.
 */
const SectionBand = styled(XStack, {
  name: "SeatPriceSectionBand",
  tag: "button",
  width: "100%",
  flexWrap: "wrap",
  alignItems: "center",
  columnGap: 12,
  rowGap: 6,
  minHeight: 44,
  paddingVertical: 12,
  paddingHorizontal: 16,
  borderWidth: 0,
  borderTopWidth: 2,
  borderColor: "$borderColor",
  borderRadius: 0,
  backgroundColor: "transparent",
  cursor: "pointer",
  hoverStyle: { backgroundColor: "$backgroundHover" },
  focusVisibleStyle: {
    outlineWidth: 2,
    outlineStyle: "solid",
    outlineColor: "$focus",
    outlineOffset: -2,
  },
});

/**
 * Column weights shared by every row table and the section's one head strip,
 * so the strip's heads sit over the tables' columns. DataTable turns weights
 * into percentages of the flexible columns; the checkbox column is fixed.
 */
const COLUMN_WEIGHTS = { seat: 2, status: 4, price: 4, note: 4 } as const;
const CHECKBOX_COLUMN_PX = 48; // DataTable's column for an "lg" checkbox.
const TOTAL_WEIGHT = Object.values(COLUMN_WEIGHTS).reduce((a, b) => a + b, 0);

// The DataTable header idiom (mono 10px / 600 / 2.5px, uppercase).
const headTextStyle: CSSProperties = {
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
  fontWeight: 600,
  fontSize: 10,
  letterSpacing: "2.5px",
  textTransform: "uppercase",
  textAlign: "left",
  padding: "8px 10px",
};

/** Rows a press can toggle: the ones that render a checkbox. */
const ROW_PRESS_CSS =
  '[data-seat-rows] [data-row-key]:has([role="checkbox"]){cursor:pointer}';

const visuallyHidden: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

const monoPrice = {
  fontFamily: "$mono",
  fontSize: 13,
  letterSpacing: 0.4,
} as const;

const customTagStyle: CSSProperties = {
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
  fontSize: 9.5,
  letterSpacing: 2.5,
  fontWeight: 600,
  textTransform: "uppercase",
  color: ACCENT_TEXT,
};

/**
 * The List view: every section of the event, its seats grouped by row.
 *
 * Each row group is one `DataTable` (compact density). Its header checkbox is
 * the row's checkbox and its card mode, below 600px, is the phone list, so
 * selection, the selected rail and the keyboard path are the table's own.
 * `DataTable` has no group rows, which is why a section is several tables
 * rather than one; only the first shows the column heads.
 */
export function SeatPriceList({
  model,
  selection,
  dispatch,
  formatCents,
  disabled,
  openSectionIds,
  onToggleSection,
  showMapHints,
}: SeatPriceListProps) {
  const t = useTranslations();
  // DataTable switches to cards below 600px; the head strip goes with it.
  const cardMode = useIsMobile();

  return (
    <YStack
      data-testid="seat-price-list"
      // The frame owns the rules: card lists inside drop their own 2px
      // top/bottom so stacked row groups do not double them.
      data-dt-frame=""
      style={{ borderBottom: `2px solid ${STRUCTURAL}` }}
    >
      <style>{ROW_PRESS_CSS}</style>
      {model.sections.map((section) => {
        const open = openSectionIds.has(section.id);
        const bodyId = `${seatPriceSectionDomId(section.id)}-seats`;
        const selectedCount = section.rowGroups.reduce(
          (sum, group) =>
            sum + group.selectableIds.filter((id) => selection.has(id)).length,
          0,
        );
        return (
          <YStack key={section.id}>
            <h2 style={{ margin: 0, font: "inherit" }}>
              <SectionBand
                id={seatPriceSectionDomId(section.id)}
                {...({ type: "button" } as object)}
                aria-expanded={open}
                // The seats are unmounted while closed, so there is nothing
                // to point at until the section is open.
                aria-controls={open ? bodyId : undefined}
                onPress={() => onToggleSection(section.id)}
                data-testid={`seat-price-section-${section.id}`}
              >
                {open ? (
                  <ChevronDown size={16} aria-hidden />
                ) : (
                  <ChevronRight size={16} aria-hidden />
                )}
                <Text variant="subtitle" weight="bold" textAlign="left">
                  {section.name}
                </Text>
                <Text variant="overline" tone="muted" textAlign="left">
                  {sectionMeta(section, selectedCount, showMapHints, t)}
                </Text>
                <SectionPriceLine
                  section={section}
                  formatCents={formatCents}
                  t={t}
                />
              </SectionBand>
            </h2>
            {open ? (
              <YStack id={bodyId}>
                {cardMode ? null : <ColumnHeadStrip t={t} />}
                {section.rowGroups.map((group) => (
                  <RowGroupTable
                    key={group.key}
                    section={section}
                    group={group}
                    selection={selection}
                    dispatch={dispatch}
                    formatCents={formatCents}
                    disabled={disabled}
                  />
                ))}
              </YStack>
            ) : null}
          </YStack>
        );
      })}
    </YStack>
  );
}

SeatPriceList.displayName = "SeatPriceList";

function sectionMeta(
  section: SectionModel,
  selectedCount: number,
  showMapHints: boolean,
  t: SeatPriceTranslate,
): string {
  const parts = [
    String(t("admin.seatPricesSeatCount", { count: section.seatCount })),
  ];
  if (section.customCount > 0) {
    parts.push(
      String(t("admin.seatPricesCustomCount", { count: section.customCount })),
    );
  }
  if (selectedCount > 0) {
    parts.push(
      String(t("admin.seatPricesSelectedShort", { count: selectedCount })),
    );
  }
  if (showMapHints && !section.onMap) {
    parts.push(String(t("admin.seatPricesNotOnMap")));
  }
  return parts.join(" · ");
}

/** "Section price $45.00 from Standard", or why custom prices are off here. */
function SectionPriceLine({
  section,
  formatCents,
  t,
}: {
  section: SectionModel;
  formatCents: FormatCents;
  t: SeatPriceTranslate;
}) {
  // A span: the line sits inside the band's <button>.
  const lineProps = {
    tag: "span",
    marginLeft: "auto",
    flexWrap: "wrap",
    columnGap: 6,
    rowGap: 2,
    alignItems: "baseline",
    flexShrink: 1,
    minWidth: 0,
  } as const;

  if (section.setRefusal) {
    return (
      <XStack {...lineProps}>
        <Text variant="caption" tone="muted" textAlign="left">
          {String(
            t(
              section.setRefusal === "ADJUSTABLE_TIER"
                ? "admin.seatPricesSectionOffPayWhatYouWant"
                : "admin.seatPricesSectionOffNoFixed",
            ),
          )}
        </Text>
      </XStack>
    );
  }
  const price = section.fixedPrice;
  if (!price) return null;
  return (
    <XStack {...lineProps}>
      <Text variant="caption" tone="muted">
        {String(t("admin.seatPricesSectionPriceLabel"))}
      </Text>
      <Text {...monoPrice} weight="semibold">
        {fixedPriceText(price, formatCents, t)}
      </Text>
      <Text variant="caption" tone="muted">
        {String(
          price.ticketTypes.length === 1
            ? t("admin.seatPricesSectionPriceFrom", {
                ticketType: price.ticketTypes[0]!.name,
              })
            : t("admin.seatPricesSectionPriceFromSeveral", {
                count: price.ticketTypes.length,
              }),
        )}
      </Text>
    </XStack>
  );
}

function RowGroupTable({
  section,
  group,
  selection,
  dispatch,
  formatCents,
  disabled,
}: {
  section: SectionModel;
  group: RowGroupModel;
  selection: SeatPriceViewProps["selection"];
  dispatch: SeatPriceViewProps["dispatch"];
  formatCents: FormatCents;
  disabled: boolean;
}) {
  const t = useTranslations();
  const rowTitle = rowTitleText(group.rowName, t);

  // The table only ever sees ITS seats' selection. Its "select all" rebuilds
  // the set from the rows it holds, so handing it the whole selection would
  // let one row's checkbox wipe every other row's ticks.
  const groupSelection = useMemo(
    () => new Set(group.selectableIds.filter((id) => selection.has(id))),
    [group.selectableIds, selection],
  );

  const selectedCount = group.selectableIds.filter((id) =>
    selection.has(id),
  ).length;
  // "Row A · 14 seats · 7 selected · 2 custom prices"
  const rowLine = [
    rowTitle,
    String(t("admin.seatPricesSeatCount", { count: group.seats.length })),
    ...(selectedCount > 0
      ? [String(t("admin.seatPricesSelectedShort", { count: selectedCount }))]
      : []),
    ...(group.customCount > 0
      ? [
          String(
            t("admin.seatPricesCustomPriceCount", { count: group.customCount }),
          ),
        ]
      : []),
  ].join(" · ");

  const columns = useMemo<Array<DataTableColumn<SeatModel>>>(() => {
    // The section shows Status / Price / Note once, in its head strip. Each
    // row table keeps those heads for screen readers only; its visible head
    // row is the row's line, laid across the hidden heads.
    const head = (label: string) => <span style={visuallyHidden}>{label}</span>;
    return [
      {
        id: "seat",
        header: (
          <span style={rowLineHostStyle}>
            <span style={rowLineStyle}>{rowLine}</span>
          </span>
        ),
        width: COLUMN_WEIGHTS.seat,
        cell: (seat) => (
          <Text
            variant="bodySmall"
            weight="semibold"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {seat.label}
          </Text>
        ),
      },
      {
        id: "status",
        header: head(String(t("admin.seatPricesColStatus"))),
        width: COLUMN_WEIGHTS.status,
        truncate: false,
        cell: (seat) => <SeatStatusMark seat={seat} t={t} />,
      },
      {
        id: "price",
        header: head(String(t("admin.seatPricesColPrice"))),
        width: COLUMN_WEIGHTS.price,
        truncate: false,
        cell: (seat) => (
          <SeatPriceMark
            seat={seat}
            section={section}
            formatCents={formatCents}
            t={t}
            showSectionPrice
          />
        ),
      },
      {
        id: "note",
        // Q3: the note's name lives in one key. Renaming it is one edit.
        header: head(String(t("admin.seatPricesNoteLabel"))),
        width: COLUMN_WEIGHTS.note,
        cell: (seat) => (
          <Text variant="bodySmall" tone="muted">
            {seatNoteCellText(seat, t)}
          </Text>
        ),
        tooltipValue: (seat) => seatNoteCellText(seat, t),
      },
    ];
  }, [formatCents, rowLine, section, t]);

  // The whole row or card toggles its seat, not only the 24px box. Mouse and
  // touch only: the keyboard keeps the one checkbox per seat, so no second
  // tab stop appears. Presses on the checkbox itself are left to it.
  const handleRowPress = (event: MouseEvent<HTMLDivElement>) => {
    if (disabled) return;
    const target = event.target as HTMLElement;
    if (target.closest('[role="checkbox"], button, a, input, textarea, label')) {
      return;
    }
    const row = target.closest<HTMLElement>("[data-row-key]");
    const seatId = row?.dataset.rowKey;
    if (!seatId || !group.selectableIds.includes(seatId)) return;
    dispatch({ type: "toggleSeat", seatId });
  };

  return (
    <div data-seat-rows={group.key} onClick={handleRowPress}>
    <DataTable<SeatModel>
      columns={columns}
      rows={group.seats}
      getRowKey={(seat) => seat.id}
      density="compact"
      // Several tables share one set of column widths, so nobody drags them
      // apart; the percentage widths above keep the columns in line.
      resizable={false}
      selectable={{
        selectedKeys: groupSelection,
        onSelectionChange: (next) =>
          dispatch({
            type: "replaceWithin",
            scopeIds: group.selectableIds,
            next,
          }),
        isRowSelectable: (seat) => seat.selectable,
        disabled: disabled || group.selectableIds.length === 0,
        // The section is in the name because two sections can both have a
        // "Row A" and an "A1"; every checkbox on the page reads differently.
        selectAllLabel: rowCheckboxLabel(section.name, group.rowName, t),
        getRowLabel: (seat) => seatCheckboxLabel(section.name, seat.label, t),
        // 24px boxes: the default 16px is too small a target on touch.
        checkboxSize: "lg",
      }}
      renderMobileCard={(seat) => (
        <SeatCard seat={seat} section={section} formatCents={formatCents} />
      )}
      testIdBase={`seat-price-rows-${group.key}`}
    />
    </div>
  );
}

// The row line sits in the seat column's head but reads across the hidden
// Status / Price / Note heads: an out-of-flow span, so it never widens the
// column and the tables stay aligned.
const rowLineHostStyle: CSSProperties = {
  position: "relative",
  display: "block",
  minHeight: 14,
};
const rowLineStyle: CSSProperties = {
  position: "absolute",
  left: 0,
  top: 0,
  zIndex: 1,
  whiteSpace: "nowrap",
};

/** Status / Price / Note, once per section, over the row tables' columns. */
function ColumnHeadStrip({ t }: { t: SeatPriceTranslate }) {
  const pct = (weight: number) => `${(weight / TOTAL_WEIGHT) * 100}%`;
  return (
    // Visual only: every row table names its own columns for assistive tech.
    <table
      aria-hidden
      style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}
    >
      <colgroup>
        <col style={{ width: CHECKBOX_COLUMN_PX }} />
        <col style={{ width: pct(COLUMN_WEIGHTS.seat) }} />
        <col style={{ width: pct(COLUMN_WEIGHTS.status) }} />
        <col style={{ width: pct(COLUMN_WEIGHTS.price) }} />
        <col style={{ width: pct(COLUMN_WEIGHTS.note) }} />
      </colgroup>
      <thead>
        <tr>
          <th style={headTextStyle} />
          <th style={headTextStyle} />
          <th style={headTextStyle}>{String(t("admin.seatPricesColStatus"))}</th>
          <th style={headTextStyle}>{String(t("admin.seatPricesColPrice"))}</th>
          <th style={headTextStyle}>{String(t("admin.seatPricesNoteLabel"))}</th>
        </tr>
      </thead>
    </table>
  );
}

function seatNoteCellText(seat: SeatModel, t: SeatPriceTranslate): string {
  return [seatRemarkText(seat, t), seat.customPrice?.note ?? null]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

function SeatStatusMark({
  seat,
  t,
}: {
  seat: SeatModel;
  t: SeatPriceTranslate;
}) {
  const label = seatStatusText(seat.status, t);
  if (seat.status === "AVAILABLE") {
    return (
      <Text variant="bodySmall" tone="muted">
        {label}
      </Text>
    );
  }
  // A flex row so the badge hugs its text instead of filling the cell.
  return (
    <XStack>
      <Badge size="xs" tone={seat.status === "HELD" ? "warning" : "neutral"}>
        {label}
      </Badge>
    </XStack>
  );
}

/** The seat's price: its custom price with the tag, or the section price, muted. */
function SeatPriceMark({
  seat,
  section,
  formatCents,
  t,
  showSectionPrice,
}: {
  seat: SeatModel;
  section: SectionModel;
  formatCents: FormatCents;
  t: SeatPriceTranslate;
  /** Add "section $45.00" beside a custom price (the table has room; a card does not). */
  showSectionPrice: boolean;
}) {
  const sectionPrice = sectionPriceText(section, formatCents, t);
  if (seat.priceUnreadable) {
    return (
      <XStack>
        <Badge size="xs" tone="danger">
          {String(t("admin.seatPricesUnreadableTag"))}
        </Badge>
      </XStack>
    );
  }
  if (!seat.customPrice) {
    return (
      <Text {...monoPrice} tone="muted">
        {sectionPrice ?? "—"}
      </Text>
    );
  }
  return (
    <XStack
      flexWrap="wrap"
      alignItems="baseline"
      columnGap={8}
      rowGap={2}
      flexShrink={1}
      minWidth={0}
    >
      <Text {...monoPrice} weight="semibold">
        {formatCents(seat.customPrice.priceCents)}
      </Text>
      <span style={customTagStyle}>{String(t("admin.seatPricesCustomTag"))}</span>
      {showSectionPrice && section.fixedPrice ? (
        <Text variant="caption" tone="muted">
          {String(
            t("admin.seatPricesSectionPriceWas", {
              price: fixedPriceText(section.fixedPrice, formatCents, t),
            }),
          )}
        </Text>
      ) : null}
    </XStack>
  );
}

/** A seat as a phone card: label on the left, status and price on the right. */
function SeatCard({
  seat,
  section,
  formatCents,
}: {
  seat: SeatModel;
  section: SectionModel;
  formatCents: FormatCents;
}) {
  const t = useTranslations();
  const remark = seatRemarkText(seat, t);
  return (
    <YStack gap={4} minHeight={24} justifyContent="center">
      <XStack alignItems="center" gap={10}>
        <Text
          variant="bodySmall"
          weight="semibold"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {seat.label}
        </Text>
        <XStack
          marginLeft="auto"
          alignItems="center"
          justifyContent="flex-end"
          flexWrap="wrap"
          columnGap={8}
          rowGap={4}
          flexShrink={1}
          minWidth={0}
        >
          {seat.status === "AVAILABLE" ? null : (
            <SeatStatusMark seat={seat} t={t} />
          )}
          <SeatPriceMark
            seat={seat}
            section={section}
            formatCents={formatCents}
            t={t}
            showSectionPrice={false}
          />
        </XStack>
      </XStack>
      {remark ? (
        <Text variant="caption" tone="muted">
          {remark}
        </Text>
      ) : null}
    </YStack>
  );
}
