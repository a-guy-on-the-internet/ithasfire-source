import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PayoutsView } from "../PayoutsView";
import {
  resolveChargebackTermsAcceptance,
  resolveServerChargebackTermsAcceptance,
} from "../chargeback-terms-acceptance";
import { CHARGEBACK_TERMS_VERSION } from "@/components/payments/ChargebackTermsContent";
import { CURRENT_CHARGEBACK_TERMS_TEXT } from "@th/core/lib/payments/chargeback-terms";

// ─────────────────────────────────────────────────────────────────────────────
// Harness (mirrors PayoutScheduleSection.test.tsx): tamagui/@th/ui become
// plain DOM so the chargeback-terms gate on the Connect button — disabled
// until accepted, re-armed by the onboarding backstop, hidden behind the
// permission note for non-admins — is exercised without the design system.
//
// Moved from the retired PaymentsView.test.tsx when Payments merged into
// Payouts (2026-10-05). It renders the REAL PayoutsView, so it also pins
// where the Stripe setup sits in each state and that the onboarding CTA is
// on the page exactly once. The Balance/Ledger renderers are stubbed — their
// own behaviour is PayoutsView.test.tsx's job.
// ─────────────────────────────────────────────────────────────────────────────

type Owner =
  | {
      kind: "org";
      orgId: string;
      orgName: string;
      orgSlug: string;
      role: "OWNER" | "ADMIN" | "EDITOR" | "FINANCE" | "VIEWER" | "SCANNER";
      avatarUrl: null;
      adminSlug: string;
    }
  | {
      kind: "human";
      humanId: string;
      humanName: string;
      humanUsername: null;
      avatarUrl: null;
      adminSlug: string;
    };

const ORG_OWNER: Owner = {
  kind: "org",
  orgId: "org-1",
  orgName: "Demo Org",
  orgSlug: "demo",
  role: "OWNER",
  avatarUrl: null,
  adminSlug: "demo",
};

const HUMAN_OWNER: Owner = {
  kind: "human",
  humanId: "human-1",
  humanName: "Dev Login",
  humanUsername: null,
  avatarUrl: null,
  adminSlug: "@admin",
};

const NOT_CONNECTED = {
  connected: false,
  stripeAccountId: null,
  chargesEnabled: false,
  payoutsEnabled: false,
  detailsSubmitted: false,
  requirements: null,
  payoutsBlockedReason: null,
  capabilityOverride: null,
};

const INCOMPLETE = {
  connected: true,
  stripeAccountId: "acct_123",
  chargesEnabled: false,
  payoutsEnabled: false,
  detailsSubmitted: false,
  requirements: { currentlyDue: ["external_account"], eventuallyDue: [], pastDue: [] },
  payoutsBlockedReason: null,
  capabilityOverride: null,
};

const COMPLETE = {
  connected: true,
  stripeAccountId: "acct_123",
  chargesEnabled: true,
  payoutsEnabled: true,
  detailsSubmitted: true,
  requirements: { currentlyDue: [], eventuallyDue: [], pastDue: [] },
  payoutsBlockedReason: null,
  capabilityOverride: null,
};

/**
 * An abandoned Express onboarding as a test server reports it: the dev
 * capability override forced charges and payouts on (so the gate passes),
 * Stripe itself has enabled neither and has no details.
 */
const OVERRIDDEN = {
  connected: true,
  stripeAccountId: "acct_123",
  chargesEnabled: true,
  payoutsEnabled: true,
  detailsSubmitted: false,
  requirements: {
    currentlyDue: [],
    eventuallyDue: [],
    pastDue: ["external_account"],
  },
  payoutsBlockedReason: null,
  capabilityOverride: { stripeChargesEnabled: false, stripePayoutsEnabled: false },
};

const ACCEPTED_AT = new Date("2026-09-01T15:00:00.000Z");

/** Just the fields `headlineFromOverview` and the view read. */
const overviewFor = (payeeId: string | null) => ({
  payeeId,
  currency: "usd",
  balanceCents: payeeId ? 4950 : 0,
  payableCents: payeeId ? 4950 : 0,
  payableResolved: true,
  pendingHoldCents: 0,
  reserveCents: 0,
  payoutMinimumCents: 2500,
  minimumResolved: true,
  belowMinimum: payeeId ? false : null,
  payoutOverdue: null,
  asOf: new Date("2026-10-05T12:00:00.000Z"),
  otherCurrencies: [],
  upcoming: [],
});

const testState = vi.hoisted(() => ({
  owner: null as unknown,
  caps: { canEdit: true, canManage: true, canFinance: true },
  status: null as unknown,
  statusError: null as unknown,
  /** With `statusError`: React Query kept the last data (a failed REFETCH). */
  statusStale: false,
  statusLoading: false,
  statusRefetch: vi.fn(),
  overview: null as unknown,
  overviewError: null as unknown,
  statementError: null as unknown,
  scheduleProps: [] as Array<Record<string, unknown>>,
  // Owner-record reads (orgs.getOrg / humans.getMyProfile). `data: undefined`
  // = loading. Keys absent on the org payload = member may not see acceptance.
  org: { data: undefined as unknown, isLoading: true, error: null as unknown, dataUpdatedAt: 0, refetch: vi.fn() },
  human: { data: undefined as unknown, isLoading: true, error: null as unknown, dataUpdatedAt: 0, refetch: vi.fn() },
  onboard: vi.fn(async () => ({ onboardingUrl: "https://stripe.example/x" })),
  acceptOrg: vi.fn(async (_input: { orgId: string }) => ({
    ok: true as const,
    targetType: "ORGANIZATION" as const,
    targetId: "org-1",
    acceptedAt: new Date("2026-09-01T15:00:00.000Z"),
    terms: { version: "", text: "…" },
    alreadyAccepted: false,
  })),
  acceptHuman: vi.fn(async () => ({
    ok: true as const,
    targetType: "HUMAN" as const,
    targetId: "human-1",
    acceptedAt: new Date("2026-09-01T15:00:00.000Z"),
    terms: { version: "", text: "…" },
    alreadyAccepted: false,
  })),
  invalidateOrg: vi.fn(),
  invalidateHuman: vi.fn(),
  toastDanger: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "demo" }),
}));

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({
    children,
    onPress,
    ...props
  }: {
    children?: ReactNode;
    onPress?: () => void;
  }) => {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      // The scroll region's keyboard semantics live in exactly these props.
      if (
        key === "role" ||
        key.startsWith("data-") ||
        key === "id" ||
        key === "tabIndex" ||
        key.startsWith("aria-")
      )
        safe[key] = value;
    }
    if (onPress) safe.onClick = onPress;
    return React.createElement("div", safe, children);
  };
  return {
    XStack: Stack,
    YStack: Stack,
    Stack,
    styled: () => Stack,
    useTheme: () => ({}),
  };
});

vi.mock("@th/ui", () => ({
  parseNamespacedPathname: () => undefined,
  // `id` passes through: the section headings are the jump targets.
  Text: ({
    children,
    id,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    id?: string;
    "data-testid"?: string;
  }) => (
    <span id={id} data-testid={testId}>
      {children}
    </span>
  ),
  Badge: ({
    children,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    "data-testid"?: string;
  }) => <span data-testid={testId}>{children}</span>,
  Separator: () => <hr />,
  Spinner: () => <span>Loading</span>,
  Button: ({
    children,
    onPress,
    disabled,
    "data-testid": testId,
    "aria-expanded": ariaExpanded,
    "aria-controls": ariaControls,
    "aria-label": ariaLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    "data-testid"?: string;
    "aria-expanded"?: boolean;
    "aria-controls"?: string;
    "aria-label"?: string;
  }) => (
    <button
      type="button"
      onClick={onPress}
      disabled={disabled}
      data-testid={testId}
      aria-expanded={ariaExpanded}
      aria-controls={ariaControls}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  ),
  Checkbox: ({
    id,
    label,
    description,
    checked,
    onCheckedChange,
    disabled,
  }: {
    id: string;
    label?: ReactNode;
    description?: ReactNode;
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    disabled?: boolean;
  }) => (
    <div>
      <input
        id={id}
        type="checkbox"
        checked={Boolean(checked)}
        disabled={disabled}
        onChange={(event) => onCheckedChange?.(event.target.checked)}
      />
      <label htmlFor={id}>{label}</label>
      {description ? <span>{description}</span> : null}
    </div>
  ),
  useNotify: () => ({
    toast: { success: vi.fn(), danger: testState.toastDanger },
  }),
  // Keys render as themselves. The ONE exception spells out the acceptance
  // line's arguments, because the tests below pin WHICH date it shows (the
  // original acceptance, not now) and a bare key would hide that.
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    key === "admin.payoutsTermsAcceptedLine" && params
      ? `${String(params.title)} ${String(params.version)} · accepted ${String(params.date)}`
      : key,
  useFormatters: () => ({
    dateTime: (date: Date) => date.toISOString().slice(0, 10),
    currency: () => "$0.00",
    number: (n: number) => String(n),
  }),
}));

