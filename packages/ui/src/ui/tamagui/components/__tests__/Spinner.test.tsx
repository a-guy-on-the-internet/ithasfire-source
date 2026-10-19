import { screen } from "@testing-library/react";

import { renderWithProvider } from "../../../../../test/utils";
import { Spinner } from "../feedback/Spinner";

describe("Spinner", () => {
  it("announces loading status on web", () => {
    renderWithProvider(<Spinner />);

    const spinner = screen.getByRole("status");
    expect(spinner).toHaveAttribute("aria-live", "polite");
    expect(spinner).toHaveAttribute("aria-label", "spinner");
    expect(spinner.className).toMatch(/_(btc|borderTopColor)-[\w-]+/);
  });

  it("respects custom labels and tokens", () => {
    renderWithProvider(
      <Spinner
        indicatorColor="$success"
        trackColor="$surfaceStrong"
        screenReaderLabel="Loading events"
        testID="loading-spinner"
        qaId="loading-spinner"
      />,
    );

    const spinner = screen.getByRole("status");
    expect(spinner).toHaveAttribute("aria-label", "Loading events");
    expect(spinner.getAttribute("data-testid")).toBe("loading-spinner");
    expect(spinner.className).not.toContain("surfaceMute");
    expect(spinner.className).toContain("success");
  });

  it("supports legacy size aliases", () => {
    renderWithProvider(
      <>
        <Spinner size="small" testID="spinner-small" />
        <Spinner size="sm" testID="spinner-sm" />
        <Spinner size="medium" testID="spinner-medium" />
        <Spinner size="md" testID="spinner-md" />
        <Spinner size="large" testID="spinner-large" />
        <Spinner size="lg" testID="spinner-lg" />
      </>,
    );

    expect(screen.getByTestId("spinner-small")).toBeInTheDocument();
    expect(screen.getByTestId("spinner-small").className).toBe(
      screen.getByTestId("spinner-sm").className,
    );
    expect(screen.getByTestId("spinner-medium").className).toBe(
      screen.getByTestId("spinner-md").className,
    );
    expect(screen.getByTestId("spinner-large")).toBeInTheDocument();
    expect(screen.getByTestId("spinner-large").className).toBe(
      screen.getByTestId("spinner-lg").className,
    );
  });
});
