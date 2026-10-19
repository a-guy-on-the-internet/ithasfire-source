import {
  RECURRENCE_MAX_OCCURRENCES,
  RECURRENCE_WINDOW_MONTHS,
} from "@th/types/repos/event-dates";

import {
  toDateTimeLocalValue,
  toIsoInTimeZone,
} from "@/app/admin/[slug]/events/new/_components/event-builder-helpers";
import {
  configsEqual,
  enumerateOccurrences,
  extractRawCount,
  type RecurrenceConfig,
  withCount,
} from "@/app/admin/[slug]/events/new/_components/recurrence-helpers";

/**
 * What a rule change would do to the dates that already exist — computed on
 * the client, ahead of the write, so the moderator reads the damage before
 * they cause it rather than after.
 *
 * ── WHY THIS IS CLIENT-SIDE ARITHMETIC AND NOT A SERVER PREVIEW ────────────
 *
 * `community.updateRecurrence` has no dry-run mode and no sibling that
 * returns one; it reconciles and returns the AFTER state (`scheduledCount`).
 * The only inputs available to a page are the candidate rule (which the
 * moderator is composing right here) and `community.listEventDates`' rows.
 * So this module mirrors the reconciliation the server will perform, using
 * exactly those two.
 *
 * ── WHAT IT MIRRORS ────────────────────────────────────────────────────────
 *
 * `EventDatesRepo.bulkReplaceForEvent` (see its port doc — this is the
 * contract being mirrored, and the one to re-read if it ever changes):
 *
 *  - a FUTURE, still-SCHEDULED row whose `startsAt` is NOT in the desired set
 *    comes off the schedule — CANCELLED when it carries RSVPs, hard-deleted
 *    when it does not;
 *  - a desired instant that coincides with an existing CANCELLED row is
 *    SKIPPED (a night a moderator called off stays off), so it is not an
 *    addition;
 *  - a desired instant matching a live SCHEDULED row is kept;
 *  - everything else desired is inserted.
 *
 * ── THE DESIRED SET IS WINDOWED *AND* CAPPED, AND BOTH MATTER ──────────────
 *
 * A row drops iff its instant is missing from the DESIRED SET — the thing
 * `applyRecurrenceForEvent` actually hands `bulkReplaceForEvent`, which is
 * `expandRecurrenceDates(..., { windowEnd: now + 12mo, max: 60 })`. The drop
 * side of the reconcile applies NO window and NO cap of its own: it walks
 * every future SCHEDULED row and drops each one not in those ≤60 instants.
 *
 * An earlier version of this module tested membership against the rule's
 * UNWINDOWED, UNCAPPED enumeration, on the argument that no stored row can sit
 * past the 12-month window (true) and that widening the set only risks a ±1
 * false positive at the horizon (false). The cap is the hole: add a second
 * weekday to a weekly rule and one pass yields 30 + 30 instead of 52, ending
 * five months earlier — the ~22 stranded Wednesdays are future, SCHEDULED and
 * not in the desired set, so the server cancels or deletes every one of them
 * while the band read "No date now on this schedule would come off."
 *
 * So membership is tested against `desired`. The ±1 that motivated the wider
 * set is handled by CLASSIFYING rather than by widening — see
 * {@link ReconcileDiff.droppedBeyondHorizonCount}.
 *
 * ── WHAT IT CAN AND CANNOT STAND BEHIND ────────────────────────────────────
 *
 * {@link ReconcileDiff.droppedCount} is the number the UI leads with. It is
 * exact for the rows in hand up to the horizon's ±1: the browser's
 * calendar-month arithmetic and the server's can disagree by the offset
 * between their zones, so a row within hours of the 12-month boundary can
 * fall either side. Such a row lands in `droppedBeyondHorizonCount`, which is
 * separately labelled, so the ±1 never reads as "the rule dropped this date".
 *
 * {@link ReconcileDiff.addedCount} carries the same ±1, and the UI says so.
 *
 * {@link ReconcileDiff.partial} says the ROW list was capped by the read, so
 * `droppedCount` is a floor rather than a total. {@link ReconcileDiff.capReached}
 * says the CANDIDATE's expansion filled its one-pass cap, so its tail is cut.
 */

/**
 * The materialisation horizon and the per-pass cap are the WRITE PATH's
 * numbers, imported from the one place they are defined (`@th/types`, beside
 * `EventDateRecord`). `apps/web` has no `@th/core` dependency, so until they
 * lived there this module carried a hand-typed copy, and a copy that drifted
 * would have shown the moderator a count the server would not honour with
 * nothing to fail.
 */

