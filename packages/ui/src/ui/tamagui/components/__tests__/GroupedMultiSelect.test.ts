import { describe, expect, it } from "vitest";

import {
  groupSelectionState,
  triggerLabelFor,
  type GroupedMultiSelectGroup,
} from "../forms/GroupedMultiSelect";

/**
 * The two pure functions behind the grouped filter control. They are tested
 * apart from the component because they are the parts that can be WRONG
 * rather than merely ugly: a parent checkbox that reads "checked" while one
 * child is unselected silently tells the reader they are filtering on more
 * than they are, and a trigger label that disagrees with the selection is the
 * same defect one layer up.
 */

const GROUPS: GroupedMultiSelectGroup[] = [
  {
    id: "cheer-up",
    label: "Cheer Up Charlies",
    options: [
      { id: "cu-late", label: "Late Night" },
      { id: "cu-main", label: "Main Calendar" },
    ],
  },
  {
    id: "hole",
    label: "Hole in the Wall",
    options: [{ id: "h-main", label: "Main Calendar" }],
  },
  {
    id: "mohawk",
    label: "Mohawk",
    options: [
      { id: "m-main", label: "Main Calendar" },
      { id: "m-outdoor", label: "Outdoor Series" },
    ],
  },
];

const COPY = { all: "All calendars", unit: "calendars", allInGroup: "all calendars" };

describe("groupSelectionState", () => {
  it("is unchecked with nothing selected", () => {
    expect(groupSelectionState(GROUPS[0]!, new Set())).toBe("unchecked");
  });

  it("is mixed when SOME children are selected", () => {
    expect(groupSelectionState(GROUPS[0]!, new Set(["cu-late"]))).toBe("mixed");
  });

  it("is checked only when EVERY child is selected", () => {
    expect(
      groupSelectionState(GROUPS[0]!, new Set(["cu-late", "cu-main"])),
    ).toBe("checked");
  });

  it("a single-option group goes straight from unchecked to checked", () => {
    expect(groupSelectionState(GROUPS[1]!, new Set(["h-main"]))).toBe("checked");
  });

  it("ignores selections belonging to other groups", () => {
    // The value is a FLAT id set across every group, so a group must never
    // count ids that are not its own.
    expect(
      groupSelectionState(GROUPS[0]!, new Set(["m-main", "m-outdoor"])),
    ).toBe("unchecked");
  });

  it("treats an empty group as unchecked rather than vacuously checked", () => {
    const empty: GroupedMultiSelectGroup = { id: "x", label: "X", options: [] };
    expect(groupSelectionState(empty, new Set())).toBe("unchecked");
  });
});

describe("triggerLabelFor", () => {
  it("says the all-label when nothing is selected — never '0 selected'", () => {
    expect(triggerLabelFor(GROUPS, new Set(), COPY)).toBe("All calendars");
  });

  it("qualifies a single option with its group", () => {
    expect(triggerLabelFor(GROUPS, new Set(["m-outdoor"]), COPY)).toBe(
      "Mohawk — Outdoor Series",
    );
  });

  it("names the group when exactly one whole group is selected", () => {
    expect(triggerLabelFor(GROUPS, new Set(["m-main", "m-outdoor"]), COPY)).toBe(
      "Mohawk (all calendars)",
    );
  });

  it("falls back to a count once the selection spans groups", () => {
    expect(
      triggerLabelFor(GROUPS, new Set(["m-main", "cu-late", "h-main"]), COPY),
    ).toBe("3 calendars");
  });

  it("does NOT claim a whole group when extra options are also selected", () => {
    // Mohawk is fully selected AND one more elsewhere — "Mohawk (all)" would
    // under-report the filter, which is the dangerous direction.
    expect(
      triggerLabelFor(
        GROUPS,
        new Set(["m-main", "m-outdoor", "cu-late"]),
        COPY,
      ),
    ).toBe("3 calendars");
  });

  it("names a fully-selected single-option group rather than counting it", () => {
    expect(triggerLabelFor(GROUPS, new Set(["h-main"]), COPY)).toBe(
      "Hole in the Wall — Main Calendar",
    );
  });

  it("counts when two whole groups are selected", () => {
    expect(
      triggerLabelFor(
        GROUPS,
        new Set(["m-main", "m-outdoor", "cu-late", "cu-main"]),
        COPY,
      ),
    ).toBe("4 calendars");
  });
});
