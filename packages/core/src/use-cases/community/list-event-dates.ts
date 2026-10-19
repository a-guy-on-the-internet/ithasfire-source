import { DateTime } from "luxon";
import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";
import type { EventDateRecord, EventSeriesSchedule } from "@th/types";
import { eventDateStatusSchema } from "@th/schema";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";
import { expandRecurrenceDates } from "../events/_shared/expand-recurrence";
import {
  summarizeRecurrence,
  type RecurrenceSummary,
} from "../events/_shared/summarize-recurrence";
import { RECURRENCE_MAX_OCCURRENCES } from "./_shared/community-recurrence";
import { COMMUNITY_MODERATION_ROLES } from "./_shared/suggestion-validation";

/**
 * Public read of a recurring community listing's upcoming schedule
 * (recurring-dates spec, slice 2). Returns the UPCOMING occurrences
 * (startsAt >= now, ascending, capped) with the VIEWER's own per-date RSVP
 * state — used by the event page (and, later slices, the card) to render the
 * schedule + per-date RSVP toggles.
 *
 * CANCELLED OCCURRENCES ARE INCLUDED, each carrying its `status`. A night a
 * moderator called off is shown struck through until it passes, because
 * dropping it says "that date was never on the schedule" when what happened is
 * "that date is off" — and the people who RSVP'd to it are still holding a
 * live RSVP. Three things downstream turn on this and are answered explicitly
 * rather than left to the caller: `nextScheduledEventDateId` (the lead date is
 * never a cancelled one), `truncated` (see {@link isTruncated}), and
 * `hasRecurrenceRule` (see that field).
 *
 * FR-004: RSVP state is personal. `viewerRsvped` reflects ONLY the caller's
 * own markers (seeded via `listDateIdsForHuman` when a viewer is present, else
 * all false). NO public going-count is ever returned.
 *
 * ONE moderator-only addition, gated HERE and not only at the transport:
 * `moderatorView` adds a per-date `hasRsvp` boolean — presence, never a
 * number — so the moderator's schedule page can say, before a rule change is
 * applied, which of the nights it would drop someone has said they are coming
 * to. See the output field and `EventDateRsvpRepo.listDateIdsWithAnyRsvp`.
 *
 * Alongside the dates it returns a `recurrence` SUMMARY of the stored rule, so
 * a page can lead with "Every Wednesday, 8:00 PM" instead of enumerating 52
 * rows, plus a `truncated` flag saying whether the returned list actually runs
 * to the END of the series. Both are event-intrinsic (nothing viewer-scoped, so
 * they may ride an edge-cached document) and strictly DECORATION: neither can
 * change `dates`, and every failure path collapses the summary to `null` — see
 * {@link readRecurrenceSummary}.
 */

/**
 * Hard cap on returned rows. Equal to {@link RECURRENCE_MAX_OCCURRENCES} on
 * purpose: the write path never materialises more than that many occurrences
 * per expansion, so a full page here means the READ stopped early too.
 *
 * It is a cap on the read, NOT a measure of the write: the count of upcoming
 * rows decays as occurrences pass, so it can never be the only truncation
 * signal — see {@link isTruncated}.
 */
const MAX_DATES = RECURRENCE_MAX_OCCURRENCES;

/**
 * How far past the last returned row the truncation probe looks.
 *
 * {@link expandRecurrenceDates} wants a bounded window, but the question here
 * is only "does ANYTHING follow the last row", so the bound just has to sit
 * beyond any real listing's next occurrence. It is not a cost knob and it is
 * never walked: a bounded rule stops at its own UNTIL/COUNT, and an unbounded
 * one is answered by `rrule`'s first step.
 */
const PROBE_HORIZON_YEARS = 100;

