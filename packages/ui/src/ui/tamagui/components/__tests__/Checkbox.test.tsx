import { renderWithProvider } from "../../../../../test/utils";
import { screen } from "@testing-library/react";

import { Checkbox, type CheckboxProps } from "../forms/Checkbox";

describe("Checkbox", () => {
  const renderCheckbox = (props: Partial<CheckboxProps> = {}) => {
    const { testIdBase = "checkbox-option", ...restProps } = props;

    return renderWithProvider(
      <Checkbox label="Accept terms" testIdBase={testIdBase} {...restProps} />,
    );
  };

  it("renders an accessible checkbox with label", () => {
    renderCheckbox();

    const checkbox = screen.getByRole("checkbox", { name: "Accept terms" });
    expect(checkbox).toBeInTheDocument();
  });

  it("associates description and error messaging", () => {
    renderCheckbox({
      description: "Additional context",
      errorMessage: "Selection required",
    });

    const checkbox = screen.getByRole("checkbox", { name: "Accept terms" });
    const description = screen.getByText("Additional context");
    const error = screen.getByRole("alert");

    expect(description.id).toBeTruthy();
    expect(error.id).toBeTruthy();
    expect(checkbox).toHaveAttribute(
      "aria-describedby",
      `${description.id} ${error.id}`,
    );
    expect(checkbox).toHaveAttribute("aria-invalid", "true");
  });

  it("announces required via aria-required without drawing a marker", () => {
    renderCheckbox({ required: true });

    // Design system v2 marks OPTIONAL fields, not required ones — the
    // asterisk ornament is gone; the requirement lives in ARIA only.
    const label = screen.getByTestId("checkbox-option-label");
    expect(label).toHaveTextContent("Accept terms");
    expect(label.textContent).not.toContain("*");
    const checkbox = screen.getByRole("checkbox", { name: /Accept terms/ });
    expect(checkbox).toHaveAttribute("aria-required", "true");
  });

  it("respects automation identifiers for sub-elements", () => {
    renderCheckbox({ testIdBase: "checkbox-option", checked: true });

    expect(screen.getByTestId("checkbox-option")).toBeInTheDocument();
    expect(screen.getByTestId("checkbox-option-frame")).toBeInTheDocument();
    expect(screen.getByTestId("checkbox-option-indicator")).toBeInTheDocument();
    expect(screen.getByTestId("checkbox-option-label")).toBeInTheDocument();
  });

  it("supports custom frame and indicator styling", () => {
    renderCheckbox({
      testIdBase: "checkbox-style",
      frameBackgroundColor: "rgb(240, 240, 240)",
      frameBorderColor: "rgb(10, 10, 10)",
      indicatorBackgroundColor: "rgb(200, 0, 0)",
      checked: true,
    });

    const frame = screen.getByTestId("checkbox-style-frame");
    expect(frame).toHaveStyle({ backgroundColor: "rgb(240, 240, 240)" });
    expect(frame).toHaveStyle({ borderTopColor: "rgb(10, 10, 10)" });

    const indicator = screen.getByTestId("checkbox-style-indicator");
    expect(indicator).toHaveStyle({ backgroundColor: "rgb(200, 0, 0)" });
  });

  /**
   * The frame is a `<button role="checkbox">` — a LABELABLE element — so a
   * consumer that also wraps its own `<label htmlFor>` around visible text
   * (the owner suggestion inbox's select-all does exactly this, to keep the
   * text clickable while the box sits in a separate grid cell) associates
   * TWO labels with one control. Per AccName those normally concatenate:
   * Chromium computes "Select all Select all" for that markup.
   *
   * It does not happen here only because Tamagui's Label↔control wiring
   * emits an `aria-labelledby` on the frame at runtime — nothing in
   * forms/Checkbox.tsx writes one, which is exactly why this is easy to
   * "fix" away by accident. AccName step 2A takes that and never consults
   * the native labels.
   *
   * If this assertion ever fails, every consumer relying on a second
   * `<label for>` must switch to an explicit `aria-labelledby`.
   */
  it("names itself via aria-labelledby, so a second <label for> cannot double the name", () => {
    renderWithProvider(
      <>
        <Checkbox id="dup-name" label="Select all" testIdBase="dup-name" />
        <label htmlFor="dup-name">Select all</label>
      </>,
    );

    const frame = screen.getByTestId("dup-name-frame");
    const labelledBy = frame.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    // …and it points at the component's OWN label, not the outer one.
    expect(document.getElementById(labelledBy!)).toBe(
      screen.getByTestId("dup-name-label"),
    );
    // Name resolves once. (getByRole's name filter runs the same AccName
    // implementation testing-library uses everywhere.)
    expect(
      screen.getByRole("checkbox", { name: "Select all" }),
    ).toBeInTheDocument();
  });

  it("wraps primitive labels with themed text", () => {
    renderCheckbox({ testIdBase: "checkbox-themed" });

    // Primitive labels are wrapped in the themed <Text> component, which
    // renders an inline-safe <span> (block display via style) since the
    // Text variant tag change in b9e6ace4 — a <p> inside <label> tripped
    // hydration/nesting issues. Assert the wrapper exists, carries the
    // label copy, and uses the body font from the design system.
    const labelText = screen.getByTestId("checkbox-themed-label-text");
    expect(labelText.tagName.toLowerCase()).toBe("span");
    expect(labelText).toHaveTextContent("Accept terms");
    expect(labelText.className).toContain("font_body");
  });
});
