import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@th/ui", () => ({
  Button: ({
    children,
    onPress,
  }: {
    children?: ReactNode;
    onPress?: () => void;
  }) => (
    <button type="button" onClick={() => onPress?.()}>
      {children}
    </button>
  ),
  // Forwards the two layout props the kicker numeral depends on as inline
  // style, so a test can see that the component passes them. This is a mock:
  // it shows what HostConvertBand hands to Text, not what Tamagui emits.
  Text: ({
    children,
    "aria-hidden": ariaHidden,
    flexShrink,
    whiteSpace,
  }: {
    children?: ReactNode;
    "aria-hidden"?: boolean;
    flexShrink?: number;
    whiteSpace?: "nowrap";
  }) => (
    <span aria-hidden={ariaHidden} style={{ flexShrink, whiteSpace }}>
      {children}
    </span>
  ),
  useTranslations: () => (key: string) => key,
}));

import { HostConvertBand } from "../HostConvertBand";

const HEADLINE = /honesty and transparency is the floor\./i;

describe("HostConvertBand", () => {
  const onCreateEvent = vi.fn();

  beforeEach(() => {
    onCreateEvent.mockClear();
  });

  it("renders the pitch headline, support copy, and labelled region", () => {
    render(<HostConvertBand sectionNumber={4} onCreateEvent={onCreateEvent} />);

    expect(
      screen.getByRole("heading", { level: 2, name: HEADLINE }),
    ).toBeInTheDocument();
    // Fees are always on top of the ticket price (ABSORB removed,
    // docs/decisions/absorb-removed.md) — the copy says so, and never claims
    // the poster price is the checkout price. The apostrophe is the
    // typographic one the source writes as `&rsquo;`.
    expect(
      screen.getByText(
        /^Fees go on top of your ticket price, and the buyer sees each one before they pay\. You’re credited the full ticket price\. Setting up is free\.$/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/price at checkout/i)).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: HEADLINE })).toBeInTheDocument();
  });

  it("renders the zero-padded kicker numeral (aria-hidden) with the audience label", () => {
    render(<HostConvertBand sectionNumber={4} onCreateEvent={onCreateEvent} />);

    const numeral = screen.getByText("04.");
    expect(numeral).toHaveAttribute("aria-hidden", "true");
    // At 320px the label wraps to two lines; the numeral must neither shrink
    // nor break before its full stop.
    expect(numeral.style.whiteSpace).toBe("nowrap");
    expect(numeral.style.flexShrink).toBe("0");
    expect(
      screen.getByText("FOR THE PEOPLE WHO MAKE THE NIGHT"),
    ).toBeInTheDocument();
  });

  it("omits the index numeral when sectionNumber is absent", () => {
    render(<HostConvertBand onCreateEvent={onCreateEvent} />);

    expect(screen.queryByText(/^\d{2}\.$/)).not.toBeInTheDocument();
    expect(
      screen.getByText("FOR THE PEOPLE WHO MAKE THE NIGHT"),
    ).toBeInTheDocument();
  });

  it("names the three audiences as an unordered list with no step numerals", () => {
    render(<HostConvertBand sectionNumber={4} onCreateEvent={onCreateEvent} />);

    const list = screen.getByRole("list");
    expect(list.tagName).toBe("UL");
    expect(screen.getAllByRole("listitem")).toHaveLength(3);

    expect(screen.getByText("Performers")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Know the room before you say yes. A place’s page shows who has played there and, once enough performers have reviewed it, what they reported, anonymously.",
      ),
    ).toBeInTheDocument();
    // "Places", per CONTEXT.md: never "Venues" in copy (owner ruling), and not
    // "Rooms" either, since a room is a space INSIDE a place.
    expect(screen.getByText("Places")).toBeInTheDocument();
    expect(screen.queryByText("Venues")).not.toBeInTheDocument();
    expect(screen.queryByText("Rooms")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "A free calendar for your own website, whether or not you sell tickets with us. Your track record is built from the shows you host, and nobody can buy one.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Weekly nights")).toBeInTheDocument();
    expect(
      screen.getByText("List it free. It shows in search and on the map."),
    ).toBeInTheDocument();

    // Order is part of the copy: performers, then places, then weekly nights.
    expect(
      screen
        .getAllByRole("listitem")
        .map((item) => item.querySelector("p")?.textContent),
    ).toEqual(["Performers", "Places", "Weekly nights"]);

    // Audiences are not a sequence: no 01/02/03 ornament.
    for (const num of ["01", "02", "03"]) {
      expect(screen.queryByText(num)).not.toBeInTheDocument();
    }
  });

  it("fires onCreateEvent from the CTA (label reuses home.createAnEvent)", async () => {
    const user = userEvent.setup();
    render(<HostConvertBand sectionNumber={4} onCreateEvent={onCreateEvent} />);

    await user.click(
      screen.getByRole("button", { name: /home\.createAnEvent/ }),
    );
    expect(onCreateEvent).toHaveBeenCalledTimes(1);
  });
});
