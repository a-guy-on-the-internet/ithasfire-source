import { describe, expect, it } from "vitest";

import { contrastRatio, themeColorLuminance } from "../theme-color-luminance";

describe("themeColorLuminance", () => {
  it("measures black and white at the WCAG ends", () => {
    expect(themeColorLuminance("#000")).toBe(0);
    expect(themeColorLuminance("#ffffff")).toBe(1);
  });

  it.each([
    "#3B82F6",
    "#3b82f6cc",
    "#38f",
    "rgb(59,130,246)",
    "rgb(59 130 246 / 50%)",
    "rgba(59, 130, 246, 0.25)",
  ])("reads %s as the same blue, ignoring alpha", (color) => {
    expect(themeColorLuminance(color)).toBeCloseTo(
      color === "#38f" ? themeColorLuminance("#3388ff")! : 0.2355,
      3,
    );
  });

  it("reads percentage rgb() channels", () => {
    expect(themeColorLuminance("rgb(100% 100% 100%)")).toBe(1);
    expect(themeColorLuminance("rgb(0%, 0%, 0%)")).toBe(0);
  });

  it("reads hsl()/hsla() with or without deg and with bare numbers", () => {
    expect(themeColorLuminance("hsl(0 0% 100%)")).toBeCloseTo(1, 6);
    expect(themeColorLuminance("hsl(0, 100%, 50%)")).toBeCloseTo(0.2126, 4); // pure red
    expect(themeColorLuminance("hsla(120deg 100% 50% / .5)")).toBeCloseTo(0.7152, 4); // green
    expect(themeColorLuminance("hsl(240 100 50)")).toBeCloseTo(0.0722, 4); // blue
    expect(themeColorLuminance("hsl(480 100% 50%)")).toBeCloseTo(0.7152, 4); // wraps to 120
  });

  it.each([
    "rebeccapurple",
    "white",
    "transparent",
    "#12345",
    "rgb(1 2)",
    "rgb(1 2 3 4 5)",
    "rgb(10deg 2 3)",
    "hsl(10 20deg 30%)",
    "rgb(1..2 3 4)",
    "url(x)",
    "",
  ])("returns null for %j rather than guessing", (color) => {
    expect(themeColorLuminance(color)).toBeNull();
  });
});

describe("contrastRatio", () => {
  it("is 21 for black on white and symmetric", () => {
    expect(contrastRatio(0, 1)).toBe(21);
    expect(contrastRatio(1, 0)).toBe(21);
    expect(contrastRatio(0.3, 0.3)).toBe(1);
  });
});
