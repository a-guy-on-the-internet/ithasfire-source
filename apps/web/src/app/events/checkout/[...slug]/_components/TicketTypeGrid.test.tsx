import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * FR-010 / Q-002 on the CHECKOUT grid — the surface one click past the page
 * that already knew.
 *
 * The gap this pins: the public event page rendered "Late release — On sale
 * Fri, Oct 9, 10:00 AM CDT" dimmed, the buyer clicked Get tickets, and the same
 * tier arrived here at full opacity with a live stepper and no notice. They
 * could add two and press Continue before the server refused with
 * `TICKET_TYPE_NOT_YET_ON_SALE`. Fail-closed, so no mischarge — but the refusal
 * landed with the card already out.
 */

// ── Mocks ────────────────────────────────────────────────────────────────────
// Every export this component pulls from `@th/ui` is enumerated EXPLICITLY. A
// catch-all Proxy would answer `then`, making the module namespace a thenable
// and hanging vitest — this repo has hit that.
vi.mock("@th/ui", async () => ({
  // The amount slider (PayWhatYouWantAmount): the real DOM contract.
  RangeSlider: (await import("@/test-support/range-slider-stub")).RangeSliderStub,
  useTranslations:
    () =>
    (key: string, vals?: Record<string, unknown>): string => {
      // Verbatim from apps/web/src/i18n/messages/en.ts.
      if (key === "eventDetail.tierOnSaleFrom")
        return `On sale ${String(vals?.date ?? "")}`;
      if (key === "eventDetail.tierNotOnSale") return "Not on sale yet";
      if (key === "eventDetail.tierSalesEnded") return "Sales ended";
      if (key === "eventDetail.tierPriceUntil")
        return `${String(vals?.price ?? "")} until ${String(vals?.date ?? "")}, then ${String(vals?.newPrice ?? "")}`;
      if (key === "checkout.increaseQuantityFor")
        return `Increase quantity — ${String(vals?.name ?? "")}`;
      if (key === "checkout.decreaseQuantityFor")
        return `Decrease quantity — ${String(vals?.name ?? "")}`;
      if (key === "common.soldOut") return "Sold out";
      if (key === "common.free") return "Free";
      if (key === "common.nRemaining")
        return `${String(vals?.count ?? 0)} remaining`;
      if (key === "checkout.calculatingTotal") return "Calculating…";
      if (key === "checkout.ticketsNotOnSale") return "Tickets are not on sale";
      if (key === "checkout.checkBackLater") return "Check back later";
      if (key === "eventDetail.fromPrice") return `From ${String(vals?.value ?? "")}`;
      return key;
    },
  useFormatters: () => ({
    // Real `Intl`, fixed locale — the zone under test comes from the prop.
    dateTime: (value: Date, options: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat("en-US", options).format(value),
    currency: (majorUnits: number, currency: string) =>
      new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
        majorUnits,
      ),
    number: (value: number) => String(value),
    locale: "en-US",
    getRawMessage: () => undefined,
  }),
  // Faithful to the real stepper's contract: `max` bounds increment, and
  // `disabled` kills both buttons. Those are the two things the grid drives.
  QuantityStepper: ({
    value,
    min = 0,
    max,
    disabled = false,
    incrementLabel,
    decrementLabel,
  }: {
    value: number;
    onStep: (delta: number) => void;
    min?: number;
    max?: number;
    disabled?: boolean;
    "aria-label"?: string;
    incrementLabel?: string;
    decrementLabel?: string;
  }) => (
    <div>
      <button type="button" disabled={!(value > min && !disabled)}>
        {decrementLabel}
      </button>
      <button
        type="button"
        disabled={!((max === undefined || value < max) && !disabled)}
      >
        {incrementLabel}
      </button>
    </div>
  ),
}));

import { TicketTypeGrid, type TicketTypeGridItem } from "./TicketTypeGrid";
import { withBuyerUnitTotals } from "@/lib/pricing/order-estimate";
import { serverRowAt } from "@/lib/pricing/__fixtures__/pwyw-floor";

const OPENS_AT = new Date("2026-10-09T15:00:00.000Z"); // 10:00 AM CDT
const CLOSED_AT = new Date("2026-09-01T15:00:00.000Z");
const FLIPS_AT = new Date("2026-10-03T20:00:00.000Z"); // 3:00 PM CDT

const formatPrice = (cents: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);

const item = (
  over: Partial<TicketTypeGridItem> & Pick<TicketTypeGridItem, "id" | "name">,
): TicketTypeGridItem => ({
  priceCents: 3000,
  buyerUnitTotalCents: 3000,
  // AUTHORED size vs what is LEFT. They are different facts and the component
  // may only read the second — see the sold-out block below.
  capacity: 40,
  remainingCapacity: 40,
  ...over,
});

