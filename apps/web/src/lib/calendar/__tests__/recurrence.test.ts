import { describe, expect, it } from "vitest";
import rrulePkg from "rrule";

import {
  buildRRuleValue,
  type CalendarRecurrence,
} from "@/lib/calendar/recurrence";

const { RRule } = rrulePkg;

const recurrence = (over: Partial<CalendarRecurrence> = {}): CalendarRecurrence => ({
  freq: "WEEKLY",
  interval: 1,
  byday: ["WE"],
  until: null,
  ...over,
});

describe("buildRRuleValue — what it emits", () => {
  it("states a weekly cadence with its day", () => {
    expect(buildRRuleValue(recurrence())).toBe("FREQ=WEEKLY;BYDAY=WE");
  });

  it("omits INTERVAL=1, which is the RFC 5545 default", () => {
    expect(buildRRuleValue(recurrence({ interval: 1 }))).not.toContain("INTERVAL");
  });

  it("states INTERVAL above 1", () => {
    expect(buildRRuleValue(recurrence({ interval: 2 }))).toBe(
      "FREQ=WEEKLY;INTERVAL=2;BYDAY=WE",
    );
  });

  it("normalises BYDAY to Monday-first order and de-duplicates", () => {
    expect(buildRRuleValue(recurrence({ byday: ["SU", "WE", "MO", "WE"] }))).toBe(
      "FREQ=WEEKLY;BYDAY=MO,WE,SU",
    );
  });

  it("accepts lowercase day codes", () => {
    expect(buildRRuleValue(recurrence({ byday: ["we"] }))).toBe(
      "FREQ=WEEKLY;BYDAY=WE",
    );
  });

  it("states DAILY and MONTHLY without a day list", () => {
    expect(buildRRuleValue(recurrence({ freq: "DAILY", byday: [] }))).toBe(
      "FREQ=DAILY",
    );
    expect(
      buildRRuleValue(recurrence({ freq: "MONTHLY", byday: [], interval: 3 })),
    ).toBe("FREQ=MONTHLY;INTERVAL=3");
  });
});

describe("buildRRuleValue — UNTIL", () => {
  it("is emitted as a UTC timestamp ending in Z", () => {
    expect(
      buildRRuleValue(recurrence({ until: "2026-12-31T06:00:00.000Z" })),
    ).toBe("FREQ=WEEKLY;BYDAY=WE;UNTIL=20261231T060000Z");
  });

  it("does NOT re-shift the instant summarizeRecurrence already resolved", () => {
    // 2026-11-26T02:00:00Z is 8:00 PM on the 25th in America/Chicago. The value
    // on the wire is the INSTANT, so the only correct output is its own UTC
    // rendering — applying the zone offset again would move the end of the
    // series by six hours.
    const value = buildRRuleValue(recurrence({ until: "2026-11-26T02:00:00Z" }));
    expect(value).toContain("UNTIL=20261126T020000Z");
  });

  it("is omitted entirely when the series is unbounded", () => {
    expect(buildRRuleValue(recurrence({ until: null }))).toBe(
      "FREQ=WEEKLY;BYDAY=WE",
    );
  });

  it("refuses the whole rule when UNTIL is present but unparseable", () => {
    // Dropping a bound we cannot read would export a finite series as endless.
    expect(buildRRuleValue(recurrence({ until: "not a date" }))).toBeNull();
  });
});

describe("buildRRuleValue — refusals (single-event export)", () => {
  it("refuses a null or absent summary", () => {
    expect(buildRRuleValue(null)).toBeNull();
    expect(buildRRuleValue(undefined)).toBeNull();
  });

  it("refuses a frequency outside the phrasable subset", () => {
    expect(
      buildRRuleValue({
        freq: "YEARLY",
        interval: 1,
        byday: [],
        until: null,
      } as unknown as CalendarRecurrence),
    ).toBeNull();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses interval %s rather than clamping it to 1",
    (interval) => {
      expect(buildRRuleValue(recurrence({ interval }))).toBeNull();
    },
  );

  it("refuses an unknown weekday code rather than dropping it", () => {
    // Dropping "XX" would widen "Wednesdays" to "every week", a rule that fires
    // on a day the schedule never names.
    expect(buildRRuleValue(recurrence({ byday: ["WE", "XX"] }))).toBeNull();
  });

  it("refuses DAILY carrying a day list", () => {
    expect(
      buildRRuleValue(recurrence({ freq: "DAILY", byday: ["MO", "WE"] })),
    ).toBeNull();
  });

  it("refuses MONTHLY carrying a day list — BYSETPOS is already lost", () => {
    // summarizeRecurrence strips BYSETPOS and the nth-prefix, so "second
    // Wednesday of the month" arrives here as { MONTHLY, ["WE"] }. Emitting
    // FREQ=MONTHLY;BYDAY=WE would book four or five nights a month.
    expect(buildRRuleValue(recurrence({ freq: "MONTHLY", byday: ["WE"] }))).toBeNull();
  });

  it("refuses a byday that is not an array of strings", () => {
    expect(
      buildRRuleValue(recurrence({ byday: "WE" as unknown as string[] })),
    ).toBeNull();
    expect(
      buildRRuleValue(recurrence({ byday: [3] as unknown as string[] })),
    ).toBeNull();
  });
});

describe("buildRRuleValue — the emitted rule round-trips through a real parser", () => {
  const parse = (value: string) =>
    RRule.fromString(`DTSTART:20260910T010000Z\nRRULE:${value}`);

  it("parses and expands the seeded open mic's cadence", () => {
    const value = buildRRuleValue(recurrence());
    expect(value).toBe("FREQ=WEEKLY;BYDAY=WE");

    const rule = parse(value!);
    expect(rule.options.freq).toBe(RRule.WEEKLY);
    expect(rule.options.interval).toBe(1);
    expect(rule.options.byweekday).toEqual([2]); // 0 = MO, so 2 = WE
    expect(rule.options.until).toBeNull();
  });

  it("parses a bounded fortnightly multi-day rule", () => {
    const value = buildRRuleValue(
      recurrence({
        interval: 2,
        byday: ["MO", "FR"],
        until: "2026-12-31T06:00:00Z",
      }),
    );
    expect(value).toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;UNTIL=20261231T060000Z");

    const rule = parse(value!);
    expect(rule.options.interval).toBe(2);
    expect(rule.options.byweekday).toEqual([0, 4]);
    expect(rule.options.until?.toISOString()).toBe("2026-12-31T06:00:00.000Z");
  });
});
