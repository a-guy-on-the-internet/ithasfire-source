import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

/**
 * The wallet row's amount is Total paid (`charges.totalCents` from
 * `listMyOrders`), not the ticket gross: gross left out the fees and tax a
 * pass-through buyer paid.
 */

vi.mock("@bprogress/next/app", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("tamagui", () => {
  const Stack = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return { Card: Stack, XStack: Stack, YStack: Stack };
});
vi.mock("@th/ui", () => ({
  Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Button: ({ children }: { children?: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  TicketWalletCard: ({ meta }: { meta: Array<string | undefined> }) => (
    <div data-testid="wallet-meta">{meta.filter(Boolean).join(" · ")}</div>
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

const order = (totalCents: number | null): OrderItem => ({
  id: "11111111-1111-4111-8111-111111111111",
  eventId: "22222222-2222-4222-8222-222222222222",
  eventSlug: null,
  eventName: "Show",
  eventStartsAt: new Date("2026-10-04T21:00:00Z"),
  eventVenue: null,
  amountGrossCents: 1000,
  charges: totalCents === null ? null : { totalCents },
  currency: "usd",
  status: "SUCCEEDED",
  occurredAt: new Date("2026-09-01T00:00:00Z"),
  ticketCount: 1,
  tiers: ["GA"],
});

describe("OrderCard amount", () => {
  it("PASS_THROUGH: shows Total paid ($11.86), not the $10.00 gross", () => {
    render(<OrderCard order={order(1186)} />);
    const meta = screen.getByTestId("wallet-meta").textContent ?? "";
    expect(meta).toContain("usd:1186");
    expect(meta).not.toContain("usd:1000");
  });

  it("ABSORB: shows face + tax ($10.89)", () => {
    render(<OrderCard order={order(1089)} />);
    expect(screen.getByTestId("wallet-meta").textContent).toContain("usd:1089");
  });

  it("a transferred-in ticket (charges null): no amount at all", () => {
    render(<OrderCard order={order(null)} />);
    const meta = screen.getByTestId("wallet-meta").textContent ?? "";
    expect(meta).not.toMatch(/usd:/);
    expect(meta).toContain("myTickets.nTickets");
  });
});
