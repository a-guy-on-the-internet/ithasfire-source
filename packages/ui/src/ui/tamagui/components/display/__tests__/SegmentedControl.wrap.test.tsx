import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProvider } from "../../../../../../test/utils";
import { SegmentedControl } from "../SegmentedControl";

const options = [
  { value: "a", label: "A rather long first label" },
  { value: "b", label: "Second" },
];

const renderControl = (wrap?: boolean) =>
  renderWithProvider(
    <SegmentedControl
      options={options}
      value="a"
      onChange={() => undefined}
      ariaLabel="Pick one"
      testIdBase="seg"
      {...(wrap === undefined ? {} : { wrap })}
    />,
  );

const row = () => screen.getByRole("radiogroup");
const segment = (value: string) => screen.getByTestId(`seg-${value}`);
const label = (value: string) =>
  segment(value).querySelector("span") as HTMLElement;

describe("SegmentedControl wrap", () => {
  it("is unchanged by default: one line, segments joined from the second", () => {
    renderControl();
    expect(getComputedStyle(row()).flexWrap).not.toBe("wrap");
    expect(getComputedStyle(segment("a")).marginLeft).not.toBe("-2px");
    expect(getComputedStyle(segment("b")).marginLeft).toBe("-2px");
    expect(getComputedStyle(segment("b")).flexShrink).not.toBe("1");
    expect(label("a").style.overflowWrap).toBe("");
  });

  it("wrap={false} matches the default", () => {
    renderControl(false);
    expect(getComputedStyle(row()).flexWrap).not.toBe("wrap");
    expect(getComputedStyle(segment("a")).marginLeft).not.toBe("-2px");
  });

  it("wrap lets the row and the labels wrap and squares up each line", () => {
    renderControl(true);
    expect(getComputedStyle(row()).flexWrap).toBe("wrap");
    expect(getComputedStyle(row()).paddingLeft).toBe("2px");
    // Every segment, the first included, takes the −2px so each wrapped
    // line's first border lands on the container edge.
    expect(getComputedStyle(segment("a")).marginLeft).toBe("-2px");
    expect(getComputedStyle(segment("b")).marginLeft).toBe("-2px");
    expect(getComputedStyle(segment("a")).flexShrink).toBe("1");
    expect(getComputedStyle(segment("a")).minWidth).toBe("0px");
    expect(label("a").style.overflowWrap).toBe("anywhere");
  });
});
