import React from "react";
import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TranslationProvider } from "@th/ui";
import type { Messages } from "@th/ui";
import enPackage from "@th/locale/messages/en.json";

import enApp from "@/i18n/messages/en";
import { pickDomProps } from "@/test-support/pick-dom-props";

/**
 * B2 (owner ruling 2026-10-16): an unverified account's lineups are withheld
 * with `email_verification_required`. /my-lineups used to answer that with
 * "couldn't load" and a Try again that could never work. It must ask for the
 * email code instead (the same prompt as /my-tickets), and once the code is
 * accepted the list must load without a reload (every tRPC query is
 * invalidated).
 */

const mocks = vi.hoisted(() => ({
  listQuery: { current: {} as Record<string, unknown> },
  invalidate: vi.fn(async () => undefined),
  refetch: vi.fn(),
  sendVerificationOtp: vi.fn(async () => ({ error: null })),
  verifyEmail: vi.fn(async () => ({ error: null as null | { message: string } })),
  getSession: vi.fn(async () => ({})),
}));

vi.mock("@/trpc", () => ({
  trpc: {
    eventHumans: {
      listMine: { useInfiniteQuery: () => mocks.listQuery.current },
      leave: {
        useMutation: () => ({
          mutateAsync: vi.fn(),
          isPending: false,
          variables: undefined,
        }),
      },
    },
    useUtils: () => ({ invalidate: mocks.invalidate }),
  },
}));

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: { user: { email: "ana@example.com", emailVerified: false } },
      isPending: false,
    }),
    getSession: mocks.getSession,
    emailOtp: {
      sendVerificationOtp: mocks.sendVerificationOtp,
      verifyEmail: mocks.verifyEmail,
      changeEmail: vi.fn(),
    },
    signIn: { email: vi.fn() },
  },
}));

vi.mock("@bprogress/next/app", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/components/layout/AppOverlayProvider", () => ({
  useAppOverlay: () => ({ showSignInOverlay: vi.fn() }),
}));

/**
 * Tamagui's frames need a TamaguiProvider + theme jsdom has no business
 * booting, so the layout primitives render as plain DOM that keeps the
 * attributes assertions read (`pickDomProps`).
 */
vi.mock("tamagui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("tamagui")>();
  const Stack = React.forwardRef<
    HTMLDivElement,
    Record<string, unknown>
  >(({ children, ...rest }, ref) => (
    <div ref={ref} {...pickDomProps(rest)}>
      {children as ReactNode}
    </div>
  ));
  Stack.displayName = "Stack";
  return {
    ...actual,
    Stack,
    XStack: Stack,
    YStack: Stack,
    styled: () => Stack,
    useThemeName: () => "stub",
  };
});

vi.mock("@/components/auth/AuthCardShell", () => ({
  AuthCardShell: ({ children }: { children?: ReactNode }) => (
    <div data-testid="auth-card-shell">{children}</div>
  ),
}));

/**
 * Real `@th/ui` translations (the copy under test is the shipped catalog);
 * the Tamagui-backed atoms render as plain DOM.
 */
vi.mock("@th/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@th/ui")>();
  const { ButtonStub } = await import("@/test-support/th-ui-button-stub");
  const Text = ({
    children,
    ...rest
  }: { children?: ReactNode } & Record<string, unknown>) => (
    <span {...pickDomProps(rest)}>{children}</span>
  );
  const Modal = Object.assign(
    ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? <div role="dialog">{children}</div> : null,
    {
      Panel: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    },
  );
  return {
    ...actual,
    Text,
    Spinner: () => null,
    Modal,
    useNotify: () => ({
      toast: { success: vi.fn(), danger: vi.fn(), info: vi.fn(), warning: vi.fn() },
      alert: { success: vi.fn(), danger: vi.fn(), info: vi.fn(), warning: vi.fn() },
    }),
    Button: ButtonStub,
  };
});

import { MyLineups } from "../MyLineups";

const mergeCatalogs = (base: Messages, override: Messages): Messages => {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = result[key];
    if (
      typeof value === "object" &&
      value !== null &&
      typeof existing === "object" &&
      existing !== null
    ) {
      result[key] = mergeCatalogs(existing as Messages, value as Messages);
    } else {
      result[key] = value;
    }
  }
  return result as Messages;
};

const messages = mergeCatalogs(enPackage as unknown as Messages, enApp);

const renderPage = () =>
  render(
    <TranslationProvider locale="en" messages={messages}>
      <MyLineups />
    </TranslationProvider>,
  );

/** The wire shape of the gate: FORBIDDEN, message is the code. */
const gateError = {
  name: "TRPCClientError",
  message: "email_verification_required",
  data: { code: "FORBIDDEN", httpStatus: 403, appCode: "FORBIDDEN" },
};

