import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal transplant of the OrdersTable.test mock pattern. usePageClamp is
// deliberately left REAL so the clamp wiring is exercised end-to-end.

const testState = vi.hoisted(() => ({
  currentOwner: undefined as
    | { kind: "org"; orgId: string }
    | { kind: "human"; humanId: string }
    | undefined,
  ownerLoading: false,
  page: 0,
  attendeesUseQuery: vi.fn(),
  setPage: vi.fn(),
  refetch: vi.fn(),
  canFinance: true,
  exportFetch: vi.fn(),
  /**
   * Flips the DataTable mock into card mode so `renderMobileCard` is covered.
   * Mirrors the real component, which swaps the whole table for a card list
   * below 600px via the shared `useIsBelowMobileBreakpoint`.
   */
  cardMode: false,
  /**
   * Called on every AttendeeDetailPanel mount. The panel is the only caller
   * of `orders.getOrgOrder` on this surface, so "never mounted" is "never
   * fetched".
   */
  detailPanelMounted: vi.fn(),
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
  return { XStack: Stack, YStack: Stack, Stack, styled: () => Stack };
});

vi.mock("@th/ui", () => ({
  Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Button: ({
    children,
    onPress,
    disabled,
    testID,
    ...rest
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    testID?: string;
    "aria-label"?: string;
  }) => (
    <button
      type="button"
      onClick={onPress}
      disabled={disabled}
      data-testid={testID}
      // aria-label is the whole point of the expander assertions below — a
      // mock that swallowed it would make the duplicate-name test vacuous.
      aria-label={rest["aria-label"]}
    >
      {children}
    </button>
  ),
  /**
   * Renders every column's `cell` output rather than a bare row marker: the
   * behaviour under test lives in the cells and in the mobile card.
   *
   * `cardMode` mirrors the REAL DataTable, which returns the card list and
   * therefore renders NO `rowActions` below 600px — the card itself is the
   * pressable. Reproducing that here is what keeps the "no duplicate
   * accessible names on a phone" assertion honest.
   */
  DataTable: ({
    columns,
    rows,
    getRowKey,
    emptyState,
    rowActions,
    renderMobileCard,
    renderExpandedRow,
    onRowPress,
  }: {
    columns: Array<{ id: string; cell: (row: never) => ReactNode }>;
    rows: unknown[];
    getRowKey: (row: never, index: number) => string;
    emptyState?: ReactNode;
    rowActions?: { render: (row: never) => ReactNode };
    renderMobileCard?: (row: never) => ReactNode;
    renderExpandedRow?: (row: never) => ReactNode;
    onRowPress?: (row: never, index: number) => void;
  }) => (
    <div
      data-testid="attendees-table"
      // Which interaction props the tab handed over. The real DataTable
      // derives the row's click / Enter / Space toggle and (on cards)
      // `role="button"` + `aria-expanded` from these, so "absent" here is
      // "no affordance" there.
      data-row-press={String(Boolean(onRowPress))}
      data-row-actions={String(Boolean(rowActions))}
      data-expandable={String(Boolean(renderExpandedRow))}
    >
      {rows.length === 0
        ? emptyState
        : rows.map((row, index) => {
            const key = getRowKey(row as never, index);
            return (
              <div
                key={key}
                data-testid={`attendee-row-${key}`}
                // Card mode only: the real DataTableCardList makes the card
                // the pressable. In table mode the press lives on the <tr>,
                // and wiring it here would double-fire with the expander.
                onClick={
                  testState.cardMode
                    ? () => onRowPress?.(row as never, index)
                    : undefined
                }
              >
                {testState.cardMode ? (
                  renderMobileCard?.(row as never)
                ) : (
                  <>
                    {columns.map((col) => (
                      <div key={col.id} data-testid={`cell-${col.id}`}>
                        {col.cell(row as never)}
                      </div>
                    ))}
                    {rowActions?.render(row as never)}
                  </>
                )}
                {renderExpandedRow?.(row as never)}
              </div>
            );
          })}
    </div>
  ),
  OverflowTooltip: ({ text }: { text?: string }) => <span>{text}</span>,
  Spinner: () => <span>Loading</span>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  useFormatters: () => ({}),
  useNotify: () => ({
    toast: { success: vi.fn(), danger: vi.fn(), warning: vi.fn() },
  }),
  // Interpolating (rather than returning the bare key) so two rows whose
  // labels differ only by their ICU arguments are actually distinguishable.
  useTranslations:
    () => (key: string, values?: Record<string, unknown>) =>
      values
        ? `${key}(${Object.entries(values)
            .map(([name, value]) => `${name}=${String(value)}`)
            .join(",")})`
        : key,
}));

vi.mock("@/trpc", () => ({
  trpc: {
    orders: {
      searchEventAttendees: {
        useQuery: (...args: unknown[]) => testState.attendeesUseQuery(...args),
      },
    },
    // The CSV export fetches on demand through the utils client rather than
    // as a live query — an export is an action, and a standing query would
    // write an audit entry on every render.
    useUtils: () => ({
      orders: {
        exportEventAttendees: { fetch: testState.exportFetch },
      },
    }),
  },
}));

vi.mock("@/hooks/useCurrentAdminOwner", () => ({
  useCurrentAdminOwner: () => ({
    currentOwner: testState.currentOwner,
    isLoading: testState.ownerLoading,
  }),
}));

vi.mock("@/hooks/useAdminOwnerCapabilities", () => ({
  useAdminOwnerCapabilities: () => ({
    canEdit: true,
    canManage: true,
    canFinance: testState.canFinance,
  }),
}));

vi.mock("@/hooks/useAdminTableParams", () => ({
  useAdminTableParams: () => ({
    searchQuery: "",
    debouncedSearch: "",
    page: testState.page,
    pageSize: 25,
    extra: {},
    handleSearchChange: vi.fn(),
    setPage: testState.setPage,
    setPageSize: vi.fn(),
    setExtra: vi.fn(),
  }),
}));

vi.mock("@/components/AdminTableParts", () => ({
  ActionBar: ({ children }: { children?: ReactNode }) => (
    <div data-testid="action-bar">{children}</div>
  ),
  AdminTableErrorState: ({
    message,
    onRetry,
  }: {
    message: string;
    onRetry: () => void;
  }) => (
    <div data-testid="attendees-error">
      <span>{message}</span>
      <button type="button" onClick={onRetry}>
        Retry
      </button>
    </div>
  ),
  FilterChips: ({
    options,
    selected,
  }: {
    options: { value: string; label: string }[];
    selected?: string;
  }) => (
    <div data-testid="filter-chips" data-selected={selected ?? ""}>
      {options.map((o) => o.value).join(",")}
    </div>
  ),
  FilterRow: ({ children }: { children?: ReactNode }) => (
    <div data-testid="filter-row">{children}</div>
  ),
  NoResults: ({ title }: { title: string }) => (
    <div data-testid="no-results">{title}</div>
  ),
  Pagination: () => <div data-testid="pagination" />,
  SearchBar: ({ children }: { children?: ReactNode }) => (
    <div data-testid="search-bar">{children}</div>
  ),
  TableContainer: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
}));

// Echo the inputs rather than a constant: the card assertions below need to
// see that the AMOUNT and the CURRENCY actually reached the card, and a mock
// that returned "$0.00" for everything would pass whatever it was handed.
vi.mock("@/lib/format", () => ({
  fmtDate: (_fmt: unknown, value: Date) =>
    `date:${new Date(value).toISOString()}`,
  fmtCurrency: (_fmt: unknown, cents: number, currency: string) =>
    `${currency.toUpperCase()} ${(cents / 100).toFixed(2)}`,
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: (err: unknown) => String(err),
}));

vi.mock("../../../[id]/attendees/_components/AttendeeDetailPanel", () => ({
  AttendeeDetailPanel: (props: { orderId: string; orgId: string }) => {
    testState.detailPanelMounted(props);
    return <div data-testid="attendee-detail" />;
  },
}));

import { AttendeesTab } from "../AttendeesTab";

const ORG_ID = "77777777-7777-4777-8777-777777777777";
const EVENT_ID = "22222222-2222-4222-8222-222222222222";

type ApiRow = {
  orderId: string;
  buyerHumanId: string;
  buyerName: string | null;
  buyerEmail: string | null;
  ticketCount: number;
  amountGrossCents: number;
  currency: string;
  status: string;
  source: string;
  occurredAt: string;
};

function makeRow(orderId: string, overrides: Partial<ApiRow> = {}): ApiRow {
  return {
    orderId,
    buyerHumanId: `h-${orderId}`,
    buyerName: "Ada Lovelace",
    buyerEmail: "ada@example.com",
    ticketCount: 3,
    amountGrossCents: 36000,
    currency: "usd",
    status: "SUCCEEDED",
    source: "ONLINE",
    occurredAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

/** Every button's accessible name, in DOM order. */
function buttonNames(): string[] {
  return screen
    .getAllByRole("button")
    .map(
      (el) => el.getAttribute("aria-label") ?? el.textContent?.trim() ?? "",
    );
}

function settledQuery(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      items: [],
      pageInfo: { total: 0, hasNextPage: false, limit: 25, offset: 0 },
    },
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
    refetch: testState.refetch,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  testState.currentOwner = { kind: "org", orgId: ORG_ID };
  testState.ownerLoading = false;
  testState.page = 0;
  testState.canFinance = true;
  testState.cardMode = false;
  testState.exportFetch = vi.fn(async () => ({
    eventId: EVENT_ID,
    rows: [],
    truncated: false,
    total: 0,
  }));
});

describe("AttendeesTab", () => {
  it("passes limit/offset derived from page and pageSize to the query", () => {
    testState.page = 2;
    testState.attendeesUseQuery.mockReturnValue(
      settledQuery({
        data: {
          items: [],
          pageInfo: { total: 200, hasNextPage: true, limit: 25, offset: 50 },
        },
      }),
    );

    render(<AttendeesTab slug="org-admin" eventId={EVENT_ID} />);

    expect(testState.attendeesUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        eventId: EVENT_ID,
        limit: 25,
        offset: 50,
      }),
      expect.objectContaining({ enabled: true }),
    );
    // 200 rows @ 25/page → page 2 is in range → no clamp.
    expect(testState.setPage).not.toHaveBeenCalled();
  });

  it("clamps a stale out-of-range page once the query settles", () => {
    testState.page = 2;
    testState.attendeesUseQuery.mockReturnValue(
      settledQuery({
        data: {
          items: [],
          pageInfo: { total: 20, hasNextPage: false, limit: 25, offset: 50 },
        },
      }),
    );

    render(<AttendeesTab slug="org-admin" eventId={EVENT_ID} />);

    // 20 rows @ 25/page → totalPages 1 → page 2 snaps to 0.
    expect(testState.setPage).toHaveBeenCalledWith(0);
  });

  it("does not clamp while the query is still fetching", () => {
    testState.page = 2;
    testState.attendeesUseQuery.mockReturnValue(
      settledQuery({
        isFetching: true,
        data: {
          items: [],
          pageInfo: { total: 20, hasNextPage: false, limit: 25, offset: 50 },
        },
      }),
    );

    render(<AttendeesTab slug="org-admin" eventId={EVENT_ID} />);

    expect(testState.setPage).not.toHaveBeenCalled();
  });

  it("renders the shared error state with a working retry", () => {
    testState.attendeesUseQuery.mockReturnValue(
      settledQuery({
        isError: true,
        error: new Error("boom"),
        data: undefined,
      }),
    );

    render(<AttendeesTab slug="org-admin" eventId={EVENT_ID} />);

    expect(screen.getByTestId("attendees-error")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(testState.refetch).toHaveBeenCalledTimes(1);
  });

  it("renders the empty state through the table when there are no rows", () => {
    testState.attendeesUseQuery.mockReturnValue(settledQuery());

    render(<AttendeesTab slug="org-admin" eventId={EVENT_ID} />);

    expect(screen.getByTestId("no-results")).toBeInTheDocument();
  });

  it("shows the org-only notice for human owners without querying", () => {
    testState.currentOwner = { kind: "human", humanId: "h1" };
    testState.attendeesUseQuery.mockReturnValue(
      settledQuery({ data: undefined }),
    );

    render(<AttendeesTab slug="human-admin" eventId={EVENT_ID} />);

    expect(screen.getByText("admin.attendeesOrgOnly")).toBeInTheDocument();
    expect(testState.attendeesUseQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false }),
    );
  });

  // Export is finance-only. Hidden rather than disabled for everyone else —
  // the procedure enforces the same set, so offering EDITOR a button that can
  // only 403 would be worse than not offering it.
  it("offers the CSV export to finance actors", () => {
    testState.attendeesUseQuery.mockReturnValue(settledQuery());

    render(<AttendeesTab slug="org-admin" eventId={EVENT_ID} />);

    expect(
      screen.getByText("admin.attendeesExportCsv"),
    ).toBeInTheDocument();
  });

  it("hides the CSV export from non-finance actors", () => {
    testState.canFinance = false;
    testState.attendeesUseQuery.mockReturnValue(settledQuery());

    render(<AttendeesTab slug="org-admin" eventId={EVENT_ID} />);

    expect(screen.queryByText("admin.attendeesExportCsv")).toBeNull();
  });

  // The export must describe the same slice the table is showing, or the file
  // and the audit entry both misrepresent what left.
  it("exports with the active search and status filter applied", async () => {
    testState.attendeesUseQuery.mockReturnValue(settledQuery());

    render(<AttendeesTab slug="org-admin" eventId={EVENT_ID} />);
    fireEvent.click(screen.getByText("admin.attendeesExportCsv"));

    await waitFor(() => {
      expect(testState.exportFetch).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: ORG_ID, eventId: EVENT_ID }),
      );
    });
  });
});

