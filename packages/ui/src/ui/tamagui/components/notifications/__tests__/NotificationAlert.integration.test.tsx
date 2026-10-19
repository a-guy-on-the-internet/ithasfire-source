import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act, useEffect, useRef } from "react";

import { renderWithProvider } from "../../../../../../test/utils";
import { NotificationAlert } from "../NotificationAlert";
import {
  NotificationProvider,
  useNotificationContext,
} from "../NotificationProvider";
import { type PushAlertOptions } from "../types";

const AlertsFixture = ({ alerts }: { alerts: PushAlertOptions[] }) => {
  const seededRef = useRef(false);
  const { pushAlert } = useNotificationContext();

  useEffect(() => {
    if (seededRef.current) {
      return;
    }
    seededRef.current = true;
    alerts.forEach((alert) => pushAlert(alert));
  }, [alerts, pushAlert]);

  return <NotificationAlert />;
};

const renderAlerts = (alerts: PushAlertOptions[]) =>
  renderWithProvider(
    <NotificationProvider>
      <AlertsFixture alerts={alerts} />
    </NotificationProvider>,
  );

describe("NotificationAlert integration", () => {
  it("renders seeded alerts", () => {
    renderAlerts([
      {
        id: "alpha",
        title: "New payout available",
        message: "Funds are ready to transfer.",
      },
      {
        id: "beta",
        title: "Webhook pending",
        message: "We have not received a payload yet.",
      },
    ]);

    expect(screen.getByText("New payout available")).toBeVisible();
    expect(
      screen.getByText("We have not received a payload yet."),
    ).toBeVisible();
  });

  it("annotates alerts with list semantics for screen readers", () => {
    renderAlerts([
      {
        id: "alpha",
        title: "New payout available",
        message: "Funds are ready to transfer.",
      },
      {
        id: "beta",
        title: "Webhook pending",
        message: "We have not received a payload yet.",
      },
    ]);

    const list = screen.getByRole("list");
    expect(list).toBeVisible();
    const alerts = screen.getAllByRole("status");
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toHaveAttribute("aria-posinset", "1");
    expect(alerts[0]).toHaveAttribute("aria-setsize", "2");
    expect(alerts[1]).toHaveAttribute("aria-posinset", "2");
    // setsize should be shared across alerts
    expect(alerts[1]).toHaveAttribute("aria-setsize", "2");
  });

  it("dismisses alerts when the close button is pressed", async () => {
    renderAlerts([
      {
        id: "gamma",
        title: "Verify identity",
        message: "Upload a government-issued ID.",
      },
    ]);

    await act(async () => {
      await userEvent.click(screen.getByLabelText("Dismiss alert"));
    });

    await waitFor(() => {
      expect(screen.queryByText("Verify identity")).not.toBeInTheDocument();
    });
  });
});