describe("MyLineups: lineups withheld until the email is verified (B2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listQuery.current = {
      data: undefined,
      isLoading: false,
      error: gateError,
      isSuccess: false,
      refetch: mocks.refetch,
    };
  });

  it("asks for the email code instead of offering a retry", () => {
    renderPage();

    const prompt = screen.getByTestId("email-verification-required");
    expect(prompt).toHaveTextContent("Verify your email to see your lineups");
    expect(prompt).toHaveTextContent("ana@example.com");
    expect(prompt).toHaveTextContent("Lineups you're on show here");
    expect(
      screen.getByRole("button", { name: "Email me a code" }),
    ).toBeInTheDocument();

    expect(
      screen.queryByTestId("my-lineups-error"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /try again/i }),
    ).not.toBeInTheDocument();
    // Same header as the loaded list: back link, title, description.
    // (The Text stub renders a span, so the h1 is checked by its text.)
    expect(screen.getByText("My lineups")).toBeInTheDocument();
    expect(
      screen.getByText(/Events where an organiser has put your name/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Back to home" }),
    ).toBeInTheDocument();
  });

  it("still shows the ordinary retry for any other failure", () => {
    mocks.listQuery.current = {
      ...mocks.listQuery.current,
      error: { message: "Internal server error", data: { code: "INTERNAL_SERVER_ERROR" } },
    };
    renderPage();

    expect(screen.getByTestId("my-lineups-error")).toBeInTheDocument();
    expect(
      screen.queryByTestId("email-verification-required"),
    ).not.toBeInTheDocument();
  });

  it("sends a code, verifies it, then refetches so the lineups appear", async () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Email me a code" }));

    await waitFor(() =>
      expect(mocks.sendVerificationOtp).toHaveBeenCalledWith({
        email: "ana@example.com",
        type: "email-verification",
      }),
    );

    const otp = await screen.findByTestId("auth-verify-email-otp");
    await act(async () => {
      fireEvent.change(otp, { target: { value: "123456" } });
    });

    await waitFor(() =>
      expect(mocks.verifyEmail).toHaveBeenCalledWith({
        email: "ana@example.com",
        otp: "123456",
      }),
    );
    // VerifyEmailCard holds its success beat for 800ms, then continues.
    await waitFor(() => expect(mocks.invalidate).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });
  });

  it("a refetch while the code card is open does not unmount it", async () => {
    const { rerender } = renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Email me a code" }));
    const otp = await screen.findByTestId("auth-verify-email-otp");
    fireEvent.change(otp, { target: { value: "12" } });

    // A focus refetch of an errored, data-less query: pending, error null.
    mocks.listQuery.current = {
      data: undefined,
      isLoading: true,
      error: null,
      isSuccess: false,
      refetch: mocks.refetch,
    };
    rerender(
      <TranslationProvider locale="en" messages={messages}>
        <MyLineups />
      </TranslationProvider>,
    );
    expect(screen.getByTestId("auth-verify-email-otp")).toBe(otp);
    expect(otp).toHaveValue("12");

    // ...and it settles on the same refusal.
    mocks.listQuery.current = {
      data: undefined,
      isLoading: false,
      error: gateError,
      isSuccess: false,
      refetch: mocks.refetch,
    };
    rerender(
      <TranslationProvider locale="en" messages={messages}>
        <MyLineups />
      </TranslationProvider>,
    );
    expect(screen.getByTestId("auth-verify-email-otp")).toBe(otp);
    expect(mocks.sendVerificationOtp).toHaveBeenCalledTimes(1);
  });

  it("shows the normal list once the lineups load", () => {
    const { rerender } = renderPage();
    expect(screen.getByTestId("email-verification-required")).toBeInTheDocument();

    mocks.listQuery.current = {
      data: { pages: [{ items: [], nextCursor: null }] },
      isLoading: false,
      error: null,
      isSuccess: true,
      refetch: mocks.refetch,
    };
    rerender(
      <TranslationProvider locale="en" messages={messages}>
        <MyLineups />
      </TranslationProvider>,
    );
    expect(
      screen.queryByTestId("email-verification-required"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("my-lineups-content")).toBeInTheDocument();
  });

  it("keeps the prompt and invalidates nothing when the code is wrong", async () => {
    mocks.verifyEmail.mockResolvedValueOnce({
      error: { message: "Invalid OTP" },
    });
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Email me a code" }));
    const otp = await screen.findByTestId("auth-verify-email-otp");
    await act(async () => {
      fireEvent.change(otp, { target: { value: "000000" } });
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid OTP");
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
});
