import { cleanup, screen } from "@testing-library/react";

import { renderWithProvider } from "../../../../../test/utils";
import { EventCard, type EventSummary } from "../event-grid";
import {
  deriveCardStamp,
  resolveCardTimeZone,
} from "../event-grid/card-stamp";

/**
 * Regression for the prod home-page hydration failure (React #418, 2026-10-15).
 *
 * The card stamped its date and start time in the RENDERER's zone. The server
 * renders in UTC (Cloud Run) and the browser in the viewer's zone, so a
 * Thursday 7:00 PM CDT show (00:00Z Friday) printed "12:00 AM" and FRI / 16 in
 * the server HTML and "7:00 PM" and THU / 15 in a Nashville browser.
 *
 * These tests switch the PROCESS zone between renders. That only works in a
 * child process (vitest 3 default pool `forks`); inside a worker thread a TZ
 * assignment is a silent no-op, so every test first asserts the switch took
 * (`expectProcessZone`) and fails rather than passing vacuously.
 */

// Thu 15 Oct 2026, 7:00 PM CDT = Fri 16 Oct 2026, 00:00 UTC.
const THURSDAY_7PM_CHICAGO = "2026-10-16T00:00:00.000Z";

const ORIGINAL_TZ = process.env.TZ;

const setProcessZone = (zone: string) => {
  process.env.TZ = zone;
};

/** Proves the pin took effect: local hours of the fixed instant per zone. */
const expectProcessZone = (zone: "UTC" | "America/Chicago" | "Asia/Tokyo") => {
  const localHour = new Date(THURSDAY_7PM_CHICAGO).getHours();
  const expected = { UTC: 0, "America/Chicago": 19, "Asia/Tokyo": 9 }[zone];
  expect(localHour, `process TZ pin to ${zone} did not take`).toBe(expected);
};

const RENDER_ZONES = ["UTC", "America/Chicago", "Asia/Tokyo"] as const;

afterEach(() => {
  cleanup();
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

const event: EventSummary = {
  id: "evt-tz",
  title: "Open Mic",
  // What the mapper emits for this instant in America/Chicago.
  date: "Thu, Oct 15, 7:00 PM",
  venue: "Our Spot, 134 W Broadway, Gallatin, TN 37066",
  priceLabel: "Free",
  startsAt: THURSDAY_7PM_CHICAGO,
  timezone: "America/Chicago",
};

const renderCardText = (summary: EventSummary, variant?: "ticket") => {
  renderWithProvider(
    <EventCard event={summary} variant={variant} testIdBase="tzcard" />,
  );
  const text = screen.getByTestId("tzcard").textContent ?? "";
  cleanup();
  return text;
};

describe("deriveCardStamp", () => {
  it("reads every part in the event's zone, whatever the process zone", () => {
    for (const zone of RENDER_ZONES) {
      setProcessZone(zone);
      expectProcessZone(zone);
      expect(deriveCardStamp(THURSDAY_7PM_CHICAGO, "America/Chicago")).toEqual(
        {
          month: "Oct",
          day: "15",
          stubParts: { weekday: "THU", day: "15", month: "OCT" },
          time: "7:00 PM",
        },
      );
    }
  });

  it("moves every part together for another zone", () => {
    setProcessZone("America/Chicago");
    expectProcessZone("America/Chicago");
    // 00:00Z Friday is 5:00 PM Thursday in Los Angeles.
    expect(
      deriveCardStamp(THURSDAY_7PM_CHICAGO, "America/Los_Angeles"),
    ).toMatchObject({
      day: "15",
      stubParts: { weekday: "THU", day: "15", month: "OCT" },
      time: "5:00 PM",
    });
  });

  it("falls back to the platform default zone, not the renderer's, when the zone is absent or unusable", () => {
    const results = RENDER_ZONES.flatMap((zone) => {
      setProcessZone(zone);
      expectProcessZone(zone);
      return [
        deriveCardStamp(THURSDAY_7PM_CHICAGO, undefined),
        deriveCardStamp(THURSDAY_7PM_CHICAGO, null),
        deriveCardStamp(THURSDAY_7PM_CHICAGO, ""),
        deriveCardStamp(THURSDAY_7PM_CHICAGO, "Not/AZone"),
      ];
    });
    // DEFAULT_VENUE_TIMEZONE is America/Chicago: the same fallback the server
    // mappers format `event.date` with, so the card agrees with that line.
    for (const stamp of results) {
      expect(stamp).toEqual(
        deriveCardStamp(THURSDAY_7PM_CHICAGO, "America/Chicago"),
      );
    }
  });

  it("returns no stamp without a usable instant", () => {
    expect(deriveCardStamp(undefined, "America/Chicago")).toBeNull();
    expect(deriveCardStamp("not a date", "America/Chicago")).toBeNull();
  });

  it("resolves the zone name it renders in", () => {
    expect(resolveCardTimeZone("Europe/Lisbon")).toBe("Europe/Lisbon");
    // Padded names are unusable, as in core's `resolveTimeZone` (no trim).
    expect(resolveCardTimeZone(" America/Denver ")).toBe("America/Chicago");
    expect(resolveCardTimeZone("  ")).toBe("America/Chicago");
    expect(resolveCardTimeZone("Not/AZone")).toBe("America/Chicago");
    expect(resolveCardTimeZone(null)).toBe("America/Chicago");
  });
});

describe("EventCard — same text on the server and in every browser", () => {
  it.each([
    ["poster", undefined],
    ["ticket", "ticket" as const],
  ])("%s: identical card text under UTC, Chicago and Tokyo", (_, variant) => {
    const texts = RENDER_ZONES.map((zone) => {
      setProcessZone(zone);
      expectProcessZone(zone);
      return renderCardText(event, variant);
    });

    expect(new Set(texts).size).toBe(1);
    // And it is the event's own wall clock, not the server's UTC one.
    expect(texts[0]).not.toContain("12:00 AM");
    expect(texts[0]).not.toMatch(/\bFRI\b/);
  });

  it("poster: prints the event's start time beside the place", () => {
    setProcessZone("UTC");
    expectProcessZone("UTC");
    expect(renderCardText(event)).toContain(
      "7:00 PM · Our Spot, 134 W Broadway, Gallatin, TN 37066",
    );
  });

  it("identical text when the producer sent no zone (a zone-less producer)", () => {
    const noZone: EventSummary = { ...event, timezone: undefined };
    const texts = RENDER_ZONES.map((zone) => {
      setProcessZone(zone);
      expectProcessZone(zone);
      return renderCardText(noZone);
    });
    expect(new Set(texts).size).toBe(1);
    expect(texts[0]).toContain("7:00 PM");
  });
});
