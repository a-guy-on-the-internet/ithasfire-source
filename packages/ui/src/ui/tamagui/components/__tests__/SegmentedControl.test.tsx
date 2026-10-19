import { fireEvent, screen } from "@testing-library/react";
import { vi } from "vitest";

import { renderWithProvider } from "../../../../../test/utils";
import {
  SegmentedControl,
  type SegmentedControlOption,
} from "../display/SegmentedControl";

type Scope = "all" | "upcoming" | "past";
const options: SegmentedControlOption<Scope>[] = [
  { value: "all", label: "All" },
  { value: "upcoming", label: "Upcoming" },
  { value: "past", label: "Past" },
];

describe("SegmentedControl", () => {
  it("renders a radiogroup with one radio per option", () => {
    renderWithProvider(
      <SegmentedControl
        options={options}
        value="all"
        onChange={vi.fn()}
        ariaLabel="Scope"
      />,
    );
    expect(screen.getByRole("radiogroup", { name: "Scope" })).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
  });

  it("marks the selected option aria-checked", () => {
    renderWithProvider(
      <SegmentedControl
        options={options}
        value="upcoming"
        onChange={vi.fn()}
      />,
    );
    const upcoming = screen.getByRole("radio", { name: "Upcoming" });
    expect(upcoming.getAttribute("aria-checked")).toBe("true");
    expect(
      screen.getByRole("radio", { name: "All" }).getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("fires onChange with the option value on press", () => {
    const onChange = vi.fn();
    renderWithProvider(
      <SegmentedControl
        options={options}
        value="all"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Past" }));
    expect(onChange).toHaveBeenCalledWith("past");
  });

  it("does not fire onChange when the already-selected option is pressed", () => {
    const onChange = vi.fn();
    renderWithProvider(
      <SegmentedControl
        options={options}
        value="all"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "All" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("uses roving tabindex (only the selected radio is tabbable)", () => {
    renderWithProvider(
      <SegmentedControl options={options} value="upcoming" onChange={vi.fn()} />,
    );
    expect(
      screen.getByRole("radio", { name: "Upcoming" }).getAttribute("tabindex"),
    ).toBe("0");
    expect(
      screen.getByRole("radio", { name: "All" }).getAttribute("tabindex"),
    ).toBe("-1");
  });

  it("moves selection with ArrowRight (keyboard operable)", () => {
    const onChange = vi.fn();
    renderWithProvider(
      <SegmentedControl options={options} value="all" onChange={onChange} />,
    );
    fireEvent.keyDown(screen.getByRole("radiogroup"), { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("upcoming");
  });

  it("wraps to the last option with ArrowLeft from the first", () => {
    const onChange = vi.fn();
    renderWithProvider(
      <SegmentedControl options={options} value="all" onChange={onChange} />,
    );
    fireEvent.keyDown(screen.getByRole("radiogroup"), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenCalledWith("past");
  });

  it("blocks interaction and sets aria-disabled when disabled", () => {
    const onChange = vi.fn();
    renderWithProvider(
      <SegmentedControl
        options={options}
        value="all"
        onChange={onChange}
        disabled
      />,
    );
    expect(
      screen.getByRole("radiogroup").getAttribute("aria-disabled"),
    ).toBe("true");
    fireEvent.keyDown(screen.getByRole("radiogroup"), { key: "ArrowRight" });
    expect(onChange).not.toHaveBeenCalled();
  });
});
