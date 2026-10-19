import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string) => key,
}));

import { CheckoutTicketSummaryHeader } from "./CheckoutTicketSummaryHeader";

/**
 * "Change tickets" opens the hold-release dialog. While the order is being
 * paid (a Stripe confirm submitting, or payment confirming) Checkout turns it
 * off: releasing the hold then released the order Stripe was charging.
 */
describe("CheckoutTicketSummaryHeader — Change tickets", () => {
  it("opens the release dialog when the way back is open", () => {
    const onChangeTickets = vi.fn();
    render(<CheckoutTicketSummaryHeader selectedQty={2} onChangeTickets={onChangeTickets} />);
    fireEvent.click(screen.getByRole("button", { name: "checkout.changeTickets" }));
    expect(onChangeTickets).toHaveBeenCalledTimes(1);
  });

  it("regression: disabled while the order is being paid — a click opens nothing", () => {
    const onChangeTickets = vi.fn();
    render(
      <CheckoutTicketSummaryHeader
        selectedQty={2}
        onChangeTickets={onChangeTickets}
        changeTicketsDisabled
      />,
    );
    const button = screen.getByRole("button", { name: "checkout.changeTickets" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onChangeTickets).not.toHaveBeenCalled();
  });
});
