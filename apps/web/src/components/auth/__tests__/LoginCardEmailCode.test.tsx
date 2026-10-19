import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Email-code (OTP) sign-in path on the sign-in card.
 *
 * Deliberately mocks LESS than `LoginCard.test.tsx`: `@/lib/redirect`,
 * `../useAuthRedirect` and `../auth-helpers` are all REAL here, because the
 * thing most worth pinning is that a post-sign-in redirect actually round-trips
 * for BOTH query-param shapes in the wild —
 *   - `?redirect_url=` emitted by `middleware/private-route-gate.ts`
 *   - `?redirect=`     emitted by `components/auth/AppAuthGate.tsx`
 * Mocking `readRedirectParam` (as the sibling test does) would make that
 * assertion vacuous.
 */

const {
  replaceMock,
  pathnameMock,
  searchParamsMock,
  sendVerificationOtpMock,
  signInEmailOtpMock,
} = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  pathnameMock: vi.fn(() => "/sign-in"),
  searchParamsMock: vi.fn(() => new URLSearchParams()),
  // Loosely typed on purpose: individual cases swap in `{ data: null, error }`
  // shapes, which a value-inferred signature would reject.
  sendVerificationOtpMock: vi.fn(
    async (): Promise<{ data: unknown; error: unknown }> => ({
      data: { success: true },
      error: null,
    }),
  ),
  signInEmailOtpMock: vi.fn(
    async (): Promise<{ data: unknown; error: unknown }> => ({
      data: { token: "t", user: {} },
      error: null,
    }),
  ),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
  usePathname: () => pathnameMock(),
  useSearchParams: () => searchParamsMock(),
}));

vi.mock("tamagui", () => {
  const Stack = ({
    children,
    onPress,
    ...rest
  }: { children?: ReactNode; onPress?: () => void } & Record<
    string,
    unknown
  >) => (
    <div onClick={onPress} {...rest}>
      {children}
    </div>
  );
  const styled = (Component: React.ComponentType<any>) => Component;
  return { XStack: Stack, YStack: Stack, styled } satisfies Record<
    string,
    unknown
  >;
});

vi.mock("@th/ui", () => {
  const Button = ({
    children,
    onPress,
    type,
    disabled,
    ...rest
  }: {
    children?: ReactNode;
    onPress?: () => void;
    type?: string;
    disabled?: boolean;
  } & Record<string, unknown>) => {
    const { icon: _icon, variant: _variant, ...passthrough } = rest;
    return (
      <button
        type={(type as "button" | "submit" | undefined) ?? "button"}
        onClick={onPress}
        disabled={disabled}
        {...passthrough}
      >
        {children}
      </button>
    );
  };
  const LabeledTextInput = ({
    testId,
    label,
    value,
    onChangeText,
    disabled,
  }: {
    testId?: string;
    label?: string;
    value?: string;
    onChangeText?: (v: string) => void;
    disabled?: boolean;
  }) => (
    <label>
      {label}
      <input
        data-testid={testId}
        value={value}
        disabled={disabled}
        onChange={(e) => onChangeText?.(e.target.value)}
      />
    </label>
  );
  const LabeledPasswordInput = LabeledTextInput;
  const Spinner = () => null;
  const Text = ({ children }: { children?: ReactNode }) => (
    <span>{children}</span>
  );
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
    emailOtp: {
      sendVerificationOtp: sendVerificationOtpMock,
    },
    signIn: {
      email: vi.fn(async () => ({ data: {}, error: null })),
      username: vi.fn(async () => ({ data: {}, error: null })),
      passkey: vi.fn(async () => ({ data: {}, error: null })),
      social: vi.fn(async () => ({ data: {}, error: null })),
      emailOtp: signInEmailOtpMock,
    },
  },
}));

vi.mock("@/lib/trace-ignored-error", () => ({
  traceIgnoredError: () => () => true,
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
  AuthCardShell: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
}));

let LoginCard: (typeof import("../LoginCard"))["LoginCard"];

const KNOWN_EMAIL = "buyer@example.com";
const UNKNOWN_EMAIL = "nobody@example.com";