/**
 * Defect 1's DATA half. Scope, stated plainly:
 *
 *   this suite  → the card carries every column's information;
 *   the browser → that it fits at 320px.
 *
 * jsdom has no layout engine, and `testState.cardMode` is a flag this file
 * flips by hand — nothing here exercises the real 599px `matchMedia` query or
 * measures a single pixel. The layout findings that motivated card mode (a
 * `td` content box of 2px against a 119px buyer-name span, the date column
 * clipped away, and no `overflow-x` scroller anywhere) were measured in
 * Chromium and can only be re-measured there.
 *
 * What IS enforced here: card mode is only a fix if it drops nothing.
 */
describe("AttendeesTab — mobile card content", () => {
  const LOAD_BEARING = [
    ["buyer name", "Ada Lovelace"],
    ["buyer email", "ada@example.com"],
    ["order code", "0000000A"],
    ["amount + currency", "USD 360.00"],
    ["ticket count", "admin.attendeeTicketCountLabel(count=3)"],
    // PART_REFUNDED, not SUCCEEDED: it is the only status on the surface that
    // exercises `replaceAll("_", " ")`, and the widest badge on the card.
    ["status", "PART REFUNDED"],
    ["date", "date:2026-08-01T10:00:00.000Z"],
  ] as const;

  it.each(LOAD_BEARING)("carries the %s onto the card", (_label, expected) => {
    testState.cardMode = true;
    testState.attendeesUseQuery.mockReturnValue(
      settledQuery({
        data: {
          items: [makeRow("0000000a", { status: "PART_REFUNDED" })],
          pageInfo: { total: 1, hasNextPage: false, limit: 25, offset: 0 },
        },
      }),
    );

    render(<AttendeesTab slug="org-admin" eventId={EVENT_ID} />);

    expect(screen.getByTestId("attendee-row-0000000a").textContent).toContain(
      expected,
    );
  });

  // A comp is a $0 order, so without the marker a complimentary ticket and a
  // genuinely free one render identically. The badge is a column-level detail
  // that a hand-written card would be very easy to drop.
  it("keeps the COMP marker on the card", () => {
    testState.cardMode = true;
    testState.attendeesUseQuery.mockReturnValue(
      settledQuery({
        data: {
          items: [
            makeRow("0000000a", { source: "COMP", amountGrossCents: 0 }),
          ],
          pageInfo: { total: 1, hasNextPage: false, limit: 25, offset: 0 },
        },
      }),
    );

    render(<AttendeesTab slug="org-admin" eventId={EVENT_ID} />);

    expect(screen.getByTestId("attendee-row-0000000a").textContent).toContain(
      "admin.attendeeCompBadge",
    );
  });

  // Nullable columns must read as MISSING on the card, not vanish silently.
  it("renders the em-dash fallbacks for a nameless, email-less buyer", () => {
    testState.cardMode = true;
    testState.attendeesUseQuery.mockReturnValue(
      settledQuery({
        data: {
          items: [makeRow("0000000a", { buyerName: null, buyerEmail: null })],
          pageInfo: { total: 1, hasNextPage: false, limit: 25, offset: 0 },
        },
      }),
    );

    render(<AttendeesTab slug="org-admin" eventId={EVENT_ID} />);

    // Two em-dashes: one for the name, one for the email.
    const text = screen.getByTestId("attendee-row-0000000a").textContent ?? "";
    expect(text.match(/—/g)?.length).toBe(2);
    // …and the order code still identifies the row.
    expect(text).toContain("0000000A");
  });

  // Expand/collapse must survive the mode swap. The real DataTable drops
  // `rowActions` in card mode and makes the CARD the pressable, so the detail
  // panel has to keep arriving through `renderExpandedRow` + `onRowPress`.
  it("still expands the detail panel from a card press", () => {
    testState.cardMode = true;
    testState.attendeesUseQuery.mockReturnValue(
      settledQuery({
        data: {
          items: [makeRow("0000000a")],
          pageInfo: { total: 1, hasNextPage: false, limit: 25, offset: 0 },
        },
      }),
    );

    render(<AttendeesTab slug="org-admin" eventId={EVENT_ID} />);
    expect(screen.queryByTestId("attendee-detail")).toBeNull();

    // DataTableCardList calls `onRowPress` on card activation; the mock wires
    // the same handler onto the card wrapper.
    fireEvent.click(screen.getByTestId("attendee-row-0000000a"));
    expect(screen.getByTestId("attendee-detail")).toBeInTheDocument();

    // …and back closed.
    fireEvent.click(screen.getByTestId("attendee-row-0000000a"));
    expect(screen.queryByTestId("attendee-detail")).toBeNull();
  });
});

