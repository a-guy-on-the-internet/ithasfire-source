import { screen, within } from "@testing-library/react";

import { renderWithProvider } from "../../../../../test/utils";
import { spaceTokens } from "../../tokens/space";
import { EventCard, type EventSummary } from "../event-grid";
import {
  PRICE_BLOCK_HEIGHT,
  PRICE_BLOCK_METRICS,
  PriceBlock,
} from "../events/PriceBlock";

describe("PriceBlock", () => {
  it("renders the amount and label on the brand-secondary fill", () => {
    renderWithProvider(
      <PriceBlock amount="$45" label="From" testId="price-block" />,
    );

    const frame = screen.getByTestId("price-block");
    // Long token names truncate in compiled classes (`_bg-brandSecond96872`).
    expect(frame.className).toContain("_bg-brandSecond");
    expect(screen.getByText("$45")).toBeTruthy();
    expect(screen.getByText("From")).toBeTruthy();
  });

  it("free variant swaps to the support fill with onSupport ink", () => {
    renderWithProvider(
      <PriceBlock amount="FREE" label="RSVP" free testId="price-block" />,
    );

    const frame = screen.getByTestId("price-block");
    expect(frame.className).toContain("_bg-support");
    expect(frame.className).not.toContain("_bg-brandSecond");
    // Foreground rides the onSupport token (ink on amber), never white.
    expect(screen.getByText("FREE").className).toContain("_col-onSupport");
  });

  it("uses onBrandSecondary ink on the default fill (never white-on-orange)", () => {
    renderWithProvider(<PriceBlock amount="$12" testId="price-block" />);
    expect(screen.getByText("$12").className).toContain("_col-onBrandSeco");
  });

  it("with `nowrap`, never wraps — the poster hard-codes this block's height", () => {
    // `POSTER_PRICE_BLOCK_H` (EventCard.tsx) is a compile-time 60px, and the
    // poster's scrim uses it to stop its content column above the block. That
    // constant is only true while both lines stay single: a wrapped amount
    // makes the real block taller than the constant and the ledger's bottom
    // rows print under an opaque slab. A long price must overflow SIDEWAYS.
    renderWithProvider(
      <PriceBlock
        amount="$1,234,567.89+"
        label="Starting from"
        nowrap
        testId="price-block"
      />,
    );
    expect(screen.getByText("$1,234,567.89+")).toHaveStyle({
      whiteSpace: "nowrap",
    });
    expect(screen.getByText("Starting from")).toHaveStyle({
      whiteSpace: "nowrap",
    });
  });

  it("WRAPS by default — a block in flow must not spill its frame", () => {
    // The TicketStub's price column is `flexShrink: 0` inside a frame with
    // `overflow: visible`. A block that cannot wrap grows sideways there and
    // spills visibly past the stub's border, so one-line is opt-in.
    renderWithProvider(
      <PriceBlock
        amount="$1,234.56+"
        label="Desde el precio de entrada"
        testId="price-block"
      />,
    );
    expect(screen.getByText("$1,234.56+")).not.toHaveStyle({
      whiteSpace: "nowrap",
    });
    expect(screen.getByText("Desde el precio de entrada")).not.toHaveStyle({
      whiteSpace: "nowrap",
    });
  });

  it("renders with the metrics PRICE_BLOCK_HEIGHT is derived from", () => {
    // The poster's `POSTER_PRICE_BLOCK_H` IS `PRICE_BLOCK_HEIGHT`. That is only
    // worth anything if the block really renders with those numbers — a
    // line-height typed straight into the JSX would leave the constant at 60
    // while the real block grew. So read the rendered box's own metrics back
    // out of the compiled classes and redo the sum.
    renderWithProvider(
      <PriceBlock amount="$45" label="From" testId="price-block" />,
    );
    const lineHeight = (el: HTMLElement) => {
      const cls = el.className.split(/\s+/).find((c) => /^_lh-\d/.test(c));
      return Number(cls?.match(/^_lh-(\d+(?:\.\d+)?)px$/)?.[1]);
    };
    const frame = screen.getByTestId("price-block");
    const gap = Number(
      frame.className.match(/(?:^|\s)_gap-(\d+(?:\.\d+)?)px(?:\s|$)/)?.[1],
    );
    // `paddingVertical: "$3"` compiles to a token class, not a px value.
    expect(frame.className).toMatch(/(?:^|\s)_paddingTop-t-space-3(?:\s|$)/);
    expect(frame.className).toMatch(/(?:^|\s)_paddingBottom-t-space-3(?:\s|$)/);
    const padding = spaceTokens.$3;

    const rendered =
      padding * 2 +
      lineHeight(screen.getByText("$45")) +
      gap +
      lineHeight(screen.getByText("From"));
    expect(rendered).toBe(PRICE_BLOCK_HEIGHT);
    expect(PRICE_BLOCK_METRICS.paddingY).toBe(padding);
    // And the number the poster was measured at in the running grid (96x60).
    expect(PRICE_BLOCK_HEIGHT).toBe(60);
  });

  it("the TICKET card's foot block still renders, and wraps (the in-flow default)", () => {
    // The ticket variant's foot is the one EventCard call site that does NOT
    // pass `nowrap`: the block sits in flow beside the serial, where wrapping a
    // long label beats spilling past the card. No production screen renders
    // the ticket variant today, so this is the only thing watching it.
    const event: EventSummary = {
      id: "22222222-2222-2222-2222-222222222222",
      title: "Ticket Foot Check",
      date: "2025-12-31",
      venue: "Harbor Hall",
      priceLabel: "$45",
    };
    renderWithProvider(
      <EventCard
        event={event}
        variant="ticket"
        testIdBase="ticket-card"
        onPress={() => {}}
      />,
    );
    const block = screen.getByTestId("ticket-card-price");
    // In the foot, not the poster's corner slot.
    expect(screen.getByTestId("ticket-card-foot").contains(block)).toBe(true);
    const amount = within(block).getByText("$45");
    expect(amount).not.toHaveStyle({ whiteSpace: "nowrap" });
  });

  it("omits the label row when no label is given", () => {
    renderWithProvider(<PriceBlock amount="$12" testId="price-block" />);
    const frame = screen.getByTestId("price-block");
    expect(frame.querySelectorAll("span").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("From")).toBeNull();
  });
});
