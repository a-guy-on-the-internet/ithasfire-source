import { screen } from "@testing-library/react";

import { renderWithProvider } from "../../../../../../test/utils";

import { NotificationProvider } from "../NotificationProvider";
import { AlertsSidebar } from "../AlertsSidebar";

describe("AlertsSidebar button styling", () => {
  it("renders ghost variant for the bell trigger", () => {
    renderWithProvider(
      <NotificationProvider>
        <AlertsSidebar />
      </NotificationProvider>,
    );

    const trigger = screen.getByRole("button", { name: /open alerts/i });
    expect(trigger).toBeVisible();
    const styles = window.getComputedStyle(trigger);
    expect(["transparent", "rgba(0, 0, 0, 0)"]).toContain(
      styles.backgroundColor,
    );
    expect(["transparent", "rgba(0, 0, 0, 0)"]).toContain(
      styles.borderTopColor,
    );
  });

  // `aria-label` overrides a button's content for the accessibility tree, so
  // the CountBadge's visible unread number never reached a screen reader.
  // The count now rides the label itself.
  it("folds the unread count into the bell's accessible name", () => {
    renderWithProvider(
      <NotificationProvider>
        <AlertsSidebar unreadCount={3} />
      </NotificationProvider>,
    );

    expect(
      screen.getByRole("button", { name: "Open alerts, 3 unread" }),
    ).toBeVisible();
  });

  it("leaves the accessible name bare when there is nothing unread", () => {
    renderWithProvider(
      <NotificationProvider>
        <AlertsSidebar unreadCount={0} />
      </NotificationProvider>,
    );

    expect(screen.getByRole("button", { name: "Open alerts" })).toBeVisible();
  });

  // The default suffix is English. A host with its own catalog supplies the
  // whole name so a Spanish reader does not hear "Abrir notificaciones, 3 unread".
  it("uses the host's formatter for the whole accessible name", () => {
    const format = (count: number) =>
      count
        ? `Abrir notificaciones, ${count} sin leer`
        : "Abrir notificaciones";
    const { rerender } = renderWithProvider(
      <NotificationProvider>
        <AlertsSidebar unreadCount={3} formatButtonLabel={format} />
      </NotificationProvider>,
    );
    expect(
      screen.getByRole("button", { name: "Abrir notificaciones, 3 sin leer" }),
    ).toBeVisible();

    rerender(
      <NotificationProvider>
        <AlertsSidebar unreadCount={0} formatButtonLabel={format} />
      </NotificationProvider>,
    );
    expect(
      screen.getByRole("button", { name: "Abrir notificaciones" }),
    ).toBeVisible();
  });
});