const renderGrid = (
  ticketTypes: TicketTypeGridItem[],
  // NOT a default parameter: passing `undefined` explicitly would silently
  // re-apply the default and make the "no timezone" case untestable.
  ...rest: [] | [timezone: string | null | undefined]
) =>
  render(
    <TicketTypeGrid
      ticketTypes={ticketTypes}
      quantities={{}}
      onQuantityChange={vi.fn()}
      formatPrice={formatPrice}
      timezone={rest.length ? rest[0] : "America/Chicago"}
    />,
  );

const renderGridWithQuantities = (
  ticketTypes: TicketTypeGridItem[],
  quantities: Record<string, number>,
) =>
  render(
    <TicketTypeGrid
      ticketTypes={ticketTypes}
      quantities={quantities}
      onQuantityChange={vi.fn()}
      formatPrice={formatPrice}
      timezone="America/Chicago"
    />,
  );

const increment = (name: string) =>
  screen.getByRole("button", { name: `Increase quantity — ${name}` });

const decrement = (name: string) =>
  screen.getByRole("button", { name: `Decrease quantity — ${name}` });

describe("TicketTypeGrid — per-tier sale windows (FR-010)", () => {
  it("dims a not-yet-open tier, names the instant, and kills its stepper", () => {
    renderGrid([
      item({ id: "tt-open", name: "General" }),
      item({
        id: "tt-late",
        name: "Late release",
        sellability: {
          available: false,
          reason: "not_yet_on_sale",
          opensAt: OPENS_AT,
          closedAt: null,
        },
      }),
    ]);

    // Listed, not hidden — a buyer who came for the late release needs to see
    // it exists and when it opens.
    expect(screen.getByText("Late release")).toBeInTheDocument();
    const note = screen.getByText(/^On sale /);
    expect(note).toHaveTextContent("Oct 9");
    expect(note).toHaveTextContent("10:00");
    // Load-bearing: without the abbreviation "10:00 AM" is unfalsifiable to a
    // reader in another zone.
    expect(note).toHaveTextContent("CDT");

    expect(increment("Late release")).toBeDisabled();
    // …and the OPEN tier beside it is untouched.
    expect(increment("General")).toBeEnabled();
    expect(screen.queryAllByText(/^On sale /)).toHaveLength(1);
  });

  it("says 'Sales ended' with no date for an elapsed tier", () => {
    renderGrid([
      item({
        id: "tt-eb",
        name: "Early bird",
        sellability: {
          available: false,
          reason: "sales_ended",
          opensAt: null,
          closedAt: CLOSED_AT,
        },
      }),
    ]);
    // A deadline that has already passed is not something the buyer can act on.
    expect(screen.getByText("Sales ended")).toBeInTheDocument();
    expect(increment("Early bird")).toBeDisabled();
  });

  it("carries the window state into the row's accessible name", () => {
    renderGrid([
      item({
        id: "tt-late",
        name: "Late release",
        sellability: {
          available: false,
          reason: "not_yet_on_sale",
          opensAt: OPENS_AT,
          closedAt: null,
        },
      }),
    ]);
    const row = screen.getByRole("listitem");
    expect(row.getAttribute("aria-label")).toContain("On sale");
  });

  it("keeps SOLD OUT and NOT-YET-OPEN as independent facts on one row", () => {
    // A tier can honestly be both; neither is folded into the other, and the
    // row must say both rather than picking one.
    renderGrid([
      item({
        id: "tt-both",
        name: "Advance",
        remainingCapacity: 0,
        soldOut: true,
        sellability: {
          available: false,
          reason: "not_yet_on_sale",
          opensAt: OPENS_AT,
          closedAt: null,
        },
      }),
    ]);
    expect(screen.getByText("Sold out")).toBeInTheDocument();
    expect(screen.getByText(/^On sale /)).toBeInTheDocument();
    expect(increment("Advance")).toBeDisabled();
  });

  it("renders NOTHING extra for an event-wide refusal (the page banners it once)", () => {
    const { container } = renderGrid([
      item({
        id: "tt-x",
        name: "General",
        sellability: {
          available: false,
          reason: "stripe_not_connected",
          opensAt: null,
          closedAt: null,
        },
      }),
    ]);
    expect(container.textContent).not.toContain("On sale");
    expect(container.textContent).not.toContain("Sales ended");
    // …but the honest answer still reaches the stepper.
    expect(increment("General")).toBeDisabled();
  });

  it("REFUSES a wall time when the event carries no timezone", () => {
    // Phase 1c: refuse, don't degrade. Formatting with no zone renders on the
    // READER's clock AND drops the abbreviation, so a London buyer would read
    // "4:00 PM" for a 10:00 AM CDT window with nothing admitting it.
    renderGrid(
      [
        item({
          id: "tt-late",
          name: "Late release",
          sellability: {
            available: false,
            reason: "not_yet_on_sale",
            opensAt: OPENS_AT,
            closedAt: null,
          },
        }),
      ],
      null,
    );
    expect(screen.queryByText(/^On sale /)).not.toBeInTheDocument();
    expect(screen.getByText("Not on sale yet")).toBeInTheDocument();
    expect(increment("Late release")).toBeDisabled();
  });

  it("NFR-001: an unwindowed, unscheduled tier renders exactly as before", () => {
    const { container } = renderGrid([item({ id: "tt-p", name: "General" })]);
    expect(container.textContent).not.toContain("On sale");
    expect(container.textContent).not.toContain("Sales ended");
    expect(container.textContent).not.toContain("until");
    expect(increment("General")).toBeEnabled();
  });

  it("NFR-001: an `ok` sellability is byte-identical to no sellability at all", () => {
    const withOk = renderGrid([
      item({
        id: "tt-p",
        name: "General",
        sellability: {
          available: true,
          reason: "ok",
          opensAt: null,
          closedAt: null,
        },
      }),
    ]);
    const okHtml = withOk.container.innerHTML;
    withOk.unmount();

    const without = renderGrid([item({ id: "tt-p", name: "General" })]);
    expect(without.container.innerHTML).toBe(okHtml);
  });
});

