import type { ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SESSION_RECHECK_DELAY_MS } from "@/hooks/useSessionVerdict";

/**
 * /account/memberships — pins the new ACTIVE/TRIALING vs. everything-else
 * split: granting-status memberships get the presentable
 * `MembershipStatusCard` treatment, everything else keeps the plain
 * bordered-row list. Section labels only appear when BOTH groups are
 * present (so a member with only one kind of membership doesn't see a
 * redundant heading). Also pins that the existing loading/empty/error/
 * not-signed-in states and the Stripe portal hand-off are untouched.
 */

const testMocks = vi.hoisted(() => ({
  useSessionMock: vi.fn(),
  listUseQuery: vi.fn(),
  portalMutate: vi.fn(),
  push: vi.fn(),
}));

vi.mock("@bprogress/next/app", () => ({
  useRouter: () => ({ push: testMocks.push }),
}));

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: { useSession: testMocks.useSessionMock },
}));

vi.mock("@/trpc", () => ({
  trpc: {
    memberships: {
      mine: { list: { useQuery: testMocks.listUseQuery } },
      portalSession: {
        useMutation: () => ({
          mutate: testMocks.portalMutate,
          isPending: false,
        }),
      },
    },
  },
}));

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({ children, ...props }: { children?: ReactNode }) => {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      if (key === "role" || key === "data-testid" || key.startsWith("aria-"))
        safe[key] = value;
    }
    return React.createElement("div", safe, children);
  };
  return {
    XStack: Stack,
    YStack: Stack,
    styled: (Base: unknown) => Base ?? Stack,
  };
});

vi.mock("lucide-react", () => ({
  BadgeCheck: () => <span data-testid="icon-badge-check" />,
  ChevronLeft: () => <span data-testid="icon-chevron-left" />,
  User: () => <span data-testid="icon-user" />,
}));

vi.mock("@th/ui", () => ({
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
    <button type="button" onClick={onPress} disabled={disabled}>
      {children}
    </button>
  ),
  Spinner: () => <span data-testid="spinner">Loading</span>,
  useTranslations:
    () =>
    (key: string, values?: Record<string, unknown>) =>
      values
        ? `${key} ${Object.entries(values)
            .map(([name, value]) => `${name}=${String(value)}`)
            .join(" ")}`
        : key,
}));

vi.mock("../_components/MembershipStatusCard", () => ({
  MembershipStatusCard: ({
    membership,
  }: {
    membership: { id: string; tier: { name: string } };
  }) => (
    <div data-testid="membership-status-card">{membership.tier.name}</div>
  ),
}));

import AccountMembershipsPage from "../page";

function baseMembership(overrides: Record<string, unknown> = {}) {
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
    owner: { type: "ORGANIZATION", id: "org-1", name: "The Ryman" },
    ...overrides,
  };
}

