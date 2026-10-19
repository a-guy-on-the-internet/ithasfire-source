import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@th/ui", () => ({
  // The key, with any `{email}` value after it, so a test can see both.
  useTranslations: () => (key: string, values?: { email?: string }) =>
    values?.email ? `${key}:${values.email}` : key,
  useFormatters: () => ({
    // Real Intl throws on an Invalid Date; a fixed string would not, and the
    // unreadable-date tests below would then pass with no guard in place.
    dateTime: (d: Date) => {
      if (Number.isNaN(d.getTime())) throw new RangeError("Invalid time value");
      return "date";
    },
  }),
  Button: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href?: string;
  }) => (href ? <a href={href}>{children}</a> : <button>{children}</button>),
}));

vi.mock("@/lib/format", () => ({
  fmtCurrency: (_fmt: unknown, cents: number) =>
    `$${(cents / 100).toFixed(2)}`,
}));

import { OrderConfirmation } from "./OrderConfirmation";

const baseProps = {
  orderId: "order-12345678",
  eventName: "Test Event",
  eventSlug: "test-event",
  eventDate: new Date("2026-09-01T20:00:00Z"),
  currency: "usd",
  ticketTypes: [
    {
      id: "ticket-ga",
      name: "General Admission",
      priceCents: 4500,
      // Fee-inclusive per-unit estimate ($51.09) — 2× would be $102.18,
      // 33¢ above the $101.85 actually charged.
      buyerUnitTotalCents: 5109,
    },
  ],
  quantities: { "ticket-ga": 2 },
  payment: "paid" as const,
};

describe("OrderConfirmation line items", () => {
  it("renders lines from the server's item amounts so they match the Subtotal", () => {
    render(
      <OrderConfirmation
        {...baseProps}
        order={{
          amountGrossCents: 9000,
          feesPlatformCents: 60,
          buyerFeesCents: 60,
          processorFeeCents: 326,
          taxAmountCents: 799,
          feeMode: "PASS_THROUGH",
          // One OrderItem per ticket (qty=1 each), as the server stamps them.
          items: [
            {
              kind: "ticket",
              ticketTypeId: "ticket-ga",
              qty: 1,
              unitPriceCents: 4500,
              amountCents: 4500,
            },
            {
              kind: "ticket",
              ticketTypeId: "ticket-ga",
              qty: 1,
              unitPriceCents: 4500,
              amountCents: 4500,
            },
          ],
        }}
      />,
    );

    // Line ($90.00) agrees with the Subtotal row ($90.00) — base pricing.
    expect(screen.getAllByText("$90.00")).toHaveLength(2);
    // The stale fee-inclusive line ($102.18) must NOT render.
    expect(screen.queryByText("$102.18")).not.toBeInTheDocument();
    // Total = 9000 + 60 + 326 + 799 = 10185 — the charged amount.
    expect(screen.getByText("$101.85")).toBeInTheDocument();
  });

  it("falls back to face × qty lines when the order has no stamped items", () => {
    render(
      <OrderConfirmation
        {...baseProps}
        order={{
          amountGrossCents: 9000,
          feesPlatformCents: 60,
          buyerFeesCents: 60,
          processorFeeCents: 326,
          taxAmountCents: 799,
          feeMode: "PASS_THROUGH",
          items: [],
        }}
      />,
    );

    // No ticket items → face-based fallback keeps the line on the Subtotal
    // basis (2 × $45.00) rather than the fee-inclusive estimate.
    expect(screen.getAllByText("$90.00")).toHaveLength(2);
    expect(screen.queryByText("$102.18")).not.toBeInTheDocument();
  });

  it("keeps the legacy inclusive line only when no items array exists at all", () => {
    render(
      <OrderConfirmation
        {...baseProps}
        order={{
          amountGrossCents: 9000,
          feesPlatformCents: 60,
          buyerFeesCents: 60,
          processorFeeCents: 326,
          taxAmountCents: 799,
          feeMode: "PASS_THROUGH",
        }}
      />,
    );

    // Defensive fallback (synthesized order without items): unchanged legacy
    // inclusive-line behavior.
    expect(screen.getByText("$102.18")).toBeInTheDocument();
  });
});

