// ─────────────────────────────────────────────────────────────────────────────
// /my-volunteering — pure helpers
//
// Bucketing, totals, and date formatting for the attendee commitments page.
// Kept free of React so the section rules (which are product decisions, not
// styling) can be unit-tested directly.
// ─────────────────────────────────────────────────────────────────────────────

import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@th/trpc";

/**
 * One commitment row, derived from the router output so the shape can never
 * silently drift from `volunteer.signups.listMyCommitments`.
 */
export type Commitment =
  inferRouterOutputs<AppRouter>["volunteer"]["signups"]["listMyCommitments"][number];

const toMs = (value: Date | string | null): number | null => {
  if (value == null) return null;
  const ms =
    value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
};

/**
 * Whether a row's missing `endsAt` means "genuinely open-ended" or merely
 * "nobody filled the end in".
 *
 * This used to be un-answerable. The commitment record carried no cadence, so
 * every `ASK_WINDOW` row with no end was treated as open — the safe direction
 * (showing a live commitment beats hiding one), and commented as an INTERIM
 * fix awaiting the standing/recurring phase. That phase has landed:
 * `VolunteerCommitmentRecord.cadence` now rides the record precisely so this
 * call can be made properly.
 *
 * The real rule:
 *  - ONGOING / RECURRING — a standing "we always need door help" ask is
 *    legitimately endless. Still open. Filing it under History would dim a
 *    live commitment and make it unreachable as "Next up".
 *  - ONE_TIME — a single ask whose `endsAt` was never filled in. It is NOT
 *    endless; its start is the best available end, same as an event shift.
 *    This is the case the old blanket carve-out got wrong, leaving a one-off
 *    from last March sitting in Confirmed forever.
 *  - null cadence — a row with no ask behind it at all (an event-shift signup
 *    the `askId` backfill never reached). Keep the conservative branch.
 */
const isEndlessByCadence = (row: Commitment): boolean =>
  row.cadence === "ONGOING" || row.cadence === "RECURRING";

/**
 * When a commitment is finished, in epoch ms, or null when it has no end.
 *
 * `endsAt` always wins — which is also why occurrence rows need no special
 * case here: an occurrence is a bounded dated slot and always carries both
 * bounds, so it never reaches the fallbacks below.
 *
 * With no end:
 *  - EVENT_SHIFT — the window is a real shift (or the event itself), so a
 *    start that has passed means the thing is over.
 *  - ASK_WINDOW — depends on the ask's cadence; see {@link isEndlessByCadence}.
 *    An endless ask has no end to compute. A ONE_TIME ask with an unfilled end
 *    falls through to its start, exactly like an event shift.
 */
const endOfWindowMs = (row: Commitment): number | null => {
  const ends = toMs(row.endsAt);
  if (ends !== null) return ends;
  if (row.source === "ASK_WINDOW" && isEndlessByCadence(row)) return null;
  return toMs(row.startsAt);
};

/**
 * True when a row's stored start can no longer be shown as a shift time: an
 * endless ask whose start has already passed ("began 1 Jan, still going").
 * Such rows render as windowless — a wrong "when" is worse than no "when".
 * A FUTURE-starting endless ask keeps its date: "from 1 Sep" is useful.
 *
 * Cadence-gated for the same reason as {@link endOfWindowMs}: a ONE_TIME ask
 * with an unfilled end is not "still going", so blanking its date would hide
 * the only "when" we have for it.
 */
export function isOpenEndedCommitment(row: Commitment, nowMs: number): boolean {
  if (row.source !== "ASK_WINDOW" || row.endsAt != null) return false;
  if (!isEndlessByCadence(row)) return false;
  const startMs = toMs(row.startsAt);
  return startMs !== null && startMs < nowMs;
}

export type CommitmentBuckets = {
  /** Nearest confirmed commitment with a future start, or null. */
  nextUp: Commitment | null;
  /** Remaining upcoming APPROVED rows (excludes `nextUp`). */
  confirmed: Commitment[];
  /** Upcoming PENDING rows — applications, never merged with `confirmed`. */
  awaiting: Commitment[];
  /** Everything finished, newest first. */
  history: Commitment[];
};

