import { renderWithProvider } from "../../../../../test/utils";
import { screen, within } from "@testing-library/react";
import { RadioGroup } from "tamagui";

import { Radio, type RadioProps } from "../forms/Radio";

describe("Radio", () => {
  const renderRadio = (props: Partial<RadioProps> = {}) => {
    const { testIdBase = "radio-option", ...restProps } = props;

    return renderWithProvider(
      <RadioGroup value={props.value ?? "option-a"}>
        <Radio
          value="option-a"
          label="Option A"
          testIdBase={testIdBase}
          {...restProps}
        />
      </RadioGroup>,
    );
  };

  it("renders an accessible radio button with label", () => {
    renderRadio();

    const radio = screen.getByRole("radio", { name: "Option A" });
    expect(radio).toBeInTheDocument();
  });

  it("associates description and error messaging", () => {
    renderRadio({
      description: "Helpful context",
      errorMessage: "Selection required",
    });

    const radio = screen.getByRole("radio", { name: "Option A" });
    const description = screen.getByText("Helpful context");
    const error = screen.getByRole("alert");

    expect(description.id).toBeTruthy();
    expect(error.id).toBeTruthy();
    expect(radio).toHaveAttribute(
      "aria-describedby",
      `${description.id} ${error.id}`,
    );
    expect(radio).toHaveAttribute("aria-invalid", "true");
  });

  it("marks required radios and surfaces an indicator", () => {
    renderRadio({ required: true });

    const label = screen.getByTestId("radio-option-label");
    expect(label).toHaveTextContent("Option A*");
    const radio = screen.getByRole("radio", { name: /Option A/ });
    expect(radio).toHaveAttribute("aria-required", "true");
  });

  it("respects automation identifiers for sub-elements", () => {
    renderRadio({ testIdBase: "radio-option" });

    expect(screen.getByTestId("radio-option")).toBeInTheDocument();
    expect(screen.getByTestId("radio-option-frame")).toBeInTheDocument();
    expect(screen.getByTestId("radio-option-indicator")).toBeInTheDocument();
    expect(screen.getByTestId("radio-option-dot")).toBeInTheDocument();
  });

  it("supports custom frame and indicator styling", () => {
    renderRadio({
      testIdBase: "radio-style",
      frameBackgroundColor: "rgb(240, 240, 240)",
      frameBorderColor: "rgb(10, 10, 10)",
      indicatorColor: "rgb(200, 0, 0)",
      value: "option-a",
    });

    const frame = screen.getByTestId("radio-style-frame");
    expect(frame).toHaveStyle({ backgroundColor: "rgb(240, 240, 240)" });
    expect(frame).toHaveStyle({ borderColor: "rgb(10, 10, 10)" });

    const indicator = screen.getByTestId("radio-style-indicator");
    const dot = within(indicator).getByTestId("radio-style-dot");
    expect(dot).toHaveStyle({ backgroundColor: "rgb(200, 0, 0)" });
  });

  it("reflects checked state when group value matches", () => {
    renderRadio({ testIdBase: "radio-checked" });

    const radio = screen.getByRole("radio", { name: "Option A" });
    expect(radio).toHaveAttribute("data-state", "checked");
    expect(radio).toHaveAttribute("aria-checked", "true");
  });

  it("wraps primitive labels with themed text", () => {
    renderRadio({ testIdBase: "radio-themed" });

    // Primitive labels are wrapped in the themed <Text> component, which
    // renders an inline-safe <span> (block display via style) since the
    // Text variant tag change in b9e6ace4 — a <p> inside <label> tripped
    // hydration/nesting issues. Assert the wrapper exists, carries the
    // label copy, and uses the body font from the design system.
    const labelText = screen.getByTestId("radio-themed-label-text");
    expect(labelText.tagName.toLowerCase()).toBe("span");
    expect(labelText).toHaveTextContent("Option A");
    expect(labelText.className).toContain("font_body");
  });

  it("lets the text column shrink and wrap while the square holds its size", () => {
    // Regression: at a 320px viewport a long description held each row at
    // its single-line width (413–440px inside a 300px dialog). Tamagui web
    // stacks default to flex-shrink:0 / min-width:auto, so the text column
    // needs explicit shrink + minWidth:0. jsdom does no layout, so this pins
    // the style contract only — it cannot prove the row actually wraps.
    renderRadio({
      testIdBase: "radio-wrap",
      description: "A draft lands in their admin. They finish the details.",
    });

    const row = screen.getByTestId("radio-wrap");
    const frame = screen.getByTestId("radio-wrap-frame");
    const textColumn = screen.getByTestId("radio-wrap-label").parentElement;

    expect(textColumn).not.toBeNull();
    expect(getComputedStyle(textColumn as HTMLElement).flexShrink).toBe("1");
    expect(getComputedStyle(textColumn as HTMLElement).minWidth).toBe("0px");
    expect(getComputedStyle(row).flexShrink).toBe("1");
    expect(getComputedStyle(row).minWidth).toBe("0px");
    expect(getComputedStyle(frame).flexShrink).toBe("0");
  });
});
