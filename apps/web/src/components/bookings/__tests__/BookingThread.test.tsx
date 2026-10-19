import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression pins for the booking-request conversation thread
 * (booking-conversation FR-001..003 / venue-hierarchy FR-012).
 *
 * The headline pin is the CURSOR-WALK LOOP. The thread accumulates cursor
 * pages into local state, and the first cut advanced a page counter inside the
 * same effect that watched `data`. Because the query hook hands back a fresh
 * object on many deliveries, that effect set state → re-rendered → re-ran,
 * forever: the BookingInbox suite OOM-killed its vitest worker
 * ("JS heap out of memory") instead of failing an assertion. These tests mount
 * with a hook mock that returns a NEW object every render — the exact shape
 * that triggered it — so a regression fails here loudly and cheaply.
 *
 * Only chrome is mocked (tamagui, @th/ui, trpc); the component's own paging,
 * merge, unread and post logic is real.
 */

const mocks = vi.hoisted(() => ({
  postMutate: vi.fn(),
  markReadMutate: vi.fn(),
  refetch: vi.fn(),
  countOpenInvalidate: vi.fn(),
  listInvalidate: vi.fn(),
  /** Cursor → page. Mutable per test. */
  pages: new Map<string, { items: unknown[]; nextCursor: string | null }>(),
  attachments: [] as unknown[],
  listRenderCount: 0,
  /** Every `bookingAgreements.get` the thread issues. Must stay empty when
   *  the row carries no agreement — see the fetch-gate pins below. */
  agreementUseQuery: vi.fn(),
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      bookingRequests: {
        countOpen: { invalidate: mocks.countOpenInvalidate },
        list: { invalidate: mocks.listInvalidate },
      },
    }),
    bookingRequests: {
      messages: {
        list: {
          // Deliberately a FRESH object every call — see the file header.
          useQuery: (input: { cursor: string | null }) => {
            mocks.listRenderCount += 1;
            const page = mocks.pages.get(input.cursor ?? "__first__") ?? {
              items: [],
              nextCursor: null,
            };
            return {
              data: { items: [...page.items], nextCursor: page.nextCursor },
              isLoading: false,
              isFetching: false,
              error: null,
              refetch: mocks.refetch,
            };
          },
        },
        post: {
          useMutation: () => ({
            mutate: mocks.postMutate,
            isPending: false,
          }),
        },
        markRead: {
          useMutation: () => ({
            mutate: mocks.markReadMutate,
            isPending: false,
          }),
        },
      },
      attachments: {
        list: {
          useQuery: () => ({
            data: mocks.attachments,
            isLoading: false,
            error: null,
            refetch: vi.fn(),
          }),
        },
      },
    },
    bookingAgreements: {
      get: {
        useQuery: (input: unknown) => {
          mocks.agreementUseQuery(input);
          return {
            data: {
              agreement: {
                status: "ACCEPTED",
                proposedDate: new Date("2026-09-19T00:00:00.000Z"),
                proposedEndDate: null,
                guaranteeCents: 65000,
              },
              pitchProvenance: {
                proposedDate: true,
                proposedEndDate: false,
                guaranteeCents: true,
                description: false,
              },
              // DRAFT-only server-side; an ACCEPTED agreement is read-only, so
              // the strip's link says "View agreement" rather than promising a
              // change the destination page will refuse.
              mayEdit: false,
            },
            error: null,
            isFetching: false,
            refetch: vi.fn(),
          };
        },
      },
    },
  },
}));

vi.mock("tamagui", () => {
  // Passes `data-testid` / `id` / `role` through — the component hangs its
  // test ids on the stacks, so a props-dropping mock would make every
  // getByTestId here a false negative.
  const Stack = ({
    children,
    ...rest
  }: {
    children?: ReactNode;
    [key: string]: unknown;
  }) => (
    <div
      data-testid={rest["data-testid"] as string | undefined}
      id={rest.id as string | undefined}
      role={rest.role as string | undefined}
    >
      {children}
    </div>
  );
  return { XStack: Stack, YStack: Stack, styled: () => Stack };
});

type SpanProps = { children?: ReactNode; "data-testid"?: string };

