import { describe, expect, it } from "vitest";

import {
  bucketCommitments,
  commitmentHref,
  commitmentSmsLabelKey,
  commitmentRowKey,
  computeTotals,
  formatDateBlock,
  formatDayLine,
  formatWindow,
  hasStatementShifts,
  isOccurrenceRow,
  isOpenEndedCommitment,
  selectStatementShifts,
  sumCreditedHours,
  type Commitment,
} from "../my-volunteering-helpers";

const NOW = new Date("2026-08-12T18:00:00Z").getTime();

const row = (over: Partial<Commitment> & { signupId: string }): Commitment => ({
  status: "APPROVED",
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
  hoursCredited: null,
  checkedInAt: null,
  createdAt: new Date("2026-07-01T00:00:00Z"),
  smsOptIn: false,
  hasContactPhone: false,
  textRemindersOffered: false,
  reminderAnchor: null,
  ...over,
});

const at = (iso: string) => new Date(iso);

describe("bucketCommitments", () => {
  it("puts the soonest future APPROVED row in nextUp and the rest in confirmed", () => {
    const soon = row({
      signupId: "a",
      startsAt: at("2026-08-14T00:00:00Z"),
      endsAt: at("2026-08-14T04:00:00Z"),
    });
    const later = row({
      signupId: "b",
      startsAt: at("2026-09-01T00:00:00Z"),
      endsAt: at("2026-09-01T04:00:00Z"),
    });

    // Deliberately fed out of order — the page must not depend on server sort.
    const buckets = bucketCommitments([later, soon], NOW);

    expect(buckets.nextUp?.signupId).toBe("a");
    expect(buckets.confirmed.map((r) => r.signupId)).toEqual(["b"]);
    expect(buckets.history).toHaveLength(0);
  });

  it("never promotes a windowless commitment to nextUp, but keeps it confirmed", () => {
    const windowless = row({ signupId: "w", startsAt: null, endsAt: null });

    const buckets = bucketCommitments([windowless], NOW);

    expect(buckets.nextUp).toBeNull();
    expect(buckets.confirmed.map((r) => r.signupId)).toEqual(["w"]);
  });

  it("keeps PENDING out of confirmed — an application is not a commitment", () => {
    const pending = row({
      signupId: "p",
      status: "PENDING",
      startsAt: at("2026-08-13T00:00:00Z"),
    });
    const approved = row({
      signupId: "a",
      startsAt: at("2026-08-20T00:00:00Z"),
    });

    const buckets = bucketCommitments([pending, approved], NOW);

    // The pending row starts SOONER than the approved one; it must still not
    // be next up, and must not appear in confirmed.
    expect(buckets.nextUp?.signupId).toBe("a");
    expect(buckets.confirmed.map((r) => r.signupId)).toEqual([]);
    expect(buckets.awaiting.map((r) => r.signupId)).toEqual(["p"]);
  });

  it("files terminal statuses in history even when the window is future", () => {
    const withdrawn = row({
      signupId: "w",
      status: "WITHDRAWN",
      startsAt: at("2026-09-09T00:00:00Z"),
    });
    const rejected = row({
      signupId: "r",
      status: "REJECTED",
      startsAt: at("2026-09-10T00:00:00Z"),
    });

    const buckets = bucketCommitments([withdrawn, rejected], NOW);

    expect(buckets.confirmed).toHaveLength(0);
    expect(buckets.awaiting).toHaveLength(0);
    expect(buckets.history.map((r) => r.signupId).sort()).toEqual(["r", "w"]);
  });

  it("files a past unreviewed application in history, not awaiting", () => {
    const stale = row({
      signupId: "s",
      status: "PENDING",
      startsAt: at("2026-08-01T00:00:00Z"),
      endsAt: at("2026-08-01T04:00:00Z"),
    });

    const buckets = bucketCommitments([stale], NOW);

    expect(buckets.awaiting).toHaveLength(0);
    expect(buckets.history.map((r) => r.signupId)).toEqual(["s"]);
  });

  it("treats an in-progress shift (started, not ended) as still upcoming", () => {
    const running = row({
      signupId: "n",
      startsAt: at("2026-08-12T16:00:00Z"),
      endsAt: at("2026-08-12T22:00:00Z"),
    });

    const buckets = bucketCommitments([running, row({ signupId: "z" })], NOW);

    expect(buckets.history).toHaveLength(0);
    // Its start is in the past, so it can't be "next up" — but it's confirmed.
    expect(buckets.nextUp).toBeNull();
    expect(buckets.confirmed.map((r) => r.signupId)).toEqual(["n", "z"]);
  });

  it("orders history newest first", () => {
    const old = row({
      signupId: "old",
      status: "CHECKED_IN",
      startsAt: at("2025-01-01T00:00:00Z"),
      endsAt: at("2025-01-01T04:00:00Z"),
    });
    const recent = row({
      signupId: "recent",
      status: "CHECKED_IN",
      startsAt: at("2026-06-01T00:00:00Z"),
      endsAt: at("2026-06-01T04:00:00Z"),
    });

    const buckets = bucketCommitments([old, recent], NOW);

    expect(buckets.history.map((r) => r.signupId)).toEqual(["recent", "old"]);
  });

  // ── Standing / open-ended asks ────────────────────────────────────────────
  //
  // An ASK_WINDOW row's window comes from the ask, whose startsAt/endsAt are
  // both nullable. Whether a missing end means "endless" or "nobody filled it
  // in" is decided by CADENCE — the record now carries it, so the old blanket
  // carve-out (every endless ask stays open) is gone.

  it("keeps an ONGOING ask with a past start in confirmed, not history", () => {
    const standing = row({
      signupId: "standing",
      source: "ASK_WINDOW",
      cadence: "ONGOING",
      eventId: null,
      eventSlug: null,
      eventTimezone: null,
      askId: "ask-1",
      startsAt: at("2026-01-01T00:00:00Z"),
      endsAt: null,
    });

    const buckets = bucketCommitments([standing], NOW);

    expect(buckets.history).toHaveLength(0);
    expect(buckets.confirmed.map((r) => r.signupId)).toEqual(["standing"]);
    // It has no meaningful "when", so it can never be Next up.
    expect(buckets.nextUp).toBeNull();
  });

  it("keeps a RECURRING ask open the same way", () => {
    const standing = row({
      signupId: "recurring",
      source: "ASK_WINDOW",
      cadence: "RECURRING",
      eventId: null,
      eventSlug: null,
      askId: "ask-r",
      startsAt: at("2026-01-01T00:00:00Z"),
      endsAt: null,
    });

    expect(bucketCommitments([standing], NOW).confirmed).toHaveLength(1);
  });

  it("DEMOTES a ONE_TIME ask whose end was simply never filled in", () => {
    // The case the interim blanket carve-out got wrong: a one-off from last
    // March is not "still going", and leaving it in Confirmed parked a dead
    // commitment at the top of the page forever.
    const oneOff = row({
      signupId: "one-off",
      source: "ASK_WINDOW",
      cadence: "ONE_TIME",
      eventId: null,
      eventSlug: null,
      askId: "ask-once",
      startsAt: at("2026-03-01T00:00:00Z"),
      endsAt: null,
    });

    const buckets = bucketCommitments([oneOff], NOW);

    expect(buckets.confirmed).toHaveLength(0);
    expect(buckets.history.map((r) => r.signupId)).toEqual(["one-off"]);
  });

  it("keeps a FUTURE ONE_TIME ask with no end upcoming, not in history", () => {
    // Falling through to the start must not demote something that hasn't
    // happened yet — it becomes an ordinary dated commitment.
    const future = row({
      signupId: "future-once",
      source: "ASK_WINDOW",
      cadence: "ONE_TIME",
      eventId: null,
      eventSlug: null,
      askId: "ask-future",
      startsAt: at("2026-09-01T00:00:00Z"),
      endsAt: null,
    });

    const buckets = bucketCommitments([future], NOW);

    expect(buckets.history).toHaveLength(0);
    expect(buckets.nextUp?.signupId).toBe("future-once");
  });

  it("stays conservative when the row has no ask behind it at all", () => {
    // `cadence: null` = an event-shift signup the askId backfill never
    // reached. Nothing to key off, so it takes the event-shift branch.
    const orphan = row({
      signupId: "orphan",
      source: "ASK_WINDOW",
      cadence: null,
      askId: null,
      startsAt: at("2026-01-01T00:00:00Z"),
      endsAt: null,
    });

    expect(
      bucketCommitments([orphan], NOW).history.map((r) => r.signupId),
    ).toEqual(["orphan"]);
  });

  it("still demotes an ask whose window genuinely ended", () => {
    const finished = row({
      signupId: "finished",
      source: "ASK_WINDOW",
      eventId: null,
      eventSlug: null,
      askId: "ask-2",
      startsAt: at("2026-01-01T00:00:00Z"),
      endsAt: at("2026-02-01T00:00:00Z"),
    });

    const buckets = bucketCommitments([finished], NOW);

    expect(buckets.confirmed).toHaveLength(0);
    expect(buckets.history.map((r) => r.signupId)).toEqual(["finished"]);
  });

  it("still demotes an event shift with a start-only past window", () => {
    // The ASK_WINDOW carve-out must NOT leak to event shifts, whose window is
    // a real shift: a start that has passed means it's over.
    const shift = row({
      signupId: "shift",
      source: "EVENT_SHIFT",
      startsAt: at("2026-08-01T00:00:00Z"),
      endsAt: null,
    });

    expect(
      bucketCommitments([shift], NOW).history.map((r) => r.signupId),
    ).toEqual(["shift"]);
  });

  it("keeps an unknown status VISIBLE instead of dropping the row", () => {
    // `VolunteerSignupStatus` is hand-mirrored from the Prisma enum and no
    // runtime validation stands between the DB and this code, so a seventh
    // value can arrive before the union knows about it. Dropping it silently
    // would leave the header counting a row the page never renders.
    const offEnum = row({
      signupId: "off-enum",
      status: "ESCALATED" as Commitment["status"],
    });

    const buckets = bucketCommitments([offEnum], NOW);

    expect(
      [...buckets.confirmed, ...buckets.awaiting, ...buckets.history].map(
        (r) => r.signupId,
      ),
    ).toEqual(["off-enum"]);
  });

  it("does not mutate the input array", () => {
    const input = [
      row({
        signupId: "a",
        status: "CHECKED_IN",
        startsAt: at("2025-01-01T00:00:00Z"),
      }),
      row({
        signupId: "b",
        status: "CHECKED_IN",
        startsAt: at("2026-01-01T00:00:00Z"),
      }),
    ];
    const snapshot = input.map((r) => r.signupId);

    bucketCommitments(input, NOW);

    expect(input.map((r) => r.signupId)).toEqual(snapshot);
  });
});

