import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface TestPlace {
  placeId: string;
  name: string;
  formattedAddress: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  countryCode: string | null;
  capacity: number | null;
  lat: number | null;
  lng: number | null;
  eventsCount: number;
  status: string;
  verificationStatus: string;
  activeVerificationRequestStatus: "PENDING" | "IN_REVIEW" | null;
  listedInDirectory: boolean;
  createdAt: Date;
  access: { orgIds: string[]; humanIds: string[] };
}

interface MockColumn {
  id: string;
  header: ReactNode;
  cell: (row: TestPlace) => ReactNode;
}

interface MockDataTableProps {
  columns: MockColumn[];
  rows: TestPlace[];
  getRowKey: (row: TestPlace) => string;
  emptyState?: ReactNode;
  sort?: { columnId: string; direction: "asc" | "desc" };
  onSortChange?: (next: { columnId: string; direction: "asc" | "desc" }) => void;
  rowActions?: { render: (row: TestPlace) => ReactNode };
}

const testState = vi.hoisted(() => ({
  listQuery: vi.fn(),
  refetch: vi.fn(),
  setPage: vi.fn(),
  setExtra: vi.fn(),
  handleSearchChange: vi.fn(),
  extra: {} as Record<string, string | undefined>,
  debouncedSearch: "",
  pageSize: 25 as number,
  hiddenColumns: new Set<string>(),
  canEdit: true,
  canManage: true,
  eligibility: { eligible: true, reasons: [] as string[] },
  dataTableProps: null as MockDataTableProps | null,
  seatingLayouts: false,
  csvSubmit: null as
    | ((rows: Record<string, string>[]) => Promise<unknown>)
    | null,
}));

const ORG_ID = "77777777-7777-4777-8777-777777777777";

/**
 * Hoisted so the spy survives re-renders. Nothing in this table may call it
 * any more (FR-013) — it exists purely so the "never called" assertion is
 * about a REAL spy rather than a per-render throwaway that can't record.
 */
const updateVerificationMutateAsync = vi.hoisted(() => vi.fn());

/**
 * Hoisted so the SAME spy survives every re-render of the table — the create
 * flow now spans two commits (open the dialog, then submit it), so a
 * per-render throwaway would record nothing.
 */
type MutationPayload = Record<string, unknown>;
const upsertMutateAsync = vi.hoisted(() =>
  vi.fn((_payload: MutationPayload) =>
    Promise.resolve({ placeId: "22222222-2222-4222-8222-222222222222" }),
  ),
);
const bulkUpsertMutateAsync = vi.hoisted(() =>
  vi.fn((_payload: MutationPayload) =>
    Promise.resolve({ total: 1, imported: 1, skipped: 0 }),
  ),
);

const basePlace: TestPlace = {
  placeId: "11111111-1111-4111-8111-111111111111",
  name: "The Velvet Room",
  formattedAddress: "123 Main St",
  addressLine1: "123 Main St",
  addressLine2: null,
  city: "Portland",
  region: "OR",
  postalCode: "97201",
  countryCode: "US",
  capacity: 250,
  lat: null,
  lng: null,
  eventsCount: 3,
  status: "ACTIVE",
  verificationStatus: "UNVERIFIED",
  activeVerificationRequestStatus: null,
  listedInDirectory: true,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  access: { orgIds: [ORG_ID], humanIds: [] },
};

vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "org-admin" }),
}));

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
    // The New place dialog renders the shared address-privacy control, which
    // reads icon colours off the theme.
    useTheme: () => ({}),
  };
});

