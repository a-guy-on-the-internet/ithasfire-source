import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { addPasskeyMock, detectDeviceLabelMock, toastDangerMock, sessionNameMock } =
  vi.hoisted(() => ({
    addPasskeyMock: vi.fn(async (_options: { name: string }) => ({
      data: {},
      error: null as null | { code?: string; message?: string },
    })),
    detectDeviceLabelMock: vi.fn((): string | null => "macOS"),
    toastDangerMock: vi.fn(),
    // Between steps 1 and 4 the account's `name` is the email-derived
    // placeholder, so that is what the passkey name is built from.
    sessionNameMock: vi.fn((): string | undefined => "jane.doe"),
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

vi.mock("lucide-react", () => ({
  ArrowLeft: () => null,
  Copy: () => null,
  Check: () => null,
  Mail: () => null,
}));

vi.mock("qrcode.react", () => ({
  QRCodeSVG: () => null,
}));

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
  const TextInput = ({ testId }: { testId?: string }) => (
    <input data-testid={testId} />
  );
  const Spinner = () => null;
  const Text = ({ children }: { children?: ReactNode }) => <span>{children}</span>;
  const useTranslations = () => (key: string) => key;
  const useNotify = () => ({ toast: { danger: toastDangerMock, success: vi.fn() } });
  return { Button, TextInput, Spinner, Text, useTranslations, useNotify } satisfies Record<
    string,
    unknown
  >;
});

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: { user: { name: sessionNameMock() } } }),
    passkey: { addPasskey: addPasskeyMock },
    twoFactor: {
      enable: vi.fn(async () => ({ data: {}, error: null })),
      sendOtp: vi.fn(async () => ({ data: {}, error: null })),
      verifyTotp: vi.fn(async () => ({ data: {}, error: null })),
      verifyOtp: vi.fn(async () => ({ data: {}, error: null })),
    },
  },
}));

// Platform sniffing has its own suite (`src/lib/auth/__tests__/device-label`).
// Mocked so the derived name is deterministic — jsdom's UA matches none of
// the real patterns.
vi.mock("@/lib/auth/device-label", () => ({
  detectDeviceLabel: detectDeviceLabelMock,
}));

vi.mock("../auth-helpers", () => ({
  formatAuthErrorMessage: (err: unknown) =>
    typeof err === "object" && err && "message" in err
      ? String((err as { message: unknown }).message)
      : String(err),
  isWebAuthnCancel: () => false,
}));

vi.mock("../AuthCardShell", () => ({
  AuthCardShell: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

// The radiogroup has its own keyboard contract; here it is reduced to one
// button per option so the tests can pick a method and drive Continue.
vi.mock("../SecureMethodChoice", () => ({
  SecureMethodChoice: ({
    options,
    value,
    onChangeAction,
  }: {
    options: readonly { value: string; testId: string }[];
    value: string;
    onChangeAction: (v: string) => void;
  }) => (
    <div role="radiogroup">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          data-testid={option.testId}
          aria-checked={option.value === value}
          onClick={() => onChangeAction(option.value)}
        >
          {option.value}
        </button>
      ))}
    </div>
  ),
}));

let Setup2faCard: (typeof import("../Setup2faCard"))["Setup2faCard"];