describe("computeTotals", () => {
  it("counts only CHECKED_IN rows from the current year", () => {
    const rows = [
      row({
        signupId: "a",
        status: "CHECKED_IN",
        hoursCredited: 4,
        checkedInAt: at("2026-03-01T00:00:00Z"),
      }),
      row({
        signupId: "b",
        status: "CHECKED_IN",
        hoursCredited: 2.5,
        checkedInAt: at("2026-05-01T00:00:00Z"),
      }),
      // Last year — excluded from the "this year" figures.
      row({
        signupId: "c",
        status: "CHECKED_IN",
        hoursCredited: 99,
        checkedInAt: at("2025-05-01T00:00:00Z"),
      }),
      // Approved but never checked in — no hours, no shift.
      row({ signupId: "d", status: "APPROVED", hoursCredited: 8 }),
    ];

    expect(computeTotals(rows, NOW)).toEqual({
      hoursThisYear: 6.5,
      shiftsThisYear: 2,
    });
  });

  it("credits the shift's scheduled duration when hoursWorked is null", () => {
    // The read model resolves "override when set, else the shift's scheduled
    // duration" into `hoursCredited`. Reading the raw `hoursWorked` here told a
    // volunteer who worked a four-hour shift that they had logged 0 hours,
    // while the organiser's export said 4.
    const rows = [
      row({
        signupId: "a",
        status: "CHECKED_IN",
        hoursWorked: null,
        hoursCredited: 4,
        startsAt: at("2026-08-15T21:00:00Z"),
        endsAt: at("2026-08-16T01:00:00Z"),
        checkedInAt: at("2026-08-16T01:00:00Z"),
      }),
    ];

    expect(computeTotals(rows, NOW)).toEqual({
      hoursThisYear: 4,
      shiftsThisYear: 1,
    });
  });

  it("counts a checked-in row with NO creditable hours as a shift worth 0 hours", () => {
    // `hoursCredited` is null for an ask-window row with no override — an ask
    // window can span months, so there is no duration to credit. Null must
    // mean "no hours to add", never "zero hours that still count".
    const rows = [
      row({
        signupId: "a",
        status: "CHECKED_IN",
        source: "ASK_WINDOW",
        eventId: null,
        eventSlug: null,
        askId: "ask-1",
        hoursWorked: null,
        hoursCredited: null,
        checkedInAt: at("2026-03-01T00:00:00Z"),
      }),
    ];

    expect(computeTotals(rows, NOW)).toEqual({
      hoursThisYear: 0,
      shiftsThisYear: 1,
    });
  });

  it("ignores hoursWorked entirely — hoursCredited is the only source", () => {
    // Guards the regression directly: a stale/odd `hoursWorked` must not leak
    // into the band now that the read model owns the fallback rule.
    const rows = [
      row({
        signupId: "a",
        status: "CHECKED_IN",
        hoursWorked: 99,
        hoursCredited: 2,
        checkedInAt: at("2026-03-01T00:00:00Z"),
      }),
    ];

    expect(computeTotals(rows, NOW).hoursThisYear).toBe(2);
  });

  it("reports zero when nothing was ever worked", () => {
    expect(
      computeTotals([row({ signupId: "a", status: "APPROVED" })], NOW),
    ).toEqual({ hoursThisYear: 0, shiftsThisYear: 0 });
  });

  it("reports zero shifts on 1 January for a volunteer whose history is all last year", () => {
    // The band gates on shiftsThisYear, so this is what stops a veteran of 18
    // hours across 5 shifts seeing "0 hours / 0 shifts" every new year: the
    // band must not render at all, rather than render zeros.
    // Local-time constructors, not UTC ISO: "this year" is the VIEWER's
    // calendar year, so a UTC midnight lands in the previous year on any
    // negative-offset machine — which is precisely the boundary under test.
    const newYear = new Date(2027, 0, 1, 9, 0, 0).getTime();
    const lastYear = [0, 1, 2, 3, 4].map((n) =>
      row({
        signupId: `s${n}`,
        status: "CHECKED_IN",
        hoursCredited: 3.6,
        checkedInAt: new Date(2026, n, 1, 12, 0, 0),
      }),
    );

    // Same rows, judged from within 2026: five shifts, 18 hours.
    expect(computeTotals(lastYear, NOW)).toEqual({
      hoursThisYear: 18,
      shiftsThisYear: 5,
    });
    // Judged from 1 Jan 2027: nothing yet — and shiftsThisYear === 0 is the
    // signal the page uses to hide the band entirely.
    expect(computeTotals(lastYear, newYear)).toEqual({
      hoursThisYear: 0,
      shiftsThisYear: 0,
    });
  });

  it("counts a shift checked in on 31 December against that year, not the next", () => {
    const newYearsEve = row({
      signupId: "nye",
      status: "CHECKED_IN",
      hoursCredited: 5,
      checkedInAt: new Date(2026, 11, 31, 23, 0, 0),
    });

    expect(
      computeTotals([newYearsEve], new Date(2026, 11, 31, 23, 30, 0).getTime()),
    ).toEqual({ hoursThisYear: 5, shiftsThisYear: 1 });
    expect(
      computeTotals([newYearsEve], new Date(2027, 0, 1, 0, 30, 0).getTime()),
    ).toEqual({ hoursThisYear: 0, shiftsThisYear: 0 });
  });

  it("falls back to the shift start when checkedInAt is missing", () => {
    const rows = [
      row({
        signupId: "a",
        status: "CHECKED_IN",
        hoursCredited: 3,
        checkedInAt: null,
        startsAt: at("2026-02-02T00:00:00Z"),
      }),
    ];

    expect(computeTotals(rows, NOW).shiftsThisYear).toBe(1);
  });
});