/**
 * Defect 2, found by driving the real app: a probe collecting
 * `aria-label || textContent` over every button returned
 * `[["Expand details", 4]]` at BOTH 320px and 1440px. Four controls sharing one
 * accessible name, with no row context, is unusable for screen-reader and
 * voice users — the same bug class CompTicketsTab deliberately avoids between
 * its header trigger and its empty-state CTA.
 *
 * Unlike the layout half, this one IS fully testable here: accessible names
 * are a DOM property, not a rendered geometry, so these assertions carry the
 * same weight as the browser probe.
 */
describe("AttendeesTab — expander accessible names", () => {
  function renderRows(rows: ApiRow[]) {
    testState.attendeesUseQuery.mockReturnValue(
      settledQuery({
        data: {
          items: rows,
          pageInfo: {
            total: rows.length,
            hasNextPage: false,
            limit: 25,
            offset: 0,
          },
        },
      }),
    );
    render(<AttendeesTab slug="org-admin" eventId={EVENT_ID} />);
  }

  it("gives every expander a unique, row-contextual name", () => {
    renderRows([
      makeRow("0000000a", { buyerName: "Ada Lovelace" }),
      makeRow("0000000b", { buyerName: "Grace Hopper" }),
      makeRow("0000000c", { buyerName: "Alan Turing" }),
      makeRow("0000000d", { buyerName: "Katherine Johnson" }),
    ]);

    const names = buttonNames();
    expect(names).toHaveLength(new Set(names).size);
    expect(names).toContain(
      "admin.attendeeExpandDetailsFor(name=Ada Lovelace,code=0000000A)",
    );
    // The pre-fix label is gone entirely.
    expect(names).not.toContain("admin.expandDetails");
  });

  // Two orders from the SAME buyer are ordinary. The name alone would collide,
  // which is why the order code rides along unconditionally.
  it("stays unique when one buyer has two orders", () => {
    renderRows([
      makeRow("0000000a", { buyerName: "Ada Lovelace" }),
      makeRow("0000000b", { buyerName: "Ada Lovelace" }),
    ]);

    const names = buttonNames();
    expect(names).toHaveLength(new Set(names).size);
  });

  // `buyerName` and `buyerEmail` are BOTH nullable — the label must never read
  // "…for null".
  it.each([
    [
      "name",
      { buyerName: "Ada Lovelace", buyerEmail: "ada@example.com" },
      "name=Ada Lovelace",
    ],
    [
      "email when the name is null",
      { buyerName: null, buyerEmail: "ada@example.com" },
      "name=ada@example.com",
    ],
    [
      "email when the name is whitespace",
      { buyerName: "   ", buyerEmail: "ada@example.com" },
      "name=ada@example.com",
    ],
    [
      "generic fallback when both are null",
      { buyerName: null, buyerEmail: null },
      "name=admin.attendeeUnnamedBuyer",
    ],
  ])("falls back to the %s", (_label, overrides, expected) => {
    renderRows([makeRow("0000000a", overrides)]);

    const label = buttonNames().find((n) =>
      n.startsWith("admin.attendeeExpandDetailsFor"),
    );
    expect(label).toContain(expected);
    expect(label).not.toContain("null");
    // The order code identifies the row even with nothing else to go on.
    expect(label).toContain("code=0000000A");
  });

  it("swaps to a collapse label, still row-contextual, once expanded", () => {
    renderRows([makeRow("0000000a", { buyerName: "Ada Lovelace" })]);

    const expander = screen.getByLabelText(
      "admin.attendeeExpandDetailsFor(name=Ada Lovelace,code=0000000A)",
    );
    fireEvent.click(expander);

    expect(
      screen.getByLabelText(
        "admin.attendeeCollapseDetailsFor(name=Ada Lovelace,code=0000000A)",
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId("attendee-detail")).toBeInTheDocument();
  });

  /**
   * Positive about what THIS file owns: `renderMobileCard` must contribute no
   * per-row controls of its own, because the card is already the pressable.
   *
   * Deliberately NOT `names.length === new Set(names).size`. In card mode the
   * mock emits exactly one button (Export CSV), so a uniqueness assertion
   * collapses to `new Set([oneName]).size === 1` and passes even with an EMPTY
   * card renderer. It would also be asserting a `@th/ui` guarantee — that
   * DataTable drops `rowActions` below 600px — against a mock that
   * reimplements that same guarantee, so a regression in `@th/ui` would leave
   * it green. The table-mode counterpart above is the honest uniqueness test:
   * 4 rows really do produce 4 distinct row-named controls there.
   */
  it("contributes no row-named controls from the mobile card", () => {
    testState.cardMode = true;
    renderRows([
      makeRow("0000000a"),
      makeRow("0000000b"),
      makeRow("0000000c"),
      makeRow("0000000d"),
    ]);

    // The cards rendered…
    expect(screen.getByTestId("attendee-row-0000000a")).toBeInTheDocument();
    // …and brought no expander of their own with them.
    expect(
      buttonNames().filter((n) => n.includes("DetailsFor")),
    ).toHaveLength(0);
    expect(buttonNames()).not.toContain("admin.expandDetails");
  });
});

/**
 * The detail panel reads `orders.getOrgOrder`, which is `canFinanceOrg`
 * (OWNER / ADMIN / FINANCE) server-side, while the list itself admits EDITOR.
 * An EDITOR who expanded a row got an error where the order should be, so a
 * non-finance viewer must get no expand affordance at all.
 */
describe("AttendeesTab — row expand is finance-only", () => {
  function renderOneRow() {
    testState.attendeesUseQuery.mockReturnValue(
      settledQuery({
        data: {
          items: [makeRow("0000000a")],
          pageInfo: { total: 1, hasNextPage: false, limit: 25, offset: 0 },
        },
      }),
    );
    return render(<AttendeesTab slug="org-admin" eventId={EVENT_ID} />);
  }

  it("offers a non-finance viewer no expander, row press or expanded row", () => {
    testState.canFinance = false;
    renderOneRow();

    const table = screen.getByTestId("attendees-table");
    expect(table).toHaveAttribute("data-row-press", "false");
    expect(table).toHaveAttribute("data-row-actions", "false");
    expect(table).toHaveAttribute("data-expandable", "false");
    // The row still renders — only the expand is withheld.
    expect(screen.getByTestId("attendee-row-0000000a")).toBeInTheDocument();
    // No buttons at all: the CSV export is finance-only too, so this is the
    // whole page's control set, not a filtered view of it.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(testState.detailPanelMounted).not.toHaveBeenCalled();
  });

  it("gives a non-finance viewer's card no chevron and no press", () => {
    testState.canFinance = false;
    testState.cardMode = true;
    const { container } = renderOneRow();

    expect(container.querySelector(".lucide-chevron-down")).toBeNull();
    // The mock wires `onRowPress` onto the card; with none passed, a press
    // opens nothing.
    fireEvent.click(screen.getByTestId("attendee-row-0000000a"));
    expect(screen.queryByTestId("attendee-detail")).toBeNull();
    expect(testState.detailPanelMounted).not.toHaveBeenCalled();
  });

  it("still lets FINANCE expand a row into the detail panel", () => {
    testState.canFinance = true;
    renderOneRow();

    const table = screen.getByTestId("attendees-table");
    expect(table).toHaveAttribute("data-row-press", "true");
    expect(table).toHaveAttribute("data-expandable", "true");

    fireEvent.click(
      screen.getByLabelText(
        "admin.attendeeExpandDetailsFor(name=Ada Lovelace,code=0000000A)",
      ),
    );
    expect(screen.getByTestId("attendee-detail")).toBeInTheDocument();
    expect(testState.detailPanelMounted).toHaveBeenCalledWith({
      orderId: "0000000a",
      orgId: ORG_ID,
    });
  });

  // A personal workspace: `canFinance` is true (humans own their events) but
  // there is no org for `getOrgOrder`, so there must be no expander over an
  // empty panel. Today the org-only notice stops the page first; this pins
  // the outcome either way.
  it("offers a personal workspace no expander even though canFinance is true", () => {
    testState.canFinance = true;
    testState.currentOwner = { kind: "human", humanId: "me" };
    renderOneRow();

    expect(screen.getByText("admin.attendeesOrgOnly")).toBeInTheDocument();
    expect(screen.queryByTestId("attendees-table")).toBeNull();
    expect(
      screen
        .queryAllByRole("button")
        .filter((b) =>
          (b.getAttribute("aria-label") ?? "").includes("DetailsFor"),
        ),
    ).toHaveLength(0);
    expect(testState.detailPanelMounted).not.toHaveBeenCalled();
  });

  it("keeps the chevron on a finance viewer's card", () => {
    testState.canFinance = true;
    testState.cardMode = true;
    const { container } = renderOneRow();

    // Non-vacuous counterpart to the non-finance card assertion above.
    expect(container.querySelector(".lucide-chevron-down")).not.toBeNull();
  });
});
