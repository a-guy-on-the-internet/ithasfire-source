import type { inferRouterOutputs } from "@trpc/server";

import type { AppRouter } from "@th/trpc";

/**
 * View model for the seat price editor, built from
 * `events.listEventSeatPriceOverridesForEdit`.
 *
 * Pure: no React, no translator. The List view and (step 5b-2) the Map view
 * both read this one model, so a seat is selectable, priced and counted the
 * same way in each.
 *
 * NO PRICING OR GATING RULE LIVES HERE. Whether a price may be set, whether a
 * paid price is blocked and whether the event is still editable are the
 * server's flags, copied through (`setRefusal`, `paidBlock`, `editable`). The
 * one thing derived locally is what the write itself documents: it only
 * touches AVAILABLE and BLOCKED seats, so only those can be selected.
 */

export type SeatPriceRead =
  inferRouterOutputs<AppRouter>["events"]["listEventSeatPriceOverridesForEdit"];
export type SeatPriceSectionRead = SeatPriceRead["sections"][number];
export type SeatPriceSeatRead = SeatPriceSectionRead["seats"][number];
export type SeatPriceTicketTypeRead = SeatPriceSectionRead["tiers"][number];
export type SeatStatus = SeatPriceSeatRead["status"];

export type SeatModel = {
  /** The event Seat's own id. Selection is keyed by this, never by label. */
  id: string;
  sectionId: string;
  label: string;
  row: string | null;
  number: number | null;
  status: SeatStatus;
  /** Layout glyph this seat was made from; `null` when it is not on the map. */
  glyphKey: string | null;
  /** The stored custom price with the organizer's private note. */
  customPrice: { priceCents: number; note: string | null } | null;
  /** The stored price cannot be read; checkout refuses the seat until fixed. */
  priceUnreadable: boolean;
  /** The write changes this seat (AVAILABLE or BLOCKED, event still editable). */
  selectable: boolean;
};

export type TicketTypeModel = {
  id: string;
  name: string;
  /** The buyer names the amount; there is no price to show. */
  payWhatYouWant: boolean;
  /** What a seat without a custom price costs right now. `null` for pay what you want. */
  priceCents: number | null;
  scheduledChange: { toPriceCents: number; at: Date } | null;
};

export type ScheduledChangeModel = {
  ticketTypeId: string;
  ticketTypeName: string;
  toPriceCents: number;
  at: Date;
};

export type RowGroupModel = {
  /** Stable across refetches: section id plus the row name. */
  key: string;
  sectionId: string;
  /** `null` for the one group of seats that have no row. */
  rowName: string | null;
  seats: SeatModel[];
  /** Ids the row checkbox toggles: this group's selectable seats, in order. */
  selectableIds: string[];
  customCount: number;
};

export type SectionModel = {
  id: string;
  name: string;
  seatCount: number;
  customCount: number;
  /**
   * The Map draws this section: it comes from the layout the Map draws
   * (`SeatPriceModel.mapLayoutId`) and at least one seat has a glyph there.
   * `false` means "not on the map": the List shows it.
   */
  onMap: boolean;
  /** The layout section this section was made from, and that layout. */
  layoutSectionId: string | null;
  placeLayoutId: string | null;
  /** Every ticket type a custom price in this section replaces. */
  ticketTypes: TicketTypeModel[];
  /**
   * The section price: the fixed-price ticket types, cheapest first, with the
   * range they span. `null` when no fixed-price ticket type sells the section.
   */
  fixedPrice: {
    ticketTypes: TicketTypeModel[];
    minCents: number;
    maxCents: number;
  } | null;
  payWhatYouWantTypes: TicketTypeModel[];
  /** Server flag: why a price cannot be SET here. Clearing is always allowed. */
  setRefusal: SeatPriceSectionRead["overrideRefusal"];
  /** Server flag: why a PAID price is blocked here. $0 is still allowed. */
  paidBlock: SeatPriceSectionRead["paidOverrideBlockedBy"];
  /** Scheduled price changes custom prices will not follow (FR-008). */
  scheduledChanges: ScheduledChangeModel[];
  rowGroups: RowGroupModel[];
};

