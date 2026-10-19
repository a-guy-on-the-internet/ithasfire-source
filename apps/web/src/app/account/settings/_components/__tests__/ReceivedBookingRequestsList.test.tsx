import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ReceivedBookingRequestsList (organizer-booking-requests FR-007): the act's
 * received organizer requests. These tests pin the interaction contract —
 * open rows expose Accept/Decline (accept via confirm dialog, decline with a
 * required reason), accepted rows link to their agreement, PENDING rows are
 * marked viewed on expand, and the empty state stays calm.
 */

const testMocks = vi.hoisted(() => ({
  listUseQuery: vi.fn(),
  respondMutate: vi.fn(),
  markViewedMutate: vi.fn(),
  listSetData: vi.fn(),
  listInvalidate: vi.fn(),
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      bookingRequests: {
        list: {
          setData: testMocks.listSetData,
          invalidate: testMocks.listInvalidate,
        },
      },
    }),
    bookingRequests: {
      list: { useQuery: testMocks.listUseQuery },
      respond: {
        useMutation: () => ({
          mutate: testMocks.respondMutate,
          isPending: false,
        }),
      },
      markViewed: {
        useMutation: () => ({
          mutate: testMocks.markViewedMutate,
          isPending: false,
        }),
      },
    },
  },
}));

vi.mock("tamagui", () => {
  const Stack = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  return { XStack: Stack, YStack: Stack };
});

vi.mock("@th/ui", () => ({
  Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Button: ({
    children,
    onPress,
    disabled,
    testID,
    testId,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    testID?: string;
    testId?: string;
  }) => (
    <button
      type="button"
      onClick={onPress}
      disabled={disabled}
      data-testid={testId ?? testID}
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
  Spinner: () => <span>Loading</span>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  TextInput: ({
    value,
    onChangeText,
    testID,
    testId,
    "aria-label": ariaLabel,
  }: {
    value?: string;
    onChangeText?: (next: string) => void;
    testID?: string;
    testId?: string;
    "aria-label"?: string;
  }) => (
    <input
      value={value ?? ""}
      onChange={(e) => onChangeText?.(e.target.value)}
      data-testid={testId ?? testID}
      aria-label={ariaLabel}
    />
  ),
  useFormatters: () => ({
    dateTime: () => "date",
    currency: (value: number) => `$${value}`,
  }),
  useNotify: () => ({
    toast: { success: vi.fn(), danger: vi.fn(), warning: vi.fn() },
  }),
  // Key-echo translator (same convention as BookingDefaultsEditor.test.tsx).
  useTranslations:
    () =>
    (key: string, values?: Record<string, unknown>) =>
      values
        ? `${key} ${Object.entries(values)
            .map(([name, value]) => `${name}=${String(value)}`)
            .join(" ")}`
        : key,
}));

vi.mock("@/components/data-table/ConfirmDialog", () => ({
  ConfirmDialog: ({
    open,
    onConfirm,
    title,
  }: {
    open: boolean;
    onConfirm: () => void;
    title: string;
  }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        <button type="button" data-testid="confirm-accept" onClick={onConfirm}>
          confirm
        </button>
      </div>
    ) : null,
}));

import { ReceivedBookingRequestsList } from "../ReceivedBookingRequestsList";

function requestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    direction: "TO_PERFORMER",
    organizerOrgId: "org-1",
    organizerOrgName: "Ryman Presents",
    attachedEventId: null,
    attachedEventTitle: null,
    attachedEventStartsAt: null,
    preferredDates: ["2026-08-01", "2026-08-02"],
    message: "We'd love to book you for a Friday showcase.",
    feeType: "GUARANTEE",
    feeAmountCents: 25_000,
    feeCurrency: "usd",
    setLengthMinutes: 45,
    status: "PENDING",
    viewedAt: null,
    respondedAt: null,
    declineReason: null,
    agreementId: null,
    expiresAt: new Date("2026-08-04T00:00:00Z"),
    createdAt: new Date("2026-07-21T00:00:00Z"),
    ...overrides,
  };
}

