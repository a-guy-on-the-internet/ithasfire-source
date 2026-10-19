import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IthasFireProvider } from "@th/ui";

import { EmbedEventGrid } from "./EmbedEventGrid";
import type { EventItem } from "./embed-types";

// ─────────────────────────────────────────────────────────────────────────────
// EmbedEventGrid — REAL render (no @th/ui mock): the point of these tests is
// that the embed browse grid now renders the design-system `EventGridCard`,
// so we mount it under the real `IthasFireProvider` (mirrors packages/ui's
// own `renderWithProvider`) and assert against the produced DOM — including
// the `accessibilityLabel` → `aria-label` override, which is spread-order
// dependent and must not be guessed at.
// ─────────────────────────────────────────────────────────────────────────────

const makeEvent = (overrides: Partial<EventItem> = {}): EventItem => ({
  id: "evt-1",
  title: "Warehouse Show",
  slug: "warehouse-show",
  startsAt: new Date("2026-09-01T20:00:00Z"),
  endsAt: null,
  currency: "usd",
  heroImageUrl: null,
  addressText: "123 Main St",
  locality: "Nashville",
  region: "TN",
  lowestPriceCents: 2500,
  lowestBuyerTotalCents: 2862,
  paidTierCount: 2,
  hasFreeTier: false,
  ...overrides,
});

const renderGrid = (props: Partial<React.ComponentProps<typeof EmbedEventGrid>> = {}) =>
  render(
    <IthasFireProvider>
      <EmbedEventGrid
        orgName="Dev QA Collective"
        events={[makeEvent()]}
        onSelectEvent={() => {}}
        {...props}
      />
    </IthasFireProvider>,
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EmbedEventGrid", () => {
  it("renders the design-system card as the single interactive element", () => {
    renderGrid();

    // The card root is the interactive element (role="link" + tabIndex from
    // EventCard itself) — the motion wrapper must NOT be a second one.
    const card = screen.getByRole("link", { name: "Warehouse Show" });
    expect(card).toBeInTheDocument();
    expect(card.getAttribute("data-testid")).toBe("event-card-evt-1");
    expect(screen.queryByRole("button", { name: /Warehouse Show/ })).toBeNull();

    // Design-system card body: title + price label from the mapper.
    expect(
      screen.getByTestId("event-card-evt-1-title").textContent,
    ).toContain("Warehouse Show");
    // The poster's price is the block notched into the art's bottom-right
    // corner, which prints the amount over its context label.
    expect(
      screen.getByTestId("event-card-evt-1-price").textContent,
    ).toContain("$28.62");
  });

  it("keeps the header and count line", () => {
    renderGrid();
    expect(screen.getByText("Dev QA Collective")).toBeInTheDocument();
    expect(screen.getByText("1 upcoming event")).toBeInTheDocument();
  });

  it("selects the event on card press", () => {
    const onSelectEvent = vi.fn();
    renderGrid({ onSelectEvent });

    fireEvent.click(screen.getByRole("link", { name: "Warehouse Show" }));
    expect(onSelectEvent).toHaveBeenCalledTimes(1);
    expect(onSelectEvent.mock.calls[0][0].id).toBe("evt-1");
  });

  it("announces and opens a new tab when linkOut is set", () => {
    const onSelectEvent = vi.fn();
    const openSpy = vi
      .spyOn(window, "open")
      .mockImplementation(() => null);

    renderGrid({
      onSelectEvent,
      linkOut: true,
      buildEventUrl: (slugOrId) => `https://ithasfire.com/events/${slugOrId}`,
    });

    // The accessibilityLabel override must land as the card's aria-label —
    // verified in the rendered DOM, not assumed from prop order.
    const card = screen.getByRole("link", {
      name: "Warehouse Show — opens on Ithas Fire in a new tab",
    });
    fireEvent.click(card);

    expect(openSpy).toHaveBeenCalledWith(
      "https://ithasfire.com/events/warehouse-show",
      "_blank",
      "noopener,noreferrer",
    );
    expect(onSelectEvent).not.toHaveBeenCalled();
  });

  // Owner ruling 2026-10-12: a gated event stays listed, with the site card's
  // gate row, and its price stays as on the main site.
  it.each([
    ["APPLICATION", /Application/],
    ["PASSWORD", /Password/],
  ] as const)("a %s-gated card carries the site card's gate label and keeps its price", (gateType, label) => {
    renderGrid({ events: [makeEvent({ gateType })] });
    const card = screen.getByTestId("event-card-evt-1");
    expect(card.textContent).toMatch(label);
    expect(screen.getByTestId("event-card-evt-1-price").textContent).toContain(
      "$28.62",
    );
  });

  it("an ungated card has no gate label", () => {
    renderGrid({ events: [makeEvent({ gateType: "NONE" })] });
    const card = screen.getByTestId("event-card-evt-1");
    expect(card.textContent).not.toMatch(/Application|Password/);
  });

  it("renders the empty state when there are no events", () => {
    renderGrid({ events: [] });
    expect(screen.getByText("No upcoming events")).toBeInTheDocument();
    expect(
      screen.getByText("Check back soon — new events will appear here."),
    ).toBeInTheDocument();
    expect(screen.getByText("0 upcoming events")).toBeInTheDocument();
  });
});
