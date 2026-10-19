import { fireEvent, render, screen } from "@testing-library/react";
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
  Button: ({
    children,
    onPress,
    disabled,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
  }) => (
    <button onClick={onPress} disabled={disabled}>
      {children}
    </button>
  ),
  useTranslations: () => (key: string) => {
    const dictionary: Record<string, string> = {
      "admin.rmHidden": "Hidden",
      "admin.rmFlagged": "Flagged",
      "admin.rmVisible": "Visible",
      "admin.rmNoComment": "No comment",
      "admin.rmAnonymous": "Anonymous",
      "admin.rmHide": "Hide",
      "admin.rmUnhide": "Unhide",
    };
    return dictionary[key] ?? key;
  },
}));

vi.mock("@/lib/format", () => ({
  formatDateShort: () => "Jun 12, 2026",
}));

import {
  ReviewMobileCard,
  getReviewModerationStatus,
  type ReviewMobileCardRow,
} from "../ReviewMobileCard";

const baseRow: ReviewMobileCardRow = {
  placeName: "The Velvet Room",
  anonymousName: "Touring Band",
  comment: "Great sound, fair payout.",
  hidden: false,
  flagged: false,
  createdAt: "2026-06-12T00:00:00Z",
};

describe("getReviewModerationStatus", () => {
  it("hidden wins, then flagged, then visible", () => {
    expect(getReviewModerationStatus({ hidden: true, flagged: true })).toEqual(
      { labelKey: "admin.rmHidden", tone: "danger" },
    );
    expect(
      getReviewModerationStatus({ hidden: false, flagged: true }),
    ).toEqual({ labelKey: "admin.rmFlagged", tone: "warning" });
    expect(
      getReviewModerationStatus({ hidden: false, flagged: false }),
    ).toEqual({ labelKey: "admin.rmVisible", tone: "success" });
  });
});

describe("ReviewMobileCard", () => {
  it("renders venue, status badge, comment, reviewer, date, and Hide action", () => {
    const onToggleHidden = vi.fn();
    render(
      <ReviewMobileCard
        row={baseRow}
        onToggleHidden={onToggleHidden}
        isMutating={false}
      />,
    );

    expect(screen.getByText("The Velvet Room")).toBeInTheDocument();
    expect(screen.getByText("Visible")).toHaveAttribute(
      "data-tone",
      "success",
    );
    expect(screen.getByText("Great sound, fair payout.")).toBeInTheDocument();
    expect(screen.getByText("Touring Band")).toBeInTheDocument();
    expect(screen.getByText("Jun 12, 2026")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Hide/ }));
    expect(onToggleHidden).toHaveBeenCalledTimes(1);
  });

  it("shows Unhide for hidden reviews and falls back for missing fields", () => {
    render(
      <ReviewMobileCard
        row={{
          ...baseRow,
          hidden: true,
          comment: null,
          anonymousName: null,
        }}
        onToggleHidden={vi.fn()}
        isMutating
      />,
    );

    expect(screen.getByText("Hidden")).toHaveAttribute("data-tone", "danger");
    expect(screen.getByText("No comment")).toBeInTheDocument();
    expect(screen.getByText("Anonymous")).toBeInTheDocument();

    const button = screen.getByRole("button", { name: /Unhide/ });
    expect(button).toBeDisabled();
  });
});