vi.mock("lucide-react", () => {
  const Icon = () => null;
  return {
    ExternalLink: Icon,
    CalendarClock: Icon,
    CheckCircle2: Icon,
    AlertTriangle: Icon,
    XCircle: Icon,
    RefreshCw: Icon,
    Wallet: Icon,
    ArrowUpRight: Icon,
    CreditCard: Icon,
    DollarSign: Icon,
    ChevronDown: Icon,
    Download: Icon,
  };
});

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      orgs: { getOrg: { invalidate: testState.invalidateOrg } },
      humans: { getMyProfile: { invalidate: testState.invalidateHuman } },
    }),
    stripeConnect: {
      getStatus: {
        useQuery: () => ({
          data: testState.statusLoading
            ? undefined
            : testState.statusError && !testState.statusStale
              ? undefined
              : testState.status,
          isLoading: testState.statusLoading,
          isFetching: testState.statusLoading,
          error: testState.statusError,
          refetch: testState.statusRefetch,
        }),
      },
      initiateOnboarding: {
        useMutation: () => ({ mutateAsync: testState.onboard, isPending: false }),
      },
      createLoginLink: {
        useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
      },
    },
    // NO `orders.getOwnerPayoutSummary`: Pending Payout left the page with
    // the merge (owner ruling), so a call to it would throw here.
    payouts: {
      getOverview: {
        useQuery: (_input: unknown, options?: { enabled?: boolean }) => ({
          data:
            options?.enabled === false || testState.overviewError
              ? undefined
              : testState.overview,
          isLoading: false,
          isFetching: false,
          error: testState.overviewError,
          refetch: vi.fn(),
        }),
      },
      exportLedger: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
      },
    },
    agreements: {
      getDefaultPayoutTerms: {
        useQuery: () => ({ data: undefined, isLoading: false }),
      },
    },
    orgs: {
      getOrg: { useQuery: () => testState.org },
      acceptChargebackTerms: {
        useMutation: () => ({ mutateAsync: testState.acceptOrg, isPending: false }),
      },
    },
    humans: {
      getMyProfile: { useQuery: () => testState.human },
      acceptMyChargebackTerms: {
        useMutation: () => ({ mutateAsync: testState.acceptHuman, isPending: false }),
      },
    },
  },
}));

vi.mock("@/hooks/useCurrentAdminOwner", () => ({
  useCurrentAdminOwner: () => ({
    currentOwner: testState.owner,
    isLoading: false,
  }),
}));

vi.mock("@/hooks/useAdminOwnerCapabilities", () => ({
  useAdminOwnerCapabilities: () => testState.caps,
}));

vi.mock("../PayoutScheduleSection", () => ({
  payoutScheduleTitleKey: () => null,
  PayoutScheduleSection: (props: Record<string, unknown>) => {
    testState.scheduleProps.push(props);
    return (
      <div
        data-testid="schedule-mock"
        data-payouts-ready={String(props.payoutsReady)}
        data-setup-message={String(props.setupRequiredMessage ?? "")}
      />
    );
  },
}));

// The Balance / Ledger renderers have their own suite (PayoutsView.test.tsx).
vi.mock("../PayoutPanel", () => ({
  PayoutAnswerSkeleton: () => null,
  PayoutPanel: () => <div data-testid="payout-panel" />,
}));
vi.mock("../MinimumRow", () => ({ MinimumRow: () => null }));
vi.mock("../BalanceBreakdown", () => ({
  BalanceBreakdown: () => <div data-testid="payout-breakdown" />,
}));
vi.mock("../LedgerTable", () => ({
  LedgerTable: () => <div data-testid="payout-ledger" />,
}));
vi.mock("../use-statement-pages", () => ({
  useStatementPages: () => ({
    first: undefined,
    entries: [],
    unconfirmedSeams: new Set(),
    hasMore: false,
    canLoadMore: false,
    balanceAfterResolved: true,
    isLoading: false,
    isLoadingMore: false,
    error: testState.statementError,
    refreshError: null,
    loadMoreError: null,
    loadMore: vi.fn(),
    refetch: vi.fn(),
  }),
}));

vi.mock("../../../_components/AdminPageHeader", () => ({
  AdminPageHeader: ({ trailing }: { trailing?: ReactNode }) => (
    <header>{trailing}</header>
  ),
}));