/**
 * The sold-out signal. This grid used to test `capacity <= 0` — the AUTHORED
 * column, which no write path decrements — so a tier with every ticket gone
 * still rendered a live stepper, and the buyer only learned it was gone when
 * Continue came back TICKET_TYPE_SOLD_OUT with the form filled in.
 */
describe("TicketTypeGrid — sold-out from the server's count", () => {
  it("marks a tier sold out even though its AUTHORED capacity is large", () => {
    renderGrid([
      item({
        id: "tt-gone",
        name: "General",
        capacity: 200,
        remainingCapacity: 0,
        soldOut: true,
      }),
    ]);

    expect(screen.getByText("Sold out")).toBeInTheDocument();
    expect(increment("General")).toBeDisabled();
    // The row's accessible name carries it too.
    expect(screen.getByRole("listitem").getAttribute("aria-label")).toContain(
      "sold out",
    );
  });

  // The inverse guard, and the one that would fail if anybody re-introduced
  // `tt.capacity <= 0`: an authored-0 tier with stock left must still be
  // offered. (Reserved-seating tiers legitimately carry capacity 0 with their
  // real inventory in the seat map.)
  it("OFFERS a tier whose authored capacity is 0 but has stock remaining", () => {
    renderGrid([
      item({
        id: "tt-odd",
        name: "Balcony",
        capacity: 0,
        remainingCapacity: 12,
      }),
    ]);

    expect(screen.queryByText("Sold out")).not.toBeInTheDocument();
    expect(increment("Balcony")).toBeEnabled();
  });

  it("counts down scarcity copy from what is LEFT, not what was authored", () => {
    renderGrid([
      item({
        id: "tt-few",
        name: "Late release",
        capacity: 500,
        remainingCapacity: 3,
      }),
    ]);
    expect(screen.getByText("Only 3 left!")).toBeInTheDocument();
  });

  it("shows the remaining count, not the authored one, on a healthy tier", () => {
    renderGrid([
      item({
        id: "tt-many",
        name: "General",
        capacity: 500,
        remainingCapacity: 220,
      }),
    ]);
    expect(screen.getByText("220 remaining")).toBeInTheDocument();
  });

  it("derives sold-out from remainingCapacity when the server sends no verdict", () => {
    renderGrid([
      item({
        id: "tt-gone",
        name: "General",
        capacity: 40,
        remainingCapacity: 0,
      }),
    ]);
    expect(screen.getByText("Sold out")).toBeInTheDocument();
    expect(increment("General")).toBeDisabled();
  });

  it("lets a buyer REDUCE a quantity they already hold on a sold-out row", () => {
    // Reachable: the public count has no order to exclude, so a buyer resuming
    // a cart that holds the last units sees their own hold as "sold out". A
    // fully dead stepper would trap them at a quantity they cannot reduce.
    renderGridWithQuantities(
      [
        item({
          id: "tt-gone",
          name: "General",
          capacity: 40,
          remainingCapacity: 0,
          soldOut: true,
        }),
      ],
      { "tt-gone": 2 },
    );

    expect(decrement("General")).toBeEnabled();
    expect(increment("General")).toBeDisabled();
  });

  it("still shows two dead buttons for a sold-out row with nothing selected", () => {
    renderGrid([
      item({
        id: "tt-gone",
        name: "General",
        capacity: 40,
        remainingCapacity: 0,
        soldOut: true,
      }),
    ]);
    expect(decrement("General")).toBeDisabled();
    expect(increment("General")).toBeDisabled();
  });
});

