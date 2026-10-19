import { describe, expect, it } from "vitest";

import {
  EMPTY_SELECTION,
  groupCheckState,
  pruneSelection,
  selectionReducer,
  type SeatSelection,
} from "../seat-price-selection";

const sel = (...ids: string[]): SeatSelection => new Set(ids);
const ids = (selection: SeatSelection) => [...selection].sort();

describe("selectionReducer", () => {
  it("toggleSeat adds a seat, then removes it", () => {
    const one = selectionReducer(EMPTY_SELECTION, { type: "toggleSeat", seatId: "a" });
    expect(ids(one)).toEqual(["a"]);
    const none = selectionReducer(one, { type: "toggleSeat", seatId: "a" });
    expect(ids(none)).toEqual([]);
  });

  it("never mutates the state it was given", () => {
    const before = sel("a");
    selectionReducer(before, { type: "toggleSeat", seatId: "b" });
    selectionReducer(before, { type: "toggleRow", seatIds: ["a", "c"] });
    expect(ids(before)).toEqual(["a"]);
    expect(EMPTY_SELECTION.size).toBe(0);
  });

  it("toggleRow selects the whole row when only part of it is selected", () => {
    const next = selectionReducer(sel("a1", "z9"), {
      type: "toggleRow",
      seatIds: ["a1", "a2", "a3"],
    });
    expect(ids(next)).toEqual(["a1", "a2", "a3", "z9"]);
  });

  it("toggleRow clears the row when all of it is selected, and leaves other rows alone", () => {
    const next = selectionReducer(sel("a1", "a2", "z9"), {
      type: "toggleRow",
      seatIds: ["a1", "a2"],
    });
    expect(ids(next)).toEqual(["z9"]);
  });

  it("toggleRow on a row with nothing selectable changes nothing", () => {
    const before = sel("a1");
    expect(selectionReducer(before, { type: "toggleRow", seatIds: [] })).toBe(before);
  });

  it("replaceWithin takes one row's new set without touching the other rows", () => {
    // DataTable's select-all rebuilds the set from the rows it holds. Each row
    // is its own table, so its result may only overwrite its own seats.
    const before = sel("a1", "b1", "b2");
    const next = selectionReducer(before, {
      type: "replaceWithin",
      scopeIds: ["a1", "a2", "a3"],
      next: sel("a2", "a3"),
    });
    expect(ids(next)).toEqual(["a2", "a3", "b1", "b2"]);
  });

  it("replaceWithin ignores ids outside its scope", () => {
    const next = selectionReducer(sel("b1"), {
      type: "replaceWithin",
      scopeIds: ["a1"],
      next: sel("a1", "stray"),
    });
    expect(ids(next)).toEqual(["a1", "b1"]);
  });

  it("replaceWithin returns the same set when nothing changes", () => {
    const before = sel("a1", "b1");
    expect(
      selectionReducer(before, {
        type: "replaceWithin",
        scopeIds: ["a1", "a2"],
        next: sel("a1"),
      }),
    ).toBe(before);
  });

  it("clear empties the selection", () => {
    expect(selectionReducer(sel("a", "b"), { type: "clear" }).size).toBe(0);
    expect(selectionReducer(EMPTY_SELECTION, { type: "clear" })).toBe(EMPTY_SELECTION);
  });

  it("prune drops seats that can no longer be changed", () => {
    const next = selectionReducer(sel("a", "sold", "gone"), {
      type: "prune",
      selectableIds: new Set(["a", "b"]),
    });
    expect(ids(next)).toEqual(["a"]);
  });

  it("keepOnly keeps the seats a failed save did not send", () => {
    const next = selectionReducer(sel("a", "b", "c"), {
      type: "keepOnly",
      seatIds: ["b", "c", "never-selected"],
    });
    expect(ids(next)).toEqual(["b", "c"]);
  });

  it("keepOnly returns the same set when every seat is kept", () => {
    const before = sel("a", "b");
    expect(
      selectionReducer(before, { type: "keepOnly", seatIds: ["a", "b", "c"] }),
    ).toBe(before);
  });
});

describe("pruneSelection", () => {
  it("returns the same set when every seat is still selectable", () => {
    const before = sel("a", "b");
    expect(pruneSelection(before, new Set(["a", "b", "c"]))).toBe(before);
  });

  it("returns a new, smaller set when a seat dropped out", () => {
    const before = sel("a", "b");
    const after = pruneSelection(before, new Set(["a"]));
    expect(after).not.toBe(before);
    expect(ids(after)).toEqual(["a"]);
  });
});

describe("groupCheckState", () => {
  it("is unchecked, indeterminate or checked by how much of the row is selected", () => {
    const row = ["a1", "a2", "a3"];
    expect(groupCheckState(sel(), row)).toBe(false);
    expect(groupCheckState(sel("b1"), row)).toBe(false);
    expect(groupCheckState(sel("a1"), row)).toBe("indeterminate");
    expect(groupCheckState(sel("a1", "a2", "a3", "b1"), row)).toBe(true);
  });

  it("is unchecked for a row with nothing selectable", () => {
    expect(groupCheckState(sel("a1"), [])).toBe(false);
  });
});
