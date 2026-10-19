import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The comps LEDGER.
 *
 * The load-bearing behaviour here is not the table — it is that FOUR different
 * origin/reason states share a null `reason` and must never read alike, that a
 * revoked reward cannot look live, and that the issue affordance tracks the
 * capability the SERVER enforces (ORG_ADMIN_ROLES) rather than the wider one
 * that can read the page (ORG_EDIT_OR_FINANCE_ROLES).
 *
 * Mock pattern transplanted from AttendeesTab.test. The DataTable mock renders
 * every column's `cell` output (not just a row marker) — the copy under test
 * lives in the cells.
 */

const testState = vi.hoisted(() => ({
  currentOwner: { kind: "org", orgId: "org-1" } as
    | { kind: "org"; orgId: string }
    | { kind: "human"; humanId: string }
    | undefined,
  canManage: true,
  compsUseQuery: vi.fn(),
  refetch: vi.fn(),
  /** Flips the DataTable mock into card mode so `renderMobileCard` is covered. */
  cardMode: false,
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
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    testID?: string;
  }) => (
    <button
      type="button"
      onClick={onPress}
      disabled={disabled}
      data-testid={testID}
    >
      {children}
    </button>
  ),
  DataTable: ({
    columns,
    rows,
    getRowKey,
    emptyState,
    renderMobileCard,
  }: {
    columns: Array<{ id: string; cell: (row: unknown) => ReactNode }>;
    rows: unknown[];
    getRowKey: (row: never, index: number) => string;
    emptyState?: ReactNode;
    renderMobileCard?: (row: never) => ReactNode;
  }) => (
    <div data-testid="comps-table">
      {rows.length === 0
        ? emptyState
        : rows.map((row, index) => {
            const key = getRowKey(row as never, index);
            return (
              <div key={key} data-testid={`comp-row-${key}`}>
                {testState.cardMode
                  ? renderMobileCard?.(row as never)
                  : columns.map((col) => (
                      <div key={col.id} data-testid={`cell-${col.id}`}>
                        {col.cell(row)}
                      </div>
                    ))}
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
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/trpc", () => ({
  trpc: {
    comp: {
      list: { useQuery: (...args: unknown[]) => testState.compsUseQuery(...args) },
    },
    useUtils: () => ({ comp: { list: { invalidate: vi.fn() } } }),
  },
}));

vi.mock("@/hooks/useCurrentAdminOwner", () => ({
  useCurrentAdminOwner: () => ({
    currentOwner: testState.currentOwner,
    isLoading: false,
  }),
}));

vi.mock("@/hooks/useAdminOwnerCapabilities", () => ({
  useAdminOwnerCapabilities: () => ({
    canEdit: true,
    canManage: testState.canManage,
    canFinance: true,
  }),
}));

vi.mock("@/components/AdminTableParts", () => ({
  ActionBar: ({
    children,
    countLabel,
  }: {
    children?: ReactNode;
    countLabel?: string;
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
    <div data-testid="comps-error">
      <span>{message}</span>
      <button type="button" onClick={onRetry}>
        Retry
      </button>
    </div>
  ),
  FilterChips: ({
    options,
    selected,
    onSelect,
  }: {
    options: { value: string; label: string }[];
    selected?: string;
    onSelect: (next: string | undefined) => void;
  }) => (
    <div data-testid="filter-chips" data-selected={selected ?? ""}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          data-testid={`chip-${o.value}`}
          onClick={() => onSelect(selected === o.value ? undefined : o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  ),
  FilterRow: ({ children }: { children?: ReactNode }) => (
    <div data-testid="filter-row">{children}</div>
  ),
  NoResults: ({ title }: { title: string }) => (
    <div data-testid="no-results">{title}</div>
  ),
  TableContainer: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/lib/format", () => ({ fmtDate: () => "date" }));
vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: (err: unknown) => String(err),
}));

vi.mock("../IssueCompDialog", () => ({
  IssueCompDialog: ({ open }: { open: boolean }) => (
    <div data-testid="issue-dialog" data-open={open ? "true" : "false"} />
  ),
}));

import { CompTicketsTab } from "../CompTicketsTab";

const EVENT_ID = "22222222-2222-4222-8222-222222222222";

type Row = {
  orderId: string;
  occurredAt: string;
  status: string;
  recipientHumanId: string;
  recipientName: string | null;
  recipientEmail: string | null;
  ticketTypes: Array<{
    ticketTypeId: string;
    name: string | null;
    quantity: number;
  }>;
  quantity: number;
  reason: string | null;
  origin: "HAND_ISSUED" | "VOLUNTEER_REWARD";
  issuedByHumanId: string | null;
  issuedByName: string | null;
};

function makeRow(id: string, overrides: Partial<Row> = {}): Row {
  return {
    orderId: id,
    occurredAt: "2026-08-01T10:00:00.000Z",
    status: "SUCCEEDED",
    recipientHumanId: `h-${id}`,
    recipientName: "Ada Lovelace",
    recipientEmail: "ada@example.com",
    ticketTypes: [{ ticketTypeId: `tt-${id}`, name: "General", quantity: 1 }],
    quantity: 1,
    reason: null,
    origin: "HAND_ISSUED",
    issuedByHumanId: "issuer-1",
    issuedByName: "Grace Hopper",
    ...overrides,
  };
}

function settledQuery(rows: Row[], overrides: Record<string, unknown> = {}) {
  return {
    data: {
      items: rows,
      pageInfo: {
        total: rows.length,
        count: rows.length,
        limit: 200,
        offset: 0,
        hasNextPage: false,
        nextOffset: null,
      },
    },
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
    refetch: testState.refetch,
    ...overrides,
  };
}

/** Text of the named cell in the named row. */
function cellText(orderId: string, columnId: string): string {
  const row = screen.getByTestId(`comp-row-${orderId}`);
  return within(row).getByTestId(`cell-${columnId}`).textContent ?? "";
}

beforeEach(() => {
  vi.clearAllMocks();
  testState.currentOwner = { kind: "org", orgId: "org-1" };
  testState.canManage = true;
  testState.cardMode = false;
});

describe("CompTicketsTab — the four origin/reason states", () => {
  // Live dev data today: FOUR comp orders, ZERO with a reason stamped. Every
  // row on first load takes a null-reason path, so all three fallbacks have to
  // be real copy — never a bare em-dash, which would make correct data read as
  // missing data.
  it("gives each of the four states its own reason and issuer copy", () => {
    testState.compsUseQuery.mockReturnValue(
      settledQuery([
        makeRow("reward", {
          origin: "VOLUNTEER_REWARD",
          issuedByHumanId: null,
          issuedByName: null,
          reason: null,
        }),
        makeRow("with-reason", { reason: "Sound engineer" }),
        makeRow("no-reason", { reason: null }),
        makeRow("legacy", {
          reason: null,
          issuedByHumanId: null,
          issuedByName: null,
        }),
      ]),
    );

    render(<CompTicketsTab slug="org-admin" eventId={EVENT_ID} />);

    // 1. VOLUNTEER_REWARD — no reason exists and none ever will.
    expect(cellText("reward", "reason")).toBe(
      "admin.compReasonEarnedByVolunteering",
    );
    expect(cellText("reward", "issuedBy")).toBe("admin.compIssuerAutomatic");

    // 2. HAND_ISSUED with a typed reason — the organizer's own words.
    expect(cellText("with-reason", "reason")).toBe("Sound engineer");
    expect(cellText("with-reason", "issuedBy")).toBe("Grace Hopper");

    // 3. HAND_ISSUED, issuer known, reason blank — modern, NOT legacy.
    expect(cellText("no-reason", "reason")).toBe("admin.compReasonNoneGiven");
    expect(cellText("no-reason", "issuedBy")).toBe("Grace Hopper");

    // 4. HAND_ISSUED, no issuer — predates the provenance columns.
    expect(cellText("legacy", "reason")).toBe(
      "admin.compReasonPredatesTracking",
    );
    expect(cellText("legacy", "issuedBy")).toBe("admin.compIssuerNotRecorded");

    // …and the four reason strings are genuinely four strings.
    const reasons = ["reward", "with-reason", "no-reason", "legacy"].map((id) =>
      cellText(id, "reason"),
    );
    expect(new Set(reasons).size).toBe(4);
    // No state falls back to a bare dash.
    for (const reason of reasons) expect(reason).not.toMatch(/^[—–-]?$/);
  });

  // `origin` is the server-derived discriminator. A reward-granted comp and a
  // legacy hand-issue are BOTH `reason == null` + `issuedByHumanId == null`;
  // only `origin` separates them, and the two must not render the same badge.
  it("labels origin from `origin`, never from a null reason", () => {
    testState.compsUseQuery.mockReturnValue(
      settledQuery([
        makeRow("reward", {
          origin: "VOLUNTEER_REWARD",
          issuedByHumanId: null,
          issuedByName: null,
        }),
        makeRow("legacy", { issuedByHumanId: null, issuedByName: null }),
      ]),
    );

    render(<CompTicketsTab slug="org-admin" eventId={EVENT_ID} />);

    expect(cellText("reward", "origin")).toBe(
      "admin.compOriginVolunteerReward",
    );
    expect(cellText("legacy", "origin")).toBe("admin.compOriginHandIssued");
  });

  // `issuedByName: null` collapses "the id resolves to nobody" and "the human
  // has no name". The copy must be true of both — never "this person was
  // deleted".
  it("says only what is true when an issuer id resolves to no name", () => {
    testState.compsUseQuery.mockReturnValue(
      settledQuery([
        makeRow("nameless", { issuedByHumanId: "issuer-9", issuedByName: null }),
      ]),
    );

    render(<CompTicketsTab slug="org-admin" eventId={EVENT_ID} />);

    expect(cellText("nameless", "issuedBy")).toBe(
      "admin.compIssuerNameUnavailable",
    );
  });

  // A revoked volunteer reward keeps its grant link, so it arrives as
  // VOLUNTEER_REWARD + CANCELLED.
  it("distinguishes a cancelled reward from a live one", () => {
    testState.compsUseQuery.mockReturnValue(
      settledQuery([
        makeRow("live", { origin: "VOLUNTEER_REWARD", status: "SUCCEEDED" }),
        makeRow("void", { origin: "VOLUNTEER_REWARD", status: "CANCELLED" }),
      ]),
    );

    render(<CompTicketsTab slug="org-admin" eventId={EVENT_ID} />);

    expect(cellText("live", "status")).toBe("SUCCEEDED");
    expect(cellText("void", "status")).toBe("CANCELLED");
    expect(cellText("live", "status")).not.toBe(cellText("void", "status"));
  });

  // Card mode is the 320px answer: the table squeezes `td` widths to single
  // digits with no horizontal scroller, so the data becomes unreachable.
  it("keeps every fallback in the mobile card", () => {
    testState.cardMode = true;
    testState.compsUseQuery.mockReturnValue(
      settledQuery([
        makeRow("reward", {
          origin: "VOLUNTEER_REWARD",
          issuedByHumanId: null,
          issuedByName: null,
        }),
      ]),
    );

    render(<CompTicketsTab slug="org-admin" eventId={EVENT_ID} />);

    const card = screen.getByTestId("comp-row-reward");
    expect(card.textContent).toContain("admin.compOriginVolunteerReward");
    expect(card.textContent).toContain("admin.compReasonEarnedByVolunteering");
    expect(card.textContent).toContain("admin.compIssuerAutomatic");
    expect(card.textContent).toContain("SUCCEEDED");
  });
});

describe("CompTicketsTab — capability gate", () => {
  // Reading is ORG_EDIT_OR_FINANCE_ROLES; ISSUING is ORG_ADMIN_ROLES. Hidden,
  // not disabled — the server enforces the same set, so a button that can only
  // 403 is worse than no button.
  it("offers the issue trigger to an admin", () => {
    testState.compsUseQuery.mockReturnValue(settledQuery([makeRow("a")]));

    render(<CompTicketsTab slug="org-admin" eventId={EVENT_ID} />);

    expect(screen.getByTestId("comp-issue-open")).toBeInTheDocument();
  });

  it("hides the issue trigger from a non-admin who can still read the ledger", () => {
    testState.canManage = false;
    testState.compsUseQuery.mockReturnValue(settledQuery([makeRow("a")]));

    render(<CompTicketsTab slug="org-admin" eventId={EVENT_ID} />);

    expect(screen.queryByTestId("comp-issue-open")).toBeNull();
    // …and the ledger itself is still there.
    expect(screen.getByTestId("comps-table")).toBeInTheDocument();
  });

  it("does not mount the issue dialog at all without the capability", () => {
    testState.canManage = false;
    testState.compsUseQuery.mockReturnValue(settledQuery([]));

    render(<CompTicketsTab slug="org-admin" eventId={EVENT_ID} />);

    expect(screen.queryByTestId("issue-dialog")).toBeNull();
  });

  it("opens the dialog from the header trigger", () => {
    testState.compsUseQuery.mockReturnValue(settledQuery([makeRow("a")]));

    render(<CompTicketsTab slug="org-admin" eventId={EVENT_ID} />);

    expect(screen.getByTestId("issue-dialog")).toHaveAttribute(
      "data-open",
      "false",
    );
    fireEvent.click(screen.getByTestId("comp-issue-open"));
    expect(screen.getByTestId("issue-dialog")).toHaveAttribute(
      "data-open",
      "true",
    );
  });
});

describe("CompTicketsTab — states", () => {
  it("points the empty state at the issue action for someone who can issue", () => {
    testState.compsUseQuery.mockReturnValue(settledQuery([]));

    render(<CompTicketsTab slug="org-admin" eventId={EVENT_ID} />);

    expect(screen.getByText("admin.compNoneYetTitle")).toBeInTheDocument();
    const cta = screen.getByTestId("comp-issue-empty");
    expect(cta).toBeInTheDocument();
    // A DIFFERENT accessible name from the header trigger — two buttons
    // sharing one name is ambiguous for screen-reader and voice users.
    expect(cta.textContent).toContain("admin.compIssueFirstAction");
    expect(screen.getByTestId("comp-issue-open").textContent).toContain(
      "admin.compIssueAction",
    );

    fireEvent.click(cta);
    expect(screen.getByTestId("issue-dialog")).toHaveAttribute(
      "data-open",
      "true",
    );
  });

  it("does not dangle an issue CTA in the empty state for a non-admin", () => {
    testState.canManage = false;
    testState.compsUseQuery.mockReturnValue(settledQuery([]));

    render(<CompTicketsTab slug="org-admin" eventId={EVENT_ID} />);

    expect(screen.getByText("admin.compNoneYetTitle")).toBeInTheDocument();
    expect(screen.queryByTestId("comp-issue-empty")).toBeNull();
  });

  it("renders the shared error state with a working retry", () => {
    testState.compsUseQuery.mockReturnValue(
      settledQuery([], {
        isError: true,
        error: new Error("boom"),
        data: undefined,
      }),
    );

    render(<CompTicketsTab slug="org-admin" eventId={EVENT_ID} />);

    expect(screen.getByTestId("comps-error")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(testState.refetch).toHaveBeenCalledTimes(1);
  });

  it("requests the whole ledger in one page so filtering is not a lie", () => {
    testState.compsUseQuery.mockReturnValue(settledQuery([]));

    render(<CompTicketsTab slug="org-admin" eventId={EVENT_ID} />);

    expect(testState.compsUseQuery).toHaveBeenCalledWith(
      { eventId: EVENT_ID, limit: 200, offset: 0 },
      expect.objectContaining({ enabled: true }),
    );
  });

  it("filters by origin and offers a way back", () => {
    testState.compsUseQuery.mockReturnValue(
      settledQuery([
        makeRow("hand"),
        makeRow("reward", {
          origin: "VOLUNTEER_REWARD",
          issuedByHumanId: null,
          issuedByName: null,
        }),
      ]),
    );

    render(<CompTicketsTab slug="org-admin" eventId={EVENT_ID} />);
    expect(screen.getByTestId("comp-row-hand")).toBeInTheDocument();
    expect(screen.getByTestId("comp-row-reward")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("chip-VOLUNTEER_REWARD"));
    expect(screen.queryByTestId("comp-row-hand")).toBeNull();
    expect(screen.getByTestId("comp-row-reward")).toBeInTheDocument();

    // The filtered-empty state is NOT the "no comps yet" state.
    fireEvent.click(screen.getByTestId("chip-VOLUNTEER_REWARD"));
    fireEvent.click(screen.getByTestId("chip-HAND_ISSUED"));
    expect(screen.getByTestId("comp-row-hand")).toBeInTheDocument();
    expect(screen.queryByTestId("comp-row-reward")).toBeNull();
  });

  it("uses the no-matches empty state when a filter excludes everything", () => {
    testState.compsUseQuery.mockReturnValue(settledQuery([makeRow("hand")]));

    render(<CompTicketsTab slug="org-admin" eventId={EVENT_ID} />);
    fireEvent.click(screen.getByTestId("chip-VOLUNTEER_REWARD"));

    expect(screen.getByTestId("no-results")).toHaveTextContent(
      "admin.compNoMatchesTitle",
    );
    expect(screen.queryByText("admin.compNoneYetTitle")).toBeNull();
  });

  it("says so when the ledger is longer than one page", () => {
    testState.compsUseQuery.mockReturnValue(
      settledQuery([makeRow("a")], {
        data: {
          items: [makeRow("a")],
          pageInfo: {
            total: 240,
            count: 200,
            limit: 200,
            offset: 0,
            hasNextPage: true,
            nextOffset: 200,
          },
        },
      }),
    );

    render(<CompTicketsTab slug="org-admin" eventId={EVENT_ID} />);

    expect(screen.getByText("admin.compLedgerCapped")).toBeInTheDocument();
  });
});
