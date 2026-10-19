import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@th/trpc";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Section tests for the two payout halves of /platform/settlements.
 * `@th/ui` and tamagui are mocked to bare DOM so the assertions are about
 * THESE surfaces: that payable and total-owed render as two separate
 * figures, that gross/net/deductions add up on screen, that the status
 * filter re-queries and voids the cursor chain, and that the two empty
 * states say different things.
 *
 * What these tests CANNOT see, by construction, is anything about how the
 * components sit among their neighbours — contrast against a real theme
 * surface, column width pressure, overflow. Both of those bit this diff and
 * were caught by driving the page, not here.
 */

const testState = vi.hoisted(() => ({
  payable: null as unknown,
  payableLoading: false,
  payableError: null as unknown,
  history: null as unknown,
  historyLoading: false,
  historyError: null as unknown,
  dataUpdatedAt: 1,
  historyFetch: vi.fn(),
  historyRefetch: vi.fn(),
  lastHistoryInput: null as unknown,
  isMobile: false,
  // "Payouts owed" gained an "Expected next" column, which reads the SAME
  // upcoming query the sibling section renders (one query key, one request).
  // Defaults to a resolved-but-empty answer so every existing case keeps
  // exercising what it was written for; the cases that care set it.
  upcoming: {
    items: [],
    byDate: [],
    nextByPayee: [] as Array<{
      payeeId: string;
      currency: string;
      maturesAt: Date;
      nextTrancheCents: number | null;
      creditCents: number;
      heldCents: number;
      debtAppliedCents: number | null;
    }>,
    currencyTotals: [],
    total: 0,
    truncated: false,
    rowLimit: 200,
    debtResolved: true,
  } as unknown,
  upcomingLoading: false,
  upcomingError: null as unknown,
  // "Platform revenue" — the other book. Null data = nothing loaded, which
  // the section renders as its empty state once `revenueLoading` is false.
  revenue: null as unknown,
  revenueLoading: false,
  revenueError: null as unknown,
  revenueRefetch: vi.fn(),
}));

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({
    children,
    tag,
    ...rest
  }: {
    children?: ReactNode;
    tag?: string;
    [key: string]: unknown;
  }) => {
    const domProps: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) {
      if (k.startsWith("aria-") || k === "role" || k === "id") domProps[k] = v;
    }
    return React.createElement(tag ?? "div", domProps, children);
  };
  return { XStack: Stack, YStack: Stack, Stack, styled: () => Stack };
});

