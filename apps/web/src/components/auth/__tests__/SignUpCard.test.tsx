import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { replaceMock, pathnameMock, signUpEmailMock } = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  pathnameMock: vi.fn(() => "/"),
  signUpEmailMock: vi.fn(async (_input: Record<string, unknown>) => ({
    data: {},
    error: null,
  })),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
  usePathname: () => pathnameMock(),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("tamagui", () => {
  const Stack = ({
    children,
    onPress,
    ...rest
  }: { children?: ReactNode; onPress?: () => void } & Record<string, unknown>) => (
    <div onClick={onPress} {...rest}>
      {children}
    </div>
  );
  const styled = (Component: React.ComponentType<any>) => Component;
  return { XStack: Stack, YStack: Stack, styled } satisfies Record<string, unknown>;
});

vi.mock("@th/ui", () => {
  const Button = ({
    children,
    onPress,
    type,
    ...rest
  }: {
    children?: ReactNode;
    onPress?: () => void;
    type?: string;
  } & Record<string, unknown>) => {
    const { icon: _icon, variant: _variant, asChild: _asChild, ...passthrough } = rest;
    return (
      <button
        type={(type as "button" | "submit" | undefined) ?? "button"}
        onClick={onPress}
        {...passthrough}
      >
        {children}
      </button>
    );
  };
  const LabeledTextInput = ({
    testId,
    value,
    onChangeText,
  }: {
    testId?: string;
    value?: string;
    onChangeText?: (v: string) => void;
  }) => (
    <input
      data-testid={testId}
      value={value}
      onChange={(e) => onChangeText?.(e.target.value)}
    />
  );
  const LabeledPasswordInput = LabeledTextInput;
  const NextLinkAnchor = ({ children }: { children?: ReactNode }) => <a>{children}</a>;
  const ProgressBar = () => null;
  const Spinner = () => null;
  const Text = ({ children }: { children?: ReactNode }) => <span>{children}</span>;
  const useTranslations = () => (key: string) => key;
  return {
    Button,
    LabeledPasswordInput,
    LabeledTextInput,
    NextLinkAnchor,
    ProgressBar,
    Spinner,
    Text,
    useTranslations,
  } satisfies Record<string, unknown>;
});

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: {
    signOut: vi.fn(async () => ({})),
    signUp: {
      email: signUpEmailMock,
    },
    signIn: {
      social: vi.fn(async () => ({ data: {}, error: null })),
    },
  },
}));

vi.mock("@/lib/trace-ignored-error", () => ({
  traceIgnoredError: () => () => true,
}));

vi.mock("@/lib/auth/urls", () => ({
  getSignInUrl: () => "/sign-in",
}));

vi.mock("@/lib/auth/password-strength", () => ({
  evaluatePasswordStrength: (password: string) => ({
    score: password.length > 0 ? 4 : 0,
    level: "strong",
    metRequirements: password.length >= 10,
    suggestions: [],
  }),
  passwordStrengthLabel: () => "Strong",
}));

vi.mock("@/lib/redirect", () => ({
  appendRedirectParam: (url: string) => url,
  readRedirectParam: () => null,
}));

vi.mock("@th/errors", () => ({
  normalizeError: () => ({ code: "UNKNOWN" }),
}));

vi.mock("../auth-helpers", () => ({
  formatAuthErrorMessage: (err: unknown) => String(err),
  isWebAuthnCancel: () => false,
}));

vi.mock("@/hooks/useFormErrors", () => ({
  useFormErrors: () => ({
    fieldErrors: {},
    setError: vi.fn(),
    setFieldError: vi.fn(),
    clearField: vi.fn(),
    clearAll: vi.fn(),
  }),
}));

vi.mock("@/lib/validation", () => ({
  signUpSchema: {},
  validateForm: () => ({ success: true, fieldErrors: {} }),
}));

vi.mock("../OAuthProviderButtons", () => ({
  OAuthProviderButtons: () => <div data-testid="oauth-buttons" />,
}));

vi.mock("../OrDivider", () => ({
  OrDivider: () => <div data-testid="or-divider" />,
}));

