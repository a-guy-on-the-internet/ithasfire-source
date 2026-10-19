import { screen } from "@testing-library/react";

import { renderWithProvider } from "../../../../../test/utils";
import { RangeCalendar } from "../forms/RangeCalendar";

describe("RangeCalendar", () => {
  it("renders only the active month's days", () => {
    renderWithProvider(
      <RangeCalendar start="2025-01-15" onSelect={vi.fn()} mode="single" />,
    );

    expect(
      screen.getByTestId("range-calendar-day-2025-01-01"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("range-calendar-day-2024-12-31"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("range-calendar-day-2025-02-01"),
    ).not.toBeInTheDocument();
  });
});