vi.mock("@th/ui", () => {
  // NewPlaceDialog renders through the real Modal compound component; mock it
  // down to bare DOM so the assertions are about THIS surface's payload, not
  // the design system's overlay machinery.
  const Modal = ({
    open,
    children,
  }: {
    open: boolean;
    children?: ReactNode;
  }) => (open ? <div data-testid="modal">{children}</div> : null);
  Modal.Panel = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  Modal.Header = ({ title }: { title: string }) => <h2>{title}</h2>;
  Modal.Body = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  Modal.Footer = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );

  return {
    Modal,
    TextInput: ({
      value,
      onChangeText,
      testId,
    }: {
      value?: string;
      onChangeText?: (v: string) => void;
      testId?: string;
    }) => (
      <input
        data-testid={testId}
        value={value}
        onChange={(e) => onChangeText?.(e.target.value)}
      />
    ),
    // Opt-in class that collapses a cell's secondary line at compact density.
    DT_CELL_SUB_CLASS: "dt-cell-sub",
    Badge: ({ children, tone }: { children?: ReactNode; tone?: string }) => (
      <span data-tone={tone}>{children}</span>
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
    DataTable: (props: MockDataTableProps) => {
      testState.dataTableProps = props;
      return (
        <div data-testid="places-table">
          {props.rows.length === 0
            ? props.emptyState
            : props.rows.map((row) => (
                <div key={props.getRowKey(row)} data-testid="places-row">
                  {props.columns.map((col) => (
                    <div key={col.id} data-testid={`cell-${col.id}`}>
                      {col.cell(row)}
                    </div>
                  ))}
                  <div data-testid="row-actions">
                    {props.rowActions?.render(row)}
                  </div>
                </div>
              ))}
        </div>
      );
    },
    Text: ({ children, tone }: { children?: ReactNode; tone?: string }) => (
      <span data-tone={tone}>{children}</span>
    ),
    Tooltip: ({
      anchor,
      children,
    }: {
      anchor?: ReactNode;
      children?: ReactNode;
    }) => (
      <>
        {anchor}
        {children}
      </>
    ),
    useNotify: () => ({ toast: { success: vi.fn(), danger: vi.fn() } }),
    // PlaceLocationPrivacyFields formats the radius in the page's locale.
    useLocale: () => "en",
    useTranslations:
      () => (key: string, params?: Record<string, unknown>) =>
        params ? `${key} ${Object.values(params).join(" ")}` : key,
  };
});

vi.mock("@/trpc", () => ({
  trpc: {
    places: {
      listHumanPlaces: {
        useQuery: (...args: unknown[]) => testState.listQuery(...args),
      },
      updatePlaceStatus: {
        useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
      },
      upsertPlace: {
        useMutation: () => ({
          mutateAsync: upsertMutateAsync,
          isPending: false,
        }),
      },
      bulkUpsertPlaces: {
        useMutation: () => ({
          mutateAsync: bulkUpsertMutateAsync,
          isPending: false,
        }),
      },
      updatePlaceVerificationStatus: {
        useMutation: () => ({
          mutateAsync: updateVerificationMutateAsync,
          isPending: false,
        }),
      },
    },
    useUtils: () => ({
      places: { listHumanPlaces: { invalidate: vi.fn() } },
    }),
  },
}));

vi.mock("@/hooks/useEventOwnerEntities", () => ({
  useEventOwnerEntities: () => ({
    ownersWithSlugs: [
      { kind: "org", orgId: ORG_ID, orgName: "Org", orgSlug: "org-admin" },
    ],
  }),
}));

vi.mock("@/hooks/useCurrentAdminOwner", () => ({
  useCurrentAdminOwner: () => ({
    currentOwner: {
      kind: "org",
      orgId: ORG_ID,
      orgName: "Org",
      orgSlug: "org-admin",
      role: "OWNER",
      adminSlug: "org-admin",
    },
  }),
}));

vi.mock("@/hooks/useAdminOwnerCapabilities", () => ({
  useAdminOwnerCapabilities: () => ({
    canEdit: testState.canEdit,
    canManage: testState.canManage,
  }),
}));

vi.mock("@/hooks/useFeatureGates", () => ({
  useFeatureGates: () => ({ gates: { seatingLayouts: testState.seatingLayouts } }),
}));

vi.mock("@/hooks/useIsMobile", () => ({
  useIsMobile: () => false,
}));

vi.mock("@/hooks/useAdminTableParams", () => ({
  useAdminTableParams: () => ({
    searchQuery: testState.debouncedSearch,
    debouncedSearch: testState.debouncedSearch,
    page: 0,
    pageSize: testState.pageSize,
    extra: testState.extra,
    handleSearchChange: testState.handleSearchChange,
    setPage: testState.setPage,
    setPageSize: vi.fn(),
    setExtra: testState.setExtra,
  }),
}));