/**
 * How many occurrences to enumerate before windowing.
 *
 * Generous on purpose. Every candidate on this page is anchored at
 * {@link normaliseAnchor}'s reading of the listing's `Event.startsAt`, which
 * the server re-pins to the first UPCOMING occurrence — so enumeration starts
 * at roughly `now` and the horizon is reached long before this. The headroom
 * exists so a stale re-pin degrades to a slightly conservative count instead
 * of an empty desired set, which would read as "every date comes off".
 */
const ENUMERATION_HEADROOM = 400;

/** One calendar day, for the walk in {@link prefillFromStoredRule}. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** One occurrence already on the schedule, as `listEventDates` returns it. */
export type StoredDate = {
  eventDateId: string;
  /** Epoch ms. */
  startsAtMs: number;
  status: "SCHEDULED" | "CANCELLED";
};

export type ReconcileDiff = {
  /**
   * Live dates that would come off the schedule — CANCELLED if they carry
   * RSVPs, removed if they do not. The destructive number.
   */
  droppedCount: number;
  /** The dropped rows themselves, so the list can mark them. */
  droppedIds: ReadonlySet<string>;
  /**
   * The SUBSET of `droppedIds` the new rule still WANTS — instants it
   * produces, sitting past the last one a single expansion pass can reach.
   *
   * These are the drops nobody expects, and they need saying in their own
   * words. A moderator who adds Friday to a weekly listing is not asking for
   * next spring's Wednesdays to be destroyed; they are destroyed anyway,
   * because one pass materialises at most `RECURRENCE_MAX_OCCURRENCES` and the
   * interleaved Fridays consume half of them. For any of those dates that
   * carries an RSVP the loss is permanent: it survives as CANCELLED, and the
   * reconcile deliberately SKIPS a desired instant that coincides with a
   * cancelled row, so no later top-up pass puts it back.
   *
   * It also absorbs the horizon's ±1: a row the browser puts outside the
   * 12-month window and the server puts inside lands here rather than in the
   * "the rule no longer produces this" bucket, where it would be a flatly
   * false statement about a date that is not moving.
   */
  droppedBeyondHorizonIds: ReadonlySet<string>;
  droppedBeyondHorizonCount: number;
  /** Live dates the new rule also produces. Unchanged by the write. */
  keptCount: number;
  /** Desired instants with no row yet. ±1 at the horizon — see the header. */
  addedCount: number;
  /** Live SCHEDULED rows the diff was computed over. */
  scheduledCount: number;
  /**
   * The row list was capped by the read, so more upcoming rows may exist than
   * were compared. `droppedCount` is then a floor, not a total.
   */
  partial: boolean;
  /**
   * The candidate's expansion filled the one-pass cap, so the schedule it
   * writes STOPS EARLIER than the rule does. This is the signal behind
   * `droppedBeyondHorizonCount`, and it is worth stating even when nothing is
   * stranded — it is why a 52-week listing can come back as a 30-week one.
   */
  capReached: boolean;
  /**
   * The candidate rule enumerates nothing inside the window. The server
   * refuses this outright (`RECURRENCE_HAS_NO_UPCOMING_DATES`), so the UI
   * blocks the write rather than letting it fail at the API.
   */
  producesNothing: boolean;
};

/**
 * `now + RECURRENCE_WINDOW_MONTHS`, on the runtime's local calendar — the same
 * calendar-month arithmetic Luxon's `plus({ months })` does on the server,
 * differing only by the gap between the server's zone and the browser's. That
 * gap can only move an occurrence sitting within hours of the horizon, which
 * is the ±1 {@link ReconcileDiff.addedCount} is documented to carry.
 */
export function materialisationHorizon(now: Date): Date {
  const end = new Date(now.getTime());
  end.setMonth(end.getMonth() + RECURRENCE_WINDOW_MONTHS);
  return end;
}

/**
 * The instants the candidate rule would be materialised into, as the write
 * path would compute them: enumerate, clamp to [now, horizon], cap.
 */
export function desiredOccurrences(
  config: RecurrenceConfig,
  opts: { now: Date; timezone: string },
): Date[] {
  const horizonMs = materialisationHorizon(opts.now).getTime();
  const nowMs = opts.now.getTime();
  return enumerateOccurrences(
    config.rrule,
    config.dtstart,
    config.until,
    ENUMERATION_HEADROOM,
    opts.timezone,
  )
    .filter((d) => {
      const ms = d.getTime();
      return ms >= nowMs && ms <= horizonMs;
    })
    .slice(0, RECURRENCE_MAX_OCCURRENCES);
}