describe("OrderConfirmation — a zero-tax order (owner ruling 2026-10-01)", () => {
  it("regression: the Taxes row reads $0.00 — shown, not hidden", () => {
    render(
      <OrderConfirmation
        {...baseProps}
        order={{
          amountGrossCents: 9000,
          feesPlatformCents: 60,
          buyerFeesCents: 60,
          processorFeeCents: 326,
          taxAmountCents: 0,
          feeMode: "PASS_THROUGH",
        }}
      />,
    );
    expect(screen.getByTestId("order-confirmation-tax-value")).toHaveTextContent("$0.00");
    // Total = 9000 + 60 + 326 + 0.
    expect(screen.getByText("$93.86")).toBeInTheDocument();
  });
});

describe("OrderConfirmation — with a % promo the rows still add up", () => {
  it("regression: lines at face, Subtotal pre-discount, a Discount row — Subtotal + fees + tax − discount = Total", () => {
    render(
      <OrderConfirmation
        {...baseProps}
        order={{
          // 2 × $45 = $90 at face; 10% off → gross $81.00 (post-discount).
          amountGrossCents: 8100,
          feesPlatformCents: 60,
          buyerFeesCents: 60,
          processorFeeCents: 326,
          taxAmountCents: 719,
          feeMode: "PASS_THROUGH",
          items: [
            { kind: "ticket", ticketTypeId: "ticket-ga", qty: 1, unitPriceCents: 4500, amountCents: 4500 },
            { kind: "ticket", ticketTypeId: "ticket-ga", qty: 1, unitPriceCents: 4500, amountCents: 4500 },
          ],
        }}
      />,
    );
    expect(screen.getByTestId("order-confirmation-subtotal-value")).toHaveTextContent("$90.00");
    expect(screen.getByTestId("order-confirmation-discount-value")).toHaveTextContent("−$9.00");
    // Total = 8100 + 60 + 326 + 719 = 9205 = 9000 + 60 + 326 + 719 − 900.
    expect(screen.getByText("$92.05")).toBeInTheDocument();
  });

  it("no promo → no Discount row", () => {
    render(
      <OrderConfirmation
        {...baseProps}
        order={{
          amountGrossCents: 9000,
          feesPlatformCents: 60,
          buyerFeesCents: 60,
          processorFeeCents: 326,
          taxAmountCents: 799,
          feeMode: "PASS_THROUGH",
          items: [
            { kind: "ticket", ticketTypeId: "ticket-ga", qty: 2, unitPriceCents: 4500, amountCents: 9000 },
          ],
        }}
      />,
    );
    expect(screen.queryByTestId("order-confirmation-discount-value")).toBeNull();
  });
});

describe("OrderConfirmation — ABSORB: the platform fee is the organiser's, not the buyer's", () => {
  it("regression: the Platform row reads 'Included' (dimmed), not a charged $X — and the rows sum to the Total", () => {
    render(
      <OrderConfirmation
        {...baseProps}
        order={{
          amountGrossCents: 9000,
          // The organiser's cost; the buyer paid none of it.
          feesPlatformCents: 150,
          buyerFeesCents: 0,
          processorFeeCents: 291,
          taxAmountCents: 799,
          feeMode: "ABSORB",
          items: [
            { kind: "ticket", ticketTypeId: "ticket-ga", qty: 2, unitPriceCents: 4500, amountCents: 9000 },
          ],
        }}
      />,
    );
    expect(screen.queryByTestId("order-confirmation-platform-fee-value")).toBeNull();
    expect(screen.getByTestId("order-confirmation-platform-fee-included")).toHaveTextContent(
      "checkout.included",
    );
    // Total = 9000 + 0 + 799 (ABSORB: no processing) = $97.99 = Subtotal + Taxes.
    expect(screen.getByText("$97.99")).toBeInTheDocument();
  });

  it("PASS_THROUGH: the Platform row is what the buyer paid (buyerFeesCents), not the full fee", () => {
    render(
      <OrderConfirmation
        {...baseProps}
        order={{
          amountGrossCents: 9000,
          feesPlatformCents: 90,
          // A fee waiver: the buyer paid $0.60 of the $0.90.
          buyerFeesCents: 60,
          processorFeeCents: 326,
          taxAmountCents: 799,
          feeMode: "PASS_THROUGH",
        }}
      />,
    );
    expect(screen.getByTestId("order-confirmation-platform-fee-value")).toHaveTextContent("$0.60");
  });
});

