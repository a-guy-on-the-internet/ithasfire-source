import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type TestOwner =
  | {
      kind: "human";
      humanId: string;
      humanName: string;
      humanUsername: string;
      adminSlug: string;
    }
  | {
      kind: "org";
      orgId: string;
      orgName: string;
      orgSlug: string;
      role: "OWNER" | "ADMIN" | "EDITOR" | "FINANCE" | "VIEWER" | "SCANNER";
      adminSlug: string;
    }
  | undefined;

interface TestOrder {
  id: string;
  eventId: string;
  eventTitle: string;
  orgId: string | null;
  buyerHumanId: string;
  buyerName: string | null;
  buyerEmail: string | null;
  amountGrossCents: number;
  feesPlatformCents: number;
  taxAmountCents: number;
  currency: string;
  status: string;
  source: string;
  stripePaymentIntentId: string | null;
  occurredAt: string;
}

interface MockDataTableProps {
  rows: TestOrder[];
  rowActions?: { render?: (row: TestOrder, index: number) => ReactNode };
  renderExpandedRow?: (row: TestOrder, index: number) => ReactNode;
  renderMobileCard?: (row: TestOrder) => ReactNode;
  onRowPress?: (row: TestOrder, index: number) => void;
  emptyState?: ReactNode;
}

const testState = vi.hoisted(() => ({
  currentOwner: undefined as TestOwner,
  ownerLoading: false,
  listOrgOrdersUseQuery: vi.fn(),
  listMyEventOrdersUseQuery: vi.fn(),
  requestExportUseMutation: vi.fn(),
  listOrgOrdersFetch: vi.fn(),
  listMyEventOrdersFetch: vi.fn(),
  orgRefetch: vi.fn(),
  humanRefetch: vi.fn(),
}));

const humanOrder: TestOrder = {
  id: "11111111-1111-4111-8111-111111111111",
  eventId: "22222222-2222-4222-8222-222222222222",
  eventTitle: "Human-Owned Show",
  orgId: null,
  buyerHumanId: "33333333-3333-4333-8333-333333333333",
  buyerName: "Casey Buyer",
  buyerEmail: "casey@example.com",
  amountGrossCents: 2500,
  feesPlatformCents: 250,
  taxAmountCents: 0,
  currency: "usd",
  status: "SUCCEEDED",
  source: "PRIMARY",
  stripePaymentIntentId: null,
  occurredAt: "2026-05-01T12:00:00.000Z",
};

const orgOrder: TestOrder = {
  ...humanOrder,
  id: "55555555-5555-4555-8555-555555555555",
  eventId: "66666666-6666-4666-8666-666666666666",
  eventTitle: "Org-Owned Show",
  orgId: "77777777-7777-4777-8777-777777777777",
};

vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "@human-admin" }),
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

