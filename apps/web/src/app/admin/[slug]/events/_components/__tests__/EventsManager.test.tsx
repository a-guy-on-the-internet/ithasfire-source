import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface TestEvent {
  id: string;
  title: string | null;
  status: string;
  startsAt: Date | null;
  endsAt: Date | null;
  slug: string | null;
  shortId: string | null;
  visibility: "PUBLIC" | "PRIVATE" | "UNLISTED";
  addressText: string | null;
  placeId: string | null;
  placeName: string | null;
  ticketsSold: number;
  createdAt: Date;
  updatedAt: Date | null;
}

interface MockDataTableProps {
  columns: Array<{ id: string; cell: (row: TestEvent) => ReactNode }>;
  rows: TestEvent[];
  getRowKey: (row: TestEvent) => string;
  emptyState?: ReactNode;
  density?: string;
}

const testState = vi.hoisted(() => ({
  cancelOptions: {} as { onSuccess?: (result: unknown) => void },
  toast: {
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    danger: vi.fn(),
  },
  listQuery: vi.fn(),
  refetch: vi.fn(),
  setPage: vi.fn(),
  setExtra: vi.fn(),
  handleSearchChange: vi.fn(),
  extra: {} as Record<string, string | undefined>,
  debouncedSearch: "",
  dataTableProps: null as MockDataTableProps | null,
  tableParamsOptions: undefined as { extraKeys?: string[] } | undefined,
}));

const ORG_ID = "77777777-7777-4777-8777-777777777777";

const baseEvent: TestEvent = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Basement Show",
  status: "PUBLISHED",
  startsAt: new Date("2026-09-01T00:00:00.000Z"),
  endsAt: null,
  slug: "basement-show",
  shortId: "bsmt",
  visibility: "PUBLIC",
  addressText: "123 Main St",
  placeId: null,
  placeName: null,
  ticketsSold: 12,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: null,
};

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
    Spinner: () => null,
    styled: () => Stack,
  };
});