vi.mock("@th/ui", () => ({
  Badge: ({ children, ...rest }: SpanProps) => (
    <span data-testid={rest["data-testid"]}>{children}</span>
  ),
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
    <button type="button" data-testid={testID} disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
  Spinner: () => <span>loading…</span>,
  // Ledger entries link out to the agreement / the event, so the anchor has to
  // be real enough to assert an `href` on.
  NextLinkAnchor: ({
    href,
    children,
    ...rest
  }: SpanProps & { href?: string }) => (
    <a href={href} data-testid={rest["data-testid"]}>
      {children}
    </a>
  ),
  Text: ({ children, ...rest }: SpanProps) => (
    <span data-testid={rest["data-testid"]}>{children}</span>
  ),
  TextInput: ({
    value,
    onChangeText,
    testId,
    placeholder,
  }: {
    value?: string;
    onChangeText?: (v: string) => void;
    testId?: string;
    placeholder?: string;
  }) => (
    <input
      data-testid={testId}
      value={value ?? ""}
      placeholder={placeholder}
      onChange={(e) => onChangeText?.(e.target.value)}
    />
  ),
  useFormatters: () => ({
    dateTime: (d: Date) => d.toISOString(),
    // The terms strip formats a guarantee through `fmtCurrency`, which reaches
    // for this — without it the strip throws and takes the whole thread down.
    currency: (value: number, currency: string) => `${currency} ${value}`,
    locale: "en",
  }),
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));

vi.mock("lucide-react", () => ({
  ArrowUpDown: () => <span />,
  Bookmark: () => <span />,
  BookmarkCheck: () => <span />,
  BookmarkX: () => <span />,
  Timer: () => <span />,
  UserCheck: () => <span />,
  CalendarCheck: () => <span />,
  CalendarClock: () => <span />,
  CalendarPlus: () => <span />,
  CalendarX: () => <span />,
  Check: () => <span />,
  CircleCheck: () => <span />,
  Clock: () => <span />,
  Eye: () => <span />,
  FileCheck: () => <span />,
  FileText: () => <span />,
  FileX: () => <span />,
  MessageSquare: () => <span />,
  Paperclip: () => <span />,
  RefreshCw: () => <span />,
  Send: () => <span />,
  Undo2: () => <span />,
  X: () => <span />,
}));

// The deal in plain words (A3) reads its own query; it has its own tests.
vi.mock("@/components/deals", () => ({ DealSummary: () => null }));
vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: (err: unknown) => String(err),
}));

import { BookingThread } from "../BookingThread";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

function message(
  id: string,
  authorSide: "VENUE" | "PERFORMER" | "SYSTEM",
  body: string,
  readAt: Date | null = null,
  minutes = 0,
) {
  return {
    id,
    bookingRequestId: REQUEST_ID,
    authorSide,
    authorHumanId: null,
    body,
    systemKind: null,
    systemData: null,
    readAt,
    createdAt: new Date(Date.UTC(2026, 7, 18, 12, minutes)),
  };
}

/**
 * A LEDGER ENTRY as the server writes one: `authorSide` SYSTEM, an EMPTY body,
 * the sentence living in `systemKind` + `systemData`. `readAt` stays null on
 * these forever — the server never stamps them.
 */
function entry(
  id: string,
  systemKind: string,
  systemData: Record<string, unknown> | null = {},
  minutes = 0,
) {
  return {
    id,
    bookingRequestId: REQUEST_ID,
    authorSide: "SYSTEM" as const,
    authorHumanId: "99999999-9999-4999-8999-999999999999",
    body: "",
    systemKind,
    systemData,
    readAt: null,
    createdAt: new Date(Date.UTC(2026, 7, 18, 12, minutes)),
  };
}

const AGREEMENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EVENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pages = new Map();
  mocks.attachments = [];
  mocks.listRenderCount = 0;
});