vi.mock("@th/ui", () => {
  const Text = ({
    children,
    tone,
    color,
    tag,
    id,
    role,
  }: {
    children?: ReactNode;
    tone?: string;
    color?: string;
    tag?: string;
    id?: string;
    role?: string;
  }) => {
    const Tag = (tag ?? "span") as "span";
    return (
      <Tag data-tone={tone} data-color={color} id={id} role={role}>
        {children}
      </Tag>
    );
  };
  const MoneyComponent = ({
    cents,
    currency,
    tag,
    tone,
  }: {
    cents: number;
    currency?: string;
    tag?: string;
    // Carried through so a test can assert what a figure is NOT styled as —
    // a negative net kept must not arrive wearing the error tone.
    tone?: string;
  }) => {
    const Tag = (tag ?? "span") as "span";
    return (
      <Tag
        data-money={`${currency}:${cents}`}
        data-tone={tone}
      >{`${currency}:${cents}`}</Tag>
    );
  };
  // `Money.format` is the string form the tranche-netting caption feeds into
  // an ICU message ("of {credit} credit"); same shape as the rendered form so
  // an assertion can read both the same way.
  const Money = Object.assign(MoneyComponent, {
    format: (cents: number, opts: { currency: string }) =>
      `${opts.currency}:${cents}`,
  });
  const DateTime = ({
    value,
    timeZone,
    format,
  }: {
    value: Date | string | number;
    timeZone: string;
    format?: string;
  }) => (
    <time data-tz={timeZone} data-format={format ?? "datetime"}>
      {new Date(value).toISOString()}
    </time>
  );
  return {
    Text,
    Money,
    DateTime,
    Badge: ({ children, tone }: { children?: ReactNode; tone?: string }) => (
      <span data-tone={tone} data-testid="payout-badge">
        {children}
      </span>
    ),
    Button: ({
      children,
      onPress,
      disabled,
      "aria-pressed": ariaPressed,
    }: {
      children?: ReactNode;
      onPress?: () => void;
      disabled?: boolean;
      "aria-pressed"?: boolean;
    }) => (
      <button type="button" onClick={onPress} disabled={disabled} aria-pressed={ariaPressed}>
        {children}
      </button>
    ),
    NextLinkAnchor: ({
      href,
      children,
      "aria-label": ariaLabel,
    }: {
      href: string;
      children?: ReactNode;
      "aria-label"?: string;
    }) => (
      <a href={href} aria-label={ariaLabel}>
        {children}
      </a>
    ),
    DataTable: ({
      columns,
      rows,
      getRowKey,
      emptyState,
      isLoading,
      renderMobileCard,
      caption,
    }: {
      columns: Array<{
        id: string;
        header: ReactNode;
        cell: (row: unknown) => ReactNode;
      }>;
      rows: unknown[];
      getRowKey: (row: unknown, i: number) => string;
      emptyState?: ReactNode;
      isLoading?: boolean;
      renderMobileCard?: (row: unknown) => ReactNode;
      caption?: string;
    }) =>
      testState.isMobile ? (
        <div data-testid={`cards:${caption}`}>
          {rows.map((row, i) => (
            <div key={getRowKey(row, i)} data-testid={`card-${getRowKey(row, i)}`}>
              {renderMobileCard?.(row)}
            </div>
          ))}
        </div>
      ) : (
        <table data-testid={`table:${caption}`} data-loading={isLoading ? "1" : "0"}>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.id}>{c.header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td>{emptyState}</td>
              </tr>
            ) : (
              rows.map((row, i) => (
                <tr key={getRowKey(row, i)} data-testid={`row-${getRowKey(row, i)}`}>
                  {columns.map((c) => (
                    <td key={c.id} data-col={c.id}>
                      {c.cell(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      ),
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
    useFormatters: () => ({
      dateTime: (d: Date) => d.toISOString(),
      currency: (n: number) => String(n),
    }),
  };
});

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      platform: { listPayoutHistory: { fetch: testState.historyFetch } },
    }),
    platform: {
      listPayablePositions: {
        useQuery: () => ({
          data: testState.payable,
          isLoading: testState.payableLoading,
          isError: Boolean(testState.payableError),
          error: testState.payableError,
          refetch: vi.fn(),
          isFetching: false,
        }),
      },
      listPayoutHistory: {
        useQuery: (input: unknown) => {
          testState.lastHistoryInput = input;
          return {
            data: testState.history,
            isLoading: testState.historyLoading,
            isError: Boolean(testState.historyError),
            error: testState.historyError,
            dataUpdatedAt: testState.dataUpdatedAt,
            refetch: testState.historyRefetch,
            isFetching: false,
          };
        },
      },
      listUpcomingPayouts: {
        useQuery: () => ({
          data: testState.upcoming,
          isLoading: testState.upcomingLoading,
          isError: Boolean(testState.upcomingError),
          error: testState.upcomingError,
          refetch: vi.fn(),
          isFetching: false,
        }),
      },
      getPlatformRevenue: {
        useQuery: () => ({
          data: testState.revenue,
          isLoading: testState.revenueLoading,
          isError: Boolean(testState.revenueError),
          error: testState.revenueError,
          refetch: testState.revenueRefetch,
          isFetching: false,
        }),
      },
    },
  },
}));

vi.mock("@/lib/format", () => ({
  truncateId: (id: string) => (id.length > 8 ? `${id.slice(0, 8)}...` : id),
  truncateProviderId: (id: string) => `prov:${id}`,
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
}));

vi.mock("@/lib/app-error", () => ({
  getAppErrorCode: (err: unknown) =>
    (err as { data?: { appCode?: string } })?.data?.appCode ?? null,
}));

import { PayoutsOwedSection } from "../PayoutsOwedSection";
import { UpcomingPayoutsSection } from "../UpcomingPayoutsSection";
import { PayoutsSentSection } from "../PayoutsSentSection";
import { PlatformRevenueSection } from "../PlatformRevenueSection";
import { payoutOwnerHref, payoutOwnerName } from "../PayoutOwner";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const HUMAN_ID = "22222222-2222-4222-8222-222222222222";

const PAYABLE_PAGE = {
  items: [
    {
      payeeId: "payee-org",
      subjectType: "ORGANIZATION" as const,
      subjectId: ORG_ID,
      ownerLabel: "DRKMTTR",
      ownerSlug: "drkmttr",
      currency: "usd",
      payableCents: 167_200,
      oldestMaturedAt: "2026-09-09T00:00:00.000Z",
      belowMinimum: false,
      ineligibleReason: null,
      identityResolved: true,
    },
    {
      payeeId: "payee-human",
      subjectType: "HUMAN" as const,
      subjectId: HUMAN_ID,
      ownerLabel: "Sole Artist",
      ownerSlug: null,
      currency: "usd",
      payableCents: 38_625,
      oldestMaturedAt: null,
      belowMinimum: false,
      ineligibleReason: null,
      identityResolved: true,
    },
  ],
  total: 2,
  truncated: false,
  rowLimit: 200,
  payableTotals: [{ currency: "usd", payableCents: 205_825, cellCount: 2 }],
  liabilityTotals: [
    {
      currency: "usd",
      unpaidCreditsCents: 521_875,
      reserveHeldCents: 0,
      pendingHoldCents: 0,
      totalOwedCents: 521_875,
    },
  ],
  payoutMinimumCents: 1_000,
  minimumResolved: true,
  asOf: "2026-09-11T00:00:00.000Z",
};

const SENT_ROW = {
  id: "item-1",
  payoutId: "payout-1",
  payeeId: "payee-org",
  subjectType: "ORGANIZATION" as const,
  subjectId: ORG_ID,
  ownerLabel: "DRKMTTR",
  ownerSlug: "drkmttr",
  currency: "usd",
  amountCents: 68_000,
  netCents: 61_000,
  connectAccountFeeCents: 200,
  recoveredDebtCents: 0,
  reserveHeldCents: 6_800,
  reserveReleasedCents: 0,
  status: "transferred" as const,
  occurredAt: "2026-09-02T06:00:00.000Z",
  transferredAt: "2026-09-02T06:00:00.000Z",
  scheduledFor: "2026-09-02T05:00:00.000Z",
  failedAt: null,
  failureReason: null,
  stripeTransferId: "tr_123",
  payoutStatus: "completed",
  processorBatchId: null,
};

beforeEach(() => {
  testState.payable = PAYABLE_PAGE;
  testState.payableLoading = false;
  testState.payableError = null;
  testState.history = { items: [SENT_ROW], nextCursor: null, total: 1 };
  testState.historyLoading = false;
  testState.historyError = null;
  testState.dataUpdatedAt = 1;
  testState.historyFetch = vi.fn();
  testState.historyRefetch = vi.fn();
  testState.lastHistoryInput = null;
  testState.isMobile = false;
  testState.upcoming = {
    items: [],
    byDate: [],
    nextByPayee: [],
    currencyTotals: [],
    total: 0,
    truncated: false,
    rowLimit: 200,
    debtResolved: true,
  };
  testState.upcomingLoading = false;
  testState.upcomingError = null;
  testState.revenue = null;
  testState.revenueLoading = false;
  testState.revenueError = null;
  testState.revenueRefetch = vi.fn();
});

describe("PayoutsOwedSection", () => {
  // The headline figures are the only `Money` rendered as a <p> (`tag="p"`),
  // which is what distinguishes them from the breakdown lines below — and the
  // breakdown CAN carry the same number (when reserves and holds are zero,
  // "Unpaid credits" equals "Total owed"), so a text match alone would be
  // ambiguous exactly where the section matters most.
  const headlineFigures = (container: HTMLElement) =>
    [...container.querySelectorAll("p[data-money]")].map((el) =>
      el.getAttribute("data-money"),
    );

  it("renders payable and total owed as TWO separate figures, neither derived from the other", () => {
    const { container } = render(<PayoutsOwedSection />);

    // Cents, exactly as the server sent them, in payable-then-owed order.
    expect(headlineFigures(container)).toEqual(["USD:205825", "USD:521875"]);
    // Each figure carries its own definition, so the two can't be conflated.
    expect(screen.getByText("admin.pstOwedPayableNow")).toBeTruthy();
    expect(screen.getByText("admin.pstOwedTotalOwed")).toBeTruthy();
    expect(screen.getByText("admin.pstOwedPayableNowHint")).toBeTruthy();
    expect(screen.getByText("admin.pstOwedTotalOwedHint")).toBeTruthy();
  });

  it("breaks the owed figure into its three components", () => {
    testState.payable = {
      ...PAYABLE_PAGE,
      liabilityTotals: [
        {
          currency: "usd",
          unpaidCreditsCents: 500_000,
          reserveHeldCents: 15_000,
          pendingHoldCents: 6_875,
          totalOwedCents: 521_875,
        },
      ],
    };
    const { container } = render(<PayoutsOwedSection />);

    expect(screen.getByText("USD:500000")).toBeTruthy();
    expect(screen.getByText("USD:15000")).toBeTruthy();
    expect(screen.getByText("USD:6875")).toBeTruthy();
    // 500000 + 15000 + 6875 = 521875 — the headline is the sum of its parts.
    expect(headlineFigures(container)[1]).toBe("USD:521875");
  });

  it("shows a currency that has liability but NOTHING payable — hiding it would hide money owed", () => {
    testState.payable = {
      ...PAYABLE_PAGE,
      items: [],
      total: 0,
      payableTotals: [],
      liabilityTotals: [
        {
          currency: "mxn",
          unpaidCreditsCents: 415_000,
          reserveHeldCents: 0,
          pendingHoldCents: 0,
          totalOwedCents: 415_000,
        },
      ],
    };
    const { container } = render(<PayoutsOwedSection />);

    expect(screen.getByText("MXN")).toBeTruthy();
    // Payable reads a hard zero for that currency, not a blank, beside the
    // 415,000 that is genuinely owed.
    expect(headlineFigures(container)).toEqual(["MXN:0", "MXN:415000"]);
    expect(screen.getByText("admin.pstOwedEmpty")).toBeTruthy();
  });

  it("lists each payable cell with its owner link and maturity, preserving server order", () => {
    render(<PayoutsOwedSection />);

    const rows = screen.getAllByTestId(/^row-/);
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "row-payee-org:usd",
      "row-payee-human:usd",
    ]);
    expect(screen.getByText("USD:167200")).toBeTruthy();
    expect(screen.getByText("USD:38625")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /DRKMTTR, USD/ }).getAttribute("href"),
    ).toBe("/admin/drkmttr");
    // A cell whose positive balance has no matured credit says so rather
    // than rendering an empty date.
    expect(screen.getByText("admin.pstOwedNoMatured")).toBeTruthy();
  });

  it("says it truncated, and the totals still describe every cell", () => {
    testState.payable = { ...PAYABLE_PAGE, truncated: true, total: 640 };
    render(<PayoutsOwedSection />);

    expect(
      screen.getByText('admin.pstOwedTruncated:{"limit":200,"total":640}'),
    ).toBeTruthy();
    expect(screen.getByText("USD:205825")).toBeTruthy();
  });


  it("renders TOTAL OWED as an explicit unknown, never $0.00, when the liability query did not report the currency", () => {
    // A positive "Payable now" beside "Total owed $0.00" is a silent solvency
    // OVERSTATEMENT. Failing loud, in the safe direction, is the whole point.
    testState.payable = { ...PAYABLE_PAGE, liabilityTotals: [] };
    const { container } = render(<PayoutsOwedSection />);

    expect(headlineFigures(container)).toEqual(["USD:205825"]);
    expect(screen.getByText("admin.pstOwedNotReported")).toBeTruthy();
    expect(container.textContent).not.toContain("USD:0");
  });

  it("marks the rows tonight's batch will skip, and names the threshold", () => {
    testState.payable = {
      ...PAYABLE_PAGE,
      payoutMinimumCents: 1_000,
      items: [
        { ...PAYABLE_PAGE.items[0]!, payableCents: 400, belowMinimum: true },
        {
          ...PAYABLE_PAGE.items[1]!,
          ineligibleReason: "payee_payouts_disabled" as const,
        },
      ],
    };
    render(<PayoutsOwedSection />);

    expect(screen.getByText("admin.pstOwedSkipBelowMinimum")).toBeTruthy();
    // The threshold is NAMED from the fee policy, never asserted in the UI.
    expect(screen.getByText("admin.pstOwedMinimumIs")).toBeTruthy();
    expect(screen.getByText("USD:1000")).toBeTruthy();
    expect(screen.getByText("admin.pstOwedSkipPayoutsOff")).toBeTruthy();
  });

  it("names each of the batch's three eligibility reasons", () => {
    testState.payable = {
      ...PAYABLE_PAGE,
      items: [
        {
          ...PAYABLE_PAGE.items[0]!,
          ineligibleReason: "payee_not_found" as const,
        },
        {
          ...PAYABLE_PAGE.items[1]!,
          ineligibleReason: "payee_missing_stripe_account" as const,
        },
      ],
    };
    render(<PayoutsOwedSection />);

    expect(screen.getByText("admin.pstOwedSkipNoPayee")).toBeTruthy();
    expect(screen.getByText("admin.pstOwedSkipNoStripe")).toBeTruthy();
  });

  it("says 'no known blocker' — never denying the payee cap it cannot see", () => {
    render(<PayoutsOwedSection />);
    expect(screen.getAllByText("admin.pstOwedSkipNone")).toHaveLength(2);
  });

  it("shows eligibility as UNKNOWN, never as clear, when identity degraded", () => {
    testState.payable = {
      ...PAYABLE_PAGE,
      items: [
        {
          ...PAYABLE_PAGE.items[0]!,
          identityResolved: false,
          ineligibleReason: null,
          subjectType: null,
          subjectId: null,
          ownerLabel: null,
          ownerSlug: null,
        },
      ],
    };
    render(<PayoutsOwedSection />);

    expect(screen.getByText("admin.pstOwedSkipUnknown")).toBeTruthy();
    expect(screen.queryByText("admin.pstOwedSkipNone")).toBeNull();
  });


  it("keeps the BELOW-MINIMUM verdict when only IDENTITY degraded — it needs no lookup", () => {
    testState.payable = {
      ...PAYABLE_PAGE,
      items: [
        {
          ...PAYABLE_PAGE.items[0]!,
          payableCents: 400,
          belowMinimum: true,
          identityResolved: false,
          ineligibleReason: null,
          subjectType: null,
          subjectId: null,
          ownerLabel: null,
          ownerSlug: null,
        },
      ],
    };
    render(<PayoutsOwedSection />);

    // BOTH facts, not one: eligibility is unknown, but "$4.00 is below the
    // $10.00 minimum" is still true and is the more actionable of the two.
    expect(screen.getByText("admin.pstOwedSkipUnknown")).toBeTruthy();
    expect(screen.getByText("admin.pstOwedSkipBelowMinimum")).toBeTruthy();
    expect(screen.getByText("USD:1000")).toBeTruthy();
  });

  it("says the MINIMUM is unknown when the fee-policy read failed, without accusing the row", () => {
    testState.payable = {
      ...PAYABLE_PAGE,
      payoutMinimumCents: null,
      minimumResolved: false,
      items: [{ ...PAYABLE_PAGE.items[0]!, belowMinimum: null }],
    };
    render(<PayoutsOwedSection />);

    expect(screen.getByText("admin.pstOwedSkipMinimumUnknown")).toBeTruthy();
    expect(screen.queryByText("admin.pstOwedSkipBelowMinimum")).toBeNull();
    // And no threshold is named, because none was read.
    expect(screen.queryByText("admin.pstOwedMinimumIs")).toBeNull();
  });

  it("names the per-run payee cap in a footnote, since the column cannot see it", () => {
    render(<PayoutsOwedSection />);
    expect(screen.getByText("admin.pstOwedCapFootnote")).toBeTruthy();
  });

  it("degrades to an inline retry on a statement timeout instead of hanging", () => {
    testState.payable = null;
    testState.payableError = Object.assign(new Error("timed out"), {
      data: { appCode: "SERVICE_UNAVAILABLE" },
    });
    render(<PayoutsOwedSection />);

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("admin.pstOwedTimedOut")).toBeTruthy();
    expect(screen.getByRole("button", { name: "admin.pstOwedRetry" })).toBeTruthy();
  });

  // ── "Expected next" ──────────────────────────────────────────────────────
  //
  // The forward half of a payee's position. Three states that must never
  // collapse into one another — the dangerous collapse is the third, because
  // a failed read rendered as "nothing upcoming" tells the reader a payee is
  // fully paid up when we simply do not know.

  it("shows each payee's NEXT tranche — the first one only, never their upcoming total", () => {
    testState.upcoming = {
      items: [],
      byDate: [],
      nextByPayee: [
        {
          payeeId: "payee-org",
          currency: "usd",
          maturesAt: "2026-09-27T05:00:00.000Z",
          // The payee's WHOLE upcoming book is larger than this; the cell
          // must show the first tranche, which is what actually moves next.
          nextTrancheCents: 46_075,
          creditCents: 46_075,
          heldCents: 0,
          debtAppliedCents: 0,
        },
      ],
      currencyTotals: [],
      total: 1,
      truncated: false,
      rowLimit: 200,
      debtResolved: true,
    };
    const { container } = render(<PayoutsOwedSection />);

    const monies = [...container.querySelectorAll("[data-money]")].map((el) =>
      el.getAttribute("data-money"),
    );
    expect(monies).toContain("USD:46075");
    expect(screen.getByText("admin.pstOwedColExpected")).toBeTruthy();
    // Nothing came off the gross, so no caption explains a deduction.
    expect(screen.queryByText(/admin\.pstUpOfCredit/)).toBeNull();
  });

  it("renders the NET next tranche, explains the debt that came off the gross, and notes the dispute WITHOUT subtracting it", () => {
    // A 70_000 credit; 20_000 of it under an open dispute, whose hold is why
    // the payable is −30_000 today (with 10_000 of older debt). The server
    // nets the 30_000 debt: figure 40_000. The hold appears as a note only —
    // it is inside that 30_000 already, and must not read as a further
    // 20_000 to take off.
    testState.upcoming = {
      items: [],
      byDate: [],
      nextByPayee: [
        {
          payeeId: "payee-org",
          currency: "usd",
          maturesAt: "2026-09-27T05:00:00.000Z",
          nextTrancheCents: 40_000,
          creditCents: 70_000,
          heldCents: 20_000,
          debtAppliedCents: 30_000,
        },
      ],
      currencyTotals: [],
      total: 1,
      truncated: false,
      rowLimit: 200,
      debtResolved: true,
    };
    const { container } = render(<PayoutsOwedSection />);

    const expectedCell = container.querySelector(
      '[data-testid="row-payee-org:usd"] [data-col="expected"]',
    )!;
    const monies = [...expectedCell.querySelectorAll("[data-money]")].map(
      (el) => el.getAttribute("data-money"),
    );
    // The figure is the NET — the gross is never rendered as the figure.
    expect(monies).toEqual(["USD:40000"]);
    expect(expectedCell.textContent).toContain(
      'admin.pstUpOfCredit:{"credit":"USD:70000"}',
    );
    expect(expectedCell.textContent).toContain(
      'admin.pstUpDebt:{"amount":"USD:30000"}',
    );
    // The dispute note is its own phrase, never a "held" deduction line.
    expect(expectedCell.textContent).toContain(
      'admin.pstUpUnderDispute:{"amount":"USD:20000"}',
    );
    expect(expectedCell.textContent).not.toContain("admin.pstUpHeld");
  });

  it("a dispute note with NO debt: the figure is the full credit and no netting caption appears", () => {
    // Trace (B): matured money elsewhere covers the hold, so the payable is
    // positive today and the immature credit pays in full on its date.
    testState.upcoming = {
      items: [],
      byDate: [],
      nextByPayee: [
        {
          payeeId: "payee-org",
          currency: "usd",
          maturesAt: "2026-09-27T05:00:00.000Z",
          nextTrancheCents: 70_000,
          creditCents: 70_000,
          heldCents: 70_000,
          debtAppliedCents: 0,
        },
      ],
      currencyTotals: [],
      total: 1,
      truncated: false,
      rowLimit: 200,
      debtResolved: true,
    };
    const { container } = render(<PayoutsOwedSection />);
    const expectedCell = container.querySelector(
      '[data-testid="row-payee-org:usd"] [data-col="expected"]',
    )!;
    const monies = [...expectedCell.querySelectorAll("[data-money]")].map(
      (el) => el.getAttribute("data-money"),
    );
    expect(monies).toEqual(["USD:70000"]);
    expect(expectedCell.textContent).not.toContain("admin.pstUpOfCredit");
    expect(expectedCell.textContent).toContain(
      'admin.pstUpUnderDispute:{"amount":"USD:70000"}',
    );
  });

  it("says 'could not check debt' — never a number — when the server could not net the payable", () => {
    testState.upcoming = {
      items: [],
      byDate: [],
      nextByPayee: [
        {
          payeeId: "payee-org",
          currency: "usd",
          maturesAt: "2026-09-27T05:00:00.000Z",
          nextTrancheCents: null,
          creditCents: 70_000,
          heldCents: 0,
          debtAppliedCents: null,
        },
      ],
      currencyTotals: [],
      total: 1,
      truncated: false,
      rowLimit: 200,
      debtResolved: false,
    };
    const { container } = render(<PayoutsOwedSection />);

    const expectedCell = container.querySelector(
      '[data-testid="row-payee-org:usd"] [data-col="expected"]',
    )!;
    expect(expectedCell.textContent).toContain("admin.pstUpDebtUnknown");
    // The gross survives ONLY as a labelled credit in the caption; no
    // `Money` figure stands in for the missing net.
    expect(expectedCell.querySelectorAll("[data-money]")).toHaveLength(0);
    expect(expectedCell.textContent).toContain(
      'admin.pstUpOfCredit:{"credit":"USD:70000"}',
    );
    // ...and the date is still shown: WHEN is known even if HOW MUCH is not.
    expect(expectedCell.querySelector("time")).toBeTruthy();
  });

  it("carries the same net figure and caption on the mobile card", () => {
    testState.isMobile = true;
    testState.upcoming = {
      items: [],
      byDate: [],
      nextByPayee: [
        {
          payeeId: "payee-org",
          currency: "usd",
          maturesAt: "2026-09-27T05:00:00.000Z",
          nextTrancheCents: 50_000,
          creditCents: 70_000,
          heldCents: 20_000,
          debtAppliedCents: 20_000,
        },
      ],
      currencyTotals: [],
      total: 1,
      truncated: false,
      rowLimit: 200,
      debtResolved: true,
    };
    const { container } = render(<PayoutsOwedSection />);
    const card = container.querySelector('[data-testid="card-payee-org:usd"]')!;
    const monies = [...card.querySelectorAll("[data-money]")].map((el) =>
      el.getAttribute("data-money"),
    );
    expect(monies).toContain("USD:50000");
    expect(monies).not.toContain("USD:70000");
    expect(card.textContent).toContain('admin.pstUpDebt:{"amount":"USD:20000"}');
    expect(card.textContent).toContain(
      'admin.pstUpUnderDispute:{"amount":"USD:20000"}',
    );
  });

  it("says 'nothing upcoming' for a payee with no unmatured credit", () => {
    // Default fixture: the read SUCCEEDED and returned no tranches.
    render(<PayoutsOwedSection />);
    expect(screen.getAllByText("admin.pstOwedNoUpcoming").length).toBeGreaterThan(0);
  });

  it("says 'could not check' when the upcoming read FAILED — never 'nothing upcoming'", () => {
    testState.upcoming = undefined;
    testState.upcomingError = new Error("upcoming timed out");
    render(<PayoutsOwedSection />);

    expect(screen.getAllByText("admin.pstOwedExpectedUnknown").length).toBeGreaterThan(0);
    // The whole point: a failed read must not masquerade as a settled answer.
    expect(screen.queryByText("admin.pstOwedNoUpcoming")).toBeNull();
    // ...and it must not blank the money the payable read DID return.
    expect(screen.getByText("admin.pstOwedPayableNow")).toBeTruthy();
  });
});

