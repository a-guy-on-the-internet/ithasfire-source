import { describe, expect, it } from "vitest";

import {
  rowSeats,
  seatPriceRead,
  seatRead,
  sectionRead,
  ticketTypeRead,
} from "../__fixtures__/seat-price-read";
import { buildSeatPriceModel, type SeatPriceRead } from "../seat-price-model";
import {
  notesReplacedBy,
  resolvePanelActions,
  resolvePanelState,
  resolvePriceVerdict,
  type PanelSelection,
} from "../seat-price-panel-state";

const CHANGE_AT = new Date("2026-10-24T15:00:00.000Z");

/** Orchestra (Standard $45), Balcony (pay what you want), Bar (free, no payouts). */
function venue(over: Partial<SeatPriceRead> = {}) {
  return buildSeatPriceModel(
    seatPriceRead({
      sections: [
        sectionRead({
          seatSectionId: "orch",
          name: "Orchestra",
          tiers: [
            ticketTypeRead({ id: "std", name: "Standard", currentPriceCents: 4500 }),
          ],
          seats: [
            ...rowSeats("orch", "A", [1, 2, 3]),
            seatRead({ id: "orch-A4", label: "A4", number: 4, status: "SOLD" }),
            ...rowSeats("orch", "B", [1, 2]),
          ],
        }),
        sectionRead({
          seatSectionId: "balc",
          name: "Balcony",
          overrideRefusal: "ADJUSTABLE_TIER",
          tiers: [
            ticketTypeRead({
              id: "pwyw",
              name: "Community",
              pricingMode: "ADJUSTABLE",
              currentPriceCents: null,
            }),
          ],
          seats: rowSeats("balc", "A", [1, 2]),
        }),
        sectionRead({
          seatSectionId: "bar",
          name: "Bar Rail",
          paidOverrideBlockedBy: "STRIPE",
          tiers: [
            ticketTypeRead({ id: "free", name: "Friends", currentPriceCents: 0 }),
          ],
          seats: rowSeats("bar", "A", [1]),
        }),
      ],
      ...over,
    }),
  );
}

function selected(model: ReturnType<typeof venue>, ...ids: string[]): PanelSelection {
  const state = resolvePanelState(model, new Set(ids));
  if (state.kind !== "selection") {
    throw new Error(`expected a selection, got ${state.kind}`);
  }
  return state;
}

