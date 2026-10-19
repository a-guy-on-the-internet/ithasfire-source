import { afterEach, describe, expect, it } from "vitest";

import { formatEventDateLabel, mapEventItemToSummary } from "./embed-helpers";
import type { EventItem } from "./embed-types";

/**
 * The widget's card date is printed in the EVENT's zone, never the renderer's
 * (the server renders in UTC; a Nashville browser in Central). Each test
 * switches the PROCESS zone between formats. That only works in a forked
 * child process (`poolMatchGlobs` in `vitest.config.ts`); in a worker thread a
 * TZ assignment silently no-ops, so every switch is asserted first.
 */

// Thu 15 Oct 2026, 7:00 PM CDT = Fri 16 Oct 2026, 00:00 UTC = 9:00 AM JST.
const THURSDAY_7PM_CHICAGO = "2026-10-16T00:00:00.000Z";
const ORIGINAL_TZ = process.env.TZ;

const inProcessZone = <T>(zone: "UTC" | "Asia/Tokyo", fn: () => T): T => {
  process.env.TZ = zone;
  const expectedHour = { UTC: 0, "Asia/Tokyo": 9 }[zone];
  expect(
    new Date(THURSDAY_7PM_CHICAGO).getHours(),
    `process TZ pin to ${zone} did not take`,
  ).toBe(expectedHour);
  return fn();
};

afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

const event = (timezone?: string | null): EventItem => ({
  id: "evt-tz",
  title: "Open Mic",
  slug: "open-mic",
  startsAt: new Date(THURSDAY_7PM_CHICAGO),
  endsAt: null,
  ...(timezone === undefined ? {} : { timezone }),
  currency: "usd",
  heroImageUrl: null,
  addressText: "134 W Broadway",
  locality: "Gallatin",
  region: "TN",
  lowestPriceCents: null,
  paidTierCount: 0,
  hasFreeTier: false,
  lowestBuyerTotalCents: null,
});

describe("embed card date: the event's zone, whatever the renderer's", () => {
  it("prints the same text under UTC and Asia/Tokyo, in the event's zone", () => {
    const utc = inProcessZone("UTC", () =>
      mapEventItemToSummary(event("America/Chicago")),
    );
    const tokyo = inProcessZone("Asia/Tokyo", () =>
      mapEventItemToSummary(event("America/Chicago")),
    );

    expect(utc.date).toBe(tokyo.date);
    expect(utc.date).toMatch(/^Thu, Oct 15, 7:00\sPM$/);
    // The card's stamp reads the same zone the label was formatted in.
    expect(utc.timezone).toBe("America/Chicago");
  });

  it("follows the event's own zone, not the platform default", () => {
    const denver = inProcessZone("Asia/Tokyo", () =>
      mapEventItemToSummary(event("America/Denver")),
    );
    expect(denver.date).toMatch(/^Thu, Oct 15, 6:00\sPM$/);
    expect(denver.timezone).toBe("America/Denver");
  });

  it("a payload with no zone, or an unusable one, reads as America/Chicago", () => {
    for (const tz of [undefined, null, "Not/AZone"]) {
      const utc = inProcessZone("UTC", () => mapEventItemToSummary(event(tz)));
      const tokyo = inProcessZone("Asia/Tokyo", () =>
        mapEventItemToSummary(event(tz)),
      );
      expect(utc.date).toBe(tokyo.date);
      expect(utc.date).toMatch(/^Thu, Oct 15, 7:00\sPM$/);
      expect(utc.timezone).toBe("America/Chicago");
    }
  });

  it("the order summary's date line reads the same zone", () => {
    const utc = inProcessZone("UTC", () =>
      formatEventDateLabel(new Date(THURSDAY_7PM_CHICAGO), "America/Chicago"),
    );
    const tokyo = inProcessZone("Asia/Tokyo", () =>
      formatEventDateLabel(new Date(THURSDAY_7PM_CHICAGO), "America/Chicago"),
    );
    expect(utc).toBe(tokyo);
    expect(utc).toMatch(/^Thu, Oct 15, 7:00\sPM$/);
  });
});