describe("Setup2faCard — step 3, secure", () => {
  beforeAll(async () => {
    ({ Setup2faCard } = await import("../Setup2faCard"));
  });

  beforeEach(() => {
    // The passkey option is gated on WebAuthn support, which jsdom lacks —
    // without this the picker offers only TOTP/email and "Continue" would
    // take the authenticator path instead of the ceremony under test.
    // @ts-expect-error -- test override of a browser-only global.
    window.PublicKeyCredential = function PublicKeyCredential() {};
    addPasskeyMock.mockClear();
    addPasskeyMock.mockResolvedValue({ data: {}, error: null });
    detectDeviceLabelMock.mockClear();
    detectDeviceLabelMock.mockReturnValue("macOS");
    toastDangerMock.mockClear();
    sessionNameMock.mockReturnValue("jane.doe");
  });

  afterEach(() => {
    // @ts-expect-error -- test override of a browser-only global.
    delete window.PublicKeyCredential;
  });

  const renderCard = () => {
    const onDoneAction = vi.fn();
    const onSkipAction = vi.fn();
    render(
      <Setup2faCard
        password="Str0ngPassword!"
        onDoneAction={onDoneAction}
        onSkipAction={onSkipAction}
      />,
    );
    return { onDoneAction, onSkipAction };
  };

  it("leads with the passkey option selected", () => {
    renderCard();
    expect(screen.getByTestId("auth-2fa-choose-passkey")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByTestId("auth-2fa-skip")).toBeEnabled();
  });

  describe("passkey enrolment — moved here from the sign-up card", () => {
    // This is the drift-prone call site: it enrols a passkey seconds after
    // sign-up, far from the account-settings list that shows the result, so a
    // hand-rolled name here went unnoticed for a long time. It shares
    // `derivePasskeyName` from `@th/types` with account settings; this pins it.
    it("derives the shared name from the session's name + device label", async () => {
      const { onDoneAction } = renderCard();

      fireEvent.click(screen.getByTestId("auth-2fa-continue"));

      await waitFor(() => expect(addPasskeyMock).toHaveBeenCalled());
      const { name } = addPasskeyMock.mock.calls[0][0];
      expect(name).toBe("jane.doe’s macOS");
      // Never the email — a passkey name is rendered in a list the user shares
      // screenshots of.
      expect(name).not.toMatch(/@/);
      // And never a date: the settings row already renders "Added <date>".
      expect(name).not.toMatch(/\d/);

      await waitFor(() => expect(onDoneAction).toHaveBeenCalled());
    });

    it("degrades to a device-free name when the platform can't be detected", async () => {
      detectDeviceLabelMock.mockReturnValue(null);
      renderCard();

      fireEvent.click(screen.getByTestId("auth-2fa-continue"));

      await waitFor(() =>
        expect(addPasskeyMock).toHaveBeenCalledWith({
          name: "jane.doe’s passkey",
        }),
      );
    });

    // Better Auth's passkey client does NOT throw for a refused ceremony — it
    // resolves `{ error: { code: "ERROR_CEREMONY_ABORTED" } }`. Browsers only
    // allow the ceremony from a real gesture and the reader can dismiss or
    // time it out, so a decline must land back on the picker, silently, with
    // Skip for now still in reach.
    it("returns to the picker silently when the ceremony is declined", async () => {
      addPasskeyMock.mockResolvedValue({
        data: {},
        error: { code: "ERROR_CEREMONY_ABORTED" },
      });
      const { onDoneAction } = renderCard();

      fireEvent.click(screen.getByTestId("auth-2fa-continue"));

      await waitFor(() => expect(addPasskeyMock).toHaveBeenCalled());
      await waitFor(() =>
        expect(screen.getByTestId("auth-2fa-choose-passkey")).toBeInTheDocument(),
      );
      expect(onDoneAction).not.toHaveBeenCalled();
      expect(toastDangerMock).not.toHaveBeenCalled();
      expect(screen.getByTestId("auth-2fa-skip")).toBeEnabled();
      expect(screen.getByTestId("auth-2fa-continue")).toBeInTheDocument();
    });

    it("still surfaces a genuine failure, and still returns to the picker", async () => {
      addPasskeyMock.mockResolvedValue({
        data: {},
        error: { code: "SOMETHING_ELSE", message: "authenticator exploded" },
      });
      const { onDoneAction } = renderCard();

      fireEvent.click(screen.getByTestId("auth-2fa-continue"));

      await waitFor(() => expect(toastDangerMock).toHaveBeenCalled());
      expect(onDoneAction).not.toHaveBeenCalled();
      expect(screen.getByTestId("auth-2fa-skip")).toBeEnabled();
    });
  });

  it("skip for now hands off without touching any authenticator", () => {
    const { onSkipAction } = renderCard();

    fireEvent.click(screen.getByTestId("auth-2fa-skip"));

    expect(onSkipAction).toHaveBeenCalled();
    expect(addPasskeyMock).not.toHaveBeenCalled();
  });
});
