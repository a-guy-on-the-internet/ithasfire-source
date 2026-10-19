import type {
  SeatModel,
  SeatStatus,
  SectionModel,
} from "./seat-price-model";

/**
 * Wording shared by the list, the section list and the panel, so a section
 * price or a seat status reads the same wherever it appears. Each function
 * takes the translator; none of them decides anything.
 */

export type SeatPriceTranslate = (
  key: string,
  values?: Record<string, string | number>,
) => unknown;

export type FormatCents = (cents: number) => string;

/** "$45.00", or "$30.00 to $45.00" when the ticket types differ in price. */
export function fixedPriceText(
  price: NonNullable<SectionModel["fixedPrice"]>,
  formatCents: FormatCents,
  t: SeatPriceTranslate,
): string {
  if (price.minCents === price.maxCents) return formatCents(price.minCents);
  return String(
    t("admin.seatPricesPriceRange", {
      min: formatCents(price.minCents),
      max: formatCents(price.maxCents),
    }),
  );
}

/** What a seat WITHOUT a custom price costs: its section price. */
export function sectionPriceText(
  section: SectionModel,
  formatCents: FormatCents,
  t: SeatPriceTranslate,
): string | null {
  if (section.fixedPrice) return fixedPriceText(section.fixedPrice, formatCents, t);
  if (section.payWhatYouWantTypes.length > 0) {
    return String(t("admin.seatPricesPayWhatYouWant"));
  }
  return null;
}

const STATUS_KEY: Record<SeatStatus, string> = {
  AVAILABLE: "admin.seatPricesStatusAvailable",
  HELD: "admin.seatPricesStatusHeld",
  SOLD: "admin.seatPricesStatusSold",
  BLOCKED: "admin.seatPricesStatusBlocked",
};

export function seatStatusText(status: SeatStatus, t: SeatPriceTranslate): string {
  return String(t(STATUS_KEY[status]));
}

/**
 * Why a seat has no checkbox, or what is wrong with it. `null` for a seat
 * that can simply be priced.
 */
export function seatRemarkText(seat: SeatModel, t: SeatPriceTranslate): string | null {
  const parts: string[] = [];
  if (seat.status === "SOLD") parts.push(String(t("admin.seatPricesLockedSold")));
  if (seat.status === "HELD") parts.push(String(t("admin.seatPricesLockedHeld")));
  if (seat.priceUnreadable) parts.push(String(t("admin.seatPricesUnreadableRow")));
  return parts.length > 0 ? parts.join(" ") : null;
}

/** DOM id of a section's band in the List, for the sidebar's jump links. */
export function seatPriceSectionDomId(sectionId: string): string {
  return `seat-price-section-${sectionId}`;
}

/** "Row A", or the group of seats that have no row. */
export function rowTitleText(
  rowName: string | null,
  t: SeatPriceTranslate,
): string {
  return rowName === null
    ? String(t("admin.seatPricesNoRowName"))
    : String(t("admin.seatPricesRowName", { row: rowName }));
}

/**
 * Accessible names of the row and seat checkboxes. The section leads, so
 * "Row A" or "A1" in two sections never reads the same.
 */
export function rowCheckboxLabel(
  sectionName: string,
  rowName: string | null,
  t: SeatPriceTranslate,
): string {
  return String(
    t("admin.seatPricesSelectRowAria", {
      section: sectionName,
      row: rowTitleText(rowName, t),
    }),
  );
}

export function seatCheckboxLabel(
  sectionName: string,
  seatLabel: string,
  t: SeatPriceTranslate,
): string {
  return String(
    t("admin.seatPricesSelectSeatAria", { section: sectionName, seat: seatLabel }),
  );
}
