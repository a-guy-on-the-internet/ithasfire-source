import { screen } from "@testing-library/react";

import { renderWithProvider } from "../../../../../test/utils";
import {
  DEFAULT_MEDIA_ASPECT_RATIO,
  EventCard,
  EventGrid,
  getEventCardMediaDimensions,
  getEventCardMinHeight,
  type EventSummary,
} from "../event-grid";

const baseEvent: EventSummary = {
  id: "evt-1",
  title: "Sample Event",
  date: "2025-12-31",
  venue: "Harbor Hall",
  priceLabel: "$120",
  media: {
    url: "https://static.ithasfire.test/sample.jpg",
    alt: "Sample Event image",
    aspectRatio: 16 / 9,
  },
};

describe("EventCard sizing", () => {
  it("keeps the surface auto-sized, and gives the POSTER no min-height", () => {
    renderWithProvider(
      <EventCard event={baseEvent} testIdBase="spec-card" layout="vertical" />,
    );

    const surface = screen.getByTestId("spec-card");
    expect((surface as HTMLElement).style.width).toBe("");
    expect((surface as HTMLElement).style.maxWidth).toBe("");
    expect((surface as HTMLElement).style.minHeight).toBe("");

    // `getEventCardMinHeight` is art-height + body-height computed from the
    // TICKET's landscape maths. A poster has no body, so imposing it was pure
    // surplus the art absorbed through `flexGrow` — it rendered at 0.737
    // instead of the 4:5 it asked for and every phone card came out ~40px
    // taller than it needed to be.
    const layout = screen.getByTestId("spec-card-layout");
    expect(window.getComputedStyle(layout as HTMLElement).minHeight).toBe("");
  });

  it("still enforces the vertical min-height on the ticket", () => {
    renderWithProvider(
      <EventCard
        event={baseEvent}
        variant="ticket"
        testIdBase="tk"
        layout="vertical"
      />,
    );

    const layout = screen.getByTestId("tk-layout");
    expect(window.getComputedStyle(layout as HTMLElement).minHeight).toBe(
      `${getEventCardMinHeight("md", "vertical")}px`,
    );
  });

  it("enforces min-height via the horizontal layout container", () => {
    renderWithProvider(
      <EventCard
        event={baseEvent}
        testIdBase="spec-card"
        layout="horizontal"
      />,
    );

    const layout = screen.getByTestId("spec-card-layout");
    const expected = `${getEventCardMinHeight("md", "horizontal")}px`;
    expect(window.getComputedStyle(layout as HTMLElement).minHeight).toBe(
      expected,
    );
  });

  it("sizes the art window by RATIO, not by a pixel cap", () => {
    const { unmount } = renderWithProvider(
      <EventCard event={baseEvent} testIdBase="spec-card" layout="vertical" />,
    );

    // The default card is the poster: PORTRAIT 2:3.
    let image = screen.getAllByRole("img", { name: baseEvent.media!.alt })[0];
    // This used to assert a `maxHeight` of `getEventCardMediaDimensions(...)`,
    // which is the height the ratio implies for the card's NOMINAL width — not
    // the width an auto-fill track actually hands it. Measured in a browser at
    // a real 332px card the cap won and the window came out the wrong shape.
    // The ratio is the point of the art window, so the ratio governs.
    expect((image as HTMLElement).style.maxHeight).toBe("");
    expect((image as HTMLElement).style.aspectRatio).toBe(String(2 / 3));
    unmount();

    // The ticket keeps the landscape window.
    renderWithProvider(
      <EventCard event={baseEvent} variant="ticket" testIdBase="tk" />,
    );
    image = screen.getAllByRole("img", { name: baseEvent.media!.alt })[0];
    expect((image as HTMLElement).style.aspectRatio).toBe(
      String(DEFAULT_MEDIA_ASPECT_RATIO),
    );
  });

  it("lets the horizontal media stretch with the card height", () => {
    renderWithProvider(
      <EventCard
        event={baseEvent}
        testIdBase="spec-card"
        layout="horizontal"
      />,
    );

    const image = screen.getAllByRole("img", { name: baseEvent.media!.alt })[0];
    const mediaContainer = (image as HTMLElement).parentElement as HTMLElement;
    const expectedMinHeight = `${getEventCardMinHeight("md", "horizontal")}px`;

    expect(window.getComputedStyle(mediaContainer).minHeight).toBe(
      expectedMinHeight,
    );
    expect(mediaContainer.style.maxHeight).toBe("");
    expect(mediaContainer.style.aspectRatio).toBe("");
    expect((image as HTMLElement).style.maxHeight).toBe("");
    expect((image as HTMLElement).style.aspectRatio).toBe("");
  });
});