vi.mock("@th/ui", () => ({
  // Opt-in class that collapses a cell's secondary line at compact density.
  DT_CELL_SUB_CLASS: "dt-cell-sub",
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
  DataTable: ({
    rows,
    rowActions,
    renderExpandedRow,
    renderMobileCard,
    onRowPress,
    emptyState,
  }: MockDataTableProps) => (
    <div data-testid="orders-table">
      {rows.length === 0
        ? emptyState
        : rows.map((row, index) => (
            <div key={row.id} data-testid={`orders-row-${row.id}`}>
              <button type="button" onClick={() => onRowPress?.(row, index)}>
                {row.eventTitle}
              </button>
              {rowActions?.render?.(row, index)}
              {renderMobileCard ? (
                <div data-testid={`orders-card-${row.id}`}>
                  {renderMobileCard(row)}
                </div>
              ) : null}
              {renderExpandedRow?.(row, index)}
            </div>
          ))}
    </div>
  ),
  Spinner: () => <span>Loading</span>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  // RowActionMenu builds on the shared Popover — render anchor + (open)
  // content inline so menu items stay reachable in jsdom.
  Popover: ({
    anchor,
    open,
    children,
  }: {
    anchor?: ReactNode;
    open?: boolean;
    children?: ReactNode;
  }) => (
    <>
      {anchor}
      {open ? children : null}
    </>
  ),
  useFormatters: () => ({}),
  useNotify: () => ({ toast: { success: vi.fn(), danger: vi.fn() } }),
  useTranslations: () => (key: string, params?: Record<string, unknown>) => {
    const dictionary: Record<string, string> = {
      "admin.orders": "Orders",
      "admin.loadingOrders": "Loading orders...",
      "admin.ordersOrgOnly": "Orders require a group",
      "admin.ordersOrgOnlyDescription":
        "The Orders view is available for group accounts.",
      "admin.ordersUnavailable": "Orders unavailable",
      "admin.ordersUnavailableDescription":
        "We couldn't resolve an admin workspace.",
      "admin.expandDetails": "Expand details",
      "admin.collapseDetails": "Collapse details",
      "admin.viewInStripe": "View in Stripe",
      "admin.nOfTotal": `${params?.start}-${params?.end} of ${params?.total} orders`,
    };

    return dictionary[key] ?? key;
  },
}));

