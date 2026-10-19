import { screen } from "@testing-library/react";

import { renderWithProvider } from "../../../../../test/utils";
import { colorTokens } from "../../tokens/colors";
import { Separator } from "../display/Separator";

const hexToCssColor = (hex: string) => {
  const normalized = hex.replace("#", "");
  const hasAlpha = normalized.length === 8;
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  if (!hasAlpha) {
    return `rgb(${r}, ${g}, ${b})`;
  }
  const alpha = parseInt(normalized.slice(6, 8), 16) / 255;
  if (alpha === 1) {
    return `rgb(${r}, ${g}, ${b})`;
  }
  return `rgba(${r}, ${g}, ${b}, ${Number(alpha.toFixed(3))})`;
};

describe("Separator", () => {
  it("renders a horizontal rule with border tokens by default", () => {
    renderWithProvider(<Separator testId="separator-default" />);

    const separator = screen.getByTestId("separator-default");
    expect(separator.className).toContain("_bg-borderColor");
    expect(separator).toHaveStyle({ width: "100%", height: "1px" });
  });

  it("supports vertical orientation", () => {
    renderWithProvider(
      <Separator
        orientation="vertical"
        height={72}
        testId="separator-vertical"
      />,
    );

    const separator = screen.getByTestId("separator-vertical");
    expect(separator).toHaveStyle({ height: "72px" });
  });

  it("accepts palette tokens for background color", () => {
    renderWithProvider(
      <Separator colorToken="accent" testId="separator-accent" />,
    );

    const separator = screen.getByTestId("separator-accent");
    const computed = getComputedStyle(separator);
    const expectedColor = hexToCssColor(colorTokens.color.accent);
    expect(computed.backgroundColor).toBe(expectedColor);
  });
});