export const listEventDatesInputSchema = z
  .object({
    eventId: z.uuid(),
    /** Absent for anonymous viewers — all `viewerRsvped` come back false. */
    viewerHumanId: z.uuid().nullable().optional(),
    /**
     * Read the Event row to summarise the stored rule (default `true`).
     *
     * Pass `false` from a caller that wants ONLY the per-date RSVP flags — the
     * web viewer-state endpoint does, and it is `private, no-store`, so the
     * Event read it discarded was one extra row per viewer per page. When
     * `false`, `recurrence` is `null` and `truncated` reflects ONLY the row cap:
     * truncation is answered by expanding the stored schedule, and this caller
     * declined to read it. That caller reads neither field — see `truncated`.
     */
    includeRecurrence: z.boolean().optional().default(true),
    /**
     * Add the moderator-only `hasRsvp` per date (default `false`).
     *
     * Requires `viewerHumanId` to hold one of the community-moderation roles;
     * anyone else — anonymous included — is refused with `STAFF_ONLY` rather
     * than handed a read with the field blank, so a page cannot mistake "not
     * allowed" for "nobody RSVP'd". Checked by this use case, so no transport
     * can forward the flag without the check coming with it.
     */
    moderatorView: z.boolean().optional().default(false),
  })
  .strict();

