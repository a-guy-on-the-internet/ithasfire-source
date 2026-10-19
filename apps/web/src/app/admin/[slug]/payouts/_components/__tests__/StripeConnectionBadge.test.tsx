import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { StripeConnectionBadge } from "../StripeAccountSection";
import type { StripeAccount } from "../use-stripe-account";

// The badge is shared: the Payouts page's Stripe settings row and the
// account-settings Payouts block (PersonalPayoutsSection) both render it.

vi.mock("tamagui", () => {
  const Stack = ({
    children,
    "data-testid": testId,
    "data-tone": tone,
    borderColor,
  }: {
    children?: ReactNode;
    "data-testid"?: string;
    "data-tone"?: string;
    borderColor?: string;
  }) => (
    <div data-testid={testId} data-tone={tone} data-border={borderColor}>
      {children}
    </div>
  );
  return { YStack: Stack, XStack: Stack, styled: () => Stack };
});

vi.mock("@th/ui", () => ({
  Badge: ({
    children,
    tone,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    tone?: string;
    "data-testid"?: string;
  }) => (
    <span data-testid={testId} data-tone={tone}>
      {children}
    </span>
  ),
  Text: ({ children, color }: { children?: ReactNode; color?: string }) => (
    <span data-color={color}>{children}</span>
  ),
  Button: ({ children }: { children?: ReactNode }) => <button>{children}</button>,
  Spinner: () => null,
  Separator: () => null,
  useTranslations: () => (key: string) => key,
}));

vi.mock("lucide-react", () => ({
  ExternalLink: () => null,
  CheckCircle2: () => null,
  AlertTriangle: () => null,
  XCircle: () => null,
  ChevronDown: () => null,
}));

vi.mock("../ChargebackTermsSection", () => ({
  ChargebackTermsSection: () => null,
}));

function account(
  connected: boolean,
  isFullyConnected: boolean,
): StripeAccount {
  return {
    status: { connected },
    isFullyConnected,
    statusQuery: { isLoading: false, error: null },
  } as unknown as StripeAccount;
}

describe("StripeConnectionBadge", () => {
  // Text and rule come from THEME tokens (Stub #92400E / #166534 on cream,
  // AA), never the Badge's module-scope palette.
  const colours = (badge: HTMLElement) => ({
    tone: badge.getAttribute("data-tone"),
    border: badge.getAttribute("data-border"),
    text: badge.querySelector("span")?.getAttribute("data-color"),
  });

  it("connected but unfinished says Incomplete, in the warning tone, never Connected", () => {
    render(<StripeConnectionBadge stripe={account(true, false)} />);
    const badge = screen.getByTestId("stripe-connection-badge");
    expect(badge.textContent).toBe("admin.stripeIncomplete");
    expect(colours(badge)).toEqual({
      tone: "warning",
      border: "$warning",
      text: "$warning",
    });
  });

  it("fully set up says Connected", () => {
    render(<StripeConnectionBadge stripe={account(true, true)} />);
    const badge = screen.getByTestId("stripe-connection-badge");
    expect(badge.textContent).toBe("admin.connected");
    expect(colours(badge)).toEqual({
      tone: "success",
      border: "$success",
      text: "$success",
    });
  });

  it("no account says Not connected, muted", () => {
    render(<StripeConnectionBadge stripe={account(false, false)} />);
    const badge = screen.getByTestId("stripe-connection-badge");
    expect(badge.textContent).toBe("admin.stripeNotConnected");
    expect(colours(badge)).toEqual({
      tone: "neutral",
      border: "$borderColor",
      text: "$colorMuted",
    });
  });
});
