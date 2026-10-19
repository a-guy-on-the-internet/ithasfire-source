/**
 * The seat price editor's ONE selection, shared by the List view and (step
 * 5b-2) the Map view. A set of event Seat ids, keyed by the seat's own id and
 * never by its label: two sections can both have an "A1".
 *
 * The reducer returns the SAME set when an action changes nothing, so an
 * effect that dispatches `prune` after every refetch cannot loop.
 */

export type SeatSelection = ReadonlySet<string>;

export const EMPTY_SELECTION: SeatSelection = new Set<string>();

export type SelectionAction =
  /** One seat's checkbox, or one seat pressed on the map. */
  | { type: "toggleSeat"; seatId: string }
  /**
   * A row's checkbox. Selects every listed seat unless all of them already
   * are, in which case it clears them. Pass only selectable ids.
   */
  | { type: "toggleRow"; seatIds: readonly string[] }
  /**
   * A view reports the new selection for the seats IT shows (one row group's
   * table, or a drag box on the map). Seats outside `scopeIds` keep their
   * state, so one table's "select all" cannot wipe another's ticks.
   */
  | { type: "replaceWithin"; scopeIds: readonly string[]; next: SeatSelection }
  | { type: "clear" }
  /** After a refetch: drop seats that can no longer be changed. */
  | { type: "prune"; selectableIds: ReadonlySet<string> }
  /** After a partly failed save: keep only the seats that were not saved. */
  | { type: "keepOnly"; seatIds: readonly string[] };

export function selectionReducer(
  state: SeatSelection,
  action: SelectionAction,
): SeatSelection {
  switch (action.type) {
    case "toggleSeat": {
      const next = new Set(state);
      if (!next.delete(action.seatId)) next.add(action.seatId);
      return next;
    }
    case "toggleRow": {
      if (action.seatIds.length === 0) return state;
      const allSelected = action.seatIds.every((id) => state.has(id));
      const next = new Set(state);
      for (const id of action.seatIds) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    }
    case "replaceWithin": {
      const next = new Set(state);
      for (const id of action.scopeIds) {
        if (action.next.has(id)) next.add(id);
        else next.delete(id);
      }
      return sameMembers(state, next) ? state : next;
    }
    case "clear":
      return state.size === 0 ? state : EMPTY_SELECTION;
    case "prune":
      return pruneSelection(state, action.selectableIds);
    case "keepOnly": {
      const keep = new Set(action.seatIds);
      const next = new Set([...state].filter((id) => keep.has(id)));
      return sameMembers(state, next) ? state : next;
    }
  }
}

/** The selection without the ids a save can no longer change. */
export function pruneSelection(
  selection: SeatSelection,
  selectableIds: ReadonlySet<string>,
): SeatSelection {
  let dropped = false;
  const next = new Set<string>();
  for (const id of selection) {
    if (selectableIds.has(id)) next.add(id);
    else dropped = true;
  }
  return dropped ? next : selection;
}

/** `true` | `false` | `"indeterminate"` for a row or section checkbox. */
export function groupCheckState(
  selection: SeatSelection,
  seatIds: readonly string[],
): boolean | "indeterminate" {
  if (seatIds.length === 0) return false;
  const selected = seatIds.filter((id) => selection.has(id)).length;
  if (selected === 0) return false;
  return selected === seatIds.length ? true : "indeterminate";
}

function sameMembers(a: SeatSelection, b: SeatSelection): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}