describe("UpcomingPayoutsSection", () => {
  const TRANCHE = {
    payeeId: "payee-org",
    subjectType: "ORGANIZATION" as const,
    subjectId: ORG_ID,
    ownerLabel: "DRKMTTR",
    ownerSlug: "drkmttr",
    currency: "usd",
    maturesAt: "2026-10-04T00:00:00.000Z",
    creditCents: 7_000,
    heldCents: 7_000,
    // The hold is why the payable is −7_000 today; the SERVER nets that
    // debt. The hold itself is an annotation.
    debtAppliedCents: 7_000,
    expectedCents: 0,
    creditCount: 1,
    identityResolved: true,
  };

  it("renders the EXPECTED amount as the figure and the gross only as a labelled credit", () => {
    // The defect this section was rebuilt for: a 7_000 credit whose hold
    // put the payable at −7_000 used to forecast 7_000 going out. It moves 0.
    testState.upcoming = {
      items: [TRANCHE],
      byDate: [],
      nextByPayee: [],
      currencyTotals: [
        {
          currency: "usd",
          creditCents: 7_000,
          debtAppliedCents: 7_000,
          expectedCents: 0,
          trancheCount: 1,
        },
      ],
      total: 1,
      truncated: false,
      rowLimit: 200,
      debtResolved: true,
    };
    const { container } = render(<UpcomingPayoutsSection />);

    const amountCell = container.querySelector(
      '[data-testid="row-payee-org:usd:2026-10-04T00:00:00.000Z"] [data-col="amount"]',
    )!;
    const monies = [...amountCell.querySelectorAll("[data-money]")].map((el) =>
      el.getAttribute("data-money"),
    );
    expect(monies).toEqual(["USD:0"]);
    expect(amountCell.textContent).toContain(
      'admin.pstUpOfCredit:{"credit":"USD:7000"}',
    );
    expect(amountCell.textContent).toContain(
      'admin.pstUpDebt:{"amount":"USD:7000"}',
    );
    // The dispute is noted, in words that do not invite a second subtraction.
    expect(amountCell.textContent).toContain(
      'admin.pstUpUnderDispute:{"amount":"USD:7000"}',
    );

    // The currency tile leads with the expected total (the <p>), and its
    // caption shows the gross it was netted from — and NO hold figure, which
    // is per order and sums to nothing a reader should use.
    const headline = container.querySelector("p[data-money]")!;
    expect(headline.getAttribute("data-money")).toBe("USD:0");
    expect(headline.parentElement!.textContent).toContain(
      'admin.pstUpOfCredit:{"credit":"USD:7000"}',
    );
    expect(headline.parentElement!.textContent).not.toContain(
      "admin.pstUpUnderDispute",
    );
  });

  it("shows no caption when nothing was netted — a clean tranche is just its figure", () => {
    testState.upcoming = {
      items: [{ ...TRANCHE, heldCents: 0, debtAppliedCents: 0, expectedCents: 7_000 }],
      byDate: [],
      nextByPayee: [],
      currencyTotals: [
        {
          currency: "usd",
          creditCents: 7_000,
          debtAppliedCents: 0,
          expectedCents: 7_000,
          trancheCount: 1,
        },
      ],
      total: 1,
      truncated: false,
      rowLimit: 200,
      debtResolved: true,
    };
    const { container } = render(<UpcomingPayoutsSection />);
    expect(container.textContent).not.toContain("admin.pstUpOfCredit");
    expect(container.textContent).not.toContain("admin.pstUpUnderDispute");
    expect(container.textContent).not.toContain("admin.pstUpDebtUnknown");
  });

  it("a hold with NO debt is a note beside the FULL figure, never a deduction", () => {
    // Trace (B): 7_000 under dispute, but matured money elsewhere covers the
    // hold, so nothing is netted and the tranche pays 7_000.
    testState.upcoming = {
      items: [{ ...TRANCHE, heldCents: 7_000, debtAppliedCents: 0, expectedCents: 7_000 }],
      byDate: [],
      nextByPayee: [],
      currencyTotals: [],
      total: 1,
      truncated: false,
      rowLimit: 200,
      debtResolved: true,
    };
    const { container } = render(<UpcomingPayoutsSection />);
    const amountCell = container.querySelector(
      '[data-testid="row-payee-org:usd:2026-10-04T00:00:00.000Z"] [data-col="amount"]',
    )!;
    expect(
      [...amountCell.querySelectorAll("[data-money]")].map((el) =>
        el.getAttribute("data-money"),
      ),
    ).toEqual(["USD:7000"]);
    expect(amountCell.textContent).not.toContain("admin.pstUpOfCredit");
    expect(amountCell.textContent).toContain(
      'admin.pstUpUnderDispute:{"amount":"USD:7000"}',
    );
  });

  it("renders 'could not check debt' in place of EVERY expected figure when debt is unresolved", () => {
    testState.upcoming = {
      items: [
        { ...TRANCHE, heldCents: 0, debtAppliedCents: null, expectedCents: null },
      ],
      byDate: [],
      nextByPayee: [],
      currencyTotals: [
        {
          currency: "usd",
          creditCents: 7_000,
          debtAppliedCents: null,
          expectedCents: null,
          trancheCount: 1,
        },
      ],
      total: 1,
      truncated: false,
      rowLimit: 200,
      debtResolved: false,
    };
    const { container } = render(<UpcomingPayoutsSection />);

    // Row AND tile: two badges, zero confident figures.
    expect(screen.getAllByText("admin.pstUpDebtUnknown")).toHaveLength(2);
    expect(container.querySelectorAll("[data-money]")).toHaveLength(0);
    // The gross is still stated, as credit.
    expect(container.textContent).toContain(
      'admin.pstUpOfCredit:{"credit":"USD:7000"}',
    );
  });

  it("carries the net figure and the netting caption on the mobile card", () => {
    testState.isMobile = true;
    testState.upcoming = {
      items: [
        { ...TRANCHE, heldCents: 2_000, debtAppliedCents: 3_000, expectedCents: 4_000 },
      ],
      byDate: [],
      nextByPayee: [],
      currencyTotals: [],
      total: 1,
      truncated: false,
      rowLimit: 200,
      debtResolved: true,
    };
    const { container } = render(<UpcomingPayoutsSection />);
    const card = container.querySelector(
      '[data-testid="card-payee-org:usd:2026-10-04T00:00:00.000Z"]',
    )!;
    const monies = [...card.querySelectorAll("[data-money]")].map((el) =>
      el.getAttribute("data-money"),
    );
    expect(monies).toEqual(["USD:4000"]);
    expect(card.textContent).toContain('admin.pstUpDebt:{"amount":"USD:3000"}');
    expect(card.textContent).toContain(
      'admin.pstUpUnderDispute:{"amount":"USD:2000"}',
    );
  });
});