export const listEventDatesOutputSchema = z
  .object({
    dates: z.array(
      z
        .object({
          eventDateId: z.uuid(),
          startsAt: z.date(),
          endsAt: z.date().nullable(),
          viewerRsvped: z.boolean(),
          /**
           * `CANCELLED` means the night is off — render it struck through and
           * refuse an RSVP on it, do NOT hide it. `rsvpToEventDate` rejects a
           * non-SCHEDULED date with `EVENT_DATE_NOT_RSVPABLE`, so a stale
           * toggle fails loudly rather than pretending to work.
           */
          status: eventDateStatusSchema,
          /**
           * MODERATOR-ONLY: whether at least one person holds a live RSVP on
           * this date. Present only when `moderatorView` was requested AND the
           * caller passed the moderation-role check; absent otherwise, never
           * `false`-by-default, so a page cannot read "not allowed to know"
           * as "nobody is coming".
           *
           * A boolean, never a count (FR-004). It states the same fact
           * `bulkReplaceForEvent` acts on when a rule change drops the date —
           * CANCELLED and its people emailed if anyone RSVP'd, deleted
           * outright if not — which a moderator could always infer after the
           * fact; this puts it in front of the decision. It must never ride
           * an edge-cached document: the public page's loader does not
           * request it, and `assertNoViewerScopedFields` refuses the key.
           */
          hasRsvp: z.boolean().optional(),
        })
        .strict(),
    ),
    /**
     * Plain-language shape of the stored recurrence rule, or `null` when there
     * is nothing a cadence line can state (no schedule, FIXED_DATES, a rule
     * outside the summarisable subset, or any failure reading it). Deliberately
     * lossy — see `summarizeRecurrence`.
     */
    recurrence: z
      .object({
        freq: z.enum(["DAILY", "WEEKLY", "MONTHLY"]),
        interval: z.number().int().min(1),
        byday: z.array(z.string()),
        until: z.date().nullable(),
      })
      .strict()
      .nullable(),
    /**
     * The stored rule ITSELF — the `rrule` string verbatim, with its `dtstart`
     * anchor and the schedule's own `until` bound as UTC instants — or `null`
     * when the listing holds no schedule, holds FIXED_DATES, or holds an RRULE
     * schedule whose rule or anchor is missing or unparseable (nothing can be
     * expanded from it, so nothing can be edited).
     *
     * The two instants are NOT verbatim, on purpose. They are parsed exactly as
     * expansion parses them (`wallTimeToFloating`: a bare wall-clock string is
     * read in the EVENT's zone, an explicit offset is honoured) and re-emitted
     * as ISO in UTC. A browser handed the raw string would read a bare one in
     * ITS zone, seed the editor a few hours off, and preview every row as
     * dropped. An `until` that fails to parse comes back `null`, which is what
     * expansion does with it too (the rule's own `UNTIL=`, if any, still
     * applies).
     *
     * `recurrence` above is a phrasebook and is lossy BY DESIGN (COUNT and any
     * monthly ordinal are dropped). That is fine for a sentence and wrong for
     * an editor: a rule editor prefilled from the summary opens on a rule
     * WIDER than the stored one — `COUNT=20` comes back open-ended, a "second
     * Wednesday" comes back as every Wednesday — and a widened rule drops no
     * dates, so the moderator's consequence preview reads clean while applying
     * it quietly rewrites the series. This field exists so an editor prefills
     * from the truth. Event-intrinsic (the dates and the summary are both
     * derived from it), so it may ride an edge-cached document, though the
     * public page has no use for it and does not carry it.
     *
     * `hasRecurrenceRule` is the broader question ("is there a schedule at
     * all", FIXED_DATES included); this is `null` for a FIXED_DATES listing
     * that `hasRecurrenceRule` answers `true` for.
     */
    storedRule: z
      .object({
        rrule: z.string(),
        dtstart: z.string(),
        until: z.string().nullable(),
      })
      .strict()
      .nullable(),
    /**
     * `true` when `dates` does NOT reach the end of the series — i.e. there are
     * more occurrences than the ones returned here.
     *
     * The client cannot derive this: the list is capped twice over (rows, and
     * what materialisation generated) and neither cap is visible downstream.
     * Without the flag a page renders the server's caps as the organizer's
     * schedule — an open-ended weekly open mic comes back as 52 rows covering a
     * year and reads as "52 dates through Sep 2027", which is a false statement
     * about someone's listing.
     *
     * It is computed by asking the stored schedule whether anything follows the
     * last returned row, so it tracks the series rather than the list — see
     * {@link isTruncated} for the probe and for the three inputs it cannot
     * probe.
     *
     * Deliberately conservative: `false` means "this really is all of it", and
     * uncertainty answers `true`, so the worst case is a page that stays vague
     * instead of one that invents an end date. The `false` cases are a listing
     * with no schedule, and a schedule whose final occurrence is already in
     * `dates`.
     *
     * Only fully meaningful when `includeRecurrence` is `true` (the default);
     * see that field.
     */
    truncated: z.boolean(),
    /**
     * The occurrence the page should LEAD with: the first upcoming one that is
     * still SCHEDULED, or `null` when every upcoming occurrence is cancelled
     * (or there are none).
     *
     * Server-computed rather than left as `dates[0]` because `dates[0]` is now
     * routinely the wrong answer — a called-off night sorts first like any
     * other, and leading with it advertises a night that is off. Answered once,
     * here, so every surface leads with the same date.
     */
    nextScheduledEventDateId: z.uuid().nullable(),
    /**
     * Whether the listing is driven by a stored recurrence rule at all.
     *
     * NOT derivable from `recurrence`: that is a summary of a deliberately
     * narrow phrasebook and comes back `null` for FIXED_DATES and for any rule
     * outside the subset, both of which are very much recurring listings.
     * Keying off it would treat a FIXED_DATES series with every night called
     * off as a plain single-date event.
     *
     * This is the field that makes the ZERO-DATES ruling expressible. With no
     * upcoming SCHEDULED occurrence, three states are distinguishable from a
     * page's side:
     *  - `hasRecurrenceRule && truncated` — DRAINED BUT LIVE (the top-up job
     *    stalled, or the materialisation window is exhausted). The page states
     *    the cadence and says the next dates are being scheduled; no per-date
     *    RSVP, because there is no date to attach one to.
     *  - `hasRecurrenceRule && !truncated` — GENUINELY ENDED (an UNTIL passed,
     *    a COUNT ran out). "This series has ended."
     *  - `!hasRecurrenceRule` — an ordinary single-date listing; unchanged
     *    behaviour, and the only case where the event-level RSVP button is the
     *    right control.
     *
     * A recurring listing must NEVER fall back to the event-level RSVP button:
     * `Event.startsAt` on a drained recurring listing is a past or synthetic
     * instant, so that fallback attaches "I'm going" to a night that already
     * happened.
     *
     * `false` when the Event row was not read (`includeRecurrence: false`) or
     * the read threw — the same "we do not know" that collapses `recurrence` to
     * null, resolved toward the unchanged single-date rendering.
     */
    hasRecurrenceRule: z.boolean(),
  })
  .strict();

export type ListEventDatesInput = z.infer<typeof listEventDatesInputSchema>;
export type ListEventDatesOutput = z.infer<typeof listEventDatesOutputSchema>;

export type ListEventDatesDeps = {
  repos: Repos;
  clock: ClockPort;
  /**
   * Required for `moderatorView`; the flag is refused without it. Optional
   * because the public read has no role to check and its composition roots
   * need not wire one.
   */
  authz?: Pick<AuthZPort, "hasStaffRole">;
  logger?: LoggerPort;
  /**
   * Best-effort reporter (ReporterPort convention). The recurrence read is
   * swallowed so it can never take down the public event page, which would
   * otherwise make a broken schedule read invisible.
   */
  reportError?: ReporterPort;
};