describe("EventCard recurring affordance", () => {
  it("puts Recurring on the poster's chrome line", () => {
    renderWithProvider(
      <EventCard
        event={{ ...baseEvent, isRecurring: true }}
        testIdBase="spec-card"
      />,
    );

    // The poster has no body to hang icon rows off, so status rides the mono
    // line. Dropping it would mean a recurring event reading as a one-off.
    expect(screen.getByTestId("spec-card-status").textContent).toContain(
      "Recurring",
    );
  });

  it("prints the poster's gate label at full strength", () => {
    renderWithProvider(
      <EventCard
        event={{ ...baseEvent, gateType: "APPLICATION" }}
        testIdBase="gate-card"
      />,
    );

    // On an embed list this line is the only sign the event is gated, so it
    // must not be dimmed below the meta line it sits under.
    const status = screen.getByTestId("gate-card-status") as HTMLElement;
    // "Application" here; apps/web's catalog overrides it to "By application".
    expect(status.textContent).toMatch(/application/i);
    // Computed, not `.style`: Tamagui emits style props as atomic classes, so
    // the inline attribute would miss an `opacity` prop. It used to print at
    // 0.75 — the dimmest line on the card.
    const computed = window.getComputedStyle(status);
    expect(computed.opacity).not.toBe("0.75");
    expect(["", "1"]).toContain(computed.opacity);
    // The meta line's rung (`monoScale.sm`): size and tracking travel together.
    expect(computed.fontSize).toBe("11px");
    expect(computed.letterSpacing).toBe("2px");
  });

  it("keeps Recurring as an icon row on the ticket", () => {
    renderWithProvider(
      <EventCard
        event={{ ...baseEvent, isRecurring: true }}
        variant="ticket"
        testIdBase="tk"
      />,
    );

    expect(screen.getByText("Recurring")).toBeTruthy();
  });

  it("keeps the Recurring label in the dense layout when isRecurring is true", () => {
    renderWithProvider(
      <EventCard
        event={{ ...baseEvent, isRecurring: true }}
        testIdBase="spec-card"
        dense
      />,
    );

    expect(screen.getByText("Recurring")).toBeTruthy();
  });

  it("omits the Recurring label for single-date events", () => {
    renderWithProvider(<EventCard event={baseEvent} testIdBase="spec-card" />);

    expect(screen.queryByText("Recurring")).toBeNull();
  });
});