describe("formatWindow", () => {
  const fmt = (
    value: Date | number | string,
    opts?: Intl.DateTimeFormatOptions,
  ) => new Intl.DateTimeFormat("en-US", opts).format(new Date(value));

  it("renders the venue's local time with its zone, not the viewer's", () => {
    const out = formatWindow(
      fmt,
      at("2026-08-14T23:00:00Z"),
      at("2026-08-15T03:00:00Z"),
      "America/Chicago",
    );

    // 23:00Z is 18:00 CDT.
    expect(out).toContain("6:00");
    expect(out).toContain("10:00");
    expect(out).toContain("CDT");
  });

  it("survives an unusable timezone string instead of throwing", () => {
    expect(() =>
      formatWindow(fmt, at("2026-08-14T23:00:00Z"), null, "Not/AZone"),
    ).not.toThrow();
    expect(
      formatWindow(fmt, at("2026-08-14T23:00:00Z"), null, "Not/AZone"),
    ).toBeTruthy();
  });

  it("returns null for a windowless commitment", () => {
    expect(formatWindow(fmt, null, null, "America/Chicago")).toBeNull();
  });

  it("returns null for an unparseable date instead of throwing", () => {
    expect(formatWindow(fmt, "not-a-date", null, null)).toBeNull();
  });
});

