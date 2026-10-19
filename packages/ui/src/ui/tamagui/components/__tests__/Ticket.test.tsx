import { screen } from "@testing-library/react";

import { renderWithProvider } from "../../../../../test/utils";
import { Ticket } from "../events/Ticket";

const base = {
  eventTitle: "Hearth & Howl Music Festival",
  when: "Sat, Aug 15, 2026, 2:00 PM",
  where: "Riverfront Park",
  tier: "General admission",
  code: "HH-8412-2",
};

describe("Ticket", () => {
  describe("the fixed fact set", () => {
    it("renders when / where / tier / holder / seat in that order, always", () => {
      // A ticket whose shape varies per event type stops being recognisable at
      // the door. The order is the contract.
      const { container } = renderWithProvider(
        <Ticket {...base} holder="Dana Whitfield" seat="B12" />,
      );
      const labels = [...container.querySelectorAll("*")]
        .filter((e) => e.children.length === 0)
        .map((e) => e.textContent)
        .filter((t): t is string =>
          ["When", "Where", "Tier", "Holder", "Seat"].includes(t ?? ""),
        );
      expect(labels).toEqual(["When", "Where", "Tier", "Holder", "Seat"]);
    });

    it("omits a fact with no value rather than printing an empty row", () => {
      // `holder` and `seat` are not on the order payload yet. Absence is a
      // missing row, never a blank one.
      renderWithProvider(<Ticket {...base} />);
      expect(screen.getByText("When")).toBeInTheDocument();
      expect(screen.queryByText("Holder")).toBeNull();
      expect(screen.queryByText("Seat")).toBeNull();
    });

    it("keeps the surviving facts in order when a middle one is absent", () => {
      const { container } = renderWithProvider(
        <Ticket {...base} tier={undefined} holder="Dana Whitfield" />,
      );
      const labels = [...container.querySelectorAll("*")]
        .filter((e) => e.children.length === 0)
        .map((e) => e.textContent)
        .filter((t): t is string =>
          ["When", "Where", "Tier", "Holder"].includes(t ?? ""),
        );
      expect(labels).toEqual(["When", "Where", "Holder"]);
    });
  });

  describe("medium is a rendering, not a redesign", () => {
    it("prints the same facts and code on screen and on paper", () => {
      // The whole reason this is one component: an attendee comparing their
      // phone to their printout has to see the same ticket.
      const read = (el: HTMLElement) =>
        (el.textContent ?? "").replace(/\s+/g, " ").trim();

      const { container: s } = renderWithProvider(
        <Ticket {...base} medium="screen" />,
      );
      const screenText = read(s.firstElementChild as HTMLElement);

      const { container: pr } = renderWithProvider(
        <Ticket {...base} medium="print" />,
      );
      expect(read(pr.firstElementChild as HTMLElement)).toBe(screenText);
    });

    it("renders the code larger in print, where it is the read-aloud fallback", () => {
      const codeOf = (c: HTMLElement) =>
        [...c.querySelectorAll("*")].find(
          (e) => e.textContent === base.code && e.children.length === 0,
        ) as HTMLElement | undefined;

      const { container: s } = renderWithProvider(
        <Ticket {...base} medium="screen" />,
      );
      const { container: pr } = renderWithProvider(
        <Ticket {...base} medium="print" />,
      );
      const sSize = parseFloat(getComputedStyle(codeOf(s)!).fontSize || "0");
      const pSize = parseFloat(getComputedStyle(codeOf(pr)!).fontSize || "0");
      expect(pSize).toBeGreaterThan(sSize);
    });
  });

  describe("the QR is a slot, not a dependency", () => {
    it("frames whatever encoder output the app passes", () => {
      renderWithProvider(
        <Ticket {...base} qr={<svg data-testid="real-qr" />} />,
      );
      expect(screen.getByTestId("real-qr")).toBeInTheDocument();
    });

    it("still renders the ticket when no QR is supplied", () => {
      // A ticket with no code is a receipt — it must not crash, so the failure
      // is visible as a missing code rather than a blank page.
      renderWithProvider(<Ticket {...base} qr={undefined} />);
      expect(screen.getByText(base.eventTitle)).toBeInTheDocument();
    });

    it("prints the human-readable code so a scanner failure is recoverable", () => {
      renderWithProvider(<Ticket {...base} />);
      expect(screen.getByText(base.code)).toBeInTheDocument();
    });
  });

  describe("content", () => {
    it("renders the kicker and serial when given", () => {
      renderWithProvider(
        <Ticket {...base} kicker="Music · Festival" serial="001984" />,
      );
      expect(screen.getByText("Music · Festival")).toBeInTheDocument();
      expect(screen.getByText("No. 001984")).toBeInTheDocument();
    });

    it("takes localized fact labels rather than owning copy", () => {
      renderWithProvider(
        <Ticket {...base} whenLabel="Cuándo" whereLabel="Dónde" />,
      );
      expect(screen.getByText("Cuándo")).toBeInTheDocument();
      expect(screen.getByText("Dónde")).toBeInTheDocument();
    });
  });

  describe("the die-cut", () => {
    // NOTE: the holes' geometry — no border, page-coloured fill, stacked above
    // the frame so they interrupt its edge — is NOT asserted here. jsdom does
    // not apply Tamagui's class-based styles, so `getComputedStyle` reports
    // nothing for them and any such assertion would pass while broken. That
    // part is verified in the browser. These tests cover what the DOM can show.
    const holes = (c: HTMLElement) =>
      c.querySelectorAll("[data-th-punch-hole]").length;

    it("cuts two holes on screen", () => {
      const { container } = renderWithProvider(<Ticket {...base} />);
      expect(holes(container)).toBe(2);
    });

    it("still cuts two when the stub stacks beneath the body", () => {
      const { container } = renderWithProvider(<Ticket {...base} stacked />);
      expect(holes(container)).toBe(2);
    });

    it("drops them in print, where they reproduce as grey blobs", () => {
      const { container } = renderWithProvider(
        <Ticket {...base} medium="print" />,
      );
      expect(holes(container)).toBe(0);
    });
  });
});