vi.mock("@/app/admin/_components/AdminPageData", () => ({
  AdminPageData: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

const acceptedTerms = (version: string) => ({
  version,
  text: "…",
});

const ORG_ROW = { id: "org-1", name: "Demo Org", slug: "demo", status: "ACTIVE" };
const orgRead = (fields: Record<string, unknown>) => ({
  data: { ...ORG_ROW, ...fields },
  isLoading: false,
  error: null,
  dataUpdatedAt: 1,
  refetch: vi.fn(),
});
const humanRead = (fields: Record<string, unknown>) => ({
  data: { phone: null, jobs: [], genreTags: [], otherJobDescription: "", ...fields },
  isLoading: false,
  error: null,
  dataUpdatedAt: 1,
  refetch: vi.fn(),
});
const NEVER_ACCEPTED = { chargebackTermsVersion: null, chargebackTermsAcceptedAt: null };

async function acceptOnPage() {
  fireEvent.click(screen.getByLabelText("admin.ebChargebackTermsCheckboxLabel"));
  fireEvent.click(screen.getByTestId("chargeback-terms-accept"));
  await waitFor(() =>
    expect(screen.getByTestId("chargeback-terms-acknowledged")).toBeTruthy(),
  );
}

describe("PayoutsView (Stripe) — chargeback terms gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.owner = ORG_OWNER;
    testState.caps = { canEdit: true, canManage: true, canFinance: true };
    testState.status = NOT_CONNECTED;
    testState.statusError = null;
    testState.statusStale = false;
    testState.statusLoading = false;
    testState.overviewError = null;
    testState.statementError = null;
    testState.overview = overviewFor(null);
    testState.scheduleProps = [];
    testState.org = orgRead(NEVER_ACCEPTED);
    testState.human = humanRead(NEVER_ACCEPTED);
    testState.acceptOrg.mockResolvedValue({
      ok: true,
      targetType: "ORGANIZATION",
      targetId: "org-1",
      acceptedAt: ACCEPTED_AT,
      terms: acceptedTerms(CHARGEBACK_TERMS_VERSION),
      alreadyAccepted: false,
    });
    testState.acceptHuman.mockResolvedValue({
      ok: true,
      targetType: "HUMAN",
      targetId: "human-1",
      acceptedAt: ACCEPTED_AT,
      terms: acceptedTerms(CHARGEBACK_TERMS_VERSION),
      alreadyAccepted: false,
    });
    testState.onboard.mockResolvedValue({ onboardingUrl: "https://stripe.example/x" });
  });

  it("not connected: Connect is disabled until the terms are accepted, then enabled", async () => {
    render(<PayoutsView />);

    const connect = screen.getByTestId("stripe-connect-start") as HTMLButtonElement;
    expect(connect.disabled).toBe(true);

    // Full text present, keyboard-reachable, and labelled.
    const region = screen.getByTestId("chargeback-terms-body");
    expect(region.getAttribute("role")).toBe("region");
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(region.getAttribute("aria-label")).toBe("admin.ebChargebackTermsTitle");
    expect(screen.getByText(/supplement the Ithas Fire Terms of Service/)).toBeTruthy();
    // Every paragraph of the live constant renders — nothing truncates and
    // nothing assumes a fixed count, so a terms revision that adds or drops
    // a paragraph cannot silently lose one.
    expect(region.children.length).toBe(
      CURRENT_CHARGEBACK_TERMS_TEXT.split("\n\n").length,
    );
    expect(region.textContent).toContain("does not debit your bank account");

    // Accept is a deliberate second act: disabled until the box is ticked.
    const accept = screen.getByTestId("chargeback-terms-accept") as HTMLButtonElement;
    expect(accept.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("admin.ebChargebackTermsCheckboxLabel"));
    expect(accept.disabled).toBe(false);

    fireEvent.click(accept);
    await waitFor(() =>
      expect(screen.getByTestId("chargeback-terms-acknowledged")).toBeTruthy(),
    );

    expect(testState.acceptOrg).toHaveBeenCalledWith({ orgId: "org-1" });
    expect(testState.invalidateOrg).toHaveBeenCalledWith({ orgId: "org-1" });
    // Accepting never starts onboarding by itself.
    expect(testState.onboard).not.toHaveBeenCalled();
    expect(connect.disabled).toBe(false);

    // Collapsed: version + date meta line, no wall of text, expander present.
    expect(
      screen.getByText(
        `admin.ebChargebackTermsTitle ${CHARGEBACK_TERMS_VERSION} · accepted 2026-09-01`,
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("chargeback-terms-section")).toBeNull();
    expect(screen.queryByTestId("chargeback-terms-body")).toBeNull();

    const toggle = screen.getByTestId("chargeback-terms-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // Nothing to point at while collapsed.
    expect(toggle.getAttribute("aria-controls")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const body = screen.getByTestId("chargeback-terms-body");
    expect(toggle.getAttribute("aria-controls")).toBe(body.getAttribute("id"));
  });

  it("backstop: onboarding answering chargeback_terms_required re-opens the terms with an inline error, no toast", async () => {
    testState.onboard.mockRejectedValueOnce(new Error("chargeback_terms_required"));
    render(<PayoutsView />);

    await acceptOnPage();
    const connect = screen.getByTestId("stripe-connect-start") as HTMLButtonElement;
    expect(connect.disabled).toBe(false);

    fireEvent.click(connect);

    await waitFor(() =>
      expect(screen.getByTestId("chargeback-terms-section")).toBeTruthy(),
    );
    const alert = screen.getByTestId("chargeback-terms-error");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain(
      "admin.payoutsTermsStillNeeded",
    );
    expect(testState.toastDanger).not.toHaveBeenCalled();
    expect(connect.disabled).toBe(true);
    // Re-asked ⇒ re-ticked from scratch.
    expect(
      (screen.getByLabelText("admin.ebChargebackTermsCheckboxLabel") as HTMLInputElement)
        .checked,
    ).toBe(false);
  });

  it("other onboarding failures still toast and leave the acceptance in place", async () => {
    testState.onboard.mockRejectedValueOnce(new Error("Stripe is down"));
    render(<PayoutsView />);

    await acceptOnPage();
    fireEvent.click(screen.getByTestId("stripe-connect-start"));

    await waitFor(() => expect(testState.toastDanger).toHaveBeenCalled());
    expect(screen.getByTestId("chargeback-terms-acknowledged")).toBeTruthy();
  });

  it("accept failure is inline and retryable", async () => {
    testState.acceptOrg.mockRejectedValueOnce(new Error("insufficient_role"));
    render(<PayoutsView />);

    fireEvent.click(screen.getByLabelText("admin.ebChargebackTermsCheckboxLabel"));
    fireEvent.click(screen.getByTestId("chargeback-terms-accept"));

    await waitFor(() =>
      expect(screen.getByTestId("chargeback-terms-error")).toBeTruthy(),
    );
    expect(screen.queryByTestId("chargeback-terms-acknowledged")).toBeNull();
    expect(
      (screen.getByTestId("stripe-connect-start") as HTMLButtonElement).disabled,
    ).toBe(true);

    // Retry succeeds.
    fireEvent.click(screen.getByTestId("chargeback-terms-accept"));
    await waitFor(() =>
      expect(screen.getByTestId("chargeback-terms-acknowledged")).toBeTruthy(),
    );
    expect(screen.queryByTestId("chargeback-terms-error")).toBeNull();
  });

  it("FINANCE member: may start onboarding but cannot accept — shows who can, no dead control", () => {
    testState.owner = { ...ORG_OWNER, role: "FINANCE" };
    testState.caps = { canEdit: false, canManage: false, canFinance: true };
    render(<PayoutsView />);

    expect(screen.getByTestId("chargeback-terms-section")).toBeTruthy();
    expect(
      screen.getByText("admin.payoutsTermsOrgOnly"),
    ).toBeTruthy();
    expect(screen.queryByTestId("chargeback-terms-accept")).toBeNull();
    expect(screen.queryByLabelText("admin.ebChargebackTermsCheckboxLabel")).toBeNull();
    expect(
      (screen.getByTestId("stripe-connect-start") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("EDITOR: no Connect button, so no terms section either", () => {
    testState.owner = { ...ORG_OWNER, role: "EDITOR" };
    testState.caps = { canEdit: true, canManage: false, canFinance: false };
    render(<PayoutsView />);

    expect(screen.queryByTestId("stripe-connect-start")).toBeNull();
    expect(screen.queryByTestId("chargeback-terms-section")).toBeNull();
  });

  it("connected but incomplete: Continue is gated the same way", async () => {
    testState.status = INCOMPLETE;
    render(<PayoutsView />);

    const cont = screen.getByTestId("stripe-connect-continue") as HTMLButtonElement;
    expect(cont.disabled).toBe(true);
    expect(screen.queryByTestId("stripe-connect-start")).toBeNull();

    await acceptOnPage();
    expect(cont.disabled).toBe(false);
  });

  it("human owner: accepts via humans.acceptMyChargebackTerms", async () => {
    testState.owner = HUMAN_OWNER;
    render(<PayoutsView />);

    // A profile-owner human always may accept, so no permission note.
    expect(screen.queryByText("admin.ebChargebackTermsHumanPermissionNote")).toBeNull();
    await acceptOnPage();

    expect(testState.acceptHuman).toHaveBeenCalledTimes(1);
    expect(testState.acceptOrg).not.toHaveBeenCalled();
    expect(testState.invalidateHuman).toHaveBeenCalled();
  });

  it("only one element on the page is named 'Accept terms'", () => {
    render(<PayoutsView />);
    expect(screen.getAllByText("admin.ebChargebackTermsAcceptOnly")).toHaveLength(1);
  });
});

describe("PayoutsView (Stripe) — server-held acceptance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.owner = ORG_OWNER;
    testState.caps = { canEdit: true, canManage: true, canFinance: true };
    testState.status = NOT_CONNECTED;
    testState.statusError = null;
    testState.statusStale = false;
    testState.statusLoading = false;
    testState.overviewError = null;
    testState.statementError = null;
    testState.overview = overviewFor(null);
    testState.scheduleProps = [];
    testState.human = humanRead(NEVER_ACCEPTED);
  });

  it("reload with a current acceptance: one-liner, Connect enabled, no accept call", () => {
    testState.org = orgRead({
      chargebackTermsVersion: CHARGEBACK_TERMS_VERSION,
      chargebackTermsAcceptedAt: new Date("2026-06-01T12:00:00.000Z"),
    });
    render(<PayoutsView />);

    expect(screen.getByTestId("chargeback-terms-acknowledged")).toBeTruthy();
    expect(
      screen.getByText(
        `admin.ebChargebackTermsTitle ${CHARGEBACK_TERMS_VERSION} · accepted 2026-06-01`,
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("chargeback-terms-section")).toBeNull();
    expect(
      (screen.getByTestId("stripe-connect-start") as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(testState.acceptOrg).not.toHaveBeenCalled();
  });

  it("stale server version: required again, Connect disabled", () => {
    testState.org = orgRead({
      chargebackTermsVersion: "2020-01-01",
      chargebackTermsAcceptedAt: new Date("2020-01-02T00:00:00.000Z"),
    });
    render(<PayoutsView />);

    expect(screen.getByTestId("chargeback-terms-section")).toBeTruthy();
    expect(screen.queryByTestId("chargeback-terms-acknowledged")).toBeNull();
    expect(
      (screen.getByTestId("stripe-connect-start") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("keys absent on the org record: permission state, no control, Connect disabled", () => {
    testState.org = orgRead({});
    render(<PayoutsView />);

    expect(screen.getByTestId("chargeback-terms-section")).toBeTruthy();
    expect(
      screen.getByText("admin.payoutsTermsOrgOnly"),
    ).toBeTruthy();
    expect(screen.queryByTestId("chargeback-terms-accept")).toBeNull();
    expect(screen.queryByLabelText("admin.ebChargebackTermsCheckboxLabel")).toBeNull();
    expect(
      (screen.getByTestId("stripe-connect-start") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("loading: compact state, no terms body, Connect disabled", () => {
    testState.org = { data: undefined, isLoading: true, error: null, dataUpdatedAt: 0, refetch: vi.fn() };
    render(<PayoutsView />);

    expect(screen.getByTestId("chargeback-terms-loading")).toBeTruthy();
    expect(screen.queryByTestId("chargeback-terms-body")).toBeNull();
    expect(screen.queryByTestId("chargeback-terms-accept")).toBeNull();
    expect(
      (screen.getByTestId("stripe-connect-start") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("owner-record read failed: inline error with retry, Connect disabled", () => {
    const refetch = vi.fn();
    testState.org = { data: undefined, isLoading: false, error: new Error("organization_not_found"), dataUpdatedAt: 0, refetch };
    render(<PayoutsView />);

    expect(screen.getByTestId("chargeback-terms-load-error")).toBeTruthy();
    fireEvent.click(screen.getByTestId("chargeback-terms-retry"));
    expect(refetch).toHaveBeenCalled();
    expect(
      (screen.getByTestId("stripe-connect-start") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("alreadyAccepted: true → the ORIGINAL acceptance date is shown, not now", async () => {
    // Server says stale; accept answers "already current" with the original stamp.
    testState.org = orgRead({
      chargebackTermsVersion: "2020-01-01",
      chargebackTermsAcceptedAt: new Date("2020-01-02T00:00:00.000Z"),
    });
    testState.acceptOrg.mockResolvedValueOnce({
      ok: true,
      targetType: "ORGANIZATION",
      targetId: "org-1",
      acceptedAt: new Date("2026-03-15T09:30:00.000Z"),
      terms: acceptedTerms(CHARGEBACK_TERMS_VERSION),
      alreadyAccepted: true,
    });
    render(<PayoutsView />);

    await acceptOnPage();
    expect(
      screen.getByText(
        `admin.ebChargebackTermsTitle ${CHARGEBACK_TERMS_VERSION} · accepted 2026-03-15`,
      ),
    ).toBeTruthy();
    expect(testState.invalidateOrg).toHaveBeenCalledWith({ orgId: "org-1" });
  });

  it("human owner: reads humans.getMyProfile", () => {
    testState.owner = HUMAN_OWNER;
    testState.human = humanRead({
      chargebackTermsVersion: CHARGEBACK_TERMS_VERSION,
      chargebackTermsAcceptedAt: new Date("2026-06-01T12:00:00.000Z"),
    });
    render(<PayoutsView />);

    expect(screen.getByTestId("chargeback-terms-acknowledged")).toBeTruthy();
    expect(
      (screen.getByTestId("stripe-connect-start") as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe("PayoutsView (Stripe) — session override vs server answer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.owner = ORG_OWNER;
    testState.caps = { canEdit: true, canManage: true, canFinance: true };
    testState.status = NOT_CONNECTED;
    testState.statusError = null;
    testState.statusStale = false;
    testState.statusLoading = false;
    testState.overviewError = null;
    testState.statementError = null;
    testState.overview = overviewFor(null);
    testState.scheduleProps = [];
    testState.org = orgRead(NEVER_ACCEPTED);
    testState.human = humanRead(NEVER_ACCEPTED);
    testState.acceptOrg.mockResolvedValue({
      ok: true,
      targetType: "ORGANIZATION",
      targetId: "org-1",
      acceptedAt: ACCEPTED_AT,
      terms: acceptedTerms(CHARGEBACK_TERMS_VERSION),
      alreadyAccepted: false,
    });
  });

  it("the accept override yields to a LATER server answer that says required", async () => {
    const view = render(<PayoutsView />);
    await acceptOnPage();
    expect(
      (screen.getByTestId("stripe-connect-start") as HTMLButtonElement).disabled,
    ).toBe(false);

    // Server re-answers after the override (e.g. the write was rolled back).
    testState.org = { ...orgRead(NEVER_ACCEPTED), dataUpdatedAt: Date.now() + 1000 };
    view.rerender(<PayoutsView />);

    expect(screen.getByTestId("chargeback-terms-section")).toBeTruthy();
    expect(screen.queryByTestId("chargeback-terms-acknowledged")).toBeNull();
    expect(
      (screen.getByTestId("stripe-connect-start") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("a stale cached record does NOT override a fresh accept (cache older than the override)", async () => {
    const view = render(<PayoutsView />);
    await acceptOnPage();
    // Same stale row re-delivered with the ORIGINAL timestamp: override still wins.
    testState.org = { ...orgRead(NEVER_ACCEPTED), dataUpdatedAt: 1 };
    view.rerender(<PayoutsView />);
    expect(screen.getByTestId("chargeback-terms-acknowledged")).toBeTruthy();
  });

  it("the markRequired override yields to a LATER server answer that says current, and the inline error goes", async () => {
    testState.onboard.mockRejectedValueOnce(new Error("chargeback_terms_required"));
    const view = render(<PayoutsView />);
    await acceptOnPage();
    fireEvent.click(screen.getByTestId("stripe-connect-start"));
    await waitFor(() =>
      expect(screen.getByTestId("chargeback-terms-error")).toBeTruthy(),
    );

    testState.org = {
      ...orgRead({
        chargebackTermsVersion: CHARGEBACK_TERMS_VERSION,
        chargebackTermsAcceptedAt: new Date("2026-06-01T12:00:00.000Z"),
      }),
      dataUpdatedAt: Date.now() + 1000,
    };
    view.rerender(<PayoutsView />);

    expect(screen.getByTestId("chargeback-terms-acknowledged")).toBeTruthy();
    expect(screen.queryByTestId("chargeback-terms-error")).toBeNull();
    expect(
      (screen.getByTestId("stripe-connect-start") as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe("PayoutsView (Stripe) — where the setup sits, and the CTA exactly once", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.owner = ORG_OWNER;
    testState.caps = { canEdit: true, canManage: true, canFinance: true };
    testState.status = NOT_CONNECTED;
    testState.statusError = null;
    testState.statusStale = false;
    testState.statusLoading = false;
    testState.overviewError = null;
    testState.statementError = null;
    testState.overview = overviewFor(null);
    testState.scheduleProps = [];
    testState.org = orgRead(NEVER_ACCEPTED);
    testState.human = humanRead(NEVER_ACCEPTED);
  });

  const ctaCount = () =>
    screen.queryAllByTestId("stripe-connect-start").length +
    screen.queryAllByTestId("stripe-connect-continue").length;

  it("not connected, no payee (board B): setup card at the top of Balance, one-liners elsewhere, CTA once", () => {
    render(<PayoutsView />);

    const balance = screen.getByTestId("payouts-section-balance");
    const setup = within(balance).getByTestId("stripe-setup-card");
    expect(within(setup).getByTestId("stripe-connect-start")).toBeTruthy();
    // The setup card comes BEFORE the "nothing yet" line inside Balance.
    const nothingYet = within(balance).getByTestId("payouts-no-payee");
    expect(nothingYet.textContent).toBe("admin.payoutsNothingYet");
    expect(
      setup.compareDocumentPosition(nothingYet) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Exactly one plain line: no second "nothing yet" and no link beside it.
    expect(screen.getAllByText("admin.payoutsNothingYet")).toHaveLength(1);

    expect(
      within(screen.getByTestId("payouts-section-ledger")).getByTestId(
        "payouts-ledger-nothing",
      ).textContent,
    ).toBe("admin.payoutsLedgerEmpty");
    // The pointer names Balance and links up to it.
    const setupPointer = within(
      screen.getByTestId("payouts-section-stripe"),
    ).getByTestId("stripe-account-setup-pointer");
    expect(
      within(setupPointer).getByText("admin.payoutsStripeSetupInBalance"),
    ).toBeTruthy();
    const setupLink = within(setupPointer).getByTestId(
      "stripe-account-setup-pointer-link",
    );
    expect(setupLink.tagName).toBe("A");
    expect(setupLink.getAttribute("href")).toBe("#balance");
    expect(setupLink.textContent).toBe("admin.payoutsGoToBalance");
    expect(within(setupPointer).queryByRole("button")).toBeNull();

    // Schedule: not ready (dims itself); its note says where the setup is
    // on THIS page — never the old "Stripe Connect section above".
    const schedule = screen.getByTestId("schedule-mock");
    expect(schedule.getAttribute("data-payouts-ready")).toBe("false");
    expect(schedule.getAttribute("data-setup-message")).toBe(
      "admin.payoutScheduleSetupRequiredTop",
    );

    expect(ctaCount()).toBe(1);
    expect(screen.getAllByText("admin.ebChargebackTermsAcceptOnly")).toHaveLength(1);
  });

  it("sections render in the fixed order Balance · Ledger · Payout schedule · Stripe account", () => {
    render(<PayoutsView />);
    const ids = screen
      .getAllByTestId(/^payouts-section-(balance|ledger|schedule|stripe)$/)
      .map((el) => el.getAttribute("data-testid"));
    expect(ids).toEqual([
      "payouts-section-balance",
      "payouts-section-ledger",
      "payouts-section-schedule",
      "payouts-section-stripe",
    ]);
  });

  it("not connected but a payee exists: setup card on top AND the full balance", () => {
    testState.overview = overviewFor("payee-1");
    render(<PayoutsView />);
    const balance = screen.getByTestId("payouts-section-balance");
    expect(within(balance).getByTestId("stripe-setup-card")).toBeTruthy();
    expect(within(balance).getByTestId("payout-panel")).toBeTruthy();
    expect(screen.queryByTestId("payouts-no-payee")).toBeNull();
    expect(screen.getByTestId("payout-ledger")).toBeTruthy();
    expect(ctaCount()).toBe(1);
  });

  it("connected but incomplete (board B): a banner on top with what's missing and Continue; the section points up; CTA once", () => {
    testState.status = INCOMPLETE;
    render(<PayoutsView />);

    expect(screen.queryByTestId("stripe-setup-card")).toBeNull();
    const balance = screen.getByTestId("payouts-section-balance");
    const banner = within(balance).getByTestId("stripe-incomplete-banner");
    expect(within(banner).getByText("admin.payoutsStripeIncompleteTitle")).toBeTruthy();
    // Payouts are off, so the batch skips this payee: "paused" is true.
    expect(within(banner).getByText("admin.payoutsStripeIncompletePaused")).toBeTruthy();
    // Charges · Payouts · Details on one line, as Stripe reports them.
    const facts = within(banner).getAllByTestId("stripe-state-fact");
    expect(facts.map((f) => f.textContent)).toEqual([
      "admin.payoutsStripeStateChargesadmin.payoutsStripeStateOff",
      "admin.payoutsStripeStatePayoutsadmin.payoutsStripeStateOff",
      "admin.payoutsStripeStateDetailsadmin.payoutsStripeStateNotSubmitted",
    ]);
    // What is still needed, and the one Continue.
    const reqs = within(banner).getByTestId("stripe-requirements");
    expect(within(reqs).getByText("admin.payoutsStripeStillNeeded")).toBeTruthy();
    expect(reqs.textContent).toContain("External Account");
    expect(within(banner).getByTestId("stripe-connect-continue")).toBeTruthy();
    expect(screen.queryByText("admin.accountFullySetUp")).toBeNull();

    // The Stripe account row says Incomplete and points UP at the banner;
    // its only button is its own Details disclosure, never a second CTA.
    const stripe = screen.getByTestId("payouts-section-stripe");
    expect(within(stripe).getByTestId("stripe-connection-badge").textContent).toBe(
      "admin.stripeIncomplete",
    );
    expect(within(stripe).queryByText("admin.connected")).toBeNull();
    expect(within(stripe).getByTestId("stripe-account-setup-pointer")).toBeTruthy();
    expect(within(stripe).queryByTestId("stripe-settings-line")).toBeNull();
    expect(
      within(stripe)
        .getAllByRole("button")
        .map((b) => b.getAttribute("data-testid")),
    ).toEqual(["stripe-details-toggle"]);
    // The account ID the old status strip carried is one click away.
    fireEvent.click(within(stripe).getByTestId("stripe-details-toggle"));
    expect(within(stripe).getByTestId("stripe-account-id").textContent).toContain(
      "acct_123",
    );
    expect(ctaCount()).toBe(1);
    // The schedule note points UP at it.
    expect(
      screen.getByTestId("schedule-mock").getAttribute("data-setup-message"),
    ).toBe("admin.payoutScheduleSetupRequiredTop");
  });

  it("fully connected: no onboarding CTA anywhere, Stripe Dashboard in the header, schedule ready", () => {
    testState.status = COMPLETE;
    testState.overview = overviewFor("payee-1");
    render(<PayoutsView />);

    expect(ctaCount()).toBe(0);
    expect(screen.queryByTestId("chargeback-terms-section")).toBeNull();
    expect(screen.getByText("admin.stripeDashboard")).toBeTruthy();
    expect(
      screen.getByTestId("schedule-mock").getAttribute("data-payouts-ready"),
    ).toBe("true");
    // The status strip is gone (board B). The Stripe row is one line —
    // "Payments and payouts on · acct_…" — and the badge says Connected.
    expect(screen.queryByTestId("payouts-status-strip")).toBeNull();
    expect(screen.queryByTestId("stripe-incomplete-banner")).toBeNull();
    const row = screen.getByTestId("stripe-settings-row");
    expect(within(row).getByTestId("stripe-settings-line").textContent).toBe(
      "admin.payoutsStripeLineOn \u00b7 acct_123",
    );
    expect(screen.getByTestId("stripe-connection-badge").textContent).toBe(
      "admin.connected",
    );
    // Details folded: the rows are behind a labelled click.
    const toggle = within(row).getByTestId("stripe-details-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe("payouts-stripe-details");
    expect(toggle.getAttribute("aria-label")).toBe("admin.payoutsStripeDetailsName");
    expect(within(row).queryByText("admin.chargesEnabled")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const details = within(row).getByTestId("stripe-details");
    expect(details.getAttribute("id")).toBe("payouts-stripe-details");
    expect(within(details).getAllByText("admin.payoutsStatusEnabled")).toHaveLength(3);
    expect(within(details).getByTestId("stripe-account-id").textContent).toContain(
      "acct_123",
    );
    expect(screen.queryByText("admin.pendingPayoutLabel")).toBeNull();
    // Stripe reports it, so no override note.
    expect(screen.queryByTestId("stripe-capability-override-note")).toBeNull();
    // "Fully set up" is gone from this page: the badge and the line say it.
    expect(screen.queryByText("admin.accountFullySetUp")).toBeNull();
  });

  // A money screen states what Stripe reports. Charges and payouts alone are
  // not "set up" while Stripe still wants the account's details.
  it("charges and payouts on but details not submitted: incomplete, not fully set up", () => {
    testState.status = { ...COMPLETE, detailsSubmitted: false };
    testState.overview = overviewFor("payee-1");
    render(<PayoutsView />);

    expect(screen.queryByText("admin.accountFullySetUp")).toBeNull();
    const banner = screen.getByTestId("stripe-incomplete-banner");
    // Payouts are on, so nothing is paused: the line says only what's owed.
    expect(
      within(banner).getByText("admin.payoutsStripeIncompleteNeedsDetails"),
    ).toBeTruthy();
    expect(within(banner).queryByText("admin.payoutsStripeIncompletePaused")).toBeNull();
    // No Express dashboard for an account Stripe has not finished.
    expect(screen.queryByText("admin.stripeDashboard")).toBeNull();
    expect(screen.getAllByTestId("stripe-connect-continue")).toHaveLength(1);
    // The schedule mirrors the server's gate (the Payee row), which passes.
    expect(
      screen.getByTestId("schedule-mock").getAttribute("data-payouts-ready"),
    ).toBe("true");
  });

  it("dev override standing in for Stripe: rows show Stripe's own answer and the note says why", () => {
    testState.status = OVERRIDDEN;
    testState.overview = overviewFor("payee-1");
    render(<PayoutsView />);

    expect(screen.queryByText("admin.accountFullySetUp")).toBeNull();

    const card = screen.getByTestId("stripe-incomplete-banner");
    // Charges, payouts and details: all three as Stripe reports them, off.
    expect(within(card).getAllByText("admin.payoutsStripeStateOff")).toHaveLength(2);
    expect(
      within(card).getByText("admin.payoutsStripeStateNotSubmitted"),
    ).toBeTruthy();
    expect(within(card).queryByText("admin.payoutsStripeStateOn")).toBeNull();
    expect(
      within(card).getByTestId("stripe-capability-override-note").textContent,
    ).toBe("admin.payoutsStripeOverrideNote");
    expect(screen.queryByText("admin.stripeDashboard")).toBeNull();
  });

  it("the override note comes after all three status rows, since it says 'the rows above'", () => {
    testState.status = OVERRIDDEN;
    testState.overview = overviewFor("payee-1");
    render(<PayoutsView />);

    const card = screen.getByTestId("stripe-incomplete-banner");
    const note = within(card).getByTestId("stripe-capability-override-note");
    const details = within(card).getByText("admin.payoutsStripeStateDetails");
    expect(
      details.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const requirements = within(card).getByText("admin.payoutsStripeStillNeeded");
    expect(
      note.compareDocumentPosition(requirements) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("a requirement Stripe lists as both past due and currently due shows once", () => {
    testState.status = {
      ...OVERRIDDEN,
      requirements: {
        currentlyDue: ["external_account", "individual.verification.document"],
        eventuallyDue: [],
        pastDue: ["external_account", "individual.verification.document"],
      },
    };
    testState.overview = overviewFor("payee-1");
    render(<PayoutsView />);

    const card = screen.getByTestId("stripe-incomplete-banner");
    expect(within(card).getAllByText(/External Account/)).toHaveLength(1);
    expect(
      within(card).getAllByText(/Individual › Verification › Document/),
    ).toHaveLength(1);
  });

  // A Stripe outage answers with the last-known record and details UNKNOWN.
  // A finished account must not read as "onboarding incomplete" then.
  it("Stripe unreachable, last known fully set up: stays set up, Details Unknown, says it is the last known", () => {
    testState.status = {
      ...COMPLETE,
      detailsSubmitted: null,
      requirements: null,
    };
    testState.overview = overviewFor("payee-1");
    render(<PayoutsView />);

    const card = screen.getByTestId("stripe-settings-row");
    expect(within(card).getByTestId("stripe-settings-line")).toBeTruthy();
    expect(screen.getByTestId("stripe-connection-badge").textContent).toBe(
      "admin.connected",
    );
    expect(
      within(card).getByTestId("stripe-status-refresh-failed").textContent,
    ).toBe("admin.payoutsStripeRefreshFailed");
    // Details: no value Stripe didn't give.
    fireEvent.click(within(card).getByTestId("stripe-details-toggle"));
    expect(within(card).getByText("admin.payoutsStatusUnknown")).toBeTruthy();
    expect(within(card).getAllByText("admin.payoutsStatusEnabled")).toHaveLength(2);
    expect(within(card).queryByText("admin.payoutsStatusDisabled")).toBeNull();

    expect(screen.queryByTestId("stripe-incomplete-banner")).toBeNull();
    expect(screen.getByText("admin.stripeDashboard")).toBeTruthy();
    expect(ctaCount()).toBe(0);
  });

  // A forcing test server whose Stripe read failed: the row's true/true may
  // be the override's own earlier write, so nothing here may say "set up".
  it("forced + Stripe unreachable: not set up, Charges/Payouts/Details Unknown, the note and the last-known line", () => {
    testState.status = {
      ...COMPLETE,
      detailsSubmitted: null,
      requirements: null,
      capabilityOverride: {
        stripeChargesEnabled: null,
        stripePayoutsEnabled: null,
      },
    };
    testState.overview = overviewFor("payee-1");
    render(<PayoutsView />);

    const card = screen.getByTestId("stripe-incomplete-banner");
    expect(screen.queryByText("admin.accountFullySetUp")).toBeNull();
    expect(within(card).getByText("admin.payoutsStripeIncompleteTitle")).toBeTruthy();
    // Never the row's forced "on".
    expect(within(card).getAllByText("admin.payoutsStatusUnknown")).toHaveLength(3);
    expect(within(card).queryByText("admin.payoutsStripeStateOn")).toBeNull();
    expect(
      within(card).getByTestId("stripe-capability-override-note").textContent,
    ).toBe("admin.payoutsStripeOverrideNote");
    expect(within(card).getByTestId("stripe-status-refresh-failed")).toBeTruthy();
    expect(screen.queryByText("admin.stripeDashboard")).toBeNull();
  });

  it("Stripe unreachable, last known incomplete: incomplete, Details Unknown, the last-known line", () => {
    testState.status = {
      ...INCOMPLETE,
      detailsSubmitted: null,
      requirements: null,
    };
    render(<PayoutsView />);

    const card = screen.getByTestId("stripe-incomplete-banner");
    expect(within(card).getByText("admin.payoutsStripeIncompleteTitle")).toBeTruthy();
    expect(within(card).getByText("admin.payoutsStatusUnknown")).toBeTruthy();
    expect(within(card).getByTestId("stripe-status-refresh-failed")).toBeTruthy();
    expect(screen.queryByText("admin.stripeDashboard")).toBeNull();
  });

  it("an incomplete account Stripe reports as such: no override note", () => {
    testState.status = INCOMPLETE;
    render(<PayoutsView />);
    expect(screen.getByTestId("stripe-incomplete-banner")).toBeTruthy();
    expect(screen.queryByTestId("stripe-capability-override-note")).toBeNull();
  });

  it("payouts blocked for a named reason: the banner says 'paused' and lets the reason line name the cause", () => {
    testState.status = { ...INCOMPLETE, payoutsBlockedReason: "account_restricted" };
    render(<PayoutsView />);
    const banner = screen.getByTestId("stripe-incomplete-banner");
    expect(
      within(banner).getByText("admin.payoutsStripeIncompletePausedShort"),
    ).toBeTruthy();
    expect(within(banner).getByText("admin.payoutsBlockedRestricted")).toBeTruthy();
    expect(within(banner).queryByText("admin.payoutsStripeIncompletePaused")).toBeNull();
  });

  it("EDITOR on an incomplete account: the banner states the facts, offers no Continue", () => {
    testState.status = INCOMPLETE;
    testState.caps = { canEdit: true, canManage: false, canFinance: false };
    render(<PayoutsView />);
    const banner = screen.getByTestId("stripe-incomplete-banner");
    expect(within(banner).getByTestId("stripe-requirements")).toBeTruthy();
    expect(ctaCount()).toBe(0);
  });

  it("status read failed: no setup button anywhere, the failure shows in the Stripe account section", () => {
    testState.statusError = new Error("boom");
    render(<PayoutsView />);

    expect(ctaCount()).toBe(0);
    expect(screen.queryByTestId("stripe-setup-card")).toBeNull();
    expect(
      within(screen.getByTestId("payouts-section-stripe")).getByTestId(
        "stripe-status-error",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("admin.stripeNotConnected")).toBeNull();
  });

  it("connected but incomplete, no payee: the banner is Balance's whole story — no 'once connected' line, Continue once", () => {
    testState.status = INCOMPLETE;
    render(<PayoutsView />);

    const balance = screen.getByTestId("payouts-section-balance");
    expect(within(balance).getByTestId("stripe-incomplete-banner")).toBeTruthy();
    expect(within(balance).queryByTestId("payouts-no-payee")).toBeNull();
    expect(screen.queryByText("admin.payoutsNothingYet")).toBeNull();
    expect(screen.queryByTestId("payouts-finish-stripe")).toBeNull();
    expect(within(balance).getAllByTestId("stripe-connect-continue")).toHaveLength(1);
    expect(ctaCount()).toBe(1);
  });

  it("connected but incomplete WITH a payee: the full balance, no pointer", () => {
    testState.status = INCOMPLETE;
    testState.overview = overviewFor("payee-1");
    render(<PayoutsView />);
    expect(screen.queryByTestId("payouts-finish-stripe")).toBeNull();
    expect(screen.getByTestId("payout-panel")).toBeTruthy();
  });

  it("first-load status failure: an error card with its own Retry; schedule note points below", () => {
    testState.statusError = new Error("boom");
    render(<PayoutsView />);

    expect(ctaCount()).toBe(0);
    // Balance: one plain line; the Stripe row carries the error.
    expect(screen.getByTestId("payouts-no-payee").textContent).toBe(
      "admin.payoutsNothingYet",
    );
    fireEvent.click(screen.getByTestId("stripe-status-retry"));
    expect(testState.statusRefetch).toHaveBeenCalled();
    expect(
      screen.getByTestId("schedule-mock").getAttribute("data-setup-message"),
    ).toBe("admin.payoutScheduleSetupRequiredBelow");
  });

  it("failed REFETCH with stale data (incomplete): the card stays, with an inline line; Continue once", () => {
    testState.status = INCOMPLETE;
    testState.statusError = new Error("stripe timed out");
    testState.statusStale = true;
    render(<PayoutsView />);

    const banner = screen.getByTestId("stripe-incomplete-banner");
    expect(
      within(banner).getByTestId("stripe-status-refresh-failed").textContent,
    ).toBe("admin.payoutsStripeRefreshFailed");
    // The section's pointer says it too.
    expect(
      within(screen.getByTestId("payouts-section-stripe")).getByTestId(
        "stripe-status-refresh-failed",
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("stripe-status-error")).toBeNull();
    expect(screen.getAllByTestId("stripe-connect-continue")).toHaveLength(1);
    expect(ctaCount()).toBe(1);
  });

  it("failed REFETCH with stale data (not connected): the setup card stays on top, the pointer says why", () => {
    testState.statusError = new Error("stripe timed out");
    testState.statusStale = true;
    render(<PayoutsView />);

    expect(screen.getByTestId("stripe-setup-card")).toBeTruthy();
    const stripe = screen.getByTestId("payouts-section-stripe");
    expect(within(stripe).getByTestId("stripe-account-setup-pointer")).toBeTruthy();
    expect(within(stripe).getByTestId("stripe-status-refresh-failed")).toBeTruthy();
    expect(ctaCount()).toBe(1);
  });

  it("Stripe status still loading: Balance and Ledger render; only the Stripe slots wait", () => {
    testState.statusLoading = true;
    render(<PayoutsView />);

    expect(screen.queryByTestId("payouts-skeleton")).toBeNull();
    // No "once Stripe is connected" line while we don't know whether it is:
    // the setup-slot skeleton is the only thing in its place.
    expect(screen.queryByTestId("payouts-no-payee")).toBeNull();
    expect(screen.queryByText("admin.payoutsNothingYet")).toBeNull();
    expect(screen.getByTestId("payouts-ledger-nothing")).toBeTruthy();
    const balance = screen.getByTestId("payouts-section-balance");
    expect(within(balance).getByTestId("stripe-status-skeleton")).toBeTruthy();
    expect(
      within(screen.getByTestId("payouts-section-stripe")).getByTestId(
        "stripe-status-skeleton",
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("stripe-setup-card")).toBeNull();
    expect(ctaCount()).toBe(0);
  });

  /** The schedule row's disclosure state, as PayoutsView last passed it. */
  const scheduleOpen = () =>
    (
      testState.scheduleProps.at(-1)?.disclosure as
        | { open: boolean }
        | undefined
    )?.open;

  it("Settings (board B): one band, the schedule row then the Stripe row, distinct button names", () => {
    testState.status = COMPLETE;
    testState.overview = overviewFor("payee-1");
    render(<PayoutsView />);
    const band = screen.getByTestId("payouts-section-settings");
    expect(within(band).getByText("admin.payoutsSettingsHeading")).toBeTruthy();
    const rows = within(band)
      .getAllByTestId(/^payouts-section-(schedule|stripe)$/)
      .map((el) => el.getAttribute("data-testid"));
    expect(rows).toEqual(["payouts-section-schedule", "payouts-section-stripe"]);
    // The schedule row is folded until asked.
    expect(scheduleOpen()).toBe(false);
    // No two buttons on the page share an accessible name.
    const names = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(new Set(names).size).toBe(names.length);
  });

  it("a landing on #stripe (an old /payments#stripe link) opens the Stripe details", () => {
    testState.status = COMPLETE;
    testState.overview = overviewFor("payee-1");
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    window.history.replaceState(null, "", "#stripe");
    try {
      render(<PayoutsView />);
      expect(scroll).toHaveBeenCalled();
      expect(
        screen.getByTestId("stripe-details-toggle").getAttribute("aria-expanded"),
      ).toBe("true");
      expect(screen.getByTestId("stripe-details").getAttribute("data-open")).toBe(
        "true",
      );
      expect(scheduleOpen()).toBe(false);
    } finally {
      window.history.replaceState(null, "", window.location.pathname);
    }
  });

  it("a landing on #schedule opens the schedule picker", () => {
    testState.status = COMPLETE;
    testState.overview = overviewFor("payee-1");
    Element.prototype.scrollIntoView = vi.fn();
    window.history.replaceState(null, "", "#schedule");
    try {
      render(<PayoutsView />);
      expect(scheduleOpen()).toBe(true);
      expect(
        screen.getByTestId("stripe-details-toggle").getAttribute("aria-expanded"),
      ).toBe("false");
    } finally {
      window.history.replaceState(null, "", window.location.pathname);
    }
  });

  it("phone chip row lists the four sections with the short labels", () => {
    render(<PayoutsView />);
    const chips = screen.getByTestId("payouts-section-chips");
    expect(chips.getAttribute("aria-label")).toBe("admin.payoutsSectionIndexLabel");
    expect(
      within(chips)
        .getAllByRole("link")
        .map((a) => [a.getAttribute("href"), a.textContent]),
    ).toEqual([
      ["#balance", "admin.payoutsSectionBalance"],
      ["#ledger", "admin.payoutsLedgerHeading"],
      ["#schedule", "admin.payoutsChipSchedule"],
      ["#stripe", "admin.payoutsChipStripe"],
    ]);
  });
});

describe("PayoutsView (Stripe) — the section badge and role notices", () => {
  const FORBIDDEN = { data: { code: "FORBIDDEN" } };

  beforeEach(() => {
    vi.clearAllMocks();
    testState.owner = ORG_OWNER;
    testState.caps = { canEdit: true, canManage: true, canFinance: true };
    testState.status = COMPLETE;
    testState.statusError = null;
    testState.statusStale = false;
    testState.statusLoading = false;
    testState.overview = overviewFor("payee-1");
    testState.overviewError = null;
    testState.statementError = null;
    testState.scheduleProps = [];
    testState.org = orgRead(NEVER_ACCEPTED);
    testState.human = humanRead(NEVER_ACCEPTED);
  });

  const ctaCount = () =>
    screen.queryAllByTestId("stripe-connect-start").length +
    screen.queryAllByTestId("stripe-connect-continue").length;

  it("connected: the badge sits on the section heading row; the card has no heading of its own", () => {
    render(<PayoutsView />);
    const stripe = screen.getByTestId("payouts-section-stripe");
    expect(within(stripe).getByTestId("stripe-connection-badge").textContent).toBe(
      "admin.connected",
    );
    const card = within(stripe).getByTestId("stripe-settings-row");
    expect(within(card).queryByText("admin.stripeConnect")).toBeNull();
    expect(within(card).queryByTestId("stripe-connection-badge")).toBeNull();
  });

  it("not connected: the badge says so", () => {
    testState.status = NOT_CONNECTED;
    testState.overview = overviewFor(null);
    render(<PayoutsView />);
    expect(
      within(screen.getByTestId("payouts-section-stripe")).getByTestId(
        "stripe-connection-badge",
      ).textContent,
    ).toBe("admin.stripeNotConnected");
  });

  it("no badge while the status loads or after it failed", () => {
    testState.statusLoading = true;
    const { unmount } = render(<PayoutsView />);
    expect(screen.queryByTestId("stripe-connection-badge")).toBeNull();
    unmount();
    testState.statusLoading = false;
    testState.statusError = new Error("boom");
    render(<PayoutsView />);
    expect(screen.queryByTestId("stripe-connection-badge")).toBeNull();
  });

  it("EDITOR (overview + statement FORBIDDEN, status readable): money sections say who can see them; Stripe works", () => {
    testState.caps = { canEdit: true, canManage: false, canFinance: false };
    testState.overviewError = FORBIDDEN;
    testState.statementError = FORBIDDEN;
    render(<PayoutsView />);

    const balance = screen.getByTestId("payouts-section-balance");
    expect(
      within(balance).getByTestId("payouts-balance-role-notice").textContent,
    ).toBe("admin.payoutsRoleNoticeMoney");
    expect(screen.queryByTestId("payouts-balance-error")).toBeNull();
    expect(within(balance).queryByRole("button")).toBeNull();
    expect(
      within(screen.getByTestId("payouts-section-ledger")).getByTestId(
        "payouts-ledger-role-notice",
      ).textContent,
    ).toBe("admin.payoutsRoleNoticeMoney");
    expect(screen.queryByTestId("ledger-unavailable")).toBeNull();
    // No ledger to download: the role notice stands alone.
    expect(screen.queryByTestId("ledger-download-csv")).toBeNull();
    expect(screen.getByTestId("stripe-settings-row")).toBeTruthy();
    expect(screen.getByTestId("schedule-mock")).toBeTruthy();
  });

  // `stripeConnect.createLoginLink` is ORG_FINANCE_ROLES for an org.
  it("EDITOR on a fully connected account: reads the Stripe status, gets no Stripe Dashboard link", () => {
    testState.owner = { ...ORG_OWNER, role: "EDITOR" };
    testState.caps = { canEdit: true, canManage: false, canFinance: false };
    render(<PayoutsView />);

    expect(screen.getByTestId("stripe-settings-row")).toBeTruthy();
    expect(screen.queryByText("admin.stripeDashboard")).toBeNull();
  });

  it("FINANCE on a fully connected account: the Stripe Dashboard link is offered", () => {
    testState.owner = { ...ORG_OWNER, role: "FINANCE" };
    testState.caps = { canEdit: false, canManage: false, canFinance: true };
    render(<PayoutsView />);

    expect(screen.getByText("admin.stripeDashboard")).toBeTruthy();
  });

  it("VIEWER (every read FORBIDDEN): four calm notices, no error card, no Retry, no setup button", () => {
    testState.caps = { canEdit: false, canManage: false, canFinance: false };
    testState.overviewError = FORBIDDEN;
    testState.statementError = FORBIDDEN;
    testState.statusError = FORBIDDEN;
    render(<PayoutsView />);

    expect(screen.getByTestId("payouts-balance-role-notice")).toBeTruthy();
    expect(screen.getByTestId("payouts-ledger-role-notice")).toBeTruthy();
    expect(
      within(screen.getByTestId("payouts-section-stripe")).getByTestId(
        "stripe-status-role-notice",
      ).textContent,
    ).toBe("admin.payoutsRoleNoticeAccount");
    expect(screen.queryByTestId("stripe-status-error")).toBeNull();
    expect(screen.queryByTestId("stripe-status-retry")).toBeNull();
    expect(screen.queryByTestId("stripe-setup-card")).toBeNull();
    expect(screen.queryByTestId("stripe-connection-badge")).toBeNull();
    expect(ctaCount()).toBe(0);
  });

  it("a REAL failure keeps its error with Retry (not a role notice)", () => {
    testState.overviewError = { data: { code: "INTERNAL_SERVER_ERROR" } };
    testState.statusError = { data: { code: "INTERNAL_SERVER_ERROR" } };
    render(<PayoutsView />);
    expect(screen.getByTestId("payouts-balance-error")).toBeTruthy();
    expect(screen.queryByTestId("payouts-balance-role-notice")).toBeNull();
    expect(screen.getByTestId("stripe-status-retry")).toBeTruthy();
    expect(screen.queryByTestId("stripe-status-role-notice")).toBeNull();
  });
});

describe("resolveServerChargebackTermsAcceptance", () => {
  it("undefined payload → unknown; keys absent → forbidden; null keys → required", () => {
    expect(resolveServerChargebackTermsAcceptance(undefined)).toEqual({ status: "unknown" });
    expect(resolveServerChargebackTermsAcceptance({ id: "org-1" })).toEqual({ status: "forbidden" });
    expect(
      resolveServerChargebackTermsAcceptance({
        chargebackTermsVersion: null,
        chargebackTermsAcceptedAt: null,
      }),
    ).toEqual({ status: "required" });
  });
});

describe("resolveChargebackTermsAcceptance", () => {
  it("no acceptance → required", () => {
    expect(resolveChargebackTermsAcceptance(null)).toEqual({ status: "required" });
    expect(resolveChargebackTermsAcceptance({})).toEqual({ status: "required" });
  });

  it("stale version → required (the re-entry case the strict gate refuses)", () => {
    expect(
      resolveChargebackTermsAcceptance({
        chargebackTermsVersion: "2020-01-01",
        chargebackTermsAcceptedAt: ACCEPTED_AT,
      }),
    ).toEqual({ status: "required" });
  });

  it("current version with a timestamp → current", () => {
    expect(
      resolveChargebackTermsAcceptance({
        chargebackTermsVersion: CHARGEBACK_TERMS_VERSION,
        chargebackTermsAcceptedAt: ACCEPTED_AT.toISOString(),
      }),
    ).toEqual({
      status: "current",
      version: CHARGEBACK_TERMS_VERSION,
      acceptedAt: ACCEPTED_AT,
    });
  });
});
