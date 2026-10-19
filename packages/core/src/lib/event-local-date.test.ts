import { describe, expect, it } from "vitest";

import { formatEventMonthDay } from "./event-local-date";

// Regression (prod, 2026-10-13): search results printed an evening Chicago
// show one day late, because the formatter had no `timeZone` and the server
// runs in UTC. Every case pins its zone, so the result is the same on a UTC
// machine and a Chicago one (run with TZ=UTC and TZ=America/Chicago).
describe("formatEventMonthDay", () => {
  it.each([
    {
      name: "7pm CDT Monday, 00:00Z the next day",
      at: "2026-10-13T00:00:00.000Z",
      zone: "America/Chicago",
      expected: "Oct 12",
    },
    {
      name: "10pm CDT Tuesday",
      at: "2026-10-14T03:00:00.000Z",
      zone: "America/Chicago",
      expected: "Oct 13",
    },
    {
      name: "2pm CDT, same day in both zones",
      at: "2026-10-13T19:00:00.000Z",
      zone: "America/Chicago",
      expected: "Oct 13",
    },
    {
      name: "7pm CST in winter (UTC-6)",
      at: "2026-12-08T01:00:00.000Z",
      zone: "America/Chicago",
      expected: "Dec 7",
    },
    {
      name: "9pm PDT in Los Angeles",
      at: "2026-10-13T04:00:00.000Z",
      zone: "America/Los_Angeles",
      expected: "Oct 12",
    },
  ])("formats in the event's zone: $name", ({ at, zone, expected }) => {
    expect(formatEventMonthDay(new Date(at), zone)).toBe(expected);
  });

  it("falls back to America/Chicago for an unknown, empty or missing zone", () => {
    const at = new Date("2026-10-13T00:00:00.000Z");
    expect(formatEventMonthDay(at, "Mars/Olympus_Mons")).toBe("Oct 12");
    expect(formatEventMonthDay(at, "")).toBe("Oct 12");
    expect(formatEventMonthDay(at, null)).toBe("Oct 12");
    expect(formatEventMonthDay(at, undefined)).toBe("Oct 12");
  });
});
