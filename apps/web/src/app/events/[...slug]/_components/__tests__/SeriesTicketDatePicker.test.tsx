import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EventContentSeriesDate } from "@/components/events/event-content-types";

const push = vi.fn();
vi.mock("@bprogress/next/app", () => ({
  useRouter: () => ({ push }),
}));
vi.mock("tamagui", () => ({
  useTheme: () => ({}),
}));
vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string) => key,
  useFormatters: () => ({
    // Real Intl throws on an Invalid Date; a fixed string would not, and the
    // unreadable-date tests below would then pass with no guard in place.
    dateTime: (d: Date) => {
      if (Number.isNaN(d.getTime())) throw new RangeError("Invalid time value");
      return d.toISOString();
    },
  }),
}));

import { SeriesTicketDatePicker } from "../SeriesTicketDatePicker";

const DAY = 24 * 60 * 60 * 1000;

function seriesDate(
  slug: string,
  startsAt: string,
  isCurrent = false,
): EventContentSeriesDate {
  return {
    occurrenceId: `occ-${slug}`,
    eventId: `evt-${slug}`,
    slug,
    title: "Open mic",
    startsAt,
    endsAt: null,
    timezone: "America/Chicago",
    isCurrent,
  };
}

const past = new Date(Date.now() - 7 * DAY).toISOString();
const soon = new Date(Date.now() + 2 * DAY).toISOString();
const later = new Date(Date.now() + 9 * DAY).toISOString();

function shownSlugs() {
  return screen
    .getAllByTestId("series-date-option")
    .map((el) => el.getAttribute("data-slug"));
}

afterEach(() => {
  push.mockClear();
});

describe("SeriesTicketDatePicker — an unreadable date", () => {
  it("leaves the unreadable date out and defaults to the soonest readable one", () => {
    // The unreadable date is the one being viewed, so without the filter it
    // would be the default pick (and formatting it throws a RangeError).
    render(
      <SeriesTicketDatePicker
        open
        onOpenChange={() => {}}
        seriesDates={[
          seriesDate("past", past),
          seriesDate("broken", "not a date", true),
          seriesDate("later", later),
          seriesDate("soon", soon),
        ]}
      />,
    );

    expect(shownSlugs()).toEqual(["past", "later", "soon"]);
    const selected = screen.getByRole("radio", { checked: true });
    expect(selected.getAttribute("data-slug")).toBe("soon");

    fireEvent.click(screen.getByTestId("series-date-continue"));
    expect(push).toHaveBeenCalledWith("/events/checkout/soon");
  });

  it("does not keep a seeded slug that names an unreadable date", () => {
    render(
      <SeriesTicketDatePicker
        open
        onOpenChange={() => {}}
        initialSlug="broken"
        seriesDates={[
          seriesDate("broken", "not a date"),
          seriesDate("soon", soon),
          seriesDate("later", later),
        ]}
      />,
    );

    fireEvent.click(screen.getByTestId("series-date-continue"));
    expect(push).toHaveBeenCalledWith("/events/checkout/soon");
    expect(push).not.toHaveBeenCalledWith("/events/checkout/broken");
  });

  it("renders nothing when no date is readable, as the page does with fewer than two dates", () => {
    render(
      <SeriesTicketDatePicker
        open
        onOpenChange={() => {}}
        seriesDates={[
          seriesDate("broken-a", "not a date"),
          seriesDate("broken-b", ""),
        ]}
      />,
    );

    expect(screen.queryByTestId("series-date-picker")).not.toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("readable dates are unchanged: all shown, the current one selected", () => {
    render(
      <SeriesTicketDatePicker
        open
        onOpenChange={() => {}}
        seriesDates={[
          seriesDate("soon", soon),
          seriesDate("later", later, true),
        ]}
      />,
    );

    expect(shownSlugs()).toEqual(["soon", "later"]);
    expect(
      screen.getByRole("radio", { checked: true }).getAttribute("data-slug"),
    ).toBe("later");
  });
});