describe("EventCard claimed-bar slot (v2)", () => {
  it("hides the claimed bar by default", () => {
    renderWithProvider(<EventCard event={baseEvent} testIdBase="spec-card" />);
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("renders the claimed bar on the ticket when claimedPercent is provided", () => {
    renderWithProvider(
      <EventCard
        event={baseEvent}
        variant="ticket"
        testIdBase="spec-card"
        claimedPercent={72}
      />,
    );
    expect(screen.getByText("72% claimed")).toBeTruthy();
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "72",
    );
  });

  it("states the claimed share as text on the poster — option A draws no bar", () => {
    renderWithProvider(
      <EventCard event={baseEvent} testIdBase="poster" claimedPercent={72} />,
    );
    expect(screen.getByTestId("poster-status").textContent).toContain(
      "72% claimed",
    );
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("never renders the claimed bar at 0%", () => {
    renderWithProvider(
      <EventCard event={baseEvent} testIdBase="spec-card" claimedPercent={0} />,
    );
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});

/**
 * The poster (Gate-5 option A) is what a browse card resolves to.
 *
 * These assert STRUCTURE and COUNTS, deliberately — jsdom does not apply
 * Tamagui's class-based styles, so `getComputedStyle` returns nothing for the
 * scrim gradient, the ink ground or the duotone. A test written against those
 * passes while the card is visibly broken. Geometry and contrast are verified
 * in a real browser; what is worth pinning here is which parts exist per state.
 */
describe("EventCard — the poster", () => {
  it("is the default, and it has no ticket chrome", () => {
    const { container } = renderWithProvider(
      <EventCard event={baseEvent} testIdBase="poster" />,
    );

    // No tear, no die-cuts, no serial-and-price foot: option A puts the card's
    // whole body on the image.
    expect(container.querySelectorAll("[data-th-punch-hole]")).toHaveLength(0);
    expect(screen.queryByTestId("poster-foot")).not.toBeInTheDocument();
    expect(screen.getByTestId("poster-title")).toBeInTheDocument();
  });

  it("does not require a photo — it draws the Date Stub instead", () => {
    renderWithProvider(
      <EventCard event={{ ...baseEvent, media: undefined }} testIdBase="noart" />,
    );

    // The objection that sank option A at Gate 5 was "a card with no photo
    // stops reading as anything". It still renders a complete poster — since
    // the Date Stub landed, a MORE complete one: generated artwork carrying the
    // date, the title and the place.
    //
    // The reversed-out scrim and the corner stamp stand down here, because both
    // exist to make a PHOTOGRAPH legible and the stub is not one. So the
    // title moves from `noart-title` into the stub's body; see
    // `EventCardDateStub.test.tsx` for the full contract.
    const stub = screen.getByTestId("noart-date-stub");
    expect(stub.textContent).toContain(baseEvent.title);
    // The title hook travels with the title rather than vanishing with the
    // scrim, so a spec asking for it does not need to know which treatment
    // rendered.
    expect(stub).toContainElement(screen.getByTestId("noart-title"));
  });

  it("puts the price in the corner block and the scarcity on the art", () => {
    renderWithProvider(
      <EventCard event={baseEvent} claimedPercent={72} testIdBase="chr" />,
    );

    expect(screen.getByTestId("chr-price").textContent).toContain("$120");
    expect(screen.getByTestId("chr-status").textContent).toContain(
      "72% claimed",
    );
  });

  it("never prints its own price twice", () => {
    renderWithProvider(
      <EventCard event={baseEvent} claimedPercent={72} testIdBase="once" />,
    );

    // The corner block carries it, so the status line must not repeat it.
    expect(screen.getByTestId("once-status").textContent).not.toContain("$120");
  });

  it("hangs nothing below the art when there is nothing to say", () => {
    const { container } = renderWithProvider(
      <EventCard
        event={{ ...baseEvent, priceLabel: "See details" }}
        testIdBase="bare"
      />,
    );

    // Everything the poster shows is ON the image, so an event with no price,
    // no gate and no scarcity is exactly its art — which is what makes every
    // card in a `grid-auto-rows: 1fr` grid the same height.
    expect(screen.queryByTestId("bare-price")).not.toBeInTheDocument();
    expect(screen.queryByTestId("bare-status")).not.toBeInTheDocument();
    expect(
      container.querySelector('[class*="EventCardPosterChrome"]'),
    ).toBeNull();
  });

  it("keeps sold out at full contrast and drops the claimed share", () => {
    renderWithProvider(
      <EventCard
        event={{ ...baseEvent, soldOut: true }}
        claimedPercent={100}
        testIdBase="gone"
      />,
    );

    expect(screen.getByTestId("gone-price").textContent).toContain("Sold out");
    expect(screen.queryByTestId("gone-status")).not.toBeInTheDocument();
    // Nothing is dimmed — 42% opacity reads as broken, not as unavailable.
    expect((screen.getByTestId("gone") as HTMLElement).style.opacity).toBe("");
  });

  it("stamps the date from the instant, never by re-parsing the display string", () => {
    const { rerender } = renderWithProvider(
      <EventCard
        event={{ ...baseEvent, startsAt: "2025-12-31T20:00:00.000Z" }}
        testIdBase="stamped"
      />,
    );
    // Month and zero-padded day, derived from `startsAt`.
    expect(screen.getByTestId("stamped").textContent).toMatch(/DEC|Dec/);

    // Without an instant there is no stamp — a guessed date is worse than none.
    rerender(
      <EventCard
        event={{ ...baseEvent, startsAt: undefined }}
        testIdBase="stamped"
      />,
    );
    expect(screen.getByTestId("stamped").textContent).not.toMatch(/Dec/);
  });
});

describe("EventCard — variant='ticket'", () => {
  it("still renders the tear, its die-cuts and the serial foot", () => {
    const { container } = renderWithProvider(
      <EventCard event={baseEvent} variant="ticket" testIdBase="ticket" />,
    );

    // The wallet row and the printed PDF are still tickets, so the browse card
    // can still be asked to match them. On web the tear is cut with masked
    // panes (four arc rings, two per pane); native paints two filled holes.
    const cuts =
      container.querySelectorAll("[data-th-cut-arc]").length ||
      container.querySelectorAll("[data-th-punch-hole]").length;
    expect(cuts).toBeGreaterThan(0);
    expect(screen.getByTestId("ticket-foot")).toBeInTheDocument();
    expect(screen.getByTestId("ticket-price").textContent).toContain("$120");
    expect(screen.queryByTestId("ticket-status")).not.toBeInTheDocument();
  });

  it("derives a serial from the id when none is given", () => {
    renderWithProvider(
      <EventCard
        event={{ ...baseEvent, id: "abc123def456" }}
        variant="ticket"
        testIdBase="ticket"
      />,
    );
    expect(screen.getByTestId("ticket-foot").textContent).toContain("DEF456");
  });

  it("does not put a nested control inside the card link", () => {
    renderWithProvider(
      <EventCard event={baseEvent} onPress={() => {}} testIdBase="link" />,
    );

    // The whole card is the link; the old full-width "View details" button was
    // a button inside a link — invalid, and a second tab stop to one place.
    expect(screen.queryByTestId("link-view-btn")).not.toBeInTheDocument();
  });
});

describe("EventGrid — the feature cell", () => {
  it("spans the nominated card and nothing else", () => {
    const events: EventSummary[] = [
      { ...baseEvent, id: "a", title: "First" },
      { ...baseEvent, id: "b", title: "Second" },
    ];
    const { container } = renderWithProvider(
      <EventGrid events={events} featuredEventId="b" testIdBase="g" />,
    );
    expect(
      container.querySelectorAll('[class*="th-egrid-feature"]'),
    ).toHaveLength(1);
  });

  it("spans nothing when no event is nominated", () => {
    const events: EventSummary[] = [
      { ...baseEvent, id: "a", title: "First" },
      { ...baseEvent, id: "b", title: "Second" },
    ];
    const { container } = renderWithProvider(
      <EventGrid events={events} testIdBase="g" />,
    );
    expect(container.querySelector('[class*="th-egrid-feature"]')).toBeNull();
  });

  it("gates the span on the GRID's width, never the viewport's", () => {
    renderWithProvider(
      <EventGrid
        events={[{ ...baseEvent, id: "a" }]}
        featuredEventId="a"
        testIdBase="g"
      />,
    );

    const rule = [...document.querySelectorAll('style[id^="th-egrid-feature"]')]
      .map((s) => s.textContent ?? "")
      .join("");

    // A media query here would be the bug D-096 records: three columns need
    // 864 of CONTENT width, which is a different viewport width depending on
    // gutters, sidebars and nesting.
    expect(rule).toContain("@container");
    expect(rule).not.toContain("@media");
    // Fails safe where container queries are unavailable — a normal cell is
    // always correct; a full-grid poster never is.
    expect(rule).toContain("@supports (container-type: inline-size)");
  });
});
