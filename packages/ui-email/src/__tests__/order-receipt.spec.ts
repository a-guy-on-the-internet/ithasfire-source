import { describe, expect, it } from "vitest";

import { render, sampleInputFor } from "..";

/**
 * `order.receipt` as the door-sale receipt (spec 2026-10-07 door-sales
 * FR-011): no buyer name on file, a payment method, a currency, and one line
 * per tax imposition. The resale receipt (name, no method, USD) is unchanged.
 */
describe("order.receipt", () => {
  const doorReceipt = {
    orderId: "DB21B2C3",
    lineItems: [
      { label: "General admission × 2", amountCents: 5000 },
      { label: "Platform fee", amountCents: 600 },
      { label: "Processing fee", amountCents: 347 },
      { label: "Sales tax (9.75%)", amountCents: 970 },
    ],
    totalCents: 6917,
    eventTitle: "Parity Night",
    viewOrderUrl: "https://ithasfire.test/my-tickets/abc",
    paymentMethod: "Card",
    currency: "usd",
  };

  it("renders a door receipt: no name, the payment method, every tax line, the total", async () => {
    const { html, text } = await render({
      templateId: "order.receipt",
      props: doorReceipt,
    });
    expect(html).toContain("Thanks for your purchase!");
    expect(html).not.toContain("Thanks for your purchase, ");
    expect(html).toContain("Payment");
    expect(html).toContain("Card");
    expect(html).toContain("Sales tax (9.75%)");
    expect(html).toContain("$9.70");
    expect(html).toContain("Processing fee");
    expect(html).toContain("$69.17");
    expect(text).toContain("Sales tax (9.75%)");
  });

  it("formats in the order's currency", async () => {
    const { html } = await render({
      templateId: "order.receipt",
      props: { ...doorReceipt, currency: "cad" },
    });
    expect(html).toContain("CA$69.17");
  });

  it("the resale receipt (named buyer, no method) renders as before", async () => {
    const { html } = await render({
      templateId: "order.receipt",
      props: sampleInputFor("order.receipt"),
    });
    expect(html).toContain("Jordan Alvarez");
    expect(html).toContain("Thanks for your purchase, ");
    expect(html).not.toContain(">Payment<");
    expect(html).toContain("$252.00");
    expect(html).toContain("View order details");
    expect(html).toContain('href="https://ithasfire.com/orders/ORD-83920"');
    expect(html).toContain("visit your order page for help");
    expect(html).not.toContain("Here&#x27;s your ticket");
    expect(html).not.toContain("complimentary");
    expect(html).toContain("merchant of record for this purchase");
  });

  it("a comp reads as a gift, not a purchase", async () => {
    const { html, text } = await render({
      templateId: "order.receipt",
      props: {
        ...doorReceipt,
        lineItems: [{ label: "General admission × 2", amountCents: 0 }],
        totalCents: 0,
        paymentMethod: "Complimentary",
        complimentary: true,
      },
    });
    expect(text).toContain("Here's your ticket!");
    expect(text).toContain("This receipt records your complimentary order for Parity Night.");
    expect(html).not.toContain("Thanks for your purchase");
    expect(html).not.toContain("merchant of record");
    expect(html).toContain("$0.00");
  });

  it("…with the buyer's name when there is one", async () => {
    const { text } = await render({
      templateId: "order.receipt",
      props: { ...doorReceipt, buyerName: "Sam", complimentary: true },
    });
    expect(text).toContain("Here's your ticket, Sam!");
  });

  it("a guest receipt (no order link) has no dead-end button and points at the ticket email", async () => {
    const { viewOrderUrl: _omit, ...guest } = doorReceipt;
    const { html, text } = await render({
      templateId: "order.receipt",
      props: guest,
    });
    expect(html).not.toContain("View order details");
    expect(html).not.toContain("/my-tickets/");
    expect(html).not.toContain("visit your order page");
    expect(text).toContain("Your ticket and its QR code are in a separate email.");
    expect(html).toContain("$69.17");
  });
});