/**
 * Split commitments into the page's four sections.
 *
 * PENDING and APPROVED are kept in separate buckets on purpose: an
 * application is not a commitment, and interleaving them by date would
 * imply the volunteer is on a schedule they have not been accepted onto.
 *
 * A PENDING row whose window has already passed moves to History — it is no
 * longer something the volunteer can act on or turn up for.
 */
export function bucketCommitments(
  rows: readonly Commitment[],
  nowMs: number,
): CommitmentBuckets {
  const confirmed: Commitment[] = [];
  const awaiting: Commitment[] = [];
  const history: Commitment[] = [];

  for (const row of rows) {
    const endMs = endOfWindowMs(row);
    const isPast = endMs !== null && endMs < nowMs;

    switch (row.status) {
      case "APPROVED":
        (isPast ? history : confirmed).push(row);
        break;
      case "PENDING":
        (isPast ? history : awaiting).push(row);
        break;
      // Over regardless of the clock: rejected/withdrawn applications and
      // shifts already worked belong in History even with a future window.
      case "CHECKED_IN":
      case "REJECTED":
      case "WITHDRAWN":
      case "NO_SHOW":
        history.push(row);
        break;
      default: {
        // `VolunteerSignupStatus` is HAND-MIRRORED from the Prisma enum
        // (`packages/types/src/repos/volunteering.ts`) and nothing validates
        // the payload at runtime, so the DB can grow a seventh value before
        // this union does. The assignment below breaks the BUILD the moment
        // the union changes; the push keeps an unknown status VISIBLE at
        // runtime rather than silently dropping a row the header still counts.
        const unhandled: never = row.status;
        void unhandled;
        history.push(row);
      }
    }
  }

  // "Next up" is the soonest confirmed row that actually has a start time.
  // Windowless commitments (a standing ask with no dates) can't be "next" —
  // they have no when — so they stay in the Confirmed list.
  let nextUpIndex = -1;
  let nextUpStart = Number.POSITIVE_INFINITY;
  confirmed.forEach((row, index) => {
    const startMs = toMs(row.startsAt);
    if (startMs === null || startMs < nowMs) return;
    if (startMs < nextUpStart) {
      nextUpStart = startMs;
      nextUpIndex = index;
    }
  });

  const nextUp = nextUpIndex >= 0 ? confirmed[nextUpIndex]! : null;

  return {
    nextUp,
    confirmed:
      nextUpIndex >= 0
        ? confirmed.filter((_, i) => i !== nextUpIndex)
        : confirmed,
    awaiting,
    // Newest first: the most recent thing you did is the most interesting.
    history: [...history].sort(
      (a, b) =>
        (endOfWindowMs(b) ?? toMs(b.createdAt) ?? 0) -
        (endOfWindowMs(a) ?? toMs(a.createdAt) ?? 0),
    ),
  };
}

/**
 * The row's creditable hours as a usable number, or null when there are none
 * to show. Single reader of `hoursCredited` so the totals band and the
 * per-row "N hours logged" line can never disagree about a row.
 */
export function readCreditedHours(row: Commitment): number | null {
  const credited = row.hoursCredited;
  return typeof credited === "number" && Number.isFinite(credited)
    ? credited
    : null;
}

/**
 * ROW IDENTITY. `claimId ?? signupId`, never `signupId` alone.
 *
 * A standing volunteer commits to dated slots via `VolunteerOccurrenceClaim`,
 * and the read model emits ONE ROW PER CLAIMED OCCURRENCE — so one parent
 * signup repeats across every date they worked
 * (`VolunteerCommitmentRecord` in `@th/types`, which states this contract).
 * Keying a list on `signupId` therefore hands React duplicate keys and drops
 * or scrambles rows for exactly the volunteers with the most hours: the weekly
 * regulars. On a printed hours statement that is not a rendering glitch, it is
 * an undercount on a document someone is submitting to a registrar.
 *
 * Lives here, next to the data, so every surface reading this shape keys the
 * same way instead of each rediscovering it.
 */
