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
  useTranslations: () => (key: string, vars?: Record<string, string>) => {
    if (key === "admin.phFlaggedMatch") {
      return `Same network as ${vars?.names ?? ""}`;
    }
    if (key === "admin.phFlaggedMatchBanned") {
      return `Same network as a banned account: ${vars?.names ?? ""}`;
    }
    if (key === "admin.phFlaggedMatchSuspended") {
      return `Same network as a suspended account: ${vars?.names ?? ""}`;
    }
    const dictionary: Record<string, string> = {
      "admin.phStatusActive": "Active",
      "admin.phStatusBanned": "Banned",
      "admin.phVerified": "Verified",
      "admin.phUnverified": "Unverified",
      "admin.phColJoined": "Joined",
      "admin.phFlagged": "Flagged",
    };
    return dictionary[key] ?? key;
  },
}));

vi.mock("@/lib/format", () => ({
  fmtDate: () => "Jun 1, 2026",
  truncateId: (id: string) => (id.length > 8 ? `${id.slice(0, 8)}...` : id),
}));

import { HumanMobileCard, type HumanMobileCardRow } from "../HumanMobileCard";

const baseRow: HumanMobileCardRow = {
  id: "human-1234-5678-abcd",
  name: "Mika Vigeant",
  status: "ACTIVE",
  createdAt: new Date("2026-06-01T00:00:00Z"),
  identity: {
    email: "mika@example.com",
    emailVerified: true,
  },
};

describe("HumanMobileCard", () => {
  it("renders name, status/verified badges with table tones, email, joined date, mono id, and the actions slot", () => {
    render(
      <HumanMobileCard row={baseRow} actions={<button>Actions menu</button>} />,
    );

    expect(screen.getByText("Mika Vigeant")).toBeInTheDocument();
    expect(screen.getByText("Active")).toHaveAttribute("data-tone", "success");
    expect(screen.getByText("Verified")).toHaveAttribute(
      "data-tone",
      "success",
    );
    expect(screen.getByText("mika@example.com")).toBeInTheDocument();
    expect(screen.getByText(/Joined Jun 1, 2026/)).toBeInTheDocument();
    expect(screen.getByText("human-12...")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Actions menu" }),
    ).toBeInTheDocument();
  });

  it("falls back for missing name/identity and tones banned humans", () => {
    render(
      <HumanMobileCard
        row={{ ...baseRow, name: null, status: "BANNED", identity: null }}
      />,
    );

    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByText("Banned")).toHaveAttribute("data-tone", "error");
    // No identity → unverified badge, same as the table column.
    expect(screen.getByText("Unverified")).toHaveAttribute(
      "data-tone",
      "warning",
    );
    expect(screen.queryByText("mika@example.com")).not.toBeInTheDocument();
  });

  // Ban that sticks: a flagged sign-up shows WHICH banned account it shares
  // a network with (falling back to the id when the account has no name).
  it("shows the flagged badge and the banned accounts it matches", () => {
    render(
      <HumanMobileCard
        row={baseRow}
        flaggedMatches={[
          {
            bannedHumanId: "banned-1",
            bannedHumanName: "Banned Bob",
            bannedHumanStatus: "BANNED",
          },
          {
            bannedHumanId: "banned-2222-3333",
            bannedHumanName: null,
            bannedHumanStatus: "BANNED",
          },
          {
            bannedHumanId: "susp-1",
            bannedHumanName: "Paused Pat",
            bannedHumanStatus: "SUSPENDED",
          },
        ]}
      />,
    );

    expect(screen.getByText("Flagged")).toHaveAttribute("data-tone", "warning");
    // One line per status: banned and suspended sources are named apart.
    expect(
      screen.getByText(
        "Same network as a banned account: Banned Bob, banned-2...",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Same network as a suspended account: Paused Pat"),
    ).toBeInTheDocument();
  });

  it("shows no flag when the row has no matches", () => {
    render(<HumanMobileCard row={baseRow} flaggedMatches={[]} />);
    expect(screen.queryByText("Flagged")).not.toBeInTheDocument();
  });
});
