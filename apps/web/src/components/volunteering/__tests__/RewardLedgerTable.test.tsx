import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("tamagui", () => {
  const passthrough = ({
    children,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    "data-testid"?: string;
  }) => <div data-testid={testId}>{children}</div>;
  return { YStack: passthrough, XStack: passthrough };
});

vi.mock("@th/ui", () => ({
  Text: ({
    children,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    "data-testid"?: string;
  }) => <span data-testid={testId}>{children}</span>,
  Button: ({
    children,
    onPress,
    disabled,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    "data-testid"?: string;
  }) => (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onPress}
    >
      {children}
    </button>
  ),
  useFormatters: () => ({ dateTime: () => "when", currency: (v: number) => `$${v}` }),
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/format", () => ({
  fmtCurrency: (_fmt: unknown, cents: number) => `$${(cents / 100).toFixed(2)}`,
}));

vi.mock("../RewardStatusBadge", () => ({
  RewardStatusBadge: ({ status }: { status: string | null }) =>
    status ? <span data-testid={`badge-${status}`}>{status}</span> : null,
}));

import { RewardLedgerTable } from "../RewardLedgerTable";

const ledger = {
  counts: { granted: 3, redeemed: 2, revoked: 1, total: 6 },
  remainingBudget: 47,
  faceValueCents: 5000,
  grants: [
    {
      id: "gr1",
      signupId: "s1",
      contactEmail: "vol@example.org",
      status: "GRANTED" as const,
      redeemed: false,
      faceValueCents: 1000,
      grantedAt: new Date("2026-06-01").toISOString(),
      redeemedAt: null,
      revokedAt: null,
    },
  ],
};

describe("RewardLedgerTable", () => {
  it("renders the granted / redeemed / revoked counts and remaining budget", () => {
    render(<RewardLedgerTable ledger={ledger} currency="usd" />);
    expect(screen.getByTestId("volunteer-reward-stat-granted").textContent).toContain(
      "3",
    );
    expect(
      screen.getByTestId("volunteer-reward-stat-redeemed").textContent,
    ).toContain("2");
    expect(
      screen.getByTestId("volunteer-reward-stat-revoked").textContent,
    ).toContain("1");
    expect(
      screen.getByTestId("volunteer-reward-stat-remaining").textContent,
    ).toContain("47");
  });

  it("formats the total face value comped from cents", () => {
    render(<RewardLedgerTable ledger={ledger} currency="usd" />);
    expect(
      screen.getByTestId("volunteer-reward-stat-face-value").textContent,
    ).toContain("$50.00");
  });

  it("renders a per-grant row with recipient, face value, and status badge", () => {
    render(<RewardLedgerTable ledger={ledger} currency="usd" />);
    const row = screen.getByTestId("volunteer-reward-grant-gr1");
    expect(row.textContent).toContain("vol@example.org");
    expect(row.textContent).toContain("$10.00");
    expect(screen.getByTestId("badge-GRANTED")).toBeTruthy();
  });

  it("shows the uncapped label when remaining budget is null", () => {
    render(
      <RewardLedgerTable
        ledger={{ ...ledger, remainingBudget: null }}
        currency="usd"
      />,
    );
    expect(
      screen.getByTestId("volunteer-reward-stat-remaining").textContent,
    ).toContain("volunteering.rewardLedgerUncapped");
  });

  it("renders an empty state when there are no grants", () => {
    render(
      <RewardLedgerTable ledger={{ ...ledger, grants: [] }} currency="usd" />,
    );
    expect(screen.getByTestId("volunteer-reward-ledger-empty")).toBeTruthy();
  });

  // ── Void comp action (finance-only, via onVoid) ───────────────────────────

  const redeemedGrant = {
    id: "gr2",
    signupId: "s2",
    contactEmail: "used@example.org",
    status: "REDEEMED" as const,
    redeemed: true,
    faceValueCents: 1000,
    grantedAt: new Date("2026-06-01").toISOString(),
    redeemedAt: new Date("2026-06-02").toISOString(),
    revokedAt: null,
  };

  const revokedGrant = {
    id: "gr3",
    signupId: "s3",
    contactEmail: "void@example.org",
    status: "REVOKED" as const,
    redeemed: false,
    faceValueCents: 1000,
    grantedAt: new Date("2026-06-01").toISOString(),
    redeemedAt: null,
    revokedAt: new Date("2026-06-03").toISOString(),
  };

  it("shows the Void action on a GRANTED unused row when onVoid is provided", () => {
    render(
      <RewardLedgerTable ledger={ledger} currency="usd" onVoid={vi.fn()} />,
    );
    expect(screen.getByTestId("volunteer-reward-void-gr1")).toBeTruthy();
  });

  it("hides the Void action when no onVoid callback is provided (read-only)", () => {
    render(<RewardLedgerTable ledger={ledger} currency="usd" />);
    expect(screen.queryByTestId("volunteer-reward-void-gr1")).toBeNull();
  });

  it("does not show the Void action on a REDEEMED (used) comp", () => {
    render(
      <RewardLedgerTable
        ledger={{ ...ledger, grants: [redeemedGrant] }}
        currency="usd"
        onVoid={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("volunteer-reward-void-gr2")).toBeNull();
  });

  it("does not show the Void action on an already-REVOKED comp", () => {
    render(
      <RewardLedgerTable
        ledger={{ ...ledger, grants: [revokedGrant] }}
        currency="usd"
        onVoid={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("volunteer-reward-void-gr3")).toBeNull();
  });

  it("calls onVoid with the row's grant when the Void action is clicked", () => {
    const onVoid = vi.fn();
    render(<RewardLedgerTable ledger={ledger} currency="usd" onVoid={onVoid} />);
    fireEvent.click(screen.getByTestId("volunteer-reward-void-gr1"));
    expect(onVoid).toHaveBeenCalledTimes(1);
    expect(onVoid.mock.calls[0][0]).toMatchObject({ id: "gr1" });
  });

  it("disables the Void button while its own void is in flight", () => {
    render(
      <RewardLedgerTable
        ledger={ledger}
        currency="usd"
        onVoid={vi.fn()}
        voidPendingId="gr1"
      />,
    );
    expect(
      (screen.getByTestId("volunteer-reward-void-gr1") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
