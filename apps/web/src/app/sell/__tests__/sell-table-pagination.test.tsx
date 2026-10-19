/**
 * Regression suite for the three seller-facing table pages
 * (`/sell/claims`, `/sell/listings`, `/sell/payouts`).
 *
 * All three computed their query offset as `(page - 1) * pageSize` while
 * `useAdminTableParams` hands back a ZERO-based `page`. On first load that
 * sent `offset: -25`, which the server's `offset: z.number().int().min(0)`
 * rejected with BAD_REQUEST — every cold load of all three pages errored.
 *
 * These tests pin the corrected math plus the knock-on fixes: the page reset
 * on tab change, the page clamp for stale `?p=` URLs, the headers-preserving
 * empty state, and the always-rendered pager.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Shared mutable test state
// ─────────────────────────────────────────────────────────────────────────────

const testState = vi.hoisted(() => ({
  page: 0,
  pageSize: 25,
  setPage: vi.fn(),
  setPageSize: vi.fn(),
  claimsListMyUseQuery: vi.fn(),
  resaleListMyListingsUseQuery: vi.fn(),
  refetch: vi.fn(),
}));

interface QueryResultShape {
  data?: { items: unknown[]; total: number };
  isLoading?: boolean;
  isFetching?: boolean;
  isError?: boolean;
  error?: unknown;
  refetch?: () => void;
}

function queryResult(over: QueryResultShape = {}) {
  return {
    data: { items: [], total: 0 },
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
    refetch: testState.refetch,
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Module mocks
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("@bprogress/next/app", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({ children, ...props }: { children?: ReactNode }) => {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      if (key === "role" || key === "data-testid" || key.startsWith("aria-"))
        safe[key] = value;
    }
    return React.createElement("div", safe, children);
  };

  return {
    XStack: Stack,
    YStack: Stack,
    Stack,
    styled: () => Stack,
  };
});

interface MockDataTableProps {
  columns: { id: string; header: ReactNode }[];
  rows: unknown[];
  isLoading?: boolean;
  emptyState?: ReactNode;
}

vi.mock("@th/ui", () => ({
  // Mirrors the real DataTable's contract in the one respect these tests care
  // about: the column headers render whether or not there are rows, and the
  // caller's `emptyState` fills the body. A NoResults rendered as a SIBLING
  // (the old shape) would therefore show up WITHOUT headers.
  DataTable: ({ columns, rows, isLoading, emptyState }: MockDataTableProps) => (
    <div data-testid="data-table" data-loading={String(Boolean(isLoading))}>
      <div data-testid="data-table-head">
        {columns.map((col) => (
          <span key={col.id} data-testid={`col-${col.id}`}>
            {col.header}
          </span>
        ))}
      </div>
      <div data-testid="data-table-body">
        {rows.length === 0 ? emptyState : `${rows.length} rows`}
      </div>
    </div>
  ),
  Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
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
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  useFormatters: () => ({}),
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/trpc", () => ({
  trpc: {
    claims: {
      listMy: {
        useQuery: (...args: unknown[]) =>
          testState.claimsListMyUseQuery(...args),
      },
    },
    resale: {
      listMyListings: {
        useQuery: (...args: unknown[]) =>
          testState.resaleListMyListingsUseQuery(...args),
      },
    },
  },
}));

vi.mock("@/hooks/useAdminTableParams", () => ({
  useAdminTableParams: () => ({
    searchQuery: "",
    debouncedSearch: "",
    page: testState.page,
    pageSize: testState.pageSize,
    extra: {},
    handleSearchChange: vi.fn(),
    setPage: testState.setPage,
    setPageSize: testState.setPageSize,
    setExtra: vi.fn(),
  }),
}));

// `usePageClamp` is deliberately NOT mocked — the clamp behaviour is under test.

vi.mock("@/components/AdminTableParts", () => ({
  ActionBar: ({ children }: { children?: ReactNode }) => (
    <div data-testid="action-bar">{children}</div>
  ),
  TableContainer: ({ children }: { children?: ReactNode }) => (
    <div data-testid="table-container">{children}</div>
  ),
  NoResults: ({ title }: { title: string }) => (
    <div data-testid="no-results">{title}</div>
  ),
  Pagination: (props: { page: number; totalPages: number; total?: number }) => (
    <div
      data-testid="pagination"
      data-page={String(props.page)}
      data-total-pages={String(props.totalPages)}
      data-total={props.total === undefined ? "absent" : String(props.total)}
    />
  ),
}));

vi.mock("../../admin/[slug]/_components/AdminTabBar", () => ({
  AdminTabBar: ({
    tabs,
    activeTab,
    onTabChange,
  }: {
    tabs: { value: string; label: string }[];
    activeTab: string;
    onTabChange: (tab: string) => void;
  }) => (
    <div>
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={tab.value === activeTab}
          onClick={() => onTabChange(tab.value)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: () => "network failed",
}));

vi.mock("@/lib/format", () => ({
  fmtDate: () => "May 1, 2026",
  fmtDateShort: () => "May 1",
  fmtCurrency: (_f: unknown, cents: number, currency: string) =>
    `${currency}:${cents}`,
  truncateId: (id: string) => id.slice(0, 8),
}));

vi.mock("lucide-react", () => ({
  Plus: () => <span />,
  Banknote: () => <span />,
  Clock: () => <span />,
  AlertTriangle: () => <span />,
}));

import SellClaimsPage from "../claims/page";
import SellListingsPage from "../listings/page";
import SellPayoutsPage from "../payouts/page";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** The single input object the page handed to its `useQuery`. */
function lastQueryInput(fn: { mock: { calls: unknown[][] } }) {
  const calls = fn.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1]![0] as {
    limit: number;
    offset: number;
    status?: unknown;
  };
}

