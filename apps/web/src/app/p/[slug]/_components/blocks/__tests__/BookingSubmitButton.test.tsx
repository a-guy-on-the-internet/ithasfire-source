import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * BookingSubmitButton: the submit CTA shared by RequestToPlayForm and
 * OrganizerBookingDialog. Pins the two states the forms rely on — an idle
 * button named by the submit label, and a pending button that is disabled,
 * busy, named by the sending label, and shows a spinner.
 */

vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string) => key,
  Spinner: () => <span data-testid="spinner" />,
}));

import { BookingSubmitButton } from "../BookingSubmitButton";

describe("BookingSubmitButton", () => {
  it("idle: named by the submit label, not busy, no spinner", () => {
    render(<BookingSubmitButton pending={false} />);

    const button = screen.getByRole("button", { name: "admin.bkFormSubmit" });
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute("aria-busy", "false");
    expect(screen.queryByTestId("spinner")).not.toBeInTheDocument();
    // The sending label is still in the DOM (it holds the width) but is
    // hidden from assistive tech; the idle label carries no aria-hidden.
    expect(screen.getByText("admin.bkFormSubmitting")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(screen.getByText("admin.bkFormSubmit")).not.toHaveAttribute(
      "aria-hidden",
    );
  });

  it("pending: disabled, busy, named by the sending label, spinner mounted", () => {
    render(<BookingSubmitButton pending />);

    const button = screen.getByRole("button", {
      name: "admin.bkFormSubmitting",
    });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.getByTestId("spinner")).toBeInTheDocument();
    expect(screen.getByText("admin.bkFormSubmit")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(screen.getByText("admin.bkFormSubmitting")).not.toHaveAttribute(
      "aria-hidden",
    );
  });
});
