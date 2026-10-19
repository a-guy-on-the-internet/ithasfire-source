import { fireEvent, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef } from "react";

import { renderWithProvider } from "../../../../../../test/utils";
import { NotificationProvider } from "../NotificationProvider";
import { NotificationAlert } from "../NotificationAlert";
import { useNotify } from "../useNotify";
import type { PushAlertOptions } from "../types";

const SeededAlert = ({ config }: { config: PushAlertOptions }) => {
  const { alert } = useNotify();
  const seededRef = useRef(false);

  useEffect(() => {
    if (seededRef.current) {
      return;
    }
    seededRef.current = true;
    alert.push(config);
  }, [alert, config]);

  return <NotificationAlert />;
};

const renderAlerts = (config: PushAlertOptions) =>
  renderWithProvider(
    <NotificationProvider>
      <SeededAlert config={config} />
    </NotificationProvider>,
  );

describe("NotificationAlert", () => {
  it("renders alerts pushed through the provider", async () => {
    renderAlerts({
      id: "notification-alert-visible",
      variant: "success",
      title: "New payout available",
      message: "Yesterday's sales cleared—transfer funds when you're ready.",
    });

    expect(await screen.findByText("New payout available")).toBeVisible();
    expect(
      screen.getByText(
        "Yesterday's sales cleared—transfer funds when you're ready.",
      ),
    ).toBeVisible();
  });

  it("dismisses alerts via the built-in control and invokes onClose", async () => {
    const onClose = vi.fn();

    renderAlerts({
      id: "notification-alert-dismiss",
      variant: "warning",
      title: "Heads up",
      message: "Review the venue security log before doors open.",
      dismissLabel: "Close alert",
      onClose,
    });

    const dismissButton = await screen.findByRole("button", {
      name: "Close alert",
    });
    fireEvent.click(dismissButton);

    await waitFor(() => {
      expect(screen.queryByText("Heads up")).not.toBeInTheDocument();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
