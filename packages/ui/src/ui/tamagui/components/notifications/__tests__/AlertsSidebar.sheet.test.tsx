import { screen } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";

import { renderWithProvider } from "../../../../../../test/utils";
import { NotificationProvider } from "../NotificationProvider";
import { AlertsSidebar } from "../AlertsSidebar";
import { useNotify } from "../useNotify";

const SeedAlerts = () => {
  const { alert } = useNotify();

  useEffect(() => {
    alert.info({ id: "seed-alert", title: "Heads up" });
  }, [alert]);

  return null;
};

describe("AlertsSidebar (native)", () => {
  it("renders bottom sheet affordances when opened", async () => {
    renderWithProvider(
      <NotificationProvider>
        <SeedAlerts />
        <AlertsSidebar
          buttonLabel="Open alerts"
          platformOverride="ios"
          defaultOpen
        />
      </NotificationProvider>,
    );

    expect(
      await screen.findByTestId("alerts-bottom-sheet-handle"),
    ).toBeInTheDocument();
    expect(
      await screen.findByTestId("alerts-bottom-sheet-scroll"),
    ).toBeInTheDocument();
  });

  it("does not touch body scroll", async () => {
    // The scroll lock is the web panel's, gated on the same override-aware
    // `isWeb` as the portal. The native sheet owns its own scrolling (the
    // ScrollView above) and `document.body` is not a thing it has.
    renderWithProvider(
      <NotificationProvider>
        <AlertsSidebar
          buttonLabel="Open alerts"
          platformOverride="ios"
          defaultOpen
        />
      </NotificationProvider>,
    );

    await screen.findByTestId("alerts-bottom-sheet-handle");
    expect(document.body.style.overflow).toBe("");
  });
});