describe("TicketTypeGrid — scheduled-price copy (Q-002)", () => {
  it("names the price it rises TO, not just the deadline", () => {
    renderGrid([
      item({
        id: "tt-eb",
        name: "Early bird",
        priceCents: 1200,
        buyerUnitTotalCents: 1200,
        upcomingPriceChange: { toPriceCents: 2000, at: FLIPS_AT },
      }),
    ]);
    const note = screen.getByText(/until/);
    expect(note).toHaveTextContent("$12.00 until");
    expect(note).toHaveTextContent("Oct 3");
    expect(note).toHaveTextContent("CDT");
    // The disambiguator. This line sits under availability notices that ARE
    // about dates, so "until Oct 3" alone reads as a sales deadline.
    expect(note).toHaveTextContent("then $20.00");
  });

  it("says nothing after the flip — core sends no pending change", () => {
    const { container } = renderGrid([
      item({
        id: "tt-eb",
        name: "Early bird",
        priceCents: 2000,
        buyerUnitTotalCents: 2000,
        upcomingPriceChange: null,
      }),
    ]);
    expect(container.textContent).not.toContain("until");
  });

  it("stacks the price-change line under a not-yet-open notice", () => {
    renderGrid([
      item({
        id: "tt-late",
        name: "Late release",
        priceCents: 1200,
        buyerUnitTotalCents: 1200,
        sellability: {
          available: false,
          reason: "not_yet_on_sale",
          opensAt: OPENS_AT,
          closedAt: null,
        },
        upcomingPriceChange: { toPriceCents: 2000, at: FLIPS_AT },
      }),
    ]);
    expect(screen.getByText(/^On sale /)).toBeInTheDocument();
    expect(screen.getByText(/until/)).toBeInTheDocument();
  });

  it("never leaves a raw i18n key on screen", () => {
    // The dual-catalog failure mode: a missing key renders as its own name.
    const { container } = renderGrid([
      item({
        id: "tt-late",
        name: "Late release",
        sellability: {
          available: false,
          reason: "not_yet_on_sale",
          opensAt: OPENS_AT,
          closedAt: null,
        },
        upcomingPriceChange: { toPriceCents: 2000, at: FLIPS_AT },
      }),
    ]);
    expect(container.textContent).not.toContain("eventDetail.");
    expect(container.textContent).not.toContain("checkout.");
    expect(container.textContent).not.toContain("common.");
  });

  /**
   * Drift guard for the contrast fix. An unbuyable row is dimmed, but the
   * sentence explaining WHY must not be — and opacity MULTIPLIES down the
   * tree, so the note cannot re-brighten itself from inside a dimmed
   * ancestor. The only way to keep it legible is for no ancestor between the
   * note and the row to carry an opacity below 1.
   *
   * jsdom does not composite, so this walks the chain structurally rather than
   * reading a computed colour. Without it, moving the dim back onto the row
   * is a one-line change with a fully green suite.
   */
  it("renders the availability note outside every dimmed ancestor", () => {
    renderGrid([
      item({
        id: "tt-late",
        name: "Late release",
        sellability: {
          available: false,
          reason: "not_yet_on_sale",
          opensAt: OPENS_AT,
          closedAt: null,
        },
      }),
    ]);

    const note = screen.getByText(/^On sale /);
    const row = note.closest('[role="listitem"]');
    expect(row).not.toBeNull();

    const dimmed: string[] = [];
    for (
      let el: HTMLElement | null = note as HTMLElement;
      el && el !== row;
      el = el.parentElement
    ) {
      const opacity = el.style.opacity;
      if (opacity !== "" && Number(opacity) < 1) {
        dimmed.push(`<${el.tagName.toLowerCase()} opacity=${opacity}>`);
      }
    }
    // The row itself is checked too — that is where the dim used to live.
    const rowOpacity = (row as HTMLElement).style.opacity;
    if (rowOpacity !== "" && Number(rowOpacity) < 1) {
      dimmed.push(`<row opacity=${rowOpacity}>`);
    }

    expect(
      dimmed,
      `The availability note is inside ${dimmed.length} dimmed element(s): ` +
        `${dimmed.join(", ")}. Opacity multiplies, so this reduces the note's ` +
        `contrast no matter what colour it uses. Dim the row's other content ` +
        `instead — see the comment on the row's style.`,
    ).toEqual([]);

    // And the control beside it IS still dimmed, so this can't be satisfied
    // by simply dropping the dim altogether.
    expect(increment("Late release")).toBeDisabled();
  });
});

