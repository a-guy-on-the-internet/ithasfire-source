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
      "admin.pstStatusPending": "Pending",
      "admin.pstStatusTransferred": "Transferred",
      "admin.pstStatusFailed": "Failed",
    };
    return dictionary[key] ?? key;
  },
}));

vi.mock("@/lib/format", () => ({
  fmtCurrency: (_fmt: unknown, cents: number, currency: string) =>
    `${currency}:${cents}`,
  fmtDateShort: () => "Jul 1, 2026",
  truncateId: (id: string) => (id.length > 8 ? `${id.slice(0, 8)}...` : id),
}));

import {
  SettlementMobileCard,
  type SettlementMobileCardRow,
} from "../SettlementMobileCard";

const baseRow: SettlementMobileCardRow = {
  id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  payeeLabel: "Velvet Room LLC",
  payeeSubjectId: "org_9876543210",
  eventTitle: "Solstice Bonfire",
  amountCents: 12345,
  currency: "usd",
  status: "transferred",
  scheduledPayoutDate: new Date("2026-07-01T00:00:00Z"),
};

describe("SettlementMobileCard (platform)", () => {
  it("renders payee, status badge, amount, payout date, event, and mono id", () => {
    render(<SettlementMobileCard row={baseRow} />);

    expect(screen.getByText("Velvet Room LLC")).toBeInTheDocument();
    expect(screen.getByText("Transferred")).toHaveAttribute(
      "data-tone",
      "success",
    );
    expect(screen.getByText("usd:12345")).toBeInTheDocument();
    expect(screen.getByText("Jul 1, 2026")).toBeInTheDocument();
    expect(screen.getByText("Solstice Bonfire")).toBeInTheDocument();
    expect(screen.getByText("a1b2c3d4...")).toBeInTheDocument();
  });

  it("falls back to the truncated payee id and tones failed settlements", () => {
    render(
      <SettlementMobileCard
        row={{
          ...baseRow,
          payeeLabel: null,
          eventTitle: null,
          status: "failed",
        }}
      />,
    );

    expect(screen.getByText("org_9876...")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toHaveAttribute("data-tone", "danger");
    expect(screen.queryByText("Solstice Bonfire")).not.toBeInTheDocument();
  });
});