vi.mock("@th/ui", () => ({
  // Opt-in class that collapses a cell's secondary line at compact density.
  DT_CELL_SUB_CLASS: "dt-cell-sub",
  Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Button: ({
    children,
    onPress,
    disabled,
    ...rest
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    "aria-pressed"?: boolean;
  }) => (
    <button
      type="button"
      onClick={onPress}
      disabled={disabled}
      aria-pressed={rest["aria-pressed"]}
    >
      {children}
    </button>
  ),
  DataTable: (props: MockDataTableProps) => {
    testState.dataTableProps = props;
    return (
      <div data-testid="events-table">
        {props.rows.length === 0
          ? props.emptyState
          : props.rows.map((row) => (
              <div key={props.getRowKey(row)} data-testid="events-row">
                {row.title}
              </div>
            ))}
      </div>
    );
  },
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  useFormatters: () => ({}),
  useNotify: () => ({ toast: testState.toast }),
  useTranslations:
    () => (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${Object.values(params).join(" ")}` : key,
}));

vi.mock("@/trpc", () => ({
  trpc: {
    events: {
      listMine: { useQuery: (...args: unknown[]) => testState.listQuery(...args) },
      getCalendarInfo: { useQuery: () => ({ data: undefined }) },
      getEventForEdit: { useQuery: () => ({ data: undefined, isLoading: false }) },
      cancelEvent: {
        useMutation: (options: { onSuccess?: (result: unknown) => void }) => {
          testState.cancelOptions = options;
          return { mutate: vi.fn(), isPending: false };
        },
      },
      deleteEvent: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
    series: {
      cancelEventSeries: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
    },
    volunteer: {
      signups: { statusCountsBatch: { useQuery: () => ({ data: {} }) } },
    },
    stripeConnect: { getStatus: { useQuery: () => ({ data: undefined }) } },
  },
}));

vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => false }));

vi.mock("@/hooks/useAdminTableParams", () => ({
  useAdminTableParams: (options?: { extraKeys?: string[] }) => {
    testState.tableParamsOptions = options;
    return {
      searchQuery: testState.debouncedSearch,
      debouncedSearch: testState.debouncedSearch,
      page: 0,
      pageSize: 25,
      extra: testState.extra,
      handleSearchChange: testState.handleSearchChange,
      setPage: testState.setPage,
      setPageSize: vi.fn(),
      setExtra: testState.setExtra,
    };
  },
}));

vi.mock("@/hooks/useColumnVisibility", () => ({
  useColumnVisibility: () => ({
    isVisible: () => true,
    toggleColumn: vi.fn(),
    showAll: vi.fn(),
    hasHidden: false,
  }),
}));

vi.mock("@/components/AdminTableParts", () => ({
  ActionBar: ({
    children,
    countLabel,
  }: {
    children?: ReactNode;
    countLabel?: ReactNode;
  }) => (
    <div data-testid="action-bar">
      <span>{countLabel}</span>
      {children}
    </div>
  ),
  AdminTableErrorState: ({ message }: { message: string }) => (
    <div data-testid="admin-table-error">{message}</div>
  ),
  ColumnSelector: () => <div data-testid="column-selector" />,
  FilterChips: ({
    options,
    selected,
    onSelect,
  }: {
    options: Array<{ value: string; label: string }>;
    selected?: string;
    onSelect: (value: string | undefined) => void;
  }) => (
    <div data-testid="filter-chips">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          data-selected={selected === opt.value}
          onClick={() => onSelect(selected === opt.value ? undefined : opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  ),
  FilterRow: ({
    children,
    hasActiveFilters,
    onClearAll,
  }: {
    children?: ReactNode;
    hasActiveFilters: boolean;
    onClearAll: () => void;
  }) => (
    <div data-testid="filter-row" data-active={String(hasActiveFilters)}>
      {children}
      <button type="button" onClick={onClearAll}>
        Clear all
      </button>
    </div>
  ),
  // Mirrors the real NoResults: its clear button is labelled DISTINCTLY from
  // FilterRow's so the two never collide on accessible name.
  NoResults: ({
    title,
    description,
    onClearFilters,
    clearLabel,
  }: {
    title: string;
    description?: string;
    onClearFilters?: () => void;
    clearLabel?: string;
  }) => (
    <div data-testid="no-results">
      <span>{title}</span>
      {description && <span>{description}</span>}
      {onClearFilters && (
        <button type="button" onClick={onClearFilters}>
          {clearLabel ?? "admin.atClearFiltersShowAll"}
        </button>
      )}
    </div>
  ),
  Pagination: ({ total }: { total?: number }) => (
    <div data-testid="pagination">total:{String(total)}</div>
  ),
  // Functional on purpose: a readOnly stub would leave the whole search path
  // (debounce → query input → sub-minimum guard) unexercised.
  SearchBar: ({
    value,
    onChangeText,
    maxLength,
  }: {
    value: string;
    onChangeText: (next: string) => void;
    maxLength?: number;
  }) => (
    <input
      aria-label="search"
      value={value}
      maxLength={maxLength}
      onChange={(e) => onChangeText(e.target.value)}
    />
  ),
  SkeletonEmptyState: ({ title }: { title: string }) => (
    <div data-testid="skeleton-empty">{title}</div>
  ),
  TableContainer: ({ children }: { children?: ReactNode }) => (
    <div data-testid="table-container">{children}</div>
  ),
}));

vi.mock("@/components/data-table/RowActionMenu", () => ({
  RowActionMenu: () => <div data-testid="row-action-menu" />,
}));

vi.mock("@/components/data-table/ConfirmDialog", () => ({
  ConfirmDialog: () => null,
}));

vi.mock("../EventStatusBadge", () => ({
  EventStatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

vi.mock("../EventMobileCard", () => ({
  EventMobileCard: () => <div data-testid="event-mobile-card" />,
}));

vi.mock("../ShareEventDialog", () => ({ ShareEventDialog: () => null }));

vi.mock("../../../_components/AdminPageHeader", () => ({
  AdminPageHeader: ({ trailing }: { trailing?: ReactNode }) => (
    <div data-testid="admin-page-header">{trailing}</div>
  ),
}));

vi.mock("@/app/admin/_components/AdminPageData", () => ({
  AdminPageData: ({ loadingMessage }: { loadingMessage?: string }) => (
    <div data-testid="admin-page-data">{loadingMessage}</div>
  ),
}));

vi.mock("@/lib/format", () => ({ fmtDate: () => "Sep 1" }));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: () => "boom",
}));

import { EventsManager } from "../EventsManager";

const ownerContext = { kind: "org" as const, orgId: ORG_ID };

function mockListSuccess(items: TestEvent[], total = items.length) {
  testState.listQuery.mockReturnValue({
    data: {
      items,
      pageInfo: {
        total,
        limit: 25,
        offset: 0,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    },
    isLoading: false,
    error: null,
    refetch: testState.refetch,
  });
}

describe("EventsManager", () => {
  beforeEach(() => {
    localStorage.clear();
    testState.listQuery.mockReset();
    testState.refetch.mockReset();
    testState.setPage.mockReset();
    testState.setExtra.mockReset();
    testState.handleSearchChange.mockReset();
    testState.extra = {};
    testState.debouncedSearch = "";
    testState.dataTableProps = null;
    testState.tableParamsOptions = undefined;
    mockListSuccess([baseEvent]);
  });

  function lastQueryInput() {
    return testState.listQuery.mock.calls.at(-1)?.[0] as {
      query?: string;
      status?: string[];
    };
  }

  it("keeps search in the FilterRow above the ActionBar (not nested inside it)", () => {
    render(<EventsManager ownerContext={ownerContext} />);

    const filterRow = screen.getByTestId("filter-row");
    const actionBar = screen.getByTestId("action-bar");
    const search = screen.getByLabelText("search");

    expect(filterRow).toContainElement(search);
    expect(actionBar).not.toContainElement(search);
  });

  it("renders resting chips unselected — no All chip — and sends no status scope", () => {
    render(<EventsManager ownerContext={ownerContext} />);

    // Chip grammar: resting = nothing selected = the default (all statuses).
    // Exactly the five lifecycle scopes — an extra "All" chip would be a
    // sixth button and would sit permanently lit.
    expect(
      screen.getByTestId("filter-chips").querySelectorAll("button"),
    ).toHaveLength(5);
    for (const label of [
      "admin.eventStatusDraft",
      "admin.eventStatusPublished",
      "admin.eventStatusCompleted",
      "admin.eventStatusCancelled",
      "admin.eventStatusArchived",
    ]) {
      expect(screen.getByText(label).closest("button")).toHaveAttribute(
        "data-selected",
        "false",
      );
    }

    expect(testState.listQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerType: "ORGANIZATION",
        ownerId: ORG_ID,
        status: undefined,
        limit: 25,
        offset: 0,
      }),
      expect.anything(),
    );
    expect(screen.getByTestId("filter-row")).toHaveAttribute(
      "data-active",
      "false",
    );
  });

  // NOTE: useAdminTableParams is mocked, so this can only prove the handler
  // calls BOTH setters — the actual React batching into one commit is the
  // hook's own contract, covered by useAdminTableParams.test.ts.
  it("writes the chip to ?status and asks for a page reset alongside it", () => {
    render(<EventsManager ownerContext={ownerContext} />);

    fireEvent.click(screen.getByText("admin.eventStatusDraft"));
    expect(testState.setExtra).toHaveBeenCalledWith("status", "DRAFT");
    expect(testState.setPage).toHaveBeenCalledWith(0);
  });

  it("threads a URL-synced status into the query as a one-element array and deselects back to all", () => {
    testState.extra = { status: "DRAFT" };
    render(<EventsManager ownerContext={ownerContext} />);

    expect(testState.listQuery).toHaveBeenCalledWith(
      expect.objectContaining({ status: ["DRAFT"] }),
      expect.anything(),
    );
    expect(
      screen.getByText("admin.eventStatusDraft").closest("button"),
    ).toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("filter-row")).toHaveAttribute(
      "data-active",
      "true",
    );

    fireEvent.click(screen.getByText("admin.eventStatusDraft"));
    expect(testState.setExtra).toHaveBeenCalledWith("status", undefined);
  });

  it("normalises an unrecognised ?status back to the default scope", () => {
    testState.extra = { status: "banana" };
    render(<EventsManager ownerContext={ownerContext} />);

    expect(testState.listQuery).toHaveBeenCalledWith(
      expect.objectContaining({ status: undefined }),
      expect.anything(),
    );
    expect(screen.getByTestId("filter-row")).toHaveAttribute(
      "data-active",
      "false",
    );
  });

  it("lets a caller-pinned statusFilter win and hides the chips entirely", () => {
    testState.extra = { status: "DRAFT" };
    render(
      <EventsManager ownerContext={ownerContext} statusFilter={["PUBLISHED"]} />,
    );

    expect(testState.listQuery).toHaveBeenCalledWith(
      expect.objectContaining({ status: ["PUBLISHED"] }),
      expect.anything(),
    );
    expect(screen.queryByTestId("filter-chips")).not.toBeInTheDocument();
    // A pinned scope is not a user filter — it must not light "Clear filters".
    expect(screen.getByTestId("filter-row")).toHaveAttribute(
      "data-active",
      "false",
    );
    // …and the surface stops MANAGING ?status, so the hook cannot keep
    // rewriting a param that lies about a scope the user can't change.
    expect(testState.tableParamsOptions?.extraKeys).toEqual([]);
  });

  it("manages ?status only when the scope is the user's to change", () => {
    render(<EventsManager ownerContext={ownerContext} />);
    expect(testState.tableParamsOptions?.extraKeys).toEqual(["status"]);
  });

  it("shows a describing empty state — never the create-first CTA — for a pinned scope with no rows", () => {
    mockListSuccess([], 0);
    render(
      <EventsManager ownerContext={ownerContext} statusFilter={["ARCHIVED"]} />,
    );

    // The onboarding skeleton would be a dead end: the caller pinned the
    // scope, so "create your first event" cannot resolve the empty state.
    expect(screen.queryByTestId("skeleton-empty")).not.toBeInTheDocument();
    const noResults = screen.getByTestId("no-results");
    expect(noResults).toBeInTheDocument();
    // No clear button — the pinned scope is not the user's to clear.
    expect(noResults.querySelector("button")).toBeNull();
  });

  it("still offers the clear button when a PINNED scope also carries an active search", () => {
    // Pinning forces `chipStatus` undefined, but it does NOT hide the search
    // box — so the search is still the user's to clear. This is why the
    // empty-state chain tests `hasActiveFilters` BEFORE `isStatusPinned`;
    // reversing them strands the user on a no-clear dead end.
    testState.debouncedSearch = "zz";
    mockListSuccess([], 0);
    render(
      <EventsManager ownerContext={ownerContext} statusFilter={["ARCHIVED"]} />,
    );

    const noResults = screen.getByTestId("no-results");
    expect(noResults).toHaveTextContent("admin.noMatchingEvents");
    fireEvent.click(screen.getByText("admin.atClearFiltersShowAll"));
    expect(testState.handleSearchChange).toHaveBeenCalledWith("");
  });

  it("clears search and status together", () => {
    testState.extra = { status: "DRAFT" };
    render(<EventsManager ownerContext={ownerContext} />);

    fireEvent.click(screen.getByText("Clear all"));
    expect(testState.handleSearchChange).toHaveBeenCalledWith("");
    expect(testState.setExtra).toHaveBeenCalledWith("status", undefined);
    expect(testState.setPage).toHaveBeenCalledWith(0);
  });

  it("keeps the filter row reachable when a status scope yields zero rows", () => {
    testState.extra = { status: "CANCELLED" };
    mockListSuccess([], 0);
    render(<EventsManager ownerContext={ownerContext} />);

    // NOT the create-first skeleton: with a filter active the user must be
    // able to clear it rather than be stranded on an onboarding CTA.
    expect(screen.getByTestId("no-results")).toBeInTheDocument();
    expect(screen.queryByTestId("skeleton-empty")).not.toBeInTheDocument();

    // Distinct accessible names: FilterRow's clear and NoResults' clear are
    // both on screen here and must not collide (the passkey-rename class).
    fireEvent.click(screen.getByText("admin.atClearFiltersShowAll"));
    expect(testState.setExtra).toHaveBeenCalledWith("status", undefined);
    const names = screen.getAllByRole("button").map((b) => b.textContent);
    expect(new Set(names).size).toBe(names.length);
  });

  it("shows the plain NoResults empty state — matching OrdersTable — when nothing is filtered", () => {
    mockListSuccess([], 0);
    // `onCreateEvent` wired: this is the editor path, where the header DOES
    // render the primary CTA and the empty state carries its description.
    render(
      <EventsManager ownerContext={ownerContext} onCreateEvent={() => {}} />,
    );

    // The 300px ghost-row skeleton with its overlay CTA is GONE: the page
    // header already owns the one primary "Create event" action, so the
    // overlay button was a duplicate primary in the same viewport.
    expect(screen.queryByTestId("skeleton-empty")).not.toBeInTheDocument();

    const noResults = screen.getByTestId("no-results");
    expect(noResults).toHaveTextContent("admin.noEventsYet");
    expect(noResults).toHaveTextContent("admin.getStartedEvents");
    // No clear button — there is nothing to clear on a pristine table.
    expect(noResults.querySelector("button")).toBeNull();
  });

  it("shows the loader — never the pristine empty copy — before the first page arrives", () => {
    // The `if (isLoading && !data)` early return is what actually prevents a
    // "No events yet" flash on cold load. DataTable's own 200ms deferred
    // skeleton does NOT protect this surface: with keepPreviousData the
    // `isLoading` it receives is effectively always false, so the guard above
    // it is load-bearing and untested until now.
    testState.listQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
      refetch: testState.refetch,
    });
    render(<EventsManager ownerContext={ownerContext} />);

    expect(screen.getByTestId("admin-page-data")).toHaveTextContent(
      "admin.loadingEvents",
    );
    expect(screen.queryByTestId("no-results")).toBeNull();
  });

  it("drops the create-oriented description when no create button renders", () => {
    mockListSuccess([], 0);

    // Read-only role (org VIEWER/FINANCE/SCANNER): no header CTA, so the
    // imperative "get started by creating your first event" has nothing to
    // act on. Title only.
    const { unmount } = render(
      <EventsManager ownerContext={ownerContext} canEdit={false} />,
    );
    let noResults = screen.getByTestId("no-results");
    expect(noResults).toHaveTextContent("admin.noEventsYet");
    expect(noResults).not.toHaveTextContent("admin.getStartedEvents");
    unmount();

    // Same when the createEvents feature gate closes the button.
    const { unmount: unmount2 } = render(
      <EventsManager ownerContext={ownerContext} showCreateButton={false} />,
    );
    noResults = screen.getByTestId("no-results");
    expect(noResults).not.toHaveTextContent("admin.getStartedEvents");
    unmount2();

    // …and when no create handler is wired at all.
    render(<EventsManager ownerContext={ownerContext} />);
    expect(screen.getByTestId("no-results")).not.toHaveTextContent(
      "admin.getStartedEvents",
    );
  });

  it("keeps the table chrome mounted for the pristine-empty state (Orders parity)", () => {
    mockListSuccess([], 0);
    render(<EventsManager ownerContext={ownerContext} />);

    // The empty block sits INSIDE the bordered table container, under the
    // ActionBar — previously the pristine branch dropped the chrome entirely
    // and floated a bare skeleton on the page.
    expect(screen.getByTestId("action-bar")).toBeInTheDocument();
    const container = screen.getByTestId("table-container");
    expect(container).toContainElement(screen.getByTestId("no-results"));
  });

  it("passes the honest total to Pagination so the range label renders", () => {
    mockListSuccess([baseEvent], 42);
    render(<EventsManager ownerContext={ownerContext} />);

    expect(screen.getByTestId("pagination")).toHaveTextContent("total:42");
  });

  it("omits a sub-minimum search query instead of sending a guaranteed BAD_REQUEST", () => {
    // 1 char < the server's min(2) — must be sent as "no query".
    testState.debouncedSearch = "a";
    const { unmount } = render(<EventsManager ownerContext={ownerContext} />);
    expect(lastQueryInput().query).toBeUndefined();
    unmount();

    // 2+ chars go to the server, which filters BEFORE paginating.
    testState.listQuery.mockClear();
    testState.debouncedSearch = "ab";
    render(<EventsManager ownerContext={ownerContext} />);
    expect(lastQueryInput().query).toBe("ab");
  });

  it("caps the search box at the server max and feeds the debounced param hook", () => {
    render(<EventsManager ownerContext={ownerContext} />);

    const input = screen.getByLabelText("search");
    expect(input).toHaveAttribute("maxlength", "140");

    fireEvent.change(input, { target: { value: "basement" } });
    expect(testState.handleSearchChange).toHaveBeenCalledWith("basement");
  });

  it("renders the server's rows verbatim — no client-side re-filtering", () => {
    // A stale client filter would drop this row (title has no "zzz") and
    // desync the table from the total the pager reports.
    testState.debouncedSearch = "zzz";
    mockListSuccess([baseEvent], 1);
    render(<EventsManager ownerContext={ownerContext} />);

    expect(screen.getByTestId("events-row")).toHaveTextContent("Basement Show");
  });

  it("keeps the header and filters mounted when the query fails", () => {
    testState.listQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("nope"),
      refetch: testState.refetch,
    });
    render(<EventsManager ownerContext={ownerContext} />);

    expect(screen.getByTestId("admin-table-error")).toHaveTextContent("boom");
    // A filter/search-induced failure must be recoverable in place, not only
    // via Retry (which would re-send the same bad input).
    expect(screen.getByLabelText("search")).toBeInTheDocument();
    expect(screen.getByTestId("filter-chips")).toBeInTheDocument();
  });

  it("toggles row density and persists it per-table", () => {
    render(<EventsManager ownerContext={ownerContext} />);

    expect(testState.dataTableProps?.density).toBe("comfortable");

    const toggle = screen.getByText("Density").closest("button")!;
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(toggle);
    expect(testState.dataTableProps?.density).toBe("compact");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(localStorage.getItem("admin-events-density")).toBe("compact");
  });

  // Same report as the event builder (cancel-event-toasts): the list's
  // Cancel no longer drops the counts that need a person.
  it("reports a cancellation's leftovers, not just that it happened", () => {
    render(<EventsManager ownerContext={ownerContext} />);
    testState.cancelOptions.onSuccess?.({
      refundedOrderCount: 1,
      failedRefundCount: 2,
      refundedCashOrderCount: 3,
      failedCashRefundCount: 0,
      cashRefundScanFailed: false,
      failedPendingPosVoidCount: 0,
      pendingPosScanFailed: false,
    });
    expect(testState.toast.success).toHaveBeenCalledWith(
      expect.objectContaining({ id: "event-cancelled" }),
    );
    expect(testState.toast.warning).toHaveBeenCalledWith(
      expect.objectContaining({ id: "event-cancel-refund-failures" }),
    );
    expect(testState.toast.info).toHaveBeenCalledWith(
      expect.objectContaining({ id: "event-cancel-cash-refunded" }),
    );
  });
});
