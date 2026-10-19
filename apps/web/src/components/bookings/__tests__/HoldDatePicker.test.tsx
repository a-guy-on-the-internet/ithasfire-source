import type { ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE PICKER'S OWN MECHANICS: what it sends, what it keeps, and what it tells
 * its caller.
 *
 * The model and the grid have their own suites. This one covers the file that
 * owns the three reads, `takenDates`, the month cursor, `placeMany` and the
 * failure tray — and above all the PARTIAL-SUCCESS path, which is the whole
 * reason `placeMany` reports per date instead of throwing.
 */

const mocks = vi.hoisted(() => ({
  placeMany: vi.fn(),
  calendarInvalidate: vi.fn(),
}));

let calendars: unknown[] = [];
let holds: unknown[] = [];
let events: unknown[] = [];
let availabilityDays: unknown[] = [];
/**
 * The `getAvailabilitySetupState` detector. Defaults to UNANSWERED (the
 * procedure is being built in parallel; an errored read is the shipped
 * reality today), which exercises the picker's client-side fallback.
 */
let setupState: { data: unknown; isLoading: boolean; isError: boolean } = {
  data: undefined,
  isLoading: false,
  isError: true,
};

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      places: { getCalendarEventsAdmin: { invalidate: mocks.calendarInvalidate } },
    }),
    places: {
      listCalendars: {
        useQuery: () => ({
          data: calendars,
          isLoading: false,
          isError: false,
          error: null,
        }),
      },
      getBookingAvailability: {
        useQuery: () => ({
          data: { timezone: "UTC", days: availabilityDays },
          isLoading: false,
          isError: false,
          error: null,
        }),
      },
      getCalendarEventsAdmin: {
        useQuery: () => ({
          data: { events, holds },
          isLoading: false,
          isError: false,
          error: null,
        }),
      },
      getAvailabilitySetupState: {
        useQuery: () => setupState,
      },
    },
    bookingHolds: {
      placeMany: {
        useMutation: () => ({ mutate: mocks.placeMany, isPending: false }),
      },
    },
  },
}));

vi.mock("@th/ui", () => ({
  NextLinkAnchor: ({
    children,
    href,
  }: {
    children?: ReactNode;
    href?: unknown;
  }) => <a href={String(href)}>{children}</a>,
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
  Text: ({
    children,
    role,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    role?: string;
    "data-testid"?: string;
  }) => (
    <span role={role} data-testid={testId}>
      {children}
    </span>
  ),
  useFormatters: () => ({
    locale: "en-US",
    dateTime: (value: Date | string, options?: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat("en-US", options).format(new Date(value)),
  }),
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values
      ? `${key} ${Object.entries(values)
          .map(([name, value]) => `${name}=${String(value)}`)
          .join(" ")}`
      : key,
}));

vi.mock("lucide-react", () => {
  const Icon = () => <span />;
  return {
    Bookmark: Icon,
    Check: Icon,
    ChevronLeft: Icon,
    ChevronRight: Icon,
    Lock: Icon,
    Timer: Icon,
    X: Icon,
  };
});

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: (err: unknown) => `fmt:${(err as Error)?.message ?? String(err)}`,
}));

import { HoldDatePicker } from "../HoldDatePicker";

/** A Tuesday. The whole month is open unless a test says otherwise. */
const NOW = new Date("2026-10-06T12:00:00.000Z");

const CAL = { id: "cal-1", name: "Live Music", isDefault: true, spaces: [] };

function renderPicker(over: Partial<Parameters<typeof HoldDatePicker>[0]> = {}) {
  const onPlaced = vi.fn();
  const onCancel = vi.fn();
  const onError = vi.fn();
  render(
    <HoldDatePicker
      bookingRequestId="req-1"
      placeId="place-1"
      preferredDates={["2026-10-16", "2026-10-23"]}
      onPlaced={onPlaced}
      onCancel={onCancel}
      onError={onError}
      testIdBase="pick"
      {...over}
    />,
  );
  return { onPlaced, onCancel, onError };
}

