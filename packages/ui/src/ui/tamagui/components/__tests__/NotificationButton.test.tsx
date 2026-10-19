import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithProvider } from "../../../../../test/utils";
import { NotificationButton } from "../feedback/NotificationButton";

describe("NotificationButton", () => {
  it("renders a formatted count badge", () => {
    renderWithProvider(
      <NotificationButton aria-label="alerts" count={128} maxCount={99} />,
    );

    expect(screen.getByText("99+")).toBeInTheDocument();
  });

  it("shows an indicator dot when requested", () => {
    renderWithProvider(
      <NotificationButton aria-label="alerts" showIndicator />,
    );

    expect(screen.getByTestId("badge-dot")).toBeInTheDocument();
  });

  it("forwards click handlers", async () => {
    const onPress = vi.fn();
    const user = userEvent.setup();

    renderWithProvider(
      <NotificationButton aria-label="alerts" onPress={onPress} />,
    );

    await act(async () => {
      await user.click(screen.getByRole("button", { name: /alerts/i }));
    });

    expect(onPress).toHaveBeenCalled();
  });
});
