import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * OrgReceivedRequestsTable (booking-inbox-placement FR-003): the org-as-act
 * inbox, moved out of org settings onto the Bookings workspace.
 *
 * FEATURE BEHAVIOUR IS PARITY with the account-settings
 * `ReceivedBookingRequestsList`; only presentation moved. The pins that matter:
 *
 *   • the query is the performer-inbox scope for THIS org;
 *   • rows carry organizer org name + attached event (TO_PERFORMER fields —
 *     these rows have placeId: null);
 *   • expanding a PENDING row marks it viewed;
 *   • accept goes through the confirm dialog, and — the 2026-08 fix — does not
 *     dead-end: the row stays visible (Accepted view), the toast carries an
 *     action to the freshly-minted agreement, and the agreement is reachable
 *     from the COLLAPSED row. Before this, `handleAccept` discarded the
 *     `agreementId` the mutation returns and the row vanished off the only
 *     view with a link on it;
 *   • the view counts come from the SAME filter the panel renders;
 *   • ⚠️ DECLINE WITHOUT A REASON SUCCEEDS. `BookingInbox` hard-gates decline
 *     on a ≥3-char reason; that gate is TO_VENUE-only — the server
 *     (`respond-to-booking-request.ts`) requires `declineReason` on the
 *     TO_VENUE branch and states plainly that TO_PERFORMER declines need none.
 *     Copying the venue gate here would make declining impossible without a
 *     reason. This suite exists so nobody re-adds it;
 *   • no TO_VENUE-only affordances (invite-to-claim, resend-invite) and no
 *     withdraw — withdraw belongs to the SENT tab.
 */

const testMocks = vi.hoisted(() => ({
  listUseQuery: vi.fn(),
  markViewedMutate: vi.fn(),
  respondMutate: vi.fn(),
  setData: vi.fn(),
  invalidate: vi.fn(),
  countOpenInvalidate: vi.fn(),
  routerPush: vi.fn(),
  toastSuccess: vi.fn(),
  toastDanger: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: testMocks.routerPush }),
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      bookingRequests: {
        list: {
          setData: testMocks.setData,
          invalidate: testMocks.invalidate,
        },
        countOpen: { invalidate: testMocks.countOpenInvalidate },
      },
    }),
    bookingRequests: {
      list: { useQuery: testMocks.listUseQuery },
      markViewed: {
        useMutation: () => ({
          mutate: testMocks.markViewedMutate,
          isPending: false,
        }),
      },
      respond: {
        useMutation: () => ({
          mutate: testMocks.respondMutate,
          isPending: false,
        }),
      },
    },
  },
}));

const PASSTHROUGH_PROPS = [
  "role",
  "id",
  "tabIndex",
  "onKeyDown",
  "aria-label",
  "aria-selected",
  "aria-controls",
  "aria-labelledby",
  "aria-pressed",
  "aria-hidden",
] as const;

vi.mock("tamagui", () => {
  const Stack = (props: Record<string, unknown>) => {
    const passed: Record<string, unknown> = {};
    for (const key of PASSTHROUGH_PROPS) {
      if (key in props) passed[key] = props[key];
    }
    return (
      <div
        data-testid={props.testID as string | undefined}
        onClick={props.onPress as (() => void) | undefined}
        {...passed}
      >
        {props.children as ReactNode}
      </div>
    );
  };
  return { XStack: Stack, YStack: Stack, styled: () => Stack };
});