const PAGES = [
  {
    name: "sell/claims",
    Page: SellClaimsPage,
    query: testState.claimsListMyUseQuery,
    errorKey: "admin.sellClaimsFailedToLoad",
    emptyKey: "admin.sellClaimsEmpty",
  },
  {
    name: "sell/listings",
    Page: SellListingsPage,
    query: testState.resaleListMyListingsUseQuery,
    errorKey: "admin.sellListingsFailedToLoad",
    emptyKey: "admin.sellListingsEmpty",
  },
  {
    name: "sell/payouts",
    Page: SellPayoutsPage,
    query: testState.resaleListMyListingsUseQuery,
    errorKey: "admin.sellPayoutsFailedToLoad",
    emptyKey: "admin.sellPayoutsNoSales",
  },
] as const;

/** A settled-but-FAILED query: TanStack reports no data and no in-flight work. */
function erroredQuery() {
  return queryResult({
    data: undefined,
    isLoading: false,
    isFetching: false,
    isError: true,
    error: new Error("boom"),
  });
}

describe("sell/* table pages — pagination", () => {
  beforeEach(() => {
    testState.page = 0;
    testState.pageSize = 25;
    testState.setPage.mockReset();
    testState.setPageSize.mockReset();
    testState.refetch.mockReset();
    testState.claimsListMyUseQuery.mockReset();
    testState.resaleListMyListingsUseQuery.mockReset();
    testState.claimsListMyUseQuery.mockReturnValue(queryResult());
    testState.resaleListMyListingsUseQuery.mockReturnValue(queryResult());
  });

  // ── Offset math (the P0) ──────────────────────────────────────────────────

  describe.each(PAGES)("$name", ({ Page, query }) => {
    it("sends offset 0 on first load — never a negative offset the server rejects", () => {
      render(<Page />);

      const input = lastQueryInput(query);
      expect(input.offset).toBe(0);
      expect(input.offset).toBeGreaterThanOrEqual(0);
      expect(input.limit).toBe(25);
    });

    it("sends offset === pageSize on the second page (zero-based index 1)", () => {
      testState.page = 1;
      render(<Page />);

      expect(lastQueryInput(query).offset).toBe(25);
    });

    it("scales the offset with a non-default page size", () => {
      testState.page = 3;
      testState.pageSize = 50;
      render(<Page />);

      const input = lastQueryInput(query);
      expect(input.limit).toBe(50);
      expect(input.offset).toBe(150);
    });

    // The largest PAGE_SIZE_OPTIONS entry is 100 and both server schemas cap
    // `limit` at .max(100), so — unlike PlacesTable, whose server caps at 50 —
    // these pages need no `effectivePageSize` clamp. If either cap moves, this
    // fails and the clamp becomes required.
    it("never requests a limit above the server's max of 100", () => {
      testState.pageSize = 100;
      render(<Page />);

      expect(lastQueryInput(query).limit).toBeLessThanOrEqual(100);
    });
  });

  // ── Page reset on tab change ──────────────────────────────────────────────

  // NOTE the `mockClear()` after render in both: at page 4 against a small
  // dataset `usePageClamp` legitimately calls setPage(0) ON MOUNT, which would
  // satisfy the positive assertion even if the handler were reverted to
  // setPage(1). Clearing first binds BOTH assertions to the click alone.
  it("sell/claims resets to page 0 (not 1) when the tab changes", () => {
    testState.page = 4;
    render(<SellClaimsPage />);
    testState.setPage.mockClear();

    fireEvent.click(
      screen.getByRole("tab", { name: "resaleClaim.sellerTabResolved" }),
    );

    expect(testState.setPage).toHaveBeenCalledWith(0);
    expect(testState.setPage).not.toHaveBeenCalledWith(1);
  });

  it("sell/listings resets to page 0 (not 1) when the tab changes", () => {
    testState.page = 4;
    render(<SellListingsPage />);
    testState.setPage.mockClear();

    fireEvent.click(
      screen.getByRole("tab", { name: "admin.sellListingsSold" }),
    );

    expect(testState.setPage).toHaveBeenCalledWith(0);
    expect(testState.setPage).not.toHaveBeenCalledWith(1);
  });

  it("switching tabs re-queries with the new status filter at offset 0", () => {
    render(<SellListingsPage />);
    fireEvent.click(
      screen.getByRole("tab", { name: "admin.sellListingsSold" }),
    );

    // setPage is mocked, so `page` stays 0 here; the assertion that matters is
    // that the request for the new tab starts at the first window.
    expect(lastQueryInput(testState.resaleListMyListingsUseQuery).offset).toBe(
      0,
    );
  });

  // ── usePageClamp (real hook) ──────────────────────────────────────────────

  describe.each(PAGES)("$name page clamp", ({ Page, query }) => {
    it("snaps a stale ?p= page back to the last real page once data settles", () => {
      testState.page = 8; // ?p=9
      query.mockReturnValue(
        queryResult({ data: { items: [], total: 30 }, isFetching: false }),
      );

      render(<Page />);

      // 30 rows @ 25/page => 2 pages => last index 1.
      expect(testState.setPage).toHaveBeenCalledWith(1);
    });

    it("does not clamp while the query is still fetching", () => {
      testState.page = 8;
      query.mockReturnValue(
        queryResult({ data: undefined, isFetching: true, isLoading: true }),
      );

      render(<Page />);

      expect(testState.setPage).not.toHaveBeenCalled();
    });

    it("leaves an in-range page alone", () => {
      testState.page = 1;
      query.mockReturnValue(
        queryResult({ data: { items: [{}], total: 60 }, isFetching: false }),
      );

      render(<Page />);

      expect(testState.setPage).not.toHaveBeenCalled();
    });
  });

  // ── A failed query is NOT an empty dataset ────────────────────────────────
  // TanStack settles an error as `data: undefined, isLoading: false,
  // isFetching: false` — indistinguishable from "zero rows" if you read
  // `data?.total ?? 0`. Treating it as a 1-page dataset would clamp a
  // deep-linked `?p=5` to page 1 and rewrite the seller's URL on a transient
  // API failure, and would stack the empty copy under the error banner.

  describe.each(PAGES)(
    "$name error handling",
    ({ Page, query, errorKey, emptyKey }) => {
      it("does NOT clamp the page when the query failed (deep link survives)", () => {
        testState.page = 4; // ?p=5
        query.mockReturnValue(erroredQuery());

        render(<Page />);

        expect(testState.setPage).not.toHaveBeenCalled();
      });

      it("does NOT render the empty copy under the error banner", () => {
        query.mockReturnValue(erroredQuery());

        render(<Page />);

        expect(screen.queryByTestId("no-results")).not.toBeInTheDocument();
        expect(screen.queryByText(emptyKey)).not.toBeInTheDocument();
      });

      it("keeps the error message visible", () => {
        query.mockReturnValue(erroredQuery());

        render(<Page />);

        expect(screen.getByText(errorKey)).toBeInTheDocument();
      });

      it("still renders the table chrome and a 1-page pager while errored", () => {
        query.mockReturnValue(erroredQuery());

        render(<Page />);

        expect(
          screen.getByTestId("data-table-head").childElementCount,
        ).toBeGreaterThan(0);
        // `settledTotalPages ?? 1` — the pager stays mounted (rows-per-page) but
        // claims no page count it cannot substantiate.
        expect(screen.getByTestId("pagination")).toHaveAttribute(
          "data-total-pages",
          "1",
        );
      });

      it("resumes clamping once a successful refetch settles", () => {
        testState.page = 4;
        query.mockReturnValue(erroredQuery());
        const { rerender } = render(<Page />);
        expect(testState.setPage).not.toHaveBeenCalled();

        query.mockReturnValue(
          queryResult({ data: { items: [], total: 30 }, isFetching: false }),
        );
        rerender(<Page />);

        expect(testState.setPage).toHaveBeenCalledWith(1);
      });
    },
  );

  // ── Empty state keeps the table chrome ────────────────────────────────────

  describe.each(PAGES)("$name empty state", ({ Page, query }) => {
    it("renders NoResults INSIDE the table so the column headers survive", () => {
      query.mockReturnValue(
        queryResult({ data: { items: [], total: 0 }, isLoading: false }),
      );

      render(<Page />);

      const table = screen.getByTestId("data-table");
      expect(table).toBeInTheDocument();
      // Headers still present…
      expect(
        screen.getByTestId("data-table-head").childElementCount,
      ).toBeGreaterThan(0);
      // …and the empty copy sits in the body, not as a sibling replacing it.
      expect(screen.getByTestId("data-table-body")).toContainElement(
        screen.getByTestId("no-results"),
      );
    });

    it("suppresses the empty copy during the first load (no false 'nothing here' flash)", () => {
      query.mockReturnValue(
        queryResult({ data: undefined, isLoading: true, isFetching: true }),
      );

      render(<Page />);

      expect(screen.getByTestId("data-table")).toHaveAttribute(
        "data-loading",
        "true",
      );
      expect(screen.queryByTestId("no-results")).not.toBeInTheDocument();
    });
  });

  // ── Pagination is unconditional and gets `total` ──────────────────────────

  describe.each(PAGES)("$name pager", ({ Page, query }) => {
    it("renders the pager on a single page so rows-per-page stays reachable", () => {
      query.mockReturnValue(queryResult({ data: { items: [{}], total: 3 } }));

      render(<Page />);

      const pager = screen.getByTestId("pagination");
      expect(pager).toHaveAttribute("data-total-pages", "1");
      expect(pager).toHaveAttribute("data-total", "3");
    });

    it("passes the row total through so the range label can render", () => {
      testState.page = 1;
      query.mockReturnValue(queryResult({ data: { items: [{}], total: 128 } }));

      render(<Page />);

      const pager = screen.getByTestId("pagination");
      expect(pager).toHaveAttribute("data-total", "128");
      expect(pager).toHaveAttribute("data-page", "1");
      expect(pager).toHaveAttribute("data-total-pages", "6");
    });
  });
});