export async function listEventDates(
  deps: ListEventDatesDeps,
  rawInput: unknown,
): Promise<ListEventDatesOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "listEventDates" });

  const execute = async (): Promise<ListEventDatesOutput> => {
    const input = parseInput(listEventDatesInputSchema, rawInput);

    // The moderator-only half is gated BEFORE any read, here in the use case:
    // a transport that forwards `moderatorView` cannot skip this. No actor,
    // no authz wired, or not a moderator → STAFF_ONLY, never a blank field.
    if (input.moderatorView) {
      if (!input.viewerHumanId || !deps.authz) {
        throw fail("STAFF_ONLY");
      }
      await requirePlatformStaff({
        authz: deps.authz,
        actorHumanId: input.viewerHumanId,
        roles: COMMUNITY_MODERATION_ROLES,
      });
    }

    const now = deps.clock.now();
    // Both reads are event-scoped and independent, so they go out together —
    // the summary adds no round-trip to the page's critical path.
    // `readRecurrenceSummary` never rejects, so it cannot abort this Promise.all
    // and take the dates with it.
    const [upcoming, recurrenceRead] = await Promise.all([
      deps.repos.eventDates.listUpcoming({
        eventId: input.eventId,
        now,
        limit: MAX_DATES,
      }),
      input.includeRecurrence
        ? readRecurrenceSummary(deps, input.eventId)
        : Promise.resolve(RECURRENCE_UNREAD),
    ]);

    // Seed the viewer's OWN RSVP state in ONE batched query (no public count).
    const rsvpedIds = new Set<string>();
    if (input.viewerHumanId && upcoming.length > 0) {
      const ids = await deps.repos.eventDateRsvps.listDateIdsForHuman({
        humanId: input.viewerHumanId,
        eventDateIds: upcoming.map((date) => date.id),
      });
      for (const id of ids) rsvpedIds.add(id);
    }

    // Moderator view only (gated above): which dates ANYONE has RSVP'd — a
    // presence set, one batched query, never a count.
    const withRsvpIds = new Set<string>();
    if (input.moderatorView && upcoming.length > 0) {
      const ids = await deps.repos.eventDateRsvps.listDateIdsWithAnyRsvp(
        upcoming.map((date) => date.id),
      );
      for (const id of ids) withRsvpIds.add(id);
    }

    return listEventDatesOutputSchema.parse({
      dates: upcoming.map((date) => ({
        eventDateId: date.id,
        startsAt: date.startsAt,
        endsAt: date.endsAt,
        viewerRsvped: rsvpedIds.has(date.id),
        status: date.status,
        // Absent — not `false` — outside the moderator view.
        ...(input.moderatorView ? { hasRsvp: withRsvpIds.has(date.id) } : {}),
      })),
      recurrence: recurrenceRead.summary,
      storedRule: recurrenceRead.storedRule,
      truncated: isTruncated({
        upcoming,
        read: recurrenceRead,
        now,
      }),
      // The lead date is the first still-SCHEDULED one, never `upcoming[0]` —
      // a called-off night sorts first like any other.
      nextScheduledEventDateId: nextScheduledIdOf(upcoming),
      // "Is there a rule at all", which is a strictly weaker question than
      // "can we phrase it" — see the field doc.
      hasRecurrenceRule: recurrenceRead.hasSchedule,
    });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("listEventDates", execute);
  }

  return execute();
}

/**
 * The first UPCOMING occurrence that is still on, or `null`.
 *
 * `upcoming` is already `startsAt >= now` ascending, so this is a scan for the
 * first SCHEDULED row. A list of nothing but cancelled rows answers `null`,
 * which is exactly the drained state the zero-dates ruling is about — and is
 * why "no upcoming dates" can no longer be read off `dates.length`.
 */
function nextScheduledIdOf(
  upcoming: ReadonlyArray<Pick<EventDateRecord, "id" | "status">>,
): string | null {
  return upcoming.find((date) => date.status === "SCHEDULED")?.id ?? null;
}