describe("resolvePanelState", () => {
  it("is read-only when the server says the event is not editable, whatever is selected", () => {
    const model = venue({ editable: false });
    expect(resolvePanelState(model, new Set(["orch-A1"]))).toEqual({
      kind: "readOnly",
    });
  });

  it("is empty with nothing selected", () => {
    expect(resolvePanelState(venue(), new Set())).toEqual({ kind: "empty" });
  });

  it("ignores ids that are sold, or that the read no longer holds", () => {
    const model = venue();
    expect(resolvePanelState(model, new Set(["orch-A4", "gone"]))).toEqual({
      kind: "empty",
    });
    expect(selected(model, "orch-A4", "orch-A1", "gone").seatIds).toEqual(["orch-A1"]);
  });

  it("lists the selection in list order, with the rows and seats it touches", () => {
    const panel = selected(venue(), "orch-B1", "orch-A2", "orch-A1");
    expect(panel.seatIds).toEqual(["orch-A1", "orch-A2", "orch-B1"]);
    expect(panel.seatCount).toBe(3);
    expect(panel.singleSeat).toBeNull();
    expect(panel.sections).toEqual([
      {
        id: "orch",
        name: "Orchestra",
        rowNames: ["A", "B"],
        seatLabels: ["A1", "A2", "B1"],
      },
    ]);
  });

  it("names the one seat when exactly one is selected", () => {
    const panel = selected(venue(), "orch-A2");
    expect(panel.singleSeat?.id).toBe("orch-A2");
    expect(panel.seatCount).toBe(1);
  });

  it("allows any price in a section with a fixed-price ticket type and no flags", () => {
    const panel = selected(venue(), "orch-A1", "orch-A2");
    expect(panel.canSetPrice).toBe(true);
    expect(panel.canSetPaidPrice).toBe(true);
    expect(panel.setRefusals).toEqual([]);
    expect(panel.paidBlocks).toEqual([]);
    expect(panel.sectionPrice).toMatchObject({ minCents: 4500, maxCents: 4500 });
    expect(panel.replacedTicketTypes.map((t) => t.name)).toEqual(["Standard"]);
  });

  it("refuses a price where the server flags a pay-what-you-want section", () => {
    const panel = selected(venue(), "balc-A1");
    expect(panel.canSetPrice).toBe(false);
    expect(panel.canSetPaidPrice).toBe(false);
    expect(panel.setRefusals).toEqual([
      {
        reason: "ADJUSTABLE_TIER",
        sectionId: "balc",
        sectionName: "Balcony",
        payWhatYouWantTypeNames: ["Community"],
      },
    ]);
    expect(panel.sectionPrice).toBeNull();
  });

  it("carries the no-fixed-price refusal as the server gave it", () => {
    const model = buildSeatPriceModel(
      seatPriceRead({
        sections: [
          sectionRead({
            seatSectionId: "loose",
            name: "Loose",
            overrideRefusal: "NO_FIXED_TIER",
            tiers: [],
            seats: rowSeats("loose", "A", [1]),
          }),
        ],
      }),
    );
    const panel = selected(model, "loose-A1");
    expect(panel.canSetPrice).toBe(false);
    expect(panel.setRefusals[0]).toMatchObject({
      reason: "NO_FIXED_TIER",
      payWhatYouWantTypeNames: [],
    });
  });

  it("allows only $0 where the server blocks a paid price", () => {
    const panel = selected(venue(), "bar-A1");
    expect(panel.canSetPrice).toBe(true);
    expect(panel.canSetPaidPrice).toBe(false);
    expect(panel.paidBlocks).toEqual([
      { reason: "STRIPE", sectionId: "bar", sectionName: "Bar Rail" },
    ]);
  });

  it("refuses a price for a mixed selection as soon as one section refuses", () => {
    const panel = selected(venue(), "orch-A1", "balc-A1");
    expect(panel.sections.map((s) => s.name)).toEqual(["Orchestra", "Balcony"]);
    expect(panel.canSetPrice).toBe(false);
    expect(panel.setRefusals.map((r) => r.sectionName)).toEqual(["Balcony"]);
    // Two sections: there is no single section price to show.
    expect(panel.sectionPrice).toBeNull();
  });

  it("blocks a paid price for a mixed selection as soon as one section blocks it", () => {
    const panel = selected(venue(), "orch-A1", "bar-A1");
    expect(panel.canSetPrice).toBe(true);
    expect(panel.canSetPaidPrice).toBe(false);
    expect(panel.paidBlocks.map((b) => b.sectionName)).toEqual(["Bar Rail"]);
    expect(panel.replacedTicketTypes.map((t) => t.name)).toEqual([
      "Standard",
      "Friends",
    ]);
  });

  it("names every ticket type a custom price replaces", () => {
    const model = buildSeatPriceModel(
      seatPriceRead({
        sections: [
          sectionRead({
            seatSectionId: "orch",
            tiers: [
              ticketTypeRead({ id: "std", name: "Standard", currentPriceCents: 4500 }),
              ticketTypeRead({ id: "stu", name: "Student", currentPriceCents: 3000 }),
              ticketTypeRead({ id: "vip", name: "VIP", currentPriceCents: 9000 }),
            ],
            seats: rowSeats("orch", "A", [1]),
          }),
        ],
      }),
    );
    const panel = selected(model, "orch-A1");
    expect(panel.replacedTicketTypes.map((t) => [t.name, t.priceCents])).toEqual([
      ["Standard", 4500],
      ["Student", 3000],
      ["VIP", 9000],
    ]);
    expect(panel.sectionPrice).toMatchObject({ minCents: 3000, maxCents: 9000 });
  });

  it("counts selected seats whose stored price cannot be read", () => {
    const model = buildSeatPriceModel(
      seatPriceRead({
        sections: [
          sectionRead({
            seats: [
              seatRead({ id: "bad", number: 1, overrideInvalid: true }),
              seatRead({ id: "fine", number: 2 }),
              seatRead({ id: "bad-unselected", number: 3, overrideInvalid: true }),
            ],
          }),
        ],
      }),
    );
    expect(selected(model, "bad", "fine").unreadableCount).toBe(1);
  });

  it("carries the scheduled changes of the selected seats' sections only", () => {
    const model = buildSeatPriceModel(
      seatPriceRead({
        sections: [
          sectionRead({
            seatSectionId: "orch",
            hasPendingScheduledPriceChange: true,
            tiers: [
              ticketTypeRead({
                id: "std",
                name: "Standard",
                upcomingPriceChange: { toPriceCents: 5500, at: CHANGE_AT },
              }),
            ],
            seats: rowSeats("orch", "A", [1]),
          }),
          sectionRead({
            seatSectionId: "balc",
            tiers: [ticketTypeRead({ id: "balc-std", name: "Balcony Standard" })],
            seats: rowSeats("balc", "A", [1]),
          }),
        ],
      }),
    );
    expect(selected(model, "orch-A1").scheduledChanges).toEqual([
      {
        ticketTypeId: "std",
        ticketTypeName: "Standard",
        toPriceCents: 5500,
        at: CHANGE_AT,
      },
    ]);
    expect(selected(model, "balc-A1").scheduledChanges).toEqual([]);
  });

  it("prefills price and note each on its own, only when every selected seat shares it", () => {
    const model = buildSeatPriceModel(
      seatPriceRead({
        sections: [
          sectionRead({
            seats: [
              seatRead({
                id: "a",
                number: 1,
                priceOverride: { priceCents: 6000, reason: "Front row" },
              }),
              seatRead({
                id: "b",
                number: 2,
                priceOverride: { priceCents: 6000, reason: "Front row" },
              }),
              seatRead({
                id: "other-note",
                number: 3,
                priceOverride: { priceCents: 6000, reason: "House seat" },
              }),
              seatRead({
                id: "dearer",
                number: 4,
                priceOverride: { priceCents: 8000, reason: "Front row" },
              }),
              seatRead({ id: "none", number: 5 }),
            ],
          }),
        ],
      }),
    );
    const both = selected(model, "a", "b");
    expect([both.sharedPriceCents, both.sharedNote]).toEqual([6000, "Front row"]);
    // Same price, different notes: the price prefills, the note does not.
    const notes = selected(model, "a", "other-note");
    expect([notes.sharedPriceCents, notes.sharedNote]).toEqual([6000, null]);
    // Same note, different prices: the note prefills, the price does not.
    const prices = selected(model, "a", "dearer");
    expect([prices.sharedPriceCents, prices.sharedNote]).toEqual([null, "Front row"]);
    // A seat without a custom price shares nothing.
    const mixed = selected(model, "a", "none");
    expect([mixed.sharedPriceCents, mixed.sharedNote]).toEqual([null, null]);
  });

  it("counts the notes a save would replace or delete", () => {
    const model = buildSeatPriceModel(
      seatPriceRead({
        sections: [
          sectionRead({
            seats: [
              seatRead({
                id: "a",
                number: 1,
                priceOverride: { priceCents: 1000, reason: "house seat" },
              }),
              seatRead({
                id: "b",
                number: 2,
                priceOverride: { priceCents: 8000, reason: "sponsor" },
              }),
              seatRead({
                id: "c",
                number: 3,
                priceOverride: { priceCents: 8000, reason: null },
              }),
              seatRead({ id: "d", number: 4 }),
            ],
          }),
        ],
      }),
    );
    const panel = selected(model, "a", "b", "c", "d");
    expect(panel.storedNotes).toEqual(["house seat", "sponsor"]);
    expect(notesReplacedBy(panel, null)).toBe(2);
    expect(notesReplacedBy(panel, "sponsor")).toBe(1);
    expect(notesReplacedBy(panel, "new")).toBe(2);
    expect(notesReplacedBy(selected(model, "c", "d"), "new")).toBe(0);
  });

  it("counts the seats a clear would change, an unreadable stored price included", () => {
    const model = buildSeatPriceModel(
      seatPriceRead({
        sections: [
          sectionRead({
            seats: [
              seatRead({
                id: "custom",
                number: 1,
                priceOverride: { priceCents: 1000, reason: null },
              }),
              seatRead({ id: "bad", number: 2, overrideInvalid: true }),
              seatRead({ id: "plain", number: 3 }),
            ],
          }),
        ],
      }),
    );
    expect(selected(model, "custom", "bad", "plain").clearableCount).toBe(2);
    expect(selected(model, "plain").clearableCount).toBe(0);
  });

  it("groups the replaced ticket types by section for a selection across sections", () => {
    const panel = selected(venue(), "orch-A1", "bar-A1");
    expect(
      panel.replacedBySection.map((group) => [
        group.sectionName,
        group.ticketTypes.map((type) => type.name),
      ]),
    ).toEqual([
      ["Orchestra", ["Standard"]],
      ["Bar Rail", ["Friends"]],
    ]);
  });
});

