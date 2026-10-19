import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FinalizeDialog after "Create event from this booking" lands the draft in
 * the REQUESTER's admin (`finalizeBlocked: "requester_owned"`, RENT / USE).
 *
 * What this pins: the venue is left with NO way to finalize onto a different
 * event. `finalizeBookingAgreement` would link the agreement onto a
 * venue-owned event and clear the requester's draft anchor, orphaning the
 * draft the notice just described — so the "Or link an existing event"
 * picker and the footer Finalize leave with the create button, and the
 * notice offers the booking's conversation in the venue's inbox instead.
 *
 * Escape / focus-return live in `@th/ui`'s Modal, stubbed here like every
 * other dialog suite; verified by driving the real page.
 */

const mocks = vi.hoisted(() => ({
  createMutate: vi.fn(),
  finalizeMutate: vi.fn(),
  push: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@bprogress/next/app", () => ({
  useRouter: () => ({ push: mocks.push, replace: vi.fn() }),
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({ events: { listMine: { invalidate: vi.fn() } } }),
    // The picker's per-owner event reads: one resolved, non-empty list so
    // the picker has something to hide.
    useQueries: () => [
      {
        data: { items: [{ id: "ev-other", title: "Other night", startsAt: null }] },
        isLoading: false,
        isError: false,
        refetch: vi.fn(),
      },
    ],
    bookingAgreements: {
      finalize: {
        useMutation: () => ({ mutate: mocks.finalizeMutate, isPending: false }),
      },
      createEventFromAgreement: {
        useMutation: () => ({ mutate: mocks.createMutate, isPending: false }),
      },
    },
  },
}));

vi.mock("@/hooks/useEventOwnerEntities", () => ({
  useEventOwnerEntities: () => ({
    ownersWithSlugs: [
      { kind: "org", orgId: "org-1", orgSlug: "venue-co", role: "ADMIN", adminSlug: "venue-co" },
    ],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
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
  return { XStack: Stack, YStack: Stack };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");
  const ModalRoot = ({ open, children }: { open?: boolean; children?: ReactNode }) =>
    open ? <div data-testid="modal">{children}</div> : null;
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Modal: Object.assign(ModalRoot, {
      Panel: Pass,
      Header: ({ title }: { title?: string }) => <h2>{title}</h2>,
      Body: Pass,
    }),
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
      <button type="button" data-testid={testID} disabled={disabled} onClick={onPress}>
        {children}
      </button>
    ),
    NextLinkAnchor: React.forwardRef<
      HTMLAnchorElement,
      { href: string; children?: ReactNode }
    >(function NextLinkAnchor({ href, children }, ref) {
      return (
        <a ref={ref} href={href}>
          {children}
        </a>
      );
    }),
    Spinner: () => <span>loading…</span>,
    StyledSelect: ({ id }: { id?: string }) => <select id={id} data-testid="ba-event-picker" />,
    Text: ({ children, role }: { children?: ReactNode; role?: string }) => (
      <span role={role}>{children}</span>
    ),
    useFormatters: () => ({ dateTime: (d: Date) => new Date(d).toISOString().slice(0, 10) }),
    useNotify: () => ({ toast: { success: mocks.toastSuccess, warning: vi.fn() } }),
    useTranslations: () => (key: string) => key,
  };
});

vi.mock("lucide-react", () => ({ CalendarPlus: () => <span /> }));

import { FinalizeDialog } from "../FinalizeDialog";

const REQUEST_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const agreement = {
  status: "ACCEPTED",
  counterpartyType: "organization",
  counterpartyId: "org-1",
  counterpartyDisplayName: "Venue Co",
  proposerDisplayName: "Willa & the Wolves",
  proposedDate: new Date("2026-09-19T00:00:00.000Z"),
} as never;

const bookingRequest = { id: REQUEST_ID, preferredDates: ["2026-09-18"] } as never;

function renderDialog() {
  return render(
    <FinalizeDialog
      open
      onClose={vi.fn()}
      agreementId="ag-1"
      agreement={agreement}
      bookingRequest={bookingRequest}
      placeName="Venue Co"
      lines={[]}
      onRefresh={vi.fn()}
    />,
  );
}

function succeedWith(outcome: Record<string, unknown>) {
  mocks.createMutate.mockImplementation(
    (_input: unknown, opts: { onSuccess: (r: unknown) => void }) => opts.onSuccess(outcome),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("FinalizeDialog — requester-owned draft", () => {
  it("offers the picker and Finalize before anything is created", () => {
    renderDialog();
    expect(screen.getByText("Or link an existing event")).toBeInTheDocument();
    expect(screen.getByTestId("ba-event-picker")).toBeInTheDocument();
    expect(screen.getByTestId("ba-finalize-confirm")).toBeInTheDocument();
  });

  it("removes the picker and Finalize, and links the conversation, once the draft went to the requester", () => {
    succeedWith({
      eventId: "ev-9",
      alreadyLinked: false,
      finalized: false,
      finalizeBlocked: "requester_owned",
    });
    renderDialog();
    fireEvent.click(screen.getByTestId("ba-create-event"));

    const notice = screen.getByTestId("ba-create-event-outcome");
    expect(notice).toHaveTextContent("Event created in the requester's admin");
    // No venue-slug editor link — the venue cannot open that draft.
    expect(document.querySelector('a[href*="/events/"]')).toBeNull();
    // The conversation is the venue's next place to go.
    expect(screen.getByTestId("ba-create-event-open-thread").closest("a")).toHaveAttribute(
      "href",
      `/admin/venue-co/bookings?request=${REQUEST_ID}`,
    );
    // Nothing left that could finalize onto a DIFFERENT event.
    expect(screen.queryByText("Or link an existing event")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ba-event-picker")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ba-finalize-confirm")).not.toBeInTheDocument();
    expect(mocks.finalizeMutate).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("keeps the picker and Finalize for a venue-owned blocked mint", () => {
    succeedWith({
      eventId: "ev-9",
      alreadyLinked: false,
      finalized: false,
      finalizeBlocked: "lines_unconfirmed",
    });
    renderDialog();
    fireEvent.click(screen.getByTestId("ba-create-event"));

    expect(screen.getByTestId("ba-create-event-outcome")).toHaveTextContent(
      "finalize when payouts are confirmed",
    );
    expect(document.querySelector('a[href="/admin/venue-co/events/ev-9"]')).not.toBeNull();
    expect(screen.getByText("Or link an existing event")).toBeInTheDocument();
    expect(screen.getByTestId("ba-event-picker")).toBeInTheDocument();
    expect(screen.getByTestId("ba-finalize-confirm")).toBeInTheDocument();
  });
});
