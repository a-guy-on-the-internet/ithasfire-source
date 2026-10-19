import { describe, expect, it } from "vitest";

import {
  rowSeats,
  seatPriceRead,
  seatRead,
  sectionRead,
  ticketTypeRead,
} from "../__fixtures__/seat-price-read";
import {
  buildSeatPriceModel,
  compareNatural,
  listStoredPrices,
} from "../seat-price-model";

describe("compareNatural", () => {
  it("orders numbers inside a label by value, not by character", () => {
    expect(["A10", "A2", "A1"].sort(compareNatural)).toEqual(["A1", "A2", "A10"]);
    expect(["10", "9", "AA", "B"].sort(compareNatural)).toEqual([
      "9",
      "10",
      "AA",
      "B",
    ]);
  });
});

describe("buildSeatPriceModel", () => {
  it("groups a section's seats by row, rows and seats in natural order", () => {
    const model = buildSeatPriceModel(
      seatPriceRead({
        sections: [
          sectionRead({
            seatSectionId: "orch",
            seats: [
              ...rowSeats("orch", "B", [2, 1]),
              ...rowSeats("orch", "10", [1]),
              ...rowSeats("orch", "A", [10, 2, 1]),
              ...rowSeats("orch", "2", [1]),
            ],
          }),
        ],
      }),
    );

    const groups = model.sections[0]!.rowGroups;
    expect(groups.map((g) => g.rowName)).toEqual(["2", "10", "A", "B"]);
    expect(groups[2]!.seats.map((s) => s.label)).toEqual(["A1", "A2", "A10"]);
    expect(groups[3]!.seats.map((s) => s.label)).toEqual(["B1", "B2"]);
    expect(groups.map((g) => g.key)).toEqual([
      "orch:row:2",
      "orch:row:10",
      "orch:row:A",
      "orch:row:B",
    ]);
  });

  it("puts seats without a row in one last group, apart from a row named 'none'", () => {
    const model = buildSeatPriceModel(
      seatPriceRead({
        sections: [
          sectionRead({
            seatSectionId: "bar",
            seats: [
              seatRead({ id: "s1", label: "Stool 2", row: null, number: null }),
              seatRead({ id: "s2", label: "N1", row: "none", number: 1 }),
              seatRead({ id: "s3", label: "Stool 1", row: null, number: null }),
            ],
          }),
        ],
      }),
    );

    const groups = model.sections[0]!.rowGroups;
    expect(groups.map((g) => g.rowName)).toEqual(["none", null]);
    expect(groups.map((g) => g.key)).toEqual(["bar:row:none", "bar:none"]);
    expect(groups[1]!.seats.map((s) => s.label)).toEqual(["Stool 1", "Stool 2"]);
  });

  it("sorts a seat with no number after the numbered seats of its row", () => {
    const model = buildSeatPriceModel(
      seatPriceRead({
        sections: [
          sectionRead({
            seats: [
              seatRead({ id: "x", label: "A-aisle", row: "A", number: null }),
              seatRead({ id: "y", label: "A2", row: "A", number: 2 }),
              seatRead({ id: "z", label: "A1", row: "A", number: 1 }),
            ],
          }),
        ],
      }),
    );
    expect(model.sections[0]!.rowGroups[0]!.seats.map((s) => s.id)).toEqual([
      "z",
      "y",
      "x",
    ]);
  });

  it("lets only AVAILABLE and BLOCKED seats be selected", () => {
    const model = buildSeatPriceModel(
      seatPriceRead({
        sections: [
          sectionRead({
            seats: [
              seatRead({ id: "avail", number: 1, status: "AVAILABLE" }),
              seatRead({ id: "held", number: 2, status: "HELD" }),
              seatRead({ id: "sold", number: 3, status: "SOLD" }),
              seatRead({ id: "blocked", number: 4, status: "BLOCKED" }),
            ],
          }),
        ],
      }),
    );

    expect([...model.selectableIds].sort()).toEqual(["avail", "blocked"]);
    expect(model.sections[0]!.rowGroups[0]!.selectableIds).toEqual([
      "avail",
      "blocked",
    ]);
    expect(model.seatsById.get("sold")!.selectable).toBe(false);
    expect(model.seatsById.get("held")!.selectable).toBe(false);
  });

  it("makes nothing selectable once the server says the event is not editable", () => {
    const model = buildSeatPriceModel(
      seatPriceRead({
        editable: false,
        sections: [sectionRead({ seats: rowSeats("o", "A", [1, 2]) })],
      }),
    );
    expect(model.editable).toBe(false);
    expect(model.selectableIds.size).toBe(0);
    expect(model.sections[0]!.rowGroups[0]!.selectableIds).toEqual([]);
  });

  it("counts seats and custom prices per row, per section and overall", () => {
    const model = buildSeatPriceModel(
      seatPriceRead({
        sections: [
          sectionRead({
            seatSectionId: "orch",
            seats: [
              ...rowSeats("orch", "A", [1, 2], {
                priceOverride: { priceCents: 6000, reason: "Front row" },
              }),
              ...rowSeats("orch", "B", [1, 2, 3]),
            ],
          }),
          sectionRead({
            seatSectionId: "balc",
            name: "Balcony",
            seats: [
              seatRead({
                id: "balc-1",
                priceOverride: { priceCents: 0, reason: null },
              }),
            ],
          }),
        ],
      }),
    );

    expect(model.seatCount).toBe(6);
    expect(model.customCount).toBe(3);
    const [orch, balc] = model.sections;
    expect(orch!.seatCount).toBe(5);
    expect(orch!.customCount).toBe(2);
    expect(orch!.rowGroups.map((g) => g.customCount)).toEqual([2, 0]);
    expect(balc!.customCount).toBe(1);
    expect(model.seatsById.get("balc-1")!.customPrice).toEqual({
      priceCents: 0,
      note: null,
    });
    expect(model.seatsById.get("orch-A1")!.customPrice).toEqual({
      priceCents: 6000,
      note: "Front row",
    });
  });

  it("leaves out a section that has no seats and keeps the server's section order", () => {
    const model = buildSeatPriceModel(
      seatPriceRead({
        sections: [
          sectionRead({ seatSectionId: "z", name: "Zed", seats: rowSeats("z", "A", [1]) }),
          sectionRead({ seatSectionId: "ga", name: "Floor", type: "GA", seats: [] }),
          sectionRead({ seatSectionId: "a", name: "Alpha", seats: rowSeats("a", "A", [1]) }),
        ],
      }),
    );
    expect(model.sections.map((s) => s.id)).toEqual(["z", "a"]);
    expect(model.sectionsById.has("ga")).toBe(false);
  });

  it("reads the section price from the fixed-price ticket types, cheapest first", () => {
    const model = buildSeatPriceModel(
      seatPriceRead({
        sections: [
          sectionRead({
            tiers: [
              ticketTypeRead({ id: "vip", name: "VIP", currentPriceCents: 9000 }),
              ticketTypeRead({ id: "std", name: "Standard", currentPriceCents: 4500 }),
            ],
            seats: rowSeats("o", "A", [1]),
          }),
        ],
      }),
    );
    const price = model.sections[0]!.fixedPrice!;
    expect(price.ticketTypes.map((t) => t.id)).toEqual(["std", "vip"]);
    expect(price.minCents).toBe(4500);
    expect(price.maxCents).toBe(9000);
  });

  it("has no section price when only a pay-what-you-want ticket type sells the section", () => {
    const model = buildSeatPriceModel(
      seatPriceRead({
        sections: [
          sectionRead({
            overrideRefusal: "ADJUSTABLE_TIER",
            tiers: [
              ticketTypeRead({
                id: "pwyw",
                name: "Community",
                pricingMode: "ADJUSTABLE",
                currentPriceCents: null,
              }),
            ],
            seats: rowSeats("o", "A", [1]),
          }),
        ],
      }),
    );
    const section = model.sections[0]!;
    expect(section.fixedPrice).toBeNull();
    expect(section.payWhatYouWantTypes.map((t) => t.name)).toEqual(["Community"]);
    expect(section.setRefusal).toBe("ADJUSTABLE_TIER");
  });

  it("copies the server's refusal and paid-block flags through unchanged", () => {
    // The read never sets both on one section: `paidOverrideBlockedBy` is
    // null whenever `overrideRefusal` is set.
    const model = buildSeatPriceModel(
      seatPriceRead({
        sections: [
          sectionRead({
            seatSectionId: "loose",
            overrideRefusal: "NO_FIXED_TIER",
            paidOverrideBlockedBy: null,
            tiers: [],
            seats: rowSeats("loose", "A", [1]),
          }),
          sectionRead({
            seatSectionId: "bar",
            overrideRefusal: null,
            paidOverrideBlockedBy: "FEE_POLICY",
            seats: rowSeats("bar", "A", [1]),
          }),
        ],
      }),
    );
    expect(model.sectionsById.get("loose")!.setRefusal).toBe("NO_FIXED_TIER");
    expect(model.sectionsById.get("loose")!.paidBlock).toBeNull();
    expect(model.sectionsById.get("bar")!.setRefusal).toBeNull();
    expect(model.sectionsById.get("bar")!.paidBlock).toBe("FEE_POLICY");
  });

  it("lists scheduled changes only when the server flags one for the section", () => {
    const at = new Date("2026-10-24T15:00:00.000Z");
    const tiers = [
      ticketTypeRead({
        id: "std",
        name: "Standard",
        upcomingPriceChange: { toPriceCents: 5500, at },
      }),
    ];
    const flagged = buildSeatPriceModel(
      seatPriceRead({
        sections: [
          sectionRead({
            hasPendingScheduledPriceChange: true,
            tiers,
            seats: rowSeats("o", "A", [1]),
          }),
        ],
      }),
    );
    expect(flagged.sections[0]!.scheduledChanges).toEqual([
      { ticketTypeId: "std", ticketTypeName: "Standard", toPriceCents: 5500, at },
    ]);

    const unflagged = buildSeatPriceModel(
      seatPriceRead({
        sections: [
          sectionRead({
            hasPendingScheduledPriceChange: false,
            tiers,
            seats: rowSeats("o", "A", [1]),
          }),
        ],
      }),
    );
    expect(unflagged.sections[0]!.scheduledChanges).toEqual([]);
  });

  it("marks a section whose seats have no glyph as not on the map", () => {
    const model = buildSeatPriceModel(
      seatPriceRead({
        sections: [
          sectionRead({
            seatSectionId: "on",
            layoutSectionId: "A",
            placeLayoutId: "layout-1",
            seats: rowSeats("on", "A", [1]),
          }),
          sectionRead({
            seatSectionId: "off",
            seats: rowSeats("off", "A", [1], { glyphKey: null }),
          }),
        ],
      }),
    );
    expect(model.sectionsById.get("on")!.onMap).toBe(true);
    expect(model.sectionsById.get("off")!.onMap).toBe(false);
  });

  it("marks a section that came from no layout as not on the map", () => {
    const model = buildSeatPriceModel(
      seatPriceRead({ sections: [sectionRead({ seatSectionId: "loose", seats: rowSeats("loose", "A", [1]) })] }),
    );
    expect(model.sectionsById.get("loose")!.onMap).toBe(false);
    expect(model.mapLayoutId).toBeNull();
  });

  it("flags a seat whose stored price cannot be read", () => {
    const model = buildSeatPriceModel(
      seatPriceRead({
        sections: [
          sectionRead({
            seats: [seatRead({ id: "bad", overrideInvalid: true })],
          }),
        ],
      }),
    );
    expect(model.seatsById.get("bad")!.priceUnreadable).toBe(true);
    expect(model.seatsById.get("bad")!.customPrice).toBeNull();
  });
});

