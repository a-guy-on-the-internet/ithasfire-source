import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const testMocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  mutate: vi.fn(),
  useSession: vi.fn(),
  routerPush: vi.fn(),
  toastSuccess: vi.fn(),
  toastDanger: vi.fn(),
  gates: undefined as { sms?: boolean } | undefined,
}));

vi.mock("@/hooks/useFeatureGates", () => ({
  useFeatureGates: () => ({ gates: testMocks.gates, isLoading: false }),
}));

vi.mock("@/trpc", () => ({
  trpc: {
    notificationPreferences: {
      get: { useQuery: testMocks.useQuery },
      update: { useMutation: () => ({ mutate: testMocks.mutate }) },
    },
  },
}));

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: {
    useSession: testMocks.useSession,
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: testMocks.routerPush }),
}));

vi.mock("lucide-react", () => ({
  Bell: () => null,
}));

vi.mock("tamagui", () => {
  const Stack = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  return {
    XStack: Stack,
    YStack: Stack,
    styled: () => Stack,
  };
});

vi.mock("../settings-primitives", () => ({
  SectionCard: ({ children }: { children?: ReactNode }) => (
    <section>{children}</section>
  ),
}));

vi.mock("@th/ui", () => ({
  Button: ({
    children,
    onPress,
  }: {
    children?: ReactNode;
    onPress?: () => void;
  }) => (
    <button type="button" onClick={onPress}>
      {children}
    </button>
  ),
  Spinner: () => <span>Loading</span>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Switch: ({
    checked,
    onCheckedChange,
    disabled,
    "aria-label": ariaLabel,
    id,
  }: {
    checked: boolean;
    onCheckedChange: (next: boolean) => void;
    disabled?: boolean;
    "aria-label"?: string;
    id?: string;
  }) => (
    <input
      type="checkbox"
      id={id}
      aria-label={ariaLabel}
      checked={checked}
      disabled={disabled}
      onChange={(event) => onCheckedChange(event.currentTarget.checked)}
    />
  ),
  useNotify: () => ({
    toast: {
      success: testMocks.toastSuccess,
      danger: testMocks.toastDanger,
    },
  }),
  // Key-echo translator: interpolated values are appended as `name=value`
  // pairs so aria-labels built from templates stay distinguishable.
  useTranslations:
    () =>
    (key: string, values?: Record<string, unknown>) =>
      values
        ? `${key} ${Object.entries(values)
            .map(([name, value]) => `${name}=${String(value)}`)
            .join(" ")}`
        : key,
}));

import { NotificationsSection } from "../NotificationsSection";

const CHANNEL_TRUE = {
  transactional: true,
  announcements: true,
  reminders: true,
  marketing: true,
  organizerMessages: true,
};

// What the router returns from core's `smsEligibleCategories`.
const SMS_ELIGIBLE_CATEGORIES = ["transactional"];

function mockPrefsQuery(
  preferences: unknown,
  smsEligibleCategories: string[] = SMS_ELIGIBLE_CATEGORIES,
) {
  testMocks.useQuery.mockReturnValue({
    data:
      preferences === undefined
        ? undefined
        : { preferences, smsEligibleCategories },
    isLoading: false,
    refetch: vi.fn(async () => ({})),
  });
}

function mockSession(options?: {
  phoneNumber?: string | null;
  phoneNumberVerified?: boolean;
  isPending?: boolean;
}) {
  testMocks.useSession.mockReturnValue({
    data: {
      user: {
        id: "user-1",
        phoneNumber: options?.phoneNumber ?? null,
        phoneNumberVerified: options?.phoneNumberVerified ?? false,
      },
    },
    isPending: options?.isPending ?? false,
  });
}