/**
 * Every instant the candidate rule produces at all, window and cap ignored.
 *
 * NOT the survival test — that is membership in `desired` (see the module
 * header for the cap hole that misreading cost). This answers the strictly
 * weaker question "does the rule want this instant AT ALL", which is what
 * separates a date the rule genuinely dropped from one it still wants but
 * cannot reach in a single expansion pass.
 */
function producedInstants(
  config: RecurrenceConfig,
  timezone: string,
): Set<number> {
  const set = new Set<number>();
  for (const d of enumerateOccurrences(
    config.rrule,
    config.dtstart,
    config.until,
    ENUMERATION_HEADROOM,
    timezone,
  )) {
    set.add(d.getTime());
  }
  return set;
}

export function reconcileDiff(
  config: RecurrenceConfig,
  args: {
    dates: readonly StoredDate[];
    now: Date;
    timezone: string;
    /** `dates` was capped by the read — see {@link ReconcileDiff.partial}. */
    partial: boolean;
  },
): ReconcileDiff {
  const desired = desiredOccurrences(config, {
    now: args.now,
    timezone: args.timezone,
  });
  const produced = producedInstants(config, args.timezone);

  // THE desired set — windowed and capped, exactly what the write path hands
  // `bulkReplaceForEvent`. Anything not in it comes off, full stop.
  const desiredMs = new Set(desired.map((d) => d.getTime()));
  const lastDesiredMs = desired.at(-1)?.getTime() ?? null;

  const scheduled = args.dates.filter((d) => d.status === "SCHEDULED");
  const droppedIds = new Set<string>();
  const droppedBeyondHorizonIds = new Set<string>();
  for (const row of scheduled) {
    if (desiredMs.has(row.startsAtMs)) continue;
    droppedIds.add(row.eventDateId);
    // Still wanted by the rule, just out of reach of this pass. A different
    // sentence, because it is a different thing happening to the date.
    if (
      lastDesiredMs !== null &&
      row.startsAtMs > lastDesiredMs &&
      produced.has(row.startsAtMs)
    ) {
      droppedBeyondHorizonIds.add(row.eventDateId);
    }
  }

  // Any existing row at that instant blocks an insert: a live one is kept and
  // refreshed, a CANCELLED one is deliberately skipped so the night stays off.
  const occupied = new Set(args.dates.map((d) => d.startsAtMs));
  const addedCount = desired.filter((d) => !occupied.has(d.getTime())).length;

  return {
    droppedCount: droppedIds.size,
    droppedIds,
    droppedBeyondHorizonIds,
    droppedBeyondHorizonCount: droppedBeyondHorizonIds.size,
    keptCount: scheduled.length - droppedIds.size,
    addedCount,
    scheduledCount: scheduled.length,
    partial: args.partial,
    capReached: desired.length >= RECURRENCE_MAX_OCCURRENCES,
    producesNothing: desired.length === 0,
  };
}

/**
 * The instant every rule on this page is anchored to, as the BUILDER will
 * read it back.
 *
 * `RecurrenceBuilder` derives its own `dtstart` from `eventStartsAt` by the
 * round trip `datetime-local` (in the listing's zone) → instant, and its
 * emission effect rewrites a loaded config the moment that string disagrees
 * with the config's `dtstart`. So the config this page seeds must carry the
 * SAME string, which means running `Event.startsAt` through the same round
 * trip up front. The result is a fixed point of that round trip — the tests
 * pin it across a DST gap and a fold — so an untouched prefill survives the
 * builder's first render byte for byte.
 */
export function normaliseAnchor(startsAtIso: string, timezone: string): string {
  return toIsoInTimeZone(toDateTimeLocalValue(startsAtIso, timezone), timezone);
}

/** The stored rule as `community.listEventDates` returns it. */
export type StoredRule = {
  rrule: string;
  /** UTC ISO instant. */
  dtstart: string;
  /** UTC ISO instant, or `null`. */
  until: string | null;
};