export function commitmentRowKey(row: Commitment): string {
  return row.claimId ?? row.signupId;
}

/**
 * True for a row that is one dated, claimed occurrence of a standing ask
 * rather than a signup in its own right.
 *
 * `occurrenceId` is the discriminator — NOT `source`, which stays
 * `"EVENT_SHIFT" | "ASK_WINDOW"` for these rows on purpose (an occurrence row
 * genuinely is ask-path; widening the union would break every exhaustive
 * switch already written against it).
 */
export function isOccurrenceRow(row: Commitment): boolean {
  return row.occurrenceId !== null;
}

/**
 * The one status that means the work actually happened — a door scan sits
 * behind it. APPROVED is a schedule, not a record.
 *
 * Sound for occurrence rows without a special case: the read model reports a
 * claim as `CHECKED_IN` only when THAT claim has a `checkedInAt`, and
 * deliberately downgrades a parent signup's `CHECKED_IN` to `APPROVED` on
 * every un-checked-in claim — so a merely-claimed future Thursday can never be
 * billed as worked. Do not loosen this filter to "recover" those rows.
 *
 * Exported because the printable hours statement
 * (`/my-volunteering/hours/print`) must apply the SAME gate as the totals
 * band. A statement handed to a school registrar that counted APPROVED rows
 * would assert shifts nobody turned up for.
 */
export function isCreditableShift(row: Commitment): boolean {
  return row.status === "CHECKED_IN";
}

/**
 * When the work happened, in epoch ms: the check-in, else the shift start,
 * else the signup date. Null only if every one of those is unparseable.
 */
export function commitmentWorkedAtMs(row: Commitment): number | null {
  return toMs(row.checkedInAt) ?? toMs(row.startsAt) ?? toMs(row.createdAt);
}

/**
 * Sum of creditable hours across the given rows, guarded against float drift
 * from summing decimals (2.5 + 1.2 + …).
 *
 * The SINGLE summation in the app. The totals band and the printed hours
 * statement both call it, so the two figures cannot drift apart by arithmetic
 * — only by the row set they pass in, which each of them states out loud
 * (the band says "this year", the statement prints its period).
 *
 * Null `hoursCredited` contributes NOTHING and is not zero: an ask-window row
 * with no override has no shift length to convert. Such a row still counts as
 * a shift, so `rows.length` can legitimately exceed what this figure accounts
 * for — both surfaces have to say so rather than imply 0.0.
 */
export function sumCreditedHours(rows: readonly Commitment[]): number {
  let total = 0;
  for (const row of rows) {
    const credited = readCreditedHours(row);
    if (credited !== null) total += credited;
  }
  return Math.round(total * 100) / 100;
}

/**
 * Every shift that may appear on the printable hours statement, oldest first
 * — a record reads forwards in time, unlike the page's history list which
 * leads with the most recent thing you did.
 *
 * CHECKED_IN only. Rows keep their resolved `workedAtMs` so the caller
 * formats and derives the statement period from the same value the sort used.
 */
export type StatementShift = {
  row: Commitment;
  /** Resolved via {@link commitmentWorkedAtMs}; null when nothing parsed. */
  workedAtMs: number | null;
  /** `hoursCredited`, or null — never coerced to 0. */
  hours: number | null;
};

export function selectStatementShifts(
  rows: readonly Commitment[],
): StatementShift[] {
  return rows
    .filter(isCreditableShift)
    .map((row) => ({
      row,
      workedAtMs: commitmentWorkedAtMs(row),
      hours: readCreditedHours(row),
    }))
    .sort(
      (a, b) =>
        (a.workedAtMs ?? Number.POSITIVE_INFINITY) -
        (b.workedAtMs ?? Number.POSITIVE_INFINITY),
    );
}

/**
 * Whether the volunteer has anything a statement could truthfully assert.
 * Gates the entry point: never offer a document that would print empty.
 */
export function hasStatementShifts(rows: readonly Commitment[]): boolean {
  return rows.some(isCreditableShift);
}

