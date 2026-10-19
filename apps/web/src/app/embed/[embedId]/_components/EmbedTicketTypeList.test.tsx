import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// ICU-aware stand-in for the stepper name keys so the tests assert the real
// composed names (ticket-type context) rather than raw keys.
vi.mock("@th/ui", async () => ({
  // The amount slider (PayWhatYouWantAmount): the real DOM contract.
  RangeSlider: (await import("@/test-support/range-slider-stub")).RangeSliderStub,
  useTranslations:
    () =>
    (key: string, vals?: Record<string, unknown>): string => {
      if (key === "checkout.increaseQuantityFor")
        return `Increase quantity — ${String(vals?.name ?? "")}`;
      if (key === "checkout.decreaseQuantityFor")
        return `Decrease quantity — ${String(vals?.name ?? "")}`;
      // FR-010 / Q-002 copy, mirroring apps/web/src/i18n/messages/en.ts.
      if (key === "eventDetail.tierOnSaleFrom")
        return `On sale ${String(vals?.date ?? "")}`;
      if (key === "eventDetail.tierNotOnSale") return "Not on sale yet";
      if (key === "eventDetail.tierSalesEnded") return "Sales ended";
      if (key === "eventDetail.tierPriceUntil")
        return `${String(vals?.price ?? "")} until ${String(vals?.date ?? "")}, then ${String(vals?.newPrice ?? "")}`;
      // Pay-what-you-want listing copy, mirroring en.ts.
      if (key === "eventDetail.fromPrice") return `From ${String(vals?.value ?? "")}`;
      if (key === "eventDetail.suggestedPrice")
        return `suggested ${String(vals?.value ?? "")}`;
      if (key === "eventDetail.payWhatYouWant") return "Pay what you want";
      if (key === "checkout.calculatingTotal") return "Calculating total...";
      return key;
    },
  // FR-010: the list now renders sales-window instants on the EVENT's clock.
  // Real `Intl`, fixed locale — the zone under test comes from the row.
  useFormatters: () => ({
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
}));

import {
  EmbedTicketTypeList,
  type EmbedTicketType,
} from "./EmbedTicketTypeList";
import { formatCurrency } from "./embed-helpers";
import {
  PWYW_FLOOR_CENTS,
  serverRowAt,
} from "@/lib/pricing/__fixtures__/pwyw-floor";
import { withBuyerUnitTotals } from "@/lib/pricing/order-estimate";

const ticketType = (
  id: string,
  name: string,
  overrides: Partial<EmbedTicketType> = {},
): EmbedTicketType => ({
  id,
  name,
  priceCents: 2500,
  buyerUnitTotalCents: 2900,
  // AUTHORED size vs what is LEFT. They are different facts and the widget may
  // only read the second — see the sold-out block below.
  capacity: 100,
  remainingCapacity: 100,
  currency: "usd",
  ...overrides,
});

describe("EmbedTicketTypeList quantity steppers", () => {
  it("gives every stepper button a ticket-type-scoped accessible name", () => {
    render(
      <EmbedTicketTypeList
        ticketTypes={[
          ticketType("tt_ga", "General Admission"),
          ticketType("tt_vip", "VIP"),
        ]}
        quantities={{ tt_ga: 1, tt_vip: 0 }}
        onQuantityChange={vi.fn()}
      />,
    );

    // Two ticket types → four buttons, all unambiguous.
    for (const name of [
      "Increase quantity — General Admission",
      "Decrease quantity — General Admission",
      "Increase quantity — VIP",
      "Decrease quantity — VIP",
    ]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("renders 44px stepper controls (mobile tap-target floor)", () => {
    render(
      <EmbedTicketTypeList
        ticketTypes={[ticketType("tt_ga", "General Admission")]}
        quantities={{ tt_ga: 1 }}
        onQuantityChange={vi.fn()}
      />,
    );

    const inc = screen.getByRole("button", {
      name: "Increase quantity — General Admission",
    });
    const dec = screen.getByRole("button", {
      name: "Decrease quantity — General Admission",
    });
    for (const btn of [inc, dec]) {
      expect(btn.style.height).toBe("44px");
      expect(btn.style.width).toBe("44px");
    }
  });

  // jsdom does no layout, so this pins the CSS contract the narrow-iframe fix
  // rests on. With `flex: 1` (basis 0) the name column always "fit" beside
  // the 132px stepper: a 272px iframe squeezed it to 50px and "General
  // Admission" ran under the minus button. A real basis makes the row wrap
  // the control onto its own line instead.
  it("gives the name column a real flex basis so a narrow row wraps the stepper below", () => {
    render(
      <EmbedTicketTypeList
        ticketTypes={[ticketType("tt_ga", "General Admission")]}
        quantities={{}}
        onQuantityChange={vi.fn()}
      />,
    );

    const row = screen.getByRole("listitem");
    expect(row.style.flexWrap).toBe("wrap");
    const info = screen.getByTestId("embed-ticket-info");
    expect(info.style.flexBasis).toBe("160px");
    expect(info.style.minWidth).toBe("0");
    expect(screen.getByText("General Admission").style.overflowWrap).toBe(
      "anywhere",
    );
  });

  it("steps the right ticket type", () => {
    const onQuantityChange = vi.fn();
    render(
      <EmbedTicketTypeList
        ticketTypes={[
          ticketType("tt_ga", "General Admission"),
          ticketType("tt_vip", "VIP"),
        ]}
        quantities={{ tt_ga: 1, tt_vip: 2 }}
        onQuantityChange={onQuantityChange}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Increase quantity — VIP" }),
    );
    expect(onQuantityChange).toHaveBeenCalledWith("tt_vip", 1);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Decrease quantity — General Admission",
      }),
    );
    expect(onQuantityChange).toHaveBeenCalledWith("tt_ga", -1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FR-010 — the embed gains the per-tier shape it never had
// ─────────────────────────────────────────────────────────────────────────────

const OPENS_AT = new Date("2026-10-09T15:00:00.000Z"); // 10:00 AM CDT, Oct 9
const FLIPS_AT = new Date("2026-10-03T20:00:00.000Z");

describe("EmbedTicketTypeList per-tier sale state (FR-010)", () => {
  it("shows the open instant on the EVENT's clock and disables the stepper", () => {
    // Before Phase 2b the widget knew only a whole-event `salesClosed`
    // boolean, so this tier rendered with a live +/- and failed at submit.
    render(
      <EmbedTicketTypeList
        ticketTypes={[
          ticketType("tt_late", "Late release", {
            timezone: "America/Chicago",
            sellability: {
              available: false,
              reason: "not_yet_on_sale",
              opensAt: OPENS_AT,
              closedAt: null,
            },
          }),
        ]}
        quantities={{}}
        onQuantityChange={vi.fn()}
      />,
    );

    const note = screen.getByText(/^On sale /);
    expect(note).toHaveTextContent("Oct 9");
    expect(note).toHaveTextContent("10:00");
    expect(note).toHaveTextContent("CDT");

    expect(
      screen.getByRole("button", { name: "Increase quantity — Late release" }),
    ).toBeDisabled();
  });

  it("carries the state into the row's accessible name", () => {
    render(
      <EmbedTicketTypeList
        ticketTypes={[
          ticketType("tt_ended", "Early bird", {
            sellability: {
              available: false,
              reason: "sales_ended",
              opensAt: null,
              closedAt: OPENS_AT,
            },
          }),
        ]}
        quantities={{}}
        onQuantityChange={vi.fn()}
      />,
    );
    expect(screen.getByText("Sales ended")).toBeInTheDocument();
    const row = screen.getByRole("listitem");
    expect(row.getAttribute("aria-label")).toContain("Sales ended");
  });

  it("keeps SOLD OUT independent of sellability, as FR-010 leaves it", () => {
    // Sold-out is still NOT folded into sellability; a tier can honestly be
    // both. What changed is the source: the SERVER's count, not the authored
    // capacity column.
    render(
      <EmbedTicketTypeList
        ticketTypes={[
          ticketType("tt_both", "Advance", {
            remainingCapacity: 0,
            soldOut: true,
            timezone: "America/Chicago",
            sellability: {
              available: false,
              reason: "not_yet_on_sale",
              opensAt: OPENS_AT,
              closedAt: null,
            },
          }),
        ]}
        quantities={{}}
        onQuantityChange={vi.fn()}
      />,
    );
    expect(screen.getByText("Sold out")).toBeInTheDocument();
    expect(screen.getByText(/^On sale /)).toBeInTheDocument();
  });

  it("renders the Q-002 price-change line before the flip and nothing after", () => {
    const { unmount } = render(
      <EmbedTicketTypeList
        ticketTypes={[
          ticketType("tt_eb", "Early bird", {
            priceCents: 1200,
            timezone: "America/Chicago",
            upcomingPriceChange: { toPriceCents: 2000, at: FLIPS_AT },
          }),
        ]}
        quantities={{}}
        onQuantityChange={vi.fn()}
      />,
    );
    const note = screen.getByText(/until/);
    // The widget formats money with its own `formatCurrency` (embed-helpers),
    // which drops trailing zero cents — "$12", not "$12.00".
    expect(note).toHaveTextContent("$12 until");
    expect(note).toHaveTextContent("Oct 3");
    // Q-002's actual ask: the price it rises TO. Without it the line is a bare
    // date sitting under the availability notices and reads as a deadline.
    expect(note).toHaveTextContent("then $20");
    unmount();

    const { container } = render(
      <EmbedTicketTypeList
        ticketTypes={[
          ticketType("tt_eb", "Early bird", {
            priceCents: 2000,
            upcomingPriceChange: null,
          }),
        ]}
        quantities={{}}
        onQuantityChange={vi.fn()}
      />,
    );
    expect(container.textContent).not.toContain("until");
  });

  it("NFR-001: a tier with no sellability keeps a live stepper", () => {
    render(
      <EmbedTicketTypeList
        ticketTypes={[ticketType("tt_ga", "General Admission")]}
        quantities={{}}
        onQuantityChange={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", {
        name: "Increase quantity — General Admission",
      }),
    ).not.toBeDisabled();
    expect(screen.queryByText(/^On sale /)).not.toBeInTheDocument();
  });

  /**
   * Drift guard for the contrast fix — see the twin in
   * `TicketTypeGrid.test.tsx`. The row is dimmed; the sentence explaining WHY
   * must not be. Opacity multiplies down the tree, so the note has to sit
   * outside every dimmed element or its contrast drops regardless of colour.
   */
  it("renders the availability note outside every dimmed ancestor", () => {
    render(
      <EmbedTicketTypeList
        ticketTypes={[
          ticketType("tt_late", "Late release", {
            timezone: "America/Chicago",
            sellability: {
              available: false,
              reason: "not_yet_on_sale",
              opensAt: OPENS_AT,
              closedAt: null,
            },
          }),
        ]}
        quantities={{}}
        onQuantityChange={vi.fn()}
      />,
    );

    const note = screen.getByText(/^On sale /);
    const row = note.closest('[role="listitem"]') as HTMLElement | null;
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
    const rowOpacity = row!.style.opacity;
    if (rowOpacity !== "" && Number(rowOpacity) < 1) {
      dimmed.push(`<row opacity=${rowOpacity}>`);
    }

    expect(
      dimmed,
      `The availability note is inside ${dimmed.length} dimmed element(s): ` +
        `${dimmed.join(", ")}. Opacity multiplies, so this reduces the note's ` +
        `contrast no matter what colour it uses. Dim the row's other content ` +
        `instead.`,
    ).toEqual([]);

    // The control beside it is still dead, so the guard cannot be satisfied
    // by dropping the dim entirely.
    expect(
      screen.getByRole("button", { name: "Increase quantity — Late release" }),
    ).toBeDisabled();
  });
});

describe("EmbedTicketTypeList — sold-out from the server's count", () => {
  const inc = (name: string) =>
    screen.getByRole("button", { name: `Increase quantity — ${name}` });
  const dec = (name: string) =>
    screen.getByRole("button", { name: `Decrease quantity — ${name}` });

  it("marks a tier sold out even though its AUTHORED capacity is large", () => {
    render(
      <EmbedTicketTypeList
        ticketTypes={[
          ticketType("tt_gone", "General", {
            capacity: 200,
            remainingCapacity: 0,
            soldOut: true,
          }),
        ]}
        quantities={{}}
        onQuantityChange={vi.fn()}
      />,
    );

    expect(screen.getByText("Sold out")).toBeInTheDocument();
    expect(inc("General")).toBeDisabled();
    expect(screen.getByRole("listitem").getAttribute("aria-label")).toContain(
      "sold out",
    );
  });

  // The inverse guard — this is the assertion that fails if anybody
  // re-introduces `tt.capacity <= 0`.
  it("OFFERS a tier whose authored capacity is 0 but has stock remaining", () => {
    render(
      <EmbedTicketTypeList
        ticketTypes={[
          ticketType("tt_odd", "Balcony", {
            capacity: 0,
            remainingCapacity: 12,
          }),
        ]}
        quantities={{}}
        onQuantityChange={vi.fn()}
      />,
    );

    expect(screen.queryByText("Sold out")).not.toBeInTheDocument();
    expect(inc("Balcony")).toBeEnabled();
  });

  it("counts down scarcity copy from what is LEFT, not what was authored", () => {
    render(
      <EmbedTicketTypeList
        ticketTypes={[
          ticketType("tt_few", "Late release", {
            capacity: 500,
            remainingCapacity: 3,
          }),
        ]}
        quantities={{}}
        onQuantityChange={vi.fn()}
      />,
    );
    expect(screen.getByText("Only 3 left!")).toBeInTheDocument();
  });

  it("shows the remaining count, not the authored one, on a healthy tier", () => {
    render(
      <EmbedTicketTypeList
        ticketTypes={[
          ticketType("tt_many", "General", {
            capacity: 5000,
            remainingCapacity: 1200,
          }),
        ]}
        quantities={{}}
        onQuantityChange={vi.fn()}
      />,
    );
    expect(screen.getByText("1,200 remaining")).toBeInTheDocument();
  });

  it("derives sold-out from remainingCapacity when the server sends no verdict", () => {
    render(
      <EmbedTicketTypeList
        ticketTypes={[
          ticketType("tt_gone", "General", { remainingCapacity: 0 }),
        ]}
        quantities={{}}
        onQuantityChange={vi.fn()}
      />,
    );
    expect(screen.getByText("Sold out")).toBeInTheDocument();
    expect(inc("General")).toBeDisabled();
  });

  it("lets a buyer REDUCE a quantity they hold on a row that went sold out", () => {
    // The widget refetches; another buyer can take the last units while this
    // one has some in the cart. A dead minus would trap them at a quantity
    // they cannot reduce and cannot check out.
    render(
      <EmbedTicketTypeList
        ticketTypes={[
          ticketType("tt_gone", "General", {
            remainingCapacity: 0,
            soldOut: true,
          }),
        ]}
        quantities={{ tt_gone: 2 }}
        onQuantityChange={vi.fn()}
      />,
    );

    expect(dec("General")).toBeEnabled();
    expect(inc("General")).toBeDisabled();
  });

  it("still shows two dead buttons for a sold-out row with nothing selected", () => {
    render(
      <EmbedTicketTypeList
        ticketTypes={[
          ticketType("tt_gone", "General", {
            remainingCapacity: 0,
            soldOut: true,
          }),
        ]}
        quantities={{}}
        onQuantityChange={vi.fn()}
      />,
    );
    expect(dec("General")).toBeDisabled();
    expect(inc("General")).toBeDisabled();
  });
});

describe("EmbedTicketTypeList — the pay-what-you-want price (owner ruling 2026-10-02)", () => {
  const pwyw = (overrides: Partial<EmbedTicketType> = {}) =>
    ticketType("tt_pwyw", "Sliding Scale", {
      priceCents: 0,
      pricingMode: "ADJUSTABLE",
      minimumCents: PWYW_FLOOR_CENTS,
      suggestedCents: 1500,
      // `withBuyerUnitTotals` merges the server's floor row in.
      buyerUnitTotalCents: serverRowAt("tt_pwyw", PWYW_FLOOR_CENTS).buyerUnitTotalCents,
      ...overrides,
    });
  const renderList = (tier: EmbedTicketType) =>
    render(
      <EmbedTicketTypeList
        ticketTypes={[tier]}
        quantities={{}}
        onQuantityChange={vi.fn()}
      />,
    );

  it("a $5 floor at 8.88% reads 'From $6.09', the total a ticket at the floor costs", () => {
    renderList(pwyw());
    expect(screen.getByTestId("embed-ticket-price")).toHaveTextContent(
      `From ${formatCurrency(609, "usd")}`,
    );
    expect(screen.queryByTestId("embed-ticket-price-hint")).toBeNull();
    expect(screen.getByRole("listitem")).toHaveAccessibleName(
      `Sliding Scale, From ${formatCurrency(609, "usd")}`,
    );
  });

  it("the floor's row not loaded: 'Calculating total...', never the $5 floor", () => {
    renderList(pwyw({ buyerUnitTotalCents: null }));
    expect(screen.getByTestId("embed-ticket-price")).toHaveTextContent(
      "Calculating total...",
    );
    expect(screen.queryByText(/From/)).toBeNull();
  });

  it("floor 0: 'Pay what you want' + the FACE suggestion, never Free or From", () => {
    renderList(pwyw({ minimumCents: 0, buyerUnitTotalCents: 0 }));
    expect(screen.getByTestId("embed-ticket-price")).toHaveTextContent(
      "Pay what you want",
    );
    expect(screen.getByTestId("embed-ticket-price-hint")).toHaveTextContent(
      `suggested ${formatCurrency(1500, "usd")}`,
    );
    expect(screen.queryByText(/From|common\.free/)).toBeNull();
  });
});

describe("EmbedTicketTypeList — a cached estimate row priced at another face is never quoted", () => {
  // `EmbedEventDetail` builds these rows with `withBuyerUnitTotals`; the
  // fee-rates query behind it is cached for 60s.
  const pwyw = (minimumCents: number) =>
    ticketType("tt_pwyw", "Sliding Scale", {
      priceCents: 0,
      buyerUnitTotalCents: undefined,
      pricingMode: "ADJUSTABLE",
      minimumCents,
      suggestedCents: 1500,
    });
  const rowsAtFloor500 = [serverRowAt("tt_pwyw", PWYW_FLOOR_CENTS)];
  const renderRows = (rows: EmbedTicketType[]) =>
    render(
      <EmbedTicketTypeList ticketTypes={rows} quantities={{}} onQuantityChange={vi.fn()} />,
    );

  it("control: a fresh row quotes the floor all-in", () => {
    renderRows(withBuyerUnitTotals([pwyw(500)], rowsAtFloor500));
    expect(screen.getByTestId("embed-ticket-price")).toHaveTextContent(
      `From ${formatCurrency(609, "usd")}`,
    );
  });

  it("regression: the floor raised to $7 under the $5 row reads Calculating, never 'From $7'", () => {
    renderRows(withBuyerUnitTotals([pwyw(700)], rowsAtFloor500));
    expect(screen.getByTestId("embed-ticket-price")).toHaveTextContent(
      "Calculating total...",
    );
  });

  it("regression: the floor lowered to $3 under the $5 row reads Calculating, never an overstated $6.09", () => {
    renderRows(withBuyerUnitTotals([pwyw(300)], rowsAtFloor500));
    expect(screen.getByTestId("embed-ticket-price")).toHaveTextContent(
      "Calculating total...",
    );
  });

  it("regression: a fixed tier repriced $25 → $30 under the $25 row reads Calculating", () => {
    renderRows(
      withBuyerUnitTotals(
        [ticketType("tt_ga", "GA", { priceCents: 3000, buyerUnitTotalCents: undefined })],
        [serverRowAt("tt_ga", 2500)],
      ),
    );
    expect(screen.getByTestId("embed-ticket-price")).toHaveTextContent(
      "Calculating total...",
    );
  });
});
