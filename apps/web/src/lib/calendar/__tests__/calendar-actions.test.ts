import { describe, expect, it } from "vitest";

import type { CalendarEventItem } from "@/app/admin/[slug]/_components/calendar/types";

import {
  buildMonthIcs,
  buildSingleEventIcs,
  safeFilename,
  toICalEvent,
  webcalFeedUrl,
} from "../calendar-actions";

const SITE = "https://ithasfire.com";
const TEXTS = {
  untitledTitle: "Untitled event",
  viewEventText: (url: string) => `View event: ${url}`,
};
const OPTS = { siteBaseUrl: SITE, ...TEXTS };

function item(over: Partial<CalendarEventItem> & { id: string }): CalendarEventItem {
  return {
    kind: "event",
    eventId: over.id.split(":")[0]!,
    title: `Event ${over.id}`,
    status: "PUBLISHED",
    startsAt: new Date("2026-09-05T01:00:00Z"),
    endsAt: new Date("2026-09-05T04:00:00Z"),
    timezone: "America/Chicago",
    ...over,
  };
}

describe("calendar-actions", () => {
  it("toICalEvent: one UID per occurrence, absolute public URL, venue as location", () => {
    const ical = toICalEvent(
      item({ id: "ev1:2", venueName: "The Blue Room", href: { public: "/events/blue-night" } }),
      OPTS,
    );
    expect(ical.uid).toBe("ev1:2@ithasfire.com");
    expect(ical.url).toBe("https://ithasfire.com/events/blue-night");
    expect(ical.location).toBe("The Blue Room");
    expect(ical.description).toContain("https://ithasfire.com/events/blue-night");
  });

  it("toICalEvent: no public href ⇒ no URL / description, blank title falls back", () => {
    const ical = toICalEvent(item({ id: "ev2", title: "" }), OPTS);
    expect(ical.url).toBeNull();
    expect(ical.description).toBeNull();
    expect(ical.title).toBe("Untitled event");
  });

  it("toICalEvent: the fallback title and the View event line come from the caller", () => {
    const ical = toICalEvent(
      item({ id: "ev4", title: "", href: { public: "/events/x" } }),
      {
        siteBaseUrl: SITE,
        untitledTitle: "Evento sin título",
        viewEventText: (url) => `Ver evento: ${url}`,
      },
    );
    expect(ical.title).toBe("Evento sin título");
    expect(ical.description).toBe("Ver evento: https://ithasfire.com/events/x");
  });

  it("buildSingleEventIcs: a VCALENDAR with the one VEVENT and a safe filename", () => {
    const { filename, content } = buildSingleEventIcs(
      item({ id: "ev3", title: "Late Night: Jazz / Funk?" }),
      OPTS,
    );
    expect(filename).toBe("Late-Night-Jazz-Funk.ics");
    expect(content).toContain("BEGIN:VCALENDAR");
    expect(content.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(content).toContain("SUMMARY:Late Night: Jazz / Funk?");
  });

  it("buildMonthIcs: every painted item, start-ordered, named after the month", () => {
    const later = item({ id: "b", startsAt: new Date("2026-09-20T01:00:00Z"), endsAt: null });
    const earlier = item({ id: "a" });
    const { filename, content } = buildMonthIcs([later, earlier], 2026, 9, "Dashboard", {
      ...OPTS,
    });
    expect(filename).toBe("Dashboard-2026-09.ics");
    expect(content.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(content.indexOf("UID:a@")).toBeLessThan(content.indexOf("UID:b@"));
    expect(content).toContain("X-WR-CALNAME:Dashboard");
  });

  it("webcalFeedUrl: the API feed per subject with the webcal scheme", () => {
    expect(webcalFeedUrl({ kind: "place", placeId: "p1" }, "https://api.ithasfire.com/")).toBe(
      "webcal://api.ithasfire.com/api/venues/p1/calendar.ics",
    );
    expect(webcalFeedUrl({ kind: "org", orgId: "o1" }, "http://localhost:3001")).toBe(
      "webcal://localhost:3001/api/orgs/o1/calendar.ics",
    );
    expect(webcalFeedUrl({ kind: "human", humanId: "h1" }, "https://api.ithasfire.com")).toBe(
      "webcal://api.ithasfire.com/api/humans/h1/calendar.ics",
    );
  });

  it("webcalFeedUrl: a non-English locale adds ?lang=, English stays unchanged", () => {
    const place = { kind: "place", placeId: "p1" } as const;
    expect(webcalFeedUrl(place, "https://api.ithasfire.com", "es")).toBe(
      "webcal://api.ithasfire.com/api/venues/p1/calendar.ics?lang=es",
    );
    expect(webcalFeedUrl(place, "https://api.ithasfire.com", "en")).toBe(
      webcalFeedUrl(place, "https://api.ithasfire.com"),
    );
    expect(webcalFeedUrl({ kind: "org", orgId: "o1" }, "http://localhost:3001", "es")).toBe(
      "webcal://localhost:3001/api/orgs/o1/calendar.ics?lang=es",
    );
  });

  it("safeFilename never returns an empty name", () => {
    expect(safeFilename("???")).toBe("calendar");
    expect(safeFilename("  Main   Room ")).toBe("Main-Room");
  });
});
