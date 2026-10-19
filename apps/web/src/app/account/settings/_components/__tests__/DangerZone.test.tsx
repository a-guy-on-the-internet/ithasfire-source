import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const testMocks = vi.hoisted(() => ({
  useSession: vi.fn(),
  signOut: vi.fn(),
  mutateAsync: vi.fn(),
  push: vi.fn(),
  toastSuccess: vi.fn(),
  toastDanger: vi.fn(),
}));

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: {
    useSession: testMocks.useSession,
    signOut: testMocks.signOut,
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: testMocks.push }),
}));

// Real `getAppErrorCode` validates candidates against the canonical
// `AppErrorCode` registry in `@th/errors` (via `fromLegacyCode`), so an
// unregistered code — like the two new guard codes below before the
// concurrent backend change lands them — would resolve to `null`. Mocking
// this module lets the component tests assert branching behavior against
// the CONTRACT (`data.appCode` values) independent of registry timing.
vi.mock("@/lib/app-error", () => ({
  getAppErrorCode: (error: unknown) =>
    (error as { data?: { appCode?: string } } | null)?.data?.appCode ?? null,
}));

let deleteMutationIsPending = false;
let hasPasswordCredential = false;

vi.mock("@/trpc", () => ({
  trpc: {
    humans: {
      deleteMyAccount: {
        useMutation: () => ({
          mutateAsync: testMocks.mutateAsync,
          isPending: deleteMutationIsPending,
        }),
      },
      hasPasswordCredential: {
        useQuery: () => ({ data: { hasPassword: hasPasswordCredential } }),
      },
    },
  },
}));

vi.mock("tamagui", () => {
  const Stack = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    XStack: Stack,
    YStack: Stack,
  };
});

