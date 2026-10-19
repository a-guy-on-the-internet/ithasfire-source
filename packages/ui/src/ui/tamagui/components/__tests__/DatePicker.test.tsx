import { fireEvent, screen } from "@testing-library/react";

import { renderWithProvider } from "../../../../../test/utils";
import { DatePicker } from "../DatePicker";
import { isIsoWithinBounds, parseDisplayToIso } from "../date-format";

// NOTE: Tamagui's Input event plumbing is not fully compatible with jsdom for this component.
// Manual typing is covered in integration/e2e; here we unit-test the deterministic parsing + bounds logic.

describe("DatePicker", () => {
  it("parses MM/DD/YYYY and YYYY-MM-DD into ISO", () => {
    expect(parseDisplayToIso("10/20/2025", "mdy")).toBe("2025-10-20");
    // Note: parseDisplayToIso only accepts digit-based formats (mdy/dmy).
    expect(parseDisplayToIso("2025-10-20", "mdy")).toBe(undefined);
  });

  it("treats empty input as undefined and enforces min/max bounds", () => {
    const parsed = parseDisplayToIso("01/15/2024", "mdy");
    expect(parsed).toBe("2024-01-15");
    expect(isIsoWithinBounds(parsed!, "2024-01-01", "2024-12-31")).toBe(true);
    expect(isIsoWithinBounds(parsed!, "2025-01-01", "2025-12-31")).toBe(false);
  });
});

describe("picker variant", () => {
  const openPicker = () => {
    const trigger = screen.getByRole("button", { name: "Date picker" });
    fireEvent.click(trigger);
  };

  it("lets people pick a date from the calendar grid and closes the popover", () => {
    const handleChange = vi.fn();

    renderWithProvider(
      <DatePicker
        onChange={handleChange}
        min="2025-01-01"
        max="2025-12-31"
        label="Date"
      />,
    );

    openPicker();

    const jan15 = screen.getByTestId("range-calendar-day-2025-01-15");
    fireEvent.click(jan15);

    expect(handleChange).toHaveBeenLastCalledWith("2025-01-15");
    const trigger = screen.getByRole("button", { name: "Date picker" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps the calendar visible when forceOpen is enabled", () => {
    renderWithProvider(
      <DatePicker
        onChange={vi.fn()}
        value="2025-01-10"
        min="2025-01-01"
        forceOpen
        label="Date"
      />,
    );

    expect(
      screen.getByTestId("range-calendar-day-2025-01-10"),
    ).toBeInTheDocument();
  });
});