describe("PayoutsSentSection", () => {
  it("shows gross, every non-zero deduction and the net that follows from them", () => {
    render(<PayoutsSentSection />);

    expect(screen.getByText("USD:68000")).toBeTruthy(); // gross
    expect(screen.getByText("USD:200")).toBeTruthy(); // Stripe fee
    expect(screen.getByText("USD:6800")).toBeTruthy(); // reserve held
    expect(screen.getByText("USD:61000")).toBeTruthy(); // sent
    // 68000 − 6800 − 200 = 61000. The row shows its own arithmetic.
    expect(68_000 - 6_800 - 200).toBe(61_000);
    expect(screen.getByText("admin.pstPaidFee")).toBeTruthy();
    expect(screen.getByText("admin.pstPaidReserveHeld")).toBeTruthy();
  });

  it("renders a PRE-CUTOVER net as 'Not reported', never as $0.00", () => {
    // The stored zero is a migration backfill, not a net. Showing it would
    // report a transferred $500 as "Sent $0.00".
    testState.history = {
      items: [{ ...SENT_ROW, amountCents: 50_000, netCents: null }],
      nextCursor: null,
      total: 1,
    };
    const { container } = render(<PayoutsSentSection />);

    expect(screen.getByText("admin.pstPaidNetNotRecorded")).toBeTruthy();
    expect(screen.getByText("USD:50000")).toBeTruthy();
    expect(container.textContent).not.toContain("USD:0");
  });

  it("marks released reserve as ADDED, not withheld", () => {
    testState.history = {
      items: [
        {
          ...SENT_ROW,
          reserveHeldCents: 0,
          connectAccountFeeCents: 0,
          reserveReleasedCents: 6_800,
          amountCents: 31_200,
          netCents: 38_000,
        },
      ],
      nextCursor: null,
      total: 1,
    };
    render(<PayoutsSentSection />);

    expect(screen.getByText("admin.pstPaidReserveReleased")).toBeTruthy();
    expect(screen.getByText("+")).toBeTruthy();
    expect(screen.getByText("USD:38000")).toBeTruthy();
  });

  it("reads 'None' rather than a column of zeroes when nothing was withheld", () => {
    testState.history = {
      items: [
        {
          ...SENT_ROW,
          connectAccountFeeCents: 0,
          reserveHeldCents: 0,
          reserveReleasedCents: 0,
          netCents: 68_000,
        },
      ],
      nextCursor: null,
      total: 1,
    };
    render(<PayoutsSentSection />);
    expect(screen.getByText("admin.pstPaidNoDeductions")).toBeTruthy();
  });

  it("dates a pending item by its batch schedule and labels it as such", () => {
    testState.history = {
      items: [
        {
          ...SENT_ROW,
          id: "item-pending",
          status: "pending",
          transferredAt: null,
          stripeTransferId: null,
          occurredAt: "2026-09-11T05:00:00.000Z",
        },
      ],
      nextCursor: null,
      total: 1,
    };
    render(<PayoutsSentSection />);

    expect(screen.getByText("admin.pstPaidScheduled")).toBeTruthy();
    expect(screen.getByText("2026-09-11T05:00:00.000Z")).toBeTruthy();
    expect(screen.getByText("admin.pstPaidNoTransfer")).toBeTruthy();
  });

  it("surfaces the failure reason where the transfer id would have been", () => {
    testState.history = {
      items: [
        {
          ...SENT_ROW,
          id: "item-failed",
          status: "failed",
          transferredAt: null,
          stripeTransferId: null,
          failedAt: "2026-09-07T06:00:00.000Z",
          failureReason: "account_capability_inactive",
        },
      ],
      nextCursor: null,
      total: 1,
    };
    render(<PayoutsSentSection />);

    expect(
      screen.getByText(
        'admin.pstPaidFailureReason:{"reason":"account_capability_inactive"}',
      ),
    ).toBeTruthy();
  });

  it("links a transferred item to its Stripe transfer", () => {
    render(<PayoutsSentSection />);
    expect(screen.getByText("prov:tr_123")).toBeTruthy();
  });

  it("re-queries on a status filter and marks the active one", () => {
    render(<PayoutsSentSection />);
    expect(testState.lastHistoryInput).toMatchObject({ status: "all" });

    fireEvent.click(screen.getByRole("button", { name: "admin.pstStatusFailed" }));

    expect(testState.lastHistoryInput).toMatchObject({ status: "failed" });
    expect(
      screen
        .getByRole("button", { name: "admin.pstStatusFailed" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "admin.pstPaidFilterAll" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("drops accumulated cursor pages when the filter changes — two result sets must never splice", async () => {
    testState.history = { items: [SENT_ROW], nextCursor: "cursor-1", total: 40 };
    const second = {
      ...SENT_ROW,
      id: "item-2",
      ownerLabel: "Bay Area Festivals",
      ownerSlug: "bay-area",
    };
    testState.historyFetch = vi.fn(async () => ({
      items: [second],
      nextCursor: null,
      total: 39,
    }));

    render(<PayoutsSentSection />);

    fireEvent.click(screen.getByRole("button", { name: "admin.pstPaidLoadMore" }));
    await waitFor(() => expect(screen.getByTestId("row-item-2")).toBeTruthy());
    expect(testState.historyFetch).toHaveBeenCalledWith(
      expect.objectContaining({ status: "all", cursor: "cursor-1" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "admin.pstStatusPending" }));

    await waitFor(() => expect(screen.queryByTestId("row-item-2")).toBeNull());
    expect(testState.lastHistoryInput).toMatchObject({ status: "pending" });
  });

  it("says 'no payout has ever run' on the unfiltered feed and 'nothing matches' on a filtered one", () => {
    testState.history = { items: [], nextCursor: null, total: 0 };
    const { rerender } = render(<PayoutsSentSection />);
    expect(screen.getByText("admin.pstPaidEmptyEver")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "admin.pstStatusFailed" }));
    rerender(<PayoutsSentSection />);
    expect(screen.getByText("admin.pstPaidEmptyFiltered")).toBeTruthy();
  });

  it("degrades to an inline retry on a statement timeout", () => {
    testState.history = null;
    testState.historyError = Object.assign(new Error("timed out"), {
      data: { appCode: "SERVICE_UNAVAILABLE" },
    });
    render(<PayoutsSentSection />);

    expect(screen.getByText("admin.pstPaidTimedOut")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "admin.pstPaidRetry" }));
    expect(testState.historyRefetch).toHaveBeenCalled();
  });

  it("renders NOTHING zone-derived in the SERVER pass, then the note after mount", async () => {
    // THE PROPERTY IS ABOUT THE SERVER PASS, so it has to be tested there.
    // `Intl.DateTimeFormat().resolvedOptions().timeZone` is the SERVER's zone
    // during SSR and the BROWSER's afterwards; baking the first into the
    // markup mismatches on hydration for every reader outside it. Local dev
    // cannot reproduce it — server and browser are the same machine.
    //
    // An RTL-only version of this test was written first and was INERT:
    // `render()` flushes effects inside `act()`, so the note is present by
    // the first assertion whether or not it is gated — verified by deleting
    // the `timeZoneResolved &&` guard and watching it stay green. SSR is the
    // only pass where the guard is observable.
    const ssr = renderToStaticMarkup(<PayoutsSentSection />);
    expect(ssr).not.toContain("pstPaidTimeZoneNote");
    // ...and the section itself DID render, so this is not a vacuous pass on
    // an empty string.
    expect(ssr).toContain("admin.pstPaidTitle");

    // Second half: after mount it appears, carrying a real zone.
    render(<PayoutsSentSection />);
    await waitFor(() =>
      expect(screen.getByText(/^admin\.pstPaidTimeZoneNote:/)).toBeTruthy(),
    );
    expect(
      screen.getByText(/^admin\.pstPaidTimeZoneNote:/).textContent,
    ).toMatch(/"zone":"[A-Za-z/_+-]+"/);
  });

  it("renders a mobile card carrying the same numbers as the row", () => {
    testState.isMobile = true;
    render(<PayoutsSentSection />);

    const card = screen.getByTestId("card-item-1");
    expect(card.textContent).toContain("USD:68000");
    expect(card.textContent).toContain("USD:61000");
    expect(card.textContent).toContain("USD:6800");
  });
});

describe("payout owner resolution", () => {
  const base = {
    payeeId: "payee-1",
    subjectType: "ORGANIZATION" as const,
    subjectId: ORG_ID,
    ownerLabel: "DRKMTTR",
    ownerSlug: "drkmttr",
  };

  it("links an organisation to its admin surface", () => {
    expect(payoutOwnerHref(base)).toBe("/admin/drkmttr");
  });

  it("links a human to the platform humans list, since humans have no admin page", () => {
    expect(
      payoutOwnerHref({
        ...base,
        subjectType: "HUMAN",
        subjectId: HUMAN_ID,
        ownerLabel: "Sole Artist",
        ownerSlug: null,
      }),
    ).toBe("/platform/humans?q=Sole%20Artist");
  });

  it("refuses to link when there is nothing to link to", () => {
    expect(payoutOwnerHref({ ...base, ownerSlug: null })).toBeNull();
    expect(
      payoutOwnerHref({ ...base, subjectType: "HUMAN", ownerLabel: "  " }),
    ).toBeNull();
    // Degraded identity (the use case's swallow path) — no subject at all.
    expect(
      payoutOwnerHref({
        payeeId: "payee-1",
        subjectType: null,
        subjectId: null,
        ownerLabel: null,
        ownerSlug: null,
      }),
    ).toBeNull();
  });

  it("never renders a blank owner, falling back subject id then payee id", () => {
    expect(payoutOwnerName(base)).toBe("DRKMTTR");
    expect(payoutOwnerName({ ...base, ownerLabel: null })).toBe("11111111...");
    expect(
      payoutOwnerName({
        payeeId: "payee-1",
        subjectType: null,
        subjectId: null,
        ownerLabel: null,
        ownerSlug: null,
      }),
    ).toBe("payee-1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Platform revenue — the "what did we keep" book.
//
// The `@th/ui` mock above renders `<Money>` and `Money.format` as
// `CUR:cents`, and `useTranslations` as `key:{json vars}`, so these assert
// on keys and raw cents. What matters here is WHICH state each four-state
// line lands in — the two costs AND the net: a null figure must render as a
// dash + its unavailable badge, a partial figure must carry its coverage, an
// EMPTY population must render a real $0.00 with a caption and NO badge, and
// a complete one must carry neither. The net's unread badge says "Not
// computable" rather than "Not read yet", and a NEGATIVE net is a figure like
// any other, not an error.
//
// `nothing_to_report` vs `unread` is the distinction these tests exist to
// hold apart: both have `measured === 0`, and collapsing them is what made
// the page badge "Not read yet" on a finished, correct answer of zero.
//
// What this file cannot see: the mock ignores `variant`, so the net's h3
// display weight and its `tag="p"` (an `h3` there would splice a heading into
// the page outline) are not covered here. That is a render-it check.
// ─────────────────────────────────────────────────────────────────────────────

describe("PlatformRevenueSection", () => {
  /** The ROUTER's row type, so a backend rename fails this file at
   *  typecheck instead of leaving the fixture describing a shape the section
   *  no longer receives. The nullable cost figures are the point of these
   *  tests. */
  type RevenueRowFixture =
    inferRouterOutputs<AppRouter>["platform"]["getPlatformRevenue"]["rows"][number];

  const COMPLETE_ROW: RevenueRowFixture = {
    currency: "usd",
    ticketVolumeCents: 750_000,
    platformFeesChargedCents: 5_000,
    platformFeesByMode: {
      passThroughCents: 3_000,
      absorbCents: 2_000,
      unknownCents: 0,
    },
    taxCollectedHeldForRemittanceCents: 61_875,
    orderCount: 100,
    connectAccountFeesRecoveredCents: 200,
    payoutItemCount: 1,
    feesReturnedCents: 250,
    feesReturnedUnavailableReason: null,
    feesReturnedCoverage: { measured: 5, total: 5 },
    processorCostCents: 22_050,
    processorCostUnavailableReason: null,
    processorCostCoverage: { measured: 100, total: 100, parked: 0 },
    // The net is the third three-state line, not a top-level flag: it is
    // computed over the ELIGIBLE orders and reports its own coverage, so
    // `measured === total` here is "every counted order was eligible".
    netKeptCents: 1_180,
    netKeptUnavailableReason: null,
    netKeptCoverage: { measured: 100, total: 100 },
  };

  const revenue = (
    row: Partial<RevenueRowFixture> = {},
    top: { recoveredCostsResolved?: boolean } = {},
  ) => ({
    rows: [{ ...COMPLETE_ROW, ...row }],
    statuses: ["SUCCEEDED", "PART_REFUNDED", "REFUNDED", "DISPUTED"],
    recoveredCostsResolved: true,
    ...top,
  });

  /** Every rendered money figure, as the mock's `CUR:cents` strings. */
  const renderedMoney = () =>
    Array.from(document.querySelectorAll("[data-money]")).map(
      (el) => el.getAttribute("data-money") ?? "",
    );

  const badges = () =>
    screen.queryAllByTestId("payout-badge").map((el) => ({
      tone: el.getAttribute("data-tone"),
      text: el.textContent,
    }));

  it("unread on both cost lines: dash + 'not read' badge, and no cost figure is rendered", () => {
    testState.revenue = revenue({
      feesReturnedCents: null,
      feesReturnedUnavailableReason: "unread",
      feesReturnedCoverage: { measured: 0, total: 7 },
      processorCostCents: null,
      processorCostUnavailableReason: "unread",
      processorCostCoverage: { measured: 0, total: 100, parked: 0 },
      // Nothing read means nothing eligible, so the net is unread too — the
      // fixture keeps that dependency visible rather than pairing a complete
      // net with two unmeasured costs.
      netKeptCents: null,
      netKeptUnavailableReason: "unread",
      netKeptCoverage: { measured: 0, total: 100 },
    });
    render(<PlatformRevenueSection />);

    // Two cost badges, one per line, plus the net's — which says "Not
    // computable" rather than "Not read yet", because no sweep closes it.
    expect(badges()).toEqual([
      { tone: "danger", text: "admin.pstRevNotRead" },
      { tone: "danger", text: "admin.pstRevNotRead" },
      { tone: "danger", text: "admin.pstRevNetKeptUnavailable" },
    ]);
    // Two cost lines + net = three dashes. A line must never fall through to
    // a figure when its input has not been read.
    expect(screen.getAllByText("—")).toHaveLength(3);
    expect(renderedMoney()).toEqual([
      "USD:750000", // ticket volume
      "USD:5000", // fees charged
      "USD:200", // connect recovered
      "USD:61875", // tax held
    ]);
    // No coverage caption in the unread state.
    expect(screen.queryByText(/pstRevFeesReturnedCoverage/)).toBeNull();
    expect(screen.queryByText(/pstRevProcessorCoverage/)).toBeNull();
    expect(screen.queryByText(/pstRevNetKeptCoverage/)).toBeNull();
  });

  it("nothing to report on all three lines: a real $0.00 + a caption, never a dash or a badge", () => {
    // A currency with no orders at all — every measured line is 0 of 0. The
    // sum of an empty set is exactly 0, so each of these is a FINISHED
    // answer; badging it "Not read yet" reads as an unfinished feature.
    testState.revenue = revenue({
      ticketVolumeCents: 0,
      platformFeesChargedCents: 0,
      platformFeesByMode: {
        passThroughCents: 0,
        absorbCents: 0,
        unknownCents: 0,
      },
      taxCollectedHeldForRemittanceCents: 0,
      orderCount: 0,
      feesReturnedCents: 0,
      feesReturnedUnavailableReason: "nothing_to_report",
      feesReturnedCoverage: { measured: 0, total: 0 },
      processorCostCents: 0,
      processorCostUnavailableReason: "nothing_to_report",
      processorCostCoverage: { measured: 0, total: 0, parked: 0 },
      netKeptCents: 0,
      netKeptUnavailableReason: "nothing_to_report",
      netKeptCoverage: { measured: 0, total: 0 },
    });
    render(<PlatformRevenueSection />);

    // NO badge: a badge beside a real figure reads as a warning about that
    // figure, and there is nothing wrong with this one.
    expect(badges()).toEqual([]);
    expect(screen.queryByText("admin.pstRevNotRead")).toBeNull();
    expect(screen.queryByText("admin.pstRevNetKeptUnavailable")).toBeNull();
    // And no dash anywhere — the whole point of the state.
    expect(screen.queryAllByText("—")).toHaveLength(0);
    expect(renderedMoney()).toEqual([
      "USD:0", // ticket volume
      "USD:0", // fees charged
      "USD:0", // fees returned — a REAL zero, not a dash
      "USD:0", // processor cost — a REAL zero
      "USD:200", // connect recovered (a payout-only currency still has one)
      "USD:0", // net kept — a REAL zero
      "USD:0", // tax held
    ]);
    // Each line says why its zero is zero, in its own terms.
    // THESE DO NOT PROVE THE KEYS EXIST. The `t` mock above returns the key
    // verbatim, and so does the REAL `t()` on a catalog miss — so a caption
    // assertion passes either way. What they prove is WIRING: that this
    // state renders its caption at all, and that each line renders its OWN.
    // Whether the keys landed in en and es is covered by
    // `src/i18n/__tests__/catalog-parity.test.ts`. Do not count it twice.
    expect(screen.getByText("admin.pstRevFeesReturnedNothing")).toBeTruthy();
    expect(screen.getByText("admin.pstRevProcessorCostNothing")).toBeTruthy();
    expect(screen.getByText("admin.pstRevNetKeptNothing")).toBeTruthy();
    // The measured/total captions belong to `partial_coverage` alone.
    expect(screen.queryByText(/pstRevFeesReturnedCoverage/)).toBeNull();
    expect(screen.queryByText(/pstRevProcessorCoverage/)).toBeNull();
    expect(screen.queryByText(/pstRevNetKeptCoverage/)).toBeNull();
  });

  it("fees returned alone reports nothing while the other lines stay complete", () => {
    // THE REPORTED BUG, exactly: a live platform with orders and card
    // charges that has never refunded anything. Only the refund line's
    // population is empty, and only it changes.
    testState.revenue = revenue({
      feesReturnedCents: 0,
      feesReturnedUnavailableReason: "nothing_to_report",
      feesReturnedCoverage: { measured: 0, total: 0 },
    });
    render(<PlatformRevenueSection />);

    expect(badges()).toEqual([]);
    expect(screen.queryByText("admin.pstRevNotRead")).toBeNull();
    expect(screen.queryAllByText("—")).toHaveLength(0);
    expect(renderedMoney()).toEqual([
      "USD:750000",
      "USD:5000",
      "USD:0", // fees returned — nothing refunded, so exactly nothing returned
      "USD:22050",
      "USD:200",
      "USD:1180",
      "USD:61875",
    ]);
    // Wiring, not key existence — see the note in the case above.
    expect(screen.getByText("admin.pstRevFeesReturnedNothing")).toBeTruthy();
    // The other two lines are untouched — the states are per line.
    expect(screen.queryByText("admin.pstRevProcessorCostNothing")).toBeNull();
    expect(screen.queryByText("admin.pstRevNetKeptNothing")).toBeNull();
  });

  it("partial on both cost lines: figure + 'Partial' badge + coverage caption with measured/total", () => {
    testState.revenue = revenue({
      feesReturnedCents: 250,
      feesReturnedUnavailableReason: "partial_coverage",
      feesReturnedCoverage: { measured: 3, total: 10 },
      processorCostCents: 22_050,
      processorCostUnavailableReason: "partial_coverage",
      processorCostCoverage: { measured: 40, total: 100, parked: 0 },
      netKeptCents: 640,
      netKeptUnavailableReason: "partial_coverage",
      netKeptCoverage: { measured: 38, total: 100 },
    });
    render(<PlatformRevenueSection />);

    // All three three-state lines are partial, and all three are badged: the
    // net is no more allowed to present a partial sum as a total than the
    // costs above it are.
    expect(badges()).toEqual([
      { tone: "warning", text: "admin.pstRevPartial" },
      { tone: "warning", text: "admin.pstRevPartial" },
      { tone: "warning", text: "admin.pstRevPartial" },
    ]);
    expect(renderedMoney()).toContain("USD:250");
    expect(renderedMoney()).toContain("USD:22050");
    expect(renderedMoney()).toContain("USD:640");
    expect(
      screen.getByText(
        'admin.pstRevFeesReturnedCoverage:{"measured":3,"total":10}',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'admin.pstRevProcessorCoverage:{"measured":40,"total":100}',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText('admin.pstRevNetKeptCoverage:{"measured":38,"total":100}'),
    ).toBeTruthy();
    // Nothing is a dash: every line has a figure, three of them partial.
    expect(screen.queryAllByText("—")).toHaveLength(0);
  });

  it("partial processor cost with parked reads names the parked count instead of 'not read yet'", () => {
    testState.revenue = revenue({
      processorCostCents: 22_050,
      processorCostUnavailableReason: "partial_coverage",
      processorCostCoverage: { measured: 40, total: 100, parked: 12 },
    });
    render(<PlatformRevenueSection />);

    expect(
      screen.getByText(
        'admin.pstRevProcessorParked:{"measured":40,"total":100,"parked":12}',
      ),
    ).toBeTruthy();
    // The self-healing caption must not ALSO render — one story per line.
    expect(screen.queryByText(/pstRevProcessorCoverage/)).toBeNull();
    // Still partial: parked orders are unmeasured, not measured-as-zero.
    expect(badges()).toContainEqual({
      tone: "warning",
      text: "admin.pstRevPartial",
    });
    expect(renderedMoney()).toContain("USD:22050");
  });

  it("partial processor cost with zero parked keeps the 'not read yet' caption", () => {
    testState.revenue = revenue({
      processorCostCents: 22_050,
      processorCostUnavailableReason: "partial_coverage",
      processorCostCoverage: { measured: 40, total: 100, parked: 0 },
    });
    render(<PlatformRevenueSection />);

    expect(
      screen.getByText(
        'admin.pstRevProcessorCoverage:{"measured":40,"total":100}',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/pstRevProcessorParked/)).toBeNull();
  });

  it("complete on every line: figures, no badge, no coverage caption, and a real net", () => {
    testState.revenue = revenue();
    render(<PlatformRevenueSection />);

    expect(badges()).toEqual([]);
    // Waterfall order, with the net sitting in the total rule between the
    // last cost line and the tax figure below the rule.
    expect(renderedMoney()).toEqual([
      "USD:750000",
      "USD:5000",
      "USD:250",
      "USD:22050",
      "USD:200",
      "USD:1180",
      "USD:61875",
    ]);
    expect(screen.queryByText(/pstRevFeesReturnedCoverage/)).toBeNull();
    expect(screen.queryByText(/pstRevProcessorCoverage/)).toBeNull();
    expect(screen.queryByText(/pstRevNetKeptCoverage/)).toBeNull();
    // Nothing is withheld at full coverage — and the "Not computable" badge
    // the net used to carry unconditionally is gone.
    expect(screen.queryAllByText("—")).toHaveLength(0);
    expect(screen.queryByText("admin.pstRevNetKeptUnavailable")).toBeNull();
  });

  it("net unread: dash + 'Not computable', never 'Not read yet', and no net figure", () => {
    // The coherent shape of this state: both costs are fully read, but no
    // counted order recorded a fee mode, so nothing is eligible to net.
    testState.revenue = revenue({
      netKeptCents: null,
      netKeptUnavailableReason: "unread",
      netKeptCoverage: { measured: 0, total: 100 },
      platformFeesByMode: {
        passThroughCents: 0,
        absorbCents: 0,
        unknownCents: 5_000,
      },
    });
    render(<PlatformRevenueSection />);

    expect(badges()).toEqual([
      { tone: "danger", text: "admin.pstRevNetKeptUnavailable" },
    ]);
    // "Not read yet" would promise a sweep that will never fill this.
    expect(screen.queryByText("admin.pstRevNotRead")).toBeNull();
    expect(screen.getAllByText("—")).toHaveLength(1);
    expect(renderedMoney()).not.toContain("USD:1180");
    expect(screen.queryByText(/pstRevNetKeptCoverage/)).toBeNull();
    // The explanation stays: it is what tells a reader the figure is a
    // subset, so it does not depend on which state the net is in.
    expect(
      screen.getByText('admin.pstRevNetExplain:{"recorded":"USD:5000"}'),
    ).toBeTruthy();
  });

  it("net nothing-to-report: a real $0.00, never the 'Not computable' badge", () => {
    // "Not computable" is for a REAL order set none of which is eligible.
    // With NO counted orders the net is perfectly computable and it is 0.
    testState.revenue = revenue({
      orderCount: 0,
      netKeptCents: 0,
      netKeptUnavailableReason: "nothing_to_report",
      netKeptCoverage: { measured: 0, total: 0 },
    });
    render(<PlatformRevenueSection />);

    expect(badges()).toEqual([]);
    expect(screen.queryByText("admin.pstRevNetKeptUnavailable")).toBeNull();
    expect(screen.queryByText("admin.pstRevNotRead")).toBeNull();
    expect(screen.queryAllByText("—")).toHaveLength(0);
    // Wiring, not key existence — see the note two cases above.
    expect(screen.getByText("admin.pstRevNetKeptNothing")).toBeTruthy();
    expect(screen.queryByText(/pstRevNetKeptCoverage/)).toBeNull();
    expect(renderedMoney()).toEqual([
      "USD:750000",
      "USD:5000",
      "USD:250",
      "USD:22050",
      "USD:200",
      "USD:0", // net kept
      "USD:61875",
    ]);
  });

  it("net partial: the figure, a 'Partial' badge, and a coverage caption naming the exclusions", () => {
    testState.revenue = revenue({
      netKeptCents: 980,
      netKeptUnavailableReason: "partial_coverage",
      netKeptCoverage: { measured: 61, total: 100 },
    });
    render(<PlatformRevenueSection />);

    expect(badges()).toEqual([
      { tone: "warning", text: "admin.pstRevPartial" },
    ]);
    expect(renderedMoney()).toContain("USD:980");
    expect(
      screen.getByText('admin.pstRevNetKeptCoverage:{"measured":61,"total":100}'),
    ).toBeTruthy();
    expect(screen.queryAllByText("—")).toHaveLength(0);
  });

  it("a negative net renders as a signed figure and is not styled as an error", () => {
    // Refunds and recovered costs can exceed the fee retained over a
    // currency's eligible set. That is a result, not a failure — the minus
    // sign carries it, and `Money` must not arrive wearing the error tone,
    // which is reserved here for "we do not know".
    testState.revenue = revenue({ netKeptCents: -4_275 });
    render(<PlatformRevenueSection />);

    expect(renderedMoney()).toContain("USD:-4275");
    expect(screen.queryAllByText("—")).toHaveLength(0);
    expect(badges()).toEqual([]);
    const netFigure = document.querySelector('[data-money="USD:-4275"]')!;
    expect(netFigure.getAttribute("data-tone")).toBeNull();
  });

  it("by-mode caption carries pass-through and absorb amounts and omits the unknown phrase at zero", () => {
    testState.revenue = revenue();
    render(<PlatformRevenueSection />);

    const caption = screen.getByText(/admin\.pstRevFeesByMode/);
    expect(caption.textContent).toBe(
      'admin.pstRevFeesByMode:{"passThrough":"USD:3000","absorb":"USD:2000"}',
    );
    expect(screen.queryByText(/pstRevFeesModeUnknown/)).toBeNull();
  });

  it("by-mode caption appends the unknown phrase only when unknownCents > 0", () => {
    testState.revenue = revenue({
      platformFeesByMode: {
        passThroughCents: 3_000,
        absorbCents: 1_900,
        unknownCents: 100,
      },
    });
    render(<PlatformRevenueSection />);

    const caption = screen.getByText(/admin\.pstRevFeesByMode/);
    expect(caption.textContent).toBe(
      'admin.pstRevFeesByMode:{"passThrough":"USD:3000","absorb":"USD:1900"} ' +
        'admin.pstRevFeesModeUnknown:{"unknown":"USD:100"}',
    );
  });

  it("net explain names the recorded fee through Money.format, never toFixed", () => {
    testState.revenue = revenue();
    render(<PlatformRevenueSection />);

    expect(
      screen.getByText('admin.pstRevNetExplain:{"recorded":"USD:5000"}'),
    ).toBeTruthy();
    // The old hand-formatted `USD 50.00` must not come back.
    expect(screen.queryByText(/50\.00/)).toBeNull();
  });

  it("recoveredCostsResolved: false → 'Could not read recovered costs' badge on a dashed line", () => {
    testState.revenue = revenue(
      { connectAccountFeesRecoveredCents: null, payoutItemCount: null },
      { recoveredCostsResolved: false },
    );
    render(<PlatformRevenueSection />);

    expect(badges()).toEqual([
      { tone: "danger", text: "admin.pstRevConnectUnknown" },
    ]);
    expect(renderedMoney()).not.toContain("USD:200");
    // The connect line only. An unreadable recovered cost is a separate
    // failure from the net's coverage and does not dash the net.
    expect(screen.getAllByText("—")).toHaveLength(1);
  });

  it("renders the empty state when there are no rows and nothing is loading", () => {
    testState.revenue = {
      rows: [],
      statuses: ["SUCCEEDED"],
      recoveredCostsResolved: true,
    };
    render(<PlatformRevenueSection />);

    expect(screen.getByText("admin.pstRevEmpty")).toBeTruthy();
    expect(renderedMoney()).toEqual([]);
  });

  it("timeout error offers a retry that refetches; other errors render the message", () => {
    testState.revenueError = Object.assign(new Error("slow"), {
      data: { appCode: "SERVICE_UNAVAILABLE" },
    });
    const { unmount } = render(<PlatformRevenueSection />);

    expect(screen.getByRole("alert").textContent).toContain(
      "admin.pstRevTimedOut",
    );
    fireEvent.click(screen.getByRole("button", { name: "admin.pstRevRetry" }));
    expect(testState.revenueRefetch).toHaveBeenCalledTimes(1);
    unmount();

    testState.revenueError = new Error("boom");
    render(<PlatformRevenueSection />);
    expect(screen.getByRole("alert").textContent).toBe("boom");
    expect(screen.queryByRole("button", { name: "admin.pstRevRetry" })).toBeNull();
  });
});