describe("OrderConfirmation — the ticket prints once per order per tab", () => {
  const order = {
    amountGrossCents: 9000,
    feesPlatformCents: 60,
    buyerFeesCents: 60,
    processorFeeCents: 326,
    taxAmountCents: 799,
    feeMode: "PASS_THROUGH" as const,
  };
  const card = (container: HTMLElement) =>
    container.querySelector(".conf-print-card");

  beforeEach(() => {
    window.sessionStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("first sight of an order: the card feeds out (no printed modifier) and the order is marked", () => {
    const { container } = render(
      <OrderConfirmation {...baseProps} orderId="order-first" order={order} />,
    );
    expect(card(container)).not.toBeNull();
    expect(card(container)!.classList.contains("conf-print-card--printed")).toBe(false);
    expect(window.sessionStorage.getItem("th:order-printed:order-first")).toBe("1");
  });

  it("a reload of the same order renders the card at rest, no feed", () => {
    window.sessionStorage.setItem("th:order-printed:order-seen", "1");
    const { container } = render(
      <OrderConfirmation {...baseProps} orderId="order-seen" order={order} />,
    );
    expect(card(container)!.classList.contains("conf-print-card--printed")).toBe(true);
  });

  it("StrictMode's double effect doesn't read back its own mark and skip the print", () => {
    const { container } = render(
      <React.StrictMode>
        <OrderConfirmation {...baseProps} orderId="order-strict" order={order} />
      </React.StrictMode>,
    );
    expect(card(container)!.classList.contains("conf-print-card--printed")).toBe(false);
  });

  it("storage that throws falls back to printing, without crashing", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    const { container } = render(
      <OrderConfirmation {...baseProps} orderId="order-nostore" order={order} />,
    );
    expect(card(container)!.classList.contains("conf-print-card--printed")).toBe(false);
    expect(screen.getByText("confirmation.title")).toBeInTheDocument();
  });

  it("reduced motion is handled in CSS: the injected stylesheet switches the feed and the stagger off", () => {
    const { container } = render(
      <OrderConfirmation {...baseProps} orderId="order-css" order={order} />,
    );
    const css = container.querySelector("style")!.textContent ?? "";
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.conf-print-card,\s*\.conf-fade-up \{ animation: none; \}/,
    );
    expect(css).toContain("steps(12, end)");
  });

  it("the stagger rides a class (not an inline animation), indexed by --conf-i", () => {
    const { container } = render(
      <OrderConfirmation {...baseProps} orderId="order-stagger" order={order} />,
    );
    const staggered = Array.from(
      container.querySelectorAll<HTMLElement>(".conf-fade-up"),
    );
    expect(staggered.map((el) => el.style.getPropertyValue("--conf-i"))).toEqual(
      ["0", "1", "3", "4"],
    );
    for (const el of staggered) expect(el.style.animation).toBe("");
  });
});

