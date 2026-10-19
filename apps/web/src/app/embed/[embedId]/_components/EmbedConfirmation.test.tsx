import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import en from "@/i18n/messages/en";
import { generateICalString } from "@/lib/calendar/ical";
import type { EmbedCheckoutConfirmation } from "./embed-types";

// The translator reads the REAL app catalog, so a key the confirmation asks
// for that the catalog lacks shows up as the raw key.
vi.mock("@th/ui", () => ({
  useTranslations:
    () => (key: string, values?: Record<string, string | number>) => {
      const [block, name] = key.split(".");
      const value = (en as unknown as Record<string, Record<string, unknown>>)[
        block ?? ""
      ]?.[name ?? ""];
      if (typeof value !== "string") return key;
      return value.replace(/\{(\w+)\}/g, (_match, param: string) =>
        String(values?.[param] ?? `{${param}}`),
      );
    },
}));

// The .ics download is a blob handed to the browser: the test reads the
// event it was asked to write instead.
const ical = vi.hoisted(() => ({ downloaded: [] as unknown[] }));
vi.mock("@/lib/calendar/ical", async (original) => ({
  ...(await original<typeof import("@/lib/calendar/ical")>()),
  downloadICalFile: (event: unknown) => {
    ical.downloaded.push(event);
  },
}));

vi.mock("@/trpc", () => ({
  trpc: {
    embeds: {
      getEventDetail: {
        useQuery: () => ({
          data: {
            event: {
              id: "evt_embed",
              title: "Test Event",
              slug: "test-event",
              currency: "usd",
              startsAt: "2026-09-01T20:00:00Z",
              endsAt: null,
              addressText: null,
            },
            ticketTypes: [
              {
                id: "ticket-ga",
                name: "General Admission",
                priceCents: 4500,
                pricingMode: "FIXED",
                // Fee-inclusive per-unit estimate — 2× = $102.18, which is
                // 33¢ above the $101.85 the order actually charged.
                buyerUnitTotalCents: 5109,
              },
            ],
          },
        }),
      },
    },
  },
}));

vi.mock("@/lib/embed-host-origin", () => ({
  getEmbedHostOrigin: () => "https://host.example",
}));

vi.mock(
  "@/app/events/checkout/[...slug]/_components/CheckoutStepper",
  () => ({
    CheckoutStepper: () => <div data-testid="stepper" />,
  }),
);

import { EmbedConfirmation } from "./EmbedConfirmation";

/** The server's persisted lines for 2 × GA at the $45.00 face. */
const GA_TWO_AT_FACE = [
  {
    ticketTypeId: "ticket-ga",
    name: "General Admission",
    qty: 2,
    unitPriceCents: 4500,
    lineCents: 9000,
  },
];

describe("EmbedConfirmation order summary", () => {
  it("renders line items on the server order's base pricing, not the inclusive estimate", () => {
    render(
      <EmbedConfirmation
        embedId="embed-1"
        eventId="event-1"
        checkout={{
          orderId: "order-1",
          clientSecret: null,
          currency: "usd",
          orderFees: {
            amountGrossCents: 9000,
            feesPlatformCents: 60,
            buyerFeesCents: 60,
            processorFeeCents: 326,
            feeMode: "PASS_THROUGH",
            taxAmountCents: 799,
          },
          lineItems: GA_TWO_AT_FACE,
          billingAddress: null,
          waiverAccepted: false,
        }}
        email="buyer@example.com"
        onDone={() => {}}
        completedStepIds={[]}
      />,
    );

    // Line = 2 × $45.00 face, agreeing with the Subtotal row directly below.
    // Exact money throughout (the shared embed rows' format).
    expect(screen.getAllByText("$90.00")).toHaveLength(2);
    expect(screen.queryByText("$102.18")).not.toBeInTheDocument();
    // Total = 9000 + 60 + 326 + 799 = $101.85 (the charged amount).
    expect(screen.getByTestId("embed-confirmation-total-value").textContent).toBe("$101.85");
  });
});

describe("EmbedConfirmation — a zero-tax order (owner ruling 2026-10-01)", () => {
  it("regression: the Taxes row reads $0.00 — shown, with cents, not hidden", () => {
    render(
      <EmbedConfirmation
        embedId="embed-1"
        eventId="event-1"
        checkout={{
          orderId: "order-1",
          clientSecret: null,
          currency: "usd",
          orderFees: {
            amountGrossCents: 9000,
            feesPlatformCents: 60,
            buyerFeesCents: 60,
            processorFeeCents: 326,
            feeMode: "PASS_THROUGH",
            taxAmountCents: 0,
          },
          lineItems: GA_TWO_AT_FACE,
          billingAddress: null,
          waiverAccepted: false,
        }}
        email="buyer@example.com"
        onDone={() => {}}
        completedStepIds={[]}
      />,
    );
    expect(screen.getByTestId("embed-confirmation-tax-value").textContent).toBe("$0.00");
  });
});

