import type { ReactNode } from "react";
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

const loginCardMock = vi.fn((props?: Record<string, unknown>) => (
  <div
    data-testid="login-card"
    data-redirect={props?.redirectOverride ?? undefined}
    data-has-dismiss={Boolean(props?.onDismissAction)}
  />
));
const overlayMountProps = vi.fn();

vi.mock("next/link", () => ({
  __esModule: true,
  default: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock("tamagui", () => {
  const Stack = ({
    children,
    ...props
  }: { children?: ReactNode } & Record<string, unknown>) => {
    const { onPress: _onPress, ...passthrough } = props;
    return <div {...passthrough}>{children}</div>;
  };
  Stack.displayName = "MockStack";
  const styled = (Component: React.ComponentType<any>) => {
    const StyledComponent = (props: Record<string, unknown>) => (
      <Component {...props} />
    );
    StyledComponent.displayName = Component.displayName ?? "StyledComponent";
    return StyledComponent;
  };
  return {
    YStack: Stack,
    styled,
  } satisfies Record<string, unknown>;
});

vi.mock("@th/ui", () => {
  const Button = ({
    children,
    onPress,
    onClick,
    ...rest
  }: {
    children?: ReactNode;
    onPress?: () => void;
    onClick?: () => void;
  } & Record<string, unknown>) => {
    const {
      icon: _icon,
      variant: _variant,
      size: _size,
      asChild: _asChild,
      ...passthrough
    } = rest;
    return (
      <button type="button" onClick={onClick ?? onPress} {...passthrough}>
        {children}
      </button>
    );
  };
  const CardSurface = ({ children }: { children?: ReactNode }) => (
    <div data-testid="card-surface">{children}</div>
  );
  const OverlayMount = (props: {
    id: string;
    children?: ReactNode;
    options?: Record<string, unknown>;
  }) => {
    overlayMountProps(props);
    return <div data-testid="overlay-mount">{props.children}</div>;
  };
  const Text = ({ children }: { children?: ReactNode }) => (
    <span>{children}</span>
  );
  const NextLinkAnchor = ({
    children,
    onClick,
    ...rest
  }: { children?: ReactNode; onClick?: () => void } & Record<
    string,
    unknown
  >) => (
    // Strip props that shouldn't land on DOM.
    <a
      onClick={onClick}
      {...(() => {
        const { asChild: _asChild, ...passthrough } = rest;
        return passthrough;
      })()}
    >
      {children}
    </a>
  );
  const useNotify = () => ({
    toast: {
      danger: vi.fn(),
      info: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
      neutral: vi.fn(),
    },
  });

  const useTranslations = () => (key: string) => key;

  return {
    Button,
    CardSurface,
    OverlayMount,
    Text,
    NextLinkAnchor,
    useNotify,
    useTranslations,
  } satisfies Record<string, unknown>;
});

vi.mock("@/components/auth/LoginCard", () => ({
  LoginCard: (props: Record<string, unknown>) => loginCardMock(props),
}));

let SignInOverlay: (typeof import("../SignInOverlay"))["SignInOverlay"];

describe("SignInOverlay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  beforeAll(async () => {
    ({ SignInOverlay } = await import("../SignInOverlay"));
  });

  beforeEach(() => {
    loginCardMock.mockClear();
    overlayMountProps.mockClear();
  });

  it("renders the login card", () => {
    render(<SignInOverlay />);

    expect(screen.getByTestId("login-card")).toBeInTheDocument();
  });

  it("mounts overlay content with the configured identifier", () => {
    render(<SignInOverlay />);

    expect(overlayMountProps).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "sign-in-overlay",
        options: expect.objectContaining({
          interactive: true,
          maxWidth: "100%",
          padding: "$0",
        }),
      }),
    );
  });

  it("passes redirect overrides down to the login card", () => {
    render(<SignInOverlay redirectOverride="/admin/acme/events" />);

    expect(loginCardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        redirectOverride: "/admin/acme/events",
        onDismissAction: undefined,
        onRequestCreateAccountAction: undefined,
      }),
    );
  });

  it("wires the dismissal callback into the login card when provided", () => {
    const onRequestClose = vi.fn();

    render(<SignInOverlay onRequestCloseAction={onRequestClose} />);

    expect(loginCardMock).toHaveBeenCalledWith(
      expect.objectContaining({ onDismissAction: onRequestClose }),
    );
  });

  it("wires create-account requests into the login card", () => {
    const onRequestSignUp = vi.fn();

    render(<SignInOverlay onRequestSignUpAction={onRequestSignUp} />);

    expect(loginCardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        onRequestCreateAccountAction: onRequestSignUp,
      }),
    );
  });

  it("dismisses when the backdrop is clicked", () => {
    const onRequestClose = vi.fn();
    render(<SignInOverlay onRequestCloseAction={onRequestClose} />);

    // Backdrop dismissal is guarded to avoid immediate accidental closes.
    fireEvent.click(screen.getByTestId("sign-in-overlay-backdrop"));
    expect(onRequestClose).not.toHaveBeenCalled();

    // The explicit close button still closes.
    fireEvent.click(
      screen.getByRole("button", { name: /closeSignInOverlay/i }),
    );
    // Wait for animation to complete
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });

  it("does not dismiss when clicking inside the card", () => {
    const onRequestClose = vi.fn();
    render(<SignInOverlay onRequestCloseAction={onRequestClose} />);

    fireEvent.click(screen.getByTestId("login-card"));

    expect(onRequestClose).not.toHaveBeenCalled();
  });

  it("dismisses when Escape is pressed (before interaction)", () => {
    const onRequestClose = vi.fn();
    render(<SignInOverlay onRequestCloseAction={onRequestClose} />);

    // Escape dismissal is also guarded shortly after mount.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onRequestClose).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: /closeSignInOverlay/i }),
    );
    // Wait for animation to complete
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });

  it("does not dismiss from backdrop once the user has interacted with the dialog", () => {
    const onRequestClose = vi.fn();
    render(<SignInOverlay onRequestCloseAction={onRequestClose} />);

    // Interact with the dialog.
    fireEvent.click(screen.getByTestId("login-card"));
    fireEvent.click(screen.getByTestId("sign-in-overlay-backdrop"));

    expect(onRequestClose).not.toHaveBeenCalled();
  });

  it("does not dismiss via Escape while submitting", () => {
    const onRequestClose = vi.fn();
    render(<SignInOverlay onRequestCloseAction={onRequestClose} />);

    const statusChange = loginCardMock.mock.calls[0]?.[0]
      ?.onStatusChangeAction as
      | ((status: "idle" | "submitting") => void)
      | undefined;
    expect(statusChange).toBeTypeOf("function");
    act(() => {
      statusChange?.("submitting");
    });

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByTestId("sign-in-overlay-backdrop"));

    // Close button should still work even if other dismissal is disabled.
    fireEvent.click(
      screen.getByRole("button", { name: /closeSignInOverlay/i }),
    );
    // Wait for animation to complete
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });

  it("renders a close button when dismiss handling is provided", () => {
    const onRequestClose = vi.fn();
    render(<SignInOverlay onRequestCloseAction={onRequestClose} />);

    fireEvent.click(
      screen.getByRole("button", { name: /closeSignInOverlay/i }),
    );
    // Wait for animation to complete
    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });
});