/** What one read of the Event row tells us about the schedule behind `dates`. */
type RecurrenceRead = {
  /** The cadence a sentence can be built from, or `null`. */
  summary: RecurrenceSummary | null;
  /** The RRULE schedule verbatim, for an editor — see the output field doc. */
  storedRule: StoredRule | null;
  /**
   * How much is known about the stored schedule:
   *  - `KNOWN` — the row was read; `schedule` is what it holds (`null` when it
   *    holds nothing expandable).
   *  - `UNREAD` — `includeRecurrence: false`: the read was deliberately skipped.
   *  - `UNREADABLE` — the read threw.
   *
   * The last two both mean "no schedule in hand", but they answer truncation
   * DIFFERENTLY (a deliberate opt-out is not a fault), which is why this is a
   * discriminant and not a boolean — see {@link isTruncated}.
   */
  knowledge: "KNOWN" | "UNREAD" | "UNREADABLE";
  /**
   * The stored schedule, ready to re-expand. Tracked SEPARATELY from `summary`
   * because a rule can be expandable-but-not-summarisable (`FREQ=YEARLY`,
   * `FREQ=DAILY;BYDAY=MO,WE,FR`, an nth-token the phrasebook refuses): such a
   * listing still has occurrences past its last row, and keying truncation off
   * `summary` alone would call its capped list complete.
   */
  schedule: EventSeriesSchedule | null;
  /**
   * The event's IANA zone — the LOCAL basis every expansion is read on
   * (standing ruling: RRULE is evaluated locally, never in UTC).
   */
  timezone: string | null;
  /**
   * Does the Event row hold a recurrence schedule AT ALL?
   *
   * Tracked separately from both `summary` (a lossy phrasebook) and `schedule`
   * (only set when the JSON is shape-tolerant-expandable), because the
   * zero-dates ruling turns on "is this a series", not on "can we phrase it"
   * or "can we re-expand it". A listing whose `recurrenceSchedule` column holds
   * something corrupt is still a series that should not fall back to the
   * single-date RSVP button. `false` for UNREAD and UNREADABLE — see the
   * output field doc.
   */
  hasSchedule: boolean;
};

type StoredRule = NonNullable<ListEventDatesOutput["storedRule"]>;

/** What we know having deliberately NOT read the Event row: nothing. */
const RECURRENCE_UNREAD: RecurrenceRead = {
  summary: null,
  storedRule: null,
  knowledge: "UNREAD",
  schedule: null,
  timezone: null,
  hasSchedule: false,
};

/** The read threw. Also nothing — but a fault, not a choice. */
const RECURRENCE_UNREADABLE: RecurrenceRead = {
  summary: null,
  storedRule: null,
  knowledge: "UNREADABLE",
  schedule: null,
  timezone: null,
  hasSchedule: false,
};

/** The row was read and holds nothing occurrences can be generated from. */
const NO_SCHEDULE: RecurrenceRead = {
  summary: null,
  storedRule: null,
  knowledge: "KNOWN",
  schedule: null,
  timezone: null,
  hasSchedule: false,
};