describe("resolvePriceVerdict", () => {
  const model = venue();

  it("accepts a typed price where the section allows one", () => {
    const panel = selected(model, "orch-A1");
    expect(resolvePriceVerdict(panel, "60.00")).toEqual({ kind: "ok", priceCents: 6000 });
    expect(resolvePriceVerdict(panel, "0")).toEqual({ kind: "ok", priceCents: 0 });
  });

  it("treats an empty field as nothing to send, not as an error", () => {
    expect(resolvePriceVerdict(selected(model, "orch-A1"), " ")).toEqual({
      kind: "empty",
    });
  });

  it("names why a typed price is not valid", () => {
    const panel = selected(model, "orch-A1");
    expect(resolvePriceVerdict(panel, "-5")).toEqual({ kind: "invalid", reason: "negative" });
    expect(resolvePriceVerdict(panel, "19.9999")).toEqual({
      kind: "invalid",
      reason: "tooPrecise",
    });
    expect(resolvePriceVerdict(panel, "1,500")).toEqual({
      kind: "invalid",
      reason: "ambiguous",
    });
    expect(resolvePriceVerdict(panel, "abc")).toEqual({ kind: "invalid", reason: "invalid" });
  });

  it("refuses any price, even a valid one, when a section refuses", () => {
    expect(resolvePriceVerdict(selected(model, "balc-A1"), "60.00")).toEqual({
      kind: "refused",
    });
    expect(resolvePriceVerdict(selected(model, "orch-A1", "balc-A1"), "0")).toEqual({
      kind: "refused",
    });
  });

  it("takes $0 but not a paid price where a paid price is blocked", () => {
    const panel = selected(model, "bar-A1");
    expect(resolvePriceVerdict(panel, "0.00")).toEqual({ kind: "ok", priceCents: 0 });
    expect(resolvePriceVerdict(panel, "0.01")).toEqual({ kind: "paidBlocked" });
    expect(resolvePriceVerdict(selected(model, "orch-A1", "bar-A1"), "25")).toEqual({
      kind: "paidBlocked",
    });
  });
});

