import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SettingsSurface — the Security cluster's phone-number card.
 *
 * A phone number is used only for texted codes and SMS notifications, so the
 * card (and its `#phone-number-section` anchor) renders only when the `sms`
 * gate is explicitly on; unknown gates count as off. Otherwise the read-only
 * card takes its place, with no anchor.
 */

const mocks = vi.hoisted(() => ({
  gates: undefined as { sms?: boolean } | undefined,
}));

// Every section is a stub; only the Security cluster's composition is under
// test. Hoisted because the vi.mock factories below run before module code.
const { stub } = vi.hoisted(() => ({
  stub: (testId: string) => () => <div data-testid={testId} />,
}));

vi.mock("tamagui", () => {
  const Stack = ({
    children,
    id,
  }: { children?: ReactNode; id?: string } & Record<string, unknown>) => (
    <div id={id}>{children}</div>
  );
  return { XStack: Stack, YStack: Stack };
});

vi.mock("lucide-react", () => ({ ArrowLeft: () => null, User: () => null }));

vi.mock("@th/ui", () => ({
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Button: ({ children }: { children?: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  NextLinkAnchor: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Spinner: () => <div data-testid="spinner" />,
  useTranslations: () => (key: string) => key,
}));

vi.mock("@bprogress/next/app", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/settings", () => ({ SettingsNav: () => null }));

vi.mock("@/trpc", () => ({
  trpc: {
    humans: { getMyWorkSummary: { useQuery: () => ({ data: undefined }) } },
  },
}));

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: {
    // Read directly by SettingsSurface until `useSessionVerdict` replaces it.
    useSession: () => ({
      data: { user: { name: "Jane", email: "jane@example.org" } },
      isPending: false,
    }),
    listAccounts: () =>
      Promise.resolve({ data: [{ providerId: "credential" }] }),
  },
}));

vi.mock("@/hooks/useSessionVerdict", () => ({
  useSessionVerdict: () => ({
    verdict: "signedIn",
    user: { name: "Jane", email: "jane@example.org" },
  }),
}));

vi.mock("@/hooks/useFeatureGates", () => ({
  useFeatureGates: () => ({ gates: mocks.gates, isLoading: false }),
}));

vi.mock("@/lib/redirect", () => ({ readRedirectParam: () => null }));
vi.mock("@/lib/trace-ignored-error", () => ({
  traceIgnoredError: () => () => undefined,
}));

vi.mock("../settings-primitives", () => ({
  PageContainer: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("../../_lib/settings-sections", () => ({
  buildSettingsGroups: () => ({
    groups: [],
    entitlementDecidable: false,
    entitled: new Set(),
  }),
}));

vi.mock("../ProfileSection", () => ({ ProfileSection: stub("profile") }));
vi.mock("../RolesCraftSection", () => ({ RolesCraftSection: stub("roles") }));
vi.mock("../EmailSection", () => ({ EmailSection: stub("email") }));
vi.mock("../FollowingSection", () => ({ FollowingSection: stub("following") }));
vi.mock("../NotificationsSection", () => ({
  NotificationsSection: stub("notifications"),
}));
vi.mock("../PasswordSection", () => ({ PasswordSection: stub("password") }));
vi.mock("../TwoFactorSection", () => ({ TwoFactorSection: stub("two-factor") }));
vi.mock("../PhoneNumberSection", () => ({
  PhoneNumberSection: stub("phone-number"),
}));
vi.mock("../PhoneNumberReadOnly", () => ({
  PhoneNumberReadOnly: stub("phone-read-only"),
}));
vi.mock("../PasskeysSection", () => ({ PasskeysSection: stub("passkeys") }));
vi.mock("../BillingSection", () => ({ BillingSection: stub("billing") }));
vi.mock("../PerformerSection", () => ({ PerformerSection: stub("performer") }));
vi.mock("../BookingDefaultsSection", () => ({
  BookingDefaultsSection: stub("booking-defaults"),
}));
vi.mock("../BookingRequestsSection", () => ({
  BookingRequestsSection: stub("booking-requests"),
}));
vi.mock("../EditSuggestionsSection", () => ({
  EditSuggestionsSection: stub("edit-suggestions"),
}));
vi.mock("../VenueClaimsSection", () => ({
  VenueClaimsSection: stub("place-claims"),
}));
vi.mock("../DangerZone", () => ({ DangerZone: stub("danger-zone") }));

import { SettingsSurface } from "../SettingsSurface";

describe("SettingsSurface — phone card follows the sms gate", () => {
  beforeEach(() => {
    mocks.gates = undefined;
  });

  it("renders the phone card and its anchor when SMS is available", async () => {
    mocks.gates = { sms: true };
    const { container } = render(<SettingsSurface section="security" />);

    expect(await screen.findByTestId("passkeys")).toBeInTheDocument();
    expect(screen.getByTestId("phone-number")).toBeInTheDocument();
    expect(screen.queryByTestId("phone-read-only")).not.toBeInTheDocument();
    expect(container.querySelector("#phone-number-section")).not.toBeNull();
  });

  for (const [label, gates] of [
    ["sms gate off", { sms: false }],
    ["gates unknown", undefined],
  ] as const) {
    it(`renders the read-only card, no editable card or anchor (${label})`, async () => {
      mocks.gates = gates;
      const { container } = render(<SettingsSurface section="security" />);

      // The rest of the cluster still renders.
      expect(await screen.findByTestId("passkeys")).toBeInTheDocument();
      expect(screen.queryByTestId("phone-number")).not.toBeInTheDocument();
      expect(screen.getByTestId("phone-read-only")).toBeInTheDocument();
      expect(container.querySelector("#phone-number-section")).toBeNull();
    });
  }
});
