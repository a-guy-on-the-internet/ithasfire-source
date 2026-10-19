import { describe, expect, it } from "vitest";

import { buildVTimezoneLines } from "@/lib/calendar/vtimezone";
import { createZoneClock, formatUtcOffset } from "@/lib/calendar/zoned-time";

/** Wed 9 Sep 2026, 8:00 PM America/Chicago — the seeded open mic's start. */
const OPEN_MIC = new Date("2026-09-10T01:00:00.000Z");

const lines = (tz: string, dtstart = OPEN_MIC, until: Date | null = null) =>
  buildVTimezoneLines(tz, dtstart, until) ?? [];

const text = (...args: Parameters<typeof lines>) => lines(...args).join("\n");

describe("buildVTimezoneLines — structure", () => {
  it("wraps the definition and names the zone", () => {
    const out = lines("America/Chicago");
    expect(out[0]).toBe("BEGIN:VTIMEZONE");
    expect(out[1]).toBe("TZID:America/Chicago");
    expect(out.at(-1)).toBe("END:VTIMEZONE");
  });

  it("emits one DAYLIGHT and one STANDARD observance for a US zone", () => {
    const out = lines("America/Chicago");
    expect(out.filter((l) => l === "BEGIN:DAYLIGHT")).toHaveLength(1);
    expect(out.filter((l) => l === "BEGIN:STANDARD")).toHaveLength(1);
    expect(text("America/Chicago")).toContain("TZNAME:CDT");
    expect(text("America/Chicago")).toContain("TZNAME:CST");
  });

  it("returns null for a zone the runtime cannot resolve", () => {
    expect(buildVTimezoneLines("Mars/Olympus_Mons", OPEN_MIC, null)).toBeNull();
  });

  it("returns null for an invalid start instant", () => {
    expect(
      buildVTimezoneLines("America/Chicago", new Date("nope"), null),
    ).toBeNull();
  });
});

/**
 * One observance parsed out of the emitted definition. The transition instants
 * land as the observance's `DTSTART` plus its `RDATE`s — which of them is which
 * depends only on the probe window's lower edge, so the assertions below work
 * on `transitions` (the union) rather than on that split.
 */
type Observance = {
  kind: "STANDARD" | "DAYLIGHT";
  fromMinutes: number;
  toMinutes: number;
  name: string | null;
  /** Floating local date-times, `DTSTART` first. */
  transitions: string[];
};

function observances(...args: Parameters<typeof lines>): Observance[] {
  const out: Observance[] = [];
  let current: Observance | null = null;

  for (const line of lines(...args)) {
    if (line === "BEGIN:STANDARD" || line === "BEGIN:DAYLIGHT") {
      current = {
        kind: line === "BEGIN:STANDARD" ? "STANDARD" : "DAYLIGHT",
        fromMinutes: 0,
        toMinutes: 0,
        name: null,
        transitions: [],
      };
      continue;
    }
    if (!current) continue;
    if (line === "END:STANDARD" || line === "END:DAYLIGHT") {
      out.push(current);
      current = null;
    } else if (line.startsWith("DTSTART:") || line.startsWith("RDATE:")) {
      current.transitions.push(line.split(":")[1]!);
    } else if (line.startsWith("TZOFFSETFROM:")) {
      current.fromMinutes = parseOffset(line.slice("TZOFFSETFROM:".length));
    } else if (line.startsWith("TZOFFSETTO:")) {
      current.toMinutes = parseOffset(line.slice("TZOFFSETTO:".length));
    } else if (line.startsWith("TZNAME:")) {
      current.name = line.slice("TZNAME:".length);
    }
  }

  return out;
}

const pick = (all: Observance[], kind: Observance["kind"]) =>
  all.find((o) => o.kind === kind)!;

