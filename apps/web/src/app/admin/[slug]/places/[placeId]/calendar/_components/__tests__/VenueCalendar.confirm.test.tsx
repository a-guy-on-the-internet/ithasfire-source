import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The venue calendar's Confirm / Not mine entry point (venue-confirmation
 * spec, docs/specs/2026-08-27). Pins that the admin read's `venueConfirmed`
 * / `venueOwned` flags decide what a chip press opens: an UNCONFIRMED chip
 * opens the decision dialog with both actions, a confirmed third-party chip
 * the withdraw-only dialog, and a venue-owned chip opens nothing. A press
 * that opens the dialog returns `false` so the engine opens no peek; a
 * venue-owned press leaves the peek to the engine. The calendar ENGINE is
 * stubbed to one button per event item (it fires the mount's `onItemPress`
 * exactly as the real engine does and records the return); the dialog is real.
 */

const { state } = vi.hoisted(() => ({
  state: {
    events: [] as Array<Record<string, unknown>>,
    /** What the mount's `onItemPress` returned, per press. */
    pressResults: [] as unknown[],
    confirmMutate: vi.fn(),
    withdrawMutate: vi.fn(),
    /** `places.getPlacePublic` — the venue's own address setting. */
    placePublic: { data: { place: { locationIsExact: true } } } as {
      data?: { place: { locationIsExact: boolean } };
      isError?: boolean;
    },
  },
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "blue-room", placeId: "place-1" }),
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@bprogress/next/app", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@tanstack/react-query", () => ({ keepPreviousData: (x: unknown) => x }));
vi.mock("@/config/trpc", () => ({ getTrpcHttpUrl: () => "http://localhost:3001/trpc" }));
vi.mock("@/hooks/useViewerTimezone", () => ({ useViewerTimezone: () => "America/Chicago" }));

vi.mock("@/hooks/useCreateDraftEvent", () => ({
  useCreateDraftEvent: () => ({
    createDraft: vi.fn(),
    createDraftAt: vi.fn(),
    modeChoiceDialog: null,
  }),
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      places: {
        getVenueCalendar: { invalidate: vi.fn(() => Promise.resolve()) },
        getCalendarEventsAdmin: { invalidate: vi.fn(() => Promise.resolve()) },
      },
    }),
    places: {
      getVenueCalendar: {
        useQuery: () => ({
          data: {
            events: state.events,
            conflicts: [],
            holds: [],
            venueTimezone: "America/Chicago",
          },
          isLoading: false,
          isPlaceholderData: false,
          error: null,
        }),
      },
      getPlaceTitle: { useQuery: () => ({ data: { name: "The Blue Room" } }) },
      getPlacePublic: { useQuery: () => state.placePublic },
      listCalendars: { useQuery: () => ({ data: [] }) },
      listCalendarAvailability: { useQuery: () => ({ data: [] }) },
    },
    venueConfirmation: {
      confirm: {
        useMutation: () => ({ mutate: state.confirmMutate, isPending: false }),
      },
      withdraw: {
        useMutation: () => ({ mutate: state.withdrawMutate, isPending: false }),
      },
    },
  },
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: (err: unknown) => String(err),
}));

// The engine is a stub: one button per event item, marked with the flags
// the mount mapped, firing `onItemPress(item)` like the real engine does.
vi.mock("@/app/admin/[slug]/_components/calendar", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    CalendarEngine: ({
      items,
      onItemPress,
    }: {
      items: Array<{
        kind: string;
        id: string;
        eventId?: string;
        title: string;
        venueConfirmed?: boolean;
        href?: { edit?: string };
      }>;
      onItemPress?: (item: unknown, meta: unknown) => unknown;
    }) => (
      <div data-testid="calendar-stub">
        {items
          .filter((i) => i.kind === "event")
          .map((e) => (
            <button
              key={e.id}
              type="button"
              data-testid={`stub-chip-${e.eventId}`}
              data-unconfirmed={e.venueConfirmed === false ? "true" : undefined}
              data-editable={e.href?.edit ? "true" : "false"}
              onClick={() =>
                state.pressResults.push(onItemPress?.(e, { view: "week", renderKey: e.id }))
              }
            >
              {e.title}
            </button>
          ))}
      </div>
    ),
  };
});

