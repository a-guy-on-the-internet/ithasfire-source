import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RadiusSlider } from "../RadiusSlider";

const slider = () => screen.getByRole("slider") as HTMLInputElement;

describe("RadiusSlider", () => {
  it("is a native range input that keeps caller props", () => {
    render(
      <RadiusSlider
        value={2}
        min={0}
        max={9}
        onChange={() => {}}
        aria-label="Radius"
        data-testid="r"
        style={{ opacity: 0.6 }}
      />,
    );
    expect(slider().type).toBe("range");
    expect(slider().getAttribute("aria-label")).toBe("Radius");
    expect(slider().style.opacity).toBe("0.6");
    expect(slider().className).not.toBe("");
  });

  it.each([
    [0, 0, 8, "0%"],
    [4, 0, 8, "50%"],
    [8, 0, 8, "100%"],
    // A raised floor (venue ceiling) moves `min`; the fill follows it.
    [5, 3, 9, "33.33333333333333%"],
  ])("value %i in [%i, %i] fills %s", (value, min, max, fill) => {
    render(
      <RadiusSlider value={value} min={min} max={max} onChange={() => {}} />,
    );
    expect(slider().style.getPropertyValue("--range-fill")).toBe(fill);
  });

  it("does not divide by zero when min equals max", () => {
    render(<RadiusSlider value={9} min={9} max={9} onChange={() => {}} />);
    expect(slider().style.getPropertyValue("--range-fill")).toBe("0%");
  });
});
