import { screen } from "@testing-library/react";

import { renderWithProvider } from "../../../../../test/utils";
import { Money } from "../data/Money";
import { DateTime } from "../data/DateTime";

describe("Money", () => {
  describe("the cents contract", () => {
    it("shows cents by default", () => {
      // `always` is the default because the damaging error is the other one: a
      // bare "$45" sitting in a column of "$8.74"s reads as a data bug.
      renderWithProvider(<Money cents={4500} />);
      expect(screen.getByText("$45.00")).toBeInTheDocument();
    });

    it("drops a whole amount's fraction in auto mode", () => {
      renderWithProvider(<Money cents={4500} showCents="auto" />);
      expect(screen.getByText("$45")).toBeInTheDocument();
    });

    it("keeps a fractional amount's cents even in auto mode", () => {
      renderWithProvider(<Money cents={4550} showCents="auto" />);
      expect(screen.getByText("$45.50")).toBeInTheDocument();
    });

    it("accepts bigint, which core money math uses", () => {
      renderWithProvider(<Money cents={4550n} />);
      expect(screen.getByText("$45.50")).toBeInTheDocument();
    });
  });

  describe("zero", () => {
    it("renders $0.00 by default, not FREE", () => {
      // A zero tax row, a zero fee row and a zero refund are all legitimately
      // $0.00. The component cannot tell them apart from a free ticket by
      // looking at the number, so FREE is opt-in.
      renderWithProvider(<Money cents={0} />);
      expect(screen.getByText("$0.00")).toBeInTheDocument();
      expect(screen.queryByText("FREE")).toBeNull();
    });

    it("renders FREE when a price surface asks for it", () => {
      renderWithProvider(<Money cents={0} zero="free" />);
      expect(screen.getByText("FREE")).toBeInTheDocument();
    });

    it("does not treat a non-zero amount as free", () => {
      renderWithProvider(<Money cents={1} zero="free" />);
      expect(screen.getByText("$0.01")).toBeInTheDocument();
    });

    it("takes a translated free label", () => {
      renderWithProvider(<Money cents={0} zero="free" freeLabel="GRATIS" />);
      expect(screen.getByText("GRATIS")).toBeInTheDocument();
    });
  });

  describe("currency and locale", () => {
    it("does not divide by 100 for a zero-decimal currency", () => {
      renderWithProvider(<Money cents={2500} currency="JPY" />);
      expect(screen.getByText("¥2,500")).toBeInTheDocument();
    });
  });

  describe("Money.format", () => {
    it("returns the same string the component renders", () => {
      renderWithProvider(<Money cents={4550} />);
      expect(screen.getByText(Money.format(4550))).toBeInTheDocument();
    });

    it("honours showCents the same way", () => {
      expect(Money.format(4500)).toBe("$45.00");
      expect(Money.format(4500, { showCents: "auto" })).toBe("$45");
    });
  });
});

describe("DateTime", () => {
  // 8pm Central on Aug 19 2026 — already Aug 20 in UTC.
  const showtime = "2026-08-20T01:00:00.000Z";
  const CHICAGO = "America/Chicago";

  it("renders the venue's wall clock", () => {
    renderWithProvider(<DateTime value={showtime} timeZone={CHICAGO} format="time" />);
    expect(screen.getByText("8:00 PM")).toBeInTheDocument();
  });

  it("does not roll a late show onto the next day", () => {
    renderWithProvider(<DateTime value={showtime} timeZone={CHICAGO} format="date" />);
    expect(screen.getByText("Aug 19, 2026")).toBeInTheDocument();
  });

  it("carries the machine-readable instant alongside the local text", () => {
    // The visible string is venue-local and the attribute is the instant. Both
    // are true; a scraper or calendar-detector should get the unambiguous one.
    const { container } = renderWithProvider(
      <DateTime value={showtime} timeZone={CHICAGO} format="time" />,
    );
    const time = container.querySelector("time");
    expect(time).toHaveAttribute("datetime", showtime);
  });

  it("renders nothing rather than 'Invalid Date'", () => {
    const { container } = renderWithProvider(
      <DateTime value="not a date" timeZone={CHICAGO} />,
    );
    expect(container.textContent).toBe("");
  });

  it("DateTime.format matches what the component renders", () => {
    renderWithProvider(<DateTime value={showtime} timeZone={CHICAGO} format="meta" />);
    expect(
      screen.getByText(
        DateTime.format(showtime, "meta", { timeZone: CHICAGO }),
      ),
    ).toBeInTheDocument();
  });
});
