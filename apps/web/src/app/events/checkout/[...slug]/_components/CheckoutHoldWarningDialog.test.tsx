import React, { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string) => key,
}));

import { CheckoutHoldWarningDialog } from "./CheckoutHoldWarningDialog";

const renderDialog = (confirmDisabled?: boolean) => {
  const onConfirm = vi.fn();
  render(
    <CheckoutHoldWarningDialog
      dialogRef={createRef()}
      cancelButtonRef={createRef()}
      onCancel={vi.fn()}
      onConfirm={onConfirm}
      onKeyDown={vi.fn()}
      confirmDisabled={confirmDisabled}
    />,
  );
  return {
    onConfirm,
    release: screen.getByRole("button", { name: "checkout.holdWarningConfirm" }),
  };
};

describe("CheckoutHoldWarningDialog — Release", () => {
  it("releases when the way back is open", () => {
    const { onConfirm, release } = renderDialog();
    fireEvent.click(release);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("regression: disabled while the order is being created or paid — a click releases nothing", () => {
    const { onConfirm, release } = renderDialog(true);
    expect(release).toBeDisabled();
    fireEvent.click(release);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("CheckoutHoldWarningDialog — a disabled Release says why, and focus stays in the dialog", () => {
  const Harness = ({ locked }: { locked: boolean }) => (
    <CheckoutHoldWarningDialog
      dialogRef={createRef()}
      cancelButtonRef={createRef()}
      onCancel={vi.fn()}
      onConfirm={vi.fn()}
      onKeyDown={vi.fn()}
      confirmDisabled={locked}
    />
  );
  const release = () =>
    screen.getByRole("button", { name: "checkout.holdWarningConfirm" });
  const keep = () =>
    screen.getByRole("button", { name: "checkout.holdWarningCancel" });

  it("regression: locked → a 'payment in progress' line, tied to Release by aria-describedby", () => {
    render(<Harness locked />);
    const reason = screen.getByTestId("hold-warning-locked-reason");
    expect(reason).toHaveTextContent("checkout.holdWarningPaymentInProgress");
    expect(release()).toHaveAttribute("aria-describedby", reason.id);
    expect(release()).toHaveAccessibleDescription("checkout.holdWarningPaymentInProgress");
  });

  it("unlocked → no reason line, no description", () => {
    render(<Harness locked={false} />);
    expect(screen.queryByTestId("hold-warning-locked-reason")).toBeNull();
    expect(release()).not.toHaveAttribute("aria-describedby");
  });

  it("regression: Release had focus when it locked → focus moves to 'Keep my tickets' (not <body>)", () => {
    const { rerender } = render(<Harness locked={false} />);
    release().focus();
    expect(document.activeElement).toBe(release());
    rerender(<Harness locked />);
    expect(document.activeElement).toBe(keep());
  });

  it("…and does not steal focus when Release did not have it", () => {
    const { rerender } = render(
      <>
        <button type="button">elsewhere</button>
        <Harness locked={false} />
      </>,
    );
    screen.getByRole("button", { name: "elsewhere" }).focus();
    rerender(
      <>
        <button type="button">elsewhere</button>
        <Harness locked />
      </>,
    );
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "elsewhere" }),
    );
  });
});