vi.mock("@th/ui", () => ({
  Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  // `aria-hidden` / `tabIndex` are forwarded for ONE caller:
  // `OpenAgreementButton` renders `<Button tag="span">` INSIDE an anchor, where
  // the anchor is the control and the Button is decoration. The real Tamagui
  // Button emits `role="button" tabindex="0"` regardless of `tag`, and a
  // `<button>` here is likewise focusable — so this stand-in reproduces the
  // hazard faithfully enough for the neutralising attributes to be assertable.
  Button: ({
    children,
    disabled,
    onPress,
    testID,
    testId,
    tabIndex,
    "aria-hidden": ariaHidden,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onPress?: () => void;
    testID?: string;
    testId?: string;
    tabIndex?: number;
    "aria-hidden"?: boolean;
  }) => (
    <button
      type="button"
      data-testid={testId ?? testID}
      disabled={disabled}
      onClick={onPress}
      tabIndex={tabIndex}
      aria-hidden={ariaHidden}
    >
      {children}
    </button>
  ),
  // Lightest viable table: every column cell, the `rowActions` cell (which is
  // where the COLLAPSED-row agreement link lives), an expand trigger wired to
  // onRowPress, and whatever renderExpandedRow returns (null until expanded).
  DataTable: ({
    columns,
    rows,
    getRowKey,
    onRowPress,
    renderExpandedRow,
    renderMobileCard,
    rowActions,
    emptyState,
  }: {
    columns: { id: string; header: ReactNode; cell: (row: unknown) => ReactNode }[];
    rows: unknown[];
    getRowKey: (row: unknown) => string;
    onRowPress?: (row: unknown) => void;
    renderExpandedRow?: (row: unknown) => ReactNode;
    renderMobileCard?: (row: unknown) => ReactNode;
    rowActions?: {
      header?: ReactNode;
      render?: (row: unknown, index: number) => ReactNode;
    };
    emptyState?: ReactNode;
  }) => (
    <div data-testid="table">
      <div data-testid="table-headers">
        {columns.map((col) => (
          <span key={col.id}>{col.header}</span>
        ))}
        {rowActions?.header ? <span>{rowActions.header}</span> : null}
      </div>
      {rows.length === 0
        ? emptyState
        : rows.map((row, index) => (
            <div key={getRowKey(row)} data-testid={`row-${getRowKey(row)}`}>
              {columns.map((col) => (
                <div key={col.id}>{col.cell(row)}</div>
              ))}
              <div data-testid={`actions-${getRowKey(row)}`}>
                {rowActions?.render?.(row, index)}
              </div>
              <div data-testid={`card-${getRowKey(row)}`}>
                {renderMobileCard?.(row)}
              </div>
              <button
                type="button"
                data-testid={`expand-${getRowKey(row)}`}
                onClick={() => onRowPress?.(row)}
              >
                expand
              </button>
              <div data-testid={`expanded-${getRowKey(row)}`}>
                {renderExpandedRow?.(row)}
              </div>
            </div>
          ))}
    </div>
  ),
  NextLinkAnchor: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children?: ReactNode;
    "aria-label"?: string;
  }) => (
    <a href={href} aria-label={rest["aria-label"]}>
      {children}
    </a>
  ),
  Spinner: () => <span>loading…</span>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  TextInput: ({
    value,
    onChangeText,
    testID,
    testId,
    placeholder,
  }: {
    value?: string;
    onChangeText?: (v: string) => void;
    testID?: string;
    testId?: string;
    placeholder?: string;
  }) => (
    <input
      data-testid={testId ?? testID}
      placeholder={placeholder}
      value={value ?? ""}
      onChange={(e) => onChangeText?.(e.currentTarget.value)}
    />
  ),
  useFormatters: () => ({
    dateTime: (d: Date) => new Date(d).toISOString().slice(0, 10),
  }),
  useNotify: () => ({
    toast: {
      success: testMocks.toastSuccess,
      danger: testMocks.toastDanger,
      warning: testMocks.toastWarning,
    },
  }),
  useTranslations:
    () =>
    (key: string, values?: Record<string, unknown>) =>
      values
        ? `${key} ${Object.entries(values)
            .map(([name, value]) => `${name}=${String(value)}`)
            .join(" ")}`
        : key,
}));

vi.mock("@/lib/format", () => ({
  fmtCurrency: (_fmt: unknown, cents: number) => `$${cents / 100}`,
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: () => "err",
}));