describe("OrderConfirmation — a bank payment still processing (owner board A, 2026-10-14)", () => {
  const order = {
    amountGrossCents: 9000,
    feesPlatformCents: 60,
    buyerFeesCents: 60,
    processorFeeCents: 326,
    taxAmountCents: 799,
    feeMode: "PASS_THROUGH" as const,
  };
  const card = (container: HTMLElement) =>
    container.querySelector(".conf-print-card");

  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("says the payment is processing, never that it's confirmed", () => {
    render(
      <OrderConfirmation
        {...baseProps}
        payment="processing"
        order={order}
        buyerEmail="buyer@example.com"
        waiverAccepted
      />,
    );
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("confirmation.processingTitle");
    expect(heading.id).toBe("checkout-confirmation-heading");
    expect(heading.tabIndex).toBe(-1);
    expect(screen.getByText("confirmation.processingSubtitle")).toBeInTheDocument();
    expect(screen.queryByText("confirmation.title")).not.toBeInTheDocument();
    expect(screen.queryByText("confirmation.subtitle")).not.toBeInTheDocument();

    // What's next: the email (with the address), the failure line, the
    // waiver (true either way). Nothing that says tickets exist.
    expect(screen.getByText("confirmation.whatsNext")).toBeInTheDocument();
    expect(
      screen.getByText("confirmation.processingEmail:buyer@example.com"),
    ).toBeInTheDocument();
    expect(screen.getByText("confirmation.processingFailNotice")).toBeInTheDocument();
    expect(screen.getByText("confirmation.waiverAccepted")).toBeInTheDocument();
    for (const gone of [
      "confirmation.whatsNextEmail:buyer@example.com",
      "confirmation.whatsNextTickets",
      "confirmation.whatsNextEntry",
      "confirmation.walletPassesAvailable",
    ]) {
      expect(screen.queryByText(gone)).not.toBeInTheDocument();
    }

    // The order's figures stay.
    expect(screen.getByTestId("order-confirmation-subtotal-value")).toHaveTextContent("$90.00");
    expect(screen.getByText("confirmation.ticketCount")).toBeInTheDocument();

    // "View order" to the order page; "Back to Event" unchanged.
    const viewOrder = screen.getByText("confirmation.viewOrder").closest("a");
    expect(viewOrder).toHaveAttribute("href", `/my-tickets/${baseProps.orderId}`);
    expect(screen.queryByText("confirmation.viewTickets")).not.toBeInTheDocument();
    expect(screen.getByText("confirmation.backToEvent").closest("a")).toHaveAttribute(
      "href",
      "/events/test-event",
    );
  });

  it("without the buyer's email, the email line still says tickets come when it clears", () => {
    render(<OrderConfirmation {...baseProps} payment="processing" order={order} />);
    expect(
      screen.getByText("confirmation.processingEmailNoAddress"),
    ).toBeInTheDocument();
    expect(screen.getByText("confirmation.processingFailNotice")).toBeInTheDocument();
    expect(screen.queryByText("confirmation.waiverAccepted")).not.toBeInTheDocument();
  });

  it("prints no ticket and leaves the tab unmarked, so the real print plays once paid", () => {
    const { container, unmount } = render(
      <OrderConfirmation
        {...baseProps}
        payment="processing"
        orderId="order-ach"
        order={order}
      />,
    );
    expect(card(container)!.classList.contains("conf-print-card--printed")).toBe(true);
    expect(window.sessionStorage.getItem("th:order-printed:order-ach")).toBeNull();
    unmount();

    // Paid later, same tab: the ticket prints for the first time.
    const paid = render(
      <OrderConfirmation {...baseProps} payment="paid" orderId="order-ach" order={order} />,
    );
    expect(card(paid.container)!.classList.contains("conf-print-card--printed")).toBe(false);
    expect(window.sessionStorage.getItem("th:order-printed:order-ach")).toBe("1");
  });

  it("paid: the screen as before", () => {
    render(
      <OrderConfirmation {...baseProps} order={order} buyerEmail="buyer@example.com" />,
    );
    expect(screen.getByText("confirmation.title")).toBeInTheDocument();
    expect(screen.getByText("confirmation.whatsNextTickets")).toBeInTheDocument();
    expect(screen.getByText("confirmation.whatsNextEntry")).toBeInTheDocument();
    expect(screen.getByText("confirmation.walletPassesAvailable")).toBeInTheDocument();
    expect(
      screen.getByText("confirmation.whatsNextEmail:buyer@example.com"),
    ).toBeInTheDocument();
    expect(screen.getByText("confirmation.viewTickets").closest("a")).toHaveAttribute(
      "href",
      `/my-tickets/${baseProps.orderId}`,
    );
    expect(screen.queryByText("confirmation.processingFailNotice")).not.toBeInTheDocument();
  });
});

