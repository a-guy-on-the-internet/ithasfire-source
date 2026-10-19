import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

/**
 * A wallet row that is not scannable shows its order status. A PROCESSING
 * order (a US bank debit that has not cleared and can still fail) used to
 * show the raw enum "PROCESSING"; it reads "Payment processing" in the
 * warning tone.
 */

vi.mock("@bprogress/next/app", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("tamagui", () => {
  const Stack = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return { Card: Stack, XStack: Stack, YStack: Stack };
});
vi.mock("@th/ui", () => ({
  Badge: ({ children, tone }: { children?: ReactNode; tone?: string }) => (
    <span data-tone={tone}>{children}</span>
  ),
  Button: ({ children }: { children?: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  TicketWalletCard: ({ badge }: { badge?: ReactNode }) => (
    <div data-testid="wallet-badge">{badge}</div>
  ),
  useFormatters: () => ({ dateTime: () => "x" }),
  useTranslations: () => (key: string) => key,
}));
vi.mock("@/lib/format", () => ({
  fmtCurrency: (_fmt: unknown, cents: number, currency: string) =>
    `${currency}:${cents}`,
}));
vi.mock("../primitives", () => ({ SkeletonPulse: () => null }));

import { OrderCard, type OrderItem } from "../OrderCard";

const order = (status: string): OrderItem => ({
  id: "11111111-1111-4111-8111-111111111111",
  eventId: "22222222-2222-4222-8222-222222222222",
  eventSlug: null,
  eventName: "Show",
  eventStartsAt: new Date("2026-10-04T21:00:00Z"),
  eventVenue: null,
  amountGrossCents: 1000,
  charges: { totalCents: 1186 },
  currency: "usd",
  status,
  occurredAt: new Date("2026-09-01T00:00:00Z"),
  ticketCount: 1,
  tiers: ["GA"],
});

describe("OrderCard status badge", () => {
  it("PROCESSING reads 'Payment processing' in the warning tone, never the raw enum", () => {
    render(<OrderCard order={order("PROCESSING")} />);
    const badge = screen.getByText("myTickets.paymentProcessing");
    expect(badge).toHaveAttribute("data-tone", "warning");
    expect(screen.queryByText("PROCESSING")).not.toBeInTheDocument();
  });

  it("PENDING still reads Pending", () => {
    render(<OrderCard order={order("PENDING")} />);
    expect(screen.getByText("myTickets.pending")).toHaveAttribute(
      "data-tone",
      "warning",
    );
  });
});
