import { describe, expect, it } from "vitest";

import type { Commitment } from "../../../../_components/my-volunteering-helpers";
import { selectStatementShifts } from "../../../../_components/my-volunteering-helpers";
import {
  countShiftsWithoutHours,
  deriveStatementPeriod,
} from "../hours-statement-helpers";

const row = (over: Partial<Commitment> & { signupId: string }): Commitment => ({
  status: "CHECKED_IN",
  source: "EVENT_SHIFT",
  claimId: null,
  occurrenceId: null,
  cadence: null,
  signupsPaused: false,
  title: "Nashville Punk Fest",
  roleName: "Door",
  shiftLabel: null,
  startsAt: null,
  endsAt: null,
  eventId: "evt_1",
  eventSlug: "nashville-punk-fest",
  eventTimezone: "America/Chicago",
  addressText: null,
  askId: null,
  hoursWorked: null,
  hoursCredited: 4,
  checkedInAt: null,
  createdAt: new Date("2026-07-01T00:00:00Z"),
  smsOptIn: false,
  hasContactPhone: false,
  textRemindersOffered: false,
  reminderAnchor: null,
  ...over,
});

const at = (iso: string) => new Date(iso);

describe("deriveStatementPeriod", () => {
  it("brackets the shifts actually printed, never an assumed window", () => {
    const shifts = selectStatementShifts([
      row({ signupId: "a", checkedInAt: at("2026-02-11T18:00:00Z") }),
      row({ signupId: "b", checkedInAt: at("2026-06-30T18:00:00Z") }),
      row({ signupId: "c", checkedInAt: at("2026-04-02T18:00:00Z") }),
    ]);

    const period = deriveStatementPeriod(shifts);

    expect(period).not.toBeNull();
    expect(period!.startMs).toBe(at("2026-02-11T18:00:00Z").getTime());
    expect(period!.endMs).toBe(at("2026-06-30T18:00:00Z").getTime());
    expect(period!.singleDay).toBe(false);
  });

  it("reports a single day rather than a range when every shift is one day", () => {
    // "4 Aug – 4 Aug" on a one-shift statement reads as a template someone
    // forgot to finish.
    const shifts = selectStatementShifts([
      row({ signupId: "a", checkedInAt: at("2026-08-04T15:00:00Z") }),
    ]);

    expect(deriveStatementPeriod(shifts)!.singleDay).toBe(true);
  });

  it("returns null when no row carries a usable date — print no period, never an invented one", () => {
    expect(deriveStatementPeriod([])).toBeNull();
    expect(
      deriveStatementPeriod([
        { row: row({ signupId: "a" }), workedAtMs: null, hours: 4 },
      ]),
    ).toBeNull();
  });

  it("ignores dateless rows when computing the bounds", () => {
    const period = deriveStatementPeriod([
      { row: row({ signupId: "a" }), workedAtMs: null, hours: null },
      {
        row: row({ signupId: "b" }),
        workedAtMs: at("2026-03-01T00:00:00Z").getTime(),
        hours: 4,
      },
    ]);

    expect(period!.startMs).toBe(at("2026-03-01T00:00:00Z").getTime());
    expect(period!.endMs).toBe(at("2026-03-01T00:00:00Z").getTime());
  });

  it("falls back through checkedInAt → startsAt → createdAt for the bounds", () => {
    // Same resolution the Date column prints, so the stated period always
    // brackets the dates visible in the table.
    const shifts = selectStatementShifts([
      row({
        signupId: "start-only",
        checkedInAt: null,
        startsAt: at("2026-01-20T00:00:00Z"),
      }),
      row({
        signupId: "created-only",
        checkedInAt: null,
        startsAt: null,
        createdAt: at("2026-09-09T00:00:00Z"),
      }),
    ]);

    const period = deriveStatementPeriod(shifts);

    expect(period!.startMs).toBe(at("2026-01-20T00:00:00Z").getTime());
    expect(period!.endMs).toBe(at("2026-09-09T00:00:00Z").getTime());
  });
});

describe("countShiftsWithoutHours", () => {
  it("counts the rows that will print a dash instead of a figure", () => {
    const shifts = selectStatementShifts([
      row({ signupId: "a", hoursCredited: 4 }),
      row({ signupId: "b", source: "ASK_WINDOW", hoursCredited: null }),
      row({ signupId: "c", source: "ASK_WINDOW", hoursCredited: null }),
    ]);

    expect(countShiftsWithoutHours(shifts)).toBe(2);
  });

  it("is zero when every shift carries hours — no footnote to print", () => {
    const shifts = selectStatementShifts([
      row({ signupId: "a", hoursCredited: 4 }),
    ]);

    expect(countShiftsWithoutHours(shifts)).toBe(0);
  });

  it("does not treat a genuine zero-hour figure as missing", () => {
    // 0 is a claim ("this shift was credited no time"); null is the absence of
    // one. The footnote is only about the latter.
    const shifts = selectStatementShifts([
      row({ signupId: "a", hoursCredited: 0 }),
    ]);

    expect(countShiftsWithoutHours(shifts)).toBe(0);
  });
});
