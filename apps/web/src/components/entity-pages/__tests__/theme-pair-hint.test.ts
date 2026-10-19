import { describe, expect, it } from "vitest";

import { loneColorUnmeasurable } from "../theme-pair-hint";

/**
 * The public page drops a lone background or text colour it cannot measure,
 * so the theme editor shows a hint for exactly that case and no other.
 */
describe("loneColorUnmeasurable", () => {
  it("is true for a lone colour name, in either field", () => {
    expect(loneColorUnmeasurable("rebeccapurple", "")).toBe(true);
    expect(loneColorUnmeasurable("  ", " white ")).toBe(true);
  });

  it("is false for a lone colour the page can measure", () => {
    expect(loneColorUnmeasurable("#3B82F6", "")).toBe(false);
    expect(loneColorUnmeasurable("", "rgb(10 20 30)")).toBe(false);
    expect(loneColorUnmeasurable("hsl(217deg 91% 60%)", "")).toBe(false);
  });

  it("is false when both or neither are set", () => {
    expect(loneColorUnmeasurable("white", "black")).toBe(false);
    expect(loneColorUnmeasurable("", "")).toBe(false);
  });

  it("is false for a value that is not a colour (the save refuses it)", () => {
    expect(loneColorUnmeasurable("url(x)", "")).toBe(false);
  });
});
