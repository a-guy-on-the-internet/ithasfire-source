import { RECURRENCE_MAX_OCCURRENCES } from "@th/types/repos/event-dates";
import { describe, expect, it } from "vitest";

import {
  desiredOccurrences,
  droppedRsvpSummary,
  materialisationHorizon,
  normaliseAnchor,
  prefillFromStoredRule,
  reconcileDiff,
  scheduleToApply,
  type StoredDate,
} from "../schedule-reconcile";

/**
 * The reconciliation preview behind the consequence band on
 * `/moderate/listings/[eventId]/schedule`.
 *
 * The fixture is NOT invented: it is the 52 upcoming rows the dev API returns
 * for the seeded weekly open mic (`e90f26c7-…`, `FREQ=WEEKLY;BYDAY=WE`,
 * America/Chicago, 8:00 PM local), pasted verbatim. That matters twice over —
 * it pins the DST fold (the 01:00Z rows become 02:00Z from Nov 2026 to Mar
 * 2027, because the wall clock stays 8:00 PM), and it means "an unchanged
 * rule drops nothing" is asserted against instants a real expansion produced
 * rather than against instants this module generated itself.
 */
const SEEDED_WEDNESDAYS = [
  "2026-09-17T01:00:00.000Z",
  "2026-09-24T01:00:00.000Z",
  "2026-10-01T01:00:00.000Z",
  "2026-10-08T01:00:00.000Z",
  "2026-10-15T01:00:00.000Z",
  "2026-10-22T01:00:00.000Z",
  "2026-10-29T01:00:00.000Z",
  "2026-11-05T02:00:00.000Z",
  "2026-11-12T02:00:00.000Z",
  "2026-11-19T02:00:00.000Z",
  "2026-11-26T02:00:00.000Z",
  "2026-12-03T02:00:00.000Z",
  "2026-12-10T02:00:00.000Z",
  "2026-12-17T02:00:00.000Z",
  "2026-12-24T02:00:00.000Z",
  "2026-12-31T02:00:00.000Z",
  "2027-01-07T02:00:00.000Z",
  "2027-01-14T02:00:00.000Z",
  "2027-01-21T02:00:00.000Z",
  "2027-01-28T02:00:00.000Z",
  "2027-02-04T02:00:00.000Z",
  "2027-02-11T02:00:00.000Z",
  "2027-02-18T02:00:00.000Z",
  "2027-02-25T02:00:00.000Z",
  "2027-03-04T02:00:00.000Z",
  "2027-03-11T02:00:00.000Z",
  "2027-03-18T01:00:00.000Z",
  "2027-03-25T01:00:00.000Z",
  "2027-04-01T01:00:00.000Z",
  "2027-04-08T01:00:00.000Z",
  "2027-04-15T01:00:00.000Z",
  "2027-04-22T01:00:00.000Z",
  "2027-04-29T01:00:00.000Z",
  "2027-05-06T01:00:00.000Z",
  "2027-05-13T01:00:00.000Z",
  "2027-05-20T01:00:00.000Z",
  "2027-05-27T01:00:00.000Z",
  "2027-06-03T01:00:00.000Z",
  "2027-06-10T01:00:00.000Z",
  "2027-06-17T01:00:00.000Z",
  "2027-06-24T01:00:00.000Z",
  "2027-07-01T01:00:00.000Z",
  "2027-07-08T01:00:00.000Z",
  "2027-07-15T01:00:00.000Z",
  "2027-07-22T01:00:00.000Z",
  "2027-07-29T01:00:00.000Z",
  "2027-08-05T01:00:00.000Z",
  "2027-08-12T01:00:00.000Z",
  "2027-08-19T01:00:00.000Z",
  "2027-08-26T01:00:00.000Z",
  "2027-09-02T01:00:00.000Z",
  "2027-09-09T01:00:00.000Z",
] as const;

