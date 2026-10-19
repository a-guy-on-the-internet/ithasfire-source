import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { hydrateRoot, type Root } from "react-dom/client";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { replaceMock, pathnameMock, signInEmailMock } = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  pathnameMock: vi.fn(() => "/"),
  signInEmailMock: vi.fn(async () => ({ data: {}, error: null })),
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
    const { icon: _icon, variant: _variant, ...passthrough } = rest;
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
  // `id` and `autoFocus` pass through: the card's focus latch finds its
  // fields by id, and the hydration tests below depend on both.
  const LabeledTextInput = ({
    testId,
    id,
    autoFocus,
    value,
    onChangeText,
  }: {
    testId?: string;
    id?: string;
    autoFocus?: boolean;
    value?: string;
    onChangeText?: (v: string) => void;
  }) => (
    <input
      data-testid={testId}
      id={id}
      autoFocus={autoFocus}
      value={value}
      onChange={(e) => onChangeText?.(e.target.value)}
    />
  );
  const LabeledPasswordInput = LabeledTextInput;
  const Spinner = () => null;
  const Text = ({ children }: { children?: ReactNode }) => <span>{children}</span>;
  const useTranslations = () => (key: string) => key;
  return {
    Button,
    LabeledPasswordInput,
    LabeledTextInput,
    Spinner,
    Text,
    useTranslations,
  } satisfies Record<string, unknown>;
});

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: {
    signOut: vi.fn(async () => ({})),
    signIn: {
      email: signInEmailMock,
      username: vi.fn(async () => ({ data: {}, error: null })),
      passkey: vi.fn(async () => ({ data: {}, error: null })),
      social: vi.fn(async () => ({ data: {}, error: null })),
    },
  },
}));

