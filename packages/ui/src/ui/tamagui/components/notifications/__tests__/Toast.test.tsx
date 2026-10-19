import { screen } from "@testing-library/react";
import { vi } from "vitest";

import { renderWithProvider } from "../../../../../../test/utils";
import { ToastViewport } from "../Toast";
import type { ToastInternal } from "../types";

describe("ToastViewport", () => {
  const createToast = (): ToastInternal => {
    const createdAt = Date.now();
    return {
      id: "toast-1",
      title: "Heads up",
      message: "We saved your preferences.",
      variant: "info",
      intent: "system",
      durationMs: 4000,
      haptic: false,
      createdAt,
      expiresAt: createdAt + 4000,
      count: 1,
    };
  };

  it("renders close button with icon affordance", () => {
    renderWithProvider(
      <ToastViewport
        toasts={[createToast()]}
        position="top-right"
        onDismiss={vi.fn()}
        pauseOnHover
        reducedMotion={false}
        pauseToast={vi.fn()}
        resumeToast={vi.fn()}
      />,
    );

    const closeButton = screen.getByLabelText("Dismiss notification");
    expect(closeButton).toBeVisible();
    expect(closeButton.querySelector("svg")).not.toBeNull();
  });

  it("surfaces intent and tone badges", () => {
    renderWithProvider(
      <ToastViewport
        toasts={[
          { ...createToast(), variant: "success", intent: "payment", count: 2 },
        ]}
        position="top-right"
        onDismiss={vi.fn()}
        pauseOnHover
        reducedMotion={false}
        pauseToast={vi.fn()}
        resumeToast={vi.fn()}
      />,
    );

    expect(screen.getByText("Payment")).toBeVisible();
    expect(screen.getByText("Success")).toBeVisible();
    expect(screen.getByText("×2")).toBeVisible();
  });
});
