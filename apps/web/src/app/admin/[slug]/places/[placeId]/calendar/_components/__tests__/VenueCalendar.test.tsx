import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The place mount of the calendar engine (event-calendar-redesign, phase
 * 2b) with the REAL engine. Pins: week is the default (FR-008), the URL is
 * the state (FR-015), the heading carries the place name and count tags,
 * holds group into a per-(date, calendar) line (FR-016) and the selected
 * calendar narrows holds + hours, the hours caption names the scope and
 * zone (FR-011), and a clicked cell prefills in the VENUE zone (FR-019).
 * Phase 2: the selected calendar narrows EVENTS too (null-calendar listings
 * belong to "All" alone) and the count tags follow the painted set.
 */

const VENUE_TZ = "America/New_York";
const VIEWER_TZ = "America/Chicago";

const state = vi.hoisted(() => ({
  search: "",
  events: [] as unknown[],
  holds: [] as unknown[],
  conflicts: [] as unknown[],
  calendars: [] as unknown[],
  availability: [] as unknown[],
  availabilityError: null as unknown,
  lastInput: null as Record<string, unknown> | null,
  createDraftAt: vi.fn(),
}));

const copyTextMock = vi.hoisted(() => vi.fn((_text: string) => Promise.resolve(true)));
vi.mock("@/lib/calendar/calendar-actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/calendar/calendar-actions")>()),
  copyText: copyTextMock,
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

vi.mock("@th/ui", async () => {
  const { uiStub } = await import("@/app/admin/[slug]/_components/calendar/__tests__/ui.stub");
  return {
    ...uiStub,
    Modal: () => null,
    CharCountTextarea: () => null,
    useFormatters: () => ({ dateTime: () => "" }),
    useNotify: () => ({ toast: { success: vi.fn(), danger: vi.fn() } }),
    useTranslations: () => translate,
  };
});
// The catalog keys the mount reads, with the ICU plural resolved the way the
// real translator does; every other key echoes (the engine's miss signal).
const plural = (one: string, other: string) => (values?: Record<string, unknown>) =>
  `${values?.count} ${values?.count === 1 ? one : other}`;
const MESSAGES: Record<string, (values?: Record<string, unknown>) => string> = {
  "admin.venueCalendarHeading": () => "Place Calendar",
  "admin.venueCalendarEventCount": plural("event", "events"),
  "admin.venueCalendarConflictCount": plural("double-booking", "double-bookings"),
  "admin.ecHoldCount": plural("hold", "holds"),
  "admin.ecSubscribe": (values) => `Copy subscribe link (${values?.language})`,
  "admin.ecCopiedWebcal": () => "Copied webcal URL",
};
const translate = (key: string, values?: Record<string, unknown>) =>
  MESSAGES[key]?.(values) ?? key;
vi.mock("lucide-react", async () => {
  const { lucideStub } = await import("@/app/admin/[slug]/_components/calendar/__tests__/ui.stub");
  const Icon = () => <span data-icon="true" />;
  return { ...lucideStub, ArrowLeft: Icon, Download: Icon, Rss: Icon };
});
vi.mock("tamagui", () => {
  const Stack = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return { XStack: Stack, YStack: Stack, styled: () => Stack };
});
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => false }));
vi.mock("@/hooks/useViewerTimezone", () => ({ useViewerTimezone: () => VIEWER_TZ }));
vi.mock("@tanstack/react-query", () => ({ keepPreviousData: (x: unknown) => x }));
vi.mock("@/config/trpc", () => ({ getTrpcHttpUrl: () => "http://localhost:3001/trpc" }));
vi.mock("@/lib/format-error-message", () => ({ formatErrorMessage: String }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "blue-room", placeId: "place-1" }),
  useSearchParams: () => new URLSearchParams(state.search),
}));
vi.mock("@bprogress/next/app", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/useCreateDraftEvent", () => ({
  useCreateDraftEvent: () => ({
    createDraft: vi.fn(),
    createDraftAt: state.createDraftAt,
    modeChoiceDialog: null,
  }),
}));
vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({ places: {} }),
    places: {
      getVenueCalendar: {
        useQuery: (input: Record<string, unknown>) => {
          state.lastInput = input;
          return {
            data: {
              events: state.events,
              conflicts: state.conflicts,
              holds: state.holds,
              venueTimezone: VENUE_TZ,
            },
            isLoading: false,
            isPlaceholderData: false,
            error: null,
          };
        },
      },
      getPlaceTitle: { useQuery: () => ({ data: { name: "The Blue Room" } }) },
      getPlacePublic: {
        useQuery: () => ({ data: { place: { locationIsExact: true } } }),
      },
      listCalendars: { useQuery: () => ({ data: state.calendars }) },
      listCalendarAvailability: {
        useQuery: () => ({
          data: state.availabilityError ? undefined : state.availability,
          isError: Boolean(state.availabilityError),
          error: state.availabilityError,
        }),
      },
    },
    venueConfirmation: {
      confirm: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      withdraw: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
  },
}));

