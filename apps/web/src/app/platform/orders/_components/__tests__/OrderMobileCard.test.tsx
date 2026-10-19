import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", null, children);
  return { XStack: Stack, YStack: Stack, Stack, styled: () => Stack };
});

vi.mock("@th/ui", () => ({
  Badge: ({ children, tone }: { children?: ReactNode; tone?: string }) => (
    <span data-tone={tone}>{children}</span>
  ),
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  useFormatters: () => ({}),
  useTranslations: () => (key: string) => {
    const dictionary: Record<string, string> = {
      "admin.unknownBuyer": "Unknown buyer",
      "admin.plSourceResale": "Resale",
    };
    return dictionary[key] ?? key;
  },
}));

// Locale-dependent formatters are stubbed so the assertions don't depend on
// the runner's Intl data. `formatOrderCode` is deliberately NOT stubbed — it is
// the thing under test here, and a stub of it is exactly how the card came to
// render the HEAD of the UUID while every other order surface rendered the
// TAIL. (`truncateId` was mocked here and is no longer imported by the card.)
vi.mock("@/lib/format", () => ({
  fmtCurrency: (_fmt: unknown, cents: number, currency: string) =>
    `${currency}:${cents}`,
  fmtDate: () => "Jun 1, 2026",
}));

// Reuse the table's status badge contract without pulling its Tamagui deps.
// (Path is relative to this test file: __tests__ → _components → orders →
// platform → app, then into the admin tree.)
vi.mock(
  "../../../../admin/[slug]/orders/_components/OrderStatusBadge",
  () => ({
    OrderStatusBadge: ({ status }: { status: string }) => (
      <span data-testid="status-badge">{status}</span>
    ),
  }),
);

// The card only needs the SOURCE_LABEL_KEY map, not the detail panel itself.
vi.mock("../OrderDetailPanel", () => ({
  SOURCE_LABEL_KEY: {
    PRIMARY: "admin.plSourcePrimary",
    RESALE: "admin.plSourceResale",
  },
}));

import { formatOrderCode } from "@th/types/order-identifier";

import {
  OrderMobileCard,
  type OrderMobileCardRow,
} from "../OrderMobileCard";

/** A real `Order.id` shape — the code is its LAST 8 hex chars, not its first. */
const ORDER_ID = "9f2c1d4e-77a1-4b3c-8d55-1122db21b2c3";

const baseRow: OrderMobileCardRow = {
  id: ORDER_ID,
  buyerName: "Mika Vigeant",
  eventTitle: "Solstice Bonfire",
  amountGrossCents: 12345,
  currency: "usd",
  status: "SUCCEEDED",
  source: "PRIMARY",
  occurredAt: new Date("2026-06-01T00:00:00Z"),
};

describe("OrderMobileCard", () => {
  it("renders buyer, status badge, event, date, amount, and mono order code", () => {
    render(<OrderMobileCard row={baseRow} />);

    expect(screen.getByText("Mika Vigeant")).toBeInTheDocument();
    expect(screen.getByTestId("status-badge")).toHaveTextContent("SUCCEEDED");
    expect(screen.getByText("Solstice Bonfire")).toBeInTheDocument();
    expect(screen.getByText("Jun 1, 2026")).toBeInTheDocument();
    expect(screen.getByText("usd:12345")).toBeInTheDocument();
    expect(screen.getByText("#DB21B2C3")).toBeInTheDocument();
    // Primary orders do not flag a source badge, like the table default.
    expect(screen.queryByText("Resale")).not.toBeInTheDocument();
  });

  /**
   * The regression this file now guards: the card rendered `truncateId(row.id)`
   * — the HEAD of the UUID — while the detail panel it opens rendered the TAIL,
   * so one order showed two codes. Worse, the head is also 8 hex characters, so
   * `orderIdentifierFromQuery` accepts it, builds an `id endsWith <head>`
   * clause and matches NOTHING: a silent dead end rather than a visible error.
   */
  it("renders the shared order code, never the head of the UUID", () => {
    render(<OrderMobileCard row={baseRow} />);

    expect(screen.getByText(`#${formatOrderCode(ORDER_ID)}`)).toBeInTheDocument();
    expect(
      screen.queryByText(new RegExp(ORDER_ID.slice(0, 8), "i")),
    ).not.toBeInTheDocument();
  });

  it("falls back to unknown buyer and flags resale orders", () => {
    render(
      <OrderMobileCard
        row={{ ...baseRow, buyerName: null, source: "RESALE" }}
      />,
    );

    expect(screen.getByText("Unknown buyer")).toBeInTheDocument();
    expect(screen.getByText("Resale")).toHaveAttribute("data-tone", "info");
  });
});