describe("buildVTimezoneLines — measured against known transitions", () => {
  /**
   * Ground truth for the United States: DST starts the second Sunday in March
   * and ends the first Sunday in November, both at 2 AM local. Chicago is
   * CST (-0600) / CDT (-0500).
   */
  it("states Chicago's spring-forwards at the canonical 2 AM", () => {
    const daylight = pick(observances("America/Chicago"), "DAYLIGHT");
    expect(daylight.fromMinutes).toBe(-360);
    expect(daylight.toMinutes).toBe(-300);
    expect(daylight.name).toBe("CDT");
    expect(daylight.transitions).toEqual(
      expect.arrayContaining([
        "20260308T020000", // 2nd Sun Mar 2026
        "20270314T020000", // 2nd Sun Mar 2027
        "20280312T020000", // 2nd Sun Mar 2028
        "20320314T020000", // 2nd Sun Mar 2032
      ]),
    );
    // Every stated transition is a 2 AM local one — nothing drifted.
    expect(daylight.transitions.every((t) => t.endsWith("T020000"))).toBe(true);
  });

  it("states Chicago's fall-backs at the canonical 2 AM", () => {
    const standard = pick(observances("America/Chicago"), "STANDARD");
    expect(standard.fromMinutes).toBe(-300);
    expect(standard.toMinutes).toBe(-360);
    expect(standard.name).toBe("CST");
    expect(standard.transitions).toEqual(
      expect.arrayContaining([
        "20251102T020000", // 1st Sun Nov 2025 — the observance covering DTSTART
        "20261101T020000", // 1st Sun Nov 2026
        "20271107T020000", // 1st Sun Nov 2027
        "20281105T020000", // 1st Sun Nov 2028
      ]),
    );
    expect(standard.transitions.every((t) => t.endsWith("T020000"))).toBe(true);
  });

  it("handles a European zone — last Sunday, 2 AM forward / 3 AM back", () => {
    const all = observances("Europe/Berlin", new Date("2026-06-10T18:00:00Z"));
    const daylight = pick(all, "DAYLIGHT");
    const standard = pick(all, "STANDARD");

    expect([daylight.fromMinutes, daylight.toMinutes]).toEqual([60, 120]);
    expect([standard.fromMinutes, standard.toMinutes]).toEqual([120, 60]);
    expect(daylight.transitions).toContain("20260329T020000"); // last Sun Mar
    expect(standard.transitions).toContain("20261025T030000"); // last Sun Oct
  });

  it("handles a southern-hemisphere zone, where DAYLIGHT starts in October", () => {
    const all = observances("Australia/Sydney", new Date("2026-06-10T08:00:00Z"));
    const daylight = pick(all, "DAYLIGHT");
    const standard = pick(all, "STANDARD");

    expect([daylight.fromMinutes, daylight.toMinutes]).toEqual([600, 660]);
    expect([standard.fromMinutes, standard.toMinutes]).toEqual([660, 600]);
    expect(daylight.transitions).toContain("20261004T020000"); // 1st Sun Oct, 2 AM
    expect(standard.transitions).toContain("20270404T030000"); // 1st Sun Apr, 3 AM
  });

  it("handles a half-hour offset", () => {
    const out = text("Asia/Kolkata", new Date("2026-06-10T08:00:00Z"));
    expect(out).toContain("TZOFFSETFROM:+0530");
    expect(out).toContain("TZOFFSETTO:+0530");
  });
});

