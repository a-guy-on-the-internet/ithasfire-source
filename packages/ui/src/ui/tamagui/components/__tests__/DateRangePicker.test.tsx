import { fireEvent, screen } from "@testing-library/react";

import { renderWithProvider } from "../../../../../test/utils";
import { DateRangePicker } from "../forms/DateRangePicker";

describe("DateRangePicker", () => {
  const openRangePicker = () => {
    const trigger = screen.getByLabelText("Start date to End date");
    fireEvent.click(trigger);
  };

  it("emits normalized start and end values", () => {
    const handleChange = vi.fn();

    renderWithProvider(<DateRangePicker onChange={handleChange} />);

    openRangePicker();
    const startInput = screen.getByLabelText("Start date") as HTMLInputElement;
    const endInput = screen.getByLabelText("End date") as HTMLInputElement;

    fireEvent.change(startInput, { target: { value: "02/10/2025" } });
    fireEvent.change(endInput, { target: { value: "02/14/2025" } });

    expect(handleChange).toHaveBeenLastCalledWith({
      start: "2025-02-10",
      end: "2025-02-14",
    });
  });

  it("drops end value when start exceeds it", () => {
    const handleChange = vi.fn();

    renderWithProvider(
      <DateRangePicker value={{ end: "2025-03-05" }} onChange={handleChange} />,
    );

    openRangePicker();
    const startInput = screen.getByLabelText("Start date") as HTMLInputElement;
    fireEvent.change(startInput, { target: { value: "04/01/2025" } });

    expect(handleChange).toHaveBeenLastCalledWith({ start: "2025-04-01" });
  });

  it("drops start value when end falls before it", () => {
    const handleChange = vi.fn();

    renderWithProvider(
      <DateRangePicker
        value={{ start: "2025-05-15" }}
        onChange={handleChange}
      />,
    );

    openRangePicker();
    const endInput = screen.getByLabelText("End date") as HTMLInputElement;
    fireEvent.change(endInput, { target: { value: "04/20/2025" } });

    expect(handleChange).toHaveBeenLastCalledWith({ end: "2025-04-20" });
  });

  it("syncs manual entry with the calendar selection", () => {
    renderWithProvider(
      <DateRangePicker value={{ end: "2025-03-05" }} onChange={vi.fn()} />,
    );

    openRangePicker();
    const startInput = screen.getByLabelText("Start date") as HTMLInputElement;
    fireEvent.change(startInput, { target: { value: "04/01/2025" } });

    const aprilFirstCells = screen.getAllByTestId(
      "range-calendar-day-2025-04-01",
    );
    expect(
      aprilFirstCells.some(
        (cell) => cell.getAttribute("data-selected") === "true",
      ),
    ).toBe(true);
  });

  it("constrains start max to selected end date", () => {
    const handleChange = vi.fn();

    renderWithProvider(
      <DateRangePicker
        value={{ end: "2025-08-22" }}
        onChange={handleChange}
        min="2025-01-01"
        max="2025-12-31"
      />,
    );

    openRangePicker();
    const startInput = screen.getByLabelText("Start date") as HTMLInputElement;
    fireEvent.change(startInput, { target: { value: "08/21/2025" } });
    expect(handleChange).toHaveBeenLastCalledWith({
      start: "2025-08-21",
      end: "2025-08-22",
    });
    const callCountAfterValid = handleChange.mock.calls.length;

    fireEvent.change(startInput, { target: { value: "09/01/2025" } });
    expect(handleChange).toHaveBeenCalledTimes(callCountAfterValid);
  });

  it("constrains end min to selected start date", () => {
    const handleChange = vi.fn();

    renderWithProvider(
      <DateRangePicker
        value={{ start: "2025-09-01" }}
        onChange={handleChange}
        min="2025-01-01"
        max="2025-12-31"
      />,
    );

    openRangePicker();
    const endInput = screen.getByLabelText("End date") as HTMLInputElement;
    fireEvent.change(endInput, { target: { value: "09/15/2025" } });
    expect(handleChange).toHaveBeenLastCalledWith({
      start: "2025-09-01",
      end: "2025-09-15",
    });
    const callCountAfterValid = handleChange.mock.calls.length;

    fireEvent.change(endInput, { target: { value: "08/01/2025" } });
    expect(handleChange).toHaveBeenCalledTimes(callCountAfterValid);
  });

  it("lets people pick ranges from the calendar grid", () => {
    const handleChange = vi.fn();

    renderWithProvider(
      <DateRangePicker
        onChange={handleChange}
        min="2025-01-01"
        max="2025-12-31"
      />,
    );

    openRangePicker();

    const janStart = screen.getByTestId("range-calendar-day-2025-01-10");
    const janEnd = screen.getByTestId("range-calendar-day-2025-01-15");

    fireEvent.click(janStart);
    fireEvent.click(janEnd);

    expect(handleChange).toHaveBeenLastCalledWith({
      start: "2025-01-10",
      end: "2025-01-15",
    });
  });

  it("supports european date entry", () => {
    const handleChange = vi.fn();

    renderWithProvider(
      <DateRangePicker onChange={handleChange} displayFormat="single" />,
    );

    openRangePicker();
    const startInput = screen.getByLabelText("Start date") as HTMLInputElement;
    fireEvent.change(startInput, { target: { value: "20/10/2025" } });

    expect(handleChange).toHaveBeenLastCalledWith({ start: "2025-10-20" });
    expect(startInput).toHaveValue("20/10/2025");
  });

  it("keeps calendars visible when forceOpen is enabled", () => {
    renderWithProvider(
      <DateRangePicker
        onChange={vi.fn()}
        value={{ start: "2025-01-10" }}
        min="2025-01-01"
        forceOpen
      />,
    );

    expect(
      screen.getByTestId("range-calendar-day-2025-01-10"),
    ).toBeInTheDocument();
  });

  it("syncs the month column to the provided start value", () => {
    renderWithProvider(
      <DateRangePicker
        onChange={vi.fn()}
        value={{ start: "2025-08-15" }}
        forceOpen
      />,
    );

    const monthHeaders = screen.getAllByText("August 2025");
    expect(monthHeaders.length).toBeGreaterThan(0);
  });
});
