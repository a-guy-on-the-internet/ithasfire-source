import { describe, expect, it } from "vitest";

import {
  foldUnitIntoFormatted,
  stripUnitFromFormatted,
} from "../place-unit";

/**
 * The "Unit or room" fold: ONE position (right after the street line as a
 * whole run of segments, else the front), the unit as its own run, and
 * strip(fold(x)) === x byte for byte. The web dialog imports these same
 * functions, so this is the only test of the rule.
 */

const STREET = "2190 Nolensville Pike";
const BARE = `${STREET}, Nashville, TN 37211, USA`;

/** fold then strip, as a re-save does. */
function roundTrip(base: string, line1: string | null, unit: string): string {
  return stripUnitFromFormatted(
    foldUnitIntoFormatted(base, line1, unit),
    line1,
    unit,
  );
}

describe("foldUnitIntoFormatted", () => {
  it("puts the unit right after the street line", () => {
    expect(foldUnitIntoFormatted(BARE, STREET, " Unit A ")).toBe(
      `${STREET}, Unit A, Nashville, TN 37211, USA`,
    );
  });

  it("finds the street line behind a leading business name", () => {
    expect(foldUnitIntoFormatted(`Red Bicycle, ${BARE}`, STREET, "Back room")).toBe(
      `Red Bicycle, ${STREET}, Back room, Nashville, TN 37211, USA`,
    );
  });

  it("a unit with commas goes in as one run, its segments trimmed", () => {
    expect(foldUnitIntoFormatted(BARE, STREET, "Unit A ,Floor 2")).toBe(
      `${STREET}, Unit A, Floor 2, Nashville, TN 37211, USA`,
    );
  });

  it("accepted: a geocoder street segment that already carries the suite, plus the same typed unit, shows the unit twice (fold never skips; skipping is what stripped the city)", () => {
    // The street line matches only as a WHOLE segment run, so the unit goes
    // at the front; it still round-trips.
    const inline = "123 Main St Suite 5, Springfield";
    expect(foldUnitIntoFormatted(inline, "123 Main St", "Suite 5")).toBe(
      `Suite 5, ${inline}`,
    );
    expect(roundTrip(inline, "123 Main St", "Suite 5")).toBe(inline);
  });

  it("matches a street line that itself has a comma, as a run", () => {
    expect(
      foldUnitIntoFormatted("Bldg 4, 10 Elm St, Austin", "Bldg 4, 10 Elm St", "Rm 2"),
    ).toBe("Bldg 4, 10 Elm St, Rm 2, Austin");
  });

  it("leads the text when there is no street line", () => {
    expect(foldUnitIntoFormatted("Nashville, TN, USA", null, "Unit A")).toBe(
      "Unit A, Nashville, TN, USA",
    );
  });

  it("ALWAYS inserts, even when the next segment reads the same (a unit equal to the city)", () => {
    expect(foldUnitIntoFormatted(BARE, STREET, "Nashville")).toBe(
      `${STREET}, Nashville, Nashville, TN 37211, USA`,
    );
  });

  it("a blank unit changes nothing", () => {
    expect(foldUnitIntoFormatted(BARE, STREET, "  ")).toBe(BARE);
    expect(foldUnitIntoFormatted(BARE, STREET, " , ")).toBe(BARE);
    expect(foldUnitIntoFormatted(BARE, STREET, null)).toBe(BARE);
  });
});

describe("stripUnitFromFormatted", () => {
  it.each([
    ["a plain unit", STREET, "Unit A"],
    ["a unit with a comma", STREET, "Unit A, Floor 2"],
    ["a unit equal to the city", STREET, "Nashville"],
    ["a unit equal to the region", STREET, "TN 37211"],
    ["a unit at the front (no street line)", null, "Back room"],
  ])("is the exact inverse of fold: %s", (_label, line1, unit) => {
    expect(roundTrip(BARE, line1, unit)).toBe(BARE);
  });

  it("is idempotent across re-saves: strip then fold gives back the same text", () => {
    const once = foldUnitIntoFormatted(BARE, STREET, "Unit A, Floor 2");
    const again = foldUnitIntoFormatted(
      stripUnitFromFormatted(once, STREET, "Unit A, Floor 2"),
      STREET,
      "Unit A, Floor 2",
    );
    expect(again).toBe(once);
  });

  it("removes the unit ONLY at its position, never the same text elsewhere", () => {
    const elsewhere = `${STREET}, Nashville, Unit A, TN`;
    expect(stripUnitFromFormatted(elsewhere, STREET, "Unit A")).toBe(elsewhere);
    // A unit equal to the city, folded: the first "Nashville" (the unit) goes.
    expect(
      stripUnitFromFormatted(
        `${STREET}, Nashville, Nashville, TN 37211, USA`,
        STREET,
        "Nashville",
      ),
    ).toBe(BARE);
  });

  it("keeps the spacing of every untouched segment", () => {
    const odd = `${STREET},  Unit A,Nashville ,TN`;
    expect(stripUnitFromFormatted(odd, STREET, "unit a")).toBe(
      `${STREET},Nashville ,TN`,
    );
  });

  it("leaves a legacy text alone (unit folded into the street line, no stored unit)", () => {
    const legacy = `${STREET}, Unit A, Nashville, TN 37211, USA`;
    expect(stripUnitFromFormatted(legacy, `${STREET}, Unit A`, null)).toBe(legacy);
    // And a new unit on a legacy place goes after the WHOLE stored line1 run.
    expect(foldUnitIntoFormatted(legacy, `${STREET}, Unit A`, "Rear")).toBe(
      `${STREET}, Unit A, Rear, Nashville, TN 37211, USA`,
    );
  });

  it("a blank or absent unit changes nothing", () => {
    expect(stripUnitFromFormatted(BARE, STREET, null)).toBe(BARE);
    expect(stripUnitFromFormatted(BARE, STREET, "  ")).toBe(BARE);
  });
});
