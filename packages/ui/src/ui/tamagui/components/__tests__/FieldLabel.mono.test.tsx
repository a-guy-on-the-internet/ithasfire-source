import { screen } from "@testing-library/react";
import { renderWithProvider } from "../../../../../test/utils";
import { FieldLabel } from "../forms/FieldLabel";

describe("FieldLabel mono idiom", () => {
  it("renders its label through the overline variant (mono family class)", () => {
    renderWithProvider(<FieldLabel testIdBase="fl">Doors open</FieldLabel>);
    const el = screen.getByText("Doors open");
    // Tamagui compiles the family token to a class; jsdom cannot resolve the
    // var() behind it, so the class is the observable.
    expect(el.classList.contains("font_mono")).toBe(true);
    expect(el).toHaveStyle({ textTransform: "uppercase" });
  });
});
