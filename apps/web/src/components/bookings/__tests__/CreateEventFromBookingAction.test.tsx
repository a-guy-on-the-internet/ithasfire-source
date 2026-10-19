import { forwardRef, type ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The in-thread "Create event from this booking" action, on its own. The
 * inbox suite pins its PLACEMENT (inside the thread, above the composer); this
 * one pins its gating and its outcomes, including the blocked variants the
 * inbox suite does not walk.
 */

const mocks = vi.hoisted(() => ({
  getUseQuery: vi.fn(),
  createMutate: vi.fn(),
  listInvalidate: vi.fn(),
  agreementInvalidate: vi.fn(),
  messagesInvalidate: vi.fn(),
  ownersEnabled: undefined as boolean | undefined,
}));

let owners: unknown[] | undefined = undefined;

vi.mock("@/hooks/useEventOwnerEntities", () => ({
  useEventOwnerEntities: (opts?: { enabled?: boolean }) => {
    mocks.ownersEnabled = opts?.enabled;
    return { ownersWithSlugs: owners, isLoading: false, isError: false, refetch: vi.fn() };
  },
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      bookingRequests: {
        list: { invalidate: mocks.listInvalidate },
        messages: { list: { invalidate: mocks.messagesInvalidate } },
      },
      bookingAgreements: { get: { invalidate: mocks.agreementInvalidate } },
    }),
    bookingAgreements: {
      get: { useQuery: mocks.getUseQuery },
      createEventFromAgreement: {
        useMutation: () => ({ mutate: mocks.createMutate, isPending: false }),
      },
    },
  },
}));

vi.mock("tamagui", () => {
  const Stack = (props: Record<string, unknown>) => (
    <div
      data-testid={(props.testID ?? props["data-testid"]) as string | undefined}
      role={props.role as string | undefined}
    >
      {props.children as ReactNode}
    </div>
  );
  return { XStack: Stack, YStack: Stack, styled: () => Stack };
});

vi.mock("@th/ui", () => ({
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
  NextLinkAnchor: forwardRef<
    HTMLAnchorElement,
    { href: string; children?: ReactNode; "aria-label"?: string }
  >(function NextLinkAnchor({ href, children, "aria-label": ariaLabel }, ref) {
    return (
      <a ref={ref} href={href} aria-label={ariaLabel}>
        {children}
      </a>
    );
  }),
  Spinner: () => <span>loading…</span>,
  Text: ({ children, role }: { children?: ReactNode; role?: string }) => (
    <span role={role}>{children}</span>
  ),
  useFormatters: () => ({ dateTime: (d: Date) => new Date(d).toISOString().slice(0, 10) }),
  useTranslations: () => (key: string) => key,
}));

vi.mock("lucide-react", () => ({
  CalendarPlus: () => <span />,
  ExternalLink: () => <span />,
}));

import { CreateEventFromBookingAction } from "../CreateEventFromBookingAction";

const VENUE_OWNERS = [
  { kind: "org", orgId: "org-1", orgSlug: "acme", role: "EDITOR", adminSlug: "acme" },
];

function agreement(overrides: Record<string, unknown> = {}, bookingMinted = true) {
  return {
    agreement: {
      status: "ACCEPTED",
      counterpartyType: "organization",
      counterpartyId: "org-1",
      counterpartyDisplayName: "The Spot",
      proposerDisplayName: "Willa & the Wolves",
      proposedDate: new Date("2026-09-19T00:00:00.000Z"),
      ...overrides,
    },
    bookingRequest: bookingMinted ? { preferredDates: ["2026-09-18"] } : null,
    pitchProvenance: null,
    mayEdit: false,
  };
}

function resolved(data: unknown) {
  mocks.getUseQuery.mockReturnValue({ data, error: null, isFetching: false, refetch: vi.fn() });
}

