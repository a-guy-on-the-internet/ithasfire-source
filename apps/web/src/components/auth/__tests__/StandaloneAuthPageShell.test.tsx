import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { signInErrorNotice } from "../sign-in-error-notice";

vi.mock("@th/ui", () => ({
  Button: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  NextLinkAnchor: ({
    children,
    href,
  }: {
    children?: ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  useNotify: () => ({
    toast: { danger: vi.fn(), success: vi.fn(), info: vi.fn() },
  }),
  useTranslations: () => (key: string, values?: Record<string, string>) => {
    if (key === "common.appTitle") return "Ithas Fire";
    if (values?.appTitle) return `${key}:${values.appTitle}`;
    return key;
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/sign-in",
}));

vi.mock("tamagui", () => ({
  YStack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  XStack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  // `AuthCardShell` renders the step band's segments as `Stack`s, and the
  // cards below build their footer rules with `styled(YStack, …)` at module
  // top level, so the base primitives have to exist here even though this
  // suite never renders the real card.
  Stack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  // The shell imports cards (TwoFactorChallengeCard, etc.) that call
  // `styled(...)` at module top level. Return the base component unchanged.
  styled: (component: unknown) => component,
  // `AuthCardShell` reads the theme to pick the offset print shadow. "stub"
  // is the app's default theme.
  useThemeName: () => "stub",
}));

vi.mock("../LoginCard", () => ({
  LoginCard: ({
    onRequestCreateAccountAction,
    onRequestForgotPasswordAction,
    noticeMessage,
  }: Record<string, (() => void) | undefined> & {
    noticeMessage?: ReactNode;
  }) => (
    <div data-testid="login-card">
      {noticeMessage ? (
        <p data-testid="notice-message">{noticeMessage}</p>
      ) : null}
      <button type="button" onClick={onRequestCreateAccountAction}>
        Create account
      </button>
      <button type="button" onClick={onRequestForgotPasswordAction}>
        Forgot password
      </button>
    </div>
  ),
}));

vi.mock("../SignUpCard", () => ({
  SignUpCard: ({
    onRequestSignInAction,
  }: Record<string, (() => void) | undefined>) => (
    <div data-testid="sign-up-card">
      <button type="button" onClick={onRequestSignInAction}>
        Sign in
      </button>
    </div>
  ),
}));

vi.mock("../ForgotPasswordCard", () => ({
  ForgotPasswordCard: ({
    onRequestSignInAction,
  }: Record<string, (() => void) | undefined>) => (
    <div data-testid="forgot-password-card">
      <button type="button" onClick={onRequestSignInAction}>
        Back to sign in
      </button>
    </div>
  ),
}));

let StandaloneAuthPageShell: (typeof import("../StandaloneAuthPageShell"))["StandaloneAuthPageShell"];

describe("StandaloneAuthPageShell", () => {
  beforeAll(async () => {
    ({ StandaloneAuthPageShell } = await import("../StandaloneAuthPageShell"));
  });

  it("switches inline between sign-in and forgot-password", () => {
    render(<StandaloneAuthPageShell initialPanel="sign-in" />);

    expect(screen.getByTestId("login-card")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Forgot password" }));
    expect(screen.getByTestId("forgot-password-card")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to sign in" }));
    expect(screen.getByTestId("login-card")).toBeInTheDocument();
  });

  it("switches inline between sign-up and sign-in", () => {
    render(<StandaloneAuthPageShell initialPanel="sign-up" />);

    expect(screen.getByTestId("sign-up-card")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByTestId("login-card")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(screen.getByTestId("sign-up-card")).toBeInTheDocument();
  });

  // ── Session notices ──────────────────────────────────────────────────
  // Three-valued rather than boolean because the two failure modes need
  // DIFFERENT copy, and the production incident always lands on the one that
  // used to say nothing at all: a host-only cookie the api host accepts and
  // the apex never sees re-checks as a perfectly valid session, so "your
  // session expired" is both unreachable there and untrue.
  describe("sessionNotice", () => {
    const noticeText = () =>
      screen.queryByTestId("notice-message")?.textContent ?? null;

    it("says nothing by default", () => {
      render(<StandaloneAuthPageShell initialPanel="sign-in" />);
      expect(noticeText()).toBeNull();
    });

    it("says nothing while the verdict is still unknown", () => {
      render(
        <StandaloneAuthPageShell initialPanel="sign-in" sessionNotice="none" />,
      );
      expect(noticeText()).toBeNull();
    });

    it("uses the expiry copy when the server returned no session", () => {
      render(
        <StandaloneAuthPageShell
          initialPanel="sign-in"
          sessionNotice="expired"
        />,
      );
      expect(noticeText()).toBe("auth.staleSessionSignInAgain");
    });

    it("uses distinct copy when the session is confirmed but unusable here", () => {
      render(
        <StandaloneAuthPageShell
          initialPanel="sign-in"
          sessionNotice="unverified"
        />,
      );
      expect(noticeText()).toBe("auth.unverifiableSessionSignInAgain");
      expect(noticeText()).not.toBe("auth.staleSessionSignInAgain");
    });

    it("tells a refused two-factor account to use its password or passkey", () => {
      render(
        <StandaloneAuthPageShell
          initialPanel="sign-in"
          sessionNotice="twoFactorUsePrimary"
        />,
      );
      expect(noticeText()).toBe("auth.twoFactorUsePrimarySignIn");
      expect(screen.queryByRole("link", { name: /support/i })).toBeNull();
    });

    it("tells a refused passkey-only staff account to use its passkey", () => {
      render(
        <StandaloneAuthPageShell
          initialPanel="sign-in"
          sessionNotice="staffUsePasskey"
        />,
      );
      expect(noticeText()).toBe("auth.staffUsePasskeySignIn");
    });

    it("tells an inactive account it can't sign in and links to support", () => {
      render(
        <StandaloneAuthPageShell
          initialPanel="sign-in"
          sessionNotice="accountNotActive"
        />,
      );
      expect(noticeText()).toBe(
        "auth.accountNotActiveSignIn auth.accountNotActiveContactSupport",
      );
      const link = screen.getByRole("link", {
        name: "auth.accountNotActiveContactSupport",
      });
      expect(link).toHaveAttribute("href", "/support");
    });
  });
});

// `/sign-in?error=` comes from the API's refusal redirects. Anything else is
// user-controlled URL text and must not reach the page.
describe("signInErrorNotice", () => {
  it("maps the two-factor refusal", () => {
    expect(signInErrorNotice("TWO_FACTOR_ACCOUNT_USE_PRIMARY_SIGN_IN")).toBe(
      "twoFactorUsePrimary",
    );
  });

  it("maps the staff passkey refusal", () => {
    expect(signInErrorNotice("STAFF_ACCOUNT_USE_PASSKEY")).toBe(
      "staffUsePasskey",
    );
  });

  it("maps the inactive-account refusal", () => {
    expect(signInErrorNotice("account_not_active")).toBe("accountNotActive");
  });

  it.each([null, undefined, "", "bogus", "<b>hi</b>", "ACCOUNT_NOT_ACTIVE"])(
    "ignores %s",
    (value) => {
      expect(signInErrorNotice(value)).toBe("none");
    },
  );
});

// The keys must exist in EVERY catalog: `t()` is loosely typed and a missing
// key renders the RAW key string to the user, which no test above would catch
// (they mock `useTranslations` to echo keys precisely so the mapping is
// assertable).
describe("session notice copy is translated in every catalog", () => {
  it.each(["en", "es"] as const)("%s", async (locale) => {
    const messages = (
      locale === "en"
        ? await import("@/i18n/messages/en")
        : await import("@/i18n/messages/es")
    ).default as { auth: Record<string, unknown> };

    for (const key of [
      "staleSessionSignInAgain",
      "unverifiableSessionSignInAgain",
      "twoFactorUsePrimarySignIn",
      "staffUsePasskeySignIn",
      "accountNotActiveSignIn",
      "accountNotActiveContactSupport",
    ]) {
      const value = messages.auth[key];
      expect(typeof value, `${locale}.auth.${key}`).toBe("string");
      expect((value as string).length).toBeGreaterThan(0);
    }

    // Same meaning, different sentence — sharing a string would defeat the
    // point of splitting them.
    expect(messages.auth.unverifiableSessionSignInAgain).not.toBe(
      messages.auth.staleSessionSignInAgain,
    );
  });
});
