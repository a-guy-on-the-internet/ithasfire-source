import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Section tests for the three VISIBILITY surfaces on /platform/memberships.
 * `@th/ui` and tamagui are mocked to bare DOM so the assertions are about
 * THESE surfaces: that the money is labelled as the OWNERS' and not ours,
 * that the rounding remainder is shown rather than swallowed, that a
 * past-due row says benefits are gone, that an approximate age is not
 * presented as an exact one, and that the hand-rolled cursor paging works.
 *
 * What these tests CANNOT see, by construction, is anything about how the
 * components sit among their neighbours — contrast against a real theme
 * surface, column width pressure, overflow at 320px. Those were checked by
 * driving the page, not here.
 */

const testState = vi.hoisted(() => ({
  revenue: null as unknown,
  revenueLoading: false,
  revenueError: null as unknown,
  positions: null as unknown,
  positionsLoading: false,
  positionsError: null as unknown,
  dataUpdatedAt: 1,
  positionsFetch: vi.fn(),
  positionsRefetch: vi.fn(),
  lastPositionsInput: null as unknown,
  isMobile: false,
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
  const Money = ({
    cents,
    currency,
    tag,
  }: {
    cents: number;
    currency?: string;
    tag?: string;
  }) => {
    const Tag = (tag ?? "span") as "span";
    return (
      <Tag data-money={`${currency}:${cents}`}>{`${currency}:${cents}`}</Tag>
    );
  };
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
    useLocale: () => "en-US",
    Badge: ({ children, tone }: { children?: ReactNode; tone?: string }) => (
      <span data-tone={tone} data-testid="membership-badge">
        {children}
      </span>
    ),
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
            <div
              key={getRowKey(row, i)}
              data-testid={`card-${getRowKey(row, i)}`}
            >
              {renderMobileCard?.(row)}
            </div>
          ))}
        </div>
      ) : (
        <table
          data-testid={`table:${caption}`}
          data-loading={isLoading ? "1" : "0"}
        >
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
                <tr
                  key={getRowKey(row, i)}
                  data-testid={`row-${getRowKey(row, i)}`}
                >
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
      platform: {
        listMembershipPositions: { fetch: testState.positionsFetch },
      },
    }),
    platform: {
      summariseRecurringRevenue: {
        useQuery: () => ({
          data: testState.revenue,
          isLoading: testState.revenueLoading,
          isError: Boolean(testState.revenueError),
          error: testState.revenueError,
          refetch: vi.fn(),
          isFetching: false,
        }),
      },
      listMembershipPositions: {
        useQuery: (input: unknown) => {
          testState.lastPositionsInput = input;
          return {
            data: testState.positions,
            isLoading: testState.positionsLoading,
            isError: Boolean(testState.positionsError),
            error: testState.positionsError,
            dataUpdatedAt: testState.dataUpdatedAt,
            refetch: testState.positionsRefetch,
            isFetching: false,
          };
        },
      },
    },
  },
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
}));

vi.mock("@/lib/app-error", () => ({
  getAppErrorCode: (err: unknown) =>
    (err as { data?: { appCode?: string } })?.data?.appCode ?? null,
}));

import { RecurringRevenueSection } from "../RecurringRevenueSection";
import {
  MembershipsLeavingSection,
  MembershipsNeedingAttentionSection,
} from "../MembershipPositionsSection";
import {
  formatDurationBetween,
  membershipOwnerHref,
  membershipOwnerName,
} from "../membership-visibility.helpers";

const ASOF = "2026-09-11T12:00:00.000Z";

const REVENUE = {
  ownerRevenueByCurrency: [
    {
      currency: "usd",
      activeCount: 9,
      trialingCount: 1,
      annualisedCents: 109_197,
      monthlyCents: 9_099,
      monthlyRemainderCents: 9,
      annualBilledCount: 3,
    },
    {
      currency: "mxn",
      activeCount: 2,
      trialingCount: 0,
      annualisedCents: 360_000,
      monthlyCents: 30_000,
      monthlyRemainderCents: 0,
      annualBilledCount: 0,
    },
  ],
  activeTierCount: 5,
  tiersResolved: true,
};