vi.mock("@/hooks/useColumnVisibility", () => ({
  useColumnVisibility: () => ({
    isVisible: (id: string) => !testState.hiddenColumns.has(id),
    toggleColumn: vi.fn(),
    showAll: vi.fn(),
    hasHidden: testState.hiddenColumns.size > 0,
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
  AdminTableErrorState: ({
    message,
    onRetry,
  }: {
    message: string;
    onRetry: () => void;
  }) => (
    <div data-testid="admin-table-error">
      <span>{message}</span>
      <button type="button" onClick={onRetry}>
        Retry
      </button>
    </div>
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
          onClick={() =>
            onSelect(selected === opt.value ? undefined : opt.value)
          }
        >
          {opt.label}
        </button>
      ))}
    </div>
  ),
  FilterRow: ({ children }: { children?: ReactNode }) => (
    <div data-testid="filter-row">{children}</div>
  ),
  // Mirrors the real NoResults: its clear button is labelled DISTINCTLY from
  // FilterRow's so the two never collide on accessible name. Keeping the old
  // "Clear filters" literal here would have been a green test asserting a
  // string the product no longer renders.
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
  Pagination: ({
    total,
    pageSize,
    totalPages,
  }: {
    total?: number;
    pageSize?: number;
    totalPages?: number;
  }) => (
    <div
      data-testid="pagination"
      data-page-size={String(pageSize)}
      data-total-pages={String(totalPages)}
    >
      total:{String(total)}
    </div>
  ),
  SearchBar: ({ value }: { value: string }) => (
    <input aria-label="search" value={value} readOnly />
  ),
  SkeletonEmptyState: ({
    title,
    ctaLabel,
    onCtaPress,
  }: {
    title: string;
    ctaLabel: string;
    onCtaPress: () => void;
  }) => (
    <div data-testid="skeleton-empty">
      <span>{title}</span>
      <button type="button" onClick={onCtaPress}>
        {ctaLabel}
      </button>
    </div>
  ),
  TableContainer: ({ children }: { children?: ReactNode }) => (
    <div data-testid="table-container">{children}</div>
  ),
}));

vi.mock("@/components/data-table/RowActionMenu", () => ({
  // Renders each item's label as a real (pressable) control so tests can
  // assert on which actions are present (e.g. the seatingLayouts-gated Layout
  // item) AND invoke them, without opening the real Popover-based menu.
  RowActionMenu: ({
    items,
  }: {
    items: Array<{
      key: string;
      label: string;
      disabled?: boolean;
      onPress?: () => void;
    }>;
  }) => (
    <div data-testid="row-action-menu">
      {items.map((item) => (
        <button
          type="button"
          key={item.key}
          data-testid={`row-action-${item.key}`}
          disabled={item.disabled}
          onClick={item.onPress}
        >
          {item.label}
        </button>
      ))}
    </div>
  ),
}));

// FR-013: the row action opens the SHARED verification modal (the same
// component the place editor and /verify render). Its internals have their own
// suite — here we only prove the row action reaches it with the right place.
vi.mock("../RequestVerificationModal", () => ({
  RequestVerificationModal: ({
    open,
    placeId,
    placeName,
    onClose,
  }: {
    open: boolean;
    placeId: string;
    placeName: string;
    onClose: () => void;
  }) =>
    open ? (
      <div data-testid="verify-modal" data-place-id={placeId}>
        <span>{placeName}</span>
        <button type="button" onClick={onClose}>
          close-verify-modal
        </button>
      </div>
    ) : null,
}));

vi.mock("../PlaceDetailPanel", () => ({
  PlaceDetailPanel: () => <div data-testid="place-detail-panel" />,
}));

// Renders nothing, but captures `onSubmit` so the CSV row → mutation payload
// mapping can be exercised without driving the whole upload/mapping wizard.
// NOTE the path: `vi.mock` resolves relative to THIS file, while PlacesTable's
// import resolves relative to `_components/`. The old mock here pointed at
// `places/_components/CsvImportDialog`, which does not exist — so it mocked
// nothing and the real dialog rendered.
vi.mock("../../../_components/CsvImportDialog", () => ({
  CsvImportDialog: (props: {
    onSubmit: (rows: Record<string, string>[]) => Promise<unknown>;
  }) => {
    testState.csvSubmit = props.onSubmit;
    return null;
  },
}));

vi.mock("../../_components/AdminPageHeader", () => ({
  AdminPageHeader: ({ trailing }: { trailing?: ReactNode }) => (
    <div data-testid="admin-page-header">{trailing}</div>
  ),
}));

vi.mock("@/app/admin/_components/AdminPageData", () => ({
  AdminPageData: ({
    loadingMessage,
  }: {
    children?: ReactNode;
    loadingMessage?: string;
  }) => <div data-testid="admin-page-data">{loadingMessage}</div>,
}));

