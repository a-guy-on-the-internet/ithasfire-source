import {
  parseCustomPriceInput,
  type CustomPriceInputFailure,
} from "./seat-price-money";
import type {
  ScheduledChangeModel,
  SeatModel,
  SeatPriceModel,
  SectionModel,
  TicketTypeModel,
} from "./seat-price-model";
import type { SeatSelection } from "./seat-price-selection";

/**
 * Which state the ONE price panel is in for a selection. Pure, so the List
 * view and the Map view (step 5b-2) get the same answer from the same seats.
 *
 * Every "can this be set?" answer below is the server's flag for the seat's
 * section, read as-is. The only rule added here is how flags combine across a
 * selection that spans sections, and it is the strictest reading: a price can
 * be set only when EVERY selected seat's section allows it. Clearing ("Use
 * section price") is always allowed, as it is on the server.
 */

export type PanelSectionSummary = {
  id: string;
  name: string;
  /** Rows the selection touches in this section, in list order. */
  rowNames: Array<string | null>;
  seatLabels: string[];
};

export type PanelSetRefusal = {
  reason: NonNullable<SectionModel["setRefusal"]>;
  sectionId: string;
  sectionName: string;
  /** The pay-what-you-want ticket types that sell the section. */
  payWhatYouWantTypeNames: string[];
};

export type PanelPaidBlock = {
  reason: NonNullable<SectionModel["paidBlock"]>;
  sectionId: string;
  sectionName: string;
};

export type PanelSelection = {
  kind: "selection";
  /** Selected seats in list order. This is what a save sends. */
  seatIds: string[];
  seatCount: number;
  sections: PanelSectionSummary[];
  /** Set when exactly one seat is selected. */
  singleSeat: SeatModel | null;
  /** The section price, when the whole selection sits in one section that has one. */
  sectionPrice: SectionModel["fixedPrice"];
  /** Sections whose seats cannot be given a price. Empty when a price can be set. */
  setRefusals: PanelSetRefusal[];
  /** Sections where only $0 can be saved. */
  paidBlocks: PanelPaidBlock[];
  canSetPrice: boolean;
  canSetPaidPrice: boolean;
  /** Selected seats whose stored price cannot be read. */
  unreadableCount: number;
  /** Scheduled ticket price changes the selected seats would not follow. */
  scheduledChanges: ScheduledChangeModel[];
  /** Every ticket type a custom price on these seats replaces. */
  replacedTicketTypes: TicketTypeModel[];
  /**
   * The same ticket types per selected section. A seat only replaces its own
   * section's ticket types, so a selection across sections is worded per
   * section.
   */
  replacedBySection: Array<{
    sectionId: string;
    sectionName: string;
    ticketTypes: TicketTypeModel[];
  }>;
  /**
   * The stored custom price, when every selected seat has one and they are
   * all the same. Prefills the price field until the organizer types.
   */
  sharedPriceCents: number | null;
  /**
   * The stored note, when every selected seat carries the same one. `null`
   * (an empty field) when any two differ or none has a note.
   */
  sharedNote: string | null;
  /** The stored notes of the selected seats, one entry per seat that has one. */
  storedNotes: string[];
  /**
   * Selected seats a "Use section price" would change: a stored custom price,
   * readable or not. Zero means the clear would write nothing.
   */
  clearableCount: number;
};

export type PanelState =
  /** The event is closed: nothing can change. */
  | { kind: "readOnly" }
  | { kind: "empty" }
  | PanelSelection;