/**
 * The stored rule, re-anchored at the listing's next upcoming occurrence so
 * the editor can be seeded with it.
 *
 * ── WHY NOT THE SUMMARY ───────────────────────────────────────────────────
 *
 * The editor used to be seeded from the read-side SUMMARY, which is a
 * phrasebook and drops COUNT and any monthly ordinal. Both losses make the
 * rebuilt rule a SUPERSET of the stored one — `COUNT=20` came back
 * open-ended, a "second Wednesday" came back as every Wednesday — and a
 * superset drops nothing, so the consequence band's headline number read
 * clean while Apply rewrote the series. Seeding from the rule itself removes
 * the class: BYSETPOS, INTERVAL, an embedded UNTIL and everything else the
 * builder cannot express structurally pass through verbatim (as raw text in
 * its Custom mode).
 *
 * ── WHY RE-ANCHOR, AND WHAT THAT COSTS ────────────────────────────────────
 *
 * The stored `dtstart` is where the rule was anchored when it was last
 * written, and the server never moves it — it re-pins `Event.startsAt`
 * forward instead. Anchoring the BUILDER there would keep this prefill
 * trivially verbatim, but the builder anchors every rule the moderator then
 * COMPOSES at the same instant: "After 12 dates" on a listing 100 Wednesdays
 * old would count twelve nights that already happened and produce nothing.
 * So the builder stays anchored at the next upcoming occurrence, as it always
 * was, and the stored rule is carried across to that anchor instead.
 *
 * Moving the anchor to one of the rule's own occurrences changes nothing
 * about which instants a rule produces — BYDAY, BYSETPOS, INTERVAL phase and
 * UNTIL all read the same from any occurrence — with ONE exception: COUNT is
 * counted from the anchor. So a COUNT is reduced by the occurrences the
 * stored rule produced BEFORE the new anchor, which is exactly the number of
 * nights that have already happened. `FREQ=WEEKLY;BYDAY=WE;COUNT=20` with
 * three Wednesdays behind it seeds as `COUNT=17`: the same seventeen future
 * instants, and the builder's "After 17 dates" reads as the seventeen the
 * moderator can still see.
 *
 * ── WHEN IT REFUSES ───────────────────────────────────────────────────────
 *
 * All of that holds ONLY while the anchor IS an occurrence of the stored
 * rule, so that is checked, and the prefill is `null` when it is not. The
 * case that breaks it is real: a listing with nothing upcoming left (its
 * last night called off, its COUNT spent) is pinned to `now` by
 * `repinEventStartsAt`, and `now` is a Thursday afternoon, not a Wednesday
 * night. Carrying `FREQ=WEEKLY;BYDAY=WE` to that anchor would seed a rule the
 * builder reads as Custom with the wrong day pinned and a preview of fifty-two
 * Wednesdays at 2:37 PM — under a caption promising that applying it changes
 * nothing. Seeding nothing lets the editor open on its own defaults, which is
 * the honest starting point for a listing with no upcoming rule to edit.
 *
 * Occurrences are compared to the anchor at MINUTE precision, because the
 * browser-side enumeration is minute-precise by design (see
 * `floatingToInstant` in `recurrence-helpers.ts`) while a stored anchor may
 * carry seconds; without that an occurrence that IS the anchor would count as
 * already passed.
 *
 * `null` in → `null` out (no rule to seed, so the editor opens on defaults).
 */
export function prefillFromStoredRule(
  storedRule: StoredRule | null,
  opts: { anchorIso: string; timezone: string },
): RecurrenceConfig | null {
  if (!storedRule) return null;
  const anchorMs = new Date(opts.anchorIso).getTime();
  const storedMs = new Date(storedRule.dtstart).getTime();
  if (Number.isNaN(anchorMs) || Number.isNaN(storedMs)) {
    return null;
  }
  const until = storedRule.until ?? undefined;
  let rrule = storedRule.rrule;
  const count = extractRawCount(rrule);

  // Walk the stored rule from ITS anchor up to this page's. No rule the
  // builder emits fires more than once per calendar day, so the walk needs at
  // most one step per day between the two anchors plus the usual headroom —
  // and never more than COUNT for a bounded rule. Bounded on both sides
  // because the enumeration is eager and the COUNT is whatever an API caller
  // stored; a rule that fires more often than daily simply fails to reach
  // the anchor and seeds nothing.
  const anchorMinute = Math.floor(anchorMs / 60_000);
  const daysToAnchor = Math.max(0, Math.ceil((anchorMs - storedMs) / DAY_MS));
  const budget = Math.min(
    count ?? Number.POSITIVE_INFINITY,
    ENUMERATION_HEADROOM + daysToAnchor + 1,
  );
  let passed = 0;
  let anchorIsOccurrence = false;
  for (const d of enumerateOccurrences(
    rrule,
    storedRule.dtstart,
    until,
    budget,
    opts.timezone,
  )) {
    const minute = Math.floor(d.getTime() / 60_000);
    if (minute < anchorMinute) {
      passed += 1;
      continue;
    }
    anchorIsOccurrence = minute === anchorMinute;
    break;
  }
  if (!anchorIsOccurrence) return null;

  if (count != null) {
    // At least 1: a spent COUNT ends the walk before the anchor, and that
    // already returned `null` above.
    const remaining = count - passed;
    if (remaining !== count) rrule = withCount(rrule, remaining);
  }

  return {
    rrule,
    dtstart: opts.anchorIso,
    ...(until ? { until } : {}),
  };
}