describe("NotificationsSection SMS channel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testMocks.gates = { sms: true };
  });

  it("renders an SMS toggle only for transactional", () => {
    mockPrefsQuery({
      in_app: { ...CHANNEL_TRUE },
      email: { ...CHANNEL_TRUE },
      push: { ...CHANNEL_TRUE },
      sms: {
        transactional: false,
        announcements: false,
        reminders: false,
        marketing: false,
        organizerMessages: false,
      },
    });
    mockSession({ phoneNumber: "+15005550006", phoneNumberVerified: true });

    render(<NotificationsSection />);

    const smsToggles = screen.getAllByRole("checkbox", {
      name: /channel=account\.sNotifChSms/,
    });
    // Announcements, promotions and organizer messages never go by text.
    expect(smsToggles.map((el) => el.getAttribute("aria-label"))).toEqual([
      "account.sNotifToggleAria channel=account.sNotifChSms category=account.sNotifCatTransactional",
    ]);
    // The SMS disclosure shows once, with the Terms and Privacy links.
    expect(
      screen.getByText(/account\.sNotifSmsDisclosure/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "common.smsTermsLink" }),
    ).toHaveAttribute("href", "/terms#sms");
    expect(
      screen.getByRole("link", { name: "common.smsPrivacyLink" }),
    ).toHaveAttribute("href", "/privacy");
  });

  it("takes the SMS rows from the server's smsEligibleCategories", () => {
    mockPrefsQuery(
      {
        in_app: { ...CHANNEL_TRUE },
        email: { ...CHANNEL_TRUE },
        push: { ...CHANNEL_TRUE },
      },
      ["reminders"],
    );
    mockSession({ phoneNumber: "+15005550006", phoneNumberVerified: true });

    render(<NotificationsSection />);

    const smsToggles = screen.getAllByRole("checkbox", {
      name: /channel=account\.sNotifChSms/,
    });
    expect(smsToggles.map((el) => el.getAttribute("aria-label"))).toEqual([
      "account.sNotifToggleAria channel=account.sNotifChSms category=account.sNotifCatReminders",
    ]);
  });

  it("locks the transactional in-app toggle on", () => {
    mockPrefsQuery({
      in_app: { ...CHANNEL_TRUE },
      email: { ...CHANNEL_TRUE },
      push: { ...CHANNEL_TRUE },
    });
    mockSession({ phoneNumber: "+15005550006", phoneNumberVerified: true });

    render(<NotificationsSection />);

    const lockedToggle = screen.getByRole("checkbox", {
      name: /^account\.sNotifToggleAriaLocked channel=account\.sNotifChInApp category=account\.sNotifCatTransactional /,
    });
    expect(lockedToggle).toBeDisabled();
    expect(lockedToggle).toBeChecked();
  });

  it("defaults SMS off when the server snapshot omits the sms channel", () => {
    mockPrefsQuery({
      in_app: { ...CHANNEL_TRUE },
      email: { ...CHANNEL_TRUE },
      push: { ...CHANNEL_TRUE },
    });
    mockSession({ phoneNumber: "+15005550006", phoneNumberVerified: true });

    render(<NotificationsSection />);

    for (const toggle of screen.getAllByRole("checkbox", {
      name: /channel=account\.sNotifChSms/,
    })) {
      expect(toggle).not.toBeChecked();
    }
    // Non-SMS channels still default on.
    for (const toggle of screen.getAllByRole("checkbox", {
      name: /channel=account\.sNotifChPush/,
    })) {
      expect(toggle).toBeChecked();
    }
  });

  it("disables SMS toggles and shows the add-phone affordance without a verified phone", () => {
    mockPrefsQuery({
      in_app: { ...CHANNEL_TRUE },
      email: { ...CHANNEL_TRUE },
      push: { ...CHANNEL_TRUE },
    });
    mockSession({ phoneNumber: null, phoneNumberVerified: false });

    render(<NotificationsSection />);

    for (const toggle of screen.getAllByRole("checkbox", {
      name: /reason=account\.sNotifSmsRequiresPhone/,
    })) {
      expect(toggle).toBeDisabled();
      expect(toggle).not.toBeChecked();
    }
    expect(screen.getByText("errors.phoneRequiredForSms")).toBeInTheDocument();

    const scrollIntoView = vi.fn();
    const target = document.createElement("div");
    target.id = "phone-number-section";
    target.scrollIntoView = scrollIntoView;
    document.body.appendChild(target);

    fireEvent.click(
      screen.getByRole("button", { name: "account.sNotifAddPhoneBtn" }),
    );
    expect(scrollIntoView).toHaveBeenCalled();
    target.remove();

    // Never persists an SMS preference while locked.
    expect(testMocks.mutate).not.toHaveBeenCalled();
  });

  it("treats an unverified phone number as ineligible for SMS", () => {
    mockPrefsQuery({
      in_app: { ...CHANNEL_TRUE },
      email: { ...CHANNEL_TRUE },
      push: { ...CHANNEL_TRUE },
    });
    mockSession({
      phoneNumber: "+15005550006",
      phoneNumberVerified: false,
    });

    render(<NotificationsSection />);

    for (const toggle of screen.getAllByRole("checkbox", {
      name: /reason=account\.sNotifSmsRequiresPhone/,
    })) {
      expect(toggle).toBeDisabled();
    }
  });

  it("persists an SMS toggle when a verified phone is on file", () => {
    mockPrefsQuery({
      in_app: { ...CHANNEL_TRUE },
      email: { ...CHANNEL_TRUE },
      push: { ...CHANNEL_TRUE },
      sms: {
        transactional: false,
        announcements: false,
        reminders: false,
        marketing: false,
        organizerMessages: false,
      },
    });
    mockSession({ phoneNumber: "+15005550006", phoneNumberVerified: true });

    render(<NotificationsSection />);

    expect(
      screen.queryByText("errors.phoneRequiredForSms"),
    ).not.toBeInTheDocument();

    const toggle = screen.getByRole("checkbox", {
      name: "account.sNotifToggleAria channel=account.sNotifChSms category=account.sNotifCatTransactional",
    });
    expect(toggle).toBeEnabled();

    fireEvent.click(toggle);

    expect(testMocks.mutate).toHaveBeenCalledTimes(1);
    expect(testMocks.mutate).toHaveBeenCalledWith(
      {
        scope: { kind: "GLOBAL" },
        channels: { sms: { transactional: true } },
      },
      expect.anything(),
    );
  });
});