export type SeatPriceModel = {
  eventId: string;
  /** Server flag: `false` once the event is cancelled, completed or archived. */
  editable: boolean;
  sections: SectionModel[];
  seatCount: number;
  customCount: number;
  seatsById: ReadonlyMap<string, SeatModel>;
  sectionsById: ReadonlyMap<string, SectionModel>;
  /** Every seat a save can change. The selection is pruned against this. */
  selectableIds: ReadonlySet<string>;
  /**
   * The one layout the Map draws: the layout most sections were made from.
   * `null` when no section came from a layout.
   */
  mapLayoutId: string | null;
};

// A fixed locale keeps the order identical on the server, in tests and in
// every browser. `numeric` gives the natural order: A2 before A10, row 2
// before row 10.
const naturalCollator = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

export function compareNatural(a: string, b: string): number {
  return naturalCollator.compare(a, b);
}

function compareSeats(a: SeatModel, b: SeatModel): number {
  if (a.number !== null && b.number !== null && a.number !== b.number) {
    return a.number - b.number;
  }
  // A seat without a number sorts after the numbered ones of its row.
  if ((a.number === null) !== (b.number === null)) {
    return a.number === null ? 1 : -1;
  }
  return compareNatural(a.label, b.label) || a.id.localeCompare(b.id);
}

/** The write's own rule ("seat status on write"): SOLD and HELD are skipped. */
function isWritableStatus(status: SeatStatus): boolean {
  return status === "AVAILABLE" || status === "BLOCKED";
}

function toTicketType(tier: SeatPriceTicketTypeRead): TicketTypeModel {
  return {
    id: tier.id,
    name: tier.name,
    payWhatYouWant: tier.pricingMode === "ADJUSTABLE",
    priceCents: tier.currentPriceCents,
    scheduledChange: tier.upcomingPriceChange
      ? {
          toPriceCents: tier.upcomingPriceChange.toPriceCents,
          at: tier.upcomingPriceChange.at,
        }
      : null,
  };
}

function buildRowGroups(sectionId: string, seats: SeatModel[]): RowGroupModel[] {
  const byRow = new Map<string, { rowName: string | null; seats: SeatModel[] }>();
  for (const seat of seats) {
    // The prefix keeps a row literally named "none" apart from the no-row group.
    const key = seat.row === null ? "none" : `row:${seat.row}`;
    const group = byRow.get(key) ?? { rowName: seat.row, seats: [] };
    group.seats.push(seat);
    byRow.set(key, group);
  }

  return [...byRow.entries()]
    .map(([key, group]) => {
      const ordered = [...group.seats].sort(compareSeats);
      return {
        key: `${sectionId}:${key}`,
        sectionId,
        rowName: group.rowName,
        seats: ordered,
        selectableIds: ordered.filter((s) => s.selectable).map((s) => s.id),
        customCount: ordered.filter((s) => s.customPrice !== null).length,
      };
    })
    .sort((a, b) => {
      // Named rows in natural order, then the seats that have no row.
      if ((a.rowName === null) !== (b.rowName === null)) {
        return a.rowName === null ? 1 : -1;
      }
      return compareNatural(a.rowName ?? "", b.rowName ?? "");
    });
}

