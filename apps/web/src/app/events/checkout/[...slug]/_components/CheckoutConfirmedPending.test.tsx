import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string) => key,
}));

import { CheckoutConfirmedPending } from "./CheckoutConfirmedPending";

/**
 * The views a paid / being-verified checkout shows instead of the steps:
 * NO figures (no estimate, no "Pay $…"), and no way to pay again.
 */
describe("CheckoutConfirmedPending", () => {
  it("regression: 'confirming' (a redirect return being verified) — says so, with no money figure and no Pay button", () => {
    const { container } = render(<CheckoutConfirmedPending status="confirming" orderId={null} />);
    expect(screen.getByRole("status")).toHaveTextContent("checkout.redirectConfirming");
    expect(container.textContent).not.toMatch(/\$/);
    expect(container.textContent).not.toMatch(/Pay/i);
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector("form, iframe, input")).toBeNull();
  });

  it("regression: 'received' (paid, confirm failed) — the terminal message and a way to My tickets", () => {
    const { container } = render(<CheckoutConfirmedPending status="received" orderId={null} />);
    expect(screen.getByRole("alert")).toHaveTextContent("checkout.paymentReceivedFinishing");
    expect(screen.getByRole("link", { name: "confirmation.viewTickets" })).toHaveAttribute(
      "href",
      "/my-tickets",
    );
    expect(container.textContent).not.toMatch(/\$/);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("'unavailable' links to the order itself when its id is known", () => {
    render(<CheckoutConfirmedPending status="unavailable" orderId="order-1" />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/my-tickets/order-1");
  });

  it.each([
    ["submitted", "checkout.paymentSubmittedFinishing"],
    ["unverified", "checkout.paymentUnverified"],
    ["wrong-account", "checkout.paymentWrongAccount"],
  ] as const)("terminal '%s' — its own copy, a link to My tickets, no figure, no button", (status, key) => {
    const { container } = render(<CheckoutConfirmedPending status={status} orderId={null} />);
    expect(screen.getByRole("alert")).toHaveTextContent(key);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/my-tickets");
    expect(container.textContent).not.toMatch(/\$/);
    expect(screen.queryByRole("button")).toBeNull();
  });

  // "unavailable" (the order couldn't be loaded) says the payment went
  // through only when this page knows it did (owner, 2026-10-14).
  it.each([
    ["paid", "checkout.confirmedOrderUnavailable"],
    ["processing", "checkout.paymentSubmittedFinishing"],
    ["unknown", "checkout.paymentUnverified"],
    [undefined, "checkout.paymentUnverified"],
  ] as const)("'unavailable' with payment %s — %s", (payment, key) => {
    render(
      <CheckoutConfirmedPending status="unavailable" orderId="order-1" payment={payment} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(key);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/my-tickets/order-1");
  });

  it("'loading' is neutral — a free claim lands here too, so it never says 'Payment received'", () => {
    render(<CheckoutConfirmedPending status="loading" orderId="order-1" />);
    expect(screen.getByRole("status")).toHaveTextContent("checkout.confirmedOrderLoading");
  });
});
