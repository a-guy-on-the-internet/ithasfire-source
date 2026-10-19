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
      "admin.pclStatusOpen": "Open",
      "admin.pclStatusUnderReview": "Under review",
      "admin.pclStatusApproved": "Approved",
      "admin.pclStatusDenied": "Denied",
      "admin.pclStatusExpired": "Expired",
      "admin.pclKindTicketInvalid": "Ticket invalid",
      "admin.pclKindEntryDenied": "Entry denied",
      "admin.pclDeadline": "Deadline",
      "resaleClaim.windowClosedColumn": "Deadline",
      "admin.pclCreated": "Created",
    };
    return dictionary[key] ?? key;
  },
}));

vi.mock("@/lib/format", () => ({
  fmtDateShort: (_fmt: unknown, date: Date) =>
    date.toISOString().slice(0, 10),
  truncateId: (id: string) => (id.length > 8 ? `${id.slice(0, 8)}...` : id),
}));

import {
  ClaimMobileCard,
  type ClaimMobileCardRow,
} from "../ClaimMobileCard";

const baseRow: ClaimMobileCardRow = {
  id: "claim-1234-5678-abcd",
  kind: "ticket_invalid",
  status: "open",
  deadline: new Date("2026-07-01T00:00:00Z"),
  createdAt: new Date("2026-06-01T00:00:00Z"),
};

describe("ClaimMobileCard", () => {
  it("renders kind, status badge with table tone, mono id, and dates", () => {
    render(<ClaimMobileCard row={baseRow} />);

    expect(screen.getByText("Ticket invalid")).toBeInTheDocument();
    expect(screen.getByText("Open")).toHaveAttribute("data-tone", "warning");
    expect(screen.getByText("claim-12...")).toBeInTheDocument();
    expect(screen.getByText(/Deadline 2026-07-01/)).toBeInTheDocument();
    expect(screen.getByText(/Created 2026-06-01/)).toBeInTheDocument();
  });

  it("tones denied claims danger and falls back to raw values for unknown maps", () => {
    render(
      <ClaimMobileCard
        row={{ ...baseRow, status: "denied", kind: "mystery_kind" }}
      />,
    );

    expect(screen.getByText("Denied")).toHaveAttribute("data-tone", "danger");
    // Unknown kind falls through to the raw value, like the table column.
    expect(screen.getByText("mystery_kind")).toBeInTheDocument();
  });
});
