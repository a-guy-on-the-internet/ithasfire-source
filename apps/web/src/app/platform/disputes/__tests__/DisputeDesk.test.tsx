import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Container tests for the dispute desk. `@th/ui` and tamagui are mocked down
 * to bare DOM so the assertions are about THIS surface's logic (row order,
 * deep link, role gating, draft diffing, action enablement, inline errors),
 * not the design system. `Button` maps `onPress`/`disabled`/`aria-label`
 * onto a real <button> so `getByRole("button", { name })` and
 * `toBeDisabled()` mean what they normally mean.
 */

type MutationOptions = {
  meta?: { silent?: boolean };
  onSuccess?: (data: unknown, vars: unknown) => void;
  onError?: (err: unknown) => void;
};

const NOW = Date.now();
const hours = (n: number) => new Date(NOW + n * 3_600_000);

const testState = vi.hoisted(() => ({
  searchParams: "" as string,
  isMobile: false,
  roles: ["ADMIN"] as string[],
  listData: null as unknown,
  getData: null as unknown,
  getInput: null as unknown,
  getOptions: null as { refetchInterval?: number | false } | null,
  listUpdatedAt: 1,
  listFetch: vi.fn(),
  mutationOptions: {} as Record<string, MutationOptions>,
  mutate: {
    assemble: vi.fn(),
    updateDraft: vi.fn(),
    approve: vi.fn(),
    submit: vi.fn(),
  },
  invalidateList: vi.fn(),
  invalidateGet: vi.fn(),
  routerReplace: vi.fn(),
  toast: { success: vi.fn(), danger: vi.fn(), info: vi.fn(), warning: vi.fn() },
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
      if (k.startsWith("aria-") || k === "role" || k === "id" || k === "className") {
        domProps[k] = v;
      }
    }
    return React.createElement(tag ?? "div", domProps, children);
  };
  return {
    XStack: Stack,
    YStack: Stack,
    Stack,
    styled: () => Stack,
    useTheme: () => ({ color: { val: "#000" }, colorMuted: { val: "#555" } }),
  };
});

vi.mock("lucide-react", () => {
  const Icon = () => <span aria-hidden />;
  // Explicit map, not a Proxy: a Proxy that answers every key hands vitest a
  // `then` function, and the module namespace is then awaited forever.
  return {
    ShieldAlert: Icon,
    RefreshCw: Icon,
    ArrowLeft: Icon,
    Copy: Icon,
    ExternalLink: Icon,
    Ticket: Icon,
    X: Icon,
    CheckCircle2: Icon,
    RotateCcw: Icon,
    Save: Icon,
    Send: Icon,
  };
});