/** What `community.updateRecurrence` is handed. */
export type ScheduleToApply = {
  kind: "RRULE";
  rrule: string;
  dtstart: string;
  until?: string;
};

/**
 * The schedule Apply writes for a candidate.
 *
 * A candidate the moderator has NOT changed from its prefill is written as the
 * STORED rule, verbatim — historic anchor and original COUNT included — not
 * as the re-anchored copy the editor was seeded with. The server expands from
 * `now` either way, so the materialised nights are identical; what differs is
 * what the row keeps. Writing the re-anchored copy would move the stored
 * `dtstart` past any night called off before the current anchor, and a night
 * put back later would then sit before its own rule's start and be dropped by
 * the next refresh. An unchanged Apply must leave the stored schedule as it
 * is, because the caption above the editor says it does.
 *
 * Anything the moderator changed is written as composed: anchored at the next
 * upcoming date, which is what "After N dates" was counted from.
 *
 * "Unchanged" is judged by EFFECTIVE shape, not by `configsEqual`: the
 * prefill carries its COUNT only inside the rule string, while every builder
 * emission also sets the separate `count` field, so a moderator who touches a
 * control and puts it back has a candidate `configsEqual` would call
 * different — and the same rule would then be written as composed, moving
 * the stored anchor after all.
 */
export function scheduleToApply(
  candidate: RecurrenceConfig,
  prefill: RecurrenceConfig | null,
  storedRule: StoredRule | null,
): ScheduleToApply {
  if (storedRule && prefill && sameRule(candidate, prefill)) {
    return {
      kind: "RRULE",
      rrule: storedRule.rrule,
      dtstart: storedRule.dtstart,
      ...(storedRule.until ? { until: storedRule.until } : {}),
    };
  }
  return {
    kind: "RRULE",
    rrule: candidate.rrule,
    dtstart: candidate.dtstart,
    // `count` is NOT sent: the schedule schema is strict and refuses it, and
    // the bound already rides inside the rule as `COUNT=`.
    ...(candidate.until ? { until: candidate.until } : {}),
  };
}

/** Same rule, whether the COUNT rides in the string or in the `count` field. */
function sameRule(a: RecurrenceConfig, b: RecurrenceConfig): boolean {
  if (configsEqual(a, b)) return true;
  return (
    withCount(a.rrule, null) === withCount(b.rrule, null) &&
    a.dtstart === b.dtstart &&
    (a.until ?? null) === (b.until ?? null) &&
    (a.count ?? extractRawCount(a.rrule)) === (b.count ?? extractRawCount(b.rrule))
  );
}

/**
 * Of the dates a rule change would drop, how many carry RSVPs — the
 * difference between removing empty nights and calling off nights people
 * said they would come to, which is the judgement the consequence band exists
 * to inform.
 *
 * `known` is `false` when the rows in hand do not carry the moderator-only
 * `hasRsvp` flag (a read that did not ask for it, or an older API), and the
 * band then says the number is not shown rather than printing a zero it never
 * measured. A count of DATES, never of people: FR-004 forbids a going-count,
 * and `hasRsvp` is presence per date.
 */
export function droppedRsvpSummary(
  diff: Pick<ReconcileDiff, "droppedIds">,
  rows: ReadonlyArray<{ eventDateId: string; hasRsvp?: boolean }>,
): { known: boolean; count: number } {
  const dropped = rows.filter((row) => diff.droppedIds.has(row.eventDateId));
  if (dropped.some((row) => row.hasRsvp === undefined)) {
    return { known: false, count: 0 };
  }
  return {
    known: true,
    count: dropped.filter((row) => row.hasRsvp === true).length,
  };
}