vi.mock("@th/core/use-cases/places", () => ({
  getPlaceVerificationEligibility: () => testState.eligibility,
}));

vi.mock("@/lib/crypto-utils", () => ({
  buildFreshClientKey: () => "ck-test",
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: () => "boom",
}));

import { PlacesTable } from "../PlacesTable";

function mockListSuccess(places: TestPlace[], total = places.length) {
  testState.listQuery.mockReturnValue({
    data: {
      places,
      pageInfo: { total, limit: 25, offset: 0, hasNextPage: false },
    },
    isLoading: false,
    error: null,
    refetch: testState.refetch,
  });
}

describe("PlacesTable", () => {
  beforeEach(() => {
    testState.listQuery.mockReset();
    testState.refetch.mockReset();
    testState.setPage.mockReset();
    testState.setExtra.mockReset();
    testState.handleSearchChange.mockReset();
    testState.extra = {};
    testState.debouncedSearch = "";
    testState.pageSize = 25;
    testState.hiddenColumns = new Set();
    testState.canEdit = true;
    testState.canManage = true;
    testState.eligibility = { eligible: true, reasons: [] };
    testState.dataTableProps = null;
    updateVerificationMutateAsync.mockClear();
    upsertMutateAsync.mockClear();
    bulkUpsertMutateAsync.mockClear();
    testState.seatingLayouts = false;
    testState.csvSubmit = null;
    mockListSuccess([basePlace]);
  });

  it("queries with server sort, explicit status scope, and verified filter defaults", () => {
    render(<PlacesTable />);

    expect(testState.listQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 25,
        offset: 0,
        sort: { field: "name", direction: "asc" },
        status: "active",
        verifiedOnly: false,
        orgIds: [ORG_ID],
      }),
      expect.anything(),
    );
  });

  it("renders resting chips unselected — no Active chip — and selects non-default scopes", () => {
    render(<PlacesTable />);

    // Standard admin-table chip grammar: resting = no chip selected = the
    // ACTIVE default scope. An "Active" chip would sit permanently lit.
    expect(
      screen.queryByText("admin.placesActiveStatus"),
    ).not.toBeInTheDocument();
    for (const label of [
      "admin.placesArchivedStatus",
      "admin.placesAllStatuses",
      "admin.placesVerifiedOnly",
    ]) {
      expect(screen.getByText(label).closest("button")).toHaveAttribute(
        "data-selected",
        "false",
      );
    }

    // Selecting a non-default scope writes the param with a same-commit
    // page reset (not just the hook's post-commit effect).
    fireEvent.click(screen.getByText("admin.placesArchivedStatus"));
    expect(testState.setExtra).toHaveBeenCalledWith("status", "archived");
    expect(testState.setPage).toHaveBeenCalledWith(0);
  });

  it("threads URL-synced extras into the query and deselects back to the active default", () => {
    testState.extra = { status: "archived", verified: "1" };
    render(<PlacesTable />);

    expect(testState.listQuery).toHaveBeenCalledWith(
      expect.objectContaining({ status: "archived", verifiedOnly: true }),
      expect.anything(),
    );

    // Chips reflect the URL state…
    expect(
      screen.getByText("admin.placesArchivedStatus").closest("button"),
    ).toHaveAttribute("data-selected", "true");

    // …and clicking the selected chip deselects — the param is dropped and
    // the scope falls back to the active default.
    fireEvent.click(screen.getByText("admin.placesArchivedStatus"));
    expect(testState.setExtra).toHaveBeenCalledWith("status", undefined);

    fireEvent.click(screen.getByText("admin.placesVerifiedOnly"));
    expect(testState.setExtra).toHaveBeenCalledWith("verified", undefined);
  });

  it("ignores sort requests for non-server-sortable columns and resets the page for real ones", () => {
    render(<PlacesTable />);

    // Verification cannot be server-sorted — the request is dropped.
    act(() => {
      testState.dataTableProps?.onSortChange?.({
        columnId: "verification",
        direction: "desc",
      });
    });
    expect(testState.setPage).not.toHaveBeenCalled();
    expect(testState.listQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({ sort: { field: "name", direction: "asc" } }),
      expect.anything(),
    );

    // A server-backed column re-sorts the full set and rewinds to page 0.
    act(() => {
      testState.dataTableProps?.onSortChange?.({
        columnId: "created",
        direction: "desc",
      });
    });
    expect(testState.setPage).toHaveBeenCalledWith(0);
    expect(testState.listQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sort: { field: "created", direction: "desc" },
      }),
      expect.anything(),
    );
  });

  it("clamps a stale ?ps=100 consistently across limit, offset, totalPages, and the pager", () => {
    // listHumanPlaces caps `limit` at 50. Clamping ONLY `limit` desynced the
    // window from the pager: the server returns 50 rows while the pager
    // advances by 100, so rows 50–99 of every window are unreachable and
    // totalPages under-counts — and usePageClamp then acts on that bad count.
    testState.pageSize = 100;
    mockListSuccess([basePlace], 200);
    render(<PlacesTable />);

    const input = testState.listQuery.mock.calls.at(-1)?.[0] as {
      limit: number;
      offset: number;
    };
    expect(input.limit).toBe(50);
    expect(input.offset).toBe(0);

    const pager = screen.getByTestId("pagination");
    // 200 rows / 50 per window = 4 pages, not the 2 the raw ?ps=100 implies.
    expect(pager).toHaveAttribute("data-total-pages", "4");
    expect(pager).toHaveAttribute("data-page-size", "50");
  });

  it("renders the published events count and the honest total", () => {
    render(<PlacesTable />);

    expect(screen.getByTestId("cell-events")).toHaveTextContent("3");
    expect(screen.getByTestId("pagination")).toHaveTextContent("total:1");
  });

  it("shows the in-cell verification icon only when the verification column is hidden", () => {
    const { unmount } = render(<PlacesTable />);
    // Column visible → badge column owns the fact; no in-cell tooltip copy.
    expect(
      screen.queryByText("admin.placesUnverifiedDescription"),
    ).not.toBeInTheDocument();
    unmount();

    testState.hiddenColumns = new Set(["verification"]);
    render(<PlacesTable />);
    expect(
      screen.getByText("admin.placesUnverifiedDescription"),
    ).toBeInTheDocument();
  });

  it("maps empty states onto the shared chrome by filter context", () => {
    // Pristine → the plain NoResults block OrdersTable uses. The 300px
    // ghost-row skeleton with its overlay CTA is GONE: the page header
    // already owns the one primary "New place" action, so the overlay button
    // was a duplicate primary in the same viewport.
    mockListSuccess([]);
    const { unmount } = render(<PlacesTable />);
    expect(screen.queryByTestId("skeleton-empty")).not.toBeInTheDocument();
    const pristine = screen.getByTestId("no-results");
    expect(pristine).toHaveTextContent("admin.placesEmptyActive");
    expect(pristine).toHaveTextContent("admin.placesEmptyCreateDescription");
    // No clear button — there is nothing to clear on a pristine table.
    expect(pristine.querySelector("button")).toBeNull();
    unmount();

    // Non-default filter → NoResults with clear-filters.
    testState.extra = { status: "archived" };
    render(<PlacesTable />);
    expect(screen.getByTestId("no-results")).toBeInTheDocument();
    fireEvent.click(screen.getByText("admin.atClearFiltersShowAll"));
    expect(testState.setExtra).toHaveBeenCalledWith("status", undefined);
    expect(testState.setExtra).toHaveBeenCalledWith("verified", undefined);
  });

  it("shows the loader — never the pristine empty copy — before the first page arrives", () => {
    // The `if (!data && !error)` early return is what actually prevents a
    // "No places yet" flash on cold load. DataTable's own 200ms deferred
    // skeleton does NOT protect this surface: with keepPreviousData the
    // `isLoading` it receives is effectively always false, so the guard above
    // it is load-bearing and untested until now.
    testState.listQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
      refetch: testState.refetch,
    });
    render(<PlacesTable />);

    expect(screen.getByTestId("admin-page-data")).toHaveTextContent(
      "admin.loadingPlaces",
    );
    expect(screen.queryByTestId("no-results")).toBeNull();
  });

  it("drops the create-oriented description for read-only roles but keeps the same empty state", () => {
    // One `NoResults` branch for both roles — the old canEdit/read-only split
    // existed only because SkeletonEmptyState REQUIRED a CTA that read-only
    // roles could not use. Same title, same absence of a button.
    mockListSuccess([]);
    const { unmount } = render(<PlacesTable />);
    const editor = screen.getByTestId("no-results");
    expect(editor).toHaveTextContent("admin.placesEmptyActive");
    expect(editor).toHaveTextContent("admin.placesEmptyCreateDescription");
    expect(editor.querySelector("button")).toBeNull();
    unmount();

    // …but the description is an IMPERATIVE, and the header's create button is
    // canEdit-gated too, so a read-only viewer would be told to create a place
    // with no affordance anywhere on the page. They get the title alone.
    testState.canEdit = false;
    testState.canManage = false;
    render(<PlacesTable />);
    const viewer = screen.getByTestId("no-results");
    expect(viewer).toHaveTextContent("admin.placesEmptyActive");
    expect(viewer).not.toHaveTextContent("admin.placesEmptyCreateDescription");
    expect(viewer.querySelector("button")).toBeNull();
  });

  it("surfaces query failures through the shared retry state with the filters still mounted", () => {
    testState.listQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("nope"),
      refetch: testState.refetch,
    });
    render(<PlacesTable />);

    expect(screen.getByTestId("admin-table-error")).toHaveTextContent("boom");
    // The search bar + filter chips must survive the error so a
    // filter/search-induced failure is recoverable in place (not just via
    // Retry, which would re-send the same bad input).
    expect(screen.getByLabelText("search")).toBeInTheDocument();
    expect(screen.getByTestId("filter-row")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Retry"));
    expect(testState.refetch).toHaveBeenCalled();
  });

  it("omits sub-minimum search queries instead of sending a guaranteed BAD_REQUEST", () => {
    // 1 char < the server's min(2) — must be sent as "no query".
    testState.debouncedSearch = "a";
    const { unmount } = render(<PlacesTable />);
    const shortInput = testState.listQuery.mock.calls.at(-1)?.[0] as {
      query?: string;
    };
    expect(shortInput.query).toBeUndefined();
    unmount();

    // 2+ chars pass through.
    testState.listQuery.mockClear();
    testState.debouncedSearch = "ab";
    render(<PlacesTable />);
    const okInput = testState.listQuery.mock.calls.at(-1)?.[0] as {
      query?: string;
    };
    expect(okInput.query).toBe("ab");
  });

  it("hides the row-actions Layout item when the seatingLayouts feature gate is off", () => {
    // basePlace is owned (its access.orgIds includes the mocked ORG_ID) and
    // testState.canEdit defaults true, so the row-actions menu renders —
    // seatingLayouts is the ONLY thing gating the Layout item itself.
    testState.seatingLayouts = false;
    render(<PlacesTable />);

    const rowActions = screen.getByTestId("row-actions");
    // The seat-layout destination (`/admin/:slug/places/:id/layout`) enforces
    // this gate server-side and bounces the user back out, so a visible
    // Layout entry with the flag off would be a dead, misleading action.
    expect(
      within(rowActions).queryByTestId("row-action-layout"),
    ).not.toBeInTheDocument();
    // Other owned-actor actions stay unaffected by the seatingLayouts gate.
    expect(
      within(rowActions).getByTestId("row-action-edit"),
    ).toBeInTheDocument();
  });

  it("offers a Bookings row action for an owned, editable place", () => {
    // The place rail already has a Bookings entry; the table's menu is the
    // other way in, and it should sit right after Calendar (Operate order).
    render(<PlacesTable />);

    const rowActions = screen.getByTestId("row-actions");
    expect(
      within(rowActions).getByTestId("row-action-bookings"),
    ).toHaveTextContent("admin.placesBookingsTooltip");
    const keys = within(rowActions)
      .getAllByRole("button")
      .map((b) => b.getAttribute("data-testid"))
      .filter((id): id is string => Boolean(id?.startsWith("row-action-")));
    expect(keys.indexOf("row-action-bookings")).toBe(
      keys.indexOf("row-action-calendar") + 1,
    );
  });

  it("shows the row-actions Layout item when the seatingLayouts feature gate is on", () => {
    testState.seatingLayouts = true;
    render(<PlacesTable />);

    const rowActions = screen.getByTestId("row-actions");
    expect(
      within(rowActions).getByTestId("row-action-layout"),
    ).toHaveTextContent("admin.placesLayoutTooltip");
  });

  it("hides the entire row-actions menu (Layout included) for a place the actor does not own, regardless of the seatingLayouts gate", () => {
    testState.seatingLayouts = true;
    mockListSuccess([
      { ...basePlace, access: { orgIds: [], humanIds: [] } },
    ]);
    render(<PlacesTable />);

    // rowActions.render early-returns null when the actor doesn't own the
    // place — seatingLayouts alone can never surface Layout (or any other
    // action) for a place the actor has no edit access to. Assert the whole
    // menu is gone, not just the Layout item, so a future regression that
    // scopes the ownership gate to Layout alone (leaving Edit/Archive/etc.
    // reachable for an unowned place) fails this test.
    const rowActions = within(screen.getByTestId("row-actions"));
    expect(rowActions.queryByTestId("row-action-menu")).not.toBeInTheDocument();
    expect(rowActions.queryByTestId("row-action-layout")).not.toBeInTheDocument();
    expect(rowActions.queryByTestId("row-action-edit")).not.toBeInTheDocument();
  });

  // ── FR-013: one verification-request path ───────────────────────────────

  it("opens the shared verification modal from the row action instead of flipping status", () => {
    render(<PlacesTable />);

    expect(screen.queryByTestId("verify-modal")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("row-action-verify"));

    const modal = screen.getByTestId("verify-modal");
    expect(modal).toHaveAttribute("data-place-id", basePlace.placeId);
    expect(within(modal).getByText(basePlace.name)).toBeInTheDocument();

    fireEvent.click(screen.getByText("close-verify-modal"));
    expect(screen.queryByTestId("verify-modal")).not.toBeInTheDocument();
  });

  it("never calls the staff status-flip procedure from this table", () => {
    // The old row action mutated `places.updatePlaceVerificationStatus` to
    // PENDING with no documents attached, creating a queue entry a reviewer
    // had nothing to review. That call site is gone; the procedure is now
    // reached only from the platform surface.
    render(<PlacesTable />);
    fireEvent.click(screen.getByTestId("row-action-verify"));

    expect(updateVerificationMutateAsync).not.toHaveBeenCalled();
  });

  it("keeps the ineligible row action reachable, with the blocker named", () => {
    // A dead menu row that only says "Not ready" leaves the admin nowhere to
    // go; the modal lists every blocker, so the item stays pressable.
    testState.eligibility = {
      eligible: false,
      reasons: ["Street address is required."],
    };
    render(<PlacesTable />);

    const verify = screen.getByTestId("row-action-verify");
    expect(verify).toHaveTextContent("Street address is required.");
    expect(verify).not.toBeDisabled();

    fireEvent.click(verify);
    expect(screen.getByTestId("verify-modal")).toBeInTheDocument();
  });

  // ── The "TBD" sentinel ──────────────────────────────────────────────────
  //
  // The quick action used to create every place with a hard-coded
  // `address: { formatted: "TBD", line1: "TBD" }`, so each row born from this
  // table carried a forged street address that persisted to
  // `Place.addrLine1`, fed `Place.address`/`addressHash`, and rendered on the
  // venue's PUBLIC page (PlaceMobileCard still filters `!== "TBD"` because of
  // it). `line1` is optional server-side now, so absent is representable —
  // and `formatted`, which is not optional, is built from what the organiser
  // actually typed.

  function openNewPlaceDialog() {
    fireEvent.click(screen.getByText("admin.placesNewPlace"));
  }

  function fillNewPlaceDialog(
    values: { name?: string; city?: string; country?: string } = {},
  ) {
    if (values.name !== undefined) {
      fireEvent.change(screen.getByTestId("new-place-name-input"), {
        target: { value: values.name },
      });
    }
    if (values.city !== undefined) {
      fireEvent.change(screen.getByTestId("new-place-city-input"), {
        target: { value: values.city },
      });
    }
    if (values.country !== undefined) {
      fireEvent.change(screen.getByTestId("new-place-country-input"), {
        target: { value: values.country },
      });
    }
  }

  it("writes nothing when the New Place button is pressed — it opens the dialog", () => {
    render(<PlacesTable />);
    expect(screen.queryByTestId("modal")).not.toBeInTheDocument();

    openNewPlaceDialog();

    expect(screen.getByTestId("modal")).toBeInTheDocument();
    // The old one-click action fired the mutation right here, with "TBD".
    expect(upsertMutateAsync).not.toHaveBeenCalled();
  });

  it("creates the place from what the organiser typed — no 'TBD', no forged line1", async () => {
    render(<PlacesTable />);
    openNewPlaceDialog();
    fillNewPlaceDialog({ name: "The Velvet Room", city: "Portland" });

    await act(async () => {
      fireEvent.click(screen.getByText("admin.placesNewPlaceCreate"));
      await Promise.resolve();
    });

    expect(upsertMutateAsync).toHaveBeenCalledTimes(1);
    const payload = upsertMutateAsync.mock.calls[0]![0] as {
      name: string;
      address: Record<string, unknown>;
    };

    expect(payload.name).toBe("The Velvet Room");
    expect(payload.address).toEqual({
      // Same parts, same order, same join as the place editor's rebuilt
      // address, so `addressHash` does not churn on the next save.
      formatted: "Portland, US",
      city: "Portland",
      countryCode: "US",
    });
    // Not "absent-but-present-as-undefined": the key is simply not sent.
    expect(payload.address).not.toHaveProperty("line1");
    expect(JSON.stringify(payload)).not.toContain("TBD");
  });

  // ── Address privacy at creation (ruled 2026-09-17) ──────────────────────
  //
  // "Every address should be shown, but upon creation they give an option to
  // hide it." This dialog is the web app's only create path, so it is where
  // both halves have to hold: shown by default, and a hide picked here reaches
  // the create itself.

  it("creates a venue with its address shown unless the organiser hides it", async () => {
    render(<PlacesTable />);
    openNewPlaceDialog();
    fillNewPlaceDialog({ name: "The Velvet Room", city: "Portland" });

    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios.find((r) => r.value === "exact")!.checked).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByText("admin.placesNewPlaceCreate"));
      await Promise.resolve();
    });

    expect(upsertMutateAsync.mock.calls[0]![0]).toMatchObject({
      locationMode: "EXACT",
      locationRadiusMeters: null,
      locationLabel: null,
    });
  });

  it("sends a hide picked in the dialog with the create, not on a later save", async () => {
    render(<PlacesTable />);
    openNewPlaceDialog();
    fillNewPlaceDialog({ name: "Our Living Room", city: "Portland" });

    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    fireEvent.click(radios.find((r) => r.value === "hidden")!);
    // The free-text warning appears with the hide, before anything is saved.
    expect(
      screen.getByTestId("new-place-privacy-free-text-warning"),
    ).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByText("admin.placesNewPlaceCreate"));
      await Promise.resolve();
    });

    expect(upsertMutateAsync.mock.calls[0]![0]).toMatchObject({
      locationMode: "OBSCURED",
      // null = fully hidden, no public map: the MEANINGFUL null.
      locationRadiusMeters: null,
    });
  });

  it("keeps Create disabled until the minimum honest address is supplied", async () => {
    render(<PlacesTable />);
    openNewPlaceDialog();

    const create = () =>
      screen.getByText("admin.placesNewPlaceCreate").closest("button")!;

    // Nothing typed.
    expect(create()).toBeDisabled();

    // Name only — a place with a name and no location is exactly the state the
    // sentinel used to paper over.
    fillNewPlaceDialog({ name: "The Velvet Room" });
    expect(create()).toBeDisabled();

    // A half-typed country code is not a country code (server: length(2)).
    fillNewPlaceDialog({ city: "Portland", country: "U" });
    expect(create()).toBeDisabled();

    fillNewPlaceDialog({ country: "ca" });
    expect(create()).not.toBeDisabled();

    await act(async () => {
      fireEvent.click(create());
      await Promise.resolve();
    });
    expect(upsertMutateAsync.mock.calls[0]![0]).toMatchObject({
      address: { formatted: "Portland, CA", countryCode: "CA" },
    });
  });

  it("imports a CSV row with no street address without forging one", async () => {
    render(<PlacesTable />);
    expect(testState.csvSubmit).toBeTruthy();

    await act(async () => {
      await testState.csvSubmit!([
        {
          name: "Logan Square DIY",
          addressFormatted: "",
          addressLine1: "",
          city: "Chicago",
          region: "IL",
          countryCode: "US",
        },
      ]);
    });

    const payload = bulkUpsertMutateAsync.mock.calls[0]![0] as unknown as {
      places: { address: Record<string, unknown> }[];
    };
    const address = payload.places[0]!.address;

    expect(address.line1).toBeUndefined();
    expect(address.formatted).toBe("Chicago, IL, US");
    expect(JSON.stringify(payload)).not.toContain("TBD");
  });
});
