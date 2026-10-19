import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
} from "@tanstack/react-query";
import type {
  GetOrgPayoutOverviewOutput,
  OrgPayoutCreditLine,
  OrgPayoutTranche,
} from "@th/core/use-cases/payouts/get-org-payout-overview";
import type {
  GetPayeeStatementOutput,
  PayeeStatementEntry,
} from "@th/core/use-cases/payouts/get-payee-statement";

import { PayoutsView } from "../PayoutsView";

// ─────────────────────────────────────────────────────────────────────────────
// Harness (mirrors PaymentsView.test.tsx): tamagui/@th/ui become plain DOM so
// the page's STATE MACHINE is exercised without the design system — the four
// minimum-row states that must not look alike, the payable cascade, the
// no-payee empty, the human-owner fallback, and appending ledger pages.
//
// `t` echoes its key and, when given values, a JSON tail — so a sentence's
// arithmetic can be asserted through the mock without a real catalog.
//
// The `@/trpc` mock HONOURS `enabled`: a disabled query returns an idle
// result, so the human path's "no overview" is asserted, not assumed. The
// DataTable mock renders BOTH the column cells and `renderMobileCard`, so the
// phone layout is covered by the same fixtures.
// ─────────────────────────────────────────────────────────────────────────────

type Owner =
  | {
      kind: "org";
      orgId: string;
      orgName: string;
      orgSlug: string;
      role: "OWNER";
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

type QueryResult<T> = {
  data: T | undefined;
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
  refetch: () => void;
};

const ok = <T,>(data: T): QueryResult<T> => ({
  data,
  isLoading: false,
  isFetching: false,
  error: null,
  refetch: vi.fn(),
});

const IDLE: QueryResult<never> = {
  data: undefined,
  isLoading: false,
  isFetching: false,
  error: null,
  refetch: vi.fn(),
};

const PENDING: QueryResult<never> = {
  data: undefined,
  isLoading: true,
  isFetching: true,
  error: null,
  refetch: vi.fn(),
};

const testState = vi.hoisted(() => ({
  owner: null as unknown,
  ownerLoading: false,
  overview: {
    data: undefined as unknown,
    isLoading: false,
    isFetching: false,
    error: null as unknown,
    refetch: vi.fn() as () => void,
  },
  /** Every `getOverview.useQuery` call's options, in order. */
  overviewOptions: [] as Array<{ enabled?: boolean }>,
  /** Statement pages keyed by offset; an absent offset is in flight. */
  statementPages: {} as Record<number, unknown>,
  /** Every statement input the view asked for, in order. */
  statementInputs: [] as unknown[],
  /** The loaded Stripe status. Payouts off = the batch skips the payee. */
  stripeStatus: {
    connected: true,
    chargesEnabled: true,
    payoutsEnabled: true,
  } as { connected: boolean; chargesEnabled: boolean; payoutsEnabled: boolean },
  /** `payouts.exportLedger.useMutation()`'s result. */
  exportLedger: {
    mutate: vi.fn() as (input: unknown, options?: unknown) => void,
    isPending: false,
    isError: false,
  },
  downloadCsv: vi.fn() as (csv: string, filename: string) => void,
  /** When set, `exportLedger.useMutation` is react-query's real hook over this fn. */
  exportLedgerFn: null as null | (() => Promise<unknown>),
  captureException: vi.fn() as (err: unknown, hint?: unknown) => void,
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
      if (
        key === "role" ||
        key === "id" ||
        key.startsWith("data-") ||
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

vi.mock("@th/ui", () => {
  const passthrough = (props: Record<string, unknown>) => {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      if (key.startsWith("data-") || key.startsWith("aria-") || key === "role")
        safe[key] = value;
    }
    if (typeof props.testId === "string") safe["data-testid"] = props.testId;
    if (typeof props.tone === "string") safe["data-tone"] = props.tone;
    if (typeof props.tag === "string") safe["data-tag"] = props.tag;
    if (typeof props.fontSize === "string") safe["data-font-size"] = props.fontSize;
    return safe;
  };
  return {
    monoScale: { lg: { fontSize: 13, letterSpacing: 0.4 } },
    Text: ({ children, ...props }: { children?: ReactNode }) => (
      <span {...passthrough(props)}>{children}</span>
    ),
    Badge: ({ children, ...props }: { children?: ReactNode }) => (
      <span {...passthrough(props)}>{children}</span>
    ),
    Spinner: () => <span>Loading</span>,
    NextLinkAnchor: ({
      href,
      children,
    }: {
      href: string;
      children?: ReactNode;
    }) => <a href={href}>{children}</a>,
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
    DataTable: ({
      columns,
      rows,
      getRowKey,
      caption,
      emptyState,
      renderMobileCard,
    }: {
      columns: Array<{ id: string; cell: (row: unknown) => ReactNode }>;
      rows: unknown[];
      getRowKey: (row: unknown, index: number) => string;
      caption?: string;
      emptyState?: ReactNode;
      renderMobileCard?: (row: unknown) => ReactNode;
    }) => (
      <div data-testid="ledger-datatable">
        <table>
          <caption>{caption}</caption>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td>{emptyState}</td>
              </tr>
            ) : (
              rows.map((row, index) => (
                <tr key={getRowKey(row, index)} data-testid="ledger-row">
                  {columns.map((column) => (
                    <td key={column.id}>{column.cell(row)}</td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
        {renderMobileCard && (
          <div data-testid="ledger-cards">
            {rows.map((row, index) => (
              <div key={getRowKey(row, index)}>{renderMobileCard(row)}</div>
            ))}
          </div>
        )}
      </div>
    ),
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
      values ? `${key}|${JSON.stringify(values)}` : key,
    useFormatters: () => ({
      dateTime: (date: Date) => date.toISOString().slice(0, 10),
      currency: (amount: number) =>
        `$${amount.toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}`,
      number: (n: number) => String(n),
    }),
  };
});

vi.mock("lucide-react", () => {
  const Icon = () => null;
  return {
    RefreshCw: Icon,
    Wallet: Icon,
    ArrowUpRight: Icon,
    ChevronDown: Icon,
    Download: Icon,
  };
});

vi.mock("@/trpc", () => ({
  trpc: {
    payouts: {
      getOverview: {
        useQuery: (_input: unknown, options?: { enabled?: boolean }) => {
          testState.overviewOptions.push(options ?? {});
          return options?.enabled === false ? IDLE : testState.overview;
        },
      },
      exportLedger: {
        useMutation: () => {
          const fn = testState.exportLedgerFn;
          // Fixed per test, so the hook order never changes within one.
          // eslint-disable-next-line react-hooks/rules-of-hooks
          return fn ? useMutation({ mutationFn: fn }) : testState.exportLedger;
        },
      },
    },
    useQueries: (
      build: (proxy: {
        payouts: {
          getStatement: (
            input: { offset: number },
            options?: { enabled?: boolean },
          ) => unknown;
        };
      }) => unknown[],
    ) =>
      build({
        payouts: {
          getStatement: (input, options) => {
            if (options?.enabled === false) return IDLE;
            testState.statementInputs.push(input);
            return testState.statementPages[input.offset] ?? PENDING;
          },
        },
      }),
  },
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: (err: unknown, hint?: unknown) =>
    testState.captureException(err, hint),
}));

vi.mock("@/lib/csv-export", () => ({
  downloadCsv: (csv: string, filename: string) => testState.downloadCsv(csv, filename),
}));

vi.mock("@/hooks/useCurrentAdminOwner", () => ({
  useCurrentAdminOwner: () => ({
    currentOwner: testState.owner,
    isLoading: testState.ownerLoading,
  }),
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : "formatted-error",
}));

vi.mock("../../../_components/AdminPageHeader", () => ({
  AdminPageHeader: ({
    title,
    subtitle,
    trailing,
  }: {
    title: string;
    subtitle?: string;
    trailing?: ReactNode;
  }) => (
    <header>
      <h1>{title}</h1>
      <p>{subtitle}</p>
      {trailing}
    </header>
  ),
}));

vi.mock("@/app/admin/_components/AdminPageData", () => ({
  AdminPageData: ({
    isError,
    errorMessage,
    error,
    children,
  }: {
    isError?: boolean;
    errorMessage?: string;
    error?: { message?: string | null } | null;
    children?: ReactNode;
  }) =>
    isError ? (
      <div data-testid="admin-page-data-error">
        {errorMessage}
        {error?.message}
      </div>
    ) : (
      <>{children}</>
    ),
}));

// Payments merged into this page (2026-10-05). The Stripe surfaces, the status
// strip and the schedule have their own suite (PayoutsView.stripe.test.tsx);
// here the account is fully connected and those pieces are inert markers, so
// this suite keeps pinning the statement's state machine.
vi.mock("@/hooks/useAdminOwnerCapabilities", () => ({
  useAdminOwnerCapabilities: () => ({
    canEdit: true,
    canManage: true,
    canFinance: true,
  }),
}));
vi.mock("../use-stripe-account", () => ({
  useStripeAccount: (owner: unknown) => ({
    owner,
    status: testState.stripeStatus,
    statusQuery: {
      isLoading: false,
      isFetching: false,
      error: null,
      refetch: vi.fn(),
    },
    meetsPayoutGate: true,
    stripeUnreachable: false,
    isFullyConnected: true,
    isOpeningDashboard: false,
    openStripeDashboard: vi.fn(),
  }),
}));
vi.mock("../StripeAccountSection", () => ({
  stripeSetupAtTop: () => false,
  stripeIncompleteAtTop: () => false,
  StripeIncompleteBanner: () => <div data-testid="stripe-incomplete-banner" />,
  StripeSetupCard: () => <div data-testid="stripe-setup-card" />,
  StripeSettingsRow: () => <div data-testid="stripe-account-section" />,
  StripeConnectionBadge: () => null,
  StripeStatusSkeleton: () => <div data-testid="stripe-status-skeleton" />,
}));
vi.mock("../PayoutScheduleSection", () => ({
  PayoutScheduleSection: () => <div data-testid="schedule-mock" />,
}));

// ── Fixtures ────────────────────────────────────────────────────────────────

const ASOF = new Date("2026-09-22T12:00:00.000Z");
const MATURES = new Date("2026-09-26T05:00:00.000Z");
const ORDER_ID = "order-00000000-0000-0000-0000-0000deadbeef";

const line = (over: Partial<OrgPayoutCreditLine>): OrgPayoutCreditLine => ({
  entryId: "entry-1",
  amountCents: 500,
  currency: "usd",
  availableAt: MATURES,
  createdAt: ASOF,
  orderId: ORDER_ID,
  orderCode: "DEADBEEF",
  eventId: "event-1",
  eventTitle: "Friday Show",
  eventSlug: "friday-show",
  eventStartsAt: new Date("2026-09-19T01:00:00.000Z"),
  ...over,
});

const tranche = (over: Partial<OrgPayoutTranche>): OrgPayoutTranche => ({
  maturesAt: MATURES,
  currency: "usd",
  creditCents: 1064,
  heldCents: 0,
  creditCount: 2,
  debtAppliedCents: 0,
  expectedCents: 1064,
  lines: [
    line({ entryId: "entry-1", amountCents: 500 }),
    line({ entryId: "entry-2", amountCents: 564 }),
  ],
  linesResolved: true,
  linesTruncated: false,
  ...over,
});

const overview = (
  over: Partial<GetOrgPayoutOverviewOutput> = {},
): GetOrgPayoutOverviewOutput => ({
  payeeId: "payee-1",
  currency: "usd",
  otherCurrencies: [],
  balanceCents: 1564,
  payableCents: 500,
  payableResolved: true,
  pendingHoldCents: 0,
  reserveCents: 0,
  payoutMinimumCents: 100,
  minimumResolved: true,
  belowMinimum: false,
  payoutOverdue: false,
  upcoming: [tranche({})],
  upcomingTruncated: false,
  upcomingTrancheCount: 1,
  upcomingCreditCents: 1064,
  upcomingExpectedCents: 1064,
  upcomingResolved: true,
  attributionResolved: true,
  recentPayouts: [],
  historyResolved: true,
  nextPayoutRun: { runAt: "2026-09-23T05:00:00.000Z", night: "2026-09-22" },
  asOf: ASOF,
  ...over,
});

const entry = (over: Partial<PayeeStatementEntry>): PayeeStatementEntry => ({
  id: "e-1",
  type: "SETTLEMENT_CREDIT",
  amountCents: 500,
  currency: "usd",
  description: "",
  createdAt: ASOF,
  availableAt: MATURES,
  orderId: null,
  balanceAfterCents: 1564,
  ...over,
});

const statement = (
  over: Partial<GetPayeeStatementOutput> = {},
): GetPayeeStatementOutput => ({
  payeeId: "payee-1",
  currency: "usd",
  balanceCents: 1564,
  payableCents: 500,
  pendingHoldCents: 0,
  reserveCents: 0,
  nextArrivalAt: MATURES,
  nextArrivalCents: 1064,
  arrivalResolved: true,
  payoutMinimumCents: 100,
  minimumResolved: true,
  belowMinimum: false,
  entries: [
    entry({ id: "e-1", amountCents: 564, balanceAfterCents: 1564 }),
    entry({
      id: "e-2",
      type: "PAYOUT",
      amountCents: 2000,
      availableAt: null,
      balanceAfterCents: 1000,
      description: "Nightly payout",
    }),
    // A hold repeats the balance above it (below it, in newest-first order):
    // it moves its own bucket, never the balance.
    entry({
      id: "e-3",
      type: "DISPUTE_HOLD",
      amountCents: 300,
      availableAt: null,
      balanceAfterCents: 3000,
      orderId: ORDER_ID,
    }),
    // The credit that opened the ledger: 0 → 3000.
    entry({ id: "e-4", amountCents: 3000, balanceAfterCents: 3000 }),
  ],
  hasMore: false,
  nextOffset: null,
  limit: 25,
  offset: 0,
  balanceAfterResolved: true,
  nextPayoutRun: { runAt: "2026-09-23T05:00:00.000Z", night: "2026-09-22" },
  asOf: ASOF,
  ...over,
});

/** The ledger shows the 5 newest; paging lives behind "Show all entries". */
const openLedger = () => fireEvent.click(screen.getByTestId("ledger-show-all"));

const changesOnPage = () =>
  screen.getAllByTestId("ledger-change").map((el) => el.textContent);
const balancesOnPage = () =>
  screen.getAllByTestId("ledger-balance").map((el) => el.textContent);

function arrangeOrg(
  overviewData: GetOrgPayoutOverviewOutput,
  firstPage: GetPayeeStatementOutput = statement(),
) {
  testState.owner = ORG_OWNER;
  testState.overview = ok(overviewData);
  testState.statementPages = { 0: ok(firstPage) };
}

describe("PayoutsView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.owner = null;
    testState.ownerLoading = false;
    testState.overview = {
      data: undefined,
      isLoading: false,
      isFetching: false,
      error: null,
      refetch: vi.fn(),
    };
    testState.overviewOptions = [];
    testState.statementPages = {};
    testState.statementInputs = [];
    testState.stripeStatus = {
      connected: true,
      chargesEnabled: true,
      payoutsEnabled: true,
    };
    testState.exportLedger = {
      mutate: vi.fn(),
      isPending: false,
      isError: false,
    };
    testState.downloadCsv = vi.fn();
  });

  it("healthy org: the answer, Owed beside it, the minimum as one line, Coming up and the ledger", () => {
    arrangeOrg(overview());
    render(<PayoutsView />);

    // The answer: what goes tonight, then what more by the last date. The
    // "more" is the server's expected sum (net of debt), dated by the last
    // tranche because the list is complete.
    const answer = screen.getByTestId("payout-answer");
    // A plain sentence, not a heading variant: nothing can uppercase it.
    // Its type is `.th-payout-answer` (sentence case, 800, frame-sized).
    expect(answer.tagName).toBe("P");
    expect(answer.className).toBe("th-payout-answer");
    expect(answer.getAttribute("style")).toBeNull();
    expect(answer.textContent).toBe(
      'admin.payoutsAnswerSends|{"amount":"$5.00"} ' +
        'admin.payoutsAnswerLaterBy|{"amount":"$10.64","date":"2026-09-26"}',
    );
    // Each amount is its own nowrap span; the words around them are not.
    expect(
      Array.from(answer.querySelectorAll(".th-payout-answer-amount")).map(
        (el) => el.textContent,
      ),
    ).toEqual(["$5.00", "$10.64"]);
    const send = screen.getByTestId("payout-send");
    expect(send.getAttribute("data-state")).toBe("sends");
    expect(send.textContent).toContain("admin.payoutsAnswerLabelTonight");
    // The caption names the night of the next batch run (owner ruling).
    expect(send.textContent).toContain(
      'admin.payoutsSendSubNight|{"date":"2026-09-22"}',
    );
    expect(screen.getByTestId("payout-owed-value").textContent).toBe("$15.64");
    // Ready now equals what we send: it is not repeated.
    expect(screen.queryByTestId("payout-ready")).toBeNull();
    // The figures are display SCALE, not headings.
    expect(screen.getByTestId("payout-owed-value").getAttribute("data-tag")).toBe("span");
    // No holds: the page says nothing about holds.
    expect(screen.queryByTestId("payout-withheld")).toBeNull();

    // Minimum: one fact line while clear — still on the page.
    const minimum = screen.getByTestId("payout-minimum");
    expect(minimum.getAttribute("data-state")).toBe("clear");
    expect(minimum.textContent).toBe(
      'admin.payoutsMinimumFactClear|{"minimum":"$1.00"}',
    );
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.queryByTestId("payout-overdue")).toBeNull();

    // No sum sentence above the dated list.
    expect(screen.queryByTestId("payout-reconciliation")).toBeNull();

    // Coming up: one tranche, gross on the date row, Next chip, and the two
    // credits for the same show folded into one line with an order count.
    // A real heading (h3 under the Balance h2), so e2e can find it by role.
    expect(
      screen.getByText("admin.payoutsComingUpHeading").getAttribute("data-tag"),
    ).toBe("h3");
    expect(screen.getByText("admin.payoutsNextChip")).toBeTruthy();
    expect(screen.getByTestId("payout-tranche-gross").textContent).toBe("$10.64");
    const lines = screen.getAllByTestId("payout-tranche-line");
    expect(lines).toHaveLength(1);
    expect(within(lines[0]!).getByText("Friday Show").closest("a")?.getAttribute("href")).toBe(
      "/events/friday-show",
    );
    expect(lines[0]!.textContent).toContain('"count":2');
    expect(screen.queryByText(/payoutsDebtCaption/)).toBeNull();
    expect(screen.queryByText(/payoutsHoldCaption/)).toBeNull();

    // Today line carries the balance; the ledger carries every row's balance.
    expect(screen.getByTestId("payouts-today").textContent).toContain(
      '"balance":"$15.64"',
    );
    expect(changesOnPage()).toEqual([
      "+$5.64",
      "−$20.00",
      "—",
      "+$30.00",
    ]);
    expect(balancesOnPage()).toEqual(["$15.64", "$10.00", "$30.00", "$30.00"]);
    // Once in the table cell, once in the phone card.
    const held = screen.getAllByText(/payoutsEntryHeld/);
    expect(held).toHaveLength(2);
    expect(held[0]!.textContent).toContain("DEADBEEF");
    // One heading — the page's section heading; the table no longer carries
    // its own — and the caption is a descriptor rather than a second one.
    // (The other "Ledger" on the page is the phone jump chip, a link.)
    const ledgerLabels = screen.getAllByText("admin.payoutsLedgerHeading");
    expect(
      ledgerLabels.filter((el) => el.getAttribute("data-tag") === "h2"),
    ).toHaveLength(1);
    expect(
      ledgerLabels.filter((el) => el.tagName !== "A" && el.getAttribute("data-tag") !== "h2"),
    ).toHaveLength(0);
    // The caption says only what the column heads don't: the order.
    expect(screen.getByText("admin.payoutsLedgerNewestFirst").tagName).toBe("CAPTION");
    // Four entries and nothing behind them: nothing to show all of.
    expect(screen.queryByTestId("ledger-show-all")).toBeNull();
    expect(screen.queryByTestId("ledger-load-more")).toBeNull();
    expect(screen.queryByTestId("ledger-more-not-shown")).toBeNull();
    expect(screen.queryByTestId("ledger-balances-unresolved")).toBeNull();

    // The phone layout carries the same Change · Balance per row.
    const cards = screen.getAllByTestId("ledger-card");
    expect(cards).toHaveLength(4);
    expect(
      screen.getAllByTestId("ledger-card-change").map((el) => el.textContent),
    ).toEqual(["+$5.64", "−$20.00", "—", "+$30.00"]);
    expect(
      screen.getAllByTestId("ledger-card-balance").map((el) => el.textContent),
    ).toEqual(["$15.64", "$10.00", "$30.00", "$30.00"]);
  });

  it("a seven-figure amount never breaks mid-number: it steps down the scale", () => {
    arrangeOrg(overview({ balanceCents: 123456789 }));
    render(<PayoutsView />);
    const owed = screen.getByTestId("payout-owed-value");
    expect(owed.textContent).toBe("$1,234,567.89");
    expect(owed.getAttribute("data-font-size")).toBe("$5");
  });

  it("nine characters or fewer keep the full h3 rung", () => {
    arrangeOrg(overview());
    render(<PayoutsView />);
    expect(screen.getByTestId("payout-owed-value").getAttribute("data-font-size")).toBe("$7");
  });

  it("the order code is not repeated when the description already carries it", () => {
    arrangeOrg(
      overview(),
      statement({
        entries: [
          entry({
            id: "e-1",
            description: "Ticket revenue — order deadbeef",
            orderId: ORDER_ID,
          }),
        ],
      }),
    );
    render(<PayoutsView />);
    const row = screen.getByTestId("ledger-row");
    expect(row.textContent).toContain("Ticket revenue");
    expect(row.textContent).not.toContain("payoutsEntryOrder");
  });

  it("reserve and dispute holds get their own line under the answer, never inside it", () => {
    arrangeOrg(overview({ reserveCents: 2500, pendingHoldCents: 300 }));
    render(<PayoutsView />);
    const withheld = screen.getByTestId("payout-withheld");
    expect(withheld.textContent).toContain('payoutsReserveHeld|{"amount":"$25.00"}');
    expect(withheld.textContent).toContain('payoutsDisputeHeld|{"amount":"$3.00"}');
    expect(screen.getByTestId("payout-owed-value").textContent).toBe("$15.64");
  });

  it("belowMinimum: amber state, a measured $0 tonight, and the plain explanation", () => {
    arrangeOrg(
      overview({ payableCents: 60, belowMinimum: true, balanceCents: 1124 }),
    );
    render(<PayoutsView />);

    // Ready now differs from what we send, so both are shown.
    expect(screen.getByTestId("payout-ready-value").textContent).toBe("$0.60");
    expect(screen.getByTestId("payout-answer").textContent).toContain(
      'admin.payoutsAnswerSendsNothing|{"amount":"$0.00"}',
    );
    expect(screen.getByTestId("payout-send").textContent).toContain(
      "admin.payoutsSendBelowReason",
    );
    expect(screen.getByTestId("payout-minimum").getAttribute("data-state")).toBe(
      "below",
    );
    expect(screen.getByTestId("payout-minimum-value").textContent).toContain(
      "payoutsMinimumOf|",
    );
    expect(screen.getByText(/payoutsBelowMinimumReadyNote/).textContent).toContain(
      '"minimum":"$1.00"',
    );
    expect(screen.queryByText("admin.payoutsCouldntCheck")).toBeNull();
    // The meter announces the formatted figures, not raw cents.
    const meter = screen.getByRole("meter");
    expect(meter.getAttribute("aria-valuetext")).toContain('"payable":"$0.60"');
    expect(meter.getAttribute("aria-valuemax")).toBe("100");
  });

  it("a null next run (a schedule core cannot name) falls back to the dateless caption", () => {
    arrangeOrg(overview({ nextPayoutRun: null }));
    render(<PayoutsView />);

    const send = screen.getByTestId("payout-send").textContent ?? "";
    expect(send).toContain("admin.payoutsSendSub");
    expect(send).not.toContain("admin.payoutsSendSubNight");
    expect(send).not.toContain("SendSubBlocked");
    // No named night, so no "tonight" anywhere: plain label, "the next run".
    expect(send).not.toContain("payoutsAnswerLabelTonight");
    expect(send).toContain("admin.payoutsSendLabel");
    const answer = screen.getByTestId("payout-answer").textContent ?? "";
    expect(answer).toContain('admin.payoutsAnswerNextRun|{"amount":"$5.00"}');
    expect(answer).not.toContain("payoutsAnswerSends");
    // The maturity clause is unaffected: it names a date, not a run.
    expect(answer).toContain("admin.payoutsAnswerLaterBy");
  });

  it("minimumResolved false: red Couldn't check chip, a blank value, the data stays", () => {
    arrangeOrg(
      overview({
        payoutMinimumCents: null,
        minimumResolved: false,
        belowMinimum: null,
        payoutOverdue: null,
      }),
    );
    render(<PayoutsView />);

    // The balance and the payable are untouched.
    expect(screen.getByTestId("payout-owed-value").textContent).toBe("$15.64");
    expect(screen.getByTestId("payout-ready-value").textContent).toBe("$5.00");
    // Tonight's verdict is blank, never a zero; off the accent fill.
    expect(screen.getByTestId("payout-answer").textContent).toBe(
      "admin.payoutsAnswerUnknown",
    );
    expect(screen.getByTestId("payout-send").getAttribute("data-state")).toBe(
      "unknown",
    );
    expect(screen.getByTestId("payout-send").textContent).toContain(
      "admin.payoutsCantSay",
    );
    const row = screen.getByTestId("payout-minimum");
    expect(row.getAttribute("data-state")).toBe("minimum-unresolved");
    expect(within(row).getByText("admin.payoutsCouldntCheck")).toBeTruthy();
    expect(screen.getByTestId("payout-minimum-value").textContent).toBe("—");
    expect(screen.getByText("admin.payoutsMinimumUnresolvedNote")).toBeTruthy();
    // No range to announce: the meter is decorative.
    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("payableResolved false cascades: red Ready dash, Can't say, gross only below", () => {
    arrangeOrg(
      overview({
        payableCents: null,
        payableResolved: false,
        belowMinimum: null,
        payoutOverdue: null,
        upcomingExpectedCents: null,
        upcoming: [
          tranche({ debtAppliedCents: null, expectedCents: null, heldCents: 200 }),
        ],
      }),
    );
    render(<PayoutsView />);

    expect(screen.getByTestId("payout-owed-value").textContent).toBe("$15.64");
    const ready = screen.getByTestId("payout-ready");
    expect(screen.getByTestId("payout-ready-value").textContent).toBe("—");
    expect(within(ready).getByText("admin.payoutsCouldntCheck")).toBeTruthy();
    expect(screen.getByTestId("payout-answer").textContent).toBe(
      "admin.payoutsAnswerUnknown",
    );

    const row = screen.getByTestId("payout-minimum");
    expect(row.getAttribute("data-state")).toBe("payable-unresolved");
    expect(screen.getByTestId("payout-minimum-value").textContent).toBe(
      "admin.payoutsCantSay",
    );
    expect(screen.getByText("admin.payoutsReadyUnresolvedNote")).toBeTruthy();

    // The tranche keeps its gross and its hold annotation; no net is claimed.
    expect(screen.getByTestId("payout-tranche-gross").textContent).toBe("$10.64");
    expect(screen.queryByText(/payoutsDebtCaption/)).toBeNull();
    expect(screen.getByText(/payoutsHoldCaption/).textContent).toContain(
      '"held":"$2.00"',
    );
    // No sum sentence in any state that has a full list.
    expect(screen.queryByTestId("payout-reconciliation")).toBeNull();
  });

  it("payoutOverdue true: a separate red row that says the money is still theirs", () => {
    arrangeOrg(overview({ payoutOverdue: true }));
    render(<PayoutsView />);

    const overdue = screen.getByTestId("payout-overdue");
    expect(within(overdue).getByText("admin.payoutsOverdueRow")).toBeTruthy();
    expect(within(overdue).getByText("admin.payoutsOverdueNote")).toBeTruthy();
    // The minimum row itself is still the ordinary clear state.
    expect(screen.getByTestId("payout-minimum").getAttribute("data-state")).toBe(
      "clear",
    );
  });

  it("debt caption names the refund taken and the expected net; truncation and failed lines are said", () => {
    arrangeOrg(
      overview({
        upcoming: [
          tranche({ debtAppliedCents: 300, expectedCents: 764 }),
          tranche({
            maturesAt: new Date("2026-10-03T05:00:00.000Z"),
            creditCents: 2000,
            creditCount: 30,
            lines: [],
            linesResolved: false,
          }),
          tranche({
            maturesAt: new Date("2026-10-10T05:00:00.000Z"),
            creditCents: 900,
            creditCount: 27,
            lines: [line({ entryId: "x" })],
            linesTruncated: true,
          }),
        ],
        upcomingTrancheCount: 3,
        balanceCents: 4464,
      }),
    );
    render(<PayoutsView />);

    const caption = screen.getByText(/payoutsDebtCaption/);
    expect(caption.textContent).toContain('"debt":"$3.00"');
    expect(caption.textContent).toContain('"expected":"$7.64"');
    expect(screen.getByText("admin.payoutsLinesUnresolved")).toBeTruthy();
    expect(screen.getByText(/payoutsLinesMore/).textContent).toContain(
      '"count":26',
    );
    // Only the first tranche is Next.
    expect(screen.getAllByText("admin.payoutsNextChip")).toHaveLength(1);
    // The dated list is the breakdown: no sum sentence repeats it.
    expect(screen.queryByTestId("payout-reconciliation")).toBeNull();
  });

  it("upcomingTruncated / upcomingResolved false never assert a sum", () => {
    arrangeOrg(
      overview({ upcomingTruncated: true, upcomingTrancheCount: 30 }),
    );
    const { unmount } = render(<PayoutsView />);
    expect(screen.getByTestId("payout-reconciliation").textContent).toContain(
      'payoutsReconcileTruncated|{"shown":1,"total":30}',
    );
    // A cut list's last row is not the last date: the amount, no date.
    expect(screen.getByTestId("payout-answer").textContent).toContain(
      'admin.payoutsAnswerLater|{"amount":"$10.64"}',
    );
    expect(screen.getByTestId("payout-answer").textContent).not.toContain(
      "LaterBy",
    );
    unmount();

    arrangeOrg(
      overview({
        upcoming: [],
        upcomingResolved: false,
        upcomingTrancheCount: null,
        upcomingCreditCents: null,
        upcomingExpectedCents: null,
      }),
    );
    render(<PayoutsView />);
    expect(screen.getByText("admin.payoutsReconcileUnresolved")).toBeTruthy();
    expect(screen.queryByTestId("payout-tranche")).toBeNull();
    // Nothing is known about later money, so the sentence claims none.
    expect(screen.getByTestId("payout-answer").textContent).toBe(
      'admin.payoutsAnswerSends|{"amount":"$5.00"}',
    );
  });

  it("no payee: not an error — one line in Balance and one in Ledger, no register, no link away", () => {
    arrangeOrg(
      overview({
        payeeId: null,
        balanceCents: 0,
        payableCents: 0,
        belowMinimum: null,
        payoutOverdue: null,
        upcoming: [],
        upcomingTrancheCount: 0,
        upcomingCreditCents: 0,
        upcomingExpectedCents: 0,
      }),
      statement({ payeeId: null, balanceCents: 0, payableCents: 0, entries: [] }),
    );
    render(<PayoutsView />);

    // Board B: Payments lives on this page now, so the old "Go to Payments"
    // prompt is gone; Balance and Ledger each say one plain line.
    expect(screen.getByTestId("payouts-no-payee").textContent).toBe(
      "admin.payoutsNothingYet",
    );
    expect(screen.getByTestId("payouts-ledger-nothing").textContent).toBe(
      "admin.payoutsLedgerEmpty",
    );
    // Exactly one plain line: no second "nothing yet" and no link beside it.
    expect(screen.getAllByText("admin.payoutsNothingYet")).toHaveLength(1);
    expect(screen.queryByTestId("payout-ledger")).toBeNull();
    expect(screen.queryByTestId("payout-panel")).toBeNull();
    expect(screen.queryByText("admin.payoutsCouldntCheck")).toBeNull();
    expect(screen.queryByTestId("payout-overdue")).toBeNull();
    expect(screen.queryByTestId("admin-page-data-error")).toBeNull();
  });

  it("Stripe can't receive payouts: on hold, $0 tonight, Ready now shown and waiting", () => {
    testState.stripeStatus = {
      connected: true,
      chargesEnabled: true,
      payoutsEnabled: false,
    };
    arrangeOrg(overview());
    render(<PayoutsView />);

    const send = screen.getByTestId("payout-send");
    expect(send.getAttribute("data-state")).toBe("on-hold");
    expect(send.textContent).toContain("admin.payoutsAnswerLabelOnHold");
    // Blocked is the whole caption: no date, no minimum reason.
    expect(send.textContent).toContain("admin.payoutsSendSubBlocked");
    expect(send.textContent).not.toContain("SendSubNight");
    // Nothing goes; what is ready waits. No "more by": nothing is sending.
    expect(screen.getByTestId("payout-answer").textContent).toBe(
      'admin.payoutsAnswerSendsNothing|{"amount":"$0.00"} ' +
        'admin.payoutsAnswerWaitingForStripe|{"amount":"$5.00"}',
    );
    expect(screen.getByTestId("payout-ready-value").textContent).toBe("$5.00");
    // The minimum is still a rule, and it is still clear.
    expect(screen.getByTestId("payout-minimum").getAttribute("data-state")).toBe(
      "clear",
    );
  });

  it("blocked with no named night: on hold, and the zero says 'the next run', not 'tonight'", () => {
    testState.stripeStatus = {
      connected: true,
      chargesEnabled: true,
      payoutsEnabled: false,
    };
    arrangeOrg(overview({ nextPayoutRun: null }));
    render(<PayoutsView />);
    expect(screen.getByTestId("payout-answer").textContent).toBe(
      'admin.payoutsAnswerNextRun|{"amount":"$0.00"} ' +
        'admin.payoutsAnswerWaitingForStripe|{"amount":"$5.00"}',
    );
  });

  it("unknown send with no named night: no 'tonight'", () => {
    arrangeOrg(
      overview({
        nextPayoutRun: null,
        payoutMinimumCents: null,
        minimumResolved: false,
        belowMinimum: null,
      }),
    );
    render(<PayoutsView />);
    expect(screen.getByTestId("payout-answer").textContent).toBe(
      "admin.payoutsAnswerUnknownNextRun",
    );
  });

  it("overdue with a cleared minimum: the fact line AND the incident row", () => {
    arrangeOrg(overview({ payoutOverdue: true }));
    render(<PayoutsView />);
    expect(screen.getByTestId("payout-minimum").textContent).toContain(
      "payoutsMinimumFactClear",
    );
    expect(screen.getByTestId("payout-overdue")).toBeTruthy();
  });

  it("ledger: the 5 newest, then Show all entries opens the full table (a disclosure)", () => {
    const seven = Array.from({ length: 7 }, (_, i) =>
      // amountCents deliberately off the balance movement (100): a change
      // derived from the type would read +$9.99, from the balances +$1.00.
      entry({ id: `e-${i}`, amountCents: 999, balanceAfterCents: 700 - i * 100 }),
    );
    arrangeOrg(overview(), statement({ entries: seven }));
    render(<PayoutsView />);

    expect(screen.getAllByTestId("ledger-row")).toHaveLength(5);
    // The 5th row's change reads the 6th row's balance even while folded.
    expect(changesOnPage()[4]).toBe("+$1.00");
    const toggle = screen.getByTestId("ledger-show-all");
    expect(toggle.textContent).toBe("admin.payoutsLedgerShowAll");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe("payouts-ledger-table");

    fireEvent.click(toggle);
    expect(screen.getAllByTestId("ledger-row")).toHaveLength(7);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toBe("admin.payoutsLedgerShowFewer");

    fireEvent.click(toggle);
    expect(screen.getAllByTestId("ledger-row")).toHaveLength(5);
  });

  it("other currencies are disclosed, never summed", () => {
    arrangeOrg(overview({ otherCurrencies: ["cad", "eur"] }));
    render(<PayoutsView />);
    expect(screen.getByTestId("payouts-other-currencies").textContent).toContain(
      '"count":2',
    );
  });

  it("ledger: null balances render a dash with the muted notice; Load more appends the next page", () => {
    testState.owner = ORG_OWNER;
    testState.overview = ok(overview());
    testState.statementPages = {
      0: ok(
        statement({
          entries: [
            entry({ id: "e-1", balanceAfterCents: null }),
            entry({
              id: "e-2",
              type: "REFUND_DEBIT",
              amountCents: 250,
              balanceAfterCents: null,
            }),
          ],
          balanceAfterResolved: false,
          hasMore: true,
          nextOffset: 25,
        }),
      ),
    };
    render(<PayoutsView />);

    expect(screen.getByTestId("ledger-balances-unresolved")).toBeTruthy();
    expect(balancesOnPage()).toEqual(["—", "—"]);
    // With no balance movement to read, the type supplies the direction.
    expect(changesOnPage()).toEqual(["+$5.00", "−$2.50"]);

    // Load more: the second page is requested at the server's nextOffset and
    // its rows land UNDER the first page's — nothing is replaced.
    testState.statementPages[25] = ok(
      statement({
        offset: 25,
        entries: [
          entry({
            id: "e-3",
            type: "PAYOUT",
            amountCents: 900,
            balanceAfterCents: 100,
          }),
        ],
        hasMore: false,
        nextOffset: null,
        balanceAfterResolved: true,
      }),
    );
    openLedger();
    fireEvent.click(screen.getByTestId("ledger-load-more"));

    expect(screen.getAllByTestId("ledger-row")).toHaveLength(3);
    expect(
      testState.statementInputs.some(
        (input) => (input as { offset: number }).offset === 25,
      ),
    ).toBe(true);
    // Any unresolved page keeps the notice up; the button goes once the last
    // page says there is no more.
    expect(screen.getByTestId("ledger-balances-unresolved")).toBeTruthy();
    expect(screen.queryByTestId("ledger-load-more")).toBeNull();
  });

  it("a page still in flight counts as 'more behind': the oldest visible row does not read the opening zero", () => {
    arrangeOrg(
      overview(),
      statement({
        entries: [entry({ id: "e-1", amountCents: 500, balanceAfterCents: 1564 })],
        hasMore: true,
        nextOffset: 25,
      }),
    );
    render(<PayoutsView />);
    // Page 0 alone: e-1 is the oldest LOADED row with a page behind it, so its
    // movement is unknown and the type supplies "+$5.00".
    expect(changesOnPage()).toEqual(["+$5.00"]);

    // Click with page 25 ABSENT: the request is in flight. `hasMore` must not
    // flip false, or e-1's older balance becomes 0 and it renders "+$15.64".
    openLedger();
    fireEvent.click(screen.getByTestId("ledger-load-more"));
    expect(changesOnPage()).toEqual(["+$5.00"]);
    expect(screen.getAllByTestId("ledger-row")).toHaveLength(1);
    // The button yields to its spinner while the page is pending — it is not
    // a second no-op click.
    const button = screen.getByTestId("ledger-load-more") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("at the server's offset cap the button does not render as a no-op; a caption says more exists", () => {
    arrangeOrg(
      overview(),
      statement({ hasMore: true, nextOffset: null }),
    );
    render(<PayoutsView />);
    // Folded, there is nothing to page: neither the button nor the caption.
    expect(screen.queryByTestId("ledger-more-not-shown")).toBeNull();
    openLedger();
    expect(screen.queryByTestId("ledger-load-more")).toBeNull();
    expect(screen.getByTestId("ledger-more-not-shown")).toBeTruthy();
    // Rows exist behind the last one, so its movement stays type-derived.
    expect(changesOnPage()[3]).toBe("+$30.00");
  });

  it("a row that appears on two pages after a refetch renders once", () => {
    arrangeOrg(
      overview(),
      statement({
        entries: [
          entry({ id: "e-1", balanceAfterCents: 1564 }),
          entry({ id: "e-2", type: "PAYOUT", amountCents: 100, balanceAfterCents: 1064 }),
        ],
        hasMore: true,
        nextOffset: 25,
      }),
    );
    testState.statementPages[25] = ok(
      statement({
        offset: 25,
        entries: [
          // The row that was at index 24 before a new credit pushed it down.
          entry({ id: "e-2", type: "PAYOUT", amountCents: 100, balanceAfterCents: 1064 }),
          entry({ id: "e-3", amountCents: 1164, balanceAfterCents: 1164 }),
        ],
        hasMore: false,
        nextOffset: null,
      }),
    );
    render(<PayoutsView />);
    openLedger();
    fireEvent.click(screen.getByTestId("ledger-load-more"));
    expect(
      screen.getAllByTestId("ledger-row").map((row) => row.textContent),
    ).toHaveLength(3);
    expect(changesOnPage()).toEqual(["+$5.00", "−$1.00", "+$11.64"]);
  });

  it("a later page that FAILED: the seam row stays type-derived, the error shows, and the button retries that page", () => {
    const refetch25 = vi.fn();
    arrangeOrg(
      overview(),
      statement({
        entries: [entry({ id: "e-1", amountCents: 500, balanceAfterCents: 1564 })],
        hasMore: true,
        nextOffset: 25,
      }),
    );
    testState.statementPages[25] = {
      data: undefined,
      isLoading: false,
      isFetching: false,
      error: new Error("boom"),
      refetch: refetch25,
    };
    render(<PayoutsView />);
    openLedger();
    fireEvent.click(screen.getByTestId("ledger-load-more"));

    // Page 25 failed: rows are behind e-1, so its older balance is unknown
    // and the type supplies the direction — never the opening-zero "+$15.64".
    expect(changesOnPage()).toEqual(["+$5.00"]);
    expect(screen.getByText("boom")).toBeTruthy();
    const button = screen.getByTestId("ledger-load-more") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(refetch25).toHaveBeenCalledTimes(1);
    expect(
      testState.statementInputs.some(
        (input) => (input as { offset: number }).offset === 50,
      ),
    ).toBe(false);
  });

  it("first paint with the overview in and page 0 still loading: placeholder, DataTable not mounted", () => {
    testState.owner = ORG_OWNER;
    testState.overview = ok(overview());
    testState.statementPages = {};
    render(<PayoutsView />);

    // The register and breakdown are up (the overview resolved)…
    expect(screen.getByTestId("payout-owed-value").textContent).toBe("$15.64");
    expect(screen.getByTestId("payout-breakdown")).toBeTruthy();
    // …and the ledger is LedgerTable's OWN placeholder. DataTable is not
    // mounted at all — the real component shows its empty state for 200 ms
    // before its delayed skeleton, and that is what this avoids. (The mock
    // proves the branch, not the real component's timing.)
    expect(screen.getByTestId("ledger-skeleton")).toBeTruthy();
    expect(screen.queryByTestId("ledger-datatable")).toBeNull();
    expect(screen.queryByText("admin.payoutsLedgerEmpty")).toBeNull();
    expect(screen.queryByTestId("ledger-more-not-shown")).toBeNull();
    expect(screen.queryByTestId("ledger-load-more")).toBeNull();
    expect(screen.queryByTestId("ledger-unavailable")).toBeNull();
  });

  it("a seam whose older page is STALER than the page above it is not read as adjacent; an overlap confirms it", () => {
    // Every amount differs from the row's balance MOVEMENT, so a type-derived
    // figure and a movement-derived one are distinguishable on every row —
    // which is what makes an off-by-one in the seam index fail loudly.
    const page0 = statement({
      entries: [
        // movement +1.00 (1664 − 1564); type would say +2.50
        entry({ id: "e-0", amountCents: 250, balanceAfterCents: 1664 }),
        // the seam row: movement to a stale e-3 would say +5.00; type says +3.00
        entry({ id: "e-1", type: "DISPUTE_RELEASE", amountCents: 300, balanceAfterCents: 1564 }),
      ],
      hasMore: true,
      nextOffset: 25,
    });
    // Page 25 fetched BEFORE page 0's refetch, with no overlap: e-1's old
    // last row may have slid into a gap. Without the guard e-1 would read
    // 1564 − 1064 = "+$5.00" — a two-row movement dressed as one.
    const stalePage25 = statement({
      offset: 25,
      // movement +10.64 (1064 − opening 0); type would say +9.00
      entries: [entry({ id: "e-3", amountCents: 900, balanceAfterCents: 1064 })],
      hasMore: false,
      nextOffset: null,
    });
    testState.owner = ORG_OWNER;
    testState.overview = ok(overview());
    testState.statementPages = {
      0: { ...ok(page0), dataUpdatedAt: 200 },
      25: { ...ok(stalePage25), dataUpdatedAt: 100 },
    };
    const { unmount } = render(<PayoutsView />);
    openLedger();
    fireEvent.click(screen.getByTestId("ledger-load-more"));
    // Only e-1 (index 1, directly above the seam) falls back to its type.
    // e-0 above it and e-3 below it keep their exact movements — a flag on
    // index 0 would read "+$2.50", on index 2 "+$9.00".
    expect(changesOnPage()).toEqual(["+$1.00", "+$3.00", "+$10.64"]);
    unmount();

    // The same stale page, but it OVERLAPS (carries e-1 too): contiguity is
    // proven, so e-1's movement is read exactly — and it is zero, because a
    // hold-release moves no balance.
    testState.statementPages[25] = {
      ...ok(
        statement({
          offset: 25,
          entries: [
            entry({ id: "e-1", type: "DISPUTE_RELEASE", amountCents: 300, balanceAfterCents: 1564 }),
            // movement +15.64 (1564 − opening 0); type would say +9.00
            entry({ id: "e-3", amountCents: 900, balanceAfterCents: 1564 }),
          ],
          hasMore: false,
          nextOffset: null,
        }),
      ),
      dataUpdatedAt: 100,
    };
    render(<PayoutsView />);
    openLedger();
    fireEvent.click(screen.getByTestId("ledger-load-more"));
    expect(changesOnPage()).toEqual(["+$1.00", "—", "+$15.64"]);
  });

  it("a failed REFRESH of page 0 keeps the rows and shows the reason above them with a retry", () => {
    const refetch = vi.fn();
    testState.owner = ORG_OWNER;
    testState.overview = ok(overview());
    // React Query retains the last result and sets `error` on a failed
    // refetch — both at once.
    testState.statementPages = {
      0: {
        data: statement(),
        isLoading: false,
        isFetching: false,
        error: new Error("refresh failed"),
        refetch,
      },
    };
    render(<PayoutsView />);

    expect(screen.getAllByTestId("ledger-row")).toHaveLength(4);
    expect(screen.queryByTestId("ledger-unavailable")).toBeNull();
    expect(screen.queryByTestId("ledger-skeleton")).toBeNull();
    const line = screen.getByTestId("ledger-refresh-error");
    expect(line.textContent).toContain("admin.payoutsLedgerStale");
    expect(line.textContent).toContain("refresh failed");
    fireEvent.click(within(line).getByText("admin.retry"));
    expect(refetch).toHaveBeenCalled();
  });

  it("org path: a statement failure takes down only the ledger, with a retry in its place", () => {
    const refetch = vi.fn();
    testState.owner = ORG_OWNER;
    testState.overview = ok(overview());
    testState.statementPages = {
      0: {
        data: undefined,
        isLoading: false,
        isFetching: false,
        error: new Error("statement timed out"),
        refetch,
      },
    };
    render(<PayoutsView />);

    // The register and the breakdown the overview already resolved stay up.
    expect(screen.getByTestId("payout-owed-value").textContent).toBe("$15.64");
    expect(screen.getByTestId("payout-breakdown")).toBeTruthy();
    expect(screen.queryByTestId("admin-page-data-error")).toBeNull();
    const unavailable = screen.getByTestId("ledger-unavailable");
    expect(within(unavailable).getByText("admin.payoutsLedgerUnavailable")).toBeTruthy();
    expect(unavailable.textContent).toContain("statement timed out");
    expect(screen.queryByTestId("payout-ledger")).toBeNull();
    fireEvent.click(within(unavailable).getByText("admin.retry"));
    expect(refetch).toHaveBeenCalled();
  });

  it("human owner: register from the statement, no breakdown, the ledger still renders, no overview asked", () => {
    testState.owner = HUMAN_OWNER;
    testState.statementPages = { 0: ok(statement()) };
    render(<PayoutsView />);

    expect(screen.getByTestId("payout-owed-value").textContent).toBe("$15.64");
    // The statement carries no maturity feed in the overview's shape: the
    // answer names tonight only, never an invented "more by".
    expect(screen.getByTestId("payout-answer").textContent).toBe(
      'admin.payoutsAnswerSends|{"amount":"$5.00"}',
    );
    expect(screen.queryByTestId("payout-ready")).toBeNull();
    expect(screen.queryByTestId("payout-breakdown")).toBeNull();
    const note = screen.getByTestId("payouts-human-note");
    // One line: the forecast. No sentence about what the page lacks.
    expect(note.children).toHaveLength(1);
    expect(within(note).getByText(/payoutsHumanNextArrival/).textContent).toContain(
      '"amount":"$10.64"',
    );
    expect(screen.getAllByTestId("ledger-row")).toHaveLength(4);
    // No overdue verdict exists on the statement: no incident row, ever.
    expect(screen.queryByTestId("payout-overdue")).toBeNull();
    // The human path asks for its OWN payee — no orgId on the input — and
    // never for the org-only overview.
    expect(testState.statementInputs[0]).toEqual({ limit: 25, offset: 0 });
    expect(testState.overviewOptions.length).toBeGreaterThan(0);
    expect(testState.overviewOptions.every((o) => o.enabled === false)).toBe(true);
  });

  it("human owner: a statement failure is Balance's failure; the Stripe and schedule sections stay", () => {
    testState.owner = HUMAN_OWNER;
    testState.statementPages = {
      0: { ...PENDING, isLoading: false, isFetching: false, error: new Error("nope") },
    };
    render(<PayoutsView />);
    expect(
      within(screen.getByTestId("payouts-section-balance")).getByTestId(
        "admin-page-data-error",
      ).textContent,
    ).toContain("nope");
    expect(screen.queryByTestId("payout-panel")).toBeNull();
    expect(screen.getByTestId("stripe-account-section")).toBeTruthy();
    expect(screen.getByTestId("schedule-mock")).toBeTruthy();
  });

  it("loading shows the skeleton; a failed overview shows the error with retry", () => {
    testState.owner = ORG_OWNER;
    testState.overview = { ...testState.overview, isLoading: true };
    const { unmount } = render(<PayoutsView />);
    expect(screen.getByTestId("payouts-skeleton")).toBeTruthy();
    unmount();

    const refetch = vi.fn();
    testState.overview = {
      data: undefined,
      isLoading: false,
      isFetching: false,
      error: new Error("ledger timed out"),
      refetch,
    };
    testState.statementPages = { 0: ok(statement()) };
    render(<PayoutsView />);
    // Balance carries the failure; the setup an owner may still need to
    // finish (Stripe account) is not taken down with it.
    expect(
      within(screen.getByTestId("payouts-section-balance")).getByTestId(
        "admin-page-data-error",
      ).textContent,
    ).toContain("ledger timed out");
    expect(screen.getByTestId("stripe-account-section")).toBeTruthy();
    fireEvent.click(screen.getByText("admin.retry"));
    expect(refetch).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The ledger download (spec 2026-10-14 payouts-ledger-export, FR-009): a
// button beside the Ledger heading whenever the section shows a ledger, a
// mutation (never a query), a busy state, and an inline failure line.
// ─────────────────────────────────────────────────────────────────────────────

describe("PayoutsView ledger download", () => {
  type MutateOptions = {
    onSuccess?: (result: unknown) => void;
    onSettled?: () => void;
  };
  const mutateCall = (index = 0) =>
    vi.mocked(testState.exportLedger.mutate).mock.calls[index] as [
      unknown,
      MutateOptions,
    ];

  beforeEach(() => {
    vi.clearAllMocks();
    testState.owner = null;
    testState.ownerLoading = false;
    testState.overviewOptions = [];
    testState.statementPages = {};
    testState.statementInputs = [];
    testState.exportLedger = { mutate: vi.fn(), isPending: false, isError: false };
    testState.downloadCsv = vi.fn();
    testState.exportLedgerFn = null;
    testState.captureException = vi.fn();
  });

  it("org path: the button sits in the Ledger header and exports with the orgId", () => {
    arrangeOrg(overview());
    render(<PayoutsView />);

    const ledger = screen.getByTestId("payouts-section-ledger");
    const button = within(ledger).getByTestId("ledger-download-csv");
    expect(button.textContent).toBe("admin.payoutsLedgerDownloadCsv");
    expect((button as HTMLButtonElement).disabled).toBe(false);
    // One download control on the page.
    expect(screen.getAllByText("admin.payoutsLedgerDownloadCsv")).toHaveLength(1);

    fireEvent.click(button);
    expect(testState.exportLedger.mutate).toHaveBeenCalledTimes(1);
    expect(mutateCall()[0]).toEqual({ orgId: "org-1" });

    // A second press before the first settles is refused.
    fireEvent.click(button);
    expect(testState.exportLedger.mutate).toHaveBeenCalledTimes(1);

    // Success builds the file and names it after the slug and today.
    mutateCall()[1].onSuccess?.({
      payeeId: "payee-1",
      asOf: ASOF,
      rows: [],
    });
    expect(testState.downloadCsv).toHaveBeenCalledTimes(1);
    const [csv, filename] = vi.mocked(testState.downloadCsv).mock.calls[0]!;
    expect(csv).toBe(
      [
        "admin.payoutsLedgerCsvColDate",
        "admin.payoutsLedgerCsvColType",
        "admin.payoutsLedgerCsvColDescription",
        "admin.payoutsLedgerCsvColOrder",
        "admin.payoutsLedgerCsvColEvent",
        "admin.payoutsLedgerCsvColAmount",
        "admin.payoutsLedgerCsvColChange",
        "admin.payoutsLedgerCsvColBalanceAfter",
        "admin.payoutsLedgerCsvColAvailableFrom",
        "admin.payoutsLedgerCsvColCurrency",
      ].join(","),
    );
    expect(filename).toMatch(/^ledger-demo-\d{4}-\d{2}-\d{2}\.csv$/);

    // Settled: the next press goes through.
    mutateCall()[1].onSettled?.();
    fireEvent.click(button);
    expect(testState.exportLedger.mutate).toHaveBeenCalledTimes(2);
  });

  it("human path: exports with no input", () => {
    testState.owner = HUMAN_OWNER;
    testState.statementPages = { 0: ok(statement()) };
    render(<PayoutsView />);

    fireEvent.click(screen.getByTestId("ledger-download-csv"));
    expect(mutateCall()[0]).toBeUndefined();
  });

  it("an empty ledger still offers the download", () => {
    arrangeOrg(overview(), statement({ entries: [] }));
    render(<PayoutsView />);
    expect(screen.getByTestId("ledger-download-csv")).toBeTruthy();
  });

  it("busy: disabled and says it is preparing", () => {
    testState.exportLedger = { mutate: vi.fn(), isPending: true, isError: false };
    arrangeOrg(overview());
    render(<PayoutsView />);

    const button = screen.getByTestId("ledger-download-csv") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("admin.payoutsLedgerDownloadPreparing");
  });

  it("failed: an inline line under the header, and the button stays to retry", () => {
    testState.exportLedger = { mutate: vi.fn(), isPending: false, isError: true };
    arrangeOrg(overview());
    render(<PayoutsView />);

    const failed = screen.getByTestId("ledger-download-failed");
    expect(failed.textContent).toBe("admin.payoutsLedgerDownloadFailed");
    expect(failed.getAttribute("role")).toBe("alert");
    const button = screen.getByTestId("ledger-download-csv") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(testState.exportLedger.mutate).toHaveBeenCalledTimes(1);
  });

  it("no button while the ledger's first page is in flight", () => {
    testState.owner = ORG_OWNER;
    testState.overview = ok(overview());
    testState.statementPages = {};
    render(<PayoutsView />);
    expect(screen.queryByTestId("ledger-download-csv")).toBeNull();
  });

  it("no button on the no-payee line", () => {
    arrangeOrg(
      overview({ payeeId: null, balanceCents: 0, payableCents: 0, upcoming: [] }),
      statement({ payeeId: null, balanceCents: 0, payableCents: 0, entries: [] }),
    );
    render(<PayoutsView />);
    expect(screen.getByTestId("payouts-ledger-nothing")).toBeTruthy();
    expect(screen.queryByTestId("ledger-download-csv")).toBeNull();
  });

  it("no button when the statement failed", () => {
    testState.owner = ORG_OWNER;
    testState.overview = ok(overview());
    testState.statementPages = {
      0: {
        data: undefined,
        isLoading: false,
        isFetching: false,
        error: new Error("statement timed out"),
        refetch: vi.fn(),
      },
    };
    render(<PayoutsView />);
    expect(screen.getByTestId("ledger-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("ledger-download-csv")).toBeNull();
  });
});

describe("PayoutsView ledger download, real mutation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.owner = null;
    testState.ownerLoading = false;
    testState.statementPages = {};
    testState.statementInputs = [];
    testState.downloadCsv = vi.fn();
    testState.captureException = vi.fn();
    testState.exportLedgerFn = null;
  });

  it("a file that fails to build is reported to Sentry and shows the inline alert", async () => {
    const boom = new Error("blob failed");
    testState.downloadCsv = vi.fn(() => {
      throw boom;
    });
    testState.exportLedgerFn = vi.fn(() =>
      Promise.resolve({ payeeId: "payee-1", asOf: ASOF, rows: [] }),
    );
    arrangeOrg(overview());
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <PayoutsView />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByTestId("ledger-download-csv"));

    const failed = await screen.findByTestId("ledger-download-failed");
    expect(failed.getAttribute("role")).toBe("alert");
    expect(testState.captureException).toHaveBeenCalledWith(boom, {
      tags: { feature: "payouts-ledger-export" },
    });
    // The in-flight guard was released: a retry goes through.
    const button = screen.getByTestId("ledger-download-csv") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await vi.waitFor(() => expect(testState.exportLedgerFn).toHaveBeenCalledTimes(2));
  });
});