vi.mock("@th/ui", () => {
  const Text = ({
    children,
    color,
    id,
    role,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    color?: string;
    id?: string;
    role?: string;
    "data-testid"?: string;
  }) => (
    <span data-color={color} id={id} role={role} data-testid={testId}>
      {children}
    </span>
  );
  const Button = ({
    children,
    onPress,
    disabled,
    "aria-label": ariaLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    "aria-label"?: string;
  }) => (
    <button type="button" onClick={onPress} disabled={disabled} aria-label={ariaLabel}>
      {children}
    </button>
  );
  const Money = ({ cents, currency }: { cents: number; currency?: string }) => (
    <span>
      {cents} {currency}
    </span>
  );
  Money.format = (cents: number) => String(cents);
  return {
    Text,
    Button,
    Money,
    Badge: ({ children, tone }: { children?: ReactNode; tone?: string }) => (
      <span data-tone={tone}>{children}</span>
    ),
    Spinner: () => <span>…</span>,
    DateTime: ({ value }: { value: Date }) => <span>{String(value)}</span>,
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
    Alert: ({
      title,
      description,
      actions,
      children,
    }: {
      title?: string;
      description?: string;
      actions?: ReactNode;
      children?: ReactNode;
    }) => (
      <div role="alert">
        <strong>{title}</strong>
        {description ? <p>{description}</p> : null}
        {actions}
        {children}
      </div>
    ),
    CharCountTextarea: ({
      id,
      value,
      onChange,
      disabled,
      error,
      ariaDescribedBy,
    }: {
      id: string;
      value: string;
      onChange: (v: string) => void;
      disabled?: boolean;
      error?: boolean;
      ariaDescribedBy?: string;
    }) => (
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={ariaDescribedBy}
      />
    ),
    SegmentedControl: ({
      options,
      value,
      onChange,
      ariaLabel,
    }: {
      options: Array<{ value: string; label: string }>;
      value: string;
      onChange: (v: string) => void;
      ariaLabel?: string;
    }) => (
      <div role="radiogroup" aria-label={ariaLabel}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    ),
    DataTable: ({
      columns,
      rows,
      getRowKey,
      onRowPress,
      emptyState,
      caption,
    }: {
      columns: Array<{ id: string; cell: (row: unknown) => ReactNode }>;
      rows: unknown[];
      getRowKey: (row: unknown, i: number) => string;
      onRowPress?: (row: unknown, i: number) => void;
      emptyState?: ReactNode;
      caption?: string;
    }) => (
      <table data-testid="dispute-desk-table">
        <caption>{caption}</caption>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td>{emptyState}</td>
            </tr>
          ) : (
            rows.map((row, i) => {
              const key = getRowKey(row, i);
              return (
                <tr
                  key={key}
                  data-row-key={key}
                  data-testid={`dispute-desk-table-row-${key}`}
                  tabIndex={0}
                  onClick={() => onRowPress?.(row, i)}
                >
                  {columns.map((c) => (
                    <td key={c.id} data-col={c.id}>
                      {c.cell(row)}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    ),
    useTranslations: () => (key: string) => key,
    useFormatters: () => ({
      number: (n: number) => String(n),
      dateTime: (d: Date) => d.toISOString(),
      currency: (n: number) => String(n),
    }),
    useNotify: () => ({ toast: testState.toast }),
    useLocale: () => "en-US",
  };
});

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(testState.searchParams),
  useRouter: () => ({ replace: testState.routerReplace, push: vi.fn() }),
  usePathname: () => "/platform/disputes",
}));

vi.mock("@/hooks/useIsMobile", () => ({
  useIsMobile: () => testState.isMobile,
}));

vi.mock("@/components/support/useTabVisible", () => ({
  useTabVisible: () => true,
}));

vi.mock("@/lib/format", () => ({
  fmtDate: (_fmt: unknown, d: Date | string | null) =>
    d ? `date:${new Date(d).toISOString()}` : "—",
  fmtDateShort: (_fmt: unknown, d: Date | string | null) =>
    d ? `short:${new Date(d).toISOString()}` : "—",
}));

vi.mock("@/components/community/use-second-factor-required-toast", () => ({
  useSecondFactorRequiredToast: () => () => false,
}));

vi.mock("@/components/data-table/ConfirmDialog", () => ({
  ConfirmDialog: ({
    open,
    title,
    confirmLabel,
    onConfirm,
    onCancel,
  }: {
    open: boolean;
    title: string;
    confirmLabel?: string;
    onConfirm: () => void;
    onCancel: () => void;
  }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        <button type="button" onClick={onConfirm}>
          {confirmLabel ?? "Confirm"}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    ) : null,
}));

vi.mock("@/trpc", () => {
  const mutation = (name: keyof typeof testState.mutate) => ({
    useMutation: (options: MutationOptions) => {
      testState.mutationOptions[name] = options;
      return { mutate: testState.mutate[name], isPending: false };
    },
  });
  return {
    trpc: {
      platform: {
        checkStaffAccess: {
          useQuery: () => ({ data: { allowed: true, roles: testState.roles } }),
        },
        disputes: {
          list: {
            useQuery: () => ({
              data: testState.listData,
              isLoading: false,
              isError: false,
              error: null,
              dataUpdatedAt: testState.listUpdatedAt,
              refetch: vi.fn(),
            }),
          },
          get: {
            useQuery: (
              input: unknown,
              options: { refetchInterval?: number | false },
            ) => {
              testState.getInput = input;
              testState.getOptions = options;
              return {
                data: testState.getData,
                isLoading: false,
                isError: false,
                error: null,
                refetch: vi.fn(),
              };
            },
          },
          assemble: mutation("assemble"),
          updateDraft: mutation("updateDraft"),
          approve: mutation("approve"),
          submit: mutation("submit"),
        },
      },
      useUtils: () => ({
        platform: {
          disputes: {
            list: {
              invalidate: testState.invalidateList,
              fetch: testState.listFetch,
            },
            get: { invalidate: testState.invalidateGet },
          },
        },
      }),
    },
  };
});

import { DisputeDesk } from "../_components/DisputeDesk";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeRow(
  id: string,
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    id,
    stripeDisputeId: `dp_${id}`,
    status: "OPEN",
    reason: "fraudulent",
    amountCents: 4500,
    feeCents: 1500,
    currency: "USD",
    triageReason: null,
    evidenceDueBy: hours(24 * 10),
    evidenceHasEvidence: false,
    evidencePastDue: false,
    evidenceSubmissionCount: 0,
    evidenceSubmittedAt: null,
    fundsWithdrawnAt: null,
    closedAt: null,
    outcome: null,
    createdAt: hours(-24),
    orderId: `order-${id}`,
    orderKind: "TICKETING",
    orderShortId: "AB12CD34",
    buyerHumanId: "h1",
    buyerName: "Jane Buyer",
    eventId: "e1",
    eventTitle: `Event ${id}`,
    ownerOrgId: "o1",
    ownerOrgName: "Velvet Room",
    ownerHumanId: null,
    ownerHumanName: null,
    evidenceStatus: "DRAFT",
    evidenceAssembledVersion: 1,
    ...overrides,
  };
}

function makeEvidence(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "ev-1",
    disputeId: "d1",
    status: "DRAFT",
    fields: { productDescription: "Old", customerName: "Jane" },
    sources: {
      order: "found",
      buyer: "found",
      buyerEmail: "found",
      checkoutIp: "missing",
      billingAddress: "missing",
      event: "found",
      venue: "found",
      organizer: "found",
      refundPolicy: "missing",
      termsAcceptance: "found",
      tickets: "found",
      scanLog: "not_applicable",
      refundHistory: "found",
      cardChecks: "missing",
      ticketEmail: "found",
      statementDescriptor: "found",
      truncated: false,
    },
    assembledAt: hours(-20),
    assembledVersion: 1,
    reviewedByHumanId: null,
    reviewedAt: null,
    submittedByHumanId: null,
    submittedAt: null,
    submitError: null,
    processorSubmissionCount: null,
    createdAt: hours(-20),
    updatedAt: hours(-20),
    ...overrides,
  };
}

function makeDetail(
  id: string,
  evidence: ReturnType<typeof makeEvidence> | null,
  disputeOverrides: Partial<Record<string, unknown>> = {},
) {
  return {
    dispute: {
      id,
      stripeDisputeId: `dp_${id}`,
      stripeChargeId: "ch_1",
      paymentIntentId: "pi_1",
      status: "OPEN",
      reason: "fraudulent",
      amountCents: 4500,
      feeCents: 1500,
      feeBorneBy: "PLATFORM",
      currency: "USD",
      triageReason: null,
      linkedAt: hours(-24),
      evidenceDueBy: hours(24 * 10),
      evidenceHasEvidence: false,
      evidencePastDue: false,
      evidenceSubmissionCount: 0,
      evidenceSubmittedAt: null,
      fundsWithdrawnAt: null,
      closedAt: null,
      outcome: null,
      createdAt: hours(-24),
      updatedAt: hours(-24),
      ...disputeOverrides,
    },
    order: {
      id: "11111111-2222-4333-8444-555566667777",
      kind: "TICKETING",
      status: "DISPUTED",
      amountGrossCents: 4500,
      taxAmountCents: 0,
      currency: "USD",
      occurredAt: hours(-72),
      paymentChannel: "ONLINE",
      paymentMethodType: "card",
      billingDescriptor: "ITHAS FIRE* VELVET",
      checkoutIp: "203.0.113.7",
      disputeStatus: "OPEN",
    },
    buyer: { humanId: "h1", name: "Jane Buyer", email: "jane@example.com" },
    event: {
      id: "e1",
      title: "Event d1",
      startsAt: hours(24 * 30),
      timezone: "America/Chicago",
    },
    owner: { subjectType: "ORGANIZATION", subjectId: "o1", name: "Velvet Room" },
    evidence,
    ledger: { activeHolds: [], debits: [], heldCents: 0, debitedCents: 0 },
  };
}

function limitError() {
  return {
    message: "DISPUTE_EVIDENCE_LIMIT_EXCEEDED",
    data: {
      appCode: "DISPUTE_EVIDENCE_LIMIT_EXCEEDED",
      meta: {
        violations: [
          { kind: "field", field: "productDescription", chars: 20_500, max: 20_000 },
        ],
      },
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("DisputeDesk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.searchParams = "";
    testState.isMobile = false;
    testState.roles = ["ADMIN"];
    testState.getInput = null;
    testState.getOptions = null;
    testState.listUpdatedAt = 1;
    testState.mutationOptions = {};
    testState.listData = {
      items: [
        makeRow("d1", { evidenceDueBy: hours(-2), evidencePastDue: true }),
        makeRow("d2", { evidenceDueBy: hours(24 * 2 + 1) }),
        // +1h: the component samples `now` after the fixture, so an exact
        // 10-day distance would floor to 9d by render time.
        makeRow("d3", { evidenceDueBy: hours(24 * 10 + 1) }),
      ],
      nextCursor: null,
    };
    testState.getData = null;
  });

  it("renders rows in server order with the due-date treatment", () => {
    render(<DisputeDesk />);
    const rows = screen.getAllByTestId(/dispute-desk-table-row-/);
    expect(rows.map((r) => r.getAttribute("data-row-key"))).toEqual([
      "d1",
      "d2",
      "d3",
    ]);

    const dueCell = (row: HTMLElement) =>
      within(row).getAllByRole("cell").find((c) => c.dataset.col === "due")!;
    const overdue = within(dueCell(rows[0])).getByText("Overdue");
    expect(overdue).toHaveAttribute("data-color", "$dangerSoft");
    const soon = within(dueCell(rows[1])).getByText("in 2d");
    expect(soon).toHaveAttribute("data-color", "$warningSoft");
    const later = within(dueCell(rows[2])).getByText("in 10d");
    expect(later).toHaveAttribute("data-color", "$color");

    // Open filter is the default; nothing is selected until a row is pressed.
    expect(screen.getByRole("radio", { name: "Open" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(testState.getInput).toBeNull();
  });

  it("shows a per-filter empty state", () => {
    testState.listData = { items: [], nextCursor: null };
    render(<DisputeDesk />);
    expect(screen.getByText("No open disputes")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Closed" }));
    expect(screen.getByText("No closed disputes")).toBeInTheDocument();
  });

  it("deep-links ?dispute=<id>: opens on ALL and loads that dispute's detail", () => {
    testState.searchParams = "dispute=d2";
    testState.getData = makeDetail("d2", makeEvidence({ disputeId: "d2" }));
    render(<DisputeDesk />);
    expect(testState.getInput).toEqual({ disputeId: "d2" });
    expect(screen.getByRole("radio", { name: "All" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(
      screen.getByRole("heading", { level: 2, name: "dp_d2" }),
    ).toBeInTheDocument();
  });

  it("selects a row on press, updates the URL, and closes back to the row", () => {
    testState.getData = makeDetail("d1", makeEvidence());
    render(<DisputeDesk />);
    fireEvent.click(screen.getByTestId("dispute-desk-table-row-d1"));
    expect(testState.getInput).toEqual({ disputeId: "d1" });
    expect(testState.routerReplace).toHaveBeenCalledWith("?dispute=d1", {
      scroll: false,
    });
    fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    expect(testState.routerReplace).toHaveBeenLastCalledWith("?", {
      scroll: false,
    });
    expect(screen.queryByRole("heading", { level: 2 })).not.toBeInTheDocument();
  });

  it("hides every write action for SUPPORT and renders fields read-only", () => {
    testState.roles = ["SUPPORT"];
    testState.searchParams = "dispute=d1";
    testState.getData = makeDetail("d1", makeEvidence());
    render(<DisputeDesk />);
    for (const name of [
      "Save draft",
      "Approve evidence",
      "Submit to Stripe",
      "Re-assemble evidence",
      "Assemble evidence",
    ]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.getByText("Old")).toBeInTheDocument();
    expect(
      screen.getByText(/Editing, approval and submission need the ADMIN role/),
    ).toBeInTheDocument();
  });

  it("Save draft sends only the changed keys, with \"\" for a cleared field", () => {
    testState.searchParams = "dispute=d1";
    testState.getData = makeDetail("d1", makeEvidence());
    render(<DisputeDesk />);

    const save = screen.getByRole("button", { name: "Save draft" });
    expect(save).toBeDisabled();

    fireEvent.change(document.getElementById("evidence-productDescription")!, {
      target: { value: "New" },
    });
    fireEvent.change(document.getElementById("evidence-customerName")!, {
      target: { value: "" },
    });
    // Untouched field stays untouched (must be omitted from the payload).
    expect(
      (document.getElementById("evidence-uncategorizedText") as HTMLTextAreaElement)
        .value,
    ).toBe("");

    expect(save).toBeEnabled();
    fireEvent.click(save);
    expect(testState.mutate.updateDraft).toHaveBeenCalledWith({
      disputeId: "d1",
      fields: { productDescription: "New", customerName: "" },
    });
    expect(testState.mutationOptions.updateDraft?.meta).toEqual({ silent: true });
  });

  it("Approve is blocked while the draft is dirty, and confirms before mutating", () => {
    testState.searchParams = "dispute=d1";
    testState.getData = makeDetail("d1", makeEvidence());
    render(<DisputeDesk />);
    const approve = screen.getByRole("button", { name: "Approve evidence" });
    expect(approve).toBeEnabled();
    fireEvent.change(document.getElementById("evidence-productDescription")!, {
      target: { value: "New" },
    });
    expect(approve).toBeDisabled();
    expect(screen.getByText(/Save the draft before approving/)).toBeInTheDocument();

    fireEvent.change(document.getElementById("evidence-productDescription")!, {
      target: { value: "Old" },
    });
    fireEvent.click(approve);
    const dialog = screen.getByRole("dialog", {
      name: "Approve this evidence package?",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    expect(testState.mutate.approve).toHaveBeenCalledWith({ disputeId: "d1" });
  });

  it("Submit to Stripe is disabled unless APPROVED, and when past due", () => {
    testState.searchParams = "dispute=d1";
    testState.getData = makeDetail("d1", makeEvidence({ status: "DRAFT" }));
    const { unmount } = render(<DisputeDesk />);
    expect(screen.getByRole("button", { name: "Submit to Stripe" })).toBeDisabled();
    expect(
      screen.getByText(/Approve the package to enable submission/),
    ).toBeInTheDocument();
    unmount();

    testState.getData = makeDetail("d1", makeEvidence({ status: "APPROVED" }));
    const second = render(<DisputeDesk />);
    const submit = screen.getByRole("button", { name: "Submit to Stripe" });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    const dialog = screen.getByRole("dialog", { name: "Submit evidence to Stripe?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Submit" }));
    expect(testState.mutate.submit).toHaveBeenCalledWith({ disputeId: "d1" });
    second.unmount();

    testState.getData = makeDetail(
      "d1",
      makeEvidence({ status: "APPROVED" }),
      { evidenceDueBy: hours(-1), evidencePastDue: true },
    );
    render(<DisputeDesk />);
    expect(screen.getByRole("button", { name: "Submit to Stripe" })).toBeDisabled();
    expect(screen.getByText(/deadline has passed/)).toBeInTheDocument();
  });

  it("highlights the offending fields on DISPUTE_EVIDENCE_LIMIT_EXCEEDED", () => {
    testState.searchParams = "dispute=d1";
    testState.getData = makeDetail("d1", makeEvidence());
    render(<DisputeDesk />);
    fireEvent.change(document.getElementById("evidence-productDescription")!, {
      target: { value: "New" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    // Simulate the server rejecting the merged package.
    act(() => testState.mutationOptions.updateDraft!.onError!(limitError()));

    const field = document.getElementById("evidence-productDescription")!;
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field.getAttribute("aria-describedby")).toContain(
      "evidence-productDescription-error",
    );
    expect(document.getElementById("evidence-customerName")).not.toHaveAttribute(
      "aria-invalid",
    );
    expect(
      screen.getByText("Evidence is over Stripe's size limits"),
    ).toBeInTheDocument();
    expect(screen.getByText(/over by 500/)).toBeInTheDocument();

    // Editing the errored field clears its inline error (clear-on-input).
    fireEvent.change(field, { target: { value: "Shorter" } });
    expect(field).not.toHaveAttribute("aria-invalid");
  });

  it("shows DISPUTE_NOT_ACCEPTING_EVIDENCE inline after a rejected submit", () => {
    testState.searchParams = "dispute=d1";
    testState.getData = makeDetail("d1", makeEvidence({ status: "APPROVED" }));
    render(<DisputeDesk />);
    act(() =>
      testState.mutationOptions.submit!.onError!({
        message: "the evidence deadline has passed",
        data: { appCode: "DISPUTE_NOT_ACCEPTING_EVIDENCE" },
      }),
    );
    expect(
      screen.getByText("Stripe is not accepting evidence for this dispute"),
    ).toBeInTheDocument();
    expect(screen.getByText("the evidence deadline has passed")).toBeInTheDocument();
  });

  it("SUBMIT_FAILED shows the stored submitError and re-enables the write actions", () => {
    testState.searchParams = "dispute=d1";
    testState.getData = makeDetail(
      "d1",
      makeEvidence({
        status: "SUBMIT_FAILED",
        submitError: "Stripe: the processor evidence submission failed (rate_limit)",
      }),
    );
    render(<DisputeDesk />);
    expect(screen.getByText("Last submission failed")).toBeInTheDocument();
    expect(
      screen.getByText(/rate_limit/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve evidence" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Re-assemble evidence" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Submit to Stripe" })).toBeDisabled();
  });

  it("SUBMITTED renders read-only with the submission details and no write buttons", () => {
    testState.searchParams = "dispute=d1";
    testState.getData = makeDetail(
      "d1",
      makeEvidence({
        status: "SUBMITTED",
        submittedAt: hours(-1),
        submittedByHumanId: "human-admin",
        processorSubmissionCount: 1,
      }),
      { evidenceSubmissionCount: 1, evidenceSubmittedAt: hours(-1) },
    );
    render(<DisputeDesk />);
    expect(screen.getByText("Submitted to Stripe")).toBeInTheDocument();
    expect(screen.getByText(/by human-admin/)).toBeInTheDocument();
    expect(screen.getByText(/Stripe submissions: 1/)).toBeInTheDocument();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    for (const name of ["Save draft", "Approve evidence", "Submit to Stripe"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Re-assemble evidence" })).toBeDisabled();
  });

  it("offers Assemble evidence when no package exists (ADMIN only)", () => {
    testState.searchParams = "dispute=d1";
    testState.getData = makeDetail("d1", null);
    const first = render(<DisputeDesk />);
    fireEvent.click(screen.getByRole("button", { name: "Assemble evidence" }));
    expect(testState.mutate.assemble).toHaveBeenCalledWith({
      disputeId: "d1",
      force: false,
    });
    first.unmount();

    testState.roles = ["SUPPORT"];
    render(<DisputeDesk />);
    expect(
      screen.queryByRole("button", { name: "Assemble evidence" }),
    ).not.toBeInTheDocument();
  });

  it("on mobile, the detail replaces the queue and Back returns to it", () => {
    testState.isMobile = true;
    testState.getData = makeDetail("d1", makeEvidence());
    render(<DisputeDesk />);
    fireEvent.click(screen.getByTestId("dispute-desk-table-row-d1"));
    expect(screen.queryByTestId("dispute-desk-table")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "common.back" }));
    expect(screen.getByTestId("dispute-desk-table")).toBeInTheDocument();
  });
  it("combined counter is muted at rest and red when over the limit", () => {
    testState.searchParams = "dispute=d1";
    testState.getData = makeDetail("d1", makeEvidence());
    render(<DisputeDesk />);
    const counter = screen.getByTestId("evidence-combined-count");
    expect(counter).toHaveAttribute("data-color", "$colorMuted");
    expect(counter).toHaveTextContent("Combined 7 / 150000");

    // Server-reported combined violation → red.
    fireEvent.change(document.getElementById("evidence-productDescription")!, {
      target: { value: "New" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    act(() =>
      testState.mutationOptions.updateDraft!.onError!({
        message: "DISPUTE_EVIDENCE_LIMIT_EXCEEDED",
        data: {
          appCode: "DISPUTE_EVIDENCE_LIMIT_EXCEEDED",
          meta: { violations: [{ kind: "combined", chars: 151_000, max: 150_000 }] },
        },
      }),
    );
    expect(screen.getByTestId("evidence-combined-count")).toHaveAttribute(
      "data-color",
      "$dangerSoft",
    );
  });

  it("combined counter goes red locally once typed text exceeds 150,000", () => {
    testState.searchParams = "dispute=d1";
    testState.getData = makeDetail("d1", makeEvidence());
    render(<DisputeDesk />);
    const big = "x".repeat(19_000);
    for (const key of [
      "productDescription",
      "customerName",
      "customerEmailAddress",
      "customerPurchaseIp",
      "billingAddress",
      "serviceDate",
      "refundPolicyDisclosure",
      "refundRefusalExplanation",
    ]) {
      fireEvent.change(document.getElementById(`evidence-${key}`)!, {
        target: { value: big },
      });
    }
    expect(screen.getByTestId("evidence-combined-count")).toHaveAttribute(
      "data-color",
      "$dangerSoft",
    );
  });

  it("pauses the detail poll while the editor is dirty", () => {
    testState.searchParams = "dispute=d1";
    testState.getData = makeDetail("d1", makeEvidence());
    render(<DisputeDesk />);
    expect(testState.getOptions?.refetchInterval).toBe(30_000);
    fireEvent.change(document.getElementById("evidence-productDescription")!, {
      target: { value: "New" },
    });
    expect(testState.getOptions?.refetchInterval).toBe(false);
    fireEvent.change(document.getElementById("evidence-productDescription")!, {
      target: { value: "Old" },
    });
    expect(testState.getOptions?.refetchInterval).toBe(30_000);
  });

  it("keeps unsaved edits and shows a reload banner when the record changes underneath", () => {
    testState.searchParams = "dispute=d1";
    testState.getData = makeDetail("d1", makeEvidence());
    const view = render(<DisputeDesk />);
    const field = () =>
      document.getElementById("evidence-productDescription") as HTMLTextAreaElement;
    fireEvent.change(field(), { target: { value: "My edit" } });

    // Another operator (or a resync) moved updatedAt with different content.
    testState.getData = makeDetail(
      "d1",
      makeEvidence({
        fields: { productDescription: "Server version", customerName: "Jane" },
        updatedAt: hours(-1),
      }),
    );
    view.rerender(<DisputeDesk />);

    expect(field().value).toBe("My edit");
    expect(
      screen.getByText("This package changed while you were editing"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Your unsaved edits are kept — reload to discard them."),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reload package" }));
    expect(field().value).toBe("Server version");
    expect(
      screen.queryByText("This package changed while you were editing"),
    ).not.toBeInTheDocument();
  });

  it("a clean editor silently takes the server's new fields", () => {
    testState.searchParams = "dispute=d1";
    testState.getData = makeDetail("d1", makeEvidence());
    const view = render(<DisputeDesk />);
    testState.getData = makeDetail(
      "d1",
      makeEvidence({
        fields: { productDescription: "Server version" },
        updatedAt: hours(-1),
      }),
    );
    view.rerender(<DisputeDesk />);
    expect(
      (document.getElementById("evidence-productDescription") as HTMLTextAreaElement)
        .value,
    ).toBe("Server version");
    expect(
      screen.queryByText("This package changed while you were editing"),
    ).not.toBeInTheDocument();
  });

  it("re-baselines from the saved record so the follow-up refetch is not flagged as stale", () => {
    testState.searchParams = "dispute=d1";
    testState.getData = makeDetail("d1", makeEvidence());
    const view = render(<DisputeDesk />);
    fireEvent.change(document.getElementById("evidence-productDescription")!, {
      target: { value: "Saved text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    const saved = makeEvidence({
      fields: { productDescription: "Saved text", customerName: "Jane" },
      updatedAt: hours(-1),
    });
    act(() =>
      testState.mutationOptions.updateDraft!.onSuccess!(
        { ok: true, evidence: saved, combinedChars: 14 },
        { disputeId: "d1", fields: { productDescription: "Saved text" } },
      ),
    );
    expect(testState.invalidateGet).toHaveBeenCalled();
    testState.getData = makeDetail("d1", saved);
    view.rerender(<DisputeDesk />);
    expect(
      screen.queryByText("This package changed while you were editing"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
  });

  it("drops loaded extra pages when page 1 refreshes, and offers Load more again", async () => {
    testState.listData = {
      items: [makeRow("d1"), makeRow("d2")],
      nextCursor: "cursor-1",
    };
    testState.listFetch.mockResolvedValue({
      items: [makeRow("d9")],
      nextCursor: null,
    });
    const view = render(<DisputeDesk />);
    fireEvent.click(screen.getByRole("button", { name: "Load more disputes" }));
    await waitFor(() =>
      expect(screen.getByTestId("dispute-desk-table-row-d9")).toBeInTheDocument(),
    );
    expect(testState.listFetch).toHaveBeenCalledWith({
      status: "open",
      cursor: "cursor-1",
      limit: 50,
    });
    expect(
      screen.queryByRole("button", { name: "Load more disputes" }),
    ).not.toBeInTheDocument();

    // Page 1 refreshed (poll or Refresh): the cursor chain is void.
    testState.listUpdatedAt = 2;
    view.rerender(<DisputeDesk />);
    expect(screen.queryByTestId("dispute-desk-table-row-d9")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Load more disputes" }),
    ).toBeInTheDocument();
  });

  it("APPROVED + dirty disables Submit with a hint, and reverting re-enables it", () => {
    testState.searchParams = "dispute=d1";
    testState.getData = makeDetail("d1", makeEvidence({ status: "APPROVED" }));
    render(<DisputeDesk />);
    const submit = () => screen.getByRole("button", { name: "Submit to Stripe" });
    expect(submit()).toBeEnabled();
    fireEvent.change(document.getElementById("evidence-productDescription")!, {
      target: { value: "New" },
    });
    expect(submit()).toBeDisabled();
    expect(
      screen.getByText(/Unsaved edits — saving drops the package back to draft/),
    ).toBeInTheDocument();
    fireEvent.change(document.getElementById("evidence-productDescription")!, {
      target: { value: "Old" },
    });
    expect(submit()).toBeEnabled();
  });

  it("assemble toasts branch on skipped / fallback", () => {
    testState.searchParams = "dispute=d1";
    testState.getData = makeDetail("d1", null);
    render(<DisputeDesk />);
    const fire = (result: Record<string, unknown>) =>
      act(() =>
        testState.mutationOptions.assemble!.onSuccess!(
          { ok: true, disputeId: "d1", evidence: null, ...result },
          { disputeId: "d1", force: false },
        ),
      );
    fire({ skipped: "unlinked", fallback: false });
    expect(testState.toast.info).toHaveBeenLastCalledWith({
      title: "This dispute is not linked to an order; nothing to assemble",
    });
    fire({ skipped: "already_submitted", fallback: false });
    expect(testState.toast.info).toHaveBeenLastCalledWith({
      title: "Package already submitted",
    });
    fire({ skipped: "already_assembled", fallback: false });
    expect(testState.toast.info).toHaveBeenLastCalledWith({
      title: "Evidence package already exists",
    });
    fire({ skipped: null, fallback: true });
    expect(testState.toast.warning).toHaveBeenLastCalledWith({
      title: "Assembled a minimal draft — some sources were unavailable",
    });
    fire({ skipped: null, fallback: false });
    expect(testState.toast.success).toHaveBeenLastCalledWith({
      title: "Evidence package assembled",
    });
  });

  it("submit success toast notes a processor reconciliation", () => {
    testState.searchParams = "dispute=d1";
    testState.getData = makeDetail("d1", makeEvidence({ status: "APPROVED" }));
    render(<DisputeDesk />);
    act(() =>
      testState.mutationOptions.submit!.onSuccess!(
        {
          ok: true,
          evidence: makeEvidence({ status: "SUBMITTED" }),
          processorStatus: "under_review",
          processorSubmissionCount: 1,
          idempotencyKey: "k",
          reconciledFromProcessor: true,
        },
        { disputeId: "d1" },
      ),
    );
    expect(testState.toast.success).toHaveBeenLastCalledWith({
      title: "Stripe already held this submission; the record was reconciled.",
      message: "Stripe status: under_review. Submissions: 1.",
    });
  });

  it("DISPUTE_EVIDENCE_STATE_INVALID resyncs the record and names an in-flight operator", () => {
    testState.searchParams = "dispute=d1";
    testState.getData = makeDetail("d1", makeEvidence());
    render(<DisputeDesk />);
    fireEvent.change(document.getElementById("evidence-productDescription")!, {
      target: { value: "New" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    act(() =>
      testState.mutationOptions.updateDraft!.onError!({
        message: "DISPUTE_EVIDENCE_STATE_INVALID",
        data: {
          appCode: "DISPUTE_EVIDENCE_STATE_INVALID",
          meta: { disputeId: "d1", inFlight: true },
        },
      }),
    );
    expect(testState.invalidateGet).toHaveBeenCalled();
    expect(
      screen.getByText("Another operator is working on this package"),
    ).toBeInTheDocument();
    // The edit survives the resync.
    expect(
      (document.getElementById("evidence-productDescription") as HTMLTextAreaElement)
        .value,
    ).toBe("New");
  });

  it("labels the Stripe pivot as the live dashboard", () => {
    testState.searchParams = "dispute=d1";
    testState.getData = makeDetail("d1", makeEvidence());
    render(<DisputeDesk />);
    expect(
      screen.getByRole("link", { name: "Open in Stripe (live) (opens in a new tab)" }),
    ).toHaveAttribute("href", "https://dashboard.stripe.com/disputes/dp_d1");
  });
});