export type VolunteerTotals = {
  /** Sum of `hoursCredited` across this year's checked-in rows. */
  hoursThisYear: number;
  /**
   * How many shifts those hours came from — and the ONLY gate on whether the
   * totals band renders. Gating on "has ever checked in" instead would show a
   * veteran of 18 hours across 5 shifts a band reading "0 hours this year /
   * 0 shifts this year" every 1 January, which reads like their history was
   * wiped. No number, no band (design-system v2 §S5).
   */
  shiftsThisYear: number;
};

/**
 * Totals from CHECKED_IN rows only — the only status that means the work
 * actually happened.
 *
 * "This year" is the viewer's local calendar year, keyed off when the work
 * happened (`checkedInAt`, falling back to the shift start, then the signup
 * date).
 *
 * Hours come from `hoursCredited`, NOT `hoursWorked`. The canonical rule —
 * "`hoursWorked` override when set, else the shift's scheduled duration"
 * (`packages/core/src/use-cases/volunteering/org-volunteer-hours.ts`) — is
 * already implemented twice in the adapter layer and is applied for us in the
 * read model. Re-deriving it here would be a third copy and would drift, and
 * reading the raw `hoursWorked` told a volunteer who worked a four-hour shift
 * that they had logged zero hours while the organiser's export said four.
 *
 * `hoursCredited` is deliberately null for ask-window rows with no override
 * (an ask window can span months). Null means "no hours to add" — NOT zero
 * hours that still count — so a checked-in row with null hours still counts
 * as a SHIFT while contributing nothing to the hours figure. The shift count
 * can therefore legitimately exceed what the hours figure accounts for.
 */
export function computeTotals(
  rows: readonly Commitment[],
  nowMs: number,
): VolunteerTotals {
  const currentYear = new Date(nowMs).getFullYear();

  const thisYear = rows.filter((row) => {
    if (!isCreditableShift(row)) return false;
    const whenMs = commitmentWorkedAtMs(row);
    return whenMs !== null && new Date(whenMs).getFullYear() === currentYear;
  });

  return {
    // Same summation the printed statement uses — see `sumCreditedHours`.
    hoursThisYear: sumCreditedHours(thisYear),
    shiftsThisYear: thisYear.length,
  };
}

// ── Date/time formatting ────────────────────────────────────────────────────

export type DateTimeFormatter = (
  value: Date | number | string,
  options?: Intl.DateTimeFormatOptions,
) => string;

/**
 * `Intl.DateTimeFormat` throws `RangeError` on an unknown IANA zone, and
 * `eventTimezone` is free-form data we did not mint. Retry without the zone
 * rather than take the whole page down over one bad row.
 */
function safeFormat(
  fmtDateTime: DateTimeFormatter,
  value: Date,
  options: Intl.DateTimeFormatOptions,
  timeZone: string | null,
): string {
  if (timeZone) {
    try {
      return fmtDateTime(value, { ...options, timeZone });
    } catch {
      /* fall through to the viewer's own zone */
    }
  }
  return fmtDateTime(value, options);
}

const asDate = (value: Date | string): Date =>
  value instanceof Date ? value : new Date(value);

/**
 * An unparseable date, or null when it can't be one.
 *
 * `Intl.DateTimeFormat#format` throws `RangeError` on an Invalid Date, and
 * `safeFormat`'s try/catch only wraps the ZONED attempt — the un-zoned
 * fallback call is uncaught. Every formatter below therefore screens the
 * input first, so the three of them fail the same way.
 */
