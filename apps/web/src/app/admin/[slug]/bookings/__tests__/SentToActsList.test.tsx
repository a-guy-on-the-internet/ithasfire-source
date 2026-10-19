import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SentToActsList — the org's outbound requests, lifted verbatim out of the old
 * `BookingsHub` into the "Sent to acts" tab (booking-inbox-placement FR-002).
 * Behaviour is meant to be UNCHANGED, so this suite pins it directly rather
 * than only asserting its absence from the received tab:
 *
 *   • the organizer-scope query input;
 *   • withdraw → optimistic WITHDRAWN, and the button leaves with the status;
 *   • a failed withdraw rolls the row back and toasts;
 *   • one in-flight withdraw disables withdraw on EVERY row;
 *   • no withdraw affordance on already-answered rows (the `isOpen` guard);
 *   • the empty state and the agreement link on ACCEPTED rows.
 *
 * WITHDRAW LIVES HERE AND ONLY HERE — it is the sender's action. The
 * counterpart pin (no withdraw on received rows) is in
 * `OrgReceivedRequestsTable.test.tsx`.
 */

const testMocks = vi.hoisted(() => ({
  listUseQuery: vi.fn(),
  withdrawMutate: vi.fn(),
  invalidate: vi.fn(),
  toastDanger: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      bookingRequests: { list: { invalidate: testMocks.invalidate } },
    }),
    bookingRequests: {
      list: { useQuery: testMocks.listUseQuery },
      withdraw: {
        useMutation: () => ({
          mutate: testMocks.withdrawMutate,
          isPending: false,
        }),
      },
    },
  },
}));

vi.mock("tamagui", () => {
  const Stack = ({
    children,
    onPress,
    testID,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    testID?: string;
  }) => (
    <div data-testid={testID} onClick={onPress}>
      {children}
    </div>
  );
  return { XStack: Stack, YStack: Stack, styled: () => Stack };
});

vi.mock("@th/ui", () => ({
  Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Button: ({
    children,
    disabled,
    onPress,
    testID,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onPress?: () => void;
    testID?: string;
  }) => (
    <button
      type="button"
      data-testid={testID}
      disabled={disabled}
      onClick={onPress}
    >
      {children}
    </button>
  ),
  NextLinkAnchor: ({
    href,
    children,
  }: {
    href: string;
    children?: ReactNode;
  }) => <a href={href}>{children}</a>,
  Spinner: () => <span>loading…</span>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
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

import { SentToActsList } from "../_components/SentToActsList";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function sentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    direction: "TO_PERFORMER",
    performerDisplayName: "Alex Rivera",
    attachedEventTitle: null,
    attachedEventStartsAt: null,
    preferredDates: ["2026-09-01"],
    feeType: "GUARANTEE",
    feeAmountCents: 50000,
    feeCurrency: "usd",
    status: "PENDING",
    declineReason: null,
    agreementId: null,
    createdAt: new Date("2026-08-01T12:00:00Z"),
    ...overrides,
  };
}

function listResult(requests: unknown[]) {
  return { data: { requests }, isLoading: false, isError: false };
}

beforeEach(() => {
  vi.clearAllMocks();
  testMocks.listUseQuery.mockReturnValue(listResult([]));
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SentToActsList — query + states", () => {
  it("queries the organizer scope for this org", () => {
    render(<SentToActsList orgId="org-1" slug="dev-qa" />);
    expect(testMocks.listUseQuery.mock.calls[0]![0]).toEqual({
      scope: "organizer",
      organizerOrgId: "org-1",
    });
  });

  it("renders the calm empty state when nothing was sent", () => {
    render(<SentToActsList orgId="org-1" slug="dev-qa" />);
    expect(screen.getByText("admin.bkHubActsEmpty")).toBeInTheDocument();
  });

  it("shows a spinner while loading and a message on failure", () => {
    testMocks.listUseQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    });
    const { rerender } = render(<SentToActsList orgId="org-1" slug="dev-qa" />);
    expect(screen.getByText("loading…")).toBeInTheDocument();

    testMocks.listUseQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    });
    rerender(<SentToActsList orgId="org-1" slug="dev-qa" />);
    expect(screen.getByText("admin.bkHubLoadFailed")).toBeInTheDocument();
  });

  it("names the act, falling back when the display name is missing", () => {
    testMocks.listUseQuery.mockReturnValue(
      listResult([
        sentRow(),
        sentRow({ id: "req-2", performerDisplayName: null }),
      ]),
    );
    render(<SentToActsList orgId="org-1" slug="dev-qa" />);
    expect(screen.getByText("Alex Rivera")).toBeInTheDocument();
    expect(screen.getByText("admin.bkHubActFallback")).toBeInTheDocument();
  });
});