const TIMEZONE = "America/Chicago";
/** Fixed so the 12-month horizon is a constant, not "whenever the suite ran". */
const NOW = new Date("2026-09-15T18:00:00.000Z");
const DTSTART = SEEDED_WEDNESDAYS[0];

const rows = (
  overrides: Partial<Record<number, StoredDate["status"]>> = {},
): StoredDate[] =>
  SEEDED_WEDNESDAYS.map((iso, index) => ({
    eventDateId: `date-${index}`,
    startsAtMs: new Date(iso).getTime(),
    status: overrides[index] ?? "SCHEDULED",
  }));

const diffFor = (
  rrule: string,
  opts: { dates?: StoredDate[]; partial?: boolean; until?: string } = {},
) =>
  reconcileDiff(
    { rrule, dtstart: DTSTART, ...(opts.until ? { until: opts.until } : {}) },
    {
      dates: opts.dates ?? rows(),
      now: NOW,
      timezone: TIMEZONE,
      partial: opts.partial ?? false,
    },
  );

describe("materialisationHorizon", () => {
  it("is twelve calendar months out", () => {
    expect(materialisationHorizon(NOW).toISOString()).toBe(
      "2027-09-15T18:00:00.000Z",
    );
  });
});

describe("desiredOccurrences", () => {
  it("reproduces the SERVER's expansion of the live rule, DST fold included", () => {
    const desired = desiredOccurrences(
      { rrule: "FREQ=WEEKLY;BYDAY=WE", dtstart: DTSTART },
      { now: NOW, timezone: TIMEZONE },
    );
    expect(desired.map((d) => d.toISOString())).toEqual([
      ...SEEDED_WEDNESDAYS,
    ]);
  });

  it("never returns more than the write path materialises in one pass", () => {
    const desired = desiredOccurrences(
      { rrule: "FREQ=DAILY", dtstart: DTSTART },
      { now: NOW, timezone: TIMEZONE },
    );
    // A daily rule has ~365 occurrences inside the window; the cap bites first.
    expect(desired).toHaveLength(RECURRENCE_MAX_OCCURRENCES);
  });
});

