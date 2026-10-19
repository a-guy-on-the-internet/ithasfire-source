import type { Dispatch } from "react";

import type { SeatPriceModel } from "./seat-price-model";
import type { SeatSelection, SelectionAction } from "./seat-price-selection";

/**
 * The editor's two views. The board's pick is "a map with a List switch":
 * one screen, ONE selection and ONE price panel shared by both.
 */
export type SeatPriceView = "map" | "list";

/**
 * The views the editor offers, in switch order. An event with no seat on a
 * layout gets the List alone (`availableSeatPriceViews`): a Map option that
 * can draw nothing is a control that goes nowhere.
 */
export const AVAILABLE_SEAT_PRICE_VIEWS: readonly SeatPriceView[] = ["map", "list"];

export function availableSeatPriceViews(
  anySeatOnMap: boolean,
): readonly SeatPriceView[] {
  return anySeatOnMap ? AVAILABLE_SEAT_PRICE_VIEWS : ["list"];
}

/** The map when at least one section has seats on it, else the List. */
export function defaultSeatPriceView(anySeatOnMap: boolean): SeatPriceView {
  return anySeatOnMap ? "map" : "list";
}

/** Per viewer, in this browser only (a convenience, never relied on). */
export const SEAT_PRICE_VIEW_STORAGE_KEY = "ithasfire.seatPrices.view";

export function readStoredSeatPriceView(): SeatPriceView | null {
  try {
    const value = window.localStorage.getItem(SEAT_PRICE_VIEW_STORAGE_KEY);
    return value === "map" || value === "list" ? value : null;
  } catch {
    return null;
  }
}

export function storeSeatPriceView(view: SeatPriceView): void {
  try {
    window.localStorage.setItem(SEAT_PRICE_VIEW_STORAGE_KEY, view);
  } catch {
    // Private window or blocked storage: the choice lasts for this visit.
  }
}

/**
 * What every view gets. A view shows `model`, reads `selection`, and reports
 * what the organizer picked through `dispatch`; it never owns selection state
 * and never talks to the server.
 */
export type SeatPriceViewProps = {
  model: SeatPriceModel;
  selection: SeatSelection;
  dispatch: Dispatch<SelectionAction>;
  /** Integer cents as display text, in the event's currency. */
  formatCents: (cents: number) => string;
  /** A save is in flight: selection controls are disabled, not hidden. */
  disabled: boolean;
  /** The section the sidebar's section list last pointed at. */
  activeSectionId: string | null;
  /** Switches to the List (the Map offers it when it cannot draw seats). */
  onShowList?: () => void;
};