/**
 * What step 1 is answered with before the email-code path is reachable.
 *
 * A USERNAME, not an address, on purpose. Step 1 accepts either, and the panel
 * seeds its address field from the step-1 identifier only when that identifier
 * looks like an email. Seeding a constant here would put a second, different
 * address into the rendered output of the enumeration test below, where the
 * whole method is normalising the one address out of the DOM and diffing the
 * rest. Keeping step 1 address-free means the ONLY email in the panel is the
 * one the case under test typed, and the value shares no substring with either
 * address so the normalisation cannot chew a hole in it. The seed itself is
 * covered separately.
 */
const STEP_ONE_IDENTIFIER = "otp-only-user";

/**
 * Walk step 1 (`ACCESS \u00b7 01`) and open the email-code panel on step 2.
 *
 * The toggle no longer sits on the first view as a collapsed peer of the
 * passkey CTA. The reader says who they are, and the panel opens in place on
 * the credential step, beside `FORGOT YOUR PASSWORD?` — which is where somebody
 * who has no password actually looks.
 */
async function openEmailCodePanel(identifier: string = STEP_ONE_IDENTIFIER) {
  fireEvent.change(screen.getByTestId("auth-sign-in-email"), {
    target: { value: identifier },
  });
  fireEvent.click(screen.getByTestId("auth-sign-in-continue"));

  const toggle = await screen.findByTestId("auth-email-code-toggle");
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(toggle.getAttribute("aria-expanded")).toBe("true"),
  );
  return toggle;
}

/** Reach step 2, open the panel, type an address, and submit the request. */
async function requestCode(email: string) {
  await openEmailCodePanel();

  fireEvent.change(screen.getByTestId("auth-email-code-email"), {
    target: { value: email },
  });
  fireEvent.submit(screen.getByTestId("auth-email-code-request-form"));

  await waitFor(() =>
    expect(screen.getByTestId("auth-email-code-verify-form")).toBeTruthy(),
  );
}

function submitCode(code: string) {
  fireEvent.change(screen.getByTestId("auth-email-code-otp"), {
    target: { value: code },
  });
  fireEvent.submit(screen.getByTestId("auth-email-code-verify-form"));
}

