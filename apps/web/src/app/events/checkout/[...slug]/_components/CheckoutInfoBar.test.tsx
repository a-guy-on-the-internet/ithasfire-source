import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string) => key,
}));

import { CheckoutInfoBar } from "./CheckoutInfoBar";

const renderBar = (backLocked?: boolean) =>
  render(
    <CheckoutInfoBar
      eventName="Sixth Street Comedy Night"
      dateLabel="Fri, Oct 3"
      backHref="/events/sixth-street"
      backLocked={backLocked}
    />,
  );

describe("CheckoutInfoBar — the back-to-event link", () => {
  it("goes back to the event when nothing is being paid", () => {
    renderBar();
    const back = screen.getByRole("link", { name: /common.backToEvent/ });
    expect(back).toHaveAttribute("href", "/events/sixth-street");
    expect(back).not.toHaveAttribute("aria-disabled");
  });

  it("regression: while a payment is submitting / confirming it goes nowhere, and says so", () => {
    renderBar(true);
    const back = screen.getByTestId("checkout-back-to-event");
    expect(back).not.toHaveAttribute("href");
    expect(back).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("link", { name: /common.backToEvent/ })).toBe(back);
  });
});
