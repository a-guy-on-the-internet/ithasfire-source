import type { CSSProperties, ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const { replaceMock, pathnameMock } = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  pathnameMock: vi.fn(() => "/"),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  usePathname: () => pathnameMock(),
}));

// The elevation exports are stubbed rather than re-exported from the real
// `@th/ui` (importing it pulls the whole Tamagui runtime into jsdom). The
// parsing itself is covered for real in
// `packages/ui/src/ui/tamagui/__tests__/design-system-v2.test.ts`; what these
// tests own is that the overlay RESERVES the gutter it is handed.
vi.mock("@th/ui", () => ({
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  useNotify: () => ({
    toast: {
      danger: vi.fn(),
    },
  }),
  useTranslations: () => (key: string) => key,
  elevationTokens: {
    stub: { card: "4px 4px 0 rgba(33, 28, 22, 0.85)" },
    ember: { card: "none" },
  },
  getShadowOverflowPx: (shadow: string) => (shadow === "none" ? 0 : 4),
}));

// The panel wrappers are the subject of two of the tests below, so the stack
// mock forwards the props those assertions read instead of dropping every
// prop on the floor. Anything unlisted still renders as a plain div.
type StackMockProps = {
  children?: ReactNode;
  overflow?: string;
  paddingRight?: number;
  paddingBottom?: number;
  style?: CSSProperties;
  inert?: boolean;
};

vi.mock("tamagui", () => ({
  XStack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  YStack: ({
    children,
    overflow,
    paddingRight,
    paddingBottom,
    style,
    inert,
  }: StackMockProps) => (
    <div
      data-overflow={overflow}
      data-padding-right={paddingRight}
      data-padding-bottom={paddingBottom}
      style={style}
      inert={inert}
    >
      {children}
    </div>
  ),
  useThemeName: () => "stub",
}));