describe("NotificationsSection without SMS (no provider)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const [label, gates] of [
    ["sms gate off", { sms: false }],
    ["gates unknown", undefined],
  ] as const) {
    it(`renders no SMS channel and no add-phone nudge (${label})`, () => {
      testMocks.gates = gates;
      mockPrefsQuery({
        in_app: { ...CHANNEL_TRUE },
        email: { ...CHANNEL_TRUE },
        push: { ...CHANNEL_TRUE },
      });
      mockSession({ phoneNumber: null, phoneNumberVerified: false });

      render(<NotificationsSection />);

      expect(
        screen.queryAllByRole("checkbox", {
          name: /channel=account\.sNotifChSms/,
        }),
      ).toHaveLength(0);
      expect(
        screen.queryByText("errors.phoneRequiredForSms"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "account.sNotifAddPhoneBtn" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(/account\.sNotifSmsDisclosure/),
      ).not.toBeInTheDocument();
      // The other channels still render, one per category.
      expect(
        screen.getAllByRole("checkbox", {
          name: /channel=account\.sNotifChEmail/,
        }),
      ).toHaveLength(5);
    });
  }

  it("keeps a stored transactional SMS opt-in as a switch-off-only toggle", () => {
    testMocks.gates = { sms: false };
    mockPrefsQuery({
      in_app: { ...CHANNEL_TRUE },
      email: { ...CHANNEL_TRUE },
      push: { ...CHANNEL_TRUE },
      sms: {
        transactional: true,
        announcements: false,
        reminders: false,
        marketing: false,
        organizerMessages: false,
      },
    });
    // No verified phone: withdrawing consent must still be possible.
    mockSession({ phoneNumber: null, phoneNumberVerified: false });

    render(<NotificationsSection />);

    const smsToggles = screen.getAllByRole("checkbox", {
      name: /channel=account\.sNotifChSms/,
    });
    expect(smsToggles).toHaveLength(1);
    const toggle = smsToggles[0];
    expect(toggle).toHaveAttribute(
      "aria-label",
      "account.sNotifToggleAria channel=account.sNotifChSms category=account.sNotifCatTransactional",
    );
    expect(toggle).toBeChecked();
    expect(toggle).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "account.sNotifAddPhoneBtn" }),
    ).not.toBeInTheDocument();

    fireEvent.click(toggle);

    expect(testMocks.mutate).toHaveBeenCalledTimes(1);
    expect(testMocks.mutate).toHaveBeenCalledWith(
      {
        scope: { kind: "GLOBAL" },
        channels: { sms: { transactional: false } },
      },
      expect.anything(),
    );
  });
});
