import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("tamagui", () => {
  const passthrough = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  return { XStack: passthrough, YStack: passthrough };
});

vi.mock("@th/ui", () => ({
  Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Button: ({ children }: { children?: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  useFormatters: () => ({ dateTime: () => "when" }),
  useNotify: () => ({ toast: { success: vi.fn(), danger: vi.fn() } }),
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/trpc", () => ({
  trpc: {
    volunteer: {
      signups: {
        review: {
          useMutation: () => ({ mutate: vi.fn(), isPending: false }),
        },
        checkIn: {
          useMutation: () => ({ mutate: vi.fn(), isPending: false }),
        },
      },
    },
  },
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: () => "err",
}));

vi.mock("@/components/data-table/ConfirmDialog", () => ({
  ConfirmDialog: () => null,
}));

vi.mock("../GroupAssignmentMenu", () => ({
  GroupAssignmentMenu: () => <div data-testid="group-menu" />,
}));

vi.mock("../RewardStatusBadge", () => ({
  RewardStatusBadge: ({
    status,
    testIdSuffix,
  }: {
    status: string | null | undefined;
    testIdSuffix?: string;
  }) =>
    status && status !== "NONE" ? (
      <span data-testid={`reward-status-badge-${testIdSuffix}`}>{status}</span>
    ) : null,
}));

import { SignupReviewRow } from "../SignupReviewRow";

const baseSignup = {
  id: "s1",
  contactName: "Vol",
  contactEmail: "vol@example.org",
  status: "CHECKED_IN" as const,
  groupId: null,
  roleId: "r1",
  createdAt: new Date().toISOString(),
};

describe("SignupReviewRow reward status (coordinator read-only surface)", () => {
  it("renders a read-only reward badge when the signup carries a reward status", () => {
    render(
      <SignupReviewRow
        signup={{ ...baseSignup, rewardStatus: "REDEEMED" }}
        assignableGroups={[]}
        showGroupMenu={false}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByTestId("reward-status-badge-s1").textContent).toBe(
      "REDEEMED",
    );
    // The row is read-only for rewards — it never renders the config form.
    expect(screen.queryByTestId("volunteer-reward-form")).toBeNull();
  });

  it("renders no reward badge when the signup has no reward status", () => {
    render(
      <SignupReviewRow
        signup={baseSignup}
        assignableGroups={[]}
        showGroupMenu={false}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("reward-status-badge-s1")).toBeNull();
  });
});
