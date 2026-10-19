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
      "admin.ptStatusValid": "Valid",
      "admin.ptStatusScanned": "Scanned",
      "admin.ptStatusInvalid": "Invalid",
      "admin.ptStatusRefunded": "Refunded",
      "admin.ptStatusListed": "Listed",
      "admin.ptUnknownOwner": "Unknown owner",
    };
    return dictionary[key] ?? key;
  },
}));

vi.mock("@/lib/format", () => ({
  fmtDate: () => "Jun 12, 2026",
}));

import {
  TicketMobileCard,
  type TicketMobileCardRow,
} from "../TicketMobileCard";

const baseRow: TicketMobileCardRow = {
  code: "TKT-A1B2C3D4",
  status: "VALID",
  ownerName: "Jamie Rivers",
  eventTitle: "Solstice Bonfire",
  issuedAt: new Date("2026-06-12T00:00:00Z"),
};

describe("TicketMobileCard", () => {
  it("renders code, status badge, owner, event, and issued date", () => {
    render(<TicketMobileCard row={baseRow} />);

    expect(screen.getByText("TKT-A1B2C3D4")).toBeInTheDocument();
    expect(screen.getByText("Valid")).toHaveAttribute("data-tone", "success");
    expect(screen.getByText("Jamie Rivers")).toBeInTheDocument();
    expect(screen.getByText("Solstice Bonfire")).toBeInTheDocument();
    expect(screen.getByText("Jun 12, 2026")).toBeInTheDocument();
  });

  it("falls back for unknown owners and tones invalid tickets", () => {
    render(
      <TicketMobileCard
        row={{ ...baseRow, ownerName: null, status: "INVALID" }}
      />,
    );

    expect(screen.getByText("Unknown owner")).toBeInTheDocument();
    expect(screen.getByText("Invalid")).toHaveAttribute("data-tone", "danger");
  });
});