vi.mock("../settings-primitives", () => ({
  SectionCard: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

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
  LabeledPasswordInput: ({
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
        type="password"
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
  useTranslations: () => (key: string) => {
    const messages: Record<string, string> = {
      "account.sDangerTitle": "Danger zone",
      "account.sDeleteDesc":
        "Permanently delete your account and all associated data. This action cannot be undone.",
      "account.sDeleteBtn": "Delete account",
      "account.sDeleteConfirm":
        "Are you sure? This will permanently delete your account.",
      "account.sDeleteConfirmInstructions":
        "Type your account email to confirm",
      "account.sDeleteConfirmPlaceholder": "you@example.com",
      "account.sDeleteConfirmMismatch":
        "That doesn't match your account email. Please retype it exactly.",
      "account.sDeleteConfirmPasswordLabel": "Enter your current password",
      "account.sDeleteConfirmPasswordPlaceholder": "Current password",
      "account.sDeleteConfirmPasswordRequired":
        "Enter your current password to confirm.",
      "account.sDeleteConfirmPasswordInvalid":
        "That password doesn't match your account. Please try again.",
      "account.sTogglePw": "Toggle password visibility",
      "account.sPwVisible": "Password visible",
      "account.sPwHidden": "Password hidden",
      "account.sDeleteBlockedByHistory":
        "Your account has order or ticket history and can't be fully deleted. Contact support if you'd like help with this.",
      "account.sDeleteBlockedBySoleOwner":
        "You're the sole owner of an organization. Transfer ownership to another member before deleting your account.",
      "account.sDeleteConfirmBtn": "Yes, delete my account",
      "account.sCancel": "Cancel",
      "account.sDeletedTitle": "Account deleted",
      "account.sDeletedMsg": "Your account has been permanently removed.",
      "account.sDeleteFailedTitle": "Deletion failed",
      "account.sDeleteFailedMsg":
        "We couldn't delete your account right now. Please try again later.",
    };
    return messages[key] ?? key;
  },
}));

import { DangerZone } from "../DangerZone";

const openConfirmPanel = () => {
  fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
};

describe("DangerZone", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deleteMutationIsPending = false;
    // Default to no password credential so the existing (pre-step-up) tests
    // below are unaffected by the new gate.
    hasPasswordCredential = false;
    testMocks.useSession.mockReturnValue({
      data: { user: { email: "me@example.com" } },
    });
  });

  it("keeps the confirm button disabled until the typed email matches", () => {
    render(<DangerZone />);
    openConfirmPanel();

    const confirmButton = screen.getByRole("button", {
      name: "Yes, delete my account",
    });
    expect(confirmButton).toBeDisabled();

    fireEvent.change(
      screen.getByLabelText("Type your account email to confirm"),
      { target: { value: "wrong@example.com" } },
    );
    expect(confirmButton).toBeDisabled();

    fireEvent.change(
      screen.getByLabelText("Type your account email to confirm"),
      { target: { value: "ME@EXAMPLE.com" } },
    );
    expect(confirmButton).toBeEnabled();
  });

  it("deletes the account, signs out, and redirects on success", async () => {
    testMocks.mutateAsync.mockResolvedValue({ deleted: true });
    render(<DangerZone />);
    openConfirmPanel();

    fireEvent.change(
      screen.getByLabelText("Type your account email to confirm"),
      { target: { value: "me@example.com" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Yes, delete my account" }),
    );

    await waitFor(() => {
      expect(testMocks.mutateAsync).toHaveBeenCalledWith({
        confirmationPhrase: "me@example.com",
      });
    });
    await waitFor(() => expect(testMocks.signOut).toHaveBeenCalled());
    expect(testMocks.toastSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Account deleted" }),
    );
    expect(testMocks.push).toHaveBeenCalledWith("/");
  });

  it("shows an inline mismatch message on a CONFIRMATION_PHRASE_MISMATCH appCode instead of navigating", async () => {
    testMocks.mutateAsync.mockRejectedValue({
      data: { appCode: "CONFIRMATION_PHRASE_MISMATCH" },
    });
    render(<DangerZone />);
    openConfirmPanel();

    fireEvent.change(
      screen.getByLabelText("Type your account email to confirm"),
      { target: { value: "me@example.com" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Yes, delete my account" }),
    );

    expect(
      await screen.findByText(
        "That doesn't match your account email. Please retype it exactly.",
      ),
    ).toBeInTheDocument();
    expect(testMocks.push).not.toHaveBeenCalled();
    expect(testMocks.signOut).not.toHaveBeenCalled();
  });

  it("shows the order-history guidance (not the mismatch message) on CANNOT_DELETE_ACCOUNT_WITH_ORDER_HISTORY", async () => {
    testMocks.mutateAsync.mockRejectedValue({
      data: { appCode: "CANNOT_DELETE_ACCOUNT_WITH_ORDER_HISTORY" },
    });
    render(<DangerZone />);
    openConfirmPanel();

    fireEvent.change(
      screen.getByLabelText("Type your account email to confirm"),
      { target: { value: "me@example.com" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Yes, delete my account" }),
    );

    expect(
      await screen.findByText(
        "Your account has order or ticket history and can't be fully deleted. Contact support if you'd like help with this.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        "That doesn't match your account email. Please retype it exactly.",
      ),
    ).not.toBeInTheDocument();
    expect(testMocks.toastDanger).not.toHaveBeenCalled();
    expect(testMocks.push).not.toHaveBeenCalled();
    expect(testMocks.signOut).not.toHaveBeenCalled();
  });

  it("shows the sole-owner guidance on CANNOT_DELETE_SOLE_ORG_OWNER", async () => {
    testMocks.mutateAsync.mockRejectedValue({
      data: { appCode: "CANNOT_DELETE_SOLE_ORG_OWNER" },
    });
    render(<DangerZone />);
    openConfirmPanel();

    fireEvent.change(
      screen.getByLabelText("Type your account email to confirm"),
      { target: { value: "me@example.com" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Yes, delete my account" }),
    );

    expect(
      await screen.findByText(
        "You're the sole owner of an organization. Transfer ownership to another member before deleting your account.",
      ),
    ).toBeInTheDocument();
    expect(testMocks.toastDanger).not.toHaveBeenCalled();
    expect(testMocks.push).not.toHaveBeenCalled();
    expect(testMocks.signOut).not.toHaveBeenCalled();
  });

  it("shows a generic failure toast for any other error", async () => {
    testMocks.mutateAsync.mockRejectedValue({ data: { code: "NOT_FOUND" } });
    render(<DangerZone />);
    openConfirmPanel();

    fireEvent.change(
      screen.getByLabelText("Type your account email to confirm"),
      { target: { value: "me@example.com" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Yes, delete my account" }),
    );

    await waitFor(() => {
      expect(testMocks.toastDanger).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Deletion failed" }),
      );
    });
    expect(testMocks.push).not.toHaveBeenCalled();
  });

  it("falls through to the generic toast (not the mismatch message) for a raw BAD_REQUEST with no structured appCode", async () => {
    // Regression guard for the bug this fix addresses: a generic Zod
    // validation failure also surfaces as tRPC `BAD_REQUEST`, so branching
    // on the raw transport code (instead of `data.appCode`) would have
    // wrongly shown the "didn't match your email" message here.
    testMocks.mutateAsync.mockRejectedValue({ data: { code: "BAD_REQUEST" } });
    render(<DangerZone />);
    openConfirmPanel();

    fireEvent.change(
      screen.getByLabelText("Type your account email to confirm"),
      { target: { value: "me@example.com" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Yes, delete my account" }),
    );

    await waitFor(() => {
      expect(testMocks.toastDanger).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Deletion failed" }),
      );
    });
    expect(
      screen.queryByText(
        "That doesn't match your account email. Please retype it exactly.",
      ),
    ).not.toBeInTheDocument();
    expect(testMocks.push).not.toHaveBeenCalled();
  });

  describe("step-up password re-entry (hasPasswordCredential: true)", () => {
    beforeEach(() => {
      hasPasswordCredential = true;
    });

    it("does not render a password field for OAuth/passkey-only accounts", () => {
      hasPasswordCredential = false;
      render(<DangerZone />);
      openConfirmPanel();

      expect(
        screen.queryByLabelText("Enter your current password"),
      ).not.toBeInTheDocument();
    });

    it("renders the password field when the account has a password credential", () => {
      render(<DangerZone />);
      openConfirmPanel();

      expect(
        screen.getByLabelText("Enter your current password"),
      ).toBeInTheDocument();
    });

    it("keeps the confirm button disabled with a matching email but an empty password", () => {
      render(<DangerZone />);
      openConfirmPanel();

      fireEvent.change(
        screen.getByLabelText("Type your account email to confirm"),
        { target: { value: "me@example.com" } },
      );
      const confirmButton = screen.getByRole("button", {
        name: "Yes, delete my account",
      });
      expect(confirmButton).toBeDisabled();

      fireEvent.change(
        screen.getByLabelText("Enter your current password"),
        { target: { value: "hunter2" } },
      );
      expect(confirmButton).toBeEnabled();
    });

    it("includes currentPassword in the mutation call", async () => {
      testMocks.mutateAsync.mockResolvedValue({ deleted: true });
      render(<DangerZone />);
      openConfirmPanel();

      fireEvent.change(
        screen.getByLabelText("Type your account email to confirm"),
        { target: { value: "me@example.com" } },
      );
      fireEvent.change(
        screen.getByLabelText("Enter your current password"),
        { target: { value: "hunter2" } },
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Yes, delete my account" }),
      );

      await waitFor(() => {
        expect(testMocks.mutateAsync).toHaveBeenCalledWith({
          confirmationPhrase: "me@example.com",
          currentPassword: "hunter2",
        });
      });
    });

    it("shows an inline message near the password field on CURRENT_PASSWORD_REQUIRED", async () => {
      testMocks.mutateAsync.mockRejectedValue({
        data: { appCode: "CURRENT_PASSWORD_REQUIRED" },
      });
      render(<DangerZone />);
      openConfirmPanel();

      fireEvent.change(
        screen.getByLabelText("Type your account email to confirm"),
        { target: { value: "me@example.com" } },
      );
      fireEvent.change(
        screen.getByLabelText("Enter your current password"),
        { target: { value: "hunter2" } },
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Yes, delete my account" }),
      );

      expect(
        await screen.findByText("Enter your current password to confirm."),
      ).toBeInTheDocument();
      expect(testMocks.push).not.toHaveBeenCalled();
      expect(testMocks.signOut).not.toHaveBeenCalled();
    });

    it("shows an inline message near the password field on CURRENT_PASSWORD_INVALID and preserves the typed values", async () => {
      testMocks.mutateAsync.mockRejectedValue({
        data: { appCode: "CURRENT_PASSWORD_INVALID" },
      });
      render(<DangerZone />);
      openConfirmPanel();

      fireEvent.change(
        screen.getByLabelText("Type your account email to confirm"),
        { target: { value: "me@example.com" } },
      );
      fireEvent.change(
        screen.getByLabelText("Enter your current password"),
        { target: { value: "wrong-password" } },
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Yes, delete my account" }),
      );

      expect(
        await screen.findByText(
          "That password doesn't match your account. Please try again.",
        ),
      ).toBeInTheDocument();
      expect(testMocks.toastDanger).not.toHaveBeenCalled();
      expect(testMocks.push).not.toHaveBeenCalled();

      // The already-typed email and password values should not be cleared —
      // only the field that was actually wrong gets retyped.
      expect(
        screen.getByLabelText("Type your account email to confirm"),
      ).toHaveValue("me@example.com");
      expect(
        screen.getByLabelText("Enter your current password"),
      ).toHaveValue("wrong-password");
    });
  });
});