vi.mock("../AuthOverlayShell", () => ({
  AuthOverlayShell: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("../LoginCard", () => ({
  LoginCard: ({
    initialIdentifier,
    onRequestCreateAccountAction,
  }: {
    initialIdentifier?: string;
    onRequestCreateAccountAction?: () => void;
  }) => (
    <div
      data-testid="login-card"
      // The prefill decides which STEP the real card opens on, so the tests
      // read it off the mock rather than trying to drive two steps here.
      data-initial-identifier={initialIdentifier ?? ""}
    >
      <button type="button" onClick={onRequestCreateAccountAction}>
        Create account
      </button>
    </div>
  ),
}));

vi.mock("../SignUpCard", () => ({
  SignUpCard: ({
    onAccountExistsAction,
    onRequestSignInAction,
  }: {
    onAccountExistsAction?: (email: string) => void;
    onRequestSignInAction?: () => void;
  }) => (
    <div data-testid="sign-up-card">
      <button
        type="button"
        onClick={() => onAccountExistsAction?.("bounced@example.com")}
      >
        Account exists
      </button>
      <button type="button" onClick={onRequestSignInAction}>
        Back to sign in
      </button>
    </div>
  ),
}));

vi.mock("../VerifyEmailCard", () => ({
  VerifyEmailCard: () => <div data-testid="verify-email-card" />,
}));

vi.mock("../ForgotPasswordCard", () => ({
  ForgotPasswordCard: () => <div data-testid="forgot-password-card" />,
}));

vi.mock("../Setup2faCard", () => ({
  Setup2faCard: ({ onDoneAction }: { onDoneAction?: () => void }) => (
    <button type="button" onClick={onDoneAction}>
      Complete setup
    </button>
  ),
}));

vi.mock("../WelcomeProfileCard", () => ({
  WelcomeProfileCard: ({
    onDoneAction,
    onSkipAction,
  }: {
    onDoneAction?: () => void;
    onSkipAction?: () => void;
  }) => (
    <div data-testid="welcome-profile-card">
      <button type="button" onClick={onDoneAction}>
        Finish
      </button>
      <button type="button" onClick={onSkipAction}>
        Skip profile
      </button>
    </div>
  ),
}));

vi.mock("../TwoFactorChallengeCard", () => ({
  TwoFactorChallengeCard: () => <div data-testid="verify-2fa-card" />,
}));

import { AUTH_PANEL_DURATION_MS } from "@/lib/motion/auth";

let UnifiedAuthOverlay: (typeof import("../UnifiedAuthOverlay"))["UnifiedAuthOverlay"];

describe("UnifiedAuthOverlay", () => {
  beforeAll(async () => {
    ({ UnifiedAuthOverlay } = await import("../UnifiedAuthOverlay"));
  });

  beforeEach(() => {
    replaceMock.mockReset();
    pathnameMock.mockReset();
    pathnameMock.mockReturnValue("/");
  });

  // Step 3 (secure) no longer ends the flow: done AND skip both advance to
  // the profile step (4 of 4). Only the profile step's finish/skip navigates.
  it("advances from setup-2fa to the profile step instead of navigating", () => {
    pathnameMock.mockReturnValue("/sign-up");

    render(<UnifiedAuthOverlay initialPanel="setup-2fa" />);

    fireEvent.click(screen.getByRole("button", { name: /complete setup/i }));

    expect(screen.getByTestId("welcome-profile-card")).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("defaults profile completion to the homepage when no redirect override is provided and the current route differs", () => {
    pathnameMock.mockReturnValue("/sign-up");

    render(<UnifiedAuthOverlay initialPanel="welcome-profile" />);

    fireEvent.click(screen.getByRole("button", { name: /^finish$/i }));

    expect(replaceMock).toHaveBeenCalledWith("/");
  });

  it("skips the redundant replace when the resolved destination matches the current pathname", () => {
    pathnameMock.mockReturnValue("/");

    render(<UnifiedAuthOverlay initialPanel="welcome-profile" />);

    fireEvent.click(screen.getByRole("button", { name: /^finish$/i }));

    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("treats skipping the profile step the same as finishing it", () => {
    pathnameMock.mockReturnValue("/sign-up");

    render(<UnifiedAuthOverlay initialPanel="welcome-profile" />);

    fireEvent.click(screen.getByRole("button", { name: /skip profile/i }));

    expect(replaceMock).toHaveBeenCalledWith("/");
  });

  it("does not clip the panel while idle, so the card's print shadow paints", () => {
    render(<UnifiedAuthOverlay initialPanel="sign-in" />);

    // Measured before the fix: this wrapper's rect was IDENTICAL to the card's
    // (480x598 at the same origin) with `overflow: hidden`, so all 4px of the
    // card's offset shadow fell outside the clip and never painted.
    const wrapper = screen.getByTestId("login-card").parentElement;
    expect(wrapper).not.toHaveAttribute("data-overflow");
  });

  describe("during a panel slide", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    const settle = () => {
      act(() => {
        vi.advanceTimersByTime(AUTH_PANEL_DURATION_MS + 50);
      });
    };

    it("reserves the shadow gutter on the clipping stack and inerts the exit layer", () => {
      render(<UnifiedAuthOverlay initialPanel="sign-in" />);

      fireEvent.click(screen.getByRole("button", { name: /create account/i }));

      // Both panels are mounted mid-slide: the incoming one in flow, the
      // outgoing one absolutely on top of it.
      const clipper = screen.getByTestId("sign-up-card").parentElement
        ?.parentElement;
      expect(clipper).toHaveAttribute("data-overflow", "hidden");
      expect(clipper).toHaveAttribute("data-padding-right", "4");
      expect(clipper).toHaveAttribute("data-padding-bottom", "4");
      expect(clipper).toHaveStyle({ width: "calc(100% + 4px)" });

      // The outgoing panel keeps a second `h1` and a live tab stop on screen
      // for the whole slide unless it is inert.
      expect(screen.getByTestId("login-card").parentElement).toHaveAttribute(
        "inert",
      );

      settle();
    });

    it("drops a stale sign-in prefill once the user chooses to create an account", () => {
      render(<UnifiedAuthOverlay initialPanel="sign-up" />);

      // Sign-up bounces: "you already have an account" stages the address and
      // routes to sign-in, which opens on the password step because of it.
      fireEvent.click(screen.getByRole("button", { name: /account exists/i }));
      settle();
      expect(screen.getByTestId("login-card")).toHaveAttribute(
        "data-initial-identifier",
        "bounced@example.com",
      );

      // The user declines that account and goes back to creating one. The
      // clear is staged, not immediate: the exit layer mounts a FRESH
      // LoginCard, so clearing synchronously would flip the outgoing card back
      // to step 1 while it is still on screen.
      fireEvent.click(screen.getByRole("button", { name: /create account/i }));
      expect(screen.getByTestId("login-card")).toHaveAttribute(
        "data-initial-identifier",
        "bounced@example.com",
      );
      settle();

      fireEvent.click(screen.getByRole("button", { name: /back to sign in/i }));
      settle();

      expect(screen.getByTestId("login-card")).toHaveAttribute(
        "data-initial-identifier",
        "",
      );
    });
  });
});