describe("formatDayLine / formatDateBlock", () => {
  const fmt = (
    value: Date | number | string,
    opts?: Intl.DateTimeFormatOptions,
  ) => new Intl.DateTimeFormat("en-US", opts).format(new Date(value));

  it("renders the venue's local day, not the viewer's", () => {
    // 03:00Z on the 15th is still the 14th in Chicago.
    expect(
      formatDayLine(fmt, at("2026-08-15T03:00:00Z"), "America/Chicago"),
    ).toContain("14");
    expect(formatDayLine(fmt, at("2026-08-15T03:00:00Z"), null)).toBeTruthy();
  });

  it("splits the date block into weekday / day / month in the venue's zone", () => {
    expect(
      formatDateBlock(fmt, at("2026-08-15T03:00:00Z"), "America/Chicago"),
    ).toEqual({ weekday: "Fri", day: "14", month: "Aug" });
  });

  it("both return null on an unparseable date rather than throwing", () => {
    // `Intl.DateTimeFormat#format` throws RangeError on an Invalid Date, and
    // safeFormat's try/catch only wraps the ZONED attempt.
    expect(() => formatDayLine(fmt, "not-a-date", null)).not.toThrow();
    expect(formatDayLine(fmt, "not-a-date", null)).toBeNull();
    expect(() =>
      formatDateBlock(fmt, "not-a-date", "America/Chicago"),
    ).not.toThrow();
    expect(formatDateBlock(fmt, "not-a-date", "America/Chicago")).toBeNull();
  });

  it("falls back to the viewer's zone on an unusable timezone", () => {
    expect(
      formatDayLine(fmt, at("2026-08-15T12:00:00Z"), "Not/AZone"),
    ).toBeTruthy();
    expect(
      formatDateBlock(fmt, at("2026-08-15T12:00:00Z"), "Not/AZone"),
    ).not.toBeNull();
  });
});