describe("reconcileDiff", () => {
  it("a COUNT-bounded rule, prefilled as stored, drops nothing and adds nothing", () => {
    // `FREQ=WEEKLY;BYDAY=WE;COUNT=20` with its twenty rows in hand. The old
    // prefill rebuilt this from the read-side SUMMARY, which drops COUNT, so
    // the editor opened on an OPEN-ENDED weekly rule: nothing dropped (a
    // superset drops nothing) and 32 dates "added" — a widening the band's
    // headline number could not see. With the stored rule handed over
    // verbatim there is nothing to misread.
    const diff = diffFor("FREQ=WEEKLY;BYDAY=WE;COUNT=20", {
      dates: rows().slice(0, 20),
    });
    expect(diff.droppedCount).toBe(0);
    expect(diff.addedCount).toBe(0);
    expect(diff.keptCount).toBe(20);
  });

  it("drops nothing and adds nothing when the rule is unchanged", () => {
    const diff = diffFor("FREQ=WEEKLY;BYDAY=WE");
    expect(diff.droppedCount).toBe(0);
    expect(diff.addedCount).toBe(0);
    expect(diff.keptCount).toBe(52);
    expect(diff.scheduledCount).toBe(52);
    expect(diff.producesNothing).toBe(false);
  });

  it("halves the schedule when weekly becomes every other week", () => {
    const diff = diffFor("FREQ=WEEKLY;INTERVAL=2;BYDAY=WE");
    // Every second Wednesday survives; the other 26 come off. Nothing is
    // added — the surviving instants already have rows.
    expect(diff.keptCount).toBe(26);
    expect(diff.droppedCount).toBe(26);
    expect(diff.addedCount).toBe(0);
    // The dropped set is the alternating rows, not an arbitrary 26.
    expect(diff.droppedIds.has("date-1")).toBe(true);
    expect(diff.droppedIds.has("date-0")).toBe(false);
  });

  it("counts a move to a different weekday as a full replacement", () => {
    const diff = diffFor("FREQ=WEEKLY;BYDAY=TH");
    expect(diff.droppedCount).toBe(52);
    expect(diff.keptCount).toBe(0);
    // No Thursday coincides with a Wednesday row, so every desired instant
    // is an insert — bounded by the one-pass cap.
    expect(diff.addedCount).toBeGreaterThan(0);
    expect(diff.addedCount).toBeLessThanOrEqual(RECURRENCE_MAX_OCCURRENCES);
  });

  /**
   * THE REGRESSION. This assertion used to read `droppedCount === 0`, with a
   * comment that correctly described the 60-date cap stopping the expansion
   * around 30 Wednesdays in — and then concluded nothing was lost. The server
   * loses every Wednesday past that point: they are future, SCHEDULED, and
   * not in the ≤60 desired instants, so `bulkReplaceForEvent` cancels the ones
   * carrying RSVPs (permanently — a desired instant coinciding with a
   * cancelled row is skipped forever after) and hard-deletes the rest.
   *
   * Adding a weekday is the single most ordinary edit this page exists to
   * make, and it was the one the band called free.
   */
  it("counts the Wednesdays the one-pass cap strands when a weekday is ADDED", () => {
    const diff = diffFor("FREQ=WEEKLY;BYDAY=WE,FR");

    // Interleaved, the 60-date pass holds 30 Wednesdays and 30 Fridays and
    // ends ~5 months earlier than the 52 Wednesdays already on the schedule.
    expect(diff.capReached).toBe(true);
    expect(diff.keptCount).toBe(30);
    expect(diff.droppedCount).toBe(22);

    // …and every one of those 22 is a date the new rule STILL WANTS. That is
    // a different sentence from "the rule no longer produces this", and the
    // band says it separately.
    expect(diff.droppedBeyondHorizonCount).toBe(22);
    expect(diff.addedCount).toBe(30);
  });

  it("separates 'the rule dropped it' from 'the pass could not reach it'", () => {
    // Moving the night to Thursday drops all 52 Wednesdays, and NONE of them
    // is a horizon casualty — the rule genuinely stopped producing them.
    const moved = diffFor("FREQ=WEEKLY;BYDAY=TH");
    expect(moved.droppedCount).toBe(52);
    expect(moved.droppedBeyondHorizonCount).toBe(0);

    // Unchanged rule: no cap pressure at all.
    const same = diffFor("FREQ=WEEKLY;BYDAY=WE");
    expect(same.capReached).toBe(false);
    expect(same.droppedBeyondHorizonCount).toBe(0);
  });

  it("leaves a CANCELLED row out of the drop count and lets it block an insert", () => {
    // Row 3 is already called off. The rule still produces its instant.
    const diff = diffFor("FREQ=WEEKLY;BYDAY=WE", {
      dates: rows({ 3: "CANCELLED" }),
    });
    expect(diff.scheduledCount).toBe(51);
    expect(diff.droppedCount).toBe(0);
    // `bulkReplaceForEvent` SKIPS a desired date that coincides with a
    // cancelled row — a night a moderator called off stays off — so this is
    // not an addition either.
    expect(diff.addedCount).toBe(0);
  });

  it("reports a capped read so the drop count is presented as a floor", () => {
    expect(diffFor("FREQ=WEEKLY;BYDAY=TH", { partial: true }).partial).toBe(
      true,
    );
  });

  it("flags a rule that would materialise nothing, which the server refuses", () => {
    const diff = diffFor("FREQ=WEEKLY;BYDAY=WE", {
      // An UNTIL before the first occurrence yields an empty expansion, which
      // the use case answers with RECURRENCE_HAS_NO_UPCOMING_DATES.
      until: "2026-09-16T01:00:00.000Z",
    });
    expect(diff.producesNothing).toBe(true);
  });

  it("survives an unparseable rule instead of throwing inside a render", () => {
    const diff = diffFor("FREQ=NONSENSE");
    expect(diff.producesNothing).toBe(true);
    expect(diff.droppedCount).toBe(52);
  });
});