describe("LoginCard — email-code (OTP) sign-in", () => {
  beforeAll(async () => {
    ({ LoginCard } = await import("../LoginCard"));
  });

  beforeEach(() => {
    replaceMock.mockReset();
    pathnameMock.mockReset();
    pathnameMock.mockReturnValue("/sign-in");
    searchParamsMock.mockReset();
    searchParamsMock.mockReturnValue(new URLSearchParams());
    sendVerificationOtpMock.mockReset();
    sendVerificationOtpMock.mockResolvedValue({
      data: { success: true },
      error: null,
    });
    signInEmailOtpMock.mockReset();
    signInEmailOtpMock.mockResolvedValue({
      data: { token: "t", user: {} },
      error: null,
    });
  });

  it("stays off step 1 and opens collapsed on the credential step", async () => {
    // jsdom has no WebAuthn; the passkey CTA only renders when it is present.
    Object.defineProperty(window, "PublicKeyCredential", {
      configurable: true,
      writable: true,
      value: function PublicKeyCredential() {},
    });

    render(<LoginCard />);

    // Step 1 identifies. Passkey is one of its three ink-outline peers; the
    // email-code path is not on this view at all — it was a fifth peer on a
    // page that already had too many.
    expect(screen.getByTestId("auth-sign-in-passkey")).toBeTruthy();
    expect(screen.queryByTestId("auth-email-code-toggle")).toBeNull();

    fireEvent.change(screen.getByTestId("auth-sign-in-email"), {
      target: { value: STEP_ONE_IDENTIFIER },
    });
    fireEvent.click(screen.getByTestId("auth-sign-in-continue"));

    // Step 2 authenticates. The toggle is here, and it starts CLOSED so the
    // password field stays the step's obvious answer.
    const toggle = await screen.findByTestId("auth-email-code-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe("auth-email-code-panel");
    expect(screen.getByTestId("auth-sign-in-password")).toBeTruthy();

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(toggle.getAttribute("aria-expanded")).toBe("true"),
    );
    expect(screen.getByTestId("auth-email-code-request-form")).toBeTruthy();
  });

  it("seeds the address from step 1 when the identifier is an address", async () => {
    render(<LoginCard />);
    await openEmailCodePanel(KNOWN_EMAIL);

    // The reader already typed this once; asking for it again on the next
    // screen is the panel making them repeat themselves.
    expect(
      (screen.getByTestId("auth-email-code-email") as HTMLInputElement).value,
    ).toBe(KNOWN_EMAIL);
  });

  it("does not seed the address from a username identifier", async () => {
    render(<LoginCard />);
    await openEmailCodePanel(STEP_ONE_IDENTIFIER);

    // Step 1 takes email OR username, and this endpoint can do nothing with a
    // username — seeding one would hand the reader a value that can only fail.
    expect(
      (screen.getByTestId("auth-email-code-email") as HTMLInputElement).value,
    ).toBe("");
  });

  it("requests a sign-in code for the typed address", async () => {
    render(<LoginCard />);
    await requestCode(KNOWN_EMAIL);

    expect(sendVerificationOtpMock).toHaveBeenCalledTimes(1);
    expect(sendVerificationOtpMock).toHaveBeenCalledWith({
      email: KNOWN_EMAIL,
      type: "sign-in",
    });

    // The expiry is stated up front rather than left to fail mysteriously.
    const notice = screen.getByTestId("auth-email-code-notice");
    expect(notice.textContent).toContain(KNOWN_EMAIL);
    expect(notice.textContent).toContain("10 minutes");
    expect(notice.getAttribute("aria-live")).toBe("polite");
  });

  it("rejects a malformed address locally without calling the API", async () => {
    render(<LoginCard />);

    await openEmailCodePanel();
    fireEvent.change(screen.getByTestId("auth-email-code-email"), {
      target: { value: "not-an-email" },
    });
    fireEvent.submit(screen.getByTestId("auth-email-code-request-form"));

    expect(sendVerificationOtpMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("auth-email-code-error").textContent).toContain(
      "valid email address",
    );
  });

  it("keeps a rejected code on step 2 with the address intact", async () => {
    signInEmailOtpMock.mockResolvedValue({
      data: null,
      error: { code: "INVALID_OTP", message: "Invalid OTP", status: 400 },
    });

    render(<LoginCard />);
    await requestCode(KNOWN_EMAIL);
    submitCode("000000");

    await waitFor(() =>
      expect(screen.getByTestId("auth-email-code-error")).toBeTruthy(),
    );

    const alert = screen.getByTestId("auth-email-code-error");
    // Announced, not merely coloured.
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("That code didn't work");

    // Still on the panel's code step, and no navigation happened.
    expect(screen.getByTestId("auth-email-code-verify-form")).toBeTruthy();
    expect(replaceMock).not.toHaveBeenCalled();

    // The code is still alive, so the "sent to <address>" orientation stays —
    // it is the only thing on screen naming the address the code went to.
    expect(
      screen.getByTestId("auth-email-code-notice").textContent,
    ).toContain(KNOWN_EMAIL);

    // The address survived: stepping back shows it still typed in.
    fireEvent.click(screen.getByTestId("auth-email-code-change-email"));
    await waitFor(() =>
      expect(screen.getByTestId("auth-email-code-request-form")).toBeTruthy(),
    );
    expect(
      (screen.getByTestId("auth-email-code-email") as HTMLInputElement).value,
    ).toBe(KNOWN_EMAIL);
  });

  it("explains an expired code instead of showing a bare failure", async () => {
    signInEmailOtpMock.mockResolvedValue({
      data: null,
      error: { code: "OTP_EXPIRED", message: "OTP expired", status: 400 },
    });

    render(<LoginCard />);
    await requestCode(KNOWN_EMAIL);
    submitCode("123456");

    await waitFor(() =>
      expect(
        screen.getByTestId("auth-email-code-error").textContent,
      ).toContain("expired"),
    );

    // The server discarded the code, so "it expires in 10 minutes" is now a
    // lie and must come down.
    expect(screen.queryByTestId("auth-email-code-notice")).toBeNull();
  });

  it.each([
    ["STAFF_ACCOUNT_USE_PASSKEY", "auth.staffUsePasskeySignIn"],
    ["TWO_FACTOR_ACCOUNT_USE_PRIMARY_SIGN_IN", "auth.twoFactorUsePrimarySignIn"],
  ])(
    "shows the translated copy for a %s refusal, not the server's English",
    async (code, key) => {
      signInEmailOtpMock.mockResolvedValue({
        data: null,
        error: { code, message: "English from the API", status: 400 },
      });

      render(<LoginCard />);
      await requestCode(KNOWN_EMAIL);
      submitCode("123456");

      await waitFor(() =>
        expect(screen.getByTestId("auth-email-code-error").textContent).toBe(
          key,
        ),
      );
    },
  );

  it("drops the sent-notice when the server has burned the code", async () => {
    signInEmailOtpMock.mockResolvedValue({
      data: null,
      error: {
        code: "TOO_MANY_ATTEMPTS",
        message: "Too many attempts",
        status: 403,
      },
    });

    render(<LoginCard />);
    await requestCode(KNOWN_EMAIL);
    submitCode("123456");

    await waitFor(() =>
      expect(
        screen.getByTestId("auth-email-code-error").textContent,
      ).toContain("Send a new one"),
    );
    expect(screen.queryByTestId("auth-email-code-notice")).toBeNull();
  });

  // Both shapes are live: the middleware gate emits `redirect_url`, AppAuthGate
  // emits `redirect`. `readRedirectParam` is the REAL one in this file.
  it.each([
    ["redirect_url", "/my-tickets/order-123"],
    ["redirect", "/my-tickets/order-123"],
  ])(
    "signs in and honours ?%s= on success",
    async (paramName, target) => {
      searchParamsMock.mockReturnValue(
        new URLSearchParams(`${paramName}=${encodeURIComponent(target)}`),
      );

      render(<LoginCard />);
      await requestCode(KNOWN_EMAIL);
      submitCode("131287");

      await waitFor(() =>
        expect(signInEmailOtpMock).toHaveBeenCalledWith({
          email: KNOWN_EMAIL,
          otp: "131287",
        }),
      );
      await waitFor(() => expect(replaceMock).toHaveBeenCalledWith(target));
    },
  );

  it("falls back to / when no redirect param is present", async () => {
    render(<LoginCard />);
    await requestCode(KNOWN_EMAIL);
    submitCode("131287");

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/"));
  });

  it("renders identically for an address with no account", async () => {
    // The API answers `{"success":true}` either way; the UI must not add a
    // tell. Compare the rendered panel with the address itself normalised out.
    const capture = async (email: string) => {
      const { container, unmount } = render(<LoginCard />);
      await requestCode(email);
      const text = (container.textContent ?? "")
        .split(email)
        .join("<EMAIL>")
        // The resend countdown ticks in real time; a second between the two
        // captures would otherwise read as a difference in the two responses.
        .replace(/Resend in \d+s/g, "Resend in <N>s");
      unmount();
      return text;
    };

    const known = await capture(KNOWN_EMAIL);
    sendVerificationOtpMock.mockClear();
    const unknown = await capture(UNKNOWN_EMAIL);

    // Guard against the diff going vacuous. If a future navigation change left
    // `capture` looking at an empty or pre-send panel, two empty strings would
    // compare equal and this security property would silently stop being
    // tested.
    expect(known).toContain("<EMAIL>");
    expect(known).toContain("Code sent");
    expect(known).toContain("auth.lcSignIn");

    expect(unknown).toBe(known);
    expect(unknown).not.toMatch(/no account|not found|doesn't exist/i);
  });

  it("throttles resend and states the wait", async () => {
    render(<LoginCard />);
    await requestCode(KNOWN_EMAIL);

    const resend = screen.getByTestId(
      "auth-email-code-resend",
    ) as HTMLButtonElement;
    expect(resend.disabled).toBe(true);
    expect(resend.textContent).toMatch(/Resend in \d+s/);
  });
});