vi.mock("../AuthCardShell", () => ({
  AuthCardShell: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("../useAuthRedirect", () => ({
  useAuthRedirect: () => ({
    destination: "/",
    oauthCallbackUrl: "http://localhost/",
  }),
}));

let SignUpCard: (typeof import("../SignUpCard"))["SignUpCard"];
let placeholderNameFromEmail: (typeof import("../SignUpCard"))["placeholderNameFromEmail"];

const EMAIL = "jane.doe@example.com";
const PASSWORD = "Str0ngPassword!";

describe("SignUpCard", () => {
  beforeAll(async () => {
    ({ SignUpCard, placeholderNameFromEmail } = await import("../SignUpCard"));
  });

  beforeEach(() => {
    replaceMock.mockReset();
    pathnameMock.mockReset();
    pathnameMock.mockReturnValue("/");
    signUpEmailMock.mockClear();
    signUpEmailMock.mockResolvedValue({ data: {}, error: null });
  });

  /**
   * Step 1 of 4 is email + password and nothing else. There is no disclosure
   * to open first — the form IS the step — and display name / username live
   * on the profile step (4 of 4) now.
   */
  async function submitSignUp(props: Parameters<typeof SignUpCard>[0] = {}) {
    render(<SignUpCard {...props} />);

    expect(screen.queryByTestId("auth-sign-up-expand-form")).toBeNull();
    expect(screen.queryByTestId("auth-sign-up-display-name")).toBeNull();
    expect(screen.queryByTestId("auth-sign-up-username")).toBeNull();
    expect(screen.queryByTestId("auth-sign-up-confirm-password")).toBeNull();

    fireEvent.change(screen.getByTestId("auth-sign-up-email"), {
      target: { value: EMAIL },
    });
    fireEvent.change(screen.getByTestId("auth-sign-up-password"), {
      target: { value: PASSWORD },
    });

    fireEvent.click(screen.getByTestId("auth-sign-up-submit"));

    await waitFor(() => expect(signUpEmailMock).toHaveBeenCalled());
  }

  it("skips the redundant replace when the resolved destination matches the current pathname", async () => {
    pathnameMock.mockReturnValue("/");

    await submitSignUp();

    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("still navigates when the resolved destination differs from the current pathname", async () => {
    pathnameMock.mockReturnValue("/some-other-page");

    await submitSignUp();

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/"));
  });

  it("hands off to the onboarding flow instead of navigating when a parent owns the next step", async () => {
    pathnameMock.mockReturnValue("/some-other-page");
    const onSignUpSuccessAction = vi.fn();

    await submitSignUp({ onSignUpSuccessAction });

    await waitFor(() =>
      expect(onSignUpSuccessAction).toHaveBeenCalledWith(EMAIL, PASSWORD),
    );
    expect(replaceMock).not.toHaveBeenCalled();
  });

  describe("what step 1 sends", () => {
    // Better Auth requires `name`; the profile step overwrites this placeholder.
    // `username` must NOT be sent — the plugin leaves the column NULL until
    // step 4 sets a real one, and a sent value would be a made-up handle the
    // user never chose.
    it("sends the email-derived placeholder as `name` and no `username`", async () => {
      await submitSignUp();

      const input = signUpEmailMock.mock.calls[0][0];
      expect(input.email).toBe(EMAIL);
      expect(input.password).toBe(PASSWORD);
      expect(input.name).toBe(placeholderNameFromEmail(EMAIL));
      expect(input.name).toBe("jane.doe");
      expect(input).not.toHaveProperty("username");
    });

    it("never uses the whole address as the placeholder", () => {
      expect(placeholderNameFromEmail("jane.doe@example.com")).toBe("jane.doe");
      expect(placeholderNameFromEmail("jane.doe@example.com")).not.toMatch(/@/);
      // Degenerate inputs still yield something non-empty for Better Auth.
      expect(placeholderNameFromEmail("nolocal")).toBe("nolocal");
      expect(placeholderNameFromEmail("@example.com")).toBe("@example.com");
    });
  });
});