function mockList(requests: Record<string, unknown>[]) {
  testMocks.listUseQuery.mockReturnValue({
    data: { requests },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
}

describe("ReceivedBookingRequestsList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the calm empty state when there are no requests", () => {
    mockList([]);

    render(<ReceivedBookingRequestsList owner={{ ownerType: "human" }} />);

    expect(screen.getByText("admin.bkRcvEmpty")).toBeInTheDocument();
  });

  it("queries the performer-inbox scope for the org act", () => {
    mockList([]);

    render(
      <ReceivedBookingRequestsList
        owner={{ ownerType: "org", ownerId: "org-9" }}
      />,
    );

    expect(testMocks.listUseQuery).toHaveBeenCalledWith(
      {
        scope: "performer-inbox",
        performerOwnerType: "org",
        performerOwnerId: "org-9",
      },
      expect.anything(),
    );
  });

  it("shows Accept/Decline on an expanded open row and marks it viewed", () => {
    mockList([requestRow()]);

    render(<ReceivedBookingRequestsList owner={{ ownerType: "human" }} />);

    fireEvent.click(screen.getByTestId("booking-rcv-details-req-1"));

    expect(screen.getByTestId("booking-rcv-accept-req-1")).toBeInTheDocument();
    expect(screen.getByTestId("booking-rcv-decline-req-1")).toBeInTheDocument();
    // PENDING → viewed, fire-and-forget on expand.
    expect(testMocks.markViewedMutate).toHaveBeenCalledWith(
      { bookingRequestId: "req-1" },
      expect.anything(),
    );
  });

  it("accepts through the confirm dialog", () => {
    mockList([requestRow({ status: "VIEWED" })]);

    render(<ReceivedBookingRequestsList owner={{ ownerType: "human" }} />);

    fireEvent.click(screen.getByTestId("booking-rcv-details-req-1"));
    fireEvent.click(screen.getByTestId("booking-rcv-accept-req-1"));
    fireEvent.click(screen.getByTestId("confirm-accept"));

    expect(testMocks.respondMutate).toHaveBeenCalledWith(
      { bookingRequestId: "req-1", action: "accept" },
      expect.anything(),
    );
    // Already VIEWED — no redundant markViewed call.
    expect(testMocks.markViewedMutate).not.toHaveBeenCalled();
  });

  it("declines with a typed reason", () => {
    mockList([requestRow({ status: "VIEWED" })]);

    render(<ReceivedBookingRequestsList owner={{ ownerType: "human" }} />);

    fireEvent.click(screen.getByTestId("booking-rcv-details-req-1"));
    fireEvent.click(screen.getByTestId("booking-rcv-decline-req-1"));

    const confirm = screen.getByTestId("booking-rcv-decline-confirm-req-1");

    fireEvent.change(screen.getByTestId("booking-rcv-decline-reason-req-1"), {
      target: { value: "Dates don't work for us" },
    });
    fireEvent.click(confirm);

    expect(testMocks.respondMutate).toHaveBeenCalledWith(
      {
        bookingRequestId: "req-1",
        action: "decline",
        declineReason: "Dates don't work for us",
      },
      expect.anything(),
    );
  });

  it("declines without a reason — TO_PERFORMER declines need none (reason omitted, not sent empty)", () => {
    mockList([requestRow({ status: "VIEWED" })]);

    render(<ReceivedBookingRequestsList owner={{ ownerType: "human" }} />);

    fireEvent.click(screen.getByTestId("booking-rcv-details-req-1"));
    fireEvent.click(screen.getByTestId("booking-rcv-decline-req-1"));

    const confirm = screen.getByTestId("booking-rcv-decline-confirm-req-1");
    // Optional reason: submit is enabled with an empty field.
    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);

    expect(testMocks.respondMutate).toHaveBeenCalledWith(
      { bookingRequestId: "req-1", action: "decline" },
      expect.anything(),
    );
  });

  it("still blocks a typed reason under the server's 3-char floor", () => {
    mockList([requestRow({ status: "VIEWED" })]);

    render(<ReceivedBookingRequestsList owner={{ ownerType: "human" }} />);

    fireEvent.click(screen.getByTestId("booking-rcv-details-req-1"));
    fireEvent.click(screen.getByTestId("booking-rcv-decline-req-1"));

    fireEvent.change(screen.getByTestId("booking-rcv-decline-reason-req-1"), {
      target: { value: "no" },
    });
    const confirm = screen.getByTestId("booking-rcv-decline-confirm-req-1");
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(testMocks.respondMutate).not.toHaveBeenCalled();
  });

  it("links an accepted row to its agreement", () => {
    mockList([
      requestRow({ status: "ACCEPTED", agreementId: "agr-7" }),
    ]);

    render(<ReceivedBookingRequestsList owner={{ ownerType: "human" }} />);

    const link = screen
      .getByTestId("booking-rcv-agreement-req-1")
      .closest("a");
    expect(link).toHaveAttribute("href", "/agreements/agr-7");
    // No respond affordances on a settled row.
    fireEvent.click(screen.getByTestId("booking-rcv-details-req-1"));
    expect(
      screen.queryByTestId("booking-rcv-accept-req-1"),
    ).not.toBeInTheDocument();
    expect(testMocks.markViewedMutate).not.toHaveBeenCalled();
  });
});
