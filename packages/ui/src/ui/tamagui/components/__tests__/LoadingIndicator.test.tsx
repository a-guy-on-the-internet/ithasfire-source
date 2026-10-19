import { screen } from "@testing-library/react";
import { renderWithProvider } from "../../../../../test/utils";
import { LoadingIndicator } from "../feedback/LoadingIndicator";

describe("LoadingIndicator", () => {
  it("renders a spinner and label by default", () => {
    renderWithProvider(<LoadingIndicator />);

    const el = screen.getByTestId("loading-indicator");
    expect(el).toBeTruthy();
    expect(el.querySelector('[data-testid="spinner"]')).toBeTruthy();
    expect(screen.getByText(/loading/i)).toBeTruthy();
  });

  it("can render inline without a label", () => {
    renderWithProvider(
      <LoadingIndicator inline label={null} size="sm" testID="inline-loader" />,
    );
    const el = screen.getByTestId("inline-loader");
    expect(el).toBeTruthy();
    expect(el.querySelector('[data-testid="spinner"]')).toBeTruthy();
  });
});