describe("OrderConfirmation — the .ics UID is the event's id", () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const order = {
    amountGrossCents: 9000,
    feesPlatformCents: 60,
    buyerFeesCents: 60,
    processorFeeCents: 326,
    taxAmountCents: 799,
    feeMode: "PASS_THROUGH" as const,
  };
  const blobs: Blob[] = [];

  beforeEach(() => {
    blobs.length = 0;
    window.sessionStorage.clear();
    // The real downloadICalFile runs; only the browser hand-off is stubbed.
    URL.createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return "blob:ics";
    });
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });

  const readText = (blob: Blob) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
      reader.readAsText(blob);
    });

  const downloadIcs = async (eventName: string, eventId?: string) => {
    const { unmount } = render(
      <OrderConfirmation
        {...baseProps}
        eventName={eventName}
        eventId={eventId}
        order={order}
      />,
    );
    fireEvent.click(screen.getByText("confirmation.addToCalendar"));
    fireEvent.click(screen.getByText("confirmation.downloadIcs"));
    unmount();
    const text = await readText(blobs[blobs.length - 1]!);
    return text.replace(/\r?\n[ \t]/g, "");
  };

  it("UID is <eventId>@ithasfire, identical across two downloads and when the name changes", async () => {
    const first = await downloadIcs("Test Event", "evt_abc");
    const second = await downloadIcs("Test Event", "evt_abc");
    const renamed = await downloadIcs("Renamed Event", "evt_abc");

    expect(blobs).toHaveLength(3);
    for (const ics of [first, second, renamed]) {
      expect(ics.split(/\r?\n/)).toContain("UID:evt_abc@ithasfire");
    }
    expect(renamed).toContain("SUMMARY:Renamed Event");
  });
});

describe("OrderConfirmation — an unreadable event date", () => {
  const order = {
    amountGrossCents: 9000,
    feesPlatformCents: 60,
    buyerFeesCents: 60,
    processorFeeCents: 326,
    taxAmountCents: 799,
    feeMode: "PASS_THROUGH" as const,
    items: [],
  };

  it("shows Date TBA and no calendar link instead of throwing", () => {
    // `new Date("garbage")`: Intl format and `toISOString` both throw a
    // RangeError on it, which took the paid confirmation down.
    render(
      <OrderConfirmation
        {...baseProps}
        eventDate={new Date("not a date")}
        order={order}
      />,
    );

    expect(screen.getByText("common.dateNotSet")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /confirmation\.addToCalendar/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    // The rest of the confirmation still renders: the total charged.
    expect(screen.getByText("$101.85")).toBeInTheDocument();
  });

  it("a readable date keeps its label and its calendar links", () => {
    render(<OrderConfirmation {...baseProps} order={order} />);

    expect(screen.queryByText("common.dateNotSet")).not.toBeInTheDocument();
    expect(screen.getByText("date, date \u00B7 date")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /confirmation\.addToCalendar/ }),
    );
    const google = screen.getByRole("menuitem", {
      name: /confirmation\.addToGoogleCalendar/,
    });
    // 2026-09-01T20:00:00Z, in the Google Calendar dates= form.
    expect(google.getAttribute("href")).toContain("20260901T200000Z");
  });
});