describe("resolvePanelActions (the board's button states)", () => {
  const model = venue();
  const withCustom = buildSeatPriceModel(
    seatPriceRead({
      sections: [
        sectionRead({
          seatSectionId: "balc",
          overrideRefusal: "ADJUSTABLE_TIER",
          tiers: [
            ticketTypeRead({
              pricingMode: "ADJUSTABLE",
              currentPriceCents: null,
            }),
          ],
          seats: [
            seatRead({
              id: "old",
              number: 1,
              priceOverride: { priceCents: 2000, reason: null },
            }),
          ],
        }),
      ],
    }),
  );

  const actionsFor = (panel: PanelSelection, input: string, saving = false) =>
    resolvePanelActions(panel, resolvePriceVerdict(panel, input), saving);

  it("refused section: Set price off, Use section price on when a stored price exists", () => {
    const panel = selected(withCustom, "old");
    expect(actionsFor(panel, "60.00")).toEqual({
      setPriceDisabled: true,
      useSectionPriceDisabled: false,
    });
  });

  it("Use section price is off when no selected seat has a stored price to clear", () => {
    expect(actionsFor(selected(model, "orch-A1"), "60.00")).toEqual({
      setPriceDisabled: false,
      useSectionPriceDisabled: true,
    });
  });

  it("Set price stays off until something is typed", () => {
    expect(actionsFor(selected(model, "orch-A1"), "").setPriceDisabled).toBe(true);
  });

  it("STRIPE or FEE_POLICY: a paid price never sends, $0 does", () => {
    for (const block of ["STRIPE", "FEE_POLICY"] as const) {
      const blocked = buildSeatPriceModel(
        seatPriceRead({
          sections: [
            sectionRead({
              seatSectionId: "s",
              paidOverrideBlockedBy: block,
              seats: rowSeats("s", "A", [1]),
            }),
          ],
        }),
      );
      const panel = selected(blocked, "s-A1");
      // The button presses (so the reason shows), but the verdict never
      // carries a paid price to send.
      expect(resolvePriceVerdict(panel, "25.00")).toEqual({ kind: "paidBlocked" });
      expect(resolvePriceVerdict(panel, "0")).toEqual({ kind: "ok", priceCents: 0 });
    }
  });

  it("mixed sections: one refusing section turns Set price off for all", () => {
    const panel = selected(model, "orch-A1", "balc-A1");
    expect(actionsFor(panel, "60.00").setPriceDisabled).toBe(true);
  });

  it("everything is off while a save runs", () => {
    expect(actionsFor(selected(withCustom, "old"), "60.00", true)).toEqual({
      setPriceDisabled: true,
      useSectionPriceDisabled: true,
    });
  });
});
