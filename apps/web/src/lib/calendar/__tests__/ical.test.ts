import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import rrulePkg from "rrule";

import {
  generateICalString,
  type CalendarEventData,
} from "@/lib/calendar/ical";

const { RRule } = rrulePkg;

/** Wed 9 Sep 2026, 8:00–11:00 PM America/Chicago — the seeded open mic. */
const OPEN_MIC: CalendarEventData = {
  id: "e90f26c7-a1ef-4891-b780-7d9cdd0f4705",
  title: "Grown and Sexy Open Mic",
  startsAt: "2026-09-10T01:00:00.000Z",
  endsAt: "2026-09-10T04:00:00.000Z",
  location: "Carol Ann's, Nashville, TN",
  timezone: "America/Chicago",
};

const WEEKLY = {
  freq: "WEEKLY" as const,
  interval: 1,
  byday: ["WE"],
  until: null,
};

const lines = (event: CalendarEventData) => generateICalString(event).split("\r\n");

/**
 * The first line in the VEVENT starting with `prefix`. Scoped to the VEVENT on
 * purpose: a VTIMEZONE carries `DTSTART` lines of its own, and a helper that
 * scanned the whole file would silently assert against a DST transition.
 */
const line = (event: CalendarEventData, prefix: string) => {
  const all = lines(event);
  return all
    .slice(all.indexOf("BEGIN:VEVENT"))
    .find((l) => l.startsWith(prefix));
};