vi.mock("@/lib/trace-ignored-error", () => ({
  traceIgnoredError: () => () => true,
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
  loginSchema: {},
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

let LoginCard: (typeof import("../LoginCard"))["LoginCard"];

describe("LoginCard", () => {
  beforeAll(async () => {
    ({ LoginCard } = await import("../LoginCard"));
  });

  beforeEach(() => {
    replaceMock.mockReset();
    pathnameMock.mockReset();
    pathnameMock.mockReturnValue("/");
    signInEmailMock.mockClear();
    signInEmailMock.mockResolvedValue({ data: {}, error: null });
  });

  /**
   * Drive the two-step card end to end.
   *
   * Step 1 (`ACCESS \u00b7 01`) takes the identifier and CONTINUE; only then does
   * the password field mount on step 2 (`ACCESS \u00b7 02`). Both steps submit the
   * same `auth-sign-in-form`, so each CTA is a real `type="submit"` press
   * rather than a click handler — that is what the browser does, and it is the
   * only way the Enter-key path stays covered.
   */
  async function submitSignIn() {
    render(<LoginCard />);

    // ── Step 1: identify ──────────────────────────────────────────────────
    fireEvent.change(screen.getByTestId("auth-sign-in-email"), {
      target: { value: "user@example.com" },
    });
    // The password field does not exist yet — that is the whole point of the
    // split, so assert it rather than leaving it implied.
    expect(screen.queryByTestId("auth-sign-in-password")).toBeNull();

    fireEvent.click(screen.getByTestId("auth-sign-in-continue"));

    // ── Step 2: authenticate ──────────────────────────────────────────────
    const password = await screen.findByTestId("auth-sign-in-password");
    fireEvent.change(password, { target: { value: "hunter2" } });

    fireEvent.click(screen.getByTestId("auth-sign-in-submit"));

    await waitFor(() => expect(signInEmailMock).toHaveBeenCalled());
  }

  it("skips the redundant replace when the resolved destination matches the current pathname", async () => {
    pathnameMock.mockReturnValue("/");

    await submitSignIn();

    expect(replaceMock).not.toHaveBeenCalled();
  });

  it.each([
    ["STAFF_ACCOUNT_USE_PASSKEY", "auth.staffUsePasskeySignIn"],
    ["TWO_FACTOR_ACCOUNT_USE_PRIMARY_SIGN_IN", "auth.twoFactorUsePrimarySignIn"],
  ])(
    "a %s refusal on the password form shows the translated copy",
    async (code, key) => {
      const onErrorMessageChangeAction = vi.fn();
      signInEmailMock.mockResolvedValue({
        data: null,
        error: { code, message: "English from the API", status: 400 },
      } as never);

      render(<LoginCard onErrorMessageChangeAction={onErrorMessageChangeAction} />);
      fireEvent.change(screen.getByTestId("auth-sign-in-email"), {
        target: { value: "user@example.com" },
      });
      fireEvent.click(screen.getByTestId("auth-sign-in-continue"));
      fireEvent.change(await screen.findByTestId("auth-sign-in-password"), {
        target: { value: "hunter2" },
      });
      fireEvent.click(screen.getByTestId("auth-sign-in-submit"));

      await waitFor(() =>
        expect(onErrorMessageChangeAction).toHaveBeenCalledWith(key),
      );
      expect(replaceMock).not.toHaveBeenCalled();
    },
  );

  it("any other error on the password form still goes through the usual formatting", async () => {
    const onErrorMessageChangeAction = vi.fn();
    signInEmailMock.mockResolvedValue({
      data: null,
      error: "INVALID_EMAIL_OR_PASSWORD",
    } as never);

    render(<LoginCard onErrorMessageChangeAction={onErrorMessageChangeAction} />);
    fireEvent.change(screen.getByTestId("auth-sign-in-email"), {
      target: { value: "user@example.com" },
    });
    fireEvent.click(screen.getByTestId("auth-sign-in-continue"));
    fireEvent.change(await screen.findByTestId("auth-sign-in-password"), {
      target: { value: "hunter2" },
    });
    fireEvent.click(screen.getByTestId("auth-sign-in-submit"));

    // The mocked formatAuthErrorMessage is String(err).
    await waitFor(() =>
      expect(onErrorMessageChangeAction).toHaveBeenCalledWith(
        "INVALID_EMAIL_OR_PASSWORD",
      ),
    );
  });

  it("still navigates when the resolved destination differs from the current pathname", async () => {
    pathnameMock.mockReturnValue("/some-other-page");

    await submitSignIn();

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/"));
  });
  /**
   * /login server-renders this card. Before hydration the form is a plain
   * `<form>` with no action, so a native submit would GET `/login?email=…`
   * (the address in logs, history and Sentry URLs). It must be `inert` in the
   * server HTML and lose it once React owns it.
   */
  it("server-renders the form inert, so it cannot submit natively before hydration", () => {
    const html = renderToString(<LoginCard />);
    const form = /<form[^>]*data-testid="auth-sign-in-form"[^>]*>/.exec(html);

    expect(form?.[0]).toMatch(/\sinert(=""|\s|>)/);
  });

  it("drops inert once rendered on the client", () => {
    render(<LoginCard />);

    expect(screen.getByTestId("auth-sign-in-form").hasAttribute("inert")).toBe(
      false,
    );
  });
  /**
   * Hydrate the card over its own server HTML, the way /login does. The form
   * is `inert` in that HTML, so the browser's one-shot native autofocus skips
   * the email field and React does not re-apply `autoFocus` on hydration —
   * focus used to stay on <body>. The card has to focus the field itself once
   * the form is live, and only if nothing else has focus yet.
   */
  async function hydrateFromServerHtml(before?: (c: HTMLElement) => void) {
    const container = document.createElement("div");
    container.innerHTML = renderToString(<LoginCard />);
    document.body.appendChild(container);
    before?.(container);
    const focusCalls: { id: string; inert: boolean }[] = [];
    const focus = HTMLElement.prototype.focus;
    const spy = vi
      .spyOn(HTMLElement.prototype, "focus")
      .mockImplementation(function (this: HTMLElement, options) {
        focusCalls.push({
          id: this.id,
          inert: !!this.closest("form")?.hasAttribute("inert"),
        });
        focus.call(this, options);
      });
    let root: Root | undefined;
    await act(async () => {
      root = hydrateRoot(container, <LoginCard />);
      // Let the post-hydration render (inert off) and its effects commit.
      await Promise.resolve();
    });
    spy.mockRestore();
    return {
      focusCalls,
      cleanup: () => {
        act(() => root?.unmount());
        container.remove();
      },
    };
  }

  it("focuses the email field once a server-rendered card goes live", async () => {
    const { focusCalls, cleanup } = await hydrateFromServerHtml();
    try {
      expect(document.activeElement?.id).toBe("email");
      // Focused AFTER `inert` came off — a focus inside an inert form is a
      // no-op in a real browser, so it must not count.
      expect(focusCalls).toContainEqual({ id: "email", inert: false });
    } finally {
      cleanup();
    }
  });

  it("does not take focus from a control the reader reached before hydration", async () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    const { cleanup } = await hydrateFromServerHtml(() => outside.focus());
    try {
      expect(document.activeElement).toBe(outside);
    } finally {
      cleanup();
      outside.remove();
    }
  });
});