describe("EmbedConfirmation — with a % promo the rows still add up", () => {
  it("regression: Subtotal pre-discount, a Discount row, Platform = what the buyer paid — the rows sum to the Total", () => {
    render(
      <EmbedConfirmation
        embedId="embed-1"
        eventId="event-1"
        checkout={{
          orderId: "order-1",
          clientSecret: null,
          currency: "usd",
          orderFees: {
            // 2 × $45 at face; 10% off → the server's gross $81.00.
            amountGrossCents: 8100,
            feesPlatformCents: 90,
            // A fee waiver: the buyer paid $0.60 of the $0.90 platform fee.
            buyerFeesCents: 60,
            processorFeeCents: 326,
            feeMode: "PASS_THROUGH",
            taxAmountCents: 719,
          },
          lineItems: GA_TWO_AT_FACE,
          billingAddress: null,
          waiverAccepted: false,
        }}
        email="buyer@example.com"
        onDone={() => {}}
        completedStepIds={[]}
      />,
    );
    const cents = (id: string) =>
      Math.round(Number((screen.getByTestId(id).textContent ?? "").replace(/[^0-9.]/g, "")) * 100);
    expect(cents("embed-confirmation-subtotal-value")).toBe(9000);
    expect(cents("embed-confirmation-discount-value")).toBe(900);
    expect(cents("embed-confirmation-platform-fee-value")).toBe(60);
    const total = cents("embed-confirmation-total-value");
    expect(total).toBe(8100 + 60 + 326 + 719);
    expect(
      cents("embed-confirmation-subtotal-value") +
        cents("embed-confirmation-platform-fee-value") +
        cents("embed-confirmation-processing-fee-value") +
        cents("embed-confirmation-tax-value") -
        cents("embed-confirmation-discount-value"),
    ).toBe(total);
  });
});

describe("EmbedConfirmation — the lines are the SERVER's, not a cart rebuild", () => {
  it("regression: prints the persisted order's lines even where the event's ticket types disagree (a price that moved, a PWYW amount)", () => {
    render(
      <EmbedConfirmation
        embedId="embed-1"
        eventId="event-1"
        checkout={{
          orderId: "order-1",
          clientSecret: null,
          currency: "usd",
          orderFees: {
            // 2 × $40.00 GA (the price the order was charged at, while the
            // event detail now lists $45.00) + 1 × $12.50 pay-what-you-want.
            amountGrossCents: 9250,
            feesPlatformCents: 90,
            buyerFeesCents: 90,
            processorFeeCents: 300,
            feeMode: "PASS_THROUGH",
            taxAmountCents: 0,
          },
          lineItems: [
            {
              ticketTypeId: "ticket-ga",
              name: "General Admission",
              qty: 2,
              unitPriceCents: 4000,
              lineCents: 8000,
            },
            {
              ticketTypeId: "ticket-pwyw",
              name: "Pay What You Want",
              qty: 1,
              unitPriceCents: 1250,
              lineCents: 1250,
            },
          ],
          billingAddress: null,
          waiverAccepted: false,
        }}
        email="buyer@example.com"
        onDone={() => {}}
        completedStepIds={[]}
      />,
    );

    const lines = screen
      .getAllByTestId("embed-confirmation-line-value")
      .map((el) => el.textContent);
    expect(lines).toEqual(["$80.00", "$12.50"]);
    // The event detail's $45.00 face never reaches the confirmation.
    expect(screen.queryByText("$90.00")).not.toBeInTheDocument();
    expect(screen.getByText(/Pay What You Want/)).toBeInTheDocument();
    // No promo: lines = gross, so no Discount row.
    expect(screen.queryByTestId("embed-confirmation-discount-value")).toBeNull();
    expect(screen.getByTestId("embed-confirmation-subtotal-value").textContent).toBe("$92.50");
    // Total unchanged: gross + platform + processing + tax = the charge.
    expect(screen.getByTestId("embed-confirmation-total-value").textContent).toBe("$96.40");
  });
});

