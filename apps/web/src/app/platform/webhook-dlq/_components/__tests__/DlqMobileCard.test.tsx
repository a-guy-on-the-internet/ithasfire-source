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
}));

vi.mock("@/lib/format", () => ({
  truncateId: (id: string) => (id.length > 8 ? `${id.slice(0, 8)}...` : id),
  truncateProviderId: (id: string) =>
    id.length > 16 ? `${id.slice(0, 10)}…${id.slice(-5)}` : id,
}));

import { DlqMobileCard, type DlqMobileCardRow } from "../DlqMobileCard";

const baseRow: DlqMobileCardRow = {
  stripeEventId: "evt_1Pabcdefghijklmno",
  eventType: "payment_intent.payment_failed",
  error: "No order found for payment intent pi_123",
  receivedAt: "2026-06-12T10:30:00Z",
};

describe("DlqMobileCard", () => {
  it("renders truncated event id, type badge, error, and received time", () => {
    render(<DlqMobileCard row={baseRow} />);

    // Head+tail, not head-only: Stripe ids are time-ordered, so rows that
    // failed near each other share a prefix and head-truncation renders them
    // identically. See `truncateProviderId`.
    expect(screen.getByText("evt_1Pabcd…klmno")).toBeInTheDocument();
    expect(
      screen.getByText("payment_intent.payment_failed"),
    ).toHaveAttribute("data-tone", "neutral");
    expect(
      screen.getByText("No order found for payment intent pi_123"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(new Date(baseRow.receivedAt).toLocaleString()),
    ).toBeInTheDocument();
  });
});