function renderAction(props: Partial<Parameters<typeof CreateEventFromBookingAction>[0]> = {}) {
  return render(
    <CreateEventFromBookingAction
      agreementId="ag-1"
      bookingRequestId="req-1"
      eventId={null}
      eventHref={null}
      venueName="The Spot"
      testIdBase="thread"
      {...props}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  owners = VENUE_OWNERS;
  resolved(undefined);
});

describe("CreateEventFromBookingAction — gating", () => {
  it("renders nothing while the agreement read is in flight", () => {
    const { container } = renderAction();
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for a non-ACCEPTED agreement, and does not read owners", () => {
    resolved(agreement({ status: "PROPOSED" }));
    const { container } = renderAction();
    expect(container).toBeEmptyDOMElement();
    expect(mocks.ownersEnabled).toBe(false);
  });

  it("renders nothing for an agreement that did not come from a booking", () => {
    resolved(agreement({}, false));
    const { container } = renderAction();
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for a viewer off the venue side (FINANCE included)", () => {
    resolved(agreement());
    owners = [{ kind: "org", orgId: "org-1", orgSlug: "acme", role: "FINANCE", adminSlug: "acme" }];
    const { container } = renderAction();
    expect(container).toBeEmptyDOMElement();
  });

  it("defaults OPEN while owners have not resolved — the server enforces", () => {
    resolved(agreement());
    owners = undefined;
    renderAction();
    expect(screen.getByTestId("thread-create-event-cta")).toBeInTheDocument();
  });

  it("offers the action with the explainer naming venue, date and act", () => {
    resolved(agreement());
    renderAction();
    expect(screen.getByTestId("thread-create-event")).toHaveTextContent(
      "Creates a draft show at The Spot on 2026-09-19 with Willa & the Wolves on the bill.",
    );
  });

  it("says where a requester-owned event lives instead of linking it", () => {
    // `eventHref` is the caller's; the inbox already nulls it for a
    // requester-owned row, but the slot must not depend on that alone.
    renderAction({
      eventId: "ev-9",
      eventHref: "/admin/acme/events/ev-9",
      requesterOwned: true,
    });
    const slot = screen.getByTestId("thread-requester-owned-event");
    expect(slot).toHaveTextContent("admin.bkInboxEventRequesterOwnedNote");
    expect(screen.queryByTestId("thread-open-event")).not.toBeInTheDocument();
    expect(document.querySelector('a[href="/admin/acme/events/ev-9"]')).toBeNull();
    expect(mocks.getUseQuery.mock.calls[0]![1]).toMatchObject({ enabled: false });
  });

  it("skips the agreement read entirely when an event already exists", () => {
    renderAction({ eventId: "ev-1", eventHref: "/admin/acme/events/ev-1" });
    expect(mocks.getUseQuery.mock.calls[0]![1]).toMatchObject({ enabled: false });
    expect(screen.getByRole("link", { name: "admin.bkInboxOpenEventCta" })).toHaveAttribute(
      "href",
      "/admin/acme/events/ev-1",
    );
    expect(screen.queryByTestId("thread-create-event")).not.toBeInTheDocument();
  });
});