vi.mock("@/trpc", () => ({
  trpc: {
    orders: {
      listOrgOrders: {
        useQuery: (...args: unknown[]) =>
          testState.listOrgOrdersUseQuery(...args),
      },
      listMyEventOrders: {
        useQuery: (...args: unknown[]) =>
          testState.listMyEventOrdersUseQuery(...args),
      },
      requestExport: {
        useMutation: (...args: unknown[]) =>
          testState.requestExportUseMutation(...args),
      },
    },
    useUtils: () => ({
      orders: {
        listOrgOrders: { fetch: testState.listOrgOrdersFetch },
        listMyEventOrders: { fetch: testState.listMyEventOrdersFetch },
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

vi.mock("@/hooks/useAdminTableParams", () => ({
  useAdminTableParams: () => ({
    searchQuery: "",
    debouncedSearch: "",
    page: 0,
    pageSize: 25,
    handleSearchChange: vi.fn(),
    setPage: vi.fn(),
    setPageSize: vi.fn(),
  }),
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
  ColumnSelector: () => <div data-testid="column-selector" />,
  FilterChips: () => <div data-testid="filter-chips" />,
  FilterRow: ({ children }: { children?: ReactNode }) => (
    <div data-testid="filter-row">{children}</div>
  ),
  NoResults: ({
    title,
    description,
  }: {
    title: string;
    description: string;
  }) => (
    <div>
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  ),
  Pagination: () => <div data-testid="pagination" />,
  SearchBar: ({
    value,
    placeholder,
  }: {
    value: string;
    placeholder: string;
  }) => <input aria-label={placeholder} value={value} readOnly />,
  TableContainer: ({ children }: { children?: ReactNode }) => (
    <div data-testid="table-container">{children}</div>
  ),
}));

vi.mock("@/app/admin/_components/AdminPageData", () => ({
  AdminPageData: ({
    children,
    loadingMessage,
  }: {
    children?: ReactNode;
    loadingMessage?: string;
  }) => <div data-testid="admin-page-data">{loadingMessage ?? children}</div>,
}));

vi.mock("@/lib/format", () => ({
  fmtCurrency: (_formatters: unknown, cents: number, currency: string) =>
    `${currency}:${cents}`,
  fmtDateCompact: () => "May 1",
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: () => "network failed",
}));

vi.mock("../OrderDetailPanel", () => ({
  OrderDetailPanel: ({ canRefundCash }: { canRefundCash?: boolean }) => (
    <div
      data-testid="order-detail"
      data-can-refund-cash={String(canRefundCash === true)}
    />
  ),
}));

vi.mock("../OrderStatusBadge", () => ({
  OrderStatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

vi.mock("@/components/data-table/RowActionMenu", () => ({
  RowActionMenu: ({
    items,
  }: {
    items: Array<{ key: string; label: string; onPress: () => void }>;
  }) => (
    <div>
      {items.map((item) => (
        <button key={item.key} type="button" onClick={item.onPress}>
          {item.label}
        </button>
      ))}
    </div>
  ),
}));

import { OrdersTable } from "../OrdersTable";

describe("OrdersTable", () => {
  beforeEach(() => {
    testState.currentOwner = {
      kind: "human",
      humanId: "44444444-4444-4444-8444-444444444444",
      humanName: "Human Admin",
      humanUsername: "human-admin",
      adminSlug: "@human-admin",
    };
    testState.ownerLoading = false;
    testState.listOrgOrdersUseQuery.mockReset();
    testState.listMyEventOrdersUseQuery.mockReset();
    testState.requestExportUseMutation.mockReset();
    testState.listOrgOrdersFetch.mockReset();
    testState.listMyEventOrdersFetch.mockReset();
    testState.orgRefetch.mockReset();
    testState.humanRefetch.mockReset();

    testState.listOrgOrdersUseQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: null,
      refetch: testState.orgRefetch,
    });
    testState.listMyEventOrdersUseQuery.mockReturnValue({
      data: {
        items: [humanOrder],
        pageInfo: { total: 1, hasNextPage: false, limit: 25, offset: 0 },
      },
      isLoading: false,
      error: null,
      refetch: testState.humanRefetch,
    });
    testState.requestExportUseMutation.mockReturnValue({
      isPending: false,
      mutate: vi.fn(),
    });
  });

  it("uses the human orders query for human owners without showing the organization-only gate", () => {
    render(<OrdersTable />);

    expect(testState.listMyEventOrdersUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 25,
        offset: 0,
        sort: "occurredAt_desc",
      }),
      expect.objectContaining({ enabled: true }),
    );
    expect(testState.listOrgOrdersUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "" }),
      expect.objectContaining({ enabled: false }),
    );

    expect(
      screen.queryByText("Orders require a group"),
    ).not.toBeInTheDocument();
    // Title renders in both the row button and the mobile card.
    expect(screen.getAllByText("Human-Owned Show").length).toBeGreaterThan(0);
    expect(
      screen.queryByRole("button", { name: "Expand details" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Human-Owned Show" }));
    expect(screen.queryByTestId("order-detail")).not.toBeInTheDocument();
  });

  it("shows a neutral unavailable state when the admin owner is unresolved", () => {
    testState.currentOwner = undefined;
    testState.listMyEventOrdersUseQuery.mockReturnValueOnce({
      data: undefined,
      isLoading: false,
      error: null,
      refetch: testState.humanRefetch,
    });

    render(<OrdersTable />);

    expect(screen.getByText("Orders unavailable")).toBeInTheDocument();
    expect(
      screen.queryByText("Orders require a group"),
    ).not.toBeInTheDocument();
    expect(testState.listMyEventOrdersUseQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false }),
    );
  });

  it("keeps org owners on the org orders query with expandable details", () => {
    testState.currentOwner = {
      kind: "org",
      orgId: "77777777-7777-4777-8777-777777777777",
      orgName: "Org Admin",
      orgSlug: "org-admin",
      role: "FINANCE",
      adminSlug: "org-admin",
    };
    testState.listOrgOrdersUseQuery.mockReturnValue({
      data: {
        items: [orgOrder],
        pageInfo: { total: 1, hasNextPage: false, limit: 25, offset: 0 },
      },
      isLoading: false,
      error: null,
      refetch: testState.orgRefetch,
    });

    render(<OrdersTable />);

    expect(testState.listOrgOrdersUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "77777777-7777-4777-8777-777777777777",
        limit: 25,
        offset: 0,
        sort: "occurredAt_desc",
      }),
      expect.objectContaining({ enabled: true }),
    );
    expect(testState.listMyEventOrdersUseQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false }),
    );

    // Title renders in both the row button and the mobile card.
    expect(screen.getAllByText("Org-Owned Show").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Expand details" }));
    expect(screen.getByTestId("order-detail")).toBeInTheDocument();
  });

  // Money out is Finance's job (2026-10-10): the Orders panel offers the cash
  // refund to every role that reads Orders, Owner, Admin and Finance. An
  // Editor cannot open Orders and refunds cash from Sell → Cash taken tonight
  // (owner ruling 2026-10-08).
  it.each([
    ["OWNER", true],
    ["ADMIN", true],
    ["FINANCE", true],
    ["EDITOR", false],
    ["VIEWER", false],
    ["SCANNER", false],
  ] as const)("offers the cash refund in the detail panel to %s: %s", (role, can) => {
    testState.currentOwner = {
      kind: "org",
      orgId: "77777777-7777-4777-8777-777777777777",
      orgName: "Org Admin",
      orgSlug: "org-admin",
      role,
      adminSlug: "org-admin",
    };
    testState.listOrgOrdersUseQuery.mockReturnValue({
      data: {
        items: [orgOrder],
        pageInfo: { total: 1, hasNextPage: false, limit: 25, offset: 0 },
      },
      isLoading: false,
      error: null,
      refetch: testState.orgRefetch,
    });

    render(<OrdersTable />);
    fireEvent.click(screen.getByRole("button", { name: "Expand details" }));
    expect(screen.getByTestId("order-detail")).toHaveAttribute(
      "data-can-refund-cash",
      String(can),
    );
  });

  it("renders mobile card content with a Stripe link for human owners (no expanded panel)", () => {
    const humanOrderWithPi = {
      ...humanOrder,
      stripePaymentIntentId: "pi_123",
    };
    testState.listMyEventOrdersUseQuery.mockReturnValue({
      data: {
        items: [humanOrderWithPi],
        pageInfo: { total: 1, hasNextPage: false, limit: 25, offset: 0 },
      },
      isLoading: false,
      error: null,
      refetch: testState.humanRefetch,
    });

    render(<OrdersTable />);

    const card = within(
      screen.getByTestId(`orders-card-${humanOrderWithPi.id}`),
    );
    expect(card.getByText("Casey Buyer")).toBeInTheDocument();
    expect(card.getByText("Human-Owned Show")).toBeInTheDocument();
    expect(card.getByText("SUCCEEDED")).toBeInTheDocument();
    expect(card.getByText("usd:2500")).toBeInTheDocument();
    expect(card.getByText("May 1")).toBeInTheDocument();

    // Human owners cannot expand a detail panel, so the Stripe action must
    // surface directly on the card.
    const stripeLink = card.getByRole("link", { name: /View in Stripe/i });
    expect(stripeLink).toHaveAttribute(
      "href",
      "https://dashboard.stripe.com/payments/pi_123",
    );
  });

  it("omits the card Stripe link for org owners (reachable via the expanded panel)", () => {
    testState.currentOwner = {
      kind: "org",
      orgId: "77777777-7777-4777-8777-777777777777",
      orgName: "Org Admin",
      orgSlug: "org-admin",
      role: "FINANCE",
      adminSlug: "org-admin",
    };
    const orgOrderWithPi = { ...orgOrder, stripePaymentIntentId: "pi_org" };
    testState.listOrgOrdersUseQuery.mockReturnValue({
      data: {
        items: [orgOrderWithPi],
        pageInfo: { total: 1, hasNextPage: false, limit: 25, offset: 0 },
      },
      isLoading: false,
      error: null,
      refetch: testState.orgRefetch,
    });

    render(<OrdersTable />);

    const card = within(
      screen.getByTestId(`orders-card-${orgOrderWithPi.id}`),
    );
    expect(card.getByText("Casey Buyer")).toBeInTheDocument();
    expect(card.queryByRole("link")).not.toBeInTheDocument();
  });
});
