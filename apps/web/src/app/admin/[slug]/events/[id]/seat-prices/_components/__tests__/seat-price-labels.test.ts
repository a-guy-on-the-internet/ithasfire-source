import { createTranslator } from "@th/locale";
import { describe, expect, it } from "vitest";

import enMessages from "@/i18n/messages/en";

import { rowSeats, seatPriceRead, seatRead, sectionRead } from "../__fixtures__/seat-price-read";
import { rowCheckboxLabel, seatCheckboxLabel } from "../seat-price-labels";
import { buildSeatPriceModel } from "../seat-price-model";

const t = createTranslator("en", enMessages as never).t;

describe("checkbox accessible names", () => {
  it("never repeat on one page, even when two sections share row and seat labels", () => {
    // Both sections have a Row A with A1 and A2, and a seat with no row.
    const model = buildSeatPriceModel(
      seatPriceRead({
        sections: ["Orchestra", "Balcony"].map((name) =>
          sectionRead({
            seatSectionId: name,
            name,
            seats: [
              ...rowSeats(name, "A", [1, 2]),
              ...rowSeats(name, "B", [1]),
              seatRead({ id: `${name}-stool`, label: "Stool 1", row: null, number: null }),
            ],
          }),
        ),
      }),
    );

    const names = model.sections.flatMap((section) =>
      section.rowGroups.flatMap((group) => [
        rowCheckboxLabel(section.name, group.rowName, t),
        ...group.seats.map((seat) => seatCheckboxLabel(section.name, seat.label, t)),
      ]),
    );

    expect(names).toContain("Orchestra, Row A");
    expect(names).toContain("Balcony, seat A1");
    expect(names).toContain("Balcony, Seats without a row");
    expect(new Set(names).size).toBe(names.length);
  });
});
