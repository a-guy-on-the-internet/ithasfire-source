/**
 * The gated-event wrappers (PASSWORD / APPLICATION) render their own copy of
 * the waitlist "Notify me" join form below the gate card — they do NOT go
 * through `EventContent`. Both must honour the default-OFF `waitlists` gate;
 * missing one of these render sites would leave the join affordance live on
 * exactly the events most likely to have a waitlist open.
 */
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import type { FeatureGatesSnapshot } from "@/lib/feature-gates/types";

// ── DOM-level stand-ins for the styling layer ─────────────────────────────

vi.mock("tamagui", async () => {
  const React = await import("react");
  const PASS_PROP = /^(data-|aria-)|^(id|role|style|title|tabIndex|type)$/;
  const makeStack =
    (tag: string) =>
    ({
      children,
      onPress,
      ...rest
    }: {
      children?: ReactNode;
      onPress?: () => void;
      [key: string]: unknown;
    }) => {
      const domProps: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(rest)) {
        if (PASS_PROP.test(key)) domProps[key] = value;
      }
      if (onPress) domProps.onClick = onPress;
      return React.createElement(tag, domProps, children);
    };
  const Stack = makeStack("div");
  return { XStack: Stack, YStack: Stack, Stack, styled: () => Stack };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");
  const Passthrough = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", null, children);
  const Text = ({ children }: { children?: ReactNode }) =>
    React.createElement("span", null, children);
  // `EventApplicationGate` is a compound component (`.Card` / `.Form`).
  const EventApplicationGate = Object.assign(Passthrough, {
    Card: Passthrough,
    Form: Passthrough,
  });
  return {
    Text,
    CardSurface: Passthrough,
    EventApplicationGate,
    NextLinkAnchor: Passthrough,
    PasswordInput: () => React.createElement("input", { type: "password" }),
    Button: ({ children }: { children?: ReactNode }) =>
      React.createElement("button", { type: "button" }, children),
    useTranslations: () => (key: string) => key,
    useLocale: () => "en",
    useFormatters: () => ({ dateTime: () => "date" }),
    useNotify: () => ({ toast: { danger: vi.fn(), success: vi.fn() } }),
  };
});

// The withdraw ConfirmDialog pulls in the real @th/ui Modal; these tests only
// assert join-form rendering, so stub it out entirely.
vi.mock("@/components/data-table/ConfirmDialog", () => ({
  ConfirmDialog: () => null,
}));

vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@bprogress/next/app", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/auth/auth-client", () => ({
  authClient: { useSession: () => ({ data: null, isPending: false }) },
}));
vi.mock("@/trpc", () => ({
  trpc: {
    events: {
      getViewerApplicationStatus: {
        useQuery: () => ({ data: undefined, refetch: vi.fn() }),
      },
      // Phase 3: the gate reads the PUBLIC form procedure (the authed one is
      // organizer-only and would 403 every applicant).
      getPublicApplicationForm: {
        useQuery: () => ({ data: undefined, refetch: vi.fn() }),
      },
      submitApplication: {
        useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
      },
      withdrawApplication: {
        useMutation: () => ({
          mutate: vi.fn(),
          mutateAsync: vi.fn(),
          isPending: false,
        }),
      },
    },
  },
}));

// The join form pulls in tRPC hooks of its own; these tests only assert
// whether the wrappers *render* it.
vi.mock("@/components/events/WaitlistJoinForm", () => ({
  WaitlistJoinForm: () => <div data-testid="waitlist-join-form" />,
}));

let mockGates: Partial<FeatureGatesSnapshot> | undefined;

vi.mock("@/hooks/useFeatureGates", () => ({
  useFeatureGates: () => ({ gates: mockGates, isLoading: false }),
}));

import { EventPasswordGateWrapper } from "../EventPasswordGateWrapper";
import { EventApplicationGateWrapper } from "../EventApplicationGateWrapper";

beforeEach(() => {
  mockGates = undefined;
});

const renderPasswordGate = () =>
  render(
    <EventPasswordGateWrapper
      eventId="11111111-1111-4111-8111-111111111111"
      slug="secret-show"
      title="Secret Show"
      heroImageUrl={null}
      waitlistOpen
      waitlistDescription="We'll let you know."
    />,
  );

const renderApplicationGate = () =>
  render(
    <EventApplicationGateWrapper
      eventId="11111111-1111-4111-8111-111111111111"
      slug="apply-only"
      title="Apply Only"
      heroImageUrl={null}
      waitlistOpen
      waitlistDescription="We'll let you know."
    />,
  );

describe("EventPasswordGateWrapper — `waitlists` gate", () => {
  // The Door offers the form behind a "No password? Get notified" link.
  const waitlistLink = () =>
    screen.queryByRole("button", { name: "eventDetail.pwDoorWaitlistLink" });

  it("does not render the join form when the gate is off", () => {
    mockGates = { waitlists: false };
    renderPasswordGate();
    expect(waitlistLink()).not.toBeInTheDocument();
    expect(screen.queryByTestId("waitlist-join-form")).not.toBeInTheDocument();
  });

  it("fails closed while the gates are still loading (undefined)", () => {
    mockGates = undefined;
    renderPasswordGate();
    expect(waitlistLink()).not.toBeInTheDocument();
    expect(screen.queryByTestId("waitlist-join-form")).not.toBeInTheDocument();
  });

  it("renders the join form, behind its link, when the gate is on", () => {
    mockGates = { waitlists: true };
    renderPasswordGate();
    const link = waitlistLink();
    expect(link).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(link!);
    expect(link).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("waitlist-join-form")).toBeInTheDocument();
  });
});

describe("EventApplicationGateWrapper — `waitlists` gate", () => {
  it("does not render the join form when the gate is off", () => {
    mockGates = { waitlists: false };
    renderApplicationGate();
    expect(screen.queryByTestId("waitlist-join-form")).not.toBeInTheDocument();
  });

  it("fails closed while the gates are still loading (undefined)", () => {
    mockGates = undefined;
    renderApplicationGate();
    expect(screen.queryByTestId("waitlist-join-form")).not.toBeInTheDocument();
  });

  it("renders the join form when the gate is on", () => {
    mockGates = { waitlists: true };
    renderApplicationGate();
    expect(screen.getByTestId("waitlist-join-form")).toBeInTheDocument();
  });
});