const pick = (date: string) => fireEvent.click(screen.getByTestId(`pick-day-${date}`));
const submit = () => fireEvent.click(screen.getByTestId("pick-submit"));
const lastMutation = () => mocks.placeMany.mock.calls.at(-1)!;
const resolve = (result: unknown) =>
  act(() => (lastMutation()[1] as { onSuccess: (r: unknown) => void }).onSuccess(result));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  calendars = [CAL];
  holds = [];
  events = [];
  availabilityDays = [];
  setupState = { data: undefined, isLoading: false, isError: true };
});
afterEach(() => {
  vi.useRealTimers();
});

describe("HoldDatePicker — what it sends", () => {
  it("posts the picked dates ascending, with no space", () => {
    renderPicker();
    pick("2026-10-23");
    pick("2026-10-16");
    submit();
    expect(mocks.placeMany).toHaveBeenCalledWith(
      {
        bookingRequestId: "req-1",
        calendarId: "cal-1",
        dates: ["2026-10-16", "2026-10-23"],
      },
      expect.anything(),
    );
    // The room is the calendar's, chosen at confirm — never on this form.
    expect(Object.keys(lastMutation()[0] as object)).not.toContain("spaceId");
  });

  it("cannot submit an empty tray", () => {
    renderPicker();
    expect((screen.getByTestId("pick-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("prints the calendar's rooms rather than offering them", () => {
    calendars = [
      {
        ...CAL,
        spaces: [
          { id: "s1", name: "Main Room", status: "ACTIVE" },
          { id: "s2", name: "Storage", status: "ARCHIVED" },
        ],
      },
    ];
    renderPicker();
    expect(screen.getByTestId("pick-rooms").textContent).toContain("Main Room");
    expect(screen.getByTestId("pick-rooms").textContent).not.toContain("Storage");
  });
});

describe("HoldDatePicker — partial success is the point", () => {
  const PARTIAL = {
    placed: [{ id: "h1", position: 1, date: "2026-10-16" }],
    failed: [{ date: "2026-10-23", code: "HOLD_LINE_ALREADY_CONFIRMED" }],
  };

  function placeTwoAndHalfFail() {
    const handles = renderPicker();
    pick("2026-10-16");
    pick("2026-10-23");
    submit();
    resolve(PARTIAL);
    return handles;
  }

  it("KEEPS the refused date on screen, marked, so it can be swapped not retyped", () => {
    placeTwoAndHalfFail();
    // The night that landed leaves the tray…
    expect(screen.queryByTestId("pick-chip-2026-10-16")).toBeNull();
    // …the one that did not stays, wearing the reason.
    const failed = screen.getByTestId("pick-chip-2026-10-23");
    expect(failed).toBeTruthy();
    expect(failed.textContent).toContain("bkHoldPickFailedTaken");
  });

  it("reports the count of BOTH outcomes to the caller, so the caller can decide to stay open", () => {
    const { onPlaced } = placeTwoAndHalfFail();
    expect(onPlaced).toHaveBeenCalledWith(1, 1);
  });

  it("says 'n of m' rather than only how many landed", () => {
    placeTwoAndHalfFail();
    const banner = screen.getByTestId("pick-result");
    expect(banner.textContent).toContain("bkHoldPickPlacedSome");
    expect(banner.textContent).toContain("placed=1");
    expect(banner.textContent).toContain("total=2");
  });

  it("marks a retryable refusal differently from a dead end", () => {
    renderPicker();
    pick("2026-10-16");
    submit();
    resolve({
      placed: [],
      failed: [{ date: "2026-10-16", code: "HOLD_LINE_CHANGED" }],
    });
    expect(screen.getByTestId("pick-chip-2026-10-16").textContent).toContain(
      "bkHoldPickFailedRetry",
    );
  });

  it("falls back to a generic word for a code this build has not heard of", () => {
    renderPicker();
    pick("2026-10-16");
    submit();
    resolve({ placed: [], failed: [{ date: "2026-10-16", code: "some_new_code" }] });
    expect(screen.getByTestId("pick-chip-2026-10-16").textContent).toContain(
      "bkHoldPickFailedOther",
    );
  });

  it("clears the tray and reports zero failures when everything lands", () => {
    const { onPlaced } = renderPicker();
    pick("2026-10-16");
    pick("2026-10-23");
    submit();
    resolve({
      placed: [
        { id: "h1", position: 1, date: "2026-10-16" },
        { id: "h2", position: 1, date: "2026-10-23" },
      ],
      failed: [],
    });
    expect(onPlaced).toHaveBeenCalledWith(2, 0);
    expect(screen.queryByTestId("pick-chip-2026-10-16")).toBeNull();
    expect(screen.queryByTestId("pick-chip-2026-10-23")).toBeNull();
    expect(screen.getByTestId("pick-result").textContent).toContain(
      "bkHoldPickPlacedAll",
    );
  });

  it("refreshes the overlay it draws from, so a tray still on screen re-derives its offers", () => {
    placeTwoAndHalfFail();
    expect(mocks.calendarInvalidate).toHaveBeenCalled();
  });
});

describe("HoldDatePicker — what the month is built from", () => {
  it("ends a night on a CONFIRMED hold, without counting it in the line", () => {
    holds = [
      {
        id: "hc",
        bookingRequestId: "req-rival",
        calendarId: "cal-1",
        spaceId: null,
        date: "2026-10-16",
        position: 1,
        status: "CONFIRMED",
        respondBy: null,
        lapsed: false,
        actName: "Palegrass",
        performerDisplayName: null,
      },
    ];
    renderPicker();
    const cell = screen.getByTestId("pick-day-2026-10-16");
    expect(cell.getAttribute("data-status")).toBe("taken");
    expect(cell.getAttribute("aria-disabled")).toBe("true");
    expect(cell.getAttribute("aria-label")).toContain("Palegrass");
  });

  it("ends a night on a PUBLISHED event, but never on a DRAFT one", () => {
    events = [
      {
        eventId: "e1",
        title: "Slow Pulse",
        startsAt: new Date("2026-10-17T02:00:00.000Z"),
        status: "PUBLISHED",
      },
      {
        eventId: "e2",
        title: "Someone's sketch",
        startsAt: new Date("2026-10-18T02:00:00.000Z"),
        status: "DRAFT",
      },
    ];
    renderPicker();
    expect(screen.getByTestId("pick-day-2026-10-17").getAttribute("data-status")).toBe(
      "taken",
    );
    expect(screen.getByTestId("pick-day-2026-10-18").getAttribute("data-status")).toBe(
      "open",
    );
  });

  it("marks a blacked-out day dark, and still lets an explicit click take it", () => {
    availabilityDays = [{ date: "2026-10-19", status: "blackout" }];
    renderPicker();
    const cell = screen.getByTestId("pick-day-2026-10-19");
    expect(cell.getAttribute("data-status")).toBe("dark");
    expect(cell.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(cell);
    expect(screen.getByTestId("pick-chip-2026-10-19").textContent).toContain(
      "bkHoldPickShortDark",
    );
  });
});

describe("HoldDatePicker — states", () => {
  it("says so when the venue has no calendars, instead of an empty month", () => {
    calendars = [];
    renderPicker();
    expect(screen.getByTestId("pick-no-calendars")).toBeTruthy();
    expect(screen.queryByTestId("pick-grid")).toBeNull();
  });
});

describe("HoldDatePicker — the unconfigured venue (FR-006)", () => {
  const ALL_CLOSED = Array.from({ length: 31 }, (_, i) => ({
    date: `2026-10-${String(i + 1).padStart(2, "0")}`,
    status: "closed",
  }));

  it("explains ONCE above the grid when the detector says unconfigured, and links the fix", () => {
    setupState = {
      data: { configured: false, calendarCount: 1, defaultCalendarId: "cal-1", acceptsBookingRequests: true },
      isLoading: false,
      isError: false,
    };
    renderPicker({ adminSlug: "acme" });
    const note = screen.getByTestId("pick-unconfigured");
    // VENUE-worded: only the server detector may authorise "this venue has
    // no hours" — the month alone can never prove more than its calendar.
    expect(note.getAttribute("data-scope")).toBe("venue");
    expect(note.textContent).toContain("admin.bkHoldPickUnconfigured");
    const anchor = note.querySelector("a");
    expect(anchor?.getAttribute("href")).toBe(
      "/admin/acme/places/place-1/calendars",
    );
  });

  it("keeps the grid USABLE underneath — a dark night still takes an explicit click", () => {
    setupState = {
      data: { configured: false, calendarCount: 1, defaultCalendarId: "cal-1", acceptsBookingRequests: true },
      isLoading: false,
      isError: false,
    };
    availabilityDays = ALL_CLOSED;
    renderPicker({ adminSlug: "acme" });
    pick("2026-10-16");
    expect(screen.getByTestId("pick-chip-2026-10-16")).toBeTruthy();
  });

  it("falls back to the month's own shape while the detector has not answered — CALENDAR-worded", () => {
    // Default setupState is an ERRORED read: every non-past day closed and
    // nothing blacked out is the zero-rows signature, so the note still
    // renders. A per-month approximation, and worded for the CALENDAR — the
    // one sentence that cannot overclaim, since the month can never prove
    // more than the calendar it was computed for.
    availabilityDays = ALL_CLOSED;
    renderPicker({ adminSlug: "acme" });
    const note = screen.getByTestId("pick-unconfigured");
    expect(note.getAttribute("data-scope")).toBe("calendar");
    expect(note.textContent).toContain("admin.bkHoldPickCalUnconfigured");
  });

  it("a CONFIGURED venue whose SELECTED calendar is bare still gets the note — calendar-worded", () => {
    // The live-drive regression: hours landed on the default calendar, the
    // picker switched to a second calendar with no rows of its own and no
    // place-wide rows — a fully dark month with no explanation, which is the
    // exact state FR-006 exists to kill, one calendar over.
    setupState = {
      data: { configured: true, calendarCount: 2, defaultCalendarId: "cal-1", acceptsBookingRequests: true },
      isLoading: false,
      isError: false,
    };
    availabilityDays = ALL_CLOSED;
    renderPicker({ adminSlug: "acme" });
    const note = screen.getByTestId("pick-unconfigured");
    expect(note.getAttribute("data-scope")).toBe("calendar");
    expect(note.textContent).toContain("admin.bkHoldPickCalUnconfigured");
    expect(note.querySelector("a")?.getAttribute("href")).toBe(
      "/admin/acme/places/place-1/calendars",
    );
  });

  it("a month of explicit BLACKOUTS is a stated decision, not absent hours — no note", () => {
    setupState = {
      data: { configured: true, calendarCount: 1, defaultCalendarId: "cal-1", acceptsBookingRequests: true },
      isLoading: false,
      isError: false,
    };
    availabilityDays = ALL_CLOSED.map((day) => ({ ...day, status: "blackout" }));
    renderPicker({ adminSlug: "acme" });
    expect(screen.queryByTestId("pick-unconfigured")).toBeNull();
  });

  it("renders nothing for a venue with real hours", () => {
    setupState = {
      data: { configured: true, calendarCount: 1, defaultCalendarId: null, acceptsBookingRequests: true },
      isLoading: false,
      isError: false,
    };
    renderPicker({ adminSlug: "acme" });
    expect(screen.queryByTestId("pick-unconfigured")).toBeNull();
  });

  it("degrades to the sentence alone when no admin context is supplied", () => {
    setupState = {
      data: { configured: false, calendarCount: 0, defaultCalendarId: null, acceptsBookingRequests: true },
      isLoading: false,
      isError: false,
    };
    renderPicker();
    const note = screen.getByTestId("pick-unconfigured");
    expect(note.querySelector("a")).toBeNull();
  });
});