describe("buildVTimezoneLines — fixed-offset zones", () => {
  it.each(["UTC", "America/Phoenix", "Asia/Kolkata"])(
    "%s gets exactly one STANDARD observance and no RDATEs",
    (tz) => {
      const out = lines(tz, new Date("2026-06-10T18:00:00Z"));
      expect(out.filter((l) => l === "BEGIN:STANDARD")).toHaveLength(1);
      expect(out.filter((l) => l === "BEGIN:DAYLIGHT")).toHaveLength(0);
      expect(out.filter((l) => l.startsWith("RDATE:"))).toHaveLength(0);
    },
  );

  it("states the constant offset on both sides", () => {
    const out = text("America/Phoenix", new Date("2026-06-10T18:00:00Z"));
    expect(out).toContain("TZOFFSETFROM:-0700");
    expect(out).toContain("TZOFFSETTO:-0700");
  });

  it("starts the observance before the event, so it covers DTSTART", () => {
    const out = lines("UTC", new Date("2026-06-10T18:00:00Z"));
    const dtstart = out.find((l) => l.startsWith("DTSTART:"))!;
    expect(dtstart.slice("DTSTART:".length) < "20260610T180000").toBe(true);
  });
});

describe("buildVTimezoneLines — the probe window", () => {
  it("covers roughly ten years when the series is unbounded", () => {
    const out = lines("America/Chicago");
    const years = out
      .filter((l) => l.startsWith("DTSTART:") || l.startsWith("RDATE:"))
      .map((l) => Number(l.split(":")[1]!.slice(0, 4)));
    expect(Math.min(...years)).toBeLessThanOrEqual(2025);
    expect(Math.max(...years)).toBeGreaterThanOrEqual(2035);
  });

  it("stops at UNTIL when the series is bounded", () => {
    const out = lines("America/Chicago", OPEN_MIC, new Date("2026-12-31T06:00:00Z"));
    const years = out
      .filter((l) => l.startsWith("DTSTART:") || l.startsWith("RDATE:"))
      .map((l) => Number(l.split(":")[1]!.slice(0, 4)));
    expect(Math.max(...years)).toBeLessThanOrEqual(2026);
  });
});

describe("the VTIMEZONE agrees with the clock it was derived from", () => {
  /**
   * Re-derives every stated transition back to a real instant and checks the
   * zone actually changes offset there. This is the assertion that catches the
   * coordinate trap in `floatingLocal`: a double-applied offset puts every
   * DTSTART/RDATE an hour (or six) off the true boundary, and the emitted file
   * still looks plausible.
   */
  it.each(["America/Chicago", "Europe/Berlin", "Australia/Sydney"])(
    "%s",
    (tz) => {
      const clock = createZoneClock(tz)!;
      const all = observances(tz, new Date("2026-06-10T12:00:00Z"));
      let checked = 0;

      for (const observance of all) {
        if (observance.fromMinutes === observance.toMinutes) continue;
        for (const local of observance.transitions) {
          // Undo the "local time read against TZOFFSETFROM" convention.
          const instant = new Date(
            floatingToUtcMs(local) - observance.fromMinutes * 60_000,
          );
          expect(clock.offsetMinutes(new Date(instant.getTime() - 60_000))).toBe(
            observance.fromMinutes,
          );
          expect(clock.offsetMinutes(instant)).toBe(observance.toMinutes);
          checked += 1;
        }
      }

      expect(checked).toBeGreaterThan(10);
    },
  );
});

describe("formatUtcOffset", () => {
  it.each([
    [-360, "-0600"],
    [-300, "-0500"],
    [330, "+0530"],
    [0, "+0000"],
    [660, "+1100"],
    [-30, "-0030"],
  ])("%s → %s", (minutes, expected) => {
    expect(formatUtcOffset(minutes)).toBe(expected);
  });
});

function parseOffset(value: string): number {
  const sign = value.startsWith("-") ? -1 : 1;
  const hours = Number(value.slice(1, 3));
  const minutes = Number(value.slice(3, 5));
  return sign * (hours * 60 + minutes);
}

/** `20260308T020000` read as if it were UTC. */
function floatingToUtcMs(value: string): number {
  return Date.UTC(
    Number(value.slice(0, 4)),
    Number(value.slice(4, 6)) - 1,
    Number(value.slice(6, 8)),
    Number(value.slice(9, 11)),
    Number(value.slice(11, 13)),
    Number(value.slice(13, 15)),
  );
}
