import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SentBookingRequestsList — the performer's SENT pitches.
 *
 * These pins are about the unread-reply indicator on the ROW. Before it
 * existed a venue's reply was invisible from this list: the only unread chip
 * lived inside `BookingThread`, where "mounting IS reading" clears it before
 * it can be perceived, so a performer had to open every request one at a time
 * to find out anyone had answered.
 *
 * WHAT THESE DO NOT COVER — read this before treating the count as coverage.
 * The design system is mocked away here (as everywhere in this app's component
 * suites), and the `Badge` stand-in below forwards only `role` / `aria-label` /
 * `data-testid`. It DROPS `tone`, `variant` and `leadingIcon`, so the design
 * claim that carries the whole feature — that a solid info chip with a message
 * icon reads as a different CLASS of thing from the soft info `VIEWED` status
 * chip beside it — is asserted NOWHERE in this file and cannot be. Neither is
 * legibility, spacing, or row height. Those are browser jobs. What is pinned
 * here is structure and accessible name.
 *
 * The `Badge`→DOM prop pass-through these accessible-name assertions ride on is
 * pinned separately, against the REAL component, in
 * `packages/ui/src/ui/tamagui/components/__tests__/Badge.test.tsx`.
 */

const testMocks = vi.hoisted(() => ({
  humanUseQuery: vi.fn(),
  withdrawMutate: vi.fn(),
  listInvalidate: vi.fn(),
  /** ownerId → that org's `bookingRequests.list` rows, for the fan-out below. */
  orgRequestsByOwnerId: new Map<string, unknown[]>(),
  orgOwners: [] as { kind: string; orgId: string; orgName: string }[],
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      bookingRequests: { list: { invalidate: testMocks.listInvalidate } },
    }),
    // The org fan-out: `useQueries` is handed a builder that maps each
    // `orgOwnerIds` entry to its own `bookingRequests.list` call. Resolving
    // each one out of `orgRequestsByOwnerId` keeps that branch (and the
    // human+org row merge behind it) REACHABLE from tests — with a stub that
    // returned `{}` it was dead code every suite walked straight past.
    useQueries: (build: (q: unknown) => unknown[]) =>
      build({
        bookingRequests: {
          list: (input: { performerOwnerId?: string }) => ({
            data: {
              requests:
                testMocks.orgRequestsByOwnerId.get(
                  input.performerOwnerId ?? "",
                ) ?? [],
            },
            isLoading: false,
            isError: false,
          }),
        },
      }),
    bookingRequests: {
      list: { useQuery: testMocks.humanUseQuery },
      withdraw: {
        useMutation: () => ({
          mutate: testMocks.withdrawMutate,
          isPending: false,
        }),
      },
    },
  },
}));

vi.mock("@/hooks/useEventOwnerEntities", () => ({
  useEventOwnerEntities: () => ({ ownersWithSlugs: testMocks.orgOwners }),
}));

vi.mock("@/components/bookings/BookingThread", () => ({
  BookingThread: ({
    bookingRequestId,
    // The terms strip's FETCH GATE. The act has to see the header it is
    // agreeing to WHILE it types, not only after opening the agreement page —
    // and a dropped prop here is invisible without an assertion, because the
    // thread simply renders no strip.
    agreementId,
    // The act's holds panel rides this slot while the thread is open.
    nextStep,
  }: {
    bookingRequestId: string;
    agreementId?: string | null;
    nextStep?: ReactNode;
  }) => (
    <div
      data-testid="booking-thread"
      data-request={bookingRequestId}
      data-agreement={agreementId ?? ""}
    >
      {nextStep}
    </div>
  ),
}));

vi.mock("@/components/bookings/ActHoldsPanel", () => ({
  // Stand-in that reports what it was handed; the panel's own behaviour is
  // pinned in ActHoldsPanel.test.tsx. Renders nothing for no holds, like the
  // real one, so a row without holds stays clean here too.
  ActHoldsPanel: ({
    bookingRequestId,
    holds,
    testIdBase,
  }: {
    bookingRequestId: string;
    holds: unknown[];
    testIdBase?: string;
  }) =>
    holds.length ? (
      <div
        data-testid={testIdBase}
        data-request={bookingRequestId}
        data-holds={holds.length}
      />
    ) : null,
}));

