import React from "react";
import type { ReactNode } from "react";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TranslationProvider } from "@th/ui";
import type { Messages } from "@th/ui";
import enPackage from "@th/locale/messages/en.json";

import enApp from "@/i18n/messages/en";

/**
 * The printable ticket sheet renders a BEARER CREDENTIAL, so the assertions
 * that matter here are about what does and does not reach the paper:
 *  - only printable tickets produce a stub,
 *  - the QR points at the shared /tickets/qr/[code] route with the raw ticket
 *    code as the payload (so print, wallet and screen scan identically),
 *  - the empty case says why instead of printing blank paper.
 *
 * Note what a jsdom test CANNOT see: `@media print`, `@page`, `print-color-
 * adjust`, or whether the printed QR is dark-on-white. Those are verified in a
 * real browser with `page.emulateMedia({ media: "print" })`.
 */

const orderQuery = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));
const ticketsQuery = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));

vi.mock("@/trpc", () => ({
  trpc: {
    orders: {
      getMyOrder: { useQuery: () => orderQuery.current },
      listMyOrderTickets: { useQuery: () => ticketsQuery.current },
    },
  },
}));

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: { user: { name: "Liam Nguyen", email: "liam@example.com" } },
    }),
  },
}));

/**
 * Real `@th/ui` except the Tamagui `Button`, which needs a TamaguiProvider /
 * theme that jsdom has no business booting. Everything the assertions depend on
 * — `useTranslations`, `useFormatters` — stays REAL, so the copy under test is
 * the shipped copy, not a stub.
 */
vi.mock("@th/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@th/ui")>();
  return {
    ...actual,
    Button: ({
      children,
      tabIndex,
      ...rest
    }: { children?: ReactNode; tabIndex?: number } & Record<
      string,
      unknown
    >) => {
      const domProps: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(rest)) {
        if (key.startsWith("data-") || key.startsWith("aria-")) {
          domProps[key] = value;
        }
      }
      // `tabIndex` is forwarded explicitly, unlike the rest of the Tamagui
      // surface: the back link's second tab stop is a real defect this file
      // guards, and a stub that swallowed the prop would report it fixed.
      return (
        <button {...domProps} tabIndex={tabIndex}>
          {children}
        </button>
      );
    },
  };
});

/**
 * The gate's own rendering is covered in `EmailVerificationRequired.test.tsx`;
 * here only which context the sheet asks for matters.
 */
vi.mock("@/components/auth/EmailVerificationRequired", () => ({
  EmailVerificationRequired: ({
    context,
    testId,
  }: {
    context?: string;
    testId?: string;
  }) => <div data-testid={testId} data-context={context} />,
}));

import { TicketPrintSheet } from "../TicketPrintSheet";

/** Shared catalog + the app's overrides — the same merge the stories use. */
const mergeCatalogs = (base: Messages, override: Messages): Messages => {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = result[key];
    if (
      typeof value === "object" &&
      value !== null &&
      typeof existing === "object" &&
      existing !== null
    ) {
      result[key] = mergeCatalogs(existing as Messages, value as Messages);
    } else {
      result[key] = value;
    }
  }
  return result as Messages;
};

const messages = mergeCatalogs(enPackage as unknown as Messages, enApp);

const renderSheet = (orderId: string) =>
  render(
    <TranslationProvider locale="en" messages={messages}>
      <TicketPrintSheet orderId={orderId} />
    </TranslationProvider>,
  );

const ORDER_ID = "3d1f0b62-8a4c-4f1e-9a70-1c2ddb21b2c3";

const baseOrder = {
  id: ORDER_ID,
  status: "SUCCEEDED",
  eventName: "Basement Show at the Mill",
  eventStartsAt: new Date("2026-09-12T02:00:00.000Z"),
  eventVenue: "412 Mill St, Nashville",
  organiserName: "Dev QA Collective",
  ticketTypeNames: { "tt-ga": "General Admission" },
  items: [
    { id: "item-1", transferredAt: null },
    { id: "item-2", transferredAt: new Date("2026-08-01T00:00:00.000Z") },
  ],
};

const baseTickets = {
  tickets: [
    {
      id: "ticket-1",
      code: "TKT-AAAA1111",
      status: "VALID",
      orderItemId: "item-1",
      ticketTypeId: "tt-ga",
    },
    // Transferred: still VALID, must NOT produce a stub.
    {
      id: "ticket-2",
      code: "TKT-BBBB2222",
      status: "VALID",
      orderItemId: "item-2",
      ticketTypeId: "tt-ga",
    },
    // Scanned: must NOT produce a stub.
    {
      id: "ticket-3",
      code: "TKT-CCCC3333",
      status: "SCANNED",
      orderItemId: null,
      ticketTypeId: "tt-ga",
    },
  ],
};

