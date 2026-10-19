import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * MembershipStatusCard — the presentable "show this to the door" status
 * display for an ACTIVE/TRIALING membership. Pins: tier name renders as a
 * real heading (not just a bigger div), "member since" uses the
 * membership's `startedAt`, the status badge reflects `statusKey`, and
 * Manage billing still calls through with the membership id unchanged.
 */

vi.mock("tamagui", () => {
  const Stack = ({
    children,
    tag: Tag,
    ...rest
  }: {
    children?: ReactNode;
    tag?: string;
    [key: string]: unknown;
  }) => {
    const Component = (Tag as React.ElementType) ?? "div";
    return <Component {...rest}>{children}</Component>;
  };
  return {
    XStack: Stack,
    YStack: Stack,
    styled: (Base: unknown) => Base,
  };
});

vi.mock("lucide-react", () => ({
  BadgeCheck: () => <span data-testid="badge-check-icon" />,
}));

vi.mock("@th/ui", () => ({
  Badge: ({
    children,
    leadingIcon,
  }: {
    children?: ReactNode;
    leadingIcon?: ReactNode;
  }) => (
    <span data-testid="status-badge">
      {leadingIcon}
      {children}
    </span>
  ),
  Button: ({
    children,
    onPress,
    disabled,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onPress} disabled={disabled}>
      {children}
    </button>
  ),
  Text: ({
    children,
    variant,
    id,
  }: {
    children?: ReactNode;
    variant?: string;
    id?: string;
  }) => {
    if (variant === "h4") {
      return <h4 id={id}>{children}</h4>;
    }
    return <span id={id}>{children}</span>;
  },
  // Key-echo translator (same convention as ReceivedBookingRequestsList.test.tsx).
  useTranslations:
    () =>
    (key: string, values?: Record<string, unknown>) =>
      values
        ? `${key} ${Object.entries(values)
            .map(([name, value]) => `${name}=${String(value)}`)
            .join(" ")}`
        : key,
}));

import { MembershipStatusCard } from "../MembershipStatusCard";
import type { MyMembership } from "../../membership-status";

function membership(
  overrides: Partial<MyMembership> = {},
): MyMembership {
  return {
    id: "mem-1",
    status: "active",
    cancelAtPeriodEnd: false,
    canceledAt: null,
    currentPeriodEnd: new Date("2026-09-15T00:00:00Z"),
    startedAt: new Date("2026-01-10T00:00:00Z"),
    tier: {
      id: "tier-1",
      name: "Sustaining Member",
      priceCents: 1000,
      currency: "usd",
      interval: "MONTH",
    },
    owner: {
      type: "ORGANIZATION",
      id: "org-1",
      name: "The Ryman",
    },
    ...overrides,
  } as MyMembership;
}

describe("MembershipStatusCard", () => {
  it("renders the tier name as a real heading (h4), not just styled text", () => {
    render(
      <MembershipStatusCard
        membership={membership()}
        onManageBilling={vi.fn()}
        isManagingBilling={false}
      />,
    );
    const heading = screen.getByRole("heading", { level: 4 });
    expect(heading).toHaveTextContent("Sustaining Member");
  });

  it("shows the owner name when present", () => {
    render(
      <MembershipStatusCard
        membership={membership()}
        onManageBilling={vi.fn()}
        isManagingBilling={false}
      />,
    );
    expect(screen.getByText("The Ryman")).toBeInTheDocument();
  });

  it("omits the owner line when the owner has no display name", () => {
    render(
      <MembershipStatusCard
        membership={membership({
          owner: { type: "ORGANIZATION", id: "org-1", name: null },
        })}
        onManageBilling={vi.fn()}
        isManagingBilling={false}
      />,
    );
    expect(screen.queryByText("The Ryman")).not.toBeInTheDocument();
  });

  it("renders 'member since' using startedAt, not currentPeriodEnd", () => {
    render(
      <MembershipStatusCard
        membership={membership()}
        onManageBilling={vi.fn()}
        isManagingBilling={false}
      />,
    );
    expect(
      screen.getByText("accountMemberships.memberSinceLabel"),
    ).toBeInTheDocument();
    // formatDateShort renders in the local timezone, so this pins the
    // startedAt value (Jan 10 UTC) rather than the unrelated
    // currentPeriodEnd (Sep 15 UTC) used elsewhere on the card.
    expect(screen.getByText(/^Jan (9|10), 2026$/)).toBeInTheDocument();
  });

  it("shows the granting status label in the badge", () => {
    render(
      <MembershipStatusCard
        membership={membership({ status: "trialing" })}
        onManageBilling={vi.fn()}
        isManagingBilling={false}
      />,
    );
    expect(
      screen.getByText("accountMemberships.statusActive"),
    ).toBeInTheDocument();
  });

  it("shows 'ends on' wording when cancelAtPeriodEnd is true", () => {
    render(
      <MembershipStatusCard
        membership={membership({ cancelAtPeriodEnd: true })}
        onManageBilling={vi.fn()}
        isManagingBilling={false}
      />,
    );
    expect(
      screen.getByText(/accountMemberships\.endsOn/),
    ).toBeInTheDocument();
  });

  it("shows 'renews on' wording when cancelAtPeriodEnd is false", () => {
    render(
      <MembershipStatusCard
        membership={membership({ cancelAtPeriodEnd: false })}
        onManageBilling={vi.fn()}
        isManagingBilling={false}
      />,
    );
    expect(
      screen.getByText(/accountMemberships\.renewsOn/),
    ).toBeInTheDocument();
  });

  it("calls onManageBilling with the membership id when clicked", () => {
    const onManageBilling = vi.fn();
    render(
      <MembershipStatusCard
        membership={membership({ id: "mem-42" })}
        onManageBilling={onManageBilling}
        isManagingBilling={false}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onManageBilling).toHaveBeenCalledWith("mem-42");
  });

  it("disables the Manage billing button while a portal session is being requested", () => {
    render(
      <MembershipStatusCard
        membership={membership()}
        onManageBilling={vi.fn()}
        isManagingBilling
      />,
    );
    expect(screen.getByRole("button")).toBeDisabled();
  });
});
