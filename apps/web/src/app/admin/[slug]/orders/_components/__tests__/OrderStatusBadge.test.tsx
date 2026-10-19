import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

/**
 * `Order.status` is never set to DISPUTED by the dispute lifecycle
 * (`markDisputeStatus` writes only `disputeStatus`), so the badge must read
 * the dispute mirror or a charged-back order keeps saying "Succeeded".
 */

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({
    children,
    ...props
  }: { children?: ReactNode } & Record<string, unknown>) => {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      if (key === "role" || key.startsWith("aria-") || key.startsWith("data-"))
        safe[key] = value;
      if (key === "backgroundColor") safe["data-bg"] = value;
    }
    return React.createElement("div", safe, children);
  };
  return { XStack: Stack, Stack, styled: () => Stack };
});

vi.mock("@th/ui", () => ({
  Text: ({
    children,
    color,
  }: {
    children?: ReactNode;
    color?: string;
  }) => <span data-color={color}>{children}</span>,
  useTranslations: () => (key: string) => key,
}));

import { OrderStatusBadge } from "../OrderStatusBadge";

describe("OrderStatusBadge — dispute mirror", () => {
  it.each(["OPEN", "UNDER_REVIEW"] as const)(
    "shows Disputed (danger ink) for a %s dispute on a SUCCEEDED order",
    (disputeStatus) => {
      render(
        <OrderStatusBadge status="SUCCEEDED" disputeStatus={disputeStatus} />,
      );
      expect(screen.getByText("admin.statusDisputed")).toHaveAttribute(
        "data-color",
        "$dangerSoft",
      );
      expect(screen.queryByText("admin.statusSucceeded")).not.toBeInTheDocument();
    },
  );

  it("shows Dispute lost for a LOST dispute", () => {
    render(<OrderStatusBadge status="SUCCEEDED" disputeStatus="LOST" />);
    expect(screen.getByText("Dispute lost")).toHaveAttribute(
      "data-color",
      "$dangerSoft",
    );
  });

  it.each(["WON", "WARNING_OPEN", "WARNING_UNDER_REVIEW", "WARNING_CLOSED", null, undefined] as const)(
    "falls through to the order status when disputeStatus is %s",
    (disputeStatus) => {
      render(
        <OrderStatusBadge status="SUCCEEDED" disputeStatus={disputeStatus} />,
      );
      expect(screen.getByText("admin.statusSucceeded")).toHaveAttribute(
        "data-color",
        "$success",
      );
    },
  );

  it("keeps rendering the plain order status for callers that pass no dispute state (regression)", () => {
    render(<OrderStatusBadge status="PART_REFUNDED" />);
    expect(screen.getByText("admin.statusPartialRefund")).toBeInTheDocument();
  });
});
