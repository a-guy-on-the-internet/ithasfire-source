import { screen } from "@testing-library/react";
import { renderWithProvider } from "../../../../../test/utils";
import { FullPageLoader } from "../feedback/FullPageLoader";

describe("FullPageLoader", () => {
  it("renders centered loader with label and testID", () => {
    renderWithProvider(
      <FullPageLoader label="Please wait" testID="fp-loader" />,
    );

    const el = screen.getByTestId("fp-loader");
    expect(el).toBeTruthy();
    expect(el.querySelector('[data-testid="spinner"]')).toBeTruthy();
    expect(screen.getByText("Please wait")).toBeTruthy();
  });

  it("hides label when label is null", () => {
    renderWithProvider(<FullPageLoader label={null} testID="fp-no-label" />);
    expect(screen.getByTestId("fp-no-label")).toBeTruthy();
  });
});