vi.mock("tamagui", () => {
  const Stack = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return { XStack: Stack, YStack: Stack, styled: () => Stack };
});

vi.mock("lucide-react", () => {
  const Icon = () => <span />;
  return { ArrowLeft: Icon, AlertTriangle: Icon, Download: Icon, Rss: Icon };
});

vi.mock("@th/ui", async () => {
  const { pickDomProps } = await import("@/test-support/pick-dom-props");
  const Modal = ({ open, children }: { open: boolean; children?: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null;
  Modal.Panel = ({ children, ...rest }: { children?: ReactNode } & Record<string, unknown>) => (
    <div {...pickDomProps(rest)}>{children}</div>
  );
  Modal.Header = ({ title }: { title: string }) => <h2>{title}</h2>;
  Modal.Body = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  Modal.Footer = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Modal,
    Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    Button: ({
      children,
      onPress,
      disabled,
      ...rest
    }: { children?: ReactNode; onPress?: () => void; disabled?: boolean } & Record<
      string,
      unknown
    >) => (
      <button type="button" onClick={onPress} disabled={disabled} {...pickDomProps(rest)}>
        {children}
      </button>
    ),
    Text: ({ children, ...rest }: { children?: ReactNode } & Record<string, unknown>) => (
      <span {...pickDomProps(rest)}>{children}</span>
    ),
    StyledSelect: () => <select />,
    CharCountTextarea: ({
      id,
      value,
      onChange,
      testIdBase,
    }: {
      id?: string;
      value: string;
      onChange: (v: string) => void;
      testIdBase?: string;
    }) => (
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testIdBase ? `${testIdBase}-textarea` : undefined}
      />
    ),
    useFormatters: () => ({ dateTime: () => "Sat, Oct 3, 8:00 PM" }),
    useNotify: () => ({ toast: { danger: vi.fn(), success: vi.fn() } }),
    useTranslations: () => (key: string) => key,
    useLocale: () => "en",
  };
});

import { VenueCalendar } from "../VenueCalendar";

const row = (over: Record<string, unknown>) => ({
  eventId: "evt",
  slug: "evt",
  title: "Event",
  startsAt: new Date("2026-10-03T20:00:00"),
  endsAt: null,
  status: "PUBLISHED",
  primaryImageUrl: null,
  priceRange: null,
  soldOut: null,
  city: null,
  region: null,
  seriesId: null,
  seriesName: null,
  calendarId: null,
  timezone: "America/Chicago",
  occurrence: null,
  venueConfirmed: true,
  venueOwned: true,
  ...over,
});

beforeEach(() => {
  state.events = [
    row({ eventId: "u1", title: "Willa & the Wolves", venueConfirmed: false, venueOwned: false }),
    row({ eventId: "c1", title: "House Night", venueConfirmed: true, venueOwned: true }),
    row({ eventId: "t1", title: "Touring Act", venueConfirmed: true, venueOwned: false }),
  ];
  state.pressResults = [];
  state.confirmMutate.mockReset();
  state.withdrawMutate.mockReset();
  state.placePublic = { data: { place: { locationIsExact: true } } };
});

