import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string) => key,
  useFormatters: () => ({ dateTime: () => "date" }),
  Button: ({ children, href }: { children: React.ReactNode; href?: string }) =>
    href ? <a href={href}>{children}</a> : <button>{children}</button>,
}));

vi.mock("@/lib/format", () => ({
  fmtCurrency: (_fmt: unknown, cents: number) => `$${(cents / 100).toFixed(2)}`,
}));

import { CheckoutConfirmedStep } from "./CheckoutConfirmedStep";
import type { ConfirmedPayment } from "./confirmed-payment";

const props = (payment: ConfirmedPayment) => ({
  orderId: "order-12345678",
  eventName: "Test Event",
  eventSlug: "test-event",
  eventId: "evt_test",
  eventDate: new Date("2026-09-01T20:00:00Z"),
  order: {
    amountGrossCents: 9000,
    feesPlatformCents: 60,
    buyerFeesCents: 60,
    processorFeeCents: 326,
    taxAmountCents: 799,
    feeMode: "PASS_THROUGH" as const,
  },
  fallbackSubtotalCents: 9000,
  ticketTypes: [{ id: "ga", name: "GA", priceCents: 4500 }],
  quantities: { ga: 2 },
  currency: "usd",
  payment,
});

describe("CheckoutConfirmedStep — only a paid order reads as paid", () => {
  it("unknown: the 'couldn't confirm your payment' copy with the order's link, not the confirmation", () => {
    render(<CheckoutConfirmedStep {...props("unknown")} />);
    expect(screen.getByRole("alert")).toHaveTextContent("checkout.paymentUnverified");
    expect(screen.getByText("confirmation.viewTickets").closest("a")).toHaveAttribute(
      "href",
      "/my-tickets/order-12345678",
    );
    expect(screen.queryByText("confirmation.title")).not.toBeInTheDocument();
    expect(screen.queryByText("confirmation.processingTitle")).not.toBeInTheDocument();
  });

  it("processing: the confirmation, saying payment processing", () => {
    render(<CheckoutConfirmedStep {...props("processing")} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "confirmation.processingTitle",
    );
    expect(screen.queryByTestId("checkout-confirmed-pending")).not.toBeInTheDocument();
  });

  it("paid: the confirmation as before", () => {
    render(<CheckoutConfirmedStep {...props("paid")} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "confirmation.title",
    );
  });
});

describe("CheckoutConfirmedStep — forwards the event id to the calendar export", () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  afterEach(() => {
    vi.restoreAllMocks();
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });

  it("the .ics a paid confirmation downloads carries UID:<eventId>@ithasfire", async () => {
    const blobs: Blob[] = [];
    URL.createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return "blob:ics";
    });
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    render(<CheckoutConfirmedStep {...props("paid")} eventId="evt_abc" />);
    fireEvent.click(screen.getByText("confirmation.addToCalendar"));
    fireEvent.click(screen.getByText("confirmation.downloadIcs"));

    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
      reader.readAsText(blobs[0]!);
    });
    expect(text.split(/\r?\n/)).toContain("UID:evt_abc@ithasfire");
  });
});
