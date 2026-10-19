import { fireEvent, screen } from "@testing-library/react";
import { vi } from "vitest";

import { renderWithProvider } from "../../../../../test/utils";
import { TicketStub } from "../events/TicketStub";

const baseProps = {
  date: { month: "Aug", day: "02", weekday: "Sun" },
  category: "Food & Drink",
  title: "Smoke & Ember BBQ Cookoff",
  where: "Franklin Fairgrounds · 12:00 PM",
  price: { amount: "FREE", label: "RSVP", free: true },
  testId: "ticket-stub",
} as const;

describe("TicketStub", () => {
  it("renders date, category, title, where-line, and price", () => {
    renderWithProvider(<TicketStub {...baseProps} />);

    expect(screen.getByTestId("ticket-stub")).toBeTruthy();
    expect(screen.getByText("Aug")).toBeTruthy();
    expect(screen.getByText("02")).toBeTruthy();
    expect(screen.getByText("Sun")).toBeTruthy();
    expect(screen.getByText("Food & Drink")).toBeTruthy();
    expect(screen.getByText("Smoke & Ember BBQ Cookoff")).toBeTruthy();
    expect(screen.getByText("Franklin Fairgrounds · 12:00 PM")).toBeTruthy();
    expect(screen.getByText("FREE")).toBeTruthy();
    expect(screen.getByText("RSVP")).toBeTruthy();
  });

  it("renders the claimed footer only when claimedPercent > 0", () => {
    const { unmount } = renderWithProvider(
      <TicketStub {...baseProps} claimedPercent={88} />,
    );
    expect(screen.getByTestId("ticket-stub-claimed")).toBeTruthy();
    expect(screen.getByText("88% claimed")).toBeTruthy();
    unmount();

    renderWithProvider(<TicketStub {...baseProps} claimedPercent={0} />);
    expect(screen.queryByTestId("ticket-stub-claimed")).toBeNull();
  });

  it("hides the claimed footer by default", () => {
    renderWithProvider(<TicketStub {...baseProps} />);
    expect(screen.queryByTestId("ticket-stub-claimed")).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("is a labelled link when pressable", () => {
    const onPress = vi.fn();
    renderWithProvider(<TicketStub {...baseProps} onPress={onPress} />);

    const stub = screen.getByRole("link", {
      name: "Smoke & Ember BBQ Cookoff",
    });
    fireEvent.click(stub);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("renders as a real anchor when href is provided (web)", () => {
    renderWithProvider(<TicketStub {...baseProps} href="/events/smoke" />);

    const stub = screen.getByTestId("ticket-stub");
    expect(stub.tagName).toBe("A");
    expect(stub.getAttribute("href")).toBe("/events/smoke");
  });

  it("bounds the price column so a long price cannot spill past the border", () => {
    // Measured at 320px: with an unbounded `flexShrink: 0` column, "$1,234.56+"
    // over a long localised label made a 231px block that ran 63px past the
    // stub's right edge. The column caps at 45% and clips; the block shrinks
    // into it so the label wraps, and it must NOT be pinned to one line.
    renderWithProvider(
      <TicketStub
        {...baseProps}
        price={{
          amount: "$1,234.56+",
          label: "Desde el precio de entrada",
          free: false,
        }}
      />,
    );
    const block = screen
      .getByText("$1,234.56+")
      .closest(".is_PriceBlock") as HTMLElement;
    const column = block.parentElement as HTMLElement;
    expect(column.className).toContain("is_TicketStubPriceColumn");
    // Tamagui hashes a percentage into the class name, so read the resolved
    // style rather than the class.
    expect(getComputedStyle(column).maxWidth).toBe("45%");
    expect(getComputedStyle(column).overflowX).toBe("hidden");
    expect(getComputedStyle(block).flexShrink).toBe("1");
    expect(screen.getByText("Desde el precio de entrada")).not.toHaveStyle({
      whiteSpace: "nowrap",
    });
  });

  it("is not interactive without onPress/href", () => {
    renderWithProvider(<TicketStub {...baseProps} />);
    expect(screen.queryByRole("link")).toBeNull();
  });
});