describe("VenueCalendar — Confirm / Not mine", () => {
  it("hands the admin read's venueConfirmed flag to the engine and withholds Edit on third-party listings", () => {
    render(<VenueCalendar />);
    expect(screen.getByTestId("stub-chip-u1").getAttribute("data-unconfirmed")).toBe("true");
    expect(screen.getByTestId("stub-chip-u1").getAttribute("data-editable")).toBe("false");
    expect(screen.getByTestId("stub-chip-c1").hasAttribute("data-unconfirmed")).toBe(false);
    expect(screen.getByTestId("stub-chip-c1").getAttribute("data-editable")).toBe("true");
    expect(screen.getByTestId("stub-chip-t1").getAttribute("data-editable")).toBe("false");
  });

  it("pressing a confirmed third-party chip opens the withdraw-only dialog and sends the reason", () => {
    render(<VenueCalendar />);
    fireEvent.click(screen.getByTestId("stub-chip-t1"));
    expect(screen.getByRole("dialog")).toHaveTextContent("Touring Act");
    // The dialog took the press: the engine must not open its peek.
    expect(state.pressResults).toEqual([false]);
    expect(screen.queryByTestId("venue-event-confirm")).toBeNull();
    expect(screen.queryByTestId("venue-event-not-mine")).toBeNull();
    fireEvent.click(screen.getByTestId("venue-event-withdraw"));
    fireEvent.change(screen.getByTestId("venue-event-not-mine-reason-textarea"), {
      target: { value: "Double-booked the room." },
    });
    fireEvent.click(screen.getByTestId("venue-event-withdraw-submit"));
    expect(state.withdrawMutate).toHaveBeenCalledWith({
      eventId: "t1",
      reason: "Double-booked the room.",
    });
    expect(state.confirmMutate).not.toHaveBeenCalled();
  });

  it("pressing an unconfirmed chip opens the dialog with Confirm and Not mine for that event", () => {
    render(<VenueCalendar />);
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByTestId("stub-chip-u1"));
    expect(state.pressResults).toEqual([false]);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Willa & the Wolves");
    expect(screen.getByTestId("venue-event-confirm")).toBeInTheDocument();
    expect(screen.getByTestId("venue-event-not-mine")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("venue-event-confirm"));
    // …vouching for the start the calendar row carried.
    expect(state.confirmMutate).toHaveBeenCalledWith({
      eventId: "u1",
      expectedStartsAt: new Date("2026-10-03T20:00:00").toISOString(),
    });
  });

  it("pressing a venue-owned chip opens no dialog and leaves the peek to the engine", () => {
    render(<VenueCalendar />);
    fireEvent.click(screen.getByTestId("stub-chip-c1"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(state.pressResults).toEqual([undefined]);
    expect(screen.queryByTestId("venue-event-confirm")).toBeNull();
    expect(screen.queryByTestId("venue-event-not-mine")).toBeNull();
  });

  it("Not mine from the calendar sends the reason for the pressed event", () => {
    render(<VenueCalendar />);
    fireEvent.click(screen.getByTestId("stub-chip-u1"));
    fireEvent.click(screen.getByTestId("venue-event-not-mine"));
    fireEvent.change(screen.getByTestId("venue-event-not-mine-reason-textarea"), {
      target: { value: "Not on our books." },
    });
    fireEvent.click(screen.getByTestId("venue-event-not-mine-submit"));
    expect(state.withdrawMutate).toHaveBeenCalledWith({
      eventId: "u1",
      reason: "Not on our books.",
    });
  });

  describe("the address disclosure on Confirm", () => {
    const openUnconfirmed = () => {
      render(<VenueCalendar />);
      fireEvent.click(screen.getByTestId("stub-chip-u1"));
    };

    it("tells a venue that hides its address that confirming shares it", () => {
      state.placePublic = { data: { place: { locationIsExact: false } } };
      openUnconfirmed();
      expect(screen.getByTestId("venue-event-confirm-address-note")).toHaveTextContent(
        "admin.venueCalConfirmSharesAddress",
      );
    });

    it("says nothing extra at a venue that publishes its address", () => {
      openUnconfirmed();
      expect(screen.queryByTestId("venue-event-confirm-address-note")).toBeNull();
    });

    it("shows the line while the venue's setting is unknown (fail closed)", () => {
      state.placePublic = { data: undefined, isError: true };
      openUnconfirmed();
      expect(screen.getByTestId("venue-event-confirm-address-note")).toBeInTheDocument();
    });
  });
});