describe("CreateEventFromBookingAction — outcomes stay in the conversation", () => {
  function succeedWith(outcome: Record<string, unknown>) {
    mocks.createMutate.mockImplementation(
      (_input: unknown, opts: { onSuccess: (r: unknown) => void }) => opts.onSuccess(outcome),
    );
  }

  it("finalized: shows the notice with an Open-event link into the venue's editor", () => {
    resolved(agreement());
    succeedWith({ eventId: "ev-9", alreadyLinked: false, finalized: true });
    const onEventCreated = vi.fn();
    renderAction({ onEventCreated });
    fireEvent.click(screen.getByTestId("thread-create-event-cta"));

    expect(mocks.createMutate.mock.calls[0]![0]).toEqual({ agreementId: "ag-1" });
    const notice = screen.getByTestId("ba-create-event-outcome");
    expect(notice).toHaveTextContent("Event created and agreement finalized");
    expect(notice.querySelector("a")).toHaveAttribute("href", "/admin/acme/events/ev-9");
    // The caller gets the outcome AND the resolved href, so it can hold both
    // across a row remount.
    expect(onEventCreated).toHaveBeenCalledWith({
      result: expect.objectContaining({ eventId: "ev-9", finalized: true }),
      eventHref: "/admin/acme/events/ev-9",
    });
    expect(mocks.listInvalidate).toHaveBeenCalledTimes(1);
    expect(mocks.agreementInvalidate).toHaveBeenCalledWith({ agreementId: "ag-1" });
    // The LEDGER too: the server writes `booking_event.created` in the same
    // transaction, and the thread one line above this notice must show it
    // without a reload (measured: it stayed at "Agreement accepted").
    expect(mocks.messagesInvalidate).toHaveBeenCalledWith({ bookingRequestId: "req-1" });
  });

  it("keeps the outcome on screen after the row gains its eventId", () => {
    // The list invalidation that follows a create hands the row an `eventId`
    // a moment later; the slot must not flip to "Open event" and lose the
    // sentence that says what happened.
    resolved(agreement());
    succeedWith({
      eventId: "ev-9",
      alreadyLinked: false,
      finalized: false,
      finalizeBlocked: "lines_unconfirmed",
    });
    const { rerender } = renderAction();
    fireEvent.click(screen.getByTestId("thread-create-event-cta"));
    rerender(
      <CreateEventFromBookingAction
        agreementId="ag-1"
        bookingRequestId="req-1"
        eventId="ev-9"
        eventHref="/admin/acme/events/ev-9"
        venueName="The Spot"
        testIdBase="thread"
      />,
    );
    const notice = screen.getByTestId("ba-create-event-outcome");
    expect(notice).toHaveTextContent("finalize when payouts are confirmed");
    expect(notice.querySelector("a")).toHaveAttribute("href", "/admin/acme/events/ev-9");
    expect(screen.queryByTestId("thread-open-event")).not.toBeInTheDocument();
  });

  it("already linked: says so and links the existing event", () => {
    resolved(agreement());
    succeedWith({ eventId: "ev-old", alreadyLinked: true, finalized: true });
    renderAction();
    fireEvent.click(screen.getByTestId("thread-create-event-cta"));
    expect(screen.getByTestId("ba-create-event-outcome")).toHaveTextContent(
      "This agreement is already linked to its event.",
    );
  });

  it("blocked (payee_not_ready): the draft exists, and the notice says what unblocks it", () => {
    resolved(agreement());
    succeedWith({
      eventId: "ev-9",
      alreadyLinked: false,
      finalized: false,
      finalizeBlocked: "payee_not_ready",
    });
    renderAction();
    fireEvent.click(screen.getByTestId("thread-create-event-cta"));
    expect(screen.getByTestId("ba-create-event-outcome")).toHaveTextContent(
      "finalize when payees are ready",
    );
  });

  it("maps a typed failure to its calm message, inline", () => {
    resolved(agreement());
    mocks.createMutate.mockImplementation(
      (_input: unknown, opts: { onError: (e: unknown) => void }) =>
        opts.onError({ data: { code: "CONFLICT", appCode: "AGREEMENT_NOT_ACCEPTED" } }),
    );
    renderAction();
    fireEvent.click(screen.getByTestId("thread-create-event-cta"));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This agreement isn't accepted anymore",
    );
    // The action is still there to retry after a refresh.
    expect(screen.getByTestId("thread-create-event-cta")).toBeInTheDocument();
  });

  it("routes a human venue counterparty to their own admin slug", () => {
    resolved(agreement({ counterpartyType: "human", counterpartyId: "hum-1" }));
    owners = [{ kind: "human", humanId: "hum-1", adminSlug: "@stagename" }];
    succeedWith({ eventId: "ev-9", alreadyLinked: false, finalized: true });
    renderAction();
    fireEvent.click(screen.getByTestId("thread-create-event-cta"));
    expect(screen.getByTestId("ba-create-event-outcome").querySelector("a")).toHaveAttribute(
      "href",
      "/admin/@stagename/events/ev-9",
    );
  });
});