/**
 * Does `dates` stop short of the end of the series?
 *
 * Answered by asking the SCHEDULE, not by measuring the list: expand the stored
 * rule starting at the last returned row and see whether anything is there.
 * That is the same question the write path asks ("what does this schedule
 * produce"), so the flag cannot drift from what materialisation would do.
 *
 * Two earlier predicates were wrong and are deliberately gone:
 *
 *  - **The row count.** `rowCount >= MAX_DATES` DECAYS. The 60-occurrence cap
 *    is a property of the WRITE (`applyRecurrenceForEvent` expands at most
 *    `RECURRENCE_MAX_OCCURRENCES` from ITS `now`), while `listUpcoming` returns
 *    only rows still in the future — so the moment the first of those 60
 *    occurrences starts, the live count is 59 and a count-based predicate flips
 *    to `false`. It now survives ONLY as a cheap short-circuit for a full page,
 *    where it is a hair conservative for a series of exactly `MAX_DATES` (the
 *    probe would say `false`) — the safe direction.
 *  - **The materialisation window / the rule's UNTIL.** The window
 *    (`RECURRENCE_WINDOW_MONTHS`) is pinned at WRITE time, and an UNTIL inside
 *    it says nothing about how many occurrences BEFORE it actually got rows: a
 *    Mon–Fri weekly rule ending nine months out has ~145 occurrences and
 *    materialises 60 of them, ending under three months out. "UNTIL is inside
 *    the window" called that complete, so the page printed "59 dates through
 *    Sep 2026" for a series running to the following March.
 *
 * CANCELLED ROWS ARE IN `upcoming` NOW, and they change nothing here — which
 * is worth stating, because the obvious worry ("a trailing cancelled date
 * makes a live series look finished") does not survive contact with how this
 * is computed. The probe asks the RULE what follows an INSTANT; it never asks
 * the rows what they are. A called-off night is still an instant the rule
 * produced, so probing from it returns the same next occurrence it would have
 * returned from the live version of that night.
 *
 * Both directions hold:
 *  - a live series whose last materialised night is cancelled still probes to
 *    the next occurrence → `true`. It cannot look finished.
 *  - a series whose final night is cancelled probes past its own UNTIL/COUNT
 *    and finds nothing → `false`. It cannot look live.
 *
 * The one row that is NOT on the rule is a date the reconcile pass preserved
 * because it carried RSVPs when a rule change dropped it. If such a row sits
 * LATER than every remaining rule occurrence, the probe finds nothing after it
 * and answers `false` — which is correct: the rule's last occurrence is
 * already in `dates`, so `dates` really does reach the end of the series.
 *
 * The `>= MAX_DATES` short-circuit now counts cancelled rows toward the cap, so
 * a series of exactly MAX_DATES with cancellations among them can answer `true`
 * where the probe would have said `false`. That is the conservative direction
 * (vague, never an invented end date) and is left alone.
 *
 * Three inputs cannot be probed at all, and they answer differently:
 *  - `includeRecurrence: false` → the row cap alone. The caller opted out of
 *    the Event read and ignores this field (see that input).
 *  - the Event read threw → `true`. Uncertain, and the unsafe direction is a
 *    missed `true`: that is what prints a horizon the series does not have.
 *    A degraded read makes the page vague, never wrong.
 *  - the row holds no schedule, or holds something that is not one → `false`.
 *    Nothing generates occurrences, so the rows in hand really are all of them.
 *    A corrupt column answers exactly as the write path would — "this produces
 *    nothing" — which is also why FIXED_DATES needs no special case: its dates
 *    are authored, and the probe reads them back.
 */
function isTruncated(args: {
  upcoming: ReadonlyArray<{ startsAt: Date }>;
  read: RecurrenceRead;
  now: Date;
}): boolean {
  // Cheap short-circuit: a full page means the read itself stopped early.
  if (args.upcoming.length >= MAX_DATES) {
    return true;
  }
  if (args.read.knowledge === "UNREAD") {
    return false;
  }
  if (args.read.knowledge === "UNREADABLE") {
    return true;
  }
  const { schedule, timezone } = args.read;
  if (!schedule || !timezone) {
    return false;
  }

  // Probe from the last row INCLUSIVE — `expandRecurrenceDates` compares bounds
  // in floating wall-clock space, so an exclusive bound nudged off the row's
  // instant could land on the far side of its own occurrence across a DST
  // shift. Inclusive means the first slot may be consumed by that occurrence
  // itself, so ask for two and keep only a STRICTLY later one.
  //
  // With no rows at all the question is simply "does this schedule still yield
  // anything", and any answer is an occurrence the list does not show.
  const lastStartsAtMs = args.upcoming.at(-1)?.startsAt.getTime() ?? null;
  const probed = expandRecurrenceDates(schedule, {
    windowStart: lastStartsAtMs == null ? args.now : new Date(lastStartsAtMs),
    windowEnd: DateTime.fromJSDate(args.now)
      .plus({ years: PROBE_HORIZON_YEARS })
      .toJSDate(),
    max: lastStartsAtMs == null ? 1 : 2,
    timezone,
  });

  return probed.some(
    (occurrence) =>
      lastStartsAtMs == null || occurrence.startsAt.getTime() > lastStartsAtMs,
  );
}

/**
 * The stored column as something {@link expandRecurrenceDates} can read, or
 * `null` when it is not a schedule at all. Shape-tolerant on purpose — this is
 * raw JSON, and a legacy `EventSeriesSchedule` row may carry extra members the
 * strict write-path schema would reject.
 */
function asExpandableSchedule(schedule: unknown): EventSeriesSchedule | null {
  if (!schedule || typeof schedule !== "object") {
    return null;
  }
  const { kind } = schedule as { kind?: unknown };
  if (kind !== "RRULE" && kind !== "FIXED_DATES") {
    return null;
  }
  return schedule as EventSeriesSchedule;
}