/**
 * ── THE TERMS STRIP'S FETCH GATE ─────────────────────────────────────────────
 *
 * The strip exists because a booking's prose and its binding header lived on
 * two pages: an act and a venue agreed "Sep 25 works" in this thread while the
 * agreement said Sep 18, and the event was built from Sep 18.
 *
 * The gate is a MOUNT, not an `enabled` flag. `BookingThread` only renders
 * `BookingTermsStrip` when the caller passes an `agreementId`, so a request
 * with no agreement never creates the `bookingAgreements.get` hook — no query
 * key, no cache entry, and no empty frame above the composer. These two pin
 * both halves of that.
 */
describe("BookingThread — terms strip", () => {
  it("renders nothing and issues no agreement read without an agreementId", () => {
    mocks.pages.set("__first__", {
      items: [message("m1", "PERFORMER", "can we do the 25th?")],
      nextCursor: null,
    });
    render(<BookingThread bookingRequestId={REQUEST_ID} side="VENUE" />);

    expect(screen.queryByTestId("booking-thread-terms")).toBeNull();
    expect(screen.queryByTestId("booking-thread-terms-error")).toBeNull();
    expect(mocks.agreementUseQuery).not.toHaveBeenCalled();
  });

  it("shows the binding header directly above the composer once there is one", () => {
    mocks.pages.set("__first__", {
      items: [message("m1", "PERFORMER", "Sep 25 works — we'll take it")],
      nextCursor: null,
    });
    const { container } = render(
      <BookingThread
        bookingRequestId={REQUEST_ID}
        side="VENUE"
        agreementId={AGREEMENT_ID}
      />,
    );

    expect(mocks.agreementUseQuery).toHaveBeenCalledWith({
      agreementId: AGREEMENT_ID,
    });
    const strip = screen.getByTestId("booking-thread-terms");
    // The date on file, legible from inside the conversation that contradicts
    // it — that IS the fix.
    expect(
      screen.getByTestId("booking-thread-terms-date").textContent,
    ).toContain("2026-09-19T00:00:00.000Z");
    expect(
      container.querySelector(`a[href="/agreements/${AGREEMENT_ID}"]`),
    ).toBeTruthy();

    // Ordering is load-bearing: the strip sits between the newest message and
    // the box the next one is typed into, not at the top where a long thread
    // scrolls it away.
    const composer = screen.getByTestId("booking-thread-input");
    const messages = screen.getByTestId("booking-thread-messages");
    expect(
      messages.compareDocumentPosition(strip) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      strip.compareDocumentPosition(composer) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("opens the agreement INSIDE the admin shell when mounted in one", () => {
    mocks.pages.set("__first__", {
      items: [message("m1", "PERFORMER", "Sep 25 works — we'll take it")],
      nextCursor: null,
    });
    const { container } = render(
      <BookingThread
        bookingRequestId={REQUEST_ID}
        side="VENUE"
        eventAdminSlug="acme"
        agreementId={AGREEMENT_ID}
      />,
    );

    expect(
      container.querySelector(
        `a[href="/admin/acme/bookings/agreement/${AGREEMENT_ID}"]`,
      ),
    ).toBeTruthy();
    expect(
      container.querySelector(`a[href="/agreements/${AGREEMENT_ID}"]`),
    ).toBeNull();
  });
});

describe("BookingThread", () => {
  it("renders the empty state when the request has no messages", () => {
    mocks.pages.set("__first__", { items: [], nextCursor: null });
    render(<BookingThread bookingRequestId={REQUEST_ID} side="VENUE" />);
    expect(screen.getByTestId("booking-thread-empty")).toBeTruthy();
  });

  it("renders one page of messages in order", () => {
    mocks.pages.set("__first__", {
      items: [
        message("m1", "PERFORMER", "we'd love the 18th"),
        message("m2", "VENUE", "the 18th works", new Date(), 5),
      ],
      nextCursor: null,
    });
    render(<BookingThread bookingRequestId={REQUEST_ID} side="VENUE" />);
    expect(screen.getByText("we'd love the 18th")).toBeTruthy();
    expect(screen.getByText("the 18th works")).toBeTruthy();
  });

  /**
   * THE pin. Two cursor pages, a hook that returns a fresh object every
   * render: the walk must reach the end and STOP. A regression here does not
   * fail an assertion — it hangs the worker — so the render-count ceiling is
   * the real assertion.
   */
  it("walks the cursor to the end and settles (no render loop)", () => {
    mocks.pages.set("__first__", {
      items: [message("m1", "PERFORMER", "page one")],
      nextCursor: "m1",
    });
    mocks.pages.set("m1", {
      items: [message("m2", "VENUE", "page two", new Date(), 5)],
      nextCursor: null,
    });

    render(<BookingThread bookingRequestId={REQUEST_ID} side="VENUE" />);

    // Both pages are on screen — page 1 alone would hide the NEWEST message,
    // which is the whole point of this surface.
    expect(screen.getByText("page one")).toBeTruthy();
    expect(screen.getByText("page two")).toBeTruthy();
    // A loop shows up as an unbounded render count; a settled walk is a
    // handful of renders.
    expect(mocks.listRenderCount).toBeLessThan(25);
  });

  it("never duplicates a message when the same page is delivered twice", () => {
    mocks.pages.set("__first__", {
      items: [message("m1", "PERFORMER", "only once")],
      nextCursor: null,
    });
    const { rerender } = render(
      <BookingThread bookingRequestId={REQUEST_ID} side="VENUE" />,
    );
    rerender(<BookingThread bookingRequestId={REQUEST_ID} side="VENUE" />);
    expect(screen.getAllByText("only once")).toHaveLength(1);
  });

  it("counts counterparty messages with no readAt as unread and stamps them once", () => {
    mocks.pages.set("__first__", {
      items: [
        message("m1", "PERFORMER", "unread one"),
        message("m2", "PERFORMER", "unread two", null, 5),
        message("m3", "VENUE", "mine, never unread", null, 6),
      ],
      nextCursor: null,
    });
    render(<BookingThread bookingRequestId={REQUEST_ID} side="VENUE" />);

    expect(screen.getByTestId("booking-thread-unread").textContent).toContain(
      '"count":2',
    );
    expect(mocks.markReadMutate).toHaveBeenCalledTimes(1);
    const [input] = mocks.markReadMutate.mock.calls[0]!;
    expect(input).toMatchObject({ bookingRequestId: REQUEST_ID, side: "VENUE" });
    // Stamps up to the NEWEST loaded message, never "now".
    expect((input as { upToCreatedAt: Date }).upToCreatedAt.toISOString()).toBe(
      new Date(Date.UTC(2026, 7, 18, 12, 6)).toISOString(),
    );
  });

  /**
   * The list-row unread chip is fed by `bookingRequests.list`, a DIFFERENT
   * query key from anything this component reads — and this component does not
   * unmount when its row collapses, so nothing else refetches that list
   * (`refetchOnWindowFocus` is off globally; both list surfaces hold a 15s
   * staleTime). Without this invalidate the row sat there claiming "2 unread"
   * directly above the thread the operator had just read, for the whole
   * session. That is worse than the bug the badge exists to fix, so it is
   * pinned.
   */
  it("invalidates the list query when the read stamp succeeds, so row chips clear", () => {
    mocks.markReadMutate.mockImplementation(
      (
        _input: unknown,
        opts?: { onSuccess?: () => void; onError?: () => void },
      ) => {
        opts?.onSuccess?.();
      },
    );
    mocks.pages.set("__first__", {
      items: [
        message("m1", "PERFORMER", "unread one"),
        message("m2", "PERFORMER", "unread two", null, 5),
      ],
      nextCursor: null,
    });

    render(<BookingThread bookingRequestId={REQUEST_ID} side="VENUE" />);

    expect(mocks.markReadMutate).toHaveBeenCalledTimes(1);
    expect(mocks.listInvalidate).toHaveBeenCalledTimes(1);
    // The local patch still runs — the in-thread chip clears too.
    expect(screen.queryByTestId("booking-thread-unread")).toBeNull();
  });

  it("does not invalidate the list when there was nothing to stamp", () => {
    mocks.pages.set("__first__", {
      items: [message("m1", "PERFORMER", "seen", new Date())],
      nextCursor: null,
    });
    render(<BookingThread bookingRequestId={REQUEST_ID} side="VENUE" />);
    expect(mocks.listInvalidate).not.toHaveBeenCalled();
  });

  it("does not stamp read when everything is already read", () => {
    mocks.pages.set("__first__", {
      items: [message("m1", "PERFORMER", "seen", new Date())],
      nextCursor: null,
    });
    render(<BookingThread bookingRequestId={REQUEST_ID} side="VENUE" />);
    expect(screen.queryByTestId("booking-thread-unread")).toBeNull();
    expect(mocks.markReadMutate).not.toHaveBeenCalled();
  });

  it("posts the trimmed body for the declared side", () => {
    mocks.pages.set("__first__", { items: [], nextCursor: null });
    render(<BookingThread bookingRequestId={REQUEST_ID} side="PERFORMER" />);

    fireEvent.change(screen.getByTestId("booking-thread-input"), {
      target: { value: "  can we do the 20th?  " },
    });
    fireEvent.click(screen.getByTestId("booking-thread-send"));

    expect(mocks.postMutate).toHaveBeenCalledTimes(1);
    expect(mocks.postMutate.mock.calls[0]![0]).toEqual({
      bookingRequestId: REQUEST_ID,
      side: "PERFORMER",
      body: "can we do the 20th?",
    });
  });

  it("keeps Send disabled for an empty or whitespace-only body", () => {
    mocks.pages.set("__first__", { items: [], nextCursor: null });
    render(<BookingThread bookingRequestId={REQUEST_ID} side="VENUE" />);

    const send = screen.getByTestId("booking-thread-send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("booking-thread-input"), {
      target: { value: "   " },
    });
    expect(
      (screen.getByTestId("booking-thread-send") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  /**
   * THE UNLOCK PIN, and the inverse of what this file used to assert.
   *
   * The thread used to take an `isClosed` prop that both call sites derived
   * from the request's status, replacing the whole composer with a "this
   * request is closed" note at DECLINED / WITHDRAWN / EXPIRED. That is exactly
   * when the two parties most need the channel — "what happened with that
   * Friday?" had nowhere to go — so the server dropped its status gate and the
   * prop went with it.
   *
   * The component now has NO status input at all, which is why this test can
   * only assert the shape of the render: the composer is unconditional, and
   * there is no way for a caller to take it away. If a status gate ever grows
   * back here, the prop it needs would have to be threaded in first, and this
   * test is where the intent it violates is written down.
   */
  it("always offers the composer — a terminal-status thread stays writable", () => {
    mocks.pages.set("__first__", {
      items: [message("m1", "VENUE", "sorry, not this time", new Date())],
      nextCursor: null,
    });
    render(<BookingThread bookingRequestId={REQUEST_ID} side="PERFORMER" />);

    // The history reads AND the composer is there to answer it.
    expect(screen.getByText("sorry, not this time")).toBeTruthy();
    expect(screen.getByTestId("booking-thread-input")).toBeTruthy();
    expect(screen.getByTestId("booking-thread-send")).toBeTruthy();
    expect(screen.queryByTestId("booking-thread-closed-note")).toBeNull();

    // And it actually posts — an enabled-looking button that no-ops would pass
    // the assertions above.
    fireEvent.change(screen.getByTestId("booking-thread-input"), {
      target: { value: "what happened with that Friday?" },
    });
    fireEvent.click(screen.getByTestId("booking-thread-send"));
    expect(mocks.postMutate).toHaveBeenCalledTimes(1);
    expect(mocks.postMutate.mock.calls[0]![0]).toEqual({
      bookingRequestId: REQUEST_ID,
      side: "PERFORMER",
      body: "what happened with that Friday?",
    });
  });

  it("lists attachments read-only (no add/delete affordances)", () => {
    mocks.pages.set("__first__", { items: [], nextCursor: null });
    mocks.attachments = [
      {
        id: "a1",
        bookingRequestId: REQUEST_ID,
        storageKey: `booking-requests/${REQUEST_ID}/rider.pdf`,
        fileName: "rider.pdf",
        contentType: "application/pdf",
        sizeBytes: 2048,
        createdAt: new Date(),
      },
    ];
    render(<BookingThread bookingRequestId={REQUEST_ID} side="VENUE" />);

    expect(screen.getByTestId("booking-thread-attachments")).toBeTruthy();
    expect(screen.getByText("rider.pdf")).toBeTruthy();
    expect(screen.getByText("2 KB")).toBeTruthy();
    // The storage key is an internal object path — never rendered.
    expect(screen.queryByText(/booking-requests\//)).toBeNull();
  });

  it("renders no attachments block when the request has none", () => {
    mocks.pages.set("__first__", { items: [], nextCursor: null });
    render(<BookingThread bookingRequestId={REQUEST_ID} side="VENUE" />);
    expect(screen.queryByTestId("booking-thread-attachments")).toBeNull();
  });
});

/**
 * ── LEDGER ENTRIES ───────────────────────────────────────────────────────────
 *
 * The thread is the booking's timeline: lifecycle transitions arrive as SYSTEM
 * rows with an EMPTY body. Before this, every one of them rendered as an empty
 * speech bubble labelled "Ithas Fire" with nothing in it.
 *
 * The unread pins here are the load-bearing ones. The server deliberately
 * excludes entries from BOTH `countUnreadByRequest` and `markRead`, so a local
 * derivation that counted them would light this component's badge for rows the
 * list-row chip (a different query key entirely) reports as zero — the two
 * surfaces disagreeing directly above one another — and the optimistic patch
 * would paint a `readAt` the database will never hold.
 */
describe("BookingThread — system entries", () => {
  it("renders an entry as a ledger line, not an empty bubble", () => {
    mocks.pages.set("__first__", {
      items: [entry("s1", "booking_request.accepted", {
        agreementId: AGREEMENT_ID,
      })],
      nextCursor: null,
    });
    render(<BookingThread bookingRequestId={REQUEST_ID} side="VENUE" />);

    expect(screen.getByTestId("booking-thread-entry-s1")).toBeTruthy();
    // Not a message bubble, and no author attribution at all.
    expect(screen.queryByTestId("booking-thread-message-s1")).toBeNull();
    expect(screen.queryByText("booking.threadSystem")).toBeNull();
    expect(screen.getByText("booking.entryRequestAccepted")).toBeTruthy();
  });

  it("gives each kind its own copy", () => {
    mocks.pages.set("__first__", {
      items: [
        entry("s1", "booking_request.opened", {
          direction: "TO_VENUE",
          source: "PLATFORM",
        }),
        entry("s2", "booking_request.viewed", {}, 1),
        entry("s3", "booking_agreement.drafted", {
          agreementId: AGREEMENT_ID,
        }, 2),
        entry("s4", "booking_agreement.sent_for_review", {
          agreementId: AGREEMENT_ID,
          actorSide: "PLACE",
        }, 3),
        entry("s5", "booking_event.created", {
          eventId: EVENT_ID,
          agreementId: AGREEMENT_ID,
          startsAt: "2026-09-18T01:00:00.000Z",
        }, 4),
      ],
      nextCursor: null,
    });
    render(<BookingThread bookingRequestId={REQUEST_ID} side="VENUE" />);

    expect(screen.getByText("booking.entryRequestOpenedToVenue")).toBeTruthy();
    expect(screen.getByText("booking.entryRequestViewed")).toBeTruthy();
    expect(screen.getByText("booking.entryAgreementDrafted")).toBeTruthy();
    expect(
      screen.getByText("booking.entryAgreementSentForReview"),
    ).toBeTruthy();
    // The acting SIDE is metadata, never a person's name — the row carries an
    // id and the messages list projects no display name.
    expect(screen.getByText("booking.entryActorVenue")).toBeTruthy();
    expect(
      screen.getByText(
        'booking.entryEventCreated:{"date":"2026-09-18T01:00:00.000Z"}',
      ),
    ).toBeTruthy();
  });

  it("links the agreement, and the event only when the caller can build one", () => {
    const items = [
      entry("s1", "booking_agreement.drafted", { agreementId: AGREEMENT_ID }),
      entry("s2", "booking_event.created", {
        eventId: EVENT_ID,
        agreementId: AGREEMENT_ID,
        startsAt: "2026-09-18T01:00:00.000Z",
      }, 1),
    ];
    mocks.pages.set("__first__", { items, nextCursor: null });

    // No slug (the performer's own list) — the event entry renders NO link
    // rather than one that 404s.
    const { container, unmount } = render(
      <BookingThread bookingRequestId={REQUEST_ID} side="PERFORMER" />,
    );
    expect(
      container.querySelector(`a[href="/agreements/${AGREEMENT_ID}"]`),
    ).toBeTruthy();
    expect(container.querySelector('a[href*="/events/"]')).toBeNull();
    unmount();

    mocks.pages.set("__first__", { items, nextCursor: null });
    const withSlug = render(
      <BookingThread
        bookingRequestId={REQUEST_ID}
        side="VENUE"
        eventAdminSlug="demo"
      />,
    );
    expect(
      withSlug.container.querySelector(
        `a[href="/admin/demo/events/${EVENT_ID}"]`,
      ),
    ).toBeTruthy();
  });

  /**
   * The slug is the VENUE's shell, and the event can be the REQUESTER's
   * (RENT / USE). The entry's `systemData` carries no owner, so the inbox
   * tells the thread; the agreement link keeps the slug because the
   * agreement IS the venue's to open.
   */
  it("drops the event link, and keeps the agreement link, when event links are disabled", () => {
    mocks.pages.set("__first__", {
      items: [
        entry("s1", "booking_agreement.drafted", { agreementId: AGREEMENT_ID }),
        entry("s2", "booking_event.created", {
          eventId: EVENT_ID,
          agreementId: AGREEMENT_ID,
          startsAt: "2026-09-18T01:00:00.000Z",
        }, 1),
      ],
      nextCursor: null,
    });
    const { container } = render(
      <BookingThread
        bookingRequestId={REQUEST_ID}
        side="VENUE"
        eventAdminSlug="demo"
        eventLinksEnabled={false}
      />,
    );
    expect(screen.getByTestId("booking-thread-entry-s2")).toBeTruthy();
    expect(container.querySelector('a[href*="/events/"]')).toBeNull();
    expect(
      container.querySelector(`a[href="/admin/demo/bookings/agreement/${AGREEMENT_ID}"]`),
    ).toBeTruthy();
  });

  /**
   * `systemData` is not re-validated on read, and this is where its ids become
   * a URL PATH. A non-uuid id is dropped upstream (`readId`), so the entry
   * renders with NO link — never a hand-built `/admin/demo/events/../../…`.
   */
  it("builds no event link from an id that is not uuid-shaped", () => {
    mocks.pages.set("__first__", {
      items: [
        entry("s1", "booking_event.created", {
          eventId: "../../platform/settings",
          agreementId: "not-a-uuid",
          startsAt: "2026-09-18T01:00:00.000Z",
        }),
      ],
      nextCursor: null,
    });
    const { container } = render(
      <BookingThread
        bookingRequestId={REQUEST_ID}
        side="VENUE"
        eventAdminSlug="demo"
      />,
    );

    // The entry is still on screen — a bad id costs the link, not the line.
    expect(screen.getByTestId("booking-thread-entry-s1")).toBeTruthy();
    expect(container.querySelector("a")).toBeNull();
    expect(container.innerHTML).not.toContain("platform/settings");
  });

  /**
   * The one entry that opens every ledger must not name a party the row does
   * not. A null `systemData` used to read as "sent to the venue".
   */
  it("renders `opened` without a party when direction is unreadable", () => {
    mocks.pages.set("__first__", {
      items: [entry("s1", "booking_request.opened", null)],
      nextCursor: null,
    });
    render(<BookingThread bookingRequestId={REQUEST_ID} side="VENUE" />);

    expect(screen.getByText("booking.entryRequestOpened")).toBeTruthy();
    expect(screen.queryByText("booking.entryRequestOpenedToVenue")).toBeNull();
  });

  /**
   * FR-013: the thread's `side` is the reader, and the hold entries change
   * voice with it. One row, mounted from each side, must render two keys —
   * the act's `…Act` twin from PERFORMER, the venue's from VENUE.
   */
  it("renders hold entries in the reader's voice, keyed on `side`", () => {
    const items = [
      entry("s1", "booking_hold.challenged", {
        holdId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        respondBy: "2026-09-18T01:00:00.000Z",
      }),
    ];
    mocks.pages.set("__first__", { items, nextCursor: null });
    const act = render(
      <BookingThread bookingRequestId={REQUEST_ID} side="PERFORMER" />,
    );
    expect(act.container.textContent).toContain("booking.entryHoldChallengedAct:");
    expect(act.container.textContent).not.toContain("booking.entryHoldChallenged:");
    act.unmount();

    mocks.pages.set("__first__", { items, nextCursor: null });
    const venue = render(
      <BookingThread bookingRequestId={REQUEST_ID} side="VENUE" />,
    );
    expect(venue.container.textContent).toContain("booking.entryHoldChallenged:");
    expect(venue.container.textContent).not.toContain("booking.entryHoldChallengedAct:");
  });

  it("skips a kind it does not recognize instead of printing a raw key", () => {
    mocks.pages.set("__first__", {
      items: [
        entry("s1", "booking_hold.something_new", { holdId: "h1" }),
        message("m1", "PERFORMER", "still here", new Date(), 1),
      ],
      nextCursor: null,
    });
    render(<BookingThread bookingRequestId={REQUEST_ID} side="VENUE" />);

    expect(screen.queryByTestId("booking-thread-entry-s1")).toBeNull();
    expect(screen.queryByText(/booking_hold/)).toBeNull();
    // The rest of the thread is unaffected — no crash, no blanked list.
    expect(screen.getByText("still here")).toBeTruthy();
  });

  it("never counts an entry as unread, and never stamps one read", () => {
    mocks.markReadMutate.mockImplementation(
      (
        _input: unknown,
        opts?: { onSuccess?: () => void },
      ) => {
        opts?.onSuccess?.();
      },
    );
    mocks.pages.set("__first__", {
      items: [
        entry("s1", "booking_request.accepted", { agreementId: AGREEMENT_ID }),
        entry("s2", "booking_agreement.drafted", {
          agreementId: AGREEMENT_ID,
        }, 1),
      ],
      nextCursor: null,
    });
    render(<BookingThread bookingRequestId={REQUEST_ID} side="VENUE" />);

    // Both entries are on screen…
    expect(screen.getByTestId("booking-thread-entry-s1")).toBeTruthy();
    expect(screen.getByTestId("booking-thread-entry-s2")).toBeTruthy();
    // …and neither lights the badge or triggers a stamp the server would
    // refuse to write.
    expect(screen.queryByTestId("booking-thread-unread")).toBeNull();
    expect(mocks.markReadMutate).not.toHaveBeenCalled();
    expect(mocks.listInvalidate).not.toHaveBeenCalled();
  });

  it("still counts a human counterparty message beside entries", () => {
    mocks.markReadMutate.mockImplementation(
      (
        _input: unknown,
        opts?: { onSuccess?: () => void },
      ) => {
        opts?.onSuccess?.();
      },
    );
    mocks.pages.set("__first__", {
      items: [
        entry("s1", "booking_request.viewed", {}),
        message("m1", "PERFORMER", "can we do the 20th?", null, 1),
        entry("s2", "booking_agreement.drafted", {
          agreementId: AGREEMENT_ID,
        }, 2),
      ],
      nextCursor: null,
    });
    render(<BookingThread bookingRequestId={REQUEST_ID} side="VENUE" />);

    // One unread — the human message — not three.
    expect(mocks.markReadMutate).toHaveBeenCalledTimes(1);
    const [input] = mocks.markReadMutate.mock.calls[0]!;
    // Stamps up to the NEWEST loaded row, entry or not; the server decides
    // which rows within that window it will actually touch.
    expect((input as { upToCreatedAt: Date }).upToCreatedAt.toISOString()).toBe(
      new Date(Date.UTC(2026, 7, 18, 12, 2)).toISOString(),
    );
    // The optimistic patch cleared the human message and left the entries
    // alone, so the chip is gone.
    expect(screen.queryByTestId("booking-thread-unread")).toBeNull();
    expect(screen.getByText("can we do the 20th?")).toBeTruthy();
  });
});
