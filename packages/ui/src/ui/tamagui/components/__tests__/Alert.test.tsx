import { renderWithProvider } from "../../../../../test/utils";
import { fireEvent, screen } from "@testing-library/react";

import { Alert } from "../feedback/Alert";

describe("Alert", () => {
  it("renders title and description", () => {
    renderWithProvider(
      <Alert title="Heads up" description="System maintenance tonight" />,
    );

    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText("Heads up")).toBeVisible();
    expect(screen.getByText("System maintenance tonight")).toBeVisible();
  });

  it("uses alert role for danger tone", () => {
    renderWithProvider(<Alert tone="danger" title="Action required" />);

    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("supports action render", () => {
    const acknowledge = vi.fn();

    renderWithProvider(
      <Alert
        title="Payment failed"
        tone="danger"
        actions={<button onClick={acknowledge}>Retry</button>}
      />,
    );

    fireEvent.click(screen.getByText("Retry"));

    expect(acknowledge).toHaveBeenCalledTimes(1);
  });

  it("renders dismiss control", () => {
    const dismiss = vi.fn();

    renderWithProvider(
      <Alert
        title="Limited capacity"
        description="Checkouts may queue briefly."
        onDismiss={dismiss}
        dismissLabel="Close"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(dismiss).toHaveBeenCalledTimes(1);
  });
});