function buildSection(
  section: SeatPriceSectionRead,
  editable: boolean,
): SectionModel {
  const seats: SeatModel[] = section.seats.map((seat) => ({
    id: seat.id,
    sectionId: section.seatSectionId,
    label: seat.label,
    row: seat.row,
    number: seat.number,
    status: seat.status,
    glyphKey: seat.glyphKey,
    customPrice: seat.priceOverride
      ? {
          priceCents: seat.priceOverride.priceCents,
          note: seat.priceOverride.reason,
        }
      : null,
    priceUnreadable: seat.overrideInvalid,
    selectable: editable && isWritableStatus(seat.status),
  }));

  const ticketTypes = section.tiers.map(toTicketType);
  const fixedTypes = ticketTypes
    .filter(
      (type): type is TicketTypeModel & { priceCents: number } =>
        !type.payWhatYouWant && type.priceCents !== null,
    )
    .sort(
      (a, b) => a.priceCents - b.priceCents || compareNatural(a.name, b.name),
    );

  return {
    id: section.seatSectionId,
    name: section.name,
    seatCount: seats.length,
    customCount: seats.filter((s) => s.customPrice !== null).length,
    onMap: seats.some((s) => s.glyphKey !== null),
    layoutSectionId: section.layoutSectionId,
    placeLayoutId: section.placeLayoutId,
    ticketTypes,
    fixedPrice:
      fixedTypes.length > 0
        ? {
            ticketTypes: fixedTypes,
            minCents: fixedTypes[0]!.priceCents,
            maxCents: fixedTypes[fixedTypes.length - 1]!.priceCents,
          }
        : null,
    payWhatYouWantTypes: ticketTypes.filter((type) => type.payWhatYouWant),
    setRefusal: section.overrideRefusal,
    paidBlock: section.paidOverrideBlockedBy,
    // The flag is the server's; the ticket types only supply the details.
    scheduledChanges: section.hasPendingScheduledPriceChange
      ? ticketTypes.flatMap((type) =>
          !type.payWhatYouWant && type.scheduledChange
            ? [
                {
                  ticketTypeId: type.id,
                  ticketTypeName: type.name,
                  toPriceCents: type.scheduledChange.toPriceCents,
                  at: type.scheduledChange.at,
                },
              ]
            : [],
        )
      : [],
    rowGroups: buildRowGroups(section.seatSectionId, seats),
  };
}

/**
 * Sections keep the server's order. A section with no seats (general
 * admission) has nothing to price and is left out.
 */
export function buildSeatPriceModel(read: SeatPriceRead): SeatPriceModel {
  const built = read.sections
    .filter((section) => section.seats.length > 0)
    .map((section) => buildSection(section, read.editable));
  // A section from another layout is not on the map the Map draws.
  const mapLayoutId = mostUsedLayoutId(built);
  const sections = built.map((section) => ({
    ...section,
    onMap:
      section.onMap &&
      section.layoutSectionId !== null &&
      section.placeLayoutId !== null &&
      section.placeLayoutId === mapLayoutId,
  }));

  const seatsById = new Map<string, SeatModel>();
  const selectableIds = new Set<string>();
  for (const section of sections) {
    for (const group of section.rowGroups) {
      for (const seat of group.seats) {
        seatsById.set(seat.id, seat);
        if (seat.selectable) selectableIds.add(seat.id);
      }
    }
  }

  return {
    eventId: read.eventId,
    editable: read.editable,
    sections,
    seatCount: seatsById.size,
    customCount: sections.reduce((sum, s) => sum + s.customCount, 0),
    seatsById,
    sectionsById: new Map(sections.map((s) => [s.id, s])),
    selectableIds,
    mapLayoutId,
  };
}

function mostUsedLayoutId(sections: readonly SectionModel[]): string | null {
  const counts = new Map<string, number>();
  for (const section of sections) {
    if (!section.placeLayoutId || !section.layoutSectionId) continue;
    counts.set(section.placeLayoutId, (counts.get(section.placeLayoutId) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [id, count] of counts) {
    if (count > bestCount) {
      best = id;
      bestCount = count;
    }
  }
  return best;
}

export type StoredPriceLine = {
  key: string;
  sectionName: string;
  seatLabels: string[];
  /** `null` marks seats whose stored price cannot be read. */
  priceCents: number | null;
  note: string | null;
};

/**
 * The stored custom prices, for the read-only view of a closed event: one
 * line per section, price and note, with the seats that share them.
 */
export function listStoredPrices(model: SeatPriceModel): StoredPriceLine[] {
  const lines = new Map<string, StoredPriceLine>();
  for (const section of model.sections) {
    for (const group of section.rowGroups) {
      for (const seat of group.seats) {
        if (!seat.customPrice && !seat.priceUnreadable) continue;
        const priceCents = seat.customPrice?.priceCents ?? null;
        const note = seat.customPrice?.note ?? null;
        // JSON keeps a note containing the separator from merging two lines.
        const key = JSON.stringify([section.id, priceCents, note]);
        const line = lines.get(key) ?? {
          key,
          sectionName: section.name,
          seatLabels: [],
          priceCents,
          note,
        };
        line.seatLabels.push(seat.label);
        lines.set(key, line);
      }
    }
  }
  return [...lines.values()];
}
