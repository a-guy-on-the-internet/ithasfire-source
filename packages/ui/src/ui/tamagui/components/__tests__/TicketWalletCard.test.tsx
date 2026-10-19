import { screen } from "@testing-library/react";

import { renderWithProvider } from "../../../../../test/utils";
import { TicketWalletCard } from "../events/TicketWalletCard";

const base = {
  month: "Aug",
  day: "15",
  weekday: "Sat",
  eventTitle: "Hearth & Howl Music Festival",
  href: "/my-tickets/8412",
};

describe("TicketWalletCard", () => {
  describe("the stack-of-tickets identity", () => {
    it("carries the DateBlock so the row reads as a ticket, not a link", () => {
      renderWithProvider(<TicketWalletCard {...base} />);
      // The three parts of the torn-off date column.
      expect(screen.getByText("Aug")).toBeInTheDocument();
      expect(screen.getByText("15")).toBeInTheDocument();
      expect(screen.getByText("Sat")).toBeInTheDocument();
    });

    it("joins the meta line with middots and drops the gaps", () => {
      // A missing venue must close the gap, not leave a stranded separator.
      renderWithProvider(
        <TicketWalletCard
          {...base}
          meta={["Riverfront Park", null, "2 tickets", undefined, "$45.00"]}
        />,
      );
      expect(
        screen.getByText("Riverfront Park · 2 tickets · $45.00"),
      ).toBeInTheDocument();
    });

    it("renders no meta element at all when there is nothing to say", () => {
      renderWithProvider(<TicketWalletCard {...base} meta={[null, false]} />);
      expect(screen.queryByText("·")).toBeNull();
    });
  });

  describe("the affordance — one thing, never two", () => {
    it("shows the QR glyph for a live ticket", () => {
      renderWithProvider(<TicketWalletCard {...base} qrLabel="Show ticket" />);
      expect(
        screen.getByRole("img", { name: "Show ticket" }),
      ).toBeInTheDocument();
    });

    it("replaces the glyph with the badge rather than showing both", () => {
      // A QR beside a "Refunded" badge invites someone to present a ticket
      // that will not scan.
      renderWithProvider(
        <TicketWalletCard
          {...base}
          qrLabel="Show ticket"
          badge={<span>Refunded</span>}
        />,
      );
      expect(screen.getByText("Refunded")).toBeInTheDocument();
      expect(screen.queryByRole("img", { name: "Show ticket" })).toBeNull();
    });
  });

  describe("spent tickets", () => {
    it("keeps a spent ticket in the wallet at full opacity", () => {
      // Dimming reads as broken rather than as spent, and people come back
      // looking for proof they attended.
      const { container } = renderWithProvider(
        <TicketWalletCard {...base} spent badge={<span>Past</span>} />,
      );
      expect(screen.getByText(base.eventTitle)).toBeInTheDocument();
      const frame = container.firstElementChild as HTMLElement;
      const opacity = getComputedStyle(frame).opacity;
      expect(opacity === "" || opacity === "1").toBe(true);
    });
  });

  describe("accessibility", () => {
    it("makes the TITLE the link, so actions are not nested inside an anchor", () => {
      // The card this replaced wrapped everything in a <Link> and then nested
      // <Button>s inside it — invalid markup, and the reason every action had
      // to stopPropagation.
      const { container } = renderWithProvider(
        <TicketWalletCard
          {...base}
          actions={<button type="button">View event</button>}
        />,
      );
      const link = screen.getByRole("link", { name: base.eventTitle });
      expect(link).toHaveAttribute("href", base.href);

      const action = screen.getByRole("button", { name: "View event" });
      expect(link.contains(action)).toBe(false);
      expect(container.querySelectorAll("a").length).toBe(1);
    });

    it("gives the link the stretched-link class that restores the row hit area", () => {
      renderWithProvider(<TicketWalletCard {...base} />);
      expect(
        screen.getByRole("link", { name: base.eventTitle }),
      ).toHaveClass("th-wallet-link");
    });

    it("takes an explicit link label when the title alone is ambiguous", () => {
      renderWithProvider(
        <TicketWalletCard {...base} linkLabel="Hearth & Howl — 2 tickets" />,
      );
      expect(
        screen.getByRole("link", { name: "Hearth & Howl — 2 tickets" }),
      ).toBeInTheDocument();
    });
  });
});
