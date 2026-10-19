import { screen } from "@testing-library/react";

import { renderWithProvider } from "../../../../../test/utils";
import { EventCard, type EventSummary } from "../event-grid";

/**
 * The Date Stub on the browse card.
 *
 * `EventCard`'s default variant is `poster`, and nothing in the product passes
 * `ticket` — so the poster path is the one that actually ships, and these tests
 * exercise it first. The invariant worth the most is narrow and sharp: **a
 * generated stub must never displace a real poster.** An organiser who uploaded
 * artwork and then saw a two-tone graphic would reasonably conclude the upload
 * was lost.
 */

const BASE: EventSummary = {
  id: "evt-1",
  title: "Comedy Night at Larry's",
  // The card's own display label, formatted upstream. The stub must agree with
  // it, which is why both come from ONE derivation off `startsAt`.
  date: "Thu, Sep 10, 6:30 PM",
  venue: "Larry's, Nashville, TN",
  priceLabel: "$15.00",
  startsAt: "2026-09-10T12:00:00.000Z",
  timezone: "UTC",
};

const stubOf = (id: string) =>
  screen.queryByTestId(`event-card-${id}-date-stub`);

describe("EventCard — Date Stub fallback", () => {
  it("renders the stub, in the artifact's order, when the event has no poster", () => {
    renderWithProvider(<EventCard event={BASE} />);

    const stub = stubOf("evt-1");
    expect(stub).not.toBeNull();

    const text = stub?.textContent ?? "";
    expect(text.indexOf("THU")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("10")).toBeGreaterThan(text.indexOf("THU"));
    expect(text.indexOf("SEP")).toBeGreaterThan(text.indexOf("10"));
  });

  it("NEVER displaces a real poster", () => {
    renderWithProvider(
      <EventCard
        event={{
          ...BASE,
          id: "evt-2",
          media: {
            url: "https://cdn.example.test/poster.jpg",
            alt: "Comedy Night poster",
          },
        }}
      />,
    );

    const posters = screen.getAllByRole("img", { name: "Comedy Night poster" });
    expect(
      posters.some(
        (node) =>
          node.getAttribute("src") === "https://cdn.example.test/poster.jpg",
      ),
    ).toBe(true);
    expect(stubOf("evt-2")).toBeNull();
  });

  it("takes over the poster's own chrome rather than stacking under it", () => {
    // The corner date stamp and the reversed-out scrim exist to make a
    // PHOTOGRAPH legible. Over the stub they would print the date twice and put
    // on-dark ink over a paper panel, so both stand down — and the stub
    // inherits what they were saying.
    renderWithProvider(
      <EventCard
        event={{ ...BASE, id: "evt-5", gateType: "PASSWORD", isRecurring: true }}
      />,
    );

    const stub = stubOf("evt-5");
    expect(stub).not.toBeNull();
    // The status line the scrim was carrying is still on the card.
    expect(stub?.textContent).toMatch(/password/i);
    expect(stub?.textContent).toMatch(/recurring/i);
    // ...and it is not ALSO in a scrim, because there is no scrim.
    expect(
      screen.queryByTestId("event-card-evt-5-status"),
    ).not.toBeInTheDocument();
  });

  it("keeps the poster's accessibility surface unchanged: column hidden, body not", () => {
    renderWithProvider(<EventCard event={BASE} />);

    const stub = stubOf("evt-1");
    // The poster renders NO body content, so hiding the whole stub would leave
    // the card with nothing. The body stays announceable.
    expect(stub).not.toHaveAttribute("aria-hidden");
    expect(
      screen.getByText("Comedy Night at Larry's").closest("[aria-hidden]"),
    ).toBeNull();
    // The date column is a graphic, hidden the same way `PosterStamp` already
    // is — a poster card announces its time through the meta line, never
    // "THU" / "10" / "SEP" as three fragments.
    expect(screen.getByText("THU").closest('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.getByText("SEP").closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it("says TBA rather than guessing when the card carries no instant", () => {
    renderWithProvider(
      <EventCard event={{ ...BASE, id: "evt-3", startsAt: undefined }} />,
    );
    expect(stubOf("evt-3")?.textContent).toContain("TBA");
  });

  describe("dense list row", () => {
    it("tears the stub down to its date column in the 80px thumbnail", () => {
      // At a 320px viewport the browse grid resolves to this layout, so this is
      // the listing card most phone readers actually see. It replaced an empty
      // `$surfaceMuted` panel a quarter of the row wide.
      renderWithProvider(
        <EventCard event={{ ...BASE, id: "evt-9" }} layout="horizontal" dense />,
      );

      const stub = stubOf("evt-9");
      expect(stub?.textContent).toBe("THU10SEP");
      // Fully decorative here: the row prints title, date and venue as real
      // text inches to the right.
      expect(stub).toHaveAttribute("aria-hidden", "true");
      expect(screen.getByText("Thu, Sep 10, 6:30 PM")).toBeInTheDocument();
    });
  });

  describe("ticket variant", () => {
    it("renders the stub and agrees with the date label the body prints", () => {
      renderWithProvider(
        <EventCard event={{ ...BASE, id: "evt-6" }} variant="ticket" />,
      );

      const stub = stubOf("evt-6");
      expect(stub?.textContent).toContain("THU");
      expect(stub?.textContent).toContain("10");
      // Both read the same instant through the same derivation. A stub saying
      // SEP 11 above a meta line saying Sep 10 is the D-100 trap; nothing about
      // this card should be able to produce it.
      expect(screen.getByText("Thu, Sep 10, 6:30 PM")).toBeInTheDocument();
    });

    it("is fully decorative — the body below already prints all three fields", () => {
      renderWithProvider(
        <EventCard event={{ ...BASE, id: "evt-7" }} variant="ticket" />,
      );

      expect(stubOf("evt-7")).toHaveAttribute("aria-hidden", "true");
      // Exactly one title reaches the accessibility tree, not two.
      expect(
        screen
          .getAllByText("Comedy Night at Larry's")
          .filter((n) => n.closest('[aria-hidden="true"]') === null),
      ).toHaveLength(1);
    });

    it("stays MOUNTED under a real poster so a 404'd upload still degrades to it", () => {
      renderWithProvider(
        <EventCard
          event={{
            ...BASE,
            id: "evt-8",
            media: {
              url: "https://cdn.example.test/poster.jpg",
              alt: "Comedy Night poster",
            },
          }}
          variant="ticket"
        />,
      );

      const stub = stubOf("evt-8");
      expect(stub).not.toBeNull();
      const poster = screen
        .getAllByRole("img", { name: "Comedy Night poster" })
        .find(
          (node) =>
            node.getAttribute("src") === "https://cdn.example.test/poster.jpg",
        );
      expect(poster).toBeDefined();
      // Painted UNDER the image, never over it.
      expect(
        (poster as HTMLElement).compareDocumentPosition(stub as Node) &
          Node.DOCUMENT_POSITION_PRECEDING,
      ).toBeTruthy();
    });
  });
});