vi.mock("@/components/data-table/ConfirmDialog", () => ({
  ConfirmDialog: ({
    open,
    title,
    description,
    confirmLabel,
    onConfirm,
  }: {
    open: boolean;
    title: string;
    description: ReactNode;
    confirmLabel?: string;
    onConfirm: () => void;
  }) =>
    open ? (
      <div role="dialog">
        <div>{title}</div>
        <div data-testid="dialog-description">{description}</div>
        <button
          type="button"
          data-testid="dialog-confirm"
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));

import { OrgReceivedRequestsTable } from "../_components/OrgReceivedRequestsTable";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    direction: "TO_PERFORMER",
    // TO_PERFORMER rows carry no place.
    placeId: null,
    placeName: null,
    organizerOrgId: "org-9",
    organizerOrgName: "Nashville Nights",
    attachedEventId: "ev-1",
    attachedEventTitle: "Basement Showcase",
    attachedEventStartsAt: new Date("2026-09-04T02:00:00Z"),
    message: "We'd love to have you on the bill.",
    preferredDates: ["2026-09-03"],
    setLengthMinutes: 45,
    feeType: "GUARANTEE",
    feeAmountCents: 50000,
    feeCurrency: "usd",
    status: "PENDING",
    viewedAt: null,
    respondedAt: null,
    declineReason: null,
    agreementId: null,
    expiresAt: null,
    createdAt: new Date("2026-08-01T12:00:00Z"),
    ...overrides,
  };
}

function listResult(requests: unknown[]) {
  return {
    data: { requests },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  };
}

function renderTable() {
  return render(<OrgReceivedRequestsTable orgId="org-1" slug="dev-qa" />);
}