describe("SentToActsList — withdraw", () => {
  it("withdraws optimistically and drops the button with the status", () => {
    testMocks.listUseQuery.mockReturnValue(listResult([sentRow()]));
    render(<SentToActsList orgId="org-1" slug="dev-qa" />);

    expect(screen.getByText("admin.bkStatusPending")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("hub-withdraw-req-1"));

    expect(testMocks.withdrawMutate).toHaveBeenCalledTimes(1);
    expect(testMocks.withdrawMutate.mock.calls[0]![0]).toEqual({
      bookingRequestId: "req-1",
    });
    // Optimistic: the row flips to WITHDRAWN, which is not an open status, so
    // the withdraw affordance goes with it.
    expect(screen.getByText("admin.bkStatusWithdrawn")).toBeInTheDocument();
    expect(screen.queryByTestId("hub-withdraw-req-1")).not.toBeInTheDocument();
  });

  it("rolls the row back and toasts when the withdraw fails", () => {
    testMocks.listUseQuery.mockReturnValue(listResult([sentRow()]));
    testMocks.withdrawMutate.mockImplementation(
      (_input: unknown, opts: { onError: (err: unknown) => void }) =>
        opts.onError(new Error("nope")),
    );
    render(<SentToActsList orgId="org-1" slug="dev-qa" />);

    fireEvent.click(screen.getByTestId("hub-withdraw-req-1"));

    expect(screen.getByText("admin.bkStatusPending")).toBeInTheDocument();
    expect(screen.getByTestId("hub-withdraw-req-1")).toBeInTheDocument();
    expect(testMocks.toastDanger).toHaveBeenCalledTimes(1);
    expect(testMocks.toastDanger.mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        title: "account.sPerformerWithdrawFailed",
      }),
    );
  });

  it("disables withdraw on EVERY row while one is in flight", () => {
    testMocks.listUseQuery.mockReturnValue(
      listResult([sentRow(), sentRow({ id: "req-2" })]),
    );
    render(<SentToActsList orgId="org-1" slug="dev-qa" />);

    // The mutation mock never settles, so the pending latch stays set.
    fireEvent.click(screen.getByTestId("hub-withdraw-req-2"));
    expect(screen.getByTestId("hub-withdraw-req-1")).toBeDisabled();

    fireEvent.click(screen.getByTestId("hub-withdraw-req-1"));
    expect(testMocks.withdrawMutate).toHaveBeenCalledTimes(1);
  });

  it("offers no withdraw on rows that were already answered", () => {
    testMocks.listUseQuery.mockReturnValue(
      listResult([
        sentRow({ id: "a1", status: "ACCEPTED", agreementId: "ag-9" }),
        sentRow({
          id: "d1",
          status: "DECLINED",
          declineReason: "Booked that night",
        }),
      ]),
    );
    render(<SentToActsList orgId="org-1" slug="dev-qa" />);

    expect(screen.queryByTestId("hub-withdraw-a1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("hub-withdraw-d1")).not.toBeInTheDocument();
    expect(
      screen.getByText("admin.bkHubDeclined reason=Booked that night"),
    ).toBeInTheDocument();
  });
});

describe("SentToActsList — accepted rows", () => {
  it("links to the agreement", () => {
    testMocks.listUseQuery.mockReturnValue(
      listResult([sentRow({ status: "ACCEPTED", agreementId: "ag-9" })]),
    );
    render(<SentToActsList orgId="org-1" slug="dev-qa" />);

    expect(
      screen.getByTestId("hub-view-agreement-req-1").closest("a"),
    ).toHaveAttribute("href", "/admin/dev-qa/bookings/agreement/ag-9");
  });
});