beforeEach(() => {
  vi.useFakeTimers();
  // DTSTAMP is `new Date()`, so it has to be pinned for any exact-output check.
  vi.setSystemTime(new Date("2026-09-12T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
// UID
// ─────────────────────────────────────────────────────────────────────────────

describe("UID is stable across downloads", () => {
  it("is identical on two generations of the same event", () => {
    // The defect: the UID used to carry `Math.random()`, so a second "Add to
    // calendar" was a NEW entry to every client instead of an update — the user
    // silently accumulated duplicates.
    expect(line(OPEN_MIC, "UID:")).toBe(line(OPEN_MIC, "UID:"));
  });

  it("is derived from the event id, with the domain suffix kept", () => {
    expect(line(OPEN_MIC, "UID:")).toBe(
      "UID:e90f26c7-a1ef-4891-b780-7d9cdd0f4705@ithasfire",
    );
  });

  it("survives a retitle, a move and a reschedule — the id is the identity", () => {
    const moved = {
      ...OPEN_MIC,
      title: "Open Mic (new name)",
      location: "Somewhere else",
      startsAt: "2026-10-01T01:00:00.000Z",
      endsAt: undefined,
    };
    expect(line(moved, "UID:")).toBe(line(OPEN_MIC, "UID:"));
  });

  it("differs between two different events", () => {
    expect(line({ ...OPEN_MIC, id: "other-event" }, "UID:")).not.toBe(
      line(OPEN_MIC, "UID:"),
    );
  });

  it("is still deterministic without an id", () => {
    // Surfaces that render the page without an event id (the admin preview) get
    // a digest of the identifying fields instead — weaker, but not random.
    const anonymous = { ...OPEN_MIC, id: undefined };
    const uid = line(anonymous, "UID:")!;
    expect(uid).toBe(line(anonymous, "UID:"));
    expect(uid).toMatch(/^UID:20260910T010000Z-[0-9a-z]{7,}@ithasfire$/);
    expect(uid).not.toContain("undefined");
  });

  it("separates two same-instant events in the no-id fallback", () => {
    const a = { ...OPEN_MIC, id: undefined };
    const b = { ...a, title: "A different event at the same time" };
    expect(line(a, "UID:")).not.toBe(line(b, "UID:"));
  });

  it("treats a blank id as no id", () => {
    expect(line({ ...OPEN_MIC, id: "   " }, "UID:")).toMatch(/^UID:20260910T/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The non-recurring path must not move
// ─────────────────────────────────────────────────────────────────────────────

describe("the single-event export is unchanged", () => {
  /**
   * The exact bytes, pinned. The only field that could not stay as it was is
   * `UID` — it was the bug. Everything else, including the line ORDER, the CRLF
   * joins, the UTC `DTSTART`/`DTEND`, and the absence of folding on SUMMARY /
   * LOCATION, is byte-for-byte what this module emitted before recurrence
   * existed.
   */
  it("matches the pinned output for a non-recurring event", () => {
    expect(generateICalString(OPEN_MIC)).toBe(
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Ithas Fire//Event//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "BEGIN:VEVENT",
        "UID:e90f26c7-a1ef-4891-b780-7d9cdd0f4705@ithasfire",
        "DTSTART:20260910T010000Z",
        "DTEND:20260910T040000Z",
        "SUMMARY:Grown and Sexy Open Mic",
        "LOCATION:Carol Ann's\\, Nashville\\, TN",
        "DTSTAMP:20260912T120000Z",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
    );
  });

  it("adds no recurrence machinery when there is no recurrence", () => {
    for (const recurrence of [undefined, null]) {
      const out = generateICalString({ ...OPEN_MIC, recurrence });
      expect(out).not.toContain("RRULE");
      expect(out).not.toContain("VTIMEZONE");
      expect(out).not.toContain("TZID");
      expect(out).not.toContain("X-WR-TIMEZONE");
    }
  });

  it("keeps the UTC DTSTART even when a timezone is supplied", () => {
    // A timezone alone must not move a one-off appointment: it is only the
    // recurring path that needs the wall clock.
    expect(line({ ...OPEN_MIC, timezone: "America/Chicago" }, "DTSTART")).toBe(
      "DTSTART:20260910T010000Z",
    );
  });

  it("still defaults to a two-hour duration", () => {
    expect(line({ ...OPEN_MIC, endsAt: undefined }, "DTEND")).toBe(
      "DTEND:20260910T030000Z",
    );
  });

  it("still escapes text fields and emits the optional ones in order", () => {
    const out = lines({
      ...OPEN_MIC,
      title: "Semi; comma, slash\\ and\nnewline",
      description: "A, B; C",
      url: "https://ithasfire.com/events/x",
    });
    expect(out).toContain(
      "SUMMARY:Semi\\; comma\\, slash\\\\ and\\nnewline",
    );
    expect(out).toContain("DESCRIPTION:A\\, B\\; C");
    expect(out).toContain("URL:https://ithasfire.com/events/x");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The recurring path
// ─────────────────────────────────────────────────────────────────────────────

describe("the recurring export", () => {
  const recurring = { ...OPEN_MIC, recurrence: WEEKLY };

  it("emits the RRULE for the seeded open mic", () => {
    expect(line(recurring, "RRULE")).toBe("RRULE:FREQ=WEEKLY;BYDAY=WE");
  });

  it("states DTSTART/DTEND as the event's WALL CLOCK under a TZID", () => {
    // This is the load-bearing one. 8:00 PM Wednesday in America/Chicago is
    // 01:00Z on THURSDAY, so a UTC DTSTART would make `BYDAY=WE` generate
    // Tuesday nights and would slide the 8 PM start to 7 PM after the November
    // DST boundary.
    expect(line(recurring, "DTSTART")).toBe(
      "DTSTART;TZID=America/Chicago:20260909T200000",
    );
    expect(line(recurring, "DTEND")).toBe(
      "DTEND;TZID=America/Chicago:20260909T230000",
    );
  });

  it("defines the TZID it references, as RFC 5545 §3.2.19 requires", () => {
    const out = lines(recurring);
    expect(out).toContain("BEGIN:VTIMEZONE");
    expect(out).toContain("TZID:America/Chicago");
    expect(out).toContain("END:VTIMEZONE");
    // The definition precedes the event that references it.
    expect(out.indexOf("END:VTIMEZONE")).toBeLessThan(out.indexOf("BEGIN:VEVENT"));
  });

  it("names the zone for Google's importer", () => {
    // Calendar-level, so it sits above BEGIN:VEVENT rather than inside it.
    expect(lines(recurring)).toContain("X-WR-TIMEZONE:America/Chicago");
  });

  it("keeps the UID stable — a recurring series is still ONE entry", () => {
    expect(line(recurring, "UID:")).toBe(line(OPEN_MIC, "UID:"));
  });

  it("carries UNTIL when the series is bounded", () => {
    expect(
      line({ ...recurring, recurrence: { ...WEEKLY, until: "2026-12-31T06:00:00Z" } }, "RRULE"),
    ).toBe("RRULE:FREQ=WEEKLY;BYDAY=WE;UNTIL=20261231T060000Z");
  });

  it("omits UNTIL entirely when the series is unbounded", () => {
    // The page's date list is capped (hence its `truncated` flag), so its last
    // row must never be borrowed as an end date.
    expect(line(recurring, "RRULE")).not.toContain("UNTIL");
  });

  it("falls back to the single-event export when the cadence is unstatable", () => {
    // MONTHLY + BYDAY: the ordinal was already lost upstream, so the rule would
    // book four or five nights a month. Refusing means one correct night.
    const out = generateICalString({
      ...recurring,
      recurrence: { ...WEEKLY, freq: "MONTHLY", byday: ["WE"] },
    });
    expect(out).not.toContain("RRULE");
    expect(out).toContain("DTSTART:20260910T010000Z");
  });

  it("falls back to the single-event export with no timezone", () => {
    const out = generateICalString({ ...recurring, timezone: undefined });
    expect(out).not.toContain("RRULE");
    expect(out).not.toContain("TZID");
    expect(out).toContain("DTSTART:20260910T010000Z");
  });

  it("falls back to the single-event export for an unresolvable timezone", () => {
    const out = generateICalString({ ...recurring, timezone: "Mars/Olympus_Mons" });
    expect(out).not.toContain("RRULE");
    expect(out).not.toContain("TZID");
    expect(out).toContain("DTSTART:20260910T010000Z");
  });

  it("folds an RRULE line past 75 octets per RFC 5545 §3.1", () => {
    const out = generateICalString({
      ...recurring,
      recurrence: {
        freq: "WEEKLY",
        interval: 99,
        byday: ["MO", "TU", "WE", "TH", "FR", "SA", "SU"],
        until: "2036-12-31T06:00:00Z",
      },
    });
    const all = out.split("\r\n");
    const start = all.findIndex((l) => l.startsWith("RRULE:"));
    expect(start).toBeGreaterThan(-1);
    expect(all[start]!.length).toBe(75);
    // The continuation carries the single-space prefix a parser strips.
    expect(all[start + 1]).toMatch(/^ /);
    // Unfolded, the rule is intact.
    expect(`${all[start]}${all[start + 1]!.slice(1)}`).toBe(
      "RRULE:FREQ=WEEKLY;INTERVAL=99;BYDAY=MO,TU,WE,TH,FR,SA,SU;UNTIL=20361231T060000Z",
    );
    // Every content line is now within the limit.
    expect(all.every((l) => l.length <= 75)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// What a client would actually expand
// ─────────────────────────────────────────────────────────────────────────────

describe("a client expanding the emitted VEVENT lands on the right nights", () => {
  it("gives Wednesdays at 8 PM America/Chicago, across the DST boundary", () => {
    const out = lines({ ...OPEN_MIC, recurrence: WEEKLY });
    const dtstart = out
      .find((l) => l.startsWith("DTSTART;"))!
      .split(":")[1]!;
    const rrule = out.find((l) => l.startsWith("RRULE:"))!.slice("RRULE:".length);

    // Expand the rule on the LOCAL basis the TZID establishes: `rrule` is
    // driven in floating space, so the results read back as wall-clock fields.
    const rule = RRule.fromString(`DTSTART:${dtstart}\nRRULE:${rrule}`);
    const occurrences = rule.all((_, index) => index < 10);

    for (const occurrence of occurrences) {
      // Floating values: the UTC fields ARE the wall clock.
      expect(occurrence.getUTCDay()).toBe(3); // Wednesday
      expect(occurrence.getUTCHours()).toBe(20); // 8 PM, every single week
    }

    expect(occurrences[0]!.toISOString()).toBe("2026-09-09T20:00:00.000Z");
    // Four weeks past the 1 Nov 2026 fall-back, still 8 PM on a Wednesday.
    expect(occurrences.at(-1)!.toISOString()).toBe("2026-11-11T20:00:00.000Z");
  });
});

describe("an end the server sends can be unreadable or inverted", () => {
  const cases = [
    ["unreadable", "not a date"],
    ["before the start", "2026-09-09T20:00:00.000Z"],
    ["equal to the start", OPEN_MIC.startsAt],
  ] as const;

  for (const [label, endsAt] of cases) {
    it(`an end ${label} becomes start + 2h`, () => {
      expect(line({ ...OPEN_MIC, endsAt }, "DTEND")).toBe("DTEND:20260910T030000Z");
    });
  }

  it("recurring export: an inverted end still ends at start + 2h in the zone", () => {
    const event = {
      ...OPEN_MIC,
      endsAt: "2026-09-09T20:00:00.000Z",
      recurrence: WEEKLY,
    };
    expect(line(event, "DTEND")).toBe("DTEND;TZID=America/Chicago:20260909T220000");
  });

  it("a valid end is used as sent", () => {
    expect(line(OPEN_MIC, "DTEND")).toBe("DTEND:20260910T040000Z");
  });
});