/**
 * The stored RRULE schedule as the editor needs it, or `null` when it is not
 * one. The rule string is verbatim — it is what the write path expands, so an
 * editor seeded with it opens on exactly the rule that produced the rows
 * beside it — and the two instants are normalised (see the output field doc).
 * Shape-tolerant like {@link asExpandableSchedule} — this is raw JSON.
 */
function asStoredRule(
  schedule: EventSeriesSchedule | null,
  timezone: string,
): StoredRule | null {
  if (!schedule || schedule.kind !== "RRULE") {
    return null;
  }
  const { rrule, dtstart, until } = schedule;
  if (typeof rrule !== "string" || rrule.trim().length === 0) {
    return null;
  }
  const dtstartIso = toInstantIso(dtstart, timezone);
  if (!dtstartIso) {
    return null;
  }
  return { rrule, dtstart: dtstartIso, until: toInstantIso(until, timezone) };
}

/**
 * A stored wall-clock-or-offset string as a UTC ISO instant, parsed the way
 * {@link expandRecurrenceDates} parses it (`DateTime.fromISO` in the event's
 * zone), or `null` when it is absent or unparseable.
 *
 * One hair of difference from expansion: expansion keeps only the wall-clock
 * fields and resolves them itself, taking the EARLIER offset in a fall-back
 * repeated hour, while this takes Luxon's own instant, which can be the later
 * one. Reachable only by an offset-less string inside that one hour a year,
 * which no web writer produces (the builder always emits an offset) and the
 * local-basis migration refuses.
 */
function toInstantIso(value: unknown, timezone: string): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const parsed = DateTime.fromISO(value, { zone: timezone });
  return parsed.isValid ? parsed.toUTC().toISO() : null;
}

/**
 * Loads the event and summarises its stored recurrence. NEVER REJECTS.
 *
 * The cadence line is decoration for a list that renders fine without it, and
 * this sits on the public event page's critical path, so a vanished event, a
 * DB hiccup or a corrupt `recurrenceSchedule` degrade to `null` rather than
 * failing the read. Swallowed failures are reported (ReporterPort convention)
 * so the degrade is visible to operators instead of silent; a missing event is
 * NOT reported — that is an ordinary 404-shaped outcome, not a fault.
 *
 * A failed read reports `knowledge: "UNREADABLE"`, which makes truncation
 * answer `true`: with no schedule to probe we cannot claim the list is
 * complete, and a vague page beats one that invents an end date.
 *
 * The stored JSON is deliberately NOT run through `recurrenceScheduleSchema`
 * first: that schema is `.strict()` and rejects the `windowStart` / `windowEnd`
 * members a legacy `EventSeriesSchedule` row may carry, which would blank the
 * cadence line for a rule that expands perfectly well. `summarizeRecurrence`
 * is shape-tolerant and fails closed on its own, so the write path keeps the
 * strict validation and the read path stays generous.
 */
async function readRecurrenceSummary(
  deps: ListEventDatesDeps,
  eventId: string,
): Promise<RecurrenceRead> {
  try {
    const event = await deps.repos.events.getById(eventId);
    if (!event?.recurrenceSchedule) {
      return NO_SCHEDULE;
    }
    const schedule = asExpandableSchedule(event.recurrenceSchedule);
    return {
      summary: summarizeRecurrence(event.recurrenceSchedule, {
        timezone: event.timezone,
      }),
      storedRule: asStoredRule(schedule, event.timezone),
      knowledge: "KNOWN",
      schedule,
      timezone: event.timezone,
      // The column is non-null: this listing IS a series, whether or not the
      // JSON turns out to be summarisable or even expandable.
      hasSchedule: true,
    };
  } catch (err) {
    deps.logger?.error("listEventDates.recurrenceSummaryFailed", {
      eventId,
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      deps.reportError?.(err, {
        tags: { useCase: "listEventDates", step: "recurrenceSummary" },
        extra: { eventId },
      });
    } catch {
      // Reporting is best-effort — a throwing reporter must never turn the
      // graceful null fallback into a thrown error.
    }
    return RECURRENCE_UNREADABLE;
  }
}
