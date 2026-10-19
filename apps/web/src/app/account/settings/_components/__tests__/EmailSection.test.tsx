import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const testMocks = vi.hoisted(() => ({
  changeEmail: vi.fn(),
  sendVerificationOtp: vi.fn(),
  getSession: vi.fn(),
  fetch: vi.fn(),
  toastSuccess: vi.fn(),
  toastDanger: vi.fn(),
}));

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: {
    emailOtp: {
      changeEmail: testMocks.changeEmail,
      sendVerificationOtp: testMocks.sendVerificationOtp,
    },
    getSession: testMocks.getSession,
  },
}));

vi.mock("tamagui", () => {
  const Stack = ({ children }: { children?: ReactNode }) => <div>{children}</div>;

  return {
    XStack: Stack,
    YStack: Stack,
    styled: () => Stack,
  };
});

vi.mock("@th/ui", () => ({
  Button: ({
    children,
    disabled,
    onPress,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
  FormErrorBanner: ({ message }: { message: string | null }) =>
    message ? <div role="alert">{message}</div> : null,
  LabeledTextInput: ({
    helperText,
    label,
    name,
    onChangeText,
    placeholder,
    value,
  }: {
    helperText?: string;
    label: string;
    name?: string;
    onChangeText?: (value: string) => void;
    placeholder?: string;
    value?: string;
  }) => (
    <label>
      <span>{label}</span>
      <input
        aria-label={label}
        name={name}
        placeholder={placeholder}
        value={value ?? ""}
        onChange={(event) => onChangeText?.(event.currentTarget.value)}
      />
      {helperText ? <span>{helperText}</span> : null}
    </label>
  ),
  Spinner: () => <span>Loading</span>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  useNotify: () => ({
    toast: {
      success: testMocks.toastSuccess,
      danger: testMocks.toastDanger,
    },
  }),
  useTranslations: () =>
    (key: string, params?: Record<string, string>) => {
      const messages: Record<string, string> = {
        "account.sEmailTitle": "Email",
        "account.sCurrentEmail": "Current email",
        "account.sNewEmail": "New email address",
        "account.sNewEmailPlaceholder": "new@example.com",
        "account.sEmailChangeHint":
          "We'll send a verification code to your new address.",
        "account.sEmailChangeBtn": "Send verification code",
        "account.sEmailVerifyCurrentBtn": "Verify this address",
        "account.sEmailSentTitle": "Verification code sent",
        "account.sEmailSentMsg": "Check your inbox for the code.",
        "account.sEmailVerifyHint":
          "Enter the code below to finish changing your email.",
        "account.sEmailCodeLabel": "Verification code",
        "account.sEmailCodePlaceholder": "000000",
        "account.sEmailCodeHint": "We sent a 6-digit code to {email}.",
        "account.sEmailVerifyBtn": "Verify code",
        "account.sEmailChangedTitle": "Email updated",
        "account.sEmailChangedMsg":
          "Your new email is verified and saved.",
        "account.sEmailTryAnother": "Use a different address",
        "account.sEmailSameAsCurrent": "This is already your current email.",
        "account.sEmailUndeliverableBadge": "Undeliverable",
        "account.sEmailComplaintBadge": "Complaint",
        "account.sEmailDeliveryIssueTitle": "Email delivery paused",
        "account.sEmailUndeliverableDesc":
          "Messages to this address are blocked because the mailbox rejected a Ithas Fire email.",
        "account.sEmailComplaintDesc":
          "Messages to this address are blocked because a Ithas Fire email was reported as spam.",
        "emailGate.changeBlockedSent": "Verify {email} before you change it.",
        "emailGate.changeBlocked":
          "Verify your current email before you change it.",
        "account.sEmailOAuthTitle": "Managed by your sign-in provider",
        "account.sEmailOAuthDesc":
          "Your email is linked to your Google or Apple account.",
      };

      return (messages[key] ?? key).replace(
        "{email}",
        params?.email ?? "",
      );
    },
}));

import { EmailSection } from "../EmailSection";

const renderEmailSection = (
  emailDeliveryStatus?: string | null,
  hasCredential: boolean | null = true,
) =>
  render(
    <EmailSection
      user={{
        email: "current@example.com",
        emailDeliveryStatus,
      }}
      hasCredential={hasCredential}
    />,
  );

const requestEmailChange = async (rawEmail = "  New@Example.COM  ") => {
  const expectedEmail = rawEmail.trim().toLowerCase();
  fireEvent.change(screen.getByLabelText("New email address"), {
    target: { value: rawEmail },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Send verification code" }),
  );

  await waitFor(() => {
    expect(testMocks.fetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/account/email-change/request",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({ newEmail: expectedEmail }),
      }),
    );
  });
};

describe("EmailSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testMocks.changeEmail.mockResolvedValue({ error: null });
    testMocks.sendVerificationOtp.mockResolvedValue({ error: null });
    testMocks.getSession.mockResolvedValue({ data: null });
    testMocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal("fetch", testMocks.fetch);
  });

  it.each([
    [
      "BOUNCED",
      "Undeliverable",
      "Messages to this address are blocked because the mailbox rejected a Ithas Fire email.",
    ],
    [
      "COMPLAINED",
      "Complaint",
      "Messages to this address are blocked because a Ithas Fire email was reported as spam.",
    ],
  ])("renders the %s delivery status prompt", (status, badge, prompt) => {
    renderEmailSection(status);

    expect(screen.getByText(badge)).toBeInTheDocument();
    expect(screen.getByText("Email delivery paused")).toBeInTheDocument();
    expect(screen.getByText(prompt)).toBeInTheDocument();
  });

  it("requests an email change with normalized email and then shows the OTP input", async () => {
    renderEmailSection("BOUNCED");

    await requestEmailChange();

    expect(await screen.findByLabelText("Verification code")).toBeInTheDocument();
    expect(
      screen.getByText("We sent a 6-digit code to new@example.com."),
    ).toBeInTheDocument();
    expect(testMocks.changeEmail).not.toHaveBeenCalled();
  });

  it.each(["BOUNCED", "COMPLAINED"])(
    "allows %s delivery remediation for OAuth-only accounts",
    async (status) => {
      renderEmailSection(status, false);

      await requestEmailChange("oauth-fix@example.com");

      expect(await screen.findByLabelText("Verification code")).toBeInTheDocument();
      expect(testMocks.fetch).toHaveBeenCalledWith(
        "http://localhost:3001/api/account/email-change/request",
        expect.objectContaining({
          body: JSON.stringify({ newEmail: "oauth-fix@example.com" }),
        }),
      );
      expect(
        screen.queryByText("Managed by your sign-in provider"),
      ).not.toBeInTheDocument();
    },
  );

  it("does not show the OTP step when requesting a change returns an error", async () => {
    testMocks.fetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ message: "Could not send verification code." }),
    });
    renderEmailSection("BOUNCED");

    fireEvent.change(screen.getByLabelText("New email address"), {
      target: { value: "new@example.com" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Send verification code" }),
    );

    await waitFor(() => {
      expect(
        screen.getByText("Could not send verification code."),
      ).toBeInTheDocument();
    });
    expect(screen.queryByLabelText("Verification code")).not.toBeInTheDocument();
    expect(testMocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("answers verify_current_email_first by sending a code to the CURRENT address (B2)", async () => {
    testMocks.fetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({
        ok: false,
        error: "verify_current_email_first",
        message: "Verify your current email address before changing it.",
      }),
    });
    renderEmailSection();

    fireEvent.change(screen.getByLabelText("New email address"), {
      target: { value: "new@example.com" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Send verification code" }),
    );

    await waitFor(() => {
      expect(
        screen.getByText(
          "Verify current@example.com before you change it.",
        ),
      ).toBeInTheDocument();
    });
    expect(testMocks.sendVerificationOtp).toHaveBeenCalledWith({
      email: "current@example.com",
      type: "email-verification",
    });
    // The code entry is the CURRENT address's, not the refused new one's.
    expect(
      screen.getByText("We sent a 6-digit code to current@example.com."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("We sent a 6-digit code to new@example.com."),
    ).not.toBeInTheDocument();
  });

  it("a second refused change does not mail another code over the first", async () => {
    const refusal = {
      ok: false,
      json: async () => ({
        ok: false,
        error: "verify_current_email_first",
        message: "Verify your current email address before changing it.",
      }),
    };
    testMocks.fetch.mockResolvedValueOnce(refusal).mockResolvedValueOnce(refusal);
    renderEmailSection();

    const attempt = async () => {
      fireEvent.change(screen.getByLabelText("New email address"), {
        target: { value: "new@example.com" },
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Send verification code" }),
      );
      await waitFor(() => {
        expect(
          screen.getByText("Verify current@example.com before you change it."),
        ).toBeInTheDocument();
      });
    };

    await attempt();
    await waitFor(() => expect(testMocks.fetch).toHaveBeenCalledTimes(1));
    await attempt();
    await waitFor(() => expect(testMocks.fetch).toHaveBeenCalledTimes(2));

    expect(testMocks.sendVerificationOtp).toHaveBeenCalledTimes(1);
  });

  it("does not show the OTP step when requesting a change rejects", async () => {
    testMocks.fetch.mockRejectedValueOnce(
      new Error("Could not send verification code."),
    );
    renderEmailSection("COMPLAINED");

    fireEvent.change(screen.getByLabelText("New email address"), {
      target: { value: "new@example.com" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Send verification code" }),
    );

    await waitFor(() => {
      expect(
        screen.getByText("Could not send verification code."),
      ).toBeInTheDocument();
    });
    expect(screen.queryByLabelText("Verification code")).not.toBeInTheDocument();
    expect(testMocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("verifies with the pending email and trimmed OTP", async () => {
    renderEmailSection("COMPLAINED");
    await requestEmailChange();

    fireEvent.change(await screen.findByLabelText("Verification code"), {
      target: { value: "654321" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify code" }));

    await waitFor(() => {
      expect(testMocks.changeEmail).toHaveBeenCalledWith({
        newEmail: "new@example.com",
        otp: "654321",
      });
    });
    expect(testMocks.getSession).toHaveBeenCalledWith({
      query: { disableCookieCache: true },
    });
    expect(await screen.findByText("Email updated")).toBeInTheDocument();
  });

  it("does not verify when the code is incomplete", async () => {
    renderEmailSection("BOUNCED");
    await requestEmailChange();

    fireEvent.change(await screen.findByLabelText("Verification code"), {
      target: { value: "123" },
    });

    const verifyButton = screen.getByRole("button", { name: "Verify code" });
    expect(verifyButton).toBeDisabled();
    fireEvent.click(verifyButton);

    expect(testMocks.changeEmail).not.toHaveBeenCalled();
  });
});