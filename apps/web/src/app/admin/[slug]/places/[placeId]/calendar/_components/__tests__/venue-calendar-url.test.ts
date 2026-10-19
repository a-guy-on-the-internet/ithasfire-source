import { describe, expect, it } from "vitest";

import {
  buildVenueCalendarSearch,
  filtersFromUrlState,
  formatHoursSpan,
  parseVenueCalendarParams,
  urlStateWithFilters,
} from "../venue-calendar-url";

const params = (s: string) => new URLSearchParams(s);

describe("venue-calendar-url", () => {
  it("defaults: week, today, Published/Draft/Completed, holds on, all calendars", () => {
    const state = parseVenueCalendarParams(params(""));
    expect(state.view).toBe("week");
    expect(state.dateKey).toBeNull();
    expect([...state.statuses].sort()).toEqual(["COMPLETED", "DRAFT", "PUBLISHED"]);
    expect(state.seriesId).toBeNull();
    expect(state.showHolds).toBe(true);
    expect(state.calendarId).toBeNull();
    expect(buildVenueCalendarSearch(state)).toBe("");
  });

  it("round-trips every non-default value", () => {
    const state = parseVenueCalendarParams(
      params("view=month&date=2026-09-02&status=published,cancelled&series=s1&holds=0&calendar=c1"),
    );
    expect(state.view).toBe("month");
    expect(state.dateKey).toBe("2026-09-02");
    expect([...state.statuses].sort()).toEqual(["CANCELLED", "PUBLISHED"]);
    expect(state.seriesId).toBe("s1");
    expect(state.showHolds).toBe(false);
    expect(state.calendarId).toBe("c1");
    expect(buildVenueCalendarSearch(state)).toBe(
      "view=month&date=2026-09-02&status=published%2Ccancelled&series=s1&holds=0&calendar=c1",
    );
  });

  it("rejects malformed values instead of throwing", () => {
    const state = parseVenueCalendarParams(
      params("view=day&date=2026-02-30&status=bogus,,&holds=maybe"),
    );
    expect(state.view).toBe("week");
    expect(state.dateKey).toBeNull();
    expect([...state.statuses].sort()).toEqual(["COMPLETED", "DRAFT", "PUBLISHED"]);
    expect(state.showHolds).toBe(true);
    expect(parseVenueCalendarParams(null).view).toBe("week");
  });

  it("filters ↔ url state", () => {
    const state = parseVenueCalendarParams(params("holds=0&series=s9"));
    const filters = filtersFromUrlState(state);
    expect(filters.showHolds).toBe(false);
    expect(filters.seriesId).toBe("s9");
    const next = urlStateWithFilters(state, {
      statuses: new Set(["DRAFT"]),
      seriesId: "all",
      showHolds: true,
    });
    expect(buildVenueCalendarSearch(next)).toBe("status=draft");
  });

  it("formats an hours span, including one that crosses midnight", () => {
    expect(formatHoursSpan(17 * 60, 26 * 60)).toBe("5:00 PM – 2:00 AM");
    expect(formatHoursSpan(0, 12 * 60 + 30)).toBe("12:00 AM – 12:30 PM");
  });
});