function position(overrides: Record<string, unknown> = {}) {
  return {
    id: "m-1",
    status: "past_due",
    memberHumanId: "human-1",
    memberName: "Alex Rivera",
    tierId: "tier-1",
    tierName: "Sustaining Member",
    tierPriceCents: 1_200,
    tierCurrency: "usd",
    tierInterval: "MONTH" as const,
    ownerType: "ORG" as const,
    ownerId: "org-1",
    ownerLabel: "Ithas Fire Demo Org",
    ownerSlug: "demo",
    currentPeriodStart: "2026-08-31T09:00:00.000Z",
    currentPeriodEnd: "2026-09-30T09:00:00.000Z",
    cancelAtPeriodEnd: false,
    startedAt: "2026-05-01T09:00:00.000Z",
    sinceAt: "2026-09-02T12:00:00.000Z",
    sinceBasis: "lastChange" as const,
    ...overrides,
  };
}


/**
 * The STATE badge, scoped to its column.
 *
 * `getByTestId` alone is ambiguous here and that ambiguity is real, not a
 * test artefact: the section heading carries a count badge of its own, so a
 * bare query would sometimes assert against the wrong one and pass for the
 * wrong reason.
 */
function stateBadge(): HTMLElement {
  const cell = document.querySelector('[data-col="state"]');
  if (!cell) throw new Error("no state column rendered");
  const badge = cell.querySelector('[data-testid="membership-badge"]');
  if (!badge) throw new Error("no badge in the state column");
  return badge as HTMLElement;
}

beforeEach(() => {
  testState.revenue = REVENUE;
  testState.revenueLoading = false;
  testState.revenueError = null;
  testState.positions = {
    items: [position()],
    nextCursor: null,
    total: 1,
    asOf: ASOF,
  };
  testState.positionsLoading = false;
  testState.positionsError = null;
  testState.dataUpdatedAt = 1;
  testState.positionsFetch = vi.fn();
  testState.positionsRefetch = vi.fn();
  testState.lastPositionsInput = null;
  testState.isMobile = false;
});

