import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendOtp: vi.fn(),
  danger: vi.fn(),
  inputProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("tamagui", () => {
  const Stack = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return { XStack: Stack, YStack: Stack };
});
vi.mock("lucide-react", () => ({ Phone: () => null, ShieldCheck: () => null }));
vi.mock("@th/ui", () => ({
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Button: ({
    children,
    onPress,
    disabled,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onPress} disabled={disabled}>
      {children}
    </button>
  ),
  TextInput: (props: Record<string, unknown>) => {
    mocks.inputProps.push(props);
    return (
      <input
        data-testid={props.testId as string}
        onChange={(e) =>
          (props.onChangeText as (v: string) => void)(e.target.value)
        }
      />
    );
  },
  Spinner: () => null,
  useNotify: () => ({
    toast: { success: vi.fn(), danger: mocks.danger },
  }),
  useTranslations: () => (key: string) => `T(${key})`,
}));
vi.mock("@/components/notifications/SmsLegalLinks", () => ({
  SmsLegalLinks: () => null,
}));
vi.mock("../settings-primitives", () => ({
  SectionCard: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  FieldRow: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/lib/auth/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: { user: {} }, refetch: vi.fn() }),
    phoneNumber: { sendOtp: mocks.sendOtp, verify: vi.fn() },
  },
}));

import { PhoneNumberSection } from "../PhoneNumberSection";

async function sendCode() {
  render(<PhoneNumberSection />);
  fireEvent.click(screen.getByText("ADD A PHONE NUMBER"));
  fireEvent.change(screen.getByTestId("phone-number-input"), {
    target: { value: "+15555550123" },
  });
  fireEvent.click(screen.getByText("SEND CODE"));
  await waitFor(() => expect(mocks.danger).toHaveBeenCalled());
}

describe("PhoneNumberSection send-code errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.inputProps.length = 0;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("maps a code-less HTTP 429 to the rate-limited catalog message", async () => {
    mocks.sendOtp.mockResolvedValue({
      error: {
        status: 429,
        message: "Too many requests. Please try again later.",
      },
    });
    await sendCode();
    expect(mocks.danger.mock.calls[0][0].message).toBe(
      "T(account.sPhoneErrRateLimited)",
    );
  });

  it("keeps the server-code mapping ahead of the status", async () => {
    mocks.sendOtp.mockResolvedValue({
      error: { status: 429, code: "SMS_UNAVAILABLE", message: "x" },
    });
    await sendCode();
    expect(mocks.danger.mock.calls[0][0].message).toBe(
      "T(account.sPhoneErrUnavailable)",
    );
  });

  it("makes the phone input fill its column", async () => {
    mocks.sendOtp.mockResolvedValue({ error: { status: 429 } });
    await sendCode();
    const props = mocks.inputProps.find(
      (p) => p.testId === "phone-number-input",
    );
    expect(props?.fullWidth).toBe(true);
  });
});