describe("isOpenEndedCommitment", () => {
  const askRow = (over: Partial<Commitment>) =>
    row({
      signupId: "ask",
      source: "ASK_WINDOW",
      // Endless by default here; the ONE_TIME case is asserted separately.
      cadence: "ONGOING",
      eventId: null,
      eventSlug: null,
      eventTimezone: null,
      askId: "ask-1",
      ...over,
    });

  it("is false for a ONE_TIME ask — it is not 'still going'", () => {
    // Blanking the date would hide the only "when" the row has. Cadence is
    // what tells an endless ask from a one-off with an unfilled end.
    expect(
      isOpenEndedCommitment(
        askRow({
          cadence: "ONE_TIME",
          startsAt: at("2026-01-01T00:00:00Z"),
          endsAt: null,
        }),
        NOW,
      ),
    ).toBe(false);
  });

  it("is true for an ask with a past start and no end", () => {
    expect(
      isOpenEndedCommitment(
        askRow({ startsAt: at("2026-01-01T00:00:00Z"), endsAt: null }),
        NOW,
      ),
    ).toBe(true);
  });

  it("is false for an ask starting in the future — 'from 1 Sep' is useful", () => {
    expect(
      isOpenEndedCommitment(
        askRow({ startsAt: at("2026-09-01T00:00:00Z"), endsAt: null }),
        NOW,
      ),
    ).toBe(false);
  });

  it("is false once the ask has an end date", () => {
    expect(
      isOpenEndedCommitment(
        askRow({
          startsAt: at("2026-01-01T00:00:00Z"),
          endsAt: at("2026-12-01T00:00:00Z"),
        }),
        NOW,
      ),
    ).toBe(false);
  });

  it("is false for event shifts, whatever their window", () => {
    expect(
      isOpenEndedCommitment(
        row({
          signupId: "shift",
          source: "EVENT_SHIFT",
          startsAt: at("2026-01-01T00:00:00Z"),
          endsAt: null,
        }),
        NOW,
      ),
    ).toBe(false);
  });

  it("is false for a fully windowless ask (nothing to suppress)", () => {
    expect(
      isOpenEndedCommitment(askRow({ startsAt: null, endsAt: null }), NOW),
    ).toBe(false);
  });
});