function signedIn() {
  testMocks.useSessionMock.mockReturnValue({
    data: { user: { id: "human-1" } },
    isPending: false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  // Only the session-verdict tests install fake timers; this is a no-op
  // otherwise and keeps them from leaking into the next case.
  vi.useRealTimers();
});

describe("AccountMembershipsPage", () => {
  it("shows a spinner while the session is loading", () => {
    testMocks.useSessionMock.mockReturnValue({ data: null, isPending: true });
    render(<AccountMembershipsPage />);
    expect(screen.getByTestId("spinner")).toBeInTheDocument();
  });

  it("prompts sign-in only once a second lookup also finds no user", () => {
    vi.useFakeTimers();
    const refetch = vi.fn();
    testMocks.useSessionMock.mockReturnValue({
      data: null,
      error: null,
      isPending: false,
      refetch,
    });
    render(<AccountMembershipsPage />);

    // One settled null is NOT a verdict: a /get-session whose request beat the
    // freshly-set cookie looks identical to a real signed-out answer, and this
    // page's only call to action is "sign in" — which the user just did.
    expect(screen.getByTestId("spinner")).toBeInTheDocument();
    expect(screen.queryByText("account.notSignedIn")).not.toBeInTheDocument();
    expect(refetch).toHaveBeenCalledTimes(1);

    act(() => void vi.advanceTimersByTime(SESSION_RECHECK_DELAY_MS));
    expect(screen.getByText("account.notSignedIn")).toBeInTheDocument();
  });

  it("does not prompt sign-in when the re-check finds the user", () => {
    vi.useFakeTimers();
    testMocks.useSessionMock.mockReturnValue({
      data: null,
      error: null,
      isPending: false,
      refetch: vi.fn(),
    });
    const { rerender } = render(<AccountMembershipsPage />);
    expect(screen.queryByText("account.notSignedIn")).not.toBeInTheDocument();

    testMocks.listUseQuery.mockReturnValue({
      isPending: false,
      data: undefined,
    });
    signedIn();
    act(() => {
      rerender(<AccountMembershipsPage />);
      vi.advanceTimersByTime(SESSION_RECHECK_DELAY_MS * 3);
    });

    expect(screen.queryByText("account.notSignedIn")).not.toBeInTheDocument();
  });

  it("shows a spinner while memberships are loading", () => {
    signedIn();
    testMocks.listUseQuery.mockReturnValue({ isPending: true });
    render(<AccountMembershipsPage />);
    expect(screen.getByTestId("spinner")).toBeInTheDocument();
  });

  it("shows the load error state", () => {
    signedIn();
    testMocks.listUseQuery.mockReturnValue({ isPending: false, isError: true });
    render(<AccountMembershipsPage />);
    expect(screen.getByText("accountMemberships.loadError")).toBeInTheDocument();
  });

  it("shows the empty state when there are no memberships", () => {
    signedIn();
    testMocks.listUseQuery.mockReturnValue({
      isPending: false,
      isError: false,
      data: { items: [] },
    });
    render(<AccountMembershipsPage />);
    expect(screen.getByText("accountMemberships.empty")).toBeInTheDocument();
  });

  it("renders only the presentable card treatment for an all-active list, with no section labels", () => {
    signedIn();
    testMocks.listUseQuery.mockReturnValue({
      isPending: false,
      isError: false,
      data: { items: [baseMembership({ id: "mem-1" }), baseMembership({ id: "mem-2", status: "trialing" })] },
    });
    render(<AccountMembershipsPage />);
    expect(screen.getAllByTestId("membership-status-card")).toHaveLength(2);
    expect(
      screen.queryByText("accountMemberships.activeSectionLabel"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("accountMemberships.otherSectionLabel"),
    ).not.toBeInTheDocument();
  });

  it("renders only the plain row treatment for an all-canceled list, with no section labels", () => {
    signedIn();
    testMocks.listUseQuery.mockReturnValue({
      isPending: false,
      isError: false,
      data: {
        items: [baseMembership({ id: "mem-1", status: "canceled" })],
      },
    });
    render(<AccountMembershipsPage />);
    expect(screen.queryByTestId("membership-status-card")).not.toBeInTheDocument();
    expect(screen.getByText("accountMemberships.statusCanceled")).toBeInTheDocument();
    expect(
      screen.queryByText("accountMemberships.activeSectionLabel"),
    ).not.toBeInTheDocument();
  });

  it("splits a mixed list into a presentable active section and a plain other section, each labeled", () => {
    signedIn();
    testMocks.listUseQuery.mockReturnValue({
      isPending: false,
      isError: false,
      data: {
        items: [
          baseMembership({ id: "mem-active", status: "active" }),
          baseMembership({
            id: "mem-canceled",
            status: "canceled",
            tier: {
              id: "tier-2",
              name: "Lapsed Tier",
              priceCents: 500,
              currency: "usd",
              interval: "MONTH",
            },
          }),
        ],
      },
    });
    render(<AccountMembershipsPage />);
    expect(screen.getAllByTestId("membership-status-card")).toHaveLength(1);
    expect(screen.getByText("accountMemberships.activeSectionLabel")).toBeInTheDocument();
    expect(screen.getByText("accountMemberships.otherSectionLabel")).toBeInTheDocument();
    expect(screen.getByText("accountMemberships.statusCanceled")).toBeInTheDocument();
  });

  it("still hands off to the Stripe portal from a plain (non-active) row's Manage billing button", () => {
    signedIn();
    testMocks.listUseQuery.mockReturnValue({
      isPending: false,
      isError: false,
      data: {
        items: [baseMembership({ id: "mem-past-due", status: "past_due" })],
      },
    });
    render(<AccountMembershipsPage />);
    fireEvent.click(screen.getByText("accountMemberships.manageBilling"));
    expect(testMocks.portalMutate).toHaveBeenCalledWith(
      { membershipId: "mem-past-due", returnPath: "/account/memberships" },
      expect.any(Object),
    );
  });
});