describe("RecurringRevenueSection", () => {
  it("labels the money as the OWNERS', never as platform income", () => {
    // Memberships are 0% platform fee. A number that looked like ours would
    // end up in a revenue comparison and be wrong by 100% of itself.
    render(<RecurringRevenueSection />);
    expect(
      screen.getByText("platformMemberships.mvRevIntro"),
    ).toBeInTheDocument();
    // One block per currency, so the label appears once per currency.
    expect(
      screen.getAllByText("platformMemberships.mvRevMonthly"),
    ).toHaveLength(2);
  });

  it("renders BOTH the derived monthly figure and the exact annualised one", () => {
    render(<RecurringRevenueSection />);
    expect(document.querySelector('[data-money="USD:9099"]')).toBeTruthy();
    expect(document.querySelector('[data-money="USD:109197"]')).toBeTruthy();
  });

  it("shows the cents the rounding set aside instead of swallowing them", () => {
    render(<RecurringRevenueSection />);
    expect(
      screen.getByText("platformMemberships.mvRevRemainder"),
    ).toBeInTheDocument();
    expect(document.querySelector('[data-money="USD:9"]')).toBeTruthy();
  });

  it("says nothing about rounding when the division was exact", () => {
    // MXN's remainder is 0. A permanent "set aside $0.00" line would be noise
    // that teaches a reader to ignore the one case that matters.
    testState.revenue = {
      ...REVENUE,
      ownerRevenueByCurrency: [REVENUE.ownerRevenueByCurrency[1]],
    };
    render(<RecurringRevenueSection />);
    expect(
      screen.queryByText("platformMemberships.mvRevRemainder"),
    ).toBeNull();
  });

  it("names the annual cohort only when the normalisation applied to it", () => {
    render(<RecurringRevenueSection />);
    expect(
      screen.getByText('platformMemberships.mvRevAnnualBilled:{"count":3}'),
    ).toBeInTheDocument();
    // MXN is all-monthly; the sentence would be a fact about nothing.
    expect(
      screen.queryByText('platformMemberships.mvRevAnnualBilled:{"count":0}'),
    ).toBeNull();
  });

  it("counts trialing members apart from paying ones", () => {
    render(<RecurringRevenueSection />);
    expect(
      screen.getByText('platformMemberships.mvRevActive:{"count":9}'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('platformMemberships.mvRevTrialing:{"count":1}'),
    ).toBeInTheDocument();
  });

  it("keeps currencies apart, one block each", () => {
    render(<RecurringRevenueSection />);
    expect(screen.getByText("USD")).toBeInTheDocument();
    expect(screen.getByText("MXN")).toBeInTheDocument();
    expect(document.querySelector('[data-money="MXN:30000"]')).toBeTruthy();
  });

  it("warns that a DEGRADED read covers only part of the book", () => {
    testState.revenue = { ...REVENUE, tiersResolved: false };
    render(<RecurringRevenueSection />);
    expect(
      screen.getByText("platformMemberships.mvRevTiersDegraded"),
    ).toBeInTheDocument();
    // The partial totals are still shown — the money is the point.
    expect(document.querySelector('[data-money="USD:9099"]')).toBeTruthy();
  });

  it("NEVER prints the empty sentence when the tier lookup resolved nothing", () => {
    // THE hazard. The use case drops counts whose tier did not resolve, so a
    // total failure yields zero rows — and falling through to "No active or
    // trialing memberships yet" would tell staff a book with nine paying
    // members has none, in the calm grey of a normal empty state. A Neon cold
    // start is enough to produce it. UNKNOWN and ZERO are different facts.
    testState.revenue = {
      ownerRevenueByCurrency: [],
      activeTierCount: 0,
      tiersResolved: false,
    };
    render(<RecurringRevenueSection />);

    expect(screen.queryByText("platformMemberships.mvRevEmpty")).toBeNull();
    expect(
      screen.getByText("platformMemberships.mvRevUnavailable"),
    ).toBeInTheDocument();
    // Loud, not muted: this is a failed read wearing an empty state's clothes.
    expect(screen.getByRole("alert")).toHaveTextContent(
      "platformMemberships.mvRevUnavailable",
    );
  });

  it("does not claim 'only part of the book' when there is no part to show", () => {
    // "these totals cover only part of the book" is a sentence ABOUT totals.
    // With nothing resolved there are none to qualify.
    testState.revenue = {
      ownerRevenueByCurrency: [],
      activeTierCount: 0,
      tiersResolved: false,
    };
    render(<RecurringRevenueSection />);
    expect(
      screen.queryByText("platformMemberships.mvRevTiersDegraded"),
    ).toBeNull();
  });

  it("offers a retry on a timeout, and plain text on anything else", () => {
    testState.revenue = null;
    testState.revenueError = Object.assign(new Error("boom"), {
      data: { appCode: "SERVICE_UNAVAILABLE" },
    });
    const { unmount } = render(<RecurringRevenueSection />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(
      screen.getByText("platformMemberships.mvRetry"),
    ).toBeInTheDocument();
    unmount();

    testState.revenueError = new Error("something else");
    render(<RecurringRevenueSection />);
    expect(screen.getByRole("alert")).toHaveTextContent("something else");
  });

  it("renders the empty state only when the read RESOLVED and found nothing", () => {
    testState.revenue = {
      ownerRevenueByCurrency: [],
      activeTierCount: 0,
      // Resolved. "No memberships" is then a fact, not a guess.
      tiersResolved: true,
    };
    render(<RecurringRevenueSection />);
    expect(
      screen.getByText("platformMemberships.mvRevEmpty"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("platformMemberships.mvRevUnavailable"),
    ).toBeNull();
    expect(document.querySelector("[data-money]")).toBeNull();
  });
});

describe("MembershipsNeedingAttentionSection", () => {
  it("queries the attention bucket", () => {
    render(<MembershipsNeedingAttentionSection />);
    expect(testState.lastPositionsInput).toMatchObject({
      bucket: "attention",
    });
  });

  it("says benefits are ALREADY gone for a failing card", () => {
    // The point of the whole feature: past_due denies benefits at checkout and
    // nothing else in the system tells anyone.
    render(<MembershipsNeedingAttentionSection />);
    expect(
      screen.getByText("platformMemberships.mvStatusPastDue"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("platformMemberships.mvBenefitsDenied"),
    ).toBeInTheDocument();
    expect(stateBadge()).toHaveAttribute("data-tone", "danger");
  });

  it("distinguishes 'still retrying' from 'retries exhausted'", () => {
    testState.positions = {
      items: [position({ id: "m-2", status: "unpaid" })],
      nextCursor: null,
      total: 1,
      asOf: ASOF,
    };
    render(<MembershipsNeedingAttentionSection />);
    expect(
      screen.getByText("platformMemberships.mvStatusUnpaid"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("platformMemberships.mvStatusPastDue"),
    ).toBeNull();
  });

  it("does NOT claim benefits are denied for an unfinished signup", () => {
    // An `incomplete` member never started, so nothing was taken from them.
    testState.positions = {
      items: [
        position({
          id: "m-3",
          status: "incomplete",
          sinceBasis: "signup",
          sinceAt: "2026-09-07T12:00:00.000Z",
        }),
      ],
      nextCursor: null,
      total: 1,
      asOf: ASOF,
    };
    render(<MembershipsNeedingAttentionSection />);
    expect(
      screen.getByText("platformMemberships.mvStatusIncomplete"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("platformMemberships.mvBenefitsDenied"),
    ).toBeNull();
    expect(stateBadge()).toHaveAttribute("data-tone", "warning");
  });

  it("renders an unknown Stripe status raw rather than mislabelling it", () => {
    // `Membership.status` mirrors Stripe's vocabulary verbatim and Stripe has
    // added values before. Guessing a label would put a wrong cause on screen.
    testState.positions = {
      items: [position({ id: "m-4", status: "paused" })],
      nextCursor: null,
      total: 1,
      asOf: ASOF,
    };
    render(<MembershipsNeedingAttentionSection />);
    expect(stateBadge()).toHaveTextContent("paused");
  });

  it("marks a last-change age as APPROXIMATE, and a signup age as exact", () => {
    const { unmount } = render(<MembershipsNeedingAttentionSection />);
    // 2026-09-02T12:00Z → 2026-09-11T12:00Z is nine days, "about".
    expect(
      screen.getByText('platformMemberships.mvSinceApprox:{"duration":"9 days"}'),
    ).toBeInTheDocument();
    expect(
      screen.getByText("platformMemberships.mvSinceBasisLastChange"),
    ).toBeInTheDocument();
    unmount();

    testState.positions = {
      items: [
        position({
          id: "m-5",
          status: "incomplete",
          sinceBasis: "signup",
          sinceAt: "2026-09-07T12:00:00.000Z",
        }),
      ],
      nextCursor: null,
      total: 1,
      asOf: ASOF,
    };
    render(<MembershipsNeedingAttentionSection />);
    expect(screen.getByText("4 days")).toBeInTheDocument();
    expect(
      screen.getByText("platformMemberships.mvSinceBasisSignup"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/mvSinceApprox/),
    ).toBeNull();
  });

  it("measures the age against the SERVER's asOf, not the browser clock", () => {
    // The server is what decided this row belongs in this bucket. A duration
    // derived from a different clock could contradict the list it sits in.
    //
    // FAKE TIMERS, not `vi.spyOn(Date, "now")`. The first cut of this test
    // used the spy and was INERT: `new Date()` reads the clock directly and
    // never calls `Date.now()`, so swapping the component to `new Date()`
    // still passed. `setSystemTime` moves the actual clock, which is the only
    // thing that can tell the two implementations apart.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-01-01T00:00:00.000Z"));
    try {
      render(<MembershipsNeedingAttentionSection />);
      // Against the browser clock this would read "3 months", not "9 days".
      expect(
        screen.getByText(
          'platformMemberships.mvSinceApprox:{"duration":"9 days"}',
        ),
      ).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the interval beside the amount", () => {
    // $120 a MONTH and $120 a YEAR differ by a factor of twelve.
    const { unmount } = render(<MembershipsNeedingAttentionSection />);
    expect(
      screen.getByText("platformMemberships.mvIntervalMonth"),
    ).toBeInTheDocument();
    unmount();

    testState.positions = {
      items: [
        position({ id: "m-6", tierInterval: "YEAR", tierPriceCents: 11_999 }),
      ],
      nextCursor: null,
      total: 1,
      asOf: ASOF,
    };
    render(<MembershipsNeedingAttentionSection />);
    expect(
      screen.getByText("platformMemberships.mvIntervalYear"),
    ).toBeInTheDocument();
    expect(document.querySelector('[data-money="USD:11999"]')).toBeTruthy();
  });

  it("links an org owner to its admin surface and leaves a person as text", () => {
    testState.positions = {
      items: [
        position(),
        position({
          id: "m-human",
          ownerType: "HUMAN",
          ownerId: "human-9",
          ownerLabel: "Jamie Chen",
          ownerSlug: null,
        }),
      ],
      nextCursor: null,
      total: 2,
      asOf: ASOF,
    };
    render(<MembershipsNeedingAttentionSection />);
    const links = Array.from(document.querySelectorAll("a")).map((a) =>
      a.getAttribute("href"),
    );
    expect(links).toContain("/admin/demo");
    expect(links).toContain("/platform/humans?q=Jamie%20Chen");
  });

  it("falls back to a placeholder for a member with no name", () => {
    testState.positions = {
      items: [position({ id: "m-7", memberName: null })],
      nextCursor: null,
      total: 1,
      asOf: ASOF,
    };
    render(<MembershipsNeedingAttentionSection />);
    expect(
      screen.getByText("platformMemberships.mvUnnamedMember"),
    ).toBeInTheDocument();
  });

  it("renders its own empty state", () => {
    testState.positions = {
      items: [],
      nextCursor: null,
      total: 0,
      asOf: ASOF,
    };
    render(<MembershipsNeedingAttentionSection />);
    expect(
      screen.getByText("platformMemberships.mvAttentionEmpty"),
    ).toBeInTheDocument();
  });

  it("pages by hand with utils.fetch, appending without duplicating", async () => {
    testState.positions = {
      items: [position()],
      nextCursor: "cursor-2",
      total: 2,
      asOf: ASOF,
    };
    testState.positionsFetch = vi.fn(async () => ({
      items: [position(), position({ id: "m-page2", memberName: "Sam Okonkwo" })],
      nextCursor: null,
      total: 2,
      asOf: ASOF,
    }));

    render(<MembershipsNeedingAttentionSection />);
    fireEvent.click(screen.getByText("platformMemberships.mvLoadMore"));

    await waitFor(() => {
      expect(screen.getByTestId("row-m-page2")).toBeInTheDocument();
    });
    expect(testState.positionsFetch).toHaveBeenCalledWith({
      bucket: "attention",
      cursor: "cursor-2",
      limit: 25,
    });
    // The repeated row from page one appears once, not twice.
    expect(screen.getAllByTestId("row-m-1")).toHaveLength(1);
  });

  it("shows a badge with the WHOLE-bucket total, not the page size", () => {
    testState.positions = {
      items: [position()],
      nextCursor: "cursor-2",
      total: 37,
      asOf: ASOF,
    };
    render(<MembershipsNeedingAttentionSection />);
    expect(screen.getByText("37")).toBeInTheDocument();
  });
});

describe("MembershipsLeavingSection", () => {
  beforeEach(() => {
    testState.positions = {
      items: [
        position({
          id: "m-leaving",
          status: "active",
          cancelAtPeriodEnd: true,
          currentPeriodEnd: "2026-09-17T09:00:00.000Z",
        }),
      ],
      nextCursor: null,
      total: 1,
      asOf: ASOF,
    };
  });

  it("queries the leaving bucket", () => {
    render(<MembershipsLeavingSection />);
    expect(testState.lastPositionsInput).toMatchObject({ bucket: "leaving" });
  });

  it("renders the deadline date AND how far away it is", () => {
    render(<MembershipsLeavingSection />);
    expect(
      document.querySelector('time[data-format="date"]'),
    ).toBeTruthy();
    expect(
      screen.getByText('platformMemberships.mvEndsIn:{"duration":"5 days"}'),
    ).toBeInTheDocument();
  });

  it("does not show the attention-only columns", () => {
    render(<MembershipsLeavingSection />);
    expect(document.querySelector('[data-col="state"]')).toBeNull();
    expect(document.querySelector('[data-col="ends"]')).toBeTruthy();
  });

  it("renders its own empty state, distinct from the attention one", () => {
    testState.positions = {
      items: [],
      nextCursor: null,
      total: 0,
      asOf: ASOF,
    };
    render(<MembershipsLeavingSection />);
    expect(
      screen.getByText("platformMemberships.mvLeavingEmpty"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("platformMemberships.mvAttentionEmpty"),
    ).toBeNull();
  });
});

describe("time-zone note is client-only", () => {
  it("is ABSENT from the server pass, so hydration cannot mismatch", () => {
    // `Intl.DateTimeFormat().resolvedOptions().timeZone` returns the SERVER's
    // zone during SSR and the BROWSER's afterwards, so any markup derived from
    // it mismatches for every reader outside the server's zone. An RTL
    // `render()` cannot see this — it only ever runs the client pass — so this
    // one goes through `renderToStaticMarkup`.
    const html = renderToStaticMarkup(<MembershipsLeavingSection />);
    expect(html).not.toContain("mvTimeZoneNote");
  });
});

describe("helpers", () => {
  it("membershipOwnerHref: orgs link to admin, people to the humans list", () => {
    expect(
      membershipOwnerHref({
        ownerType: "ORG",
        ownerId: "o",
        ownerLabel: "Demo",
        ownerSlug: "demo",
      }),
    ).toBe("/admin/demo");
    expect(
      membershipOwnerHref({
        ownerType: "ORG",
        ownerId: "o",
        ownerLabel: "Demo",
        ownerSlug: null,
      }),
    ).toBeNull();
    expect(
      membershipOwnerHref({
        ownerType: "HUMAN",
        ownerId: "h",
        ownerLabel: "Jamie Chen",
        ownerSlug: null,
      }),
    ).toBe("/platform/humans?q=Jamie%20Chen");
  });

  it("membershipOwnerName never renders blank", () => {
    expect(
      membershipOwnerName({
        ownerType: "ORG",
        ownerId: "org-1",
        ownerLabel: "   ",
        ownerSlug: null,
      }),
    ).toBe("org-1");
  });

  it("formatDurationBetween is a DURATION, with no direction of its own", () => {
    // The sentences it feeds ("Card failing for …", "Ends in …") supply the
    // direction; a formatter that added one would double it.
    const a = new Date("2026-09-02T12:00:00.000Z");
    const b = new Date("2026-09-11T12:00:00.000Z");
    expect(formatDurationBetween(a, b, "en-US")).toBe("9 days");
    // Symmetric — the caller decides which way round it reads.
    expect(formatDurationBetween(b, a, "en-US")).toBe("9 days");
    expect(formatDurationBetween(a, b, "en-US")).not.toMatch(/ago|in /);
  });

  it("formatDurationBetween buckets coarsely and never reports zero", () => {
    const base = new Date("2026-09-11T12:00:00.000Z");
    const plus = (ms: number) => new Date(base.getTime() + ms);
    expect(formatDurationBetween(base, plus(30_000), "en-US")).toBe("1 minute");
    expect(formatDurationBetween(base, plus(5 * 3_600_000), "en-US")).toBe(
      "5 hours",
    );
    expect(formatDurationBetween(base, plus(90 * 86_400_000), "en-US")).toBe(
      "3 months",
    );
    expect(formatDurationBetween(base, plus(400 * 86_400_000), "en-US")).toBe(
      "1 year",
    );
  });
});
