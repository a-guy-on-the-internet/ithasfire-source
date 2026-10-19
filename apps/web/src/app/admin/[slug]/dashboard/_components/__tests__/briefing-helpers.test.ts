import { describe, it, expect } from "vitest";

import type { CalendarEvent } from "@/app/admin/[slug]/_components/event-calendar-types";
import {
  isSameCalendarDay,
  selectNextEvent,
  isHappeningToday,
  selectWeekAgenda,
  countUpcomingPublished,
} from "../briefing-helpers";

// Fixed reference: Tue 2026-08-04 18:00 local.
const NOW = new Date(2026, 7, 4, 18, 0, 0);

let seq = 0;
function ev(overrides: Partial<CalendarEvent>): CalendarEvent {
  seq += 1;
  return {
    id: `ev-${seq}`,
    title: `Event ${seq}`,
    status: "PUBLISHED",
    startsAt: null,
    endsAt: null,
    ...overrides,
  };
}

describe("isSameCalendarDay", () => {
  it("matches two instants on the same local day", () => {
    expect(
      isSameCalendarDay(new Date(2026, 7, 4, 0, 1), new Date(2026, 7, 4, 23, 59)),
    ).toBe(true);
  });

  it("rejects adjacent days even one minute apart", () => {
    expect(
      isSameCalendarDay(new Date(2026, 7, 4, 23, 59), new Date(2026, 7, 5, 0, 0)),
    ).toBe(false);
  });
});

describe("selectNextEvent", () => {
  it("returns null for an empty list", () => {
    expect(selectNextEvent([], NOW)).toBeNull();
  });

  it("picks the earliest-starting published event that has not ended", () => {
    const later = ev({ startsAt: new Date(2026, 7, 10, 20, 0) });
    const sooner = ev({ startsAt: new Date(2026, 7, 5, 20, 0) });
    expect(selectNextEvent([later, sooner], NOW)?.id).toBe(sooner.id);
  });

  it("skips drafts and cancelled events", () => {
    const draft = ev({ status: "DRAFT", startsAt: new Date(2026, 7, 5, 20, 0) });
    const cancelled = ev({
      status: "CANCELLED",
      startsAt: new Date(2026, 7, 6, 20, 0),
    });
    const published = ev({ startsAt: new Date(2026, 7, 8, 20, 0) });
    expect(selectNextEvent([draft, cancelled, published], NOW)?.id).toBe(
      published.id,
    );
  });

  it("skips events that already ended", () => {
    const ended = ev({
      startsAt: new Date(2026, 7, 4, 12, 0),
      endsAt: new Date(2026, 7, 4, 14, 0),
    });
    expect(selectNextEvent([ended], NOW)).toBeNull();
  });

  it("keeps an in-progress event (started, ends later)", () => {
    const ongoing = ev({
      startsAt: new Date(2026, 7, 4, 17, 0),
      endsAt: new Date(2026, 7, 4, 23, 0),
    });
    expect(selectNextEvent([ongoing], NOW)?.id).toBe(ongoing.id);
  });

  it("skips events with no startsAt", () => {
    expect(selectNextEvent([ev({ startsAt: null })], NOW)).toBeNull();
  });

  // Regression: without the grace window, a null-endsAt event vanished at
  // exactly startsAt — the moment the organiser opens the dashboard to scan.
  it("keeps a null-endsAt event within the 6h grace window after doors", () => {
    const doorsJustOpened = ev({
      startsAt: new Date(2026, 7, 4, 17, 0), // 1h before NOW (18:00)
      endsAt: null,
    });
    expect(selectNextEvent([doorsJustOpened], NOW)?.id).toBe(
      doorsJustOpened.id,
    );
  });

  it("drops a null-endsAt event once the grace window lapses", () => {
    const longOver = ev({
      startsAt: new Date(2026, 7, 4, 11, 0), // 7h before NOW
      endsAt: null,
    });
    expect(selectNextEvent([longOver], NOW)).toBeNull();
  });
});

describe("isHappeningToday (Tonight boundary)", () => {
  it("is true for an event later today", () => {
    expect(
      isHappeningToday(ev({ startsAt: new Date(2026, 7, 4, 23, 30) }), NOW),
    ).toBe(true);
  });

  it("is false for an event tomorrow", () => {
    expect(
      isHappeningToday(ev({ startsAt: new Date(2026, 7, 5, 0, 30) }), NOW),
    ).toBe(false);
  });

  it("is true for a multi-day event that started yesterday and is still running", () => {
    expect(
      isHappeningToday(
        ev({
          startsAt: new Date(2026, 7, 3, 20, 0),
          endsAt: new Date(2026, 7, 5, 2, 0),
        }),
        NOW,
      ),
    ).toBe(true);
  });
});

describe("selectWeekAgenda", () => {
  it("returns an empty list when nothing is upcoming", () => {
    const past = ev({ startsAt: new Date(2026, 7, 1, 20, 0) });
    expect(selectWeekAgenda([past], NOW)).toEqual([]);
  });

  it("includes events inside the 7-day window and excludes those outside it", () => {
    const inWindow = ev({ startsAt: new Date(2026, 7, 10, 20, 0) }); // day 6
    const outOfWindow = ev({ startsAt: new Date(2026, 7, 12, 20, 0) }); // day 8
    const beforeNow = ev({ startsAt: new Date(2026, 7, 4, 12, 0) }); // earlier today
    const ids = selectWeekAgenda([inWindow, outOfWindow, beforeNow], NOW).map(
      (e) => e.id,
    );
    expect(ids).toEqual([inWindow.id]);
  });

  it("treats the exact 7-day boundary as exclusive", () => {
    const boundary = ev({ startsAt: new Date(2026, 7, 11, 18, 0) }); // now + 7d exactly
    expect(selectWeekAgenda([boundary], NOW)).toEqual([]);
  });

  it("sorts ascending and caps at max", () => {
    const events = [22, 20, 21, 19, 23].map((h) =>
      ev({ startsAt: new Date(2026, 7, 5, h, 0) }),
    );
    const agenda = selectWeekAgenda(events, NOW, 4);
    expect(agenda).toHaveLength(4);
    expect(agenda.map((e) => e.startsAt!.getHours())).toEqual([19, 20, 21, 22]);
  });

  it("keeps drafts (the status badge carries that signal)", () => {
    const draft = ev({
      status: "DRAFT",
      startsAt: new Date(2026, 7, 6, 20, 0),
    });
    expect(selectWeekAgenda([draft], NOW).map((e) => e.id)).toEqual([draft.id]);
  });
});

describe("countUpcomingPublished", () => {
  it("counts published not-yet-ended events only", () => {
    const upcoming = ev({ startsAt: new Date(2026, 7, 6, 20, 0) });
    const ongoing = ev({
      startsAt: new Date(2026, 7, 4, 17, 0),
      endsAt: new Date(2026, 7, 4, 23, 0),
    });
    const ended = ev({
      startsAt: new Date(2026, 7, 1, 20, 0),
      endsAt: new Date(2026, 7, 1, 23, 0),
    });
    const draft = ev({ status: "DRAFT", startsAt: new Date(2026, 7, 6, 20, 0) });
    expect(
      countUpcomingPublished([upcoming, ongoing, ended, draft], NOW),
    ).toBe(2);
  });
});