import { zonedInstant } from "@/app/admin/[slug]/_components/calendar/helpers";
import { VenueCalendar } from "../VenueCalendar";

const at = (m: number, d: number, h: number) => zonedInstant(2026, m, d, h, 0, VENUE_TZ);

const event = (over: Record<string, unknown>) => ({
  eventId: "e1",
  slug: "e1",
  title: "Event",
  startsAt: at(9, 3, 20),
  endsAt: at(9, 3, 23),
  status: "PUBLISHED",
  primaryImageUrl: null,
  priceRange: null,
  soldOut: null,
  city: null,
  region: null,
  seriesId: null,
  seriesName: null,
  calendarId: "cal-main",
  timezone: VENUE_TZ,
  occurrence: null,
  venueConfirmed: true,
  venueOwned: true,
  ...over,
});

const hold = (over: Record<string, unknown>) => ({
  id: "h1",
  bookingRequestId: "req-1",
  calendarId: "cal-main",
  spaceId: "space-1",
  date: "2026-09-04",
  position: 1,
  status: "ACTIVE",
  respondBy: null,
  lapsed: false,
  actName: "Willa & the Wolves",
  performerDisplayName: null,
  ...over,
});

const calendar = (over: Record<string, unknown>) => ({
  id: "cal-main",
  placeId: "place-1",
  name: "Main Room",
  slug: "main-room",
  description: null,
  isDefault: true,
  defaultStartTime: "20:30",
  defaultCategoryId: null,
  eventTemplate: null,
  acceptsPerform: true,
  acceptsRent: true,
  acceptsUse: true,
  rentalRateCents: null,
  rentalRateCurrency: null,
  rentalRateVisible: false,
  rentalMode: "REQUEST",
  createdAt: new Date(0),
  updatedAt: new Date(0),
  spaces: [
    {
      id: "space-1",
      placeId: "place-1",
      name: "Main Stage",
      capacity: 200,
      sortOrder: 0,
      status: "ACTIVE",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
  ],
  ...over,
});

/**
 * Next keeps `useSearchParams` in step with `history.replaceState`, so the
 * mock has to as well: with a FROZEN `state.search` every write started from
 * an empty query and the suite could never have caught one writer clobbering
 * another's params.
 */
const spyReplaceState = () =>
  vi.spyOn(window.history, "replaceState").mockImplementation(((
    _data: unknown,
    _title: string,
    url?: string | URL | null,
  ) => {
    const href = String(url ?? "");
    state.search = (href.split("?")[1] ?? "").split("#")[0] ?? "";
  }) as typeof window.history.replaceState);
let replaceState: ReturnType<typeof spyReplaceState>;

beforeEach(() => {
  vi.useFakeTimers({ now: at(9, 2, 12), toFake: ["Date"] });
  state.search = "";
  state.events = [
    event({ eventId: "e1", title: "House Night" }),
    event({ eventId: "e2", title: "Late Show", startsAt: at(9, 3, 21), endsAt: at(9, 3, 23) }),
  ];
  state.conflicts = [{ eventAId: "e1", eventBId: "e2", overlapMinutes: 120 }];
  state.holds = [
    hold({ id: "h1", position: 1 }),
    hold({ id: "h2", position: 2, actName: "The Second Act", status: "CHALLENGED", respondBy: at(9, 3, 17) }),
    hold({ id: "h3", calendarId: "cal-loft", spaceId: null, actName: "Loft Act" }),
    hold({ id: "h4", lapsed: true, actName: "Lapsed Act", position: 3 }),
  ];
  state.calendars = [
    calendar({}),
    calendar({ id: "cal-loft", name: "The Loft", slug: "loft", isDefault: false, spaces: [] }),
  ];
  state.availability = [
    // Place-wide Thursday 5 PM – 2 AM; the Loft opens Thursday at noon.
    { id: "a1", placeId: "place-1", calendarId: null, dayOfWeek: 4, date: null, startTime: "17:00", endTime: "02:00", isOpen: true, note: null, createdAt: new Date(0), updatedAt: new Date(0) },
    { id: "a2", placeId: "place-1", calendarId: "cal-loft", dayOfWeek: 4, date: null, startTime: "12:00", endTime: "18:00", isOpen: true, note: null, createdAt: new Date(0), updatedAt: new Date(0) },
  ];
  state.lastInput = null;
  state.availabilityError = null;
  state.createDraftAt.mockReset();
  replaceState = spyReplaceState();
});

describe("VenueCalendar", () => {
  it("opens in week, paints in the venue zone, names the place and rolls up the counts", () => {
    render(<VenueCalendar />);
    expect(screen.getByTestId("event-calendar").getAttribute("data-view")).toBe("week");
    expect(screen.getByTestId("venue-calendar-place").textContent).toBe("The Blue Room");
    expect(screen.getByTestId("venue-calendar-event-count").textContent).toBe("2 events");
    expect(screen.getByTestId("venue-calendar-conflict-badge").textContent).toContain("1 double-booking");
    expect(screen.getByRole("menuitem", { name: "Copy subscribe link (English)" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Copy subscribe link (Español)" })).toBeTruthy();
    // h4 is lapsed → 3 live holds.
    expect(screen.getByTestId("venue-calendar-hold-count").textContent).toBe("3 holds");
    // The fetch window is the painted week, Sunday to Sunday in the venue zone.
    expect(state.lastInput).toMatchObject({ placeId: "place-1", from: at(8, 30, 0), to: at(9, 6, 0) });
    // Hours caption: scope, union window, zone — the timezone slot is off.
    expect(screen.queryByTestId("calendar-timezone")).toBeNull();
    expect(screen.getByTestId("calendar-hours-caption").textContent).toBe(
      "Hours · All calendars · 12:00 PM – 2:00 AM · America/New_York",
    );
  });

  it("each subscribe item copies its own language's feed URL (English plain, Español ?lang=es)", () => {
    copyTextMock.mockClear();
    render(<VenueCalendar />);
    act(() => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Copy subscribe link (English)" }));
    });
    act(() => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Copy subscribe link (Español)" }));
    });
    expect(copyTextMock.mock.calls.map((c) => c[0])).toEqual([
      "webcal://localhost:3001/api/venues/place-1/calendar.ics",
      "webcal://localhost:3001/api/venues/place-1/calendar.ics?lang=es",
    ]);
  });

  it("URL is the state: view / date / status / holds / calendar writes go through replaceState", () => {
    render(<VenueCalendar />);
    fireEvent.click(screen.getByTestId("calendar-view-month"));
    expect(replaceState).toHaveBeenLastCalledWith(null, "", "/?view=month");

    fireEvent.click(screen.getByTestId("calendar-nav-next"));
    expect(replaceState).toHaveBeenLastCalledWith(null, "", "/?date=2026-09-09");

    fireEvent.click(screen.getByTestId("calendar-filter-status-draft"));
    expect(replaceState).toHaveBeenLastCalledWith(null, "", "/?status=published%2Ccompleted");

    fireEvent.click(screen.getByTestId("calendar-filter-holds"));
    expect(replaceState).toHaveBeenLastCalledWith(null, "", "/?holds=0");

    fireEvent.change(screen.getByTestId("venue-calendar-picker"), { target: { value: "cal-loft" } });
    expect(replaceState).toHaveBeenLastCalledWith(null, "", "/?calendar=cal-loft");
  });

  it("reads the URL back: month view anchored on the date, holds off", () => {
    state.search = "view=month&date=2026-10-15&holds=0";
    render(<VenueCalendar />);
    expect(screen.getByTestId("event-calendar").getAttribute("data-view")).toBe("month");
    expect(screen.getByTestId("calendar-nav-label").textContent).toBe("October 2026");
    expect(screen.queryByTestId("calendar-hold-chip-h1")).toBeNull();
  });

  it("a selected calendar narrows holds and the hours window; an unknown id reads as All", () => {
    state.search = "calendar=cal-loft";
    render(<VenueCalendar />);
    expect(screen.queryByTestId("calendar-hold-chip-h1")).toBeNull();
    expect(screen.getByTestId("calendar-hold-chip-h3")).toBeTruthy();
    expect(screen.getByTestId("calendar-hours-caption").textContent).toBe(
      "Hours · The Loft · 12:00 PM – 2:00 AM · America/New_York",
    );

    state.search = "calendar=nope";
    render(<VenueCalendar />);
    expect(screen.getAllByTestId("venue-calendar-hold-count").at(-1)!.textContent).toBe("3 holds");
  });

  it("a selected calendar hides other calendars' events and null-calendar events; the count tags follow", () => {
    state.events = [
      event({ eventId: "e1", title: "House Night" }),
      event({ eventId: "e2", title: "Loft Session", calendarId: "cal-loft", startsAt: at(9, 3, 21), endsAt: at(9, 3, 23) }),
      event({ eventId: "e3", title: "Unfiled", calendarId: null, startsAt: at(9, 4, 20), endsAt: at(9, 4, 22) }),
    ];
    state.conflicts = [{ eventAId: "e1", eventBId: "e2", overlapMinutes: 120 }];

    const all = render(<VenueCalendar />);
    // e1 and e2 are double-booked on Sep 3, and a 120px day column cannot
    // paint two readable blocks: the first takes the column and the second
    // collapses into the group's "+1" slot (both are in that day's list).
    expect(screen.getByTestId("calendar-event-chip-e1:0")).toBeTruthy();
    expect(screen.getByTestId("calendar-event-chip-e3:0")).toBeTruthy();
    expect(screen.getByTestId("calendar-week-more-2026-09-03-0").textContent).toBe("+1 more");
    expect(screen.getByTestId("venue-calendar-event-count").textContent).toBe("3 events");
    all.unmount();

    state.search = "calendar=cal-loft";
    render(<VenueCalendar />);
    // Alone in its column now, so it paints in full.
    expect(screen.getByTestId("calendar-event-chip-e2:0")).toBeTruthy();
    expect(screen.queryByTestId("calendar-week-more-2026-09-03-0")).toBeNull();
    expect(screen.queryByTestId("calendar-event-chip-e1:0")).toBeNull();
    expect(screen.queryByTestId("calendar-event-chip-e3:0")).toBeNull();
    expect(screen.getByTestId("venue-calendar-event-count").textContent).toBe("1 event");
    // e2 is painted and double-booked with e1 → the tag still warns.
    expect(screen.getByTestId("venue-calendar-conflict-badge").textContent).toContain("1 double-booking");
    // Holds narrow with it (h3 is the Loft's only live hold).
    expect(screen.getByTestId("venue-calendar-hold-count").textContent).toBe("1 hold");
  });

  it("holds group into a line per (date, calendar) with the space name; the peek shows the whole line and the booking link", () => {
    render(<VenueCalendar />);
    fireEvent.click(screen.getByTestId("calendar-hold-chip-h2"));
    const line = screen.getByTestId("calendar-peek-hold-line");
    expect(line.textContent).toContain("Willa & the Wolves");
    expect(line.textContent).toContain("The Second Act");
    expect(line.textContent).not.toContain("Loft Act");
    expect(line.textContent).not.toContain("Lapsed Act");
    expect(screen.getByTestId("calendar-peek-kicker").textContent).toContain("Main Stage");
    expect(screen.getByTestId("calendar-peek-booking").getAttribute("href")).toBe(
      "/admin/blue-room/bookings?request=req-1",
    );
  });

  it("flags double-booked events and the peek shows the venue", () => {
    render(<VenueCalendar />);
    const chip = screen.getByTestId("calendar-event-chip-e1:0");
    expect(chip.getAttribute("data-conflict")).toBe("true");
    fireEvent.click(chip);
    expect(screen.getByRole("dialog").textContent).toContain("The Blue Room");
    expect(screen.getByTestId("calendar-peek-edit").getAttribute("href")).toBe(
      "/admin/blue-room/events/e1/edit",
    );
  });

  it("a second URL write keeps the first one's params (no clobber)", () => {
    const { rerender } = render(<VenueCalendar />);
    fireEvent.click(screen.getByTestId("calendar-view-month"));
    expect(replaceState).toHaveBeenLastCalledWith(null, "", "/?view=month");
    // Next feeds the new query back through `useSearchParams`; so does the mock.
    rerender(<VenueCalendar />);
    fireEvent.click(screen.getByTestId("calendar-filter-status-draft"));
    expect(replaceState).toHaveBeenLastCalledWith(
      null,
      "",
      "/?view=month&status=published%2Ccompleted",
    );
    rerender(<VenueCalendar />);
    fireEvent.change(screen.getByTestId("venue-calendar-picker"), { target: { value: "cal-loft" } });
    expect(replaceState).toHaveBeenLastCalledWith(
      null,
      "",
      "/?view=month&status=published%2Ccompleted&calendar=cal-loft",
    );
  });

  it("agenda Show more never asks the read for more than its 90-day window", () => {
    state.search = "view=agenda";
    render(<VenueCalendar />);
    const span = () => {
      const input = state.lastInput as { from: Date; to: Date };
      return input.to.getTime() - input.from.getTime();
    };
    // The trap: a 90-DAY page spans 91 days (midnight D → end of day D+90),
    // and `getVenueCalendar` rejects that with `time_window_too_large`, which
    // replaced the whole page with the generic error screen.
    expect(span()).toBeLessThanOrEqual(90 * 86_400_000);
    for (let click = 0; click < 4; click += 1) {
      const more = screen.queryByTestId("calendar-agenda-show-more");
      if (!more) break;
      fireEvent.click(more);
      expect(span()).toBeLessThanOrEqual(90 * 86_400_000);
      // The error screen must never appear.
      expect(screen.queryByText("admin.venueCalendarGenericError")).toBeNull();
      expect(screen.getByTestId("event-calendar")).toBeTruthy();
    }
    // It really did paginate — the window grew past the first page.
    expect(span()).toBeGreaterThan(31 * 86_400_000);
  });

  it("a FAILED availability read says so, instead of claiming the venue set no hours", () => {
    state.availabilityError = new Error("boom");
    render(<VenueCalendar />);
    const caption = screen.getByTestId("calendar-hours-caption").textContent;
    expect(caption).toContain("Hours unavailable");
    expect(caption).not.toContain("No hours set");
    // The week still paints — the engine falls back to auto-fit hours.
    expect(screen.getByTestId("calendar-week-grid")).toBeTruthy();
  });

  it("create-on-click prefills the VENUE wall clock with the selected calendar and its sole space", () => {
    state.search = "view=month&calendar=cal-main";
    render(<VenueCalendar />);
    fireEvent.click(screen.getByTestId("calendar-day-create-2026-09-10"));
    expect(state.createDraftAt).toHaveBeenCalledWith({
      startsAt: "2026-09-10T20:30",
      placeId: "place-1",
      calendarId: "cal-main",
      spaceId: "space-1",
    });
  });
});
