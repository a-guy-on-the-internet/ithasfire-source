/**
 * Regression tests for the platform places page's own state logic:
 *
 *  - Status filter: a chip click must stay selected while the URL navigation
 *    is still in flight, and the URL write must survive the page reset that
 *    the same click triggers. `router.replace` here records the URL but does
 *    NOT update `useSearchParams` — the same window a real App Router
 *    navigation (a Transition plus a server round-trip) leaves open.
 *  - Bulk selection: keys whose rows leave the server page (approve, reject,
 *    unlist, another admin's change) are pruned, and the Set keeps its
 *    identity when nothing left.
 *
 * `useAdminTableParams` is the REAL hook: it owns the URL writes, and the
 * filter bug lived in how the page and the hook shared them. Everything else
 * is mocked down to bare DOM. Assertions use plain DOM reads, not jest-dom
 * matchers.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
  placeId: string;
  name: string;
  verificationStatus: string;
  listedInDirectory: boolean;
  ownerCount: number;
  capacity: number | null;
  status: "ACTIVE" | "SUSPENDED" | "ARCHIVED";
}

interface CapturedTableProps {
  rows: Row[];
  getRowKey: (row: Row) => string;
  columns: { id: string; cell: (row: Row) => ReactNode }[];
  rowActions?: { render: (row: Row) => ReactNode };
  emptyState?: ReactNode;
  selectable?: {
    selectedKeys: Set<string>;
    onSelectionChange: (next: Set<string>) => void;
  };
}

const state = vi.hoisted(() => {
  const replace = vi.fn();
  return {
    searchParams: new URLSearchParams(),
    replace,
    // Stable like the real router (bprogress keeps it in a ref).
    router: {
      replace: (...args: unknown[]) => replace(...args),
      push: vi.fn(),
    },
    places: [] as Row[],
    listInputs: [] as unknown[],
    table: null as CapturedTableProps | null,
    bulkDeleteMutate: vi.fn(),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => state.router,
  usePathname: () => "/platform/places",
  useSearchParams: () => state.searchParams,
}));

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", null, children);
  return {
    XStack: Stack,
    YStack: Stack,
    Stack,
    useTheme: () => ({}),
  };
});

vi.mock("lucide-react", () => {
  const Icon = () => <span />;
  return {
    MapPin: Icon,
    ShieldCheck: Icon,
    ShieldX: Icon,
    Users: Icon,
    Eye: Icon,
    BookOpen: Icon,
    BookX: Icon,
    Upload: Icon,
    Archive: Icon,
    Trash2: Icon,
    RefreshCw: Icon,
  };
});

vi.mock("@th/ui", () => {
  const Modal = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  const Passthrough = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  Modal.Panel = Passthrough;
  Modal.Header = () => null;
  Modal.Body = Passthrough;
  return {
    Modal,
    Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    Tooltip: ({ anchor }: { anchor: ReactNode }) => <>{anchor}</>,
    Button: ({
      children,
      onPress,
      disabled,
      ...rest
    }: {
      children?: ReactNode;
      onPress?: () => void;
      disabled?: boolean;
      [key: string]: unknown;
    }) => (
      <button
        type="button"
        onClick={onPress}
        disabled={disabled}
        aria-pressed={rest["aria-pressed"] as boolean | undefined}
        aria-label={rest["aria-label"] as string | undefined}
      >
        {children}
      </button>
    ),
    DataTable: (props: CapturedTableProps) => {
      state.table = props;
      return (
        <div data-testid="table">
          {props.rows.length === 0
            ? props.emptyState
            : props.rows.map((row) => (
                <div
                  key={props.getRowKey(row)}
                  data-testid={`row-${row.placeId}`}
                >
                  {props.columns.find((c) => c.id === "name")?.cell(row)}
                  {props.rowActions?.render(row)}
                </div>
              ))}
        </div>
      );
    },
    useNotify: () => ({ toast: { success: vi.fn(), danger: vi.fn() } }),
    useTranslations: () => (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${Object.values(params).join(" ")}` : key,
  };
});

/** Mirrors the real FilterChips contract: pressing the active chip passes undefined. */
vi.mock("@/components/AdminTableParts", () => ({
  ActionBar: ({
    children,
    countLabel,
  }: {
    children?: ReactNode;
    countLabel?: string;
  }) => (
    <div>
      <span data-testid="count-label">{countLabel}</span>
      {children}
    </div>
  ),
  TableContainer: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  SearchBar: () => null,
  Pagination: () => null,
  NoResults: () => null,
  ColumnSelector: () => null,
  FilterChips: ({
    options,
    selected,
    onSelect,
    ariaLabel = "Filters",
  }: {
    options: { value: string; label: string }[];
    selected: string | undefined;
    onSelect: (v: string | undefined) => void;
    ariaLabel?: string;
  }) => (
    <div role="group" aria-label={ariaLabel}>
      {options.map((opt) => {
        const isOn = selected === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={isOn}
            onClick={() => onSelect(isOn ? undefined : opt.value)}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  ),
}));

vi.mock("@/trpc", () => {
  const mutation = () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  });
  return {
    trpc: {
      useUtils: () => ({
        platform: { listPlaces: { invalidate: vi.fn() } },
      }),
      placeReviews: { toggleDirectoryListing: { useMutation: mutation } },
      places: {
        bulkArchivePlaces: { useMutation: mutation },
        upsertPlace: { useMutation: mutation },
        bulkImportPlaces: { useMutation: mutation },
      },
      platformJobs: { runJob: { useMutation: mutation } },
      platform: {
        adminBulkDeletePlaces: {
          useMutation: () => ({
            mutate: state.bulkDeleteMutate,
            isPending: false,
          }),
        },
        updatePlaceVerificationStatus: { useMutation: mutation },
        listPlaces: {
          useQuery: (input: unknown) => {
            state.listInputs.push(input);
            return {
              data: {
                places: state.places,
                pageInfo: { total: state.places.length },
              },
              isLoading: false,
              isFetching: false,
              error: null,
              refetch: vi.fn(),
            };
          },
        },
      },
    },
  };
});

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: { useSession: () => ({ data: null }) },
}));
vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: () => "error",
}));
vi.mock("@/lib/verification-config", () => ({
  VERIFICATION_ICON_MAP: Object.fromEntries(
    ["UNVERIFIED", "PENDING", "VERIFIED", "REJECTED"].map((status) => [
      status,
      { Icon: () => null, themeKey: "color" },
    ]),
  ),
}));
vi.mock("@/lib/crypto-utils", () => ({ buildFreshClientKey: () => "key" }));
vi.mock("@/lib/place-import-fields", () => ({ PLACE_IMPORT_FIELDS: [] }));
vi.mock("@/lib/place-csv-address", () => ({
  buildPlaceCsvAddress: () => ({}),
}));
vi.mock("@/hooks/useColumnVisibility", () => ({
  useColumnVisibility: () => ({
    isVisible: () => true,
    toggleColumn: vi.fn(),
    showAll: vi.fn(),
    hasHidden: false,
  }),
}));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => false }));
vi.mock("@/components/data-table/ConfirmDialog", () => ({
  ConfirmDialog: ({
    open,
    description,
    onConfirm,
  }: {
    open: boolean;
    description: string;
    onConfirm: () => void;
  }) =>
    open ? (
      <div data-testid="bulk-delete-confirm">
        <span>{description}</span>
        <button type="button" onClick={onConfirm}>
          confirm-delete
        </button>
      </div>
    ) : null,
}));
vi.mock("@/app/admin/[slug]/_components/CsvImportDialog", () => ({
  CsvImportDialog: () => null,
}));
vi.mock("@/app/platform/_components/PlatformPageParts", () => ({
  PlatformContainer: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  PlatformFilterBar: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("../_components/VerificationReviewDetail", () => ({
  VerificationReviewDetail: () => null,
}));
vi.mock("../_components/PlaceDetailPanel", () => ({
  PlaceDetailPanel: () => null,
}));
vi.mock("../_components/PlatformVerificationQueue", () => ({
  PlatformVerificationQueue: () => null,
}));
vi.mock("../_components/PlatformPlaceMobileCard", () => ({
  PlatformPlaceMobileCard: () => null,
  PlaceVerificationBadge: () => null,
  PlaceDirectoryBadge: () => null,
  PlaceArchivedBadge: () => <span>archived-badge</span>,
  buildLocationString: () => "",
}));

import PlatformPlacesPage from "../page";

function row(placeId: string, name: string): Row {
  return {
    placeId,
    name,
    verificationStatus: "UNVERIFIED",
    listedInDirectory: false,
    ownerCount: 0,
    capacity: null,
    status: "ACTIVE",
  };
}

/** A chip inside one named group: both groups carry an "All" chip. */
function chip(label: string, group = "admin.ppVerification") {
  return within(screen.getByRole("group", { name: group })).getByRole(
    "button",
    { name: label },
  );
}
const statusChip = (label: string) => chip(label, "admin.ppStatusFilter");

function lastReplacedUrl(): string {
  const calls = state.replace.mock.calls;
  return calls.length ? String(calls[calls.length - 1]![0]) : "";
}

function renderOnAllTab() {
  const utils = render(<PlatformPlacesPage />);
  // The page opens on the Queue tab; the table lives on "All Places".
  fireEvent.click(screen.getByRole("button", { name: "All Places" }));
  return utils;
}

beforeEach(() => {
  state.searchParams = new URLSearchParams();
  state.replace.mockReset();
  state.places = [];
  state.listInputs = [];
  state.table = null;
  state.bulkDeleteMutate.mockReset();
});

describe("PlatformPlacesPage status filter", () => {
  it("keeps a clicked chip selected while the navigation is still in flight", () => {
    renderOnAllTab();
    expect(chip("admin.ppPending").getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(chip("admin.ppUnverified"));

    // searchParams is still empty: the navigation has not landed. The click
    // must not be reverted to "pending" in the meantime.
    expect(chip("admin.ppUnverified").getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(chip("admin.ppPending").getAttribute("aria-pressed")).toBe("false");
    expect(lastReplacedUrl()).toBe("/platform/places?filter=unverified");
    expect(state.listInputs.at(-1)).toMatchObject({
      verificationStatus: ["UNVERIFIED"],
    });

    fireEvent.click(chip("admin.ppFilterAll"));
    expect(chip("admin.ppFilterAll").getAttribute("aria-pressed")).toBe("true");
    expect(lastReplacedUrl()).toBe("/platform/places?filter=all");
    expect(state.listInputs.at(-1)).toMatchObject({
      verificationStatus: undefined,
    });
  });

  it("keeps the filter in the URL when the click also resets the page", () => {
    // On page 3, a filter click resets the page. The LAST URL write must
    // still carry the filter; previously the table-params hook wrote the
    // page reset from stale searchParams AFTER the filter write, so the
    // filter was dropped from the URL and snapped back to pending.
    state.searchParams = new URLSearchParams("p=3");
    renderOnAllTab();

    fireEvent.click(chip("admin.ppUnverified"));

    expect(lastReplacedUrl()).toBe("/platform/places?filter=unverified");
    expect(chip("admin.ppUnverified").getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(state.listInputs.at(-1)).toMatchObject({
      offset: 0,
      verificationStatus: ["UNVERIFIED"],
    });
  });

  it("writes no filter param when going back to pending", () => {
    state.searchParams = new URLSearchParams("filter=verified");
    renderOnAllTab();
    expect(chip("admin.ppVerified").getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(chip("admin.ppPending"));

    expect(chip("admin.ppPending").getAttribute("aria-pressed")).toBe("true");
    expect(lastReplacedUrl()).toBe("/platform/places");
  });

  it("Directory tab selects the verified filter and writes it to the URL", () => {
    render(<PlatformPlacesPage />);

    fireEvent.click(screen.getByRole("button", { name: "Directory" }));

    expect(chip("admin.ppVerified").getAttribute("aria-pressed")).toBe("true");
    expect(chip("admin.ppPending").getAttribute("aria-pressed")).toBe("false");
    expect(lastReplacedUrl()).toBe("/platform/places?filter=verified");
    expect(state.listInputs.at(-1)).toMatchObject({
      verificationStatus: ["VERIFIED"],
    });
  });

  it("holds the clicked chip when the navigation lands, with no extra URL write", () => {
    const { rerender } = renderOnAllTab();
    fireEvent.click(chip("admin.ppUnverified"));
    expect(chip("admin.ppUnverified").getAttribute("aria-pressed")).toBe(
      "true",
    );
    const writes = state.replace.mock.calls.length;

    // The navigation commits: useSearchParams now returns the replaced URL.
    const landed = new URL(lastReplacedUrl(), "http://localhost");
    state.searchParams = new URLSearchParams(landed.search);
    rerender(<PlatformPlacesPage />);

    expect(chip("admin.ppUnverified").getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(state.replace.mock.calls.length).toBe(writes);
    expect(state.listInputs.at(-1)).toMatchObject({
      verificationStatus: ["UNVERIFIED"],
    });
  });

  it.each([
    ["", "admin.ppPending"],
    ["filter=bogus", "admin.ppPending"],
    ["filter=rejected", "admin.ppRejected"],
    ["filter=all", "admin.ppFilterAll"],
  ])("reads ?%s as the %s chip", (query, expected) => {
    state.searchParams = new URLSearchParams(query);
    renderOnAllTab();
    expect(chip(expected).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("PlatformPlacesPage bulk selection", () => {
  const A = row("place-a", "Alpha Hall");
  const B = row("place-b", "Beta Room");

  function select(keys: string[]) {
    act(() => {
      state.table!.selectable!.onSelectionChange(new Set(keys));
    });
  }

  it("drops a selected key once its row leaves the server page", () => {
    state.places = [A, B];
    const { rerender } = renderOnAllTab();
    select([A.placeId, B.placeId]);
    expect([...state.table!.selectable!.selectedKeys].sort()).toEqual([
      A.placeId,
      B.placeId,
    ]);

    // A was approved (or rejected, unlisted, changed by another admin) and
    // the refetch no longer returns it.
    state.places = [B];
    rerender(<PlatformPlacesPage />);

    expect([...state.table!.selectable!.selectedKeys]).toEqual([B.placeId]);
    expect(screen.getByTestId("count-label").textContent).toBe(
      "admin.ppSelectedCount 1",
    );
  });

  // Render-churn guard, NOT a regression test for the stale-selection bug:
  // it passes before the prune existed too (nothing touched the Set then).
  // It pins that the prune's updater hands back `prev` when no key left, so
  // every background refetch doesn't re-render the table.
  it("prune keeps the same Set instance when a refetch drops nothing (no re-render churn)", () => {
    state.places = [A, B];
    const { rerender } = renderOnAllTab();
    select([A.placeId]);
    const before = state.table!.selectable!.selectedKeys;

    // A fresh array with the same rows, as a background refetch returns.
    state.places = [{ ...B }, { ...A }];
    rerender(<PlatformPlacesPage />);

    expect(state.table!.selectable!.selectedKeys).toBe(before);
    expect([...before]).toEqual([A.placeId]);
  });

  it("clears the bulk bar when every selected row leaves", () => {
    state.places = [A, B];
    const { rerender } = renderOnAllTab();
    select([A.placeId]);
    expect(
      screen.queryByRole("button", { name: "admin.ppDeselectAll" }),
    ).not.toBeNull();

    state.places = [B];
    rerender(<PlatformPlacesPage />);

    expect(state.table!.selectable!.selectedKeys.size).toBe(0);
    expect(
      screen.queryByRole("button", { name: "admin.ppDeselectAll" }),
    ).toBeNull();
  });

  it("closes Delete selected when a prune empties the selection and keeps it closed", () => {
    state.places = [A, B];
    const { rerender } = renderOnAllTab();
    select([A.placeId]);
    fireEvent.click(
      screen.getByRole("button", { name: "admin.ppDeleteSelected" }),
    );
    expect(screen.getByTestId("bulk-delete-confirm").textContent).toContain(
      "admin.ppBulkDeleteConfirm 1",
    );

    // A refetch drops A while the dialog is open.
    state.places = [B];
    rerender(<PlatformPlacesPage />);

    expect(screen.queryByTestId("bulk-delete-confirm")).toBeNull();
    expect(state.bulkDeleteMutate).not.toHaveBeenCalled();

    // The flag was reset, not just masked: a new selection must not pop the
    // dialog back open on its own.
    select([B.placeId]);
    expect(screen.queryByTestId("bulk-delete-confirm")).toBeNull();
  });
});

describe("PlatformPlacesPage lifecycle status filter", () => {
  it("defaults to Active (ACTIVE + SUSPENDED) with no ?status in the URL", () => {
    renderOnAllTab();
    expect(
      statusChip("admin.ppDetailStatusActive").getAttribute("aria-pressed"),
    ).toBe("true");
    expect(state.listInputs.at(-1)).toMatchObject({
      status: ["ACTIVE", "SUSPENDED"],
    });
  });

  it("Archived and All write ?status= and map to listPlaces.status", () => {
    renderOnAllTab();
    fireEvent.click(statusChip("admin.ppDetailStatusArchived"));
    expect(lastReplacedUrl()).toBe("/platform/places?status=archived");
    expect(state.listInputs.at(-1)).toMatchObject({ status: ["ARCHIVED"] });

    fireEvent.click(statusChip("admin.ppFilterAll"));
    expect(lastReplacedUrl()).toBe("/platform/places?status=all");
    expect(state.listInputs.at(-1)).toMatchObject({ status: undefined });
    // The verification group's own "All" is untouched.
    expect(chip("admin.ppPending").getAttribute("aria-pressed")).toBe("true");
  });

  it("pressing the lit status chip keeps it (single-select scope)", () => {
    state.searchParams = new URLSearchParams("status=archived");
    renderOnAllTab();
    fireEvent.click(statusChip("admin.ppDetailStatusArchived"));
    expect(
      statusChip("admin.ppDetailStatusArchived").getAttribute("aria-pressed"),
    ).toBe("true");
    expect(state.listInputs.at(-1)).toMatchObject({ status: ["ARCHIVED"] });
  });

  it("keeps both filters in the URL together", () => {
    state.searchParams = new URLSearchParams("filter=unverified");
    renderOnAllTab();
    fireEvent.click(statusChip("admin.ppDetailStatusArchived"));
    expect(lastReplacedUrl()).toBe(
      "/platform/places?filter=unverified&status=archived",
    );
    expect(state.listInputs.at(-1)).toMatchObject({
      verificationStatus: ["UNVERIFIED"],
      status: ["ARCHIVED"],
    });
  });

  it.each([
    ["", "admin.ppDetailStatusActive"],
    ["status=bogus", "admin.ppDetailStatusActive"],
    ["status=archived", "admin.ppDetailStatusArchived"],
    ["status=all", "admin.ppFilterAll"],
  ])("reads ?%s as the %s status chip", (query, expected) => {
    state.searchParams = new URLSearchParams(query);
    renderOnAllTab();
    expect(statusChip(expected).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("PlatformPlacesPage archived rows", () => {
  it("tags an archived row and hides its Approve action", () => {
    state.places = [
      row("p-active", "Live Room"),
      { ...row("p-archived", "Old Room"), status: "ARCHIVED" },
    ];
    renderOnAllTab();

    const live = screen.getByTestId("row-p-active");
    const old = screen.getByTestId("row-p-archived");
    expect(within(live).queryByText("archived-badge")).toBeNull();
    expect(within(old).getByText("archived-badge")).toBeTruthy();
    expect(
      within(live).getByRole("button", { name: "admin.ppApprove" }),
    ).toBeTruthy();
    expect(
      within(old).queryByRole("button", { name: "admin.ppApprove" }),
    ).toBeNull();
  });
});