describe("normaliseAnchor", () => {
  // The builder derives its own dtstart by the same round trip, and rewrites
  // a loaded config whose dtstart disagrees with it. So the page's anchor has
  // to be a FIXED POINT of that round trip — including on the two wall-clock
  // instants where zone arithmetic is most likely to move a value.
  it.each([
    ["an ordinary Wednesday night", "2026-09-24T01:00:00.000Z"],
    // 2026-03-08 02:30 does not exist in Chicago (spring forward).
    ["a spring-forward gap", "2026-03-08T08:30:00.000Z"],
    // 2026-11-01 01:30 happens twice in Chicago (fall back); the earlier
    // offset wins, which is 06:30Z.
    ["a fall-back fold", "2026-11-01T06:30:00.000Z"],
  ])("is a fixed point of the builder's round trip for %s", (_label, iso) => {
    const once = normaliseAnchor(iso, TIMEZONE);
    expect(normaliseAnchor(once, TIMEZONE)).toBe(once);
  });

  it("is the identity on a seconds-free instant", () => {
    expect(normaliseAnchor(DTSTART, TIMEZONE)).toBe(DTSTART);
  });
});

describe("prefillFromStoredRule", () => {
  const anchor = { anchorIso: DTSTART, timezone: TIMEZONE };

  it("seeds the live listing's rule verbatim, anchored at the next date", () => {
    expect(
      prefillFromStoredRule(
        { rrule: "FREQ=WEEKLY;BYDAY=WE", dtstart: DTSTART, until: null },
        anchor,
      ),
    ).toEqual({ rrule: "FREQ=WEEKLY;BYDAY=WE", dtstart: DTSTART });
  });

  it("keeps a monthly ordinal — the loss the summary-based prefill took", () => {
    // `FREQ=MONTHLY;BYDAY=WE;BYSETPOS=2` used to come back as every Wednesday
    // of every month: four times the nights, and a superset drops nothing, so
    // the band could not see it. Byte-identical now.
    expect(
      prefillFromStoredRule(
        {
          rrule: "FREQ=MONTHLY;BYDAY=WE;BYSETPOS=2",
          // Aug 12 2026, the second Wednesday of August …
          dtstart: "2026-08-13T01:00:00.000Z",
          until: null,
        },
        // … carried to Sep 9, the second Wednesday of September.
        { anchorIso: "2026-09-10T01:00:00.000Z", timezone: TIMEZONE },
      )?.rrule,
    ).toBe("FREQ=MONTHLY;BYDAY=WE;BYSETPOS=2");
  });

  it("refuses an anchor that is not one of the rule's own occurrences", () => {
    // A listing with nothing upcoming is pinned to `now` — a Thursday
    // afternoon. Carrying a Wednesday-night rule there would seed a rule the
    // builder reads as Custom with the wrong day pinned, previewing a year of
    // Wednesdays at 2:37 PM under a caption that says applying it changes
    // nothing. Nothing is seeded; the editor opens on its own defaults.
    expect(
      prefillFromStoredRule(
        { rrule: "FREQ=WEEKLY;BYDAY=WE", dtstart: DTSTART, until: null },
        { anchorIso: "2026-09-17T19:37:00.000Z", timezone: TIMEZONE },
      ),
    ).toBeNull();
    // Same for a rule the anchor precedes: the first occurrence is still
    // ahead of the anchor, so the anchor is not one of them.
    expect(
      prefillFromStoredRule(
        { rrule: "FREQ=WEEKLY;BYDAY=WE", dtstart: DTSTART, until: null },
        { anchorIso: "2026-09-10T01:00:00.000Z", timezone: TIMEZONE },
      ),
    ).toBeNull();
  });

  it("reduces a COUNT under an UNTIL that bites first, without over-counting", () => {
    // COUNT=20 but UNTIL stops the run after its eighth night. Three are
    // behind the anchor, so 17 remain on the rule; the UNTIL still bounds it.
    expect(
      prefillFromStoredRule(
        {
          rrule: "FREQ=WEEKLY;BYDAY=WE;COUNT=20",
          dtstart: "2026-08-27T01:00:00.000Z",
          until: "2026-10-22T01:00:00.000Z",
        },
        anchor,
      ),
    ).toEqual({
      rrule: "FREQ=WEEKLY;BYDAY=WE;COUNT=17",
      dtstart: DTSTART,
      until: "2026-10-22T01:00:00.000Z",
    });
  });

  it("carries the schedule's UNTIL bound and its INTERVAL through", () => {
    expect(
      prefillFromStoredRule(
        {
          rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=WE",
          dtstart: DTSTART,
          until: "2027-01-01T06:00:00.000Z",
        },
        anchor,
      ),
    ).toEqual({
      rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=WE",
      dtstart: DTSTART,
      until: "2027-01-01T06:00:00.000Z",
    });
  });

  it("reduces a COUNT by the nights already behind the anchor, and only then", () => {
    // Stored three Wednesdays before the first upcoming row: 20 − 3 = 17, so
    // the seeded rule produces exactly the seventeen rows still ahead.
    const storedDtstart = "2026-08-27T01:00:00.000Z";
    const seeded = prefillFromStoredRule(
      { rrule: "FREQ=WEEKLY;BYDAY=WE;COUNT=20", dtstart: storedDtstart, until: null },
      anchor,
    );
    expect(seeded).toEqual({
      rrule: "FREQ=WEEKLY;BYDAY=WE;COUNT=17",
      dtstart: DTSTART,
    });
    const diff = reconcileDiff(seeded!, {
      dates: rows().slice(0, 17),
      now: NOW,
      timezone: TIMEZONE,
      partial: false,
    });
    expect(diff.droppedCount).toBe(0);
    expect(diff.addedCount).toBe(0);
    expect(diff.keptCount).toBe(17);
  });

  it("leaves a COUNT rule byte-identical when nothing is behind the anchor", () => {
    expect(
      prefillFromStoredRule(
        { rrule: "FREQ=WEEKLY;COUNT=20;BYDAY=WE", dtstart: DTSTART, until: null },
        anchor,
      )?.rrule,
    ).toBe("FREQ=WEEKLY;COUNT=20;BYDAY=WE");
  });

  it("counts an occurrence AT the anchor as upcoming even when the stored anchor carries seconds", () => {
    // An API caller stored 20:00:30; the browser's enumeration is
    // minute-precise, so the occurrence that IS the anchor would otherwise
    // read as thirty seconds in the past and be subtracted.
    expect(
      prefillFromStoredRule(
        {
          rrule: "FREQ=WEEKLY;BYDAY=WE;COUNT=5",
          dtstart: "2026-09-17T01:00:30.000Z",
          until: null,
        },
        { anchorIso: "2026-09-17T01:00:30.000Z", timezone: TIMEZONE },
      )?.rrule,
    ).toBe("FREQ=WEEKLY;BYDAY=WE;COUNT=5");
  });

  it("seeds nothing for a run whose COUNT is spent — there is no upcoming rule to edit", () => {
    expect(
      prefillFromStoredRule(
        {
          rrule: "FREQ=WEEKLY;BYDAY=WE;COUNT=3",
          dtstart: "2026-08-06T01:00:00.000Z",
          until: null,
        },
        anchor,
      ),
    ).toBeNull();
  });

  it("seeds nothing when there is no stored rule or the anchor is unreadable", () => {
    expect(prefillFromStoredRule(null, anchor)).toBeNull();
    expect(
      prefillFromStoredRule(
        { rrule: "FREQ=WEEKLY;BYDAY=WE", dtstart: "next wednesday", until: null },
        anchor,
      ),
    ).toBeNull();
    expect(
      prefillFromStoredRule(
        { rrule: "FREQ=WEEKLY;BYDAY=WE", dtstart: DTSTART, until: null },
        { anchorIso: "", timezone: TIMEZONE },
      ),
    ).toBeNull();
  });
});