vi.mock("tamagui", () => {
  // `data-testid` / `data-state` pass through so the stage rail's bars stay
  // assertable from this surface; `styled` is required because the rail's
  // segment is a `styled(YStack)`.
  const Stack = ({
    children,
    ...rest
  }: {
    children?: ReactNode;
    [key: string]: unknown;
  }) => (
    <div
      data-testid={rest["data-testid"] as string | undefined}
      data-state={rest["data-state"] as string | undefined}
    >
      {children}
    </div>
  );
  return { XStack: Stack, YStack: Stack, styled: () => Stack };
});

vi.mock("@th/ui", () => ({
  // Forwards role / aria-label / data-testid so the unread chip's ACCESSIBLE
  // NAME is assertable — the whole point of that chip is that it must not
  // announce as a bare number.
  Badge: ({
    children,
    role,
    "aria-label": ariaLabel,
    "data-testid": dataTestId,
  }: {
    children?: ReactNode;
    role?: string;
    "aria-label"?: string;
    "data-testid"?: string;
  }) => (
    <span role={role} aria-label={ariaLabel} data-testid={dataTestId}>
      {children}
    </span>
  ),
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
  NextLinkAnchor: ({
    href,
    children,
  }: {
    href: string;
    children?: ReactNode;
  }) => <a href={href}>{children}</a>,
  Spinner: () => <span>Loading</span>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  useFormatters: () => ({ dateTime: () => "date" }),
  useNotify: () => ({
    toast: { success: vi.fn(), danger: vi.fn(), warning: vi.fn() },
  }),
  // Key-echo translator (same convention as
  // ReceivedBookingRequestsList.test.tsx).
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values
      ? `${key} ${Object.entries(values)
          .map(([name, value]) => `${name}=${String(value)}`)
          .join(" ")}`
      : key,
}));

import { SentBookingRequestsList } from "../SentBookingRequestsList";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeSentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    placeName: "The Paramount Theatre",
    preferredDates: ["2026-09-01"],
    status: "VIEWED",
    createdAt: new Date("2026-08-01T12:00:00Z"),
    agreementId: null,
    unreadMessageCount: 0,
    ...overrides,
  };
}

