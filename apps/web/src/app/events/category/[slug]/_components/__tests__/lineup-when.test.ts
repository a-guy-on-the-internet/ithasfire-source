import { afterEach, describe, expect, it } from "vitest";
import type { EventSummary } from "@th/ui";

import { toLineupWhen } from "../lineup-when";

/**
 * The category lineup's when-column is read in the EVENT's zone, so the list
 * and the grid card of one event print the same hour for every viewer, and the
 * server (UTC) renders the same labels the browser would. Each test switches
 * the PROCESS zone between formats; that only works in a forked child process
 * (`poolMatchGlobs` in `vitest.config.ts`), so every switch is asserted first.
 */

// Thu 15 Oct 2026, 7:00 PM CDT = Fri 16 Oct 2026, 00:00 UTC = 9:00 AM JST.
const THURSDAY_7PM_CHICAGO = "2026-10-16T00:00:00.000Z";
const ORIGINAL_TZ = process.env.TZ;

type Zone = "UTC" | "Asia/Tokyo" | "Asia/Kolkata";
const inProcessZone = <T>(zone: Zone, fn: () => T): T => {
  process.env.TZ = zone;
  const expectedMinutes = { UTC: 0, "Asia/Tokyo": 9 * 60, "Asia/Kolkata": 5 * 60 + 30 }[zone];
  const d = new Date(THURSDAY_7PM_CHICAGO);
  expect(
    d.getHours() * 60 + d.getMinutes(),
    `process TZ pin to ${zone} did not take`,
  ).toBe(expectedMinutes);
  return fn();
};

afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

const event = (
  timezone?: string | null,
  startsAt: string = THURSDAY_7PM_CHICAGO,
): EventSummary => ({
  id: "evt-tz",
  title: "Open Mic",
  date: "Thu, Oct 15, 7:00 PM",
  venue: "Our Spot",
  priceLabel: "Free",
  startsAt,
  ...(timezone === undefined ? {} : { timezone }),
});

describe("toLineupWhen: the event's zone, whatever the renderer's", () => {
  it("prints the same labels under UTC and Asia/Tokyo", () => {
    for (const compact of [false, true]) {
      const utc = inProcessZone("UTC", () =>
        toLineupWhen(event("America/Chicago"), "en-US", compact),
      );
      const tokyo = inProcessZone("Asia/Tokyo", () =>
        toLineupWhen(event("America/Chicago"), "en-US", compact),
      );
      expect(utc).toEqual(tokyo);
      expect(utc).toEqual({
        dateLabel: "Oct 15",
        timeLabel: compact ? "7 PM" : "Thu · 7 PM",
      });
    }
  });

  it("drops the minutes on the event's hour, even for a half-hour renderer", () => {
    // Asia/Kolkata is +5:30: 7:00 PM Central is 5:30 AM there, so a minute
    // read in the renderer's zone would print "7:00 PM".
    const kolkata = inProcessZone("Asia/Kolkata", () =>
      toLineupWhen(event("America/Chicago"), "en-US", true),
    );
    expect(kolkata.timeLabel).toBe("7 PM");

    const halfPast = inProcessZone("UTC", () =>
      toLineupWhen(
        event("America/Chicago", "2026-10-16T00:30:00.000Z"),
        "en-US",
        true,
      ),
    );
    expect(halfPast.timeLabel).toBe("7:30 PM");
  });

  it("follows the event's own zone", () => {
    const denver = inProcessZone("Asia/Tokyo", () =>
      toLineupWhen(event("America/Denver"), "en-US", false),
    );
    expect(denver).toEqual({ dateLabel: "Oct 15", timeLabel: "Thu · 6 PM" });
  });

  it("no zone, or an unusable one, reads as America/Chicago", () => {
    for (const tz of [undefined, null, "Not/AZone"]) {
      const tokyo = inProcessZone("Asia/Tokyo", () =>
        toLineupWhen(event(tz), "en-US", false),
      );
      expect(tokyo).toEqual({ dateLabel: "Oct 15", timeLabel: "Thu · 7 PM" });
    }
  });

  it("an untimed event keeps the server's own date string", () => {
    const untimed: EventSummary = { ...event("America/Chicago"), startsAt: undefined };
    expect(toLineupWhen(untimed, "en-US", false)).toEqual({
      dateLabel: "Thu, Oct 15, 7:00 PM",
    });
  });
});
