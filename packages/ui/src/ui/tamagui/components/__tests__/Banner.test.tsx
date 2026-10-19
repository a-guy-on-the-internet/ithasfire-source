import { renderWithProvider } from "../../../../../test/utils";
import { fireEvent, screen } from "@testing-library/react";

import { Banner } from "../feedback/Banner";

describe("Banner", () => {
  it("renders title and description", () => {
    renderWithProvider(
      <Banner title="Heads up" description="System maintenance" tone="info" />,
    );

    expect(screen.getByRole("region")).toBeInTheDocument();
    expect(screen.getByText("Heads up")).toBeVisible();
    expect(screen.getByText("System maintenance")).toBeVisible();
  });

  it("handles dismiss action", () => {
    const onDismiss = vi.fn();

    renderWithProvider(
      <Banner
        title="Warning"
        tone="warning"
        onDismiss={onDismiss}
        dismissLabel="Close"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