describe("EmbedConfirmation — no server lines (a completed free order whose lines could not be read back)", () => {
  it("renders no line rows, no Discount row, and the Total from the order figures", () => {
    render(
      <EmbedConfirmation
        embedId="embed-1"
        eventId="event-1"
        checkout={{
          orderId: "order-1",
          clientSecret: null,
          currency: "usd",
          orderFees: {
            amountGrossCents: 2000,
            feesPlatformCents: 0,
            buyerFeesCents: 0,
            processorFeeCents: 0,
            feeMode: "PASS_THROUGH",
            taxAmountCents: 0,
          },
          lineItems: [],
          billingAddress: null,
          waiverAccepted: false,
        }}
        email="buyer@example.com"
        onDone={() => {}}
        completedStepIds={[]}
      />,
    );

    expect(screen.queryAllByTestId("embed-confirmation-line-value")).toHaveLength(0);
    // Σ lines (0) − gross is clamped at 0: no negative Discount row.
    expect(screen.queryByTestId("embed-confirmation-discount-value")).toBeNull();
    expect(screen.getByTestId("embed-confirmation-subtotal-value").textContent).toBe("$20.00");
    expect(screen.getByTestId("embed-confirmation-total-value").textContent).toBe("$20.00");
  });
});

// ── The tickets and the order code ──────────────────────────────────────────

/** One string of the real catalog's `checkout` block. */
const checkoutCopy = (name: string): string =>
  String(
    (en as unknown as Record<string, Record<string, unknown>>).checkout?.[name],
  );

const ORDER_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ORDER_CODE = "#7728950E";

/** A confirmed order, with whatever tickets the server sent for it. */
const confirmedOrder = (
  tickets?: EmbedCheckoutConfirmation["tickets"],
): EmbedCheckoutConfirmation => ({
  orderId: ORDER_ID,
  clientSecret: "pi_1_secret_x",
  currency: "usd",
  orderFees: {
    amountGrossCents: 9000,
    feesPlatformCents: 60,
    buyerFeesCents: 60,
    processorFeeCents: 326,
    feeMode: "PASS_THROUGH",
    taxAmountCents: 0,
  },
  lineItems: GA_TWO_AT_FACE,
  billingAddress: null,
  waiverAccepted: false,
  ...(tickets ? { tickets } : {}),
});

const renderConfirmation = (checkout: EmbedCheckoutConfirmation | null) =>
  render(
    <EmbedConfirmation
      embedId="embed-1"
      eventId="event-1"
      checkout={checkout}
      email="buyer@example.com"
      onDone={() => {}}
      completedStepIds={[]}
    />,
  );

