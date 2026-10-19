import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TwoFactorChallengeCard — the emailed/texted code copy.
 *
 * With no SMS provider the server sends every code by email, so the method
 * label, the description and the "code sent" toast must say email unless the
 * `sms` gate is explicitly on (unknown gates count as off).
 */

const mocks = vi.hoisted(() => ({
  gates: undefined as { sms?: boolean } | undefined,
  toastSuccess: vi.fn(),
  sendOtp: vi.fn(() => Promise.resolve({ data: {}, error: null })),
}));

vi.mock("tamagui", () => {
  const Stack = ({
    children,
    onPress,
  }: { children?: ReactNode; onPress?: () => void } & Record<string, unknown>) => (
    <div onClick={onPress}>{children}</div>
  );
  const styled = <P,>(Component: React.ComponentType<P>) => Component;
  return { XStack: Stack, YStack: Stack, styled } satisfies Record<string, unknown>;
});

vi.mock("lucide-react", () => ({
  ArrowLeft: () => null,
  CheckCircle: () => null,
  KeyRound: () => null,
  Mail: () => null,
  ShieldCheck: () => null,
}));

vi.mock("@th/ui", () => {
  const Button = ({
    children,
    onPress,
    type,
    disabled,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    type?: string;
    disabled?: boolean;
  }) => (
    <button
      type={(type as "button" | "submit" | undefined) ?? "button"}
      onClick={onPress}
      disabled={disabled}
    >
      {children}
    </button>
  );
  return {
    Alert: ({ description }: { description?: string }) => <div>{description}</div>,
    Button,
    Spinner: () => null,
    Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    TextInput: () => <input />,
    useTranslations: () => (key: string) => key,
    useNotify: () => ({
      toast: { success: mocks.toastSuccess, danger: vi.fn() },
    }),
  } satisfies Record<string, unknown>;
});

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: {
    twoFactor: {
      sendOtp: mocks.sendOtp,
      verifyOtp: vi.fn(() => Promise.resolve({ data: {}, error: null })),
      verifyTotp: vi.fn(() => Promise.resolve({ data: {}, error: null })),
      verifyBackupCode: vi.fn(() => Promise.resolve({ data: {}, error: null })),
    },
  },
}));

vi.mock("@/hooks/useFeatureGates", () => ({
  useFeatureGates: () => ({ gates: mocks.gates, isLoading: false }),
}));

vi.mock("../AuthCardShell", () => ({
  AuthCardShell: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

import { TwoFactorChallengeCard } from "../TwoFactorChallengeCard";

async function chooseCodeAndSend(methodLabel: string) {
  render(<TwoFactorChallengeCard onVerifiedAction={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: methodLabel }));
  fireEvent.click(screen.getByRole("button", { name: "auth.tfcSendOtp" }));
  await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledTimes(1));
}

describe("TwoFactorChallengeCard — code copy follows the sms gate", () => {
  beforeEach(() => {
    mocks.toastSuccess.mockReset();
    mocks.sendOtp.mockClear();
  });

  for (const [label, gates] of [
    ["sms gate off", { sms: false }],
    ["gates unknown", undefined],
  ] as const) {
    it(`says email only (${label})`, async () => {
      mocks.gates = gates;
      await chooseCodeAndSend("auth.tfcMethodOtpEmail");

      expect(screen.getByText("auth.tfcOtpDescEmail")).toBeInTheDocument();
      expect(screen.queryByText("auth.tfcOtpDesc")).not.toBeInTheDocument();
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        expect.objectContaining({ message: "auth.tfcOtpSentMsgEmail" }),
      );
    });
  }

  it("keeps the email-or-SMS copy when SMS is available", async () => {
    mocks.gates = { sms: true };
    await chooseCodeAndSend("auth.tfcMethodOtp");

    expect(screen.getByText("auth.tfcOtpDesc")).toBeInTheDocument();
    expect(screen.queryByText("auth.tfcOtpDescEmail")).not.toBeInTheDocument();
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ message: "auth.tfcOtpSentMsg" }),
    );
  });
});
