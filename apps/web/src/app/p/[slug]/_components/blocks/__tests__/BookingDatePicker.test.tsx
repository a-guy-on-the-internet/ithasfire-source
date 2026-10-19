import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE PICKER'S TWO MODES.
 *
 * `dateTime` (PERFORM, the default) is unchanged: a night is chosen, then a
 * slot chip off that night's bill, and the entry carries the time.
 *
 * `date` (RENT / USE) drops the chips — a room hire types its own window
 * beside the picker — and stores a bare `YYYY-MM-DD`. What it KEEPS is the
 * point: the month shading, the posted hours and the night's existing
 * bookings, which is the only reason a room-hire requester wants a calendar
 * instead of a date field.
 */

let availability: { timezone: string; days: unknown[] } | undefined;
let queryState: { isPending: boolean; isError: boolean } = {
  isPending: false,
  isError: false,
};

vi.mock("@/trpc", () => ({
  trpc: {
    places: {
      getBookingAvailability: {
        useQuery: () => ({ data: availability, ...queryState }),
      },
    },
  },
}));

vi.mock("@th/ui", () => ({
  Spinner: () => null,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  useTranslations:
    () =>
    (key: string, values?: Record<string, unknown>) =>
      values
        ? `${key} ${Object.entries(values)
            .map(([name, value]) => `${name}=${String(value)}`)
            .join(" ")}`
        : key,
}));

vi.mock("lucide-react", () => ({
  ChevronLeft: () => null,
  ChevronRight: () => null,
  X: () => null,
}));

import {
  BookingDatePicker,
  bookingAvailabilityInput,
  localToday,
} from "../BookingDatePicker";

/** A fixed "today" so the grid month and the day keys below are stable. */
const TODAY = new Date("2027-05-10T12:00:00.000Z");

const day = (date: string, overrides: Record<string, unknown> = {}) => ({
  date,
  dayOfWeek: 1,
  status: "free",
  slots: [19 * 60, 20 * 60],
  free: [{ start: 18 * 60, end: 23 * 60 }],
  takenRatio: 0,
  bookings: [],
  ...overrides,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TODAY);
  queryState = { isPending: false, isError: false };
  availability = {
    timezone: "America/Chicago",
    days: [
      day("2027-05-12", {
        bookings: [
          { title: "Quiz night", start: 19 * 60, end: 21 * 60, assumedEnd: false },
        ],
      }),
      day("2027-05-13"),
    ],
  };
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * The grid's day cell, found by its ACCESSIBLE NAME ("Wed, May 12 — …") so a
 * mis-targeted click fails loudly instead of quietly hitting a neighbour.
 */
const dayCell = (dayOfMonth: number) =>
  screen.getByRole("button", { name: new RegExp(`May ${dayOfMonth} — `) });

describe("BookingDatePicker — mode=date", () => {
  it("stores a bare YYYY-MM-DD with no time component, and renders no slot chips", () => {
    const onChange = vi.fn();
    render(
      <BookingDatePicker
        placeId="place-1"
        mode="date"
        value={[]}
        onChange={onChange}
        max={1}
      />,
    );

    fireEvent.click(dayCell(12));

    expect(onChange).toHaveBeenCalledWith(["2027-05-12"]);
    expect(onChange.mock.calls[0]![0][0]).not.toContain("T");
    // No slot chips: the window is typed beside the picker.
    expect(screen.queryByText("7:00 pm")).not.toBeInTheDocument();
    expect(screen.queryByText("8:00 pm")).not.toBeInTheDocument();
  });

  it("keeps the night's posted hours and what is already booked — the reason a calendar is here at all", () => {
    render(
      <BookingDatePicker
        placeId="place-1"
        mode="date"
        value={[]}
        onChange={vi.fn()}
        max={1}
      />,
    );

    fireEvent.click(dayCell(12));

    expect(screen.getByText("6:00 pm–11:00 pm")).toBeInTheDocument();
    expect(screen.getByText("booking.pickerAlreadyBooked")).toBeInTheDocument();
    expect(screen.getByText(/Quiz night/)).toBeInTheDocument();
  });

  it("at max=1 a second day REPLACES the first instead of dead-ending on a full tray", () => {
    const onChange = vi.fn();
    render(
      <BookingDatePicker
        placeId="place-1"
        mode="date"
        value={["2027-05-12"]}
        onChange={onChange}
        max={1}
      />,
    );

    fireEvent.click(dayCell(13));
    expect(onChange).toHaveBeenCalledWith(["2027-05-13"]);
  });

  it("re-clicking the picked day does not drop it — reading the rail is not deselecting", () => {
    const onChange = vi.fn();
    render(
      <BookingDatePicker
        placeId="place-1"
        mode="date"
        value={["2027-05-12"]}
        onChange={onChange}
        max={1}
      />,
    );

    fireEvent.click(dayCell(12));
    expect(onChange).not.toHaveBeenCalled();
    // The tray still offers the way out.
    expect(
      screen.getByRole("button", { name: /admin.bkFormRemoveDate/ }),
    ).toBeInTheDocument();
  });
});

describe("bookingAvailabilityInput — ONE cache entry for both readers", () => {
  it("is identical for the picker and the form, so the page reads availability once", () => {
    // The two used to derive `from` separately — the picker local, the form
    // UTC — which agreed only before 18:00 in a negative-offset zone. At 20:00
    // Chicago they disagreed and the public place page computed 62 days of
    // availability twice, several hours a day.
    const picker = bookingAvailabilityInput({
      placeId: "place-1",
      calendarId: "cal-main",
    });
    const form = bookingAvailabilityInput({
      placeId: "place-1",
      calendarId: "cal-main",
    });
    expect(picker).toEqual(form);
    expect(picker.from).toBe(localToday());
  });

  it("reads `from` as the VIEWER's calendar day, never the UTC one", () => {
    // 2027-05-11T01:00Z is still 2027-05-10 in every negative-offset zone.
    // `toISOString().slice(0, 10)` would say the 11th there and hide tonight
    // from an evening reader — the bug this asserts against.
    //
    // Compared against `toLocaleDateString` (a different API from the one
    // under test, and no fixed zone of its own) so the assertion holds on a
    // UTC CI runner as well as on a Chicago laptop. `TZ` is unset in this
    // suite, so a hardcoded date here would pass locally and fail in CI.
    vi.setSystemTime(new Date("2027-05-11T01:00:00.000Z"));
    const [month, dayOfMonth, year] = new Date()
      .toLocaleDateString("en-US")
      .split("/");
    expect(bookingAvailabilityInput({ placeId: "p" }).from).toBe(
      `${year}-${month!.padStart(2, "0")}-${dayOfMonth!.padStart(2, "0")}`,
    );
  });

  it("OMITS calendarId rather than sending undefined — the input schema is .strict()", () => {
    expect("calendarId" in bookingAvailabilityInput({ placeId: "p" })).toBe(
      false,
    );
    expect(
      "calendarId" in bookingAvailabilityInput({ placeId: "p", calendarId: "" }),
    ).toBe(false);
  });
});

describe("BookingDatePicker — the default dateTime mode is untouched", () => {
  it("a day click only moves the cursor; the slot chip is what picks, and it carries the time", () => {
    const onChange = vi.fn();
    render(
      <BookingDatePicker
        placeId="place-1"
        value={[]}
        onChange={onChange}
        max={3}
      />,
    );

    fireEvent.click(dayCell(12));
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("7:00 pm"));
    expect(onChange).toHaveBeenCalledWith(["2027-05-12T19:00"]);
  });
});