function expandRow(id: string) {
  fireEvent.click(screen.getByTestId(`expand-${id}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  testMocks.listUseQuery.mockReturnValue(listResult([]));
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("OrgReceivedRequestsTable — query + rows", () => {
  it("queries the performer-inbox scope for this org", () => {
    renderTable();
    expect(testMocks.listUseQuery.mock.calls[0]![0]).toEqual({
      scope: "performer-inbox",
      performerOwnerType: "org",
      performerOwnerId: "org-1",
    });
  });

  it("shows the organizer org name and the attached event", () => {
    testMocks.listUseQuery.mockReturnValue(listResult([makeRow()]));
    renderTable();

    expect(screen.getAllByText("Nashville Nights").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Basement Showcase").length).toBeGreaterThan(0);
  });

  it("falls back to the generic organizer label when the org name is missing", () => {
    testMocks.listUseQuery.mockReturnValue(
      listResult([makeRow({ organizerOrgName: null })]),
    );
    renderTable();
    expect(screen.getAllByText("admin.bkRcvOrgFallback").length).toBeGreaterThan(
      0,
    );
  });

  it("renders the calm empty state when nothing has been received", () => {
    renderTable();
    expect(screen.getByText("admin.bkWsRcvEmptyTitle")).toBeInTheDocument();
    expect(screen.getByText("admin.bkRcvEmpty")).toBeInTheDocument();
  });

  it("offers a retry on a failed load", () => {
    const refetch = vi.fn();
    testMocks.listUseQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch,
    });
    renderTable();

    expect(screen.getByText("admin.bkRcvLoadFailed")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("org-rcv-retry"));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

describe("OrgReceivedRequestsTable — open/accepted/all views", () => {
  it("hides answered rows until another view is chosen", () => {
    testMocks.listUseQuery.mockReturnValue(
      listResult([
        makeRow(),
        makeRow({ id: "req-2", status: "ACCEPTED", agreementId: "ag-7" }),
      ]),
    );
    renderTable();

    expect(screen.getByTestId("row-req-1")).toBeInTheDocument();
    expect(screen.queryByTestId("row-req-2")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("org-rcv-filter-accepted"));
    expect(screen.getByTestId("row-req-2")).toBeInTheDocument();
    expect(screen.queryByTestId("row-req-1")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("org-rcv-filter-all"));
    expect(screen.getByTestId("row-req-1")).toBeInTheDocument();
    expect(screen.getByTestId("row-req-2")).toBeInTheDocument();
  });

  it("counts EXACTLY what each view renders", () => {
    // A view advertising a number it does not show is the specific defect the
    // Accepted view was added to fix; the counts and the rows therefore run
    // through one `rowsForView`.
    testMocks.listUseQuery.mockReturnValue(
      listResult([
        makeRow(),
        makeRow({ id: "req-2", status: "ACCEPTED", agreementId: "ag-7" }),
        makeRow({ id: "req-3", status: "DECLINED" }),
      ]),
    );
    renderTable();

    expect(screen.getByText("admin.bkInboxTabOpen (1)")).toBeInTheDocument();
    expect(
      screen.getByText("admin.bkInboxTabAccepted (1)"),
    ).toBeInTheDocument();
    expect(screen.getByText("admin.bkInboxTabAll (3)")).toBeInTheDocument();

    const rendered = (): number =>
      screen.getAllByTestId(/^row-req-/).length;
    expect(rendered()).toBe(1);
    fireEvent.click(screen.getByTestId("org-rcv-filter-accepted"));
    expect(rendered()).toBe(1);
    fireEvent.click(screen.getByTestId("org-rcv-filter-all"));
    expect(rendered()).toBe(3);
  });

  it("links accepted rows to their agreement from the COLLAPSED row", () => {
    // Not only from the expanded detail: the pre-fix route to an agreement was
    // notice-the-row-moved → find it → expand it.
    testMocks.listUseQuery.mockReturnValue(
      listResult([makeRow({ status: "ACCEPTED", agreementId: "ag-7" })]),
    );
    renderTable();

    fireEvent.click(screen.getByTestId("org-rcv-filter-all"));
    const actions = screen.getByTestId("actions-req-1");
    // Opens INSIDE this org's admin shell, not on the standalone page.
    const link = actions.querySelector('a[href="/admin/dev-qa/bookings/agreement/ag-7"]');
    expect(link).not.toBeNull();
    // The ANCHOR is the control and carries the name; the inner Button is
    // neutralised so it is not a second tab stop announcing the same thing.
    // The name names the ORGANIZER too — the visible label is identical on
    // every accepted row, so a links list would otherwise be N copies of
    // "Open agreement".
    expect(link).toHaveAttribute(
      "aria-label",
      "admin.baOpenAgreement — Nashville Nights",
    );
    const inner = screen.getByTestId("org-rcv-row-agreement-req-1");
    expect(inner).toHaveAttribute("aria-hidden", "true");
    expect(inner).toHaveAttribute("tabindex", "-1");
  });

  it("renders NO agreement link on an accepted row that has no agreement id", () => {
    // `agreementId` is optional on the respond output schema — a missing id
    // must never become `/agreements/undefined`.
    testMocks.listUseQuery.mockReturnValue(
      listResult([makeRow({ status: "ACCEPTED", agreementId: null })]),
    );
    const { container } = renderTable();

    fireEvent.click(screen.getByTestId("org-rcv-filter-all"));
    expandRow("req-1");
    expect(
      container.querySelectorAll('a[href*="/bookings/agreement/"]'),
    ).toHaveLength(0);
  });
});

describe("OrgReceivedRequestsTable — mark viewed on expand", () => {
  it("marks a PENDING row viewed when it is expanded", () => {
    testMocks.listUseQuery.mockReturnValue(listResult([makeRow()]));
    renderTable();

    expandRow("req-1");
    expect(testMocks.markViewedMutate).toHaveBeenCalledTimes(1);
    expect(testMocks.markViewedMutate.mock.calls[0]![0]).toEqual({
      bookingRequestId: "req-1",
    });
  });

  it("does not re-mark an already-VIEWED row", () => {
    testMocks.listUseQuery.mockReturnValue(
      listResult([makeRow({ status: "VIEWED" })]),
    );
    renderTable();

    expandRow("req-1");
    expect(testMocks.markViewedMutate).not.toHaveBeenCalled();
  });
});

describe("OrgReceivedRequestsTable — accept", () => {
  it("confirms before responding, then accepts", () => {
    testMocks.listUseQuery.mockReturnValue(listResult([makeRow()]));
    renderTable();

    expandRow("req-1");
    fireEvent.click(screen.getByTestId("org-rcv-accept-req-1"));
    expect(screen.getByTestId("dialog-description").textContent).toBe(
      "admin.bkRcvAcceptConfirmBody org=Nashville Nights",
    );

    fireEvent.click(screen.getByTestId("dialog-confirm"));
    expect(testMocks.respondMutate).toHaveBeenCalledTimes(1);
    expect(testMocks.respondMutate.mock.calls[0]![0]).toEqual({
      bookingRequestId: "req-1",
      action: "accept",
    });
  });

  it("KEEPS the accepted row visible and offers a working agreement route", () => {
    // The dead end this fixes: the row left the Open view the instant it was
    // accepted, the toast carried no action, and `handleAccept` threw away the
    // `agreementId` the mutation had just returned.
    testMocks.listUseQuery.mockReturnValue(listResult([makeRow()]));
    testMocks.respondMutate.mockImplementation(
      (
        _input: unknown,
        opts: { onSuccess: (r: { agreementId?: string }) => void },
      ) => opts.onSuccess({ agreementId: "ag-9" }),
    );
    renderTable();

    expandRow("req-1");
    fireEvent.click(screen.getByTestId("org-rcv-accept-req-1"));
    fireEvent.click(screen.getByTestId("dialog-confirm"));

    // The view followed the request instead of leaving it nowhere.
    expect(screen.getByTestId("org-rcv-filter-accepted")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    const toastArgs = testMocks.toastSuccess.mock.calls[0]![0] as {
      title: string;
      message?: string;
      action?: { label: string; onPress: () => void };
    };
    expect(toastArgs.title).toBe("admin.bkRcvAcceptSuccess");
    expect(toastArgs.message).toBe("admin.bkInboxAcceptSuccessMessage");
    expect(toastArgs.action?.label).toBe("admin.baOpenAgreement");
    toastArgs.action?.onPress();
    expect(testMocks.routerPush).toHaveBeenCalledWith("/admin/dev-qa/bookings/agreement/ag-9");
  });

  it("offers NO agreement action when the response carries no agreement id", () => {
    testMocks.listUseQuery.mockReturnValue(listResult([makeRow()]));
    testMocks.respondMutate.mockImplementation(
      (
        _input: unknown,
        opts: { onSuccess: (r: { agreementId?: string }) => void },
      ) => opts.onSuccess({}),
    );
    renderTable();

    expandRow("req-1");
    fireEvent.click(screen.getByTestId("org-rcv-accept-req-1"));
    fireEvent.click(screen.getByTestId("dialog-confirm"));

    const toastArgs = testMocks.toastSuccess.mock.calls[0]![0] as {
      action?: unknown;
    };
    expect(toastArgs.action).toBeUndefined();
    expect(testMocks.routerPush).not.toHaveBeenCalled();
  });
});

describe("OrgReceivedRequestsTable — countOpen invalidation", () => {
  /**
   * `countOpen` is a SEPARATE query key from `list` with its own staleTime, so
   * `list.invalidate()` leaves it stale: the tab label would keep its old "(N)"
   * above an emptied inbox and the admin rail's Bookings badge would keep its
   * pre-response number for the rest of the session.
   */
  it("invalidates countOpen as well as list after an accept", () => {
    testMocks.listUseQuery.mockReturnValue(listResult([makeRow()]));
    testMocks.respondMutate.mockImplementation(
      (
        _input: unknown,
        opts: { onSuccess: (r: { agreementId?: string }) => void },
      ) => opts.onSuccess({ agreementId: "ag-9" }),
    );
    renderTable();

    expandRow("req-1");
    fireEvent.click(screen.getByTestId("org-rcv-accept-req-1"));
    fireEvent.click(screen.getByTestId("dialog-confirm"));

    expect(testMocks.invalidate).toHaveBeenCalledTimes(1);
    expect(testMocks.countOpenInvalidate).toHaveBeenCalledTimes(1);
  });

  it("invalidates countOpen as well as list after a decline", () => {
    testMocks.listUseQuery.mockReturnValue(listResult([makeRow()]));
    testMocks.respondMutate.mockImplementation(
      (_input: unknown, opts: { onSuccess: () => void }) => opts.onSuccess(),
    );
    renderTable();

    expandRow("req-1");
    fireEvent.click(screen.getByTestId("org-rcv-decline-req-1"));
    fireEvent.click(screen.getByTestId("org-rcv-decline-confirm-req-1"));

    expect(testMocks.invalidate).toHaveBeenCalledTimes(1);
    expect(testMocks.countOpenInvalidate).toHaveBeenCalledTimes(1);
  });
});

describe("OrgReceivedRequestsTable — decline (TO_PERFORMER: reason OPTIONAL)", () => {
  it("declines with NO reason at all — the venue inbox's ≥3-char gate must not leak here", () => {
    testMocks.listUseQuery.mockReturnValue(listResult([makeRow()]));
    renderTable();

    expandRow("req-1");
    fireEvent.click(screen.getByTestId("org-rcv-decline-req-1"));

    const confirm = screen.getByTestId("org-rcv-decline-confirm-req-1");
    expect(confirm).not.toBeDisabled();

    fireEvent.click(confirm);
    expect(testMocks.respondMutate).toHaveBeenCalledTimes(1);
    // No `declineReason` key at all — never an empty string.
    expect(testMocks.respondMutate.mock.calls[0]![0]).toEqual({
      bookingRequestId: "req-1",
      action: "decline",
    });
  });

  it("still blocks a 1–2 char reason (the server's schema floor)", () => {
    testMocks.listUseQuery.mockReturnValue(listResult([makeRow()]));
    renderTable();

    expandRow("req-1");
    fireEvent.click(screen.getByTestId("org-rcv-decline-req-1"));
    fireEvent.change(screen.getByTestId("org-rcv-decline-reason-req-1"), {
      target: { value: "no" },
    });

    expect(screen.getByTestId("org-rcv-decline-confirm-req-1")).toBeDisabled();
    fireEvent.click(screen.getByTestId("org-rcv-decline-confirm-req-1"));
    expect(testMocks.respondMutate).not.toHaveBeenCalled();
  });

  it("sends a typed reason through when it clears the floor", () => {
    testMocks.listUseQuery.mockReturnValue(listResult([makeRow()]));
    renderTable();

    expandRow("req-1");
    fireEvent.click(screen.getByTestId("org-rcv-decline-req-1"));
    fireEvent.change(screen.getByTestId("org-rcv-decline-reason-req-1"), {
      target: { value: "  Already booked  " },
    });
    fireEvent.click(screen.getByTestId("org-rcv-decline-confirm-req-1"));

    expect(testMocks.respondMutate.mock.calls[0]![0]).toEqual({
      bookingRequestId: "req-1",
      action: "decline",
      declineReason: "Already booked",
    });
  });
});

describe("OrgReceivedRequestsTable — no wrong-direction affordances", () => {
  it("offers no withdraw, no invite-to-claim and no resend on received rows", () => {
    testMocks.listUseQuery.mockReturnValue(
      listResult([
        makeRow(),
        makeRow({ id: "req-2", status: "ACCEPTED", agreementId: "ag-7" }),
      ]),
    );
    const { container } = renderTable();

    fireEvent.click(screen.getByTestId("org-rcv-filter-all"));
    expandRow("req-1");
    expandRow("req-2");

    expect(screen.queryByTestId("hub-withdraw-req-1")).not.toBeInTheDocument();
    expect(
      screen.queryByText("account.sPerformerWithdraw"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("booking-resend-invite-req-2"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/invite sent/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/via your website/i)).not.toBeInTheDocument();
    // No off-platform contact channel on this direction.
    expect(container.querySelectorAll('a[href^="mailto:"]')).toHaveLength(0);
  });
});