describe("commitmentHref", () => {
  it("prefers the event slug", () => {
    expect(commitmentHref(row({ signupId: "a" }))).toBe(
      "/events/nashville-punk-fest",
    );
  });

  it("falls back to the public ask page", () => {
    expect(
      commitmentHref(
        row({ signupId: "a", eventSlug: null, eventId: null, askId: "ask_9" }),
      ),
    ).toBe("/v/ask_9");
  });

  it("never links a paused ask row to its /v/ page, which 404s", () => {
    expect(
      commitmentHref(
        row({
          signupId: "a",
          eventSlug: null,
          eventId: null,
          askId: "ask_9",
          signupsPaused: true,
        }),
      ),
    ).toBeNull();
  });

  it("never links a paused event row to its event page, which 404s", () => {
    expect(
      commitmentHref(row({ signupId: "a", signupsPaused: true })),
    ).toBeNull();
  });

  it("returns null when nothing is addressable", () => {
    expect(
      commitmentHref(
        row({ signupId: "a", eventSlug: null, eventId: null, askId: null }),
      ),
    ).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Statement selection — the rows the printable hours statement may assert.
//
// These are correctness tests, not formatting ones. The document goes to a
// school registrar or a court officer, so what it is allowed to claim is the
// feature.
// ─────────────────────────────────────────────────────────────────────────────

describe("selectStatementShifts", () => {
  it("admits ONLY checked-in shifts — a scheduled shift is not a worked shift", () => {
    const shifts = selectStatementShifts([
      row({ signupId: "checked", status: "CHECKED_IN", hoursCredited: 4 }),
      row({ signupId: "approved", status: "APPROVED", hoursCredited: 4 }),
      row({ signupId: "pending", status: "PENDING", hoursCredited: 4 }),
      row({ signupId: "noshow", status: "NO_SHOW", hoursCredited: 4 }),
      row({ signupId: "rejected", status: "REJECTED", hoursCredited: 4 }),
      row({ signupId: "withdrawn", status: "WITHDRAWN", hoursCredited: 4 }),
    ]);

    expect(shifts.map((s) => s.row.signupId)).toEqual(["checked"]);
  });

  it("orders oldest first — a record reads forwards, unlike the history list", () => {
    const shifts = selectStatementShifts([
      row({
        signupId: "aug",
        status: "CHECKED_IN",
        checkedInAt: at("2026-08-01T00:00:00Z"),
      }),
      row({
        signupId: "jan",
        status: "CHECKED_IN",
        checkedInAt: at("2026-01-05T00:00:00Z"),
      }),
      row({
        signupId: "may",
        status: "CHECKED_IN",
        checkedInAt: at("2026-05-09T00:00:00Z"),
      }),
    ]);

    expect(shifts.map((s) => s.row.signupId)).toEqual(["jan", "may", "aug"]);
  });

  it("keeps a shift with no creditable hours, and reports its hours as null — NOT zero", () => {
    // An ask-window row with no override has no scheduled shift length to
    // convert. It happened, so it prints; it just contributes no hours. If this
    // ever came back as 0 the sheet would silently assert a zero-hour shift.
    const shifts = selectStatementShifts([
      row({
        signupId: "ask",
        status: "CHECKED_IN",
        source: "ASK_WINDOW",
        hoursCredited: null,
      }),
    ]);

    expect(shifts).toHaveLength(1);
    expect(shifts[0]!.hours).toBeNull();
  });

  it("does not mutate the input array", () => {
    const rows = [
      row({
        signupId: "b",
        status: "CHECKED_IN",
        checkedInAt: at("2026-08-01T00:00:00Z"),
      }),
      row({
        signupId: "a",
        status: "CHECKED_IN",
        checkedInAt: at("2026-01-01T00:00:00Z"),
      }),
    ];

    selectStatementShifts(rows);

    expect(rows.map((r) => r.signupId)).toEqual(["b", "a"]);
  });
});

describe("hasStatementShifts", () => {
  it("is false when nothing was ever checked in — never offer an empty document", () => {
    expect(
      hasStatementShifts([
        row({ signupId: "a", status: "APPROVED" }),
        row({ signupId: "b", status: "PENDING" }),
      ]),
    ).toBe(false);
  });

  it("is true for a veteran whose only checked-in shift is from a past year", () => {
    // The gate the ENTRY POINT uses. Tying it to the this-year figures would
    // hide a school-service letter from exactly the volunteer who needs one.
    expect(
      hasStatementShifts([
        row({
          signupId: "a",
          status: "CHECKED_IN",
          checkedInAt: at("2024-03-02T00:00:00Z"),
          hoursCredited: 6,
        }),
      ]),
    ).toBe(true);
  });
});

describe("sumCreditedHours — the one summation both surfaces use", () => {
  it("skips null hours rather than counting them as zero", () => {
    expect(
      sumCreditedHours([
        row({ signupId: "a", status: "CHECKED_IN", hoursCredited: 2.5 }),
        row({ signupId: "b", status: "CHECKED_IN", hoursCredited: null }),
        row({ signupId: "c", status: "CHECKED_IN", hoursCredited: 1.2 }),
      ]),
    ).toBe(3.7);
  });

  it("guards float drift from summing decimals", () => {
    expect(
      sumCreditedHours([
        row({ signupId: "a", status: "CHECKED_IN", hoursCredited: 0.1 }),
        row({ signupId: "b", status: "CHECKED_IN", hoursCredited: 0.2 }),
      ]),
    ).toBe(0.3);
  });

  it("agrees with the totals band when handed the same period", () => {
    // THE reconciliation invariant. Two numbers about the same volunteer
    // disagreeing is the failure mode this feature exists to prevent, so the
    // page's band and the printed statement are wired to one summation. This
    // test is what breaks if someone re-implements either of them.
    const rows = [
      row({
        signupId: "a",
        status: "CHECKED_IN",
        checkedInAt: at("2026-02-01T00:00:00Z"),
        hoursCredited: 4,
      }),
      row({
        signupId: "b",
        status: "CHECKED_IN",
        checkedInAt: at("2026-06-01T00:00:00Z"),
        hoursCredited: 2.5,
      }),
      // No hours: counts as a shift on both surfaces, adds hours to neither.
      row({
        signupId: "c",
        status: "CHECKED_IN",
        source: "ASK_WINDOW",
        checkedInAt: at("2026-07-01T00:00:00Z"),
        hoursCredited: null,
      }),
      // Not checked in: on neither surface.
      row({ signupId: "d", status: "APPROVED", hoursCredited: 99 }),
    ];

    const band = computeTotals(rows, NOW);
    const statement = selectStatementShifts(rows);

    expect(sumCreditedHours(statement.map((s) => s.row))).toBe(
      band.hoursThisYear,
    );
    expect(statement).toHaveLength(band.shiftsThisYear);
  });
});

describe("commitmentRowKey — row identity", () => {
  const occurrence = (signupId: string, claimId: string) =>
    row({
      signupId,
      claimId,
      occurrenceId: `occ-${claimId}`,
      source: "ASK_WINDOW",
      cadence: "RECURRING",
      status: "CHECKED_IN",
      eventId: null,
      eventSlug: null,
      eventTimezone: null,
      askId: "ask-standing",
    });

  it("is the CLAIM on an occurrence row, so one signup's dates stay distinct", () => {
    // A standing volunteer's parent signup emits one row per claimed date, so
    // `signupId` repeats. Keying a list on it drops the repeats — an
    // undercount for the weekly regulars with the most hours.
    const rows = [
      occurrence("standing-1", "claim-a"),
      occurrence("standing-1", "claim-b"),
      occurrence("standing-1", "claim-c"),
    ];

    const keys = rows.map(commitmentRowKey);

    expect(keys).toEqual(["claim-a", "claim-b", "claim-c"]);
    expect(new Set(keys).size).toBe(rows.length);
  });

  it("falls back to the signup on an ordinary row", () => {
    expect(commitmentRowKey(row({ signupId: "plain" }))).toBe("plain");
  });

  it("counts each claimed date as its own shift in the totals", () => {
    const rows = [
      {
        ...occurrence("standing-1", "claim-a"),
        hoursCredited: 3,
        checkedInAt: at("2026-01-08T23:00:00Z"),
      },
      {
        ...occurrence("standing-1", "claim-b"),
        hoursCredited: 3,
        checkedInAt: at("2026-01-15T23:00:00Z"),
      },
      {
        ...occurrence("standing-1", "claim-c"),
        hoursCredited: 3.5,
        checkedInAt: at("2026-01-22T23:00:00Z"),
      },
    ] as Commitment[];

    const totals = computeTotals(rows, NOW);

    expect(totals.shiftsThisYear).toBe(3);
    expect(totals.hoursThisYear).toBe(9.5);
    expect(selectStatementShifts(rows)).toHaveLength(3);
  });

  it("keeps a claimed-but-not-worked date off both surfaces", () => {
    // The read model downgrades a parent CHECKED_IN to APPROVED on any claim
    // without its own check-in, so a future Thursday can't be billed as worked.
    const rows = [
      {
        ...occurrence("standing-1", "worked"),
        hoursCredited: 3,
        checkedInAt: at("2026-01-08T23:00:00Z"),
      },
      {
        ...occurrence("standing-1", "future"),
        status: "APPROVED",
        hoursCredited: 3,
        checkedInAt: null,
      },
    ] as Commitment[];

    expect(computeTotals(rows, NOW).shiftsThisYear).toBe(1);
    expect(selectStatementShifts(rows).map((s) => s.row.claimId)).toEqual([
      "worked",
    ]);
  });
});

describe("isOccurrenceRow", () => {
  it("discriminates on occurrenceId, never on source", () => {
    // `source` stays "ASK_WINDOW" for occurrence rows on purpose — widening
    // that union would break every exhaustive switch written against it.
    const occ = row({
      signupId: "s",
      source: "ASK_WINDOW",
      claimId: "c",
      occurrenceId: "o",
    });
    const askWindow = row({ signupId: "s2", source: "ASK_WINDOW" });

    expect(isOccurrenceRow(occ)).toBe(true);
    expect(isOccurrenceRow(askWindow)).toBe(false);
    expect(isOccurrenceRow(row({ signupId: "s3" }))).toBe(false);
  });
});

describe("commitmentSmsLabelKey", () => {
  it("words each server anchor", () => {
    expect(commitmentSmsLabelKey(row({ signupId: "a", reminderAnchor: "SHIFT" }))).toBe(
      "eventDetail.volunteerSmsToggleLabel",
    );
    expect(
      commitmentSmsLabelKey(row({ signupId: "a", reminderAnchor: "EVENT_START" })),
    ).toBe("eventDetail.volunteerSmsToggleLabelEventStart");
    expect(
      commitmentSmsLabelKey(
        row({
          signupId: "a",
          reminderAnchor: "ASK_START",
          source: "ASK_WINDOW",
          eventId: null,
        }),
      ),
    ).toBe("myVolunteering.smsToggleLabelAsk");
  });

  it("a null anchor takes the event page's label for event rows, the ask label for ask rows", () => {
    // A role-level signup on a role with shifts: revoke-only, shift wording.
    expect(
      commitmentSmsLabelKey(row({ signupId: "a", reminderAnchor: null })),
    ).toBe("eventDetail.volunteerSmsToggleLabel");
    expect(
      commitmentSmsLabelKey(
        row({ signupId: "a", reminderAnchor: null, eventId: null, askId: "k" }),
      ),
    ).toBe("myVolunteering.smsToggleLabelAsk");
  });

  it("an occurrence row, even a signup's first live row, takes the ask label", () => {
    expect(
      commitmentSmsLabelKey(
        row({
          signupId: "a",
          reminderAnchor: "ASK_START",
          occurrenceId: "occ_1",
          claimId: "c_1",
          eventId: null,
          askId: "k",
          source: "ASK_WINDOW",
        }),
      ),
    ).toBe("myVolunteering.smsToggleLabelAsk");
  });
});
