import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@th/ui", () => ({
  Badge: ({ children }: { children?: ReactNode }) => (
    <span data-testid="badge">{children}</span>
  ),
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  useTranslations: () => (key: string) => key,
}));

import { RewardStatusBadge } from "../RewardStatusBadge";

describe("RewardStatusBadge", () => {
  it("maps each grant status to its label key", () => {
    const { rerender } = render(<RewardStatusBadge status="GRANTED" />);
    expect(screen.getByText("volunteering.rewardStatusGranted")).toBeTruthy();

    rerender(<RewardStatusBadge status="REDEEMED" />);
    expect(screen.getByText("volunteering.rewardStatusRedeemed")).toBeTruthy();

    rerender(<RewardStatusBadge status="REVOKED" />);
    expect(screen.getByText("volunteering.rewardStatusRevoked")).toBeTruthy();
  });

  it("renders nothing for NONE / null / undefined", () => {
    const { container, rerender } = render(<RewardStatusBadge status="NONE" />);
    expect(container.querySelector("[data-testid='badge']")).toBeNull();

    rerender(<RewardStatusBadge status={null} />);
    expect(container.querySelector("[data-testid='badge']")).toBeNull();

    rerender(<RewardStatusBadge status={undefined} />);
    expect(container.querySelector("[data-testid='badge']")).toBeNull();
  });

  it("targets a row via testIdSuffix", () => {
    render(<RewardStatusBadge status="GRANTED" testIdSuffix="signup-1" />);
    expect(screen.getByTestId("reward-status-badge-signup-1")).toBeTruthy();
  });
});