export function resolvePanelState(
  model: SeatPriceModel,
  selection: SeatSelection,
): PanelState {
  if (!model.editable) return { kind: "readOnly" };

  // Walk the model, not the set, so the result is in list order and an id
  // the read no longer holds (or no longer lets us change) is ignored.
  const seats: SeatModel[] = [];
  const sectionSummaries: PanelSectionSummary[] = [];
  const selectedSections: SectionModel[] = [];
  for (const section of model.sections) {
    const summary: PanelSectionSummary = {
      id: section.id,
      name: section.name,
      rowNames: [],
      seatLabels: [],
    };
    for (const group of section.rowGroups) {
      const picked = group.seats.filter(
        (seat) => seat.selectable && selection.has(seat.id),
      );
      if (picked.length === 0) continue;
      summary.rowNames.push(group.rowName);
      summary.seatLabels.push(...picked.map((seat) => seat.label));
      seats.push(...picked);
    }
    if (summary.seatLabels.length > 0) {
      sectionSummaries.push(summary);
      selectedSections.push(section);
    }
  }

  if (seats.length === 0) return { kind: "empty" };

  const setRefusals: PanelSetRefusal[] = selectedSections.flatMap((section) =>
    section.setRefusal
      ? [
          {
            reason: section.setRefusal,
            sectionId: section.id,
            sectionName: section.name,
            payWhatYouWantTypeNames: section.payWhatYouWantTypes.map(
              (type) => type.name,
            ),
          },
        ]
      : [],
  );
  const paidBlocks: PanelPaidBlock[] = selectedSections.flatMap((section) =>
    section.paidBlock
      ? [
          {
            reason: section.paidBlock,
            sectionId: section.id,
            sectionName: section.name,
          },
        ]
      : [],
  );

  const replacedById = new Map<string, TicketTypeModel>();
  const scheduledById = new Map<string, ScheduledChangeModel>();
  for (const section of selectedSections) {
    for (const type of section.ticketTypes) replacedById.set(type.id, type);
    for (const change of section.scheduledChanges) {
      scheduledById.set(change.ticketTypeId, change);
    }
  }

  const canSetPrice = setRefusals.length === 0;
  const onlySection = selectedSections.length === 1 ? selectedSections[0]! : null;

  return {
    kind: "selection",
    seatIds: seats.map((seat) => seat.id),
    seatCount: seats.length,
    sections: sectionSummaries,
    singleSeat: seats.length === 1 ? seats[0]! : null,
    sectionPrice: onlySection?.fixedPrice ?? null,
    setRefusals,
    paidBlocks,
    canSetPrice,
    canSetPaidPrice: canSetPrice && paidBlocks.length === 0,
    unreadableCount: seats.filter((seat) => seat.priceUnreadable).length,
    scheduledChanges: [...scheduledById.values()],
    replacedTicketTypes: [...replacedById.values()],
    replacedBySection: selectedSections.map((section) => ({
      sectionId: section.id,
      sectionName: section.name,
      ticketTypes: section.ticketTypes,
    })),
    sharedPriceCents: sharedPriceCents(seats),
    sharedNote: sharedNote(seats),
    storedNotes: seats.flatMap((seat) =>
      seat.customPrice?.note ? [seat.customPrice.note] : [],
    ),
    clearableCount: seats.filter(
      (seat) => seat.customPrice !== null || seat.priceUnreadable,
    ).length,
  };
}

function sharedPriceCents(seats: SeatModel[]): number | null {
  const first = seats[0]?.customPrice;
  if (!first) return null;
  return seats.every((seat) => seat.customPrice?.priceCents === first.priceCents)
    ? first.priceCents
    : null;
}

function sharedNote(seats: SeatModel[]): string | null {
  const first = seats[0]?.customPrice?.note ?? null;
  if (first === null) return null;
  return seats.every((seat) => (seat.customPrice?.note ?? null) === first)
    ? first
    : null;
}

/**
 * How many selected seats would lose or change their stored note if the
 * price were set with `nextNote` (already trimmed; `null` for none). The
 * write replaces the whole stored value, note included.
 */
export function notesReplacedBy(
  panel: PanelSelection,
  nextNote: string | null,
): number {
  return panel.storedNotes.filter((note) => note !== nextNote).length;
}

export type PanelActions = {
  setPriceDisabled: boolean;
  useSectionPriceDisabled: boolean;
};

/**
 * Whether the two buttons can be pressed. "Set price" needs a section that
 * allows a price and something typed; a typed price the panel refuses still
 * presses, so the reason shows. "Use section price" is open even where a
 * price cannot be set (clearing is always allowed), but only when some
 * selected seat has a stored price to clear.
 */
export function resolvePanelActions(
  panel: PanelSelection,
  verdict: PriceVerdict,
  saving: boolean,
): PanelActions {
  return {
    setPriceDisabled: saving || !panel.canSetPrice || verdict.kind === "empty",
    useSectionPriceDisabled: saving || panel.clearableCount === 0,
  };
}

export type PriceVerdict =
  /** The typed price can be sent. */
  | { kind: "ok"; priceCents: number }
  /** Nothing typed yet. Not an error; "Set price" just stays off. */
  | { kind: "empty" }
  | { kind: "invalid"; reason: Exclude<CustomPriceInputFailure, "empty"> }
  /** A section in the selection refuses any price. */
  | { kind: "refused" }
  /** The price is above $0 and a section in the selection only takes $0. */
  | { kind: "paidBlocked" };

/** What "Set price" would do with the text in the field right now. */
export function resolvePriceVerdict(
  panel: PanelSelection,
  rawInput: string,
): PriceVerdict {
  if (!panel.canSetPrice) return { kind: "refused" };
  const parsed = parseCustomPriceInput(rawInput);
  if (!parsed.ok) {
    return parsed.reason === "empty"
      ? { kind: "empty" }
      : { kind: "invalid", reason: parsed.reason };
  }
  if (parsed.cents > 0 && !panel.canSetPaidPrice) return { kind: "paidBlocked" };
  return { kind: "ok", priceCents: parsed.cents };
}