describe("EmbedConfirmation — the order's tickets", () => {
  it("one ticket: its QR, its code as text, the door line, and the order code — above the event and the summary", () => {
    renderConfirmation(
      confirmedOrder([
        { code: "TCK-ONE-AAAA", ticketTypeName: "General Admission", seatLabel: null },
      ]),
    );

    const section = screen.getByRole("region", { name: "Your tickets" });
    expect(within(section).getByText(checkoutCopy("embedTicketsShowAtDoorOne"))).toBeInTheDocument();
    const qr = within(section).getByRole("img", {
      name: "Ticket code for General Admission",
    });
    // The QR is a real SVG on a literal white pad (the scanner's quiet zone).
    expect(qr.querySelector("svg")).not.toBeNull();
    expect(qr.style.background).toBe("white");
    expect(within(section).getByTestId("embed-ticket-code").textContent).toBe("TCK-ONE-AAAA");
    // One ticket has no "Ticket 1 of 1".
    expect(within(section).queryByText(/Ticket 1 of/)).toBeNull();
    // Still says where the email went.
    expect(screen.getByText("buyer@example.com")).toBeInTheDocument();
    expect(screen.getByTestId("embed-order-code").textContent).toBe(ORDER_CODE);

    // First on screen: before the Event block and the Order summary.
    const before = (later: HTMLElement) =>
      Boolean(section.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before(screen.getByText("Test Event"))).toBe(true);
    expect(before(screen.getByText("Order summary"))).toBe(true);
  });

  it("several tickets, one seated: each numbered, the seat shown, and every QR has its own accessible name", () => {
    renderConfirmation(
      confirmedOrder([
        { code: "TCK-A", ticketTypeName: "Balcony", seatLabel: "Balcony · Q5" },
        { code: "TCK-B", ticketTypeName: "Balcony", seatLabel: "Balcony · Q6" },
        { code: "TCK-C", ticketTypeName: "General Admission", seatLabel: null },
        { code: "TCK-D", ticketTypeName: "General Admission", seatLabel: null },
        { code: "TCK-E", ticketTypeName: null, seatLabel: null },
        { code: "TCK-F", ticketTypeName: null, seatLabel: "Floor · A1" },
      ]),
    );

    const section = screen.getByRole("region", { name: "Your tickets" });
    expect(within(section).getByText(checkoutCopy("embedTicketsShowAtDoorMany"))).toBeInTheDocument();
    expect(within(section).getAllByRole("listitem")).toHaveLength(6);
    expect(
      within(section).getAllByTestId("embed-ticket-code").map((el) => el.textContent),
    ).toEqual(["TCK-A", "TCK-B", "TCK-C", "TCK-D", "TCK-E", "TCK-F"]);
    expect(within(section).getByText("Ticket 1 of 6")).toBeInTheDocument();
    expect(within(section).getByText("Ticket 6 of 6")).toBeInTheDocument();
    // The seat label as the server sends it: section and seat, no prefix.
    expect(within(section).getByText("Balcony · Q5")).toBeInTheDocument();
    expect(within(section).queryByText(/Seat /)).toBeNull();

    const names = within(section)
      .getAllByRole("img")
      .map((img) => img.getAttribute("aria-label"));
    expect(names).toEqual([
      "Ticket code for Balcony, Balcony · Q5, ticket 1 of 6",
      "Ticket code for Balcony, Balcony · Q6, ticket 2 of 6",
      "Ticket code for General Admission, ticket 3 of 6",
      "Ticket code for General Admission, ticket 4 of 6",
      "Ticket code, ticket 5 of 6",
      "Ticket code, Floor · A1, ticket 6 of 6",
    ]);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each([
    ["no tickets field (an API older than this web build)", undefined],
    ["an empty list (the server withheld the codes)", []],
  ])("%s → today's screen plus the order code: no tickets heading, no door line", (_case, tickets) => {
    renderConfirmation({ ...confirmedOrder(), ...(tickets ? { tickets } : {}) });

    expect(screen.queryByText("Your tickets")).toBeNull();
    expect(screen.queryByTestId("embed-tickets")).toBeNull();
    expect(screen.queryByText(checkoutCopy("embedTicketsShowAtDoorOne"))).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
    // What the screen said before, it still says.
    expect(screen.getByText("Order confirmed")).toBeInTheDocument();
    expect(screen.getByText("buyer@example.com")).toBeInTheDocument();
    expect(screen.getByText("Order summary")).toBeInTheDocument();
    expect(screen.getByText("Wallet passes")).toBeInTheDocument();
    expect(screen.getByTestId("embed-order-code").textContent).toBe(ORDER_CODE);
  });
});

describe("EmbedConfirmation — calendar entries link to the event with a full URL", () => {
  // A calendar entry is read outside any page: "/events/<slug>" leads nowhere.
  const EVENT_URL = /https?:\/\/[^\s/\\]+\/events\/test-event(?![\w-])/;

  it("Google, Outlook and the .ics all carry an absolute /events/<slug> URL, and no bare path", () => {
    ical.downloaded.length = 0;
    renderConfirmation(confirmedOrder());

    const described = (name: string) => {
      const href = screen.getByRole("link", { name }).getAttribute("href") ?? "";
      const url = new URL(href);
      return [...url.searchParams.values()].join("\n");
    };
    for (const name of ["Google", "Outlook"]) {
      expect(described(name)).toMatch(EVENT_URL);
      expect(described(name)).not.toContain("Event: /events/");
    }

    fireEvent.click(screen.getByRole("button", { name: "iCal" }));
    expect(ical.downloaded).toHaveLength(1);
    // Unfolded: an .ics line longer than 75 octets continues on the next.
    const ics = generateICalString(
      ical.downloaded[0] as Parameters<typeof generateICalString>[0],
    ).replace(/\r?\n[ \t]/g, "");
    expect(ics).toMatch(EVENT_URL);
    expect(ics).not.toContain("Event: /events/");
  });
});

describe("EmbedConfirmation — the .ics UID is the event's id", () => {
  it("the downloaded event carries the event id, so the UID is <id>@ithasfire and stable", () => {
    ical.downloaded.length = 0;
    renderConfirmation(confirmedOrder());
    fireEvent.click(screen.getByRole("button", { name: "iCal" }));
    fireEvent.click(screen.getByRole("button", { name: "iCal" }));

    expect(ical.downloaded).toHaveLength(2);
    const uids = ical.downloaded.map(
      (event) =>
        generateICalString(event as Parameters<typeof generateICalString>[0])
          .split(/\r?\n/)
          .find((line) => line.startsWith("UID:")),
    );
    expect(uids[0]).toBe("UID:evt_embed@ithasfire");
    expect(uids[0]).toBe(uids[1]);
  });
});
