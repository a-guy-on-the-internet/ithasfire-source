import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProvider } from "../../../../../../test/utils";
import { SegmentedControl } from "../SegmentedControl";

const options = [
  { value: "a", label: "A rather long first label" },
  { value: "b", label: "Second" },
];

const renderControl = (props: { fullWidth?: boolean; equalSegments?: boolean }) =>
  renderWithProvider(
    <SegmentedControl
      options={options}
      value="a"
      onChange={() => undefined}
      ariaLabel="Pick one"
      testIdBase="seg"
      {...props}
    />,
  );

const segment = (value: string) => screen.getByTestId(`seg-${value}`);

describe("SegmentedControl equalSegments", () => {
  it("fullWidth alone grows segments from their own width (auto basis), unchanged", () => {
    renderControl({ fullWidth: true });
    for (const v of ["a", "b"]) {
      expect(getComputedStyle(segment(v)).flexGrow).toBe("1");
      expect(getComputedStyle(segment(v)).flexBasis).not.toMatch(/^0(px|%)?$/);
    }
  });

  it("equalSegments splits the row evenly: grow 1 from a zero basis on every segment", () => {
    renderControl({ fullWidth: true, equalSegments: true });
    for (const v of ["a", "b"]) {
      expect(getComputedStyle(segment(v)).flexGrow).toBe("1");
      expect(getComputedStyle(segment(v)).flexBasis).toMatch(/^0(px|%)?$/);
    }
  });

  it("is off by default", () => {
    renderControl({});
    expect(getComputedStyle(segment("a")).flexBasis).not.toMatch(/^0(px|%)?$/);
  });
});
