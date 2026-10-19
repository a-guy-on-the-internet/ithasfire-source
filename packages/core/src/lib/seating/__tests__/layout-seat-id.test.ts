import { describe, expect, it } from "vitest";

import {
  glyphIdsByLabel,
  layoutSeatIdPrefix,
  parseLayoutSeatId,
} from "../layout-seat-id";

// The derivation `materializeSections` creates Seats with, and the replay the
// override editor maps a Seat back to its glyph with.

describe("parseLayoutSeatId", () => {
  it.each([
    ["ORCH-A-1", { label: "A1", row: "A", number: 1 }],
    // The row is everything up to the LAST dash.
    ["ORCH-AA-B-12", { label: "AA-B12", row: "AA-B", number: 12 }],
    // parseInt is lossy: the zero is gone from row/number/label.
    ["ORCH-A-01", { label: "A1", row: "A", number: 1 }],
    // No dash after the prefix: no row, no number, label = raw id.
    ["ORCH-BOX", { label: "ORCH-BOX", row: null, number: null }],
    // Non-integer seat: row kept, number null, label = raw id.
    ["ORCH-A-x", { label: "ORCH-A-x", row: "A", number: null }],
  ])("%s", (seatId, expected) => {
    expect(parseLayoutSeatId(seatId, layoutSeatIdPrefix("ORCH"))).toEqual(
      expected,
    );
  });
});

describe("glyphIdsByLabel", () => {
  it("maps each derived label to the glyph id, only for the section's prefix", () => {
    const map = glyphIdsByLabel("ORCH", [
      "ORCH-A-01",
      "ORCH-BOX",
      "BAL-A-1",
    ]);
    expect([...map]).toEqual([
      ["A1", "ORCH-A-01"],
      ["ORCH-BOX", "ORCH-BOX"],
    ]);
  });

  it("last id wins on a repeated label, as materialisation does", () => {
    expect(glyphIdsByLabel("S", ["S-A-01", "S-A-1"]).get("A1")).toBe("S-A-1");
  });
});
