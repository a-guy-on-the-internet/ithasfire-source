import { Suspense, type ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * EventApplicationsPage — the organizer review queue for application-gated
 * events. The pins that matter (questions-snapshot + decision-reason work):
 *
 *   • answer headings come from `questionsSnapshot[questionId].label`, NEVER
 *     the raw question UUID; pre-snapshot submissions (snapshot `{}`) fall
 *     back to the live form's label (`getApplicationForm`), then to the raw
 *     id only when the live form no longer knows the question either;
 *   • answers render in the form's question order — the snapshot entry's
 *     explicit `order` field first (jsonb does NOT preserve key order; keys
 *     come back bytewise-sorted), live-form `order` next, key positions as
 *     last resorts;
 *   • MULTI_CHOICE array answers render " · "-joined, not String()'s
 *     comma-join;
 *   • ⚠️ APPROVE NEVER SENDS `decisionReason` — the server superRefine
 *     rejects it on APPROVED. This suite exists so nobody wires the composer
 *     into the approve path;
 *   • reject goes through the optional-reason composer: a typed reason is
 *     sent trimmed, an empty one omits the key entirely (never "");
 *   • rejected rows surface the stored `decisionReason` in the expanded
 *     panel (and the expand chevron shows even when there are no answers).
 */

const testMocks = vi.hoisted(() => ({
  listUseQuery: vi.fn(),
  formUseQuery: vi.fn(),
  reviewMutateAsync: vi.fn(),
  rescindMutateAsync: vi.fn(),
  invalidate: vi.fn(),
  toastSuccess: vi.fn(),
  toastDanger: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      events: {
        listEventApplicationSubmissions: {
          invalidate: testMocks.invalidate,
        },
      },
    }),
    events: {
      listEventApplicationSubmissions: { useQuery: testMocks.listUseQuery },
      getApplicationForm: { useQuery: testMocks.formUseQuery },
      reviewEventApplicationSubmission: {
        useMutation: () => ({
          mutateAsync: testMocks.reviewMutateAsync,
          isPending: false,
        }),
      },
      rescindEventApplicationDecision: {
        useMutation: () => ({
          mutateAsync: testMocks.rescindMutateAsync,
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
  "aria-label",
  "aria-expanded",
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
  Button: ({
    children,
    disabled,
    onPress,
    testID,
    "aria-label": ariaLabel,
    "aria-expanded": ariaExpanded,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onPress?: () => void;
    testID?: string;
    "aria-label"?: string;
    "aria-expanded"?: boolean;
  }) => (
    <button
      type="button"
      data-testid={testID}
      disabled={disabled}
      onClick={onPress}
      aria-label={ariaLabel}
      aria-expanded={ariaExpanded}
    >
      {children}
    </button>
  ),
  CharCountTextarea: ({
    value,
    onChange,
    maxLength,
    placeholder,
    disabled,
    testIdBase,
  }: {
    value: string;
    onChange: (v: string) => void;
    maxLength: number;
    placeholder?: string;
    disabled?: boolean;
    testIdBase?: string;
  }) => (
    <textarea
      data-testid={testIdBase ? `${testIdBase}-textarea` : undefined}
      maxLength={maxLength}
      placeholder={placeholder}
      disabled={disabled}
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
    />
  ),
  // Lightest viable table: every column cell rendered per row, plus whatever
  // renderExpandedRow returns (null until a composer opens) — mirrors the
  // real DataTable's unconditional per-row renderExpandedRow call.
  DataTable: ({
    columns,
    rows,
    getRowKey,
    renderExpandedRow,
    emptyState,
  }: {
    columns: {
      id: string;
      header: ReactNode;
      cell: (row: unknown) => ReactNode;
    }[];
    rows: unknown[];
    getRowKey: (row: unknown) => string;
    renderExpandedRow?: (row: unknown, index: number) => ReactNode;
    emptyState?: ReactNode;
  }) => (
    <div data-testid="table">
      {rows.length === 0
        ? emptyState
        : rows.map((row, index) => (
            <div key={getRowKey(row)} data-testid={`row-${getRowKey(row)}`}>
              {columns.map((col) => (
                <div key={col.id}>{col.cell(row)}</div>
              ))}
              <div data-testid={`expanded-${getRowKey(row)}`}>
                {renderExpandedRow?.(row, index)}
              </div>
            </div>
          ))}
    </div>
  ),
  Spinner: () => <span>loading…</span>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  useFormatters: () => ({}),
  useNotify: () => ({
    toast: {
      success: testMocks.toastSuccess,
      danger: testMocks.toastDanger,
      info: testMocks.toastInfo,
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

vi.mock("@/components/auth/AdminEmailVerificationGate", () => ({
  AdminEmailVerificationGate: ({ children }: { children?: ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@/hooks/useCurrentAdminOwner", () => ({
  useCurrentAdminOwner: () => ({ isLoading: false }),
}));

vi.mock("@/hooks/useDebouncedValue", () => ({
  useDebouncedValue: (value: string) => value,
}));

vi.mock("@/lib/format", () => ({
  fmtDate: () => "2026-08-01",
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: () => "err",
}));

vi.mock("@/components/AdminTableParts", () => ({
  ActionBar: ({ countLabel }: { countLabel?: ReactNode }) => (
    <div>{countLabel}</div>
  ),
  AdminTableErrorState: ({ message }: { message?: ReactNode }) => (
    <div data-testid="applications-table-error">{message}</div>
  ),
  // Renders the real option set so the six-status chip row is assertable.
  FilterChips: ({
    options,
  }: {
    options: { value: string; label: string }[];
  }) => (
    <div data-testid="filter-chips">
      {options.map((option) => (
        <span key={option.value} data-testid={`chip-${option.value}`}>
          {option.label}
        </span>
      ))}
    </div>
  ),
  FilterRow: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SearchBar: () => null,
  TableContainer: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/data-table/ConfirmDialog", () => ({
  ConfirmDialog: ({
    open,
    onConfirm,
    onCancel,
    title,
  }: {
    open: boolean;
    onConfirm: () => void;
    onCancel: () => void;
    title: string;
  }) =>
    open ? (
      <div data-testid="confirm-dialog">
        <span>{title}</span>
        <button
          type="button"
          data-testid="confirm-dialog-confirm"
          onClick={onConfirm}
        >
          confirm
        </button>
        <button
          type="button"
          data-testid="confirm-dialog-cancel"
          onClick={onCancel}
        >
          cancel
        </button>
      </div>
    ) : null,
}));

vi.mock("../../_components/EventOpsShell", () => ({
  EventOpsShell: ({
    filters,
    children,
  }: {
    filters?: ReactNode;
    children?: ReactNode;
  }) => (
    <div>
      {filters}
      {children}
    </div>
  ),
}));

import EventApplicationsPage from "../page";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const EVENT_ID = "evt-1";

function makeSubmission(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub-1",
    eventId: EVENT_ID,
    humanId: null,
    contactEmail: "fan@example.com",
    contactPhone: null,
    status: "PENDING",
    answers: {},
    questionsSnapshot: {},
    decisionReason: null,
    reviewerHumanId: null,
    reviewedAt: null,
    approvalToken: null,
    tokenExpiresAt: null,
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: "2026-08-01T12:00:00.000Z",
    ...overrides,
  };
}

function listResult(submissions: unknown[]) {
  return {
    data: {
      eventId: EVENT_ID,
      submissions,
      pagination: { limit: 200, offset: 0, count: submissions.length },
      appliedFilters: { statuses: null },
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  };
}

function formResult(
  questions: { id: string; label: string; order: number }[],
) {
  return {
    data: {
      form: null,
      questions: questions.map((q) => ({
        formId: "form-1",
        type: "SHORT_TEXT",
        description: null,
        options: null,
        isRequired: false,
        ...q,
      })),
    },
    isLoading: false,
    isError: false,
  };
}

/**
 * `use(params)` unwraps a thenable. A plain `Promise.resolve()` SUSPENDS the
 * first render (React only trusts a tracked promise), which under act() needs
 * awkward async choreography — so hand React an already-fulfilled thenable
 * (`status`/`value` are React's internal thenable-state protocol) and `use()`
 * returns synchronously.
 */
function fulfilledParams(value: { slug: string; id: string }) {
  return Object.assign(Promise.resolve(value), {
    status: "fulfilled" as const,
    value,
  });
}

async function renderPage() {
  const view = render(
    <Suspense fallback={null}>
      <EventApplicationsPage
        params={fulfilledParams({ slug: "acme-co", id: EVENT_ID })}
      />
    </Suspense>,
  );
  await screen.findByTestId("table");
  return view;
}

function expandAnswers() {
  fireEvent.click(screen.getByLabelText("admin.viewAnswers"));
}

beforeEach(() => {
  vi.clearAllMocks();
  testMocks.listUseQuery.mockReturnValue(listResult([]));
  testMocks.formUseQuery.mockReturnValue(formResult([]));
  testMocks.reviewMutateAsync.mockResolvedValue({});
  testMocks.rescindMutateAsync.mockResolvedValue({});
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("EventApplicationsPage — answer headings from questionsSnapshot", () => {
  it("renders the snapshot label as the heading, never the raw question UUID", async () => {
    testMocks.listUseQuery.mockReturnValue(
      listResult([
        makeSubmission({
          answers: { "a1b2c3d4-0000-0000-0000-000000000001": "Word of mouth" },
          questionsSnapshot: {
            "a1b2c3d4-0000-0000-0000-000000000001": {
              label: "How did you hear about us?",
              type: "SHORT_TEXT",
            },
          },
        }),
      ]),
    );
    await renderPage();

    expandAnswers();
    expect(
      screen.getByText("How did you hear about us?"),
    ).toBeInTheDocument();
    expect(screen.getByText("Word of mouth")).toBeInTheDocument();
    expect(
      screen.queryByText("a1b2c3d4-0000-0000-0000-000000000001"),
    ).not.toBeInTheDocument();
  });

  it("falls back to the live form's label for pre-snapshot submissions (snapshot {})", async () => {
    testMocks.listUseQuery.mockReturnValue(
      listResult([
        makeSubmission({
          answers: { "q-legacy": "Yes" },
          questionsSnapshot: {},
        }),
      ]),
    );
    testMocks.formUseQuery.mockReturnValue(
      formResult([{ id: "q-legacy", label: "Bringing a plus one?", order: 0 }]),
    );
    await renderPage();

    expandAnswers();
    expect(screen.getByText("Bringing a plus one?")).toBeInTheDocument();
    expect(screen.queryByText("q-legacy")).not.toBeInTheDocument();
  });

  it("falls back to the raw id only when neither snapshot nor live form knows the question", async () => {
    testMocks.listUseQuery.mockReturnValue(
      listResult([
        makeSubmission({
          answers: { "q-orphan": "Hello" },
          questionsSnapshot: {},
        }),
      ]),
    );
    await renderPage();

    expandAnswers();
    expect(screen.getByText("q-orphan")).toBeInTheDocument();
  });

  it('renders MULTI_CHOICE array answers " · "-joined', async () => {
    testMocks.listUseQuery.mockReturnValue(
      listResult([
        makeSubmission({
          answers: { "q-multi": ["Guitar", "Vocals"] },
          questionsSnapshot: {
            "q-multi": {
              label: "What do you play?",
              type: "MULTI_CHOICE",
              options: [
                { id: "o1", label: "Guitar" },
                { id: "o2", label: "Vocals" },
              ],
            },
          },
        }),
      ]),
    );
    await renderPage();

    expandAnswers();
    expect(screen.getByText("Guitar · Vocals")).toBeInTheDocument();
  });
});

describe("EventApplicationsPage — answer ordering", () => {
  it("orders answers by the snapshot's order field, NOT jsonb's sorted key order", async () => {
    // questionsSnapshot/answers are Postgres jsonb: keys come back
    // bytewise-sorted (= UUID-lex for all-UUID keys), NOT in form order.
    // These fixtures are written in that sorted-key order deliberately —
    // an object literal in form order can't catch a key-position ranking.
    testMocks.listUseQuery.mockReturnValue(
      listResult([
        makeSubmission({
          answers: {
            "0aaa-question": "Answer shown second",
            "9zzz-question": "Answer shown first",
          },
          questionsSnapshot: {
            "0aaa-question": {
              label: "Second question",
              type: "SHORT_TEXT",
              order: 1,
            },
            "9zzz-question": {
              label: "First question",
              type: "SHORT_TEXT",
              order: 0,
            },
          },
        }),
      ]),
    );
    const { container } = await renderPage();

    expandAnswers();
    const text = container.textContent ?? "";
    expect(text.indexOf("First question")).toBeGreaterThan(-1);
    expect(text.indexOf("First question")).toBeLessThan(
      text.indexOf("Second question"),
    );
  });

  it("legacy snapshot entries WITHOUT order fields fall back to the live form's order", async () => {
    // Snapshot keys again arrive in sorted (jsonb) order; only the live
    // form knows the real order here.
    testMocks.listUseQuery.mockReturnValue(
      listResult([
        makeSubmission({
          answers: { "q-a": "A answer", "q-b": "B answer" },
          questionsSnapshot: {
            "q-a": { label: "Alpha question", type: "SHORT_TEXT" },
            "q-b": { label: "Beta question", type: "SHORT_TEXT" },
          },
        }),
      ]),
    );
    testMocks.formUseQuery.mockReturnValue(
      formResult([
        { id: "q-b", label: "Beta question", order: 0 },
        { id: "q-a", label: "Alpha question", order: 1 },
      ]),
    );
    const { container } = await renderPage();

    expandAnswers();
    const text = container.textContent ?? "";
    expect(text.indexOf("Beta question")).toBeGreaterThan(-1);
    expect(text.indexOf("Beta question")).toBeLessThan(
      text.indexOf("Alpha question"),
    );
  });

  it("orders pre-snapshot answers by the live form's question order", async () => {
    testMocks.listUseQuery.mockReturnValue(
      listResult([
        makeSubmission({
          answers: { "q-b": "B answer", "q-a": "A answer" },
          questionsSnapshot: {},
        }),
      ]),
    );
    testMocks.formUseQuery.mockReturnValue(
      formResult([
        { id: "q-a", label: "Alpha question", order: 0 },
        { id: "q-b", label: "Beta question", order: 1 },
      ]),
    );
    const { container } = await renderPage();

    expandAnswers();
    const text = container.textContent ?? "";
    expect(text.indexOf("Alpha question")).toBeGreaterThan(-1);
    expect(text.indexOf("Alpha question")).toBeLessThan(
      text.indexOf("Beta question"),
    );
  });
});

describe("EventApplicationsPage — approve", () => {
  it("approves with NO decisionReason key — the server superRefine rejects it on APPROVED", async () => {
    testMocks.listUseQuery.mockReturnValue(listResult([makeSubmission()]));
    await renderPage();

    fireEvent.click(screen.getByText("admin.approve"));
    await waitFor(() =>
      expect(testMocks.reviewMutateAsync).toHaveBeenCalledTimes(1),
    );
    // Exact payload — no decisionReason key, ever. toStrictEqual (not
    // toEqual) so even `decisionReason: undefined` fails; the key-absence
    // check makes the intent unmissable.
    const payload = testMocks.reviewMutateAsync.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(payload).toStrictEqual({
      eventId: EVENT_ID,
      submissionId: "sub-1",
      decision: "APPROVED",
    });
    expect(Object.keys(payload)).not.toContain("decisionReason");
  });
});

describe("EventApplicationsPage — reject with optional reason", () => {
  it("opens the composer instead of rejecting immediately", async () => {
    testMocks.listUseQuery.mockReturnValue(listResult([makeSubmission()]));
    await renderPage();

    fireEvent.click(screen.getByTestId("application-reject-open-sub-1"));
    expect(testMocks.reviewMutateAsync).not.toHaveBeenCalled();
    const textarea = screen.getByTestId(
      "application-reject-reason-sub-1-textarea",
    );
    expect(textarea).toBeInTheDocument();
    // 500-char server cap enforced at the input.
    expect(textarea).toHaveAttribute("maxlength", "500");
  });

  it("sends a typed reason through, trimmed", async () => {
    testMocks.listUseQuery.mockReturnValue(listResult([makeSubmission()]));
    await renderPage();

    fireEvent.click(screen.getByTestId("application-reject-open-sub-1"));
    fireEvent.change(
      screen.getByTestId("application-reject-reason-sub-1-textarea"),
      { target: { value: "  This round is at capacity.  " } },
    );
    fireEvent.click(screen.getByTestId("application-reject-confirm-sub-1"));

    await waitFor(() =>
      expect(testMocks.reviewMutateAsync).toHaveBeenCalledTimes(1),
    );
    expect(testMocks.reviewMutateAsync.mock.calls[0]![0]).toStrictEqual({
      eventId: EVENT_ID,
      submissionId: "sub-1",
      decision: "REJECTED",
      decisionReason: "This round is at capacity.",
    });
  });

  it("rejects with NO reason at all — the key is omitted, never an empty string", async () => {
    testMocks.listUseQuery.mockReturnValue(listResult([makeSubmission()]));
    await renderPage();

    fireEvent.click(screen.getByTestId("application-reject-open-sub-1"));
    fireEvent.click(screen.getByTestId("application-reject-confirm-sub-1"));

    await waitFor(() =>
      expect(testMocks.reviewMutateAsync).toHaveBeenCalledTimes(1),
    );
    const payload = testMocks.reviewMutateAsync.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(payload).toStrictEqual({
      eventId: EVENT_ID,
      submissionId: "sub-1",
      decision: "REJECTED",
    });
    expect(Object.keys(payload)).not.toContain("decisionReason");
  });

  it("cancel closes the composer without mutating", async () => {
    testMocks.listUseQuery.mockReturnValue(listResult([makeSubmission()]));
    await renderPage();

    fireEvent.click(screen.getByTestId("application-reject-open-sub-1"));
    fireEvent.click(screen.getByTestId("application-reject-cancel-sub-1"));

    expect(
      screen.queryByTestId("application-reject-reason-sub-1-textarea"),
    ).not.toBeInTheDocument();
    expect(testMocks.reviewMutateAsync).not.toHaveBeenCalled();
  });
});

describe("EventApplicationsPage — six-status filter chips and badges", () => {
  it("offers a chip for every one of the six statuses", async () => {
    await renderPage();

    for (const status of [
      "PENDING",
      "APPROVED",
      "WAITLISTED",
      "REJECTED",
      "WITHDRAWN",
      "EXPIRED",
    ]) {
      expect(screen.getByTestId(`chip-${status}`)).toBeInTheDocument();
    }
  });

  it("labels chips with the PLURAL filter keys", async () => {
    await renderPage();

    expect(screen.getByTestId("chip-APPROVED")).toHaveTextContent(
      "admin.filterApproved",
    );
    expect(screen.getByTestId("chip-WAITLISTED")).toHaveTextContent(
      "admin.filterWaitlisted",
    );
  });

  it("labels a ROW BADGE with the singular key, never the plural chip key", async () => {
    // Spanish declines the chip labels as plurals ("Aprobadas"), which is
    // wrong on a single row — the badge must use its own singular key.
    testMocks.listUseQuery.mockReturnValue(
      listResult([makeSubmission({ status: "APPROVED" })]),
    );
    await renderPage();

    expect(
      screen.getByText("admin.statusBadgeApproved"),
    ).toBeInTheDocument();
    // The plural key appears ONLY on the chip, never in the row.
    const row = screen.getByTestId("row-sub-1");
    expect(row.textContent).not.toContain("admin.filterApproved");
  });

  it("renders singular badge copy for each new status", async () => {
    for (const [status, key] of [
      ["WAITLISTED", "admin.statusBadgeWaitlisted"],
      ["WITHDRAWN", "admin.statusBadgeWithdrawn"],
      ["EXPIRED", "admin.statusBadgeExpired"],
    ] as const) {
      testMocks.listUseQuery.mockReturnValue(
        listResult([makeSubmission({ status })]),
      );
      const { unmount } = await renderPage();
      expect(screen.getByText(key)).toBeInTheDocument();
      unmount();
    }
  });
});

describe("EventApplicationsPage — waitlist decision", () => {
  it("confirms before waitlisting instead of deciding immediately", async () => {
    testMocks.listUseQuery.mockReturnValue(listResult([makeSubmission()]));
    await renderPage();

    fireEvent.click(screen.getByTestId("application-waitlist-open-sub-1"));
    expect(testMocks.reviewMutateAsync).not.toHaveBeenCalled();
    expect(screen.getByTestId("confirm-dialog")).toHaveTextContent(
      "admin.applicationWaitlistConfirmTitle",
    );
  });

  it("sends decision WAITLISTED with NO decisionReason key", async () => {
    testMocks.listUseQuery.mockReturnValue(listResult([makeSubmission()]));
    await renderPage();

    fireEvent.click(screen.getByTestId("application-waitlist-open-sub-1"));
    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));

    await waitFor(() =>
      expect(testMocks.reviewMutateAsync).toHaveBeenCalledTimes(1),
    );
    // The server's superRefine rejects `decisionReason` on anything but
    // REJECTED — toStrictEqual so even an undefined key fails.
    const payload = testMocks.reviewMutateAsync.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(payload).toStrictEqual({
      eventId: EVENT_ID,
      submissionId: "sub-1",
      decision: "WAITLISTED",
    });
    expect(Object.keys(payload)).not.toContain("decisionReason");
  });

  it("cancel closes the confirm without deciding", async () => {
    testMocks.listUseQuery.mockReturnValue(listResult([makeSubmission()]));
    await renderPage();

    fireEvent.click(screen.getByTestId("application-waitlist-open-sub-1"));
    fireEvent.click(screen.getByTestId("confirm-dialog-cancel"));

    expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument();
    expect(testMocks.reviewMutateAsync).not.toHaveBeenCalled();
  });
});

describe("EventApplicationsPage — rescind visibility", () => {
  it("offers rescind on every ORGANIZER decision, including WAITLISTED", async () => {
    for (const status of ["APPROVED", "REJECTED", "WAITLISTED"] as const) {
      testMocks.listUseQuery.mockReturnValue(
        listResult([makeSubmission({ status })]),
      );
      const { unmount } = await renderPage();
      expect(
        screen.getByTestId("application-rescind-sub-1"),
      ).toBeInTheDocument();
      unmount();
    }
  });

  it("hides rescind on WITHDRAWN and EXPIRED — the server rejects both with INVALID_STATUS", async () => {
    for (const status of ["WITHDRAWN", "EXPIRED"] as const) {
      testMocks.listUseQuery.mockReturnValue(
        listResult([makeSubmission({ status })]),
      );
      const { unmount } = await renderPage();
      expect(
        screen.queryByTestId("application-rescind-sub-1"),
      ).not.toBeInTheDocument();
      // …and no approve/reject either: these are terminal, not pending.
      expect(screen.queryByText("admin.approve")).not.toBeInTheDocument();
      unmount();
    }
  });
});

describe("EventApplicationsPage — stored decision reason", () => {
  it("shows the stored decisionReason in the expanded panel of a rejected row", async () => {
    testMocks.listUseQuery.mockReturnValue(
      listResult([
        makeSubmission({
          status: "REJECTED",
          decisionReason: "The lineup is already full.",
          reviewedAt: "2026-08-02T12:00:00.000Z",
          answers: { "q-1": "Hi" },
          questionsSnapshot: {
            "q-1": { label: "Anything to add?", type: "SHORT_TEXT" },
          },
        }),
      ]),
    );
    await renderPage();

    expandAnswers();
    expect(
      screen.getByText("admin.applicationRejectionReason"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("The lineup is already full."),
    ).toBeInTheDocument();
  });

  it("still offers the expand chevron when a rejected row has a reason but no answers", async () => {
    testMocks.listUseQuery.mockReturnValue(
      listResult([
        makeSubmission({
          status: "REJECTED",
          decisionReason: "Sold out.",
          answers: {},
          questionsSnapshot: {},
        }),
      ]),
    );
    await renderPage();

    expandAnswers();
    expect(screen.getByText("Sold out.")).toBeInTheDocument();
  });
});