describe("scheduleToApply", () => {
  const stored = {
    rrule: "FREQ=WEEKLY;BYDAY=WE;COUNT=20",
    dtstart: "2026-08-27T01:00:00.000Z",
    until: null,
  };
  const seeded = prefillFromStoredRule(stored, {
    anchorIso: DTSTART,
    timezone: TIMEZONE,
  })!;

  it("writes the STORED rule, verbatim, for a candidate the moderator did not change", () => {
    // Not the re-anchored `COUNT=17` the editor was seeded with: the server
    // expands from `now` either way, and keeping the historic anchor is what
    // keeps a night called off before it from being orphaned if put back.
    expect(scheduleToApply(seeded, seeded, stored)).toEqual({
      kind: "RRULE",
      rrule: "FREQ=WEEKLY;BYDAY=WE;COUNT=20",
      dtstart: "2026-08-27T01:00:00.000Z",
    });
  });

  it("still writes the stored rule after a touch-and-revert, which the builder re-emits with a separate count", () => {
    // Flip to biweekly and back: the builder emits `{ …, count: 17 }` beside
    // the same rule string. Same rule, so still the stored one.
    const reverted = {
      rrule: "FREQ=WEEKLY;BYDAY=WE;COUNT=17",
      dtstart: DTSTART,
      count: 17,
    };
    expect(scheduleToApply(reverted, seeded, stored).dtstart).toBe(
      "2026-08-27T01:00:00.000Z",
    );
  });

  it("writes a changed candidate as composed, anchored at the next date", () => {
    const composed = { rrule: "FREQ=WEEKLY;BYDAY=WE;COUNT=12", dtstart: DTSTART };
    expect(scheduleToApply(composed, seeded, stored)).toEqual({
      kind: "RRULE",
      rrule: "FREQ=WEEKLY;BYDAY=WE;COUNT=12",
      dtstart: DTSTART,
    });
  });

  it("writes the candidate when the editor opened on defaults", () => {
    const composed = {
      rrule: "FREQ=WEEKLY;BYDAY=WE",
      dtstart: DTSTART,
      until: "2027-01-01T06:00:00.000Z",
    };
    expect(scheduleToApply(composed, null, stored)).toEqual({
      kind: "RRULE",
      rrule: "FREQ=WEEKLY;BYDAY=WE",
      dtstart: DTSTART,
      until: "2027-01-01T06:00:00.000Z",
    });
  });
});

describe("droppedRsvpSummary", () => {
  const dropped = { droppedIds: new Set(["date-1", "date-2", "date-3"]) };

  it("counts the DATES among the drops that carry RSVPs — never people", () => {
    expect(
      droppedRsvpSummary(dropped, [
        { eventDateId: "date-0", hasRsvp: true }, // kept: not counted
        { eventDateId: "date-1", hasRsvp: true },
        { eventDateId: "date-2", hasRsvp: false },
        { eventDateId: "date-3", hasRsvp: true },
      ]),
    ).toEqual({ known: true, count: 2 });
  });

  it("is honest about a read that did not carry the flag", () => {
    expect(
      droppedRsvpSummary(dropped, [
        { eventDateId: "date-1", hasRsvp: true },
        { eventDateId: "date-2" },
        { eventDateId: "date-3", hasRsvp: false },
      ]),
    ).toEqual({ known: false, count: 0 });
  });

  it("knows a zero when nothing drops", () => {
    expect(
      droppedRsvpSummary({ droppedIds: new Set() }, [{ eventDateId: "date-1" }]),
    ).toEqual({ known: true, count: 0 });
  });
});