function mountWith(rows: unknown[], orgOwnerIds: string[] = []) {
  testMocks.humanUseQuery.mockReturnValue({
    data: { requests: rows },
    isLoading: false,
    isError: false,
  });
  return render(<SentBookingRequestsList orgOwnerIds={orgOwnerIds} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  testMocks.orgRequestsByOwnerId = new Map();
  testMocks.orgOwners = [];
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SentBookingRequestsList — unread reply indicator on the ROW", () => {
  it("renders the unread chip when the venue has replied", () => {
    mountWith([makeSentRow({ unreadMessageCount: 2 })]);

    expect(screen.getByTestId("booking-sent-req-1-unread")).toBeInTheDocument();
  });

  it("gives the chip an accessible name that says what it is, not a bare number", () => {
    mountWith([makeSentRow({ unreadMessageCount: 2 })]);

    const chip = screen.getByRole("img", {
      name: "booking.threadUnreadA11y count=2",
    });
    expect(chip).toBe(screen.getByTestId("booking-sent-req-1-unread"));
  });

  it("renders NOTHING at 0 — no empty chip, no zero", () => {
    mountWith([makeSentRow({ unreadMessageCount: 0 })]);

    expect(
      screen.queryByTestId("booking-sent-req-1-unread"),
    ).not.toBeInTheDocument();
    // `0` is ALSO what the server returns when the count lookup degraded, so a
    // quiet row and a degraded row must render identically.
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  /**
   * The guard is `!(count > 0)`, not `count <= 0`, because `undefined <= 0` is
   * FALSE — the comparison form waves through the one value a row builder that
   * dropped the field would actually produce, and renders a chip reading
   * "undefined unread" with the accessible name "NaN unread messages" (ICU
   * interpolates `undefined` verbatim and plural-selects `other` for a
   * non-finite value, so nothing throws to warn you). Types no longer allow
   * this in the two shipped call sites; this pins the component's own floor.
   */
  it("renders nothing when the count is missing entirely", () => {
    const { unreadMessageCount: _dropped, ...noCount } = makeSentRow();
    mountWith([noCount]);

    expect(
      screen.queryByTestId("booking-sent-req-1-unread"),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByText(/undefined|NaN/)).not.toBeInTheDocument();
  });

  it("badges each row independently rather than the whole list", () => {
    mountWith([
      makeSentRow({ id: "req-quiet", unreadMessageCount: 0 }),
      makeSentRow({ id: "req-loud", unreadMessageCount: 5 }),
    ]);

    expect(
      screen.queryByTestId("booking-sent-req-quiet-unread"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("booking-sent-req-loud-unread"),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });

  // WAS "leaves the row's own status chip alone". The chip is gone: the stage
  // rail's REQUEST leg carries the same `bkStatus*` word, so keeping both
  // printed one fact twice. The pin survives because the word must still be on
  // the row — just from the rail now.
  it("leaves the row's own request status alone", () => {
    mountWith([makeSentRow({ status: "VIEWED", unreadMessageCount: 1 })]);

    expect(screen.getByText("admin.bkStatusViewed")).toBeInTheDocument();
    expect(screen.getByTestId("booking-sent-req-1-unread")).toBeInTheDocument();
  });

  // The rail is the performer's only view of what happened AFTER the venue
  // said yes. These four fields are copied field-by-field in BOTH the human
  // and the org loop, so a row shape can drift between them silently.
  it("shows the whole arc, including the booked event and its date", () => {
    mountWith([
      makeSentRow({
        status: "ACCEPTED",
        agreementId: "agr-1",
        agreementStatus: "ACCEPTED",
        eventId: "evt-1",
        eventStatus: "PUBLISHED",
        eventStartsAt: new Date("2026-09-19T00:00:00Z"),
      }),
    ]);

    expect(
      screen.getByTestId("booking-sent-req-1-stage-rail"),
    ).toBeInTheDocument();
    expect(screen.getByText("admin.bkStageAgrAccepted")).toBeInTheDocument();
    expect(screen.getByText("admin.eventStatusPublished")).toBeInTheDocument();
    expect(
      screen
        .getByTestId("booking-sent-req-1-stage-rail-bar-event")
        .getAttribute("data-state"),
    ).toBe("current");
  });

  /**
   * BOTH SIDES SEE THE TERMS. A booking's binding header lived only on
   * `/agreements/{id}`, so the act typed "Sep 25 works" into a thread whose
   * agreement said Sep 18 and the event was built from Sep 18. The act is the
   * side with the least reason to go looking at the agreement page, so the
   * thread has to carry the header to it — which is exactly one prop, and a
   * dropped one leaves no trace.
   */
  it("hands the thread the agreement so the act sees the terms while it types", () => {
    mountWith([makeSentRow({ status: "ACCEPTED", agreementId: "agr-1" })]);

    fireEvent.click(screen.getByTestId("booking-thread-toggle-req-1"));
    expect(screen.getByTestId("booking-thread")).toHaveAttribute(
      "data-agreement",
      "agr-1",
    );
  });

  it("hands it nothing on a pitch the venue has not accepted", () => {
    mountWith([makeSentRow({ agreementId: null })]);

    fireEvent.click(screen.getByTestId("booking-thread-toggle-req-1"));
    expect(screen.getByTestId("booking-thread")).toHaveAttribute(
      "data-agreement",
      "",
    );
  });

  /**
   * FR-013: ONE holds panel per request, in ONE of two places. Closed
   * thread → under the stage rail, so a challenge is answerable without
   * opening anything. Open thread → inside the thread's next-step slot,
   * under the ledger line that asked. Never both: two "Keep" buttons for one
   * hold on one page is exactly the accessible-name collision the run-it
   * rule exists to catch.
   */
  it("mounts the act's holds panel once — under the rail, or in the open thread", () => {
    const holds = [
      {
        id: "h1",
        calendarId: null,
        date: "2026-10-13",
        position: 2,
        status: "CHALLENGED",
        respondBy: new Date("2026-10-01T00:00:00Z"),
        lapsed: false,
      },
    ];
    mountWith([makeSentRow({ holds })]);

    const closed = screen.getAllByTestId("booking-sent-req-1-holds");
    expect(closed).toHaveLength(1);
    expect(closed[0]!.getAttribute("data-holds")).toBe("1");
    expect(screen.queryByTestId("booking-thread")).toBeNull();

    fireEvent.click(screen.getByTestId("booking-thread-toggle-req-1"));

    const open = screen.getAllByTestId("booking-sent-req-1-holds");
    expect(open).toHaveLength(1);
    // …and it now lives INSIDE the thread.
    expect(screen.getByTestId("booking-thread").contains(open[0]!)).toBe(true);
  });

  it("hands the panel an empty list — not a crash — when the row carries no holds", () => {
    mountWith([makeSentRow()]);
    expect(screen.queryByTestId("booking-sent-req-1-holds")).toBeNull();
  });

  it("carries holds through the org fan-out's separate row copy", () => {
    testMocks.orgOwners = [
      { kind: "org", orgId: "org-1", orgName: "Loud Machine" },
    ];
    testMocks.orgRequestsByOwnerId.set("org-1", [
      makeSentRow({
        id: "req-org",
        holds: [
          {
            id: "h9",
            calendarId: null,
            date: "2026-11-02",
            position: 1,
            status: "ACTIVE",
            respondBy: null,
            lapsed: false,
          },
        ],
      }),
    ]);

    mountWith([], ["org-1"]);

    expect(
      screen.getByTestId("booking-sent-req-org-holds").getAttribute("data-holds"),
    ).toBe("1");
  });

  it("carries the arc through the org fan-out's separate row copy", () => {
    testMocks.orgOwners = [
      { kind: "org", orgId: "org-1", orgName: "Loud Machine" },
    ];
    testMocks.orgRequestsByOwnerId.set("org-1", [
      makeSentRow({
        id: "req-org",
        status: "ACCEPTED",
        agreementStatus: "PROPOSED",
      }),
    ]);

    mountWith([], ["org-1"]);

    expect(screen.getByText("admin.bkStageAgrProposed")).toBeInTheDocument();
    expect(
      screen
        .getByTestId("booking-sent-req-org-stage-rail-bar-agreement")
        .getAttribute("data-state"),
    ).toBe("current");
  });

  // The org fan-out builds its rows in a SECOND loop with its own field-by-field
  // copy, so a row shape can drift between the human and org branches without
  // any other test noticing. A performer who pitches as a band sees these rows,
  // not the human ones.
  it("badges rows that arrived via the org fan-out, not just the human ones", () => {
    testMocks.orgOwners = [
      { kind: "org", orgId: "org-1", orgName: "Loud Machine" },
    ];
    testMocks.orgRequestsByOwnerId.set("org-1", [
      makeSentRow({ id: "req-org", unreadMessageCount: 3 }),
    ]);

    mountWith(
      [makeSentRow({ id: "req-human", unreadMessageCount: 0 })],
      ["org-1"],
    );

    expect(
      screen.getByTestId("booking-sent-req-org-unread"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "booking.threadUnreadA11y count=3" }),
    ).toBeInTheDocument();
    // …and the org row is attributed, so two identical venue names are
    // distinguishable.
    expect(
      screen.getByText(/account.sPerformerRequestsAs name=Loud Machine/),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("booking-sent-req-human-unread"),
    ).not.toBeInTheDocument();
  });
});