const validDateOrNull = (value: Date | string): Date | null => {
  const date = asDate(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** "Thu, Aug 14" in the venue's zone when we know it; null if unparseable. */
export function formatDayLine(
  fmtDateTime: DateTimeFormatter,
  startsAt: Date | string,
  timeZone: string | null,
): string | null {
  const date = validDateOrNull(startsAt);
  if (!date) return null;
  return safeFormat(
    fmtDateTime,
    date,
    { weekday: "short", month: "short", day: "numeric" },
    timeZone,
  );
}

/**
 * "6:00 PM – 10:00 PM CDT" (or "6:00 PM CDT" with no end).
 *
 * The zone abbreviation is always shown when we know the venue's zone: a
 * volunteer reading this from another timezone has to be able to tell that
 * the time is the venue's, not theirs.
 */
export function formatWindow(
  fmtDateTime: DateTimeFormatter,
  startsAt: Date | string | null,
  endsAt: Date | string | null,
  timeZone: string | null,
): string | null {
  if (!startsAt) return null;
  const start = validDateOrNull(startsAt);
  if (!start) return null;

  const timeOpts: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
  };
  const endOpts: Intl.DateTimeFormatOptions = timeZone
    ? { ...timeOpts, timeZoneName: "short" }
    : timeOpts;

  const end = endsAt ? validDateOrNull(endsAt) : null;
  if (!end) {
    return safeFormat(fmtDateTime, start, endOpts, timeZone);
  }
  return `${safeFormat(fmtDateTime, start, timeOpts, timeZone)} – ${safeFormat(
    fmtDateTime,
    end,
    endOpts,
    timeZone,
  )}`;
}

/**
 * Date block parts for the "Next up" hero: weekday / day numeral / month.
 * Null when the date is unparseable — the caller falls back to a meta row.
 */
export function formatDateBlock(
  fmtDateTime: DateTimeFormatter,
  startsAt: Date | string,
  timeZone: string | null,
): { weekday: string; day: string; month: string } | null {
  const date = validDateOrNull(startsAt);
  if (!date) return null;
  return {
    weekday: safeFormat(fmtDateTime, date, { weekday: "short" }, timeZone),
    day: safeFormat(fmtDateTime, date, { day: "numeric" }, timeZone),
    month: safeFormat(fmtDateTime, date, { month: "short" }, timeZone),
  };
}

/**
 * Where a commitment row links, or null when the payload can't address one.
 * Event rows prefer the slug; an ask row goes to its public signup page.
 * A `signupsPaused` row renders unlinked: a withheld owner's event and ask
 * pages both 404, so the row never sends the volunteer to a dead page.
 */
export function commitmentHref(row: Commitment): string | null {
  if (row.signupsPaused) return null;
  if (row.eventSlug) return `/events/${row.eventSlug}`;
  if (row.askId) return `/v/${row.askId}`;
  return null;
}

/**
 * The texts switch label for a row: what the reminder comes before, read off
 * the server's `reminderAnchor`. A null anchor (a revoke-only ON row) takes
 * the label the event page gives that row: the shift wording for an event
 * row, the ask wording for an ask row. An occurrence row (a claimed date of a
 * standing ask) is always the ask wording.
 */
export function commitmentSmsLabelKey(row: Commitment): string {
  if (isOccurrenceRow(row)) return "myVolunteering.smsToggleLabelAsk";
  switch (row.reminderAnchor) {
    case "SHIFT":
      return "eventDetail.volunteerSmsToggleLabel";
    case "EVENT_START":
      return "eventDetail.volunteerSmsToggleLabelEventStart";
    case "ASK_START":
      return "myVolunteering.smsToggleLabelAsk";
    default:
      return row.eventId
        ? "eventDetail.volunteerSmsToggleLabel"
        : "myVolunteering.smsToggleLabelAsk";
  }
}

/** A signup can still be reminded, so its texts switch belongs on the page. */
const isSmsSwitchLive = (row: Commitment): boolean =>
  row.status === "PENDING" || row.status === "APPROVED";

/**
 * Which rows carry their signup's texts switch: the first live row (PENDING
 * or APPROVED) of each signup, in page order. Consent is per SIGNUP, and a
 * standing volunteer's parent signup emits one row per claimed date, so
 * keying by row would print the same switch on every date. History rows
 * never carry one: nothing is sent for a past or closed signup.
 *
 * Returns `commitmentRowKey`s.
 */
export function smsSwitchRowKeys(
  rowsInPageOrder: readonly Commitment[],
): Set<string> {
  const seen = new Set<string>();
  const keys = new Set<string>();
  for (const row of rowsInPageOrder) {
    if (!isSmsSwitchLive(row) || seen.has(row.signupId)) continue;
    seen.add(row.signupId);
    keys.add(commitmentRowKey(row));
  }
  return keys;
}