describe("listStoredPrices", () => {
  it("gathers seats that share a price and note into one line per section", () => {
    const model = buildSeatPriceModel(
      seatPriceRead({
        editable: false,
        sections: [
          sectionRead({
            seatSectionId: "orch",
            name: "Orchestra",
            seats: [
              ...rowSeats("orch", "A", [1, 2], {
                priceOverride: { priceCents: 6000, reason: "Front row" },
              }),
              ...rowSeats("orch", "B", [1], {
                priceOverride: { priceCents: 6000, reason: null },
              }),
              ...rowSeats("orch", "C", [1]),
            ],
          }),
          sectionRead({
            seatSectionId: "balc",
            name: "Balcony",
            seats: [
              seatRead({
                id: "balc-1",
                label: "A1",
                priceOverride: { priceCents: 6000, reason: "Front row" },
              }),
              seatRead({ id: "balc-2", label: "A2", number: 2, overrideInvalid: true }),
            ],
          }),
        ],
      }),
    );

    expect(
      listStoredPrices(model).map(({ sectionName, seatLabels, priceCents, note }) => ({
        sectionName,
        seatLabels,
        priceCents,
        note,
      })),
    ).toEqual([
      { sectionName: "Orchestra", seatLabels: ["A1", "A2"], priceCents: 6000, note: "Front row" },
      { sectionName: "Orchestra", seatLabels: ["B1"], priceCents: 6000, note: null },
      { sectionName: "Balcony", seatLabels: ["A1"], priceCents: 6000, note: "Front row" },
      { sectionName: "Balcony", seatLabels: ["A2"], priceCents: null, note: null },
    ]);
  });

  it("returns nothing when no seat has a stored price", () => {
    const model = buildSeatPriceModel(
      seatPriceRead({ sections: [sectionRead({ seats: rowSeats("o", "A", [1, 2]) })] }),
    );
    expect(listStoredPrices(model)).toEqual([]);
  });
});