beforeEach(() => {
  orderQuery.current = { data: baseOrder, isLoading: false, error: null };
  ticketsQuery.current = { data: baseTickets, isLoading: false, error: null };
});

describe("TicketPrintSheet", () => {
  it("renders a stub only for printable tickets", () => {
    renderSheet(ORDER_ID);

    expect(
      screen.getByTestId("ticket-print-stub-ticket-1"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("ticket-print-stub-ticket-2")).toBeNull();
    expect(screen.queryByTestId("ticket-print-stub-ticket-3")).toBeNull();
  });

  it("never puts a non-printable ticket's code on the paper", () => {
    renderSheet(ORDER_ID);

    expect(screen.getByText("TKT-AAAA1111")).toBeInTheDocument();
    expect(screen.queryByText("TKT-BBBB2222")).toBeNull();
    expect(screen.queryByText("TKT-CCCC3333")).toBeNull();
  });

  it("points the QR at the shared route with the RAW ticket code as payload", () => {
    const { container } = renderSheet(ORDER_ID);

    const qr = container.querySelector<HTMLImageElement>(".th-ticket-qr__img");
    expect(qr).not.toBeNull();
    // Same payload the wallet passes and the scanner use — the door must not
    // care which surface produced the code.
    expect(qr?.getAttribute("src")).toBe("/tickets/qr/TKT-AAAA1111");
  });

  it("shows the order code, an unambiguous count and the print stamp", () => {
    renderSheet(ORDER_ID);

    const meta = screen.getByTestId("ticket-print-meta");
    // formatOrderCode: the 8-hex TAIL of the order UUID, uppercased.
    expect(within(meta).getByText(/DB21B2C3/)).toBeInTheDocument();
    // "1 of 3 tickets" would read as "ticket 1 of 3" on a stub that IS one of
    // several. When some tickets are held back the sheet says "Showing …".
    expect(
      within(meta).getByText("Showing 1 of 3 tickets"),
    ).toBeInTheDocument();
    expect(within(meta).queryByText(/^1 of 3/)).toBeNull();
    expect(within(meta).getByText(/^Printed /)).toBeInTheDocument();
  });

  it("says the plain ticket count when the whole order is on the sheet", () => {
    ticketsQuery.current = {
      data: { tickets: [baseTickets.tickets[0]] },
      isLoading: false,
      error: null,
    };

    renderSheet(ORDER_ID);

    const meta = screen.getByTestId("ticket-print-meta");
    expect(within(meta).getByText("1 ticket")).toBeInTheDocument();
    expect(within(meta).queryByText(/Showing/)).toBeNull();
  });

  it("names the viewer's timezone on the printed time — paper cannot re-render when you travel", () => {
    const { container } = renderSheet(ORDER_ID);

    const sub = container.querySelector(".th-ticket-field__sub");
    // `timeZoneName: "short"` appends e.g. "UTC" / "CDT" after the clock time.
    expect(sub?.textContent).toMatch(/^Starts \d{1,2}:\d{2}\s?(AM|PM)\s\S+/);
  });

  it("carries the tear-off column: order ref, what it admits, and a door-initial box", () => {
    const { container } = renderSheet(ORDER_ID);

    const tear = container.querySelector(".th-ticket-stub__tear");
    expect(tear).not.toBeNull();
    expect(
      within(tear as HTMLElement).getByText("DB21B2C3"),
    ).toBeInTheDocument();
    expect(
      within(tear as HTMLElement).getByText("1 · General Admission"),
    ).toBeInTheDocument();
    expect(
      (tear as HTMLElement).querySelector(".th-ticket-stub__initial"),
    ).not.toBeNull();
  });

  it("explains an order with nothing printable instead of rendering an empty sheet", () => {
    ticketsQuery.current = {
      data: {
        tickets: [
          {
            id: "ticket-3",
            code: "TKT-CCCC3333",
            status: "REFUNDED",
            orderItemId: "item-1",
            ticketTypeId: "tt-ga",
          },
        ],
      },
      isLoading: false,
      error: null,
    };

    renderSheet(ORDER_ID);

    expect(screen.getByTestId("ticket-print-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("ticket-print-stub-ticket-3")).toBeNull();
  });

  it("says tickets are still coming for a PROCESSING order, not that they were refunded", () => {
    // PROCESSING sits beside PENDING in orderStatusSchema and is written on the
    // Stripe webhook path. Both mean "not issued yet", which is a different
    // story from "transferred / refunded / already scanned".
    orderQuery.current = {
      data: { ...baseOrder, status: "PROCESSING" },
      isLoading: false,
      error: null,
    };
    ticketsQuery.current = {
      data: { tickets: [] },
      isLoading: false,
      error: null,
    };

    renderSheet(ORDER_ID);

    const empty = screen.getByTestId("ticket-print-empty");
    expect(empty).toHaveTextContent(/issued once payment is confirmed/i);
    expect(empty).not.toHaveTextContent(/refunded/i);
  });

  it("does NOT blame refunds/transfers when the TICKETS query itself failed", () => {
    // The regression this guards: `printableTickets` is empty for two very
    // different reasons, and reporting a transport failure as "these were
    // transferred, refunded or already scanned" tells a buyer at a door that
    // their tickets are gone — while the order page one click away shows them.
    ticketsQuery.current = {
      data: undefined,
      isLoading: false,
      error: { message: "INTERNAL_SERVER_ERROR" },
    };

    renderSheet(ORDER_ID);

    expect(
      screen.getByTestId("ticket-print-tickets-error"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("ticket-print-empty")).toBeNull();
    expect(
      screen.queryByText(/transferred, refunded, listed for resale/i),
    ).toBeNull();
  });

  it("does not read the session during the first render — hydration guard", async () => {
    // `authClient.useSession()` reports `isPending: true` on the server pass but
    // can resolve SYNCHRONOUSLY on the client's first render from its own
    // store. Reading it during render therefore made the server omit the
    // "Ticket holder" field while the client's first render emitted it — an
    // extra element at hydration, which tears the tree down and rebuilds it.
    // The identical mechanism took `/my-volunteering/hours/print` down.
    //
    // `renderToString` runs WITHOUT effects, which is exactly the condition the
    // server pass and the client's first render share. The holder name must be
    // absent from it even though the mocked session is fully resolved and
    // signed in.
    const { renderToString } = await import("react-dom/server");

    const html = renderToString(
      <TranslationProvider locale="en" messages={messages}>
        <TicketPrintSheet orderId={ORDER_ID} />
      </TranslationProvider>,
    );

    // The document itself rendered (this is not a vacuous pass)…
    expect(html).toContain("TKT-AAAA1111");
    // …but nothing session-derived reached it.
    expect(html).not.toContain("Liam Nguyen");
    expect(html).not.toContain("liam@example.com");
    expect(html).not.toContain("Ticket holder");
  });

  it("shows the ticket holder once mounted", () => {
    // The guard must delay the field, never drop it.
    renderSheet(ORDER_ID);

    expect(screen.getByText("Liam Nguyen")).toBeInTheDocument();
    expect(screen.getByText("Ticket holder")).toBeInTheDocument();
  });

  it("says the order could not be loaded rather than rendering a blank document", () => {
    orderQuery.current = {
      data: undefined,
      isLoading: false,
      error: { message: "ORDER_NOT_FOUND" },
    };

    renderSheet(ORDER_ID);

    expect(screen.getByTestId("ticket-print-not-found")).toBeInTheDocument();
  });

  it.each([
    ["order", orderQuery],
    ["tickets", ticketsQuery],
  ] as const)(
    "asks to verify the email for the tickets when the %s read is withheld",
    (_label, query) => {
      query.current = {
        data: undefined,
        isLoading: false,
        error: { data: { appCode: "email_verification_required" } },
      };
      renderSheet(ORDER_ID);

      const gate = screen.getByTestId("ticket-print-verify-email");
      expect(gate).toHaveAttribute("data-context", "printTickets");
      expect(screen.queryByTestId("ticket-print-not-found")).toBeNull();
    },
  );

  it("gives the back link a single tab stop, not two with the same name", () => {
    // `NextLinkAnchor`/`Link` wrapping a `Button tag="span"` is the toolbar
    // idiom on ALL THREE print documents, and Tamagui's Button renders a
    // FOCUSABLE span even under `tag="span"` — so the anchor and its own
    // label were two consecutive tab stops reading "Back to order" both
    // times. Found by tabbing through the volunteer badge sheet in a browser;
    // fixed on every document that shares the idiom, and guarded on each so
    // they cannot drift back apart one at a time.
    renderSheet(ORDER_ID);

    const link = screen.getByRole("link", { name: /back to order/i });
    expect(link.querySelector("[tabindex]")?.getAttribute("tabindex")).toBe(
      "-1",
    );
  });
});