describe("TicketTypeGrid — quantity is capped at what is actually LEFT", () => {
  // Closing sold-out without closing the quantity case would leave the same
  // offered-then-refused trip one dimension over: pick 5 of a tier with 3 left,
  // fill in contact + billing, get refused at hold.
  it("stops increment at remainingCapacity, not at the authored capacity", () => {
    renderGridWithQuantities(
      [item({ id: "t1", name: "General", capacity: 40, remainingCapacity: 3 })],
      { t1: 3 },
    );

    expect(increment("General")).toBeDisabled();
    // Still reducible — this is a live row, not a dead one.
    expect(decrement("General")).toBeEnabled();
  });

  it("still allows increment below the remaining count", () => {
    renderGridWithQuantities(
      [item({ id: "t1", name: "General", capacity: 40, remainingCapacity: 3 })],
      { t1: 2 },
    );

    expect(increment("General")).toBeEnabled();
  });

  it("does NOT clamp a resumed cart down to the public remaining count", () => {
    // The buyer's OWN unexpired hold is part of what consumed the tier — the
    // public read has no order to exclude — so remaining can be BELOW what they
    // already hold. Clamping would shove their quantity down; the rule is only
    // "you may not add more".
    renderGridWithQuantities(
      [item({ id: "t1", name: "General", capacity: 40, remainingCapacity: 0 })],
      { t1: 5 },
    );

    expect(increment("General")).toBeDisabled();
    expect(decrement("General")).toBeEnabled();
  });
});

describe("TicketTypeGrid — a cached estimate row priced at another face is never quoted", () => {
  // `withBuyerUnitTotals` is how `Checkout` builds these rows; the fee-rates
  // query behind it is cached for 60s, the ticket list is not.
  const pwyw = (minimumCents: number) => ({
    id: "tt-pwyw",
    name: "Sliding Scale",
    priceCents: 0,
    capacity: 40,
    remainingCapacity: 40,
    pricingMode: "ADJUSTABLE" as const,
    minimumCents,
    suggestedCents: 1500,
  });
  const rowsAtFloor500 = [serverRowAt("tt-pwyw", 500)];

  it("control: a fresh row quotes the floor all-in", () => {
    renderGrid(withBuyerUnitTotals([pwyw(500)], rowsAtFloor500));
    expect(screen.getByText("From $6.09")).toBeInTheDocument();
  });

  it("regression: the floor RAISED to $7 under a row still priced at $5 reads Calculating, never 'From $7.00' or the old $6.09", () => {
    renderGrid(withBuyerUnitTotals([pwyw(700)], rowsAtFloor500));
    expect(screen.getByText("Calculating…")).toBeInTheDocument();
    expect(screen.queryByText(/^From /)).not.toBeInTheDocument();
  });

  it("regression: the floor LOWERED to $3 under the $5 row reads Calculating, never an overstated figure", () => {
    renderGrid(withBuyerUnitTotals([pwyw(300)], rowsAtFloor500));
    expect(screen.getByText("Calculating…")).toBeInTheDocument();
    expect(screen.queryByText("From $6.09")).not.toBeInTheDocument();
  });

  it("regression: a fixed tier repriced $30 → $35 under the $30 row reads Calculating, not $35 + the $30 row's fees", () => {
    const row = serverRowAt("tt-ga", 3000);
    renderGrid(
      withBuyerUnitTotals([item({ id: "tt-ga", name: "GA", priceCents: 3500 })], [row]),
    );
    expect(screen.getByText("Calculating…")).toBeInTheDocument();
    expect(
      screen.queryByText(formatPrice(row.buyerUnitTotalCents)),
    ).not.toBeInTheDocument();
  });

  it("control: a fixed tier with a matching row shows its all-in figure", () => {
    const row = serverRowAt("tt-ga", 3000);
    renderGrid(
      withBuyerUnitTotals([item({ id: "tt-ga", name: "GA", priceCents: 3000 })], [row]),
    );
    expect(screen.getByText(formatPrice(row.buyerUnitTotalCents))).toBeInTheDocument();
  });
});
