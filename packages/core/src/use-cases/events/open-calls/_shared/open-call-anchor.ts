import { fail } from "@th/errors";
import type { LoggerPort } from "@th/ports/logger";
import type { TxRepos } from "@th/ports/repos";
import type { EventSeriesRecord } from "@th/ports/repos/event-series";
import type {
  EventRecord,
  OpenCallAnchor,
  OpenCallFormRecord,
} from "@th/ports/repos/events";

import { ensureActorCanEditEvent } from "../../_shared/ensure-actor-can-edit-event";
import { ensureSeriesOwnerAccess } from "../../../series/permissions";

/**
 * What an open call hangs off, loaded (open calls Q40: "a call will belong to
 * a series or an event. It's basically an extension of an event").
 */
export type OpenCallAnchorContext =
  | { kind: "event"; event: EventRecord }
  | { kind: "series"; series: EventSeriesRecord };

/** The anchor named by a form row. Exactly one of eventId / seriesId is set. */
export function anchorOfForm(
  form: Pick<OpenCallFormRecord, "eventId" | "seriesId">,
): OpenCallAnchor {
  if (form.eventId) return { kind: "event", eventId: form.eventId };
  if (form.seriesId) return { kind: "series", seriesId: form.seriesId };
  // The SQL CHECK makes this unreachable; fail closed if it ever isn't.
  throw fail("OPEN_CALL_NOT_FOUND");
}

/** Event statuses whose night is over or off. */
const ENDED_EVENT_STATUSES: ReadonlySet<string> = new Set([
  "CANCELLED",
  "ARCHIVED",
  "COMPLETED",
]);

/** Series occurrence statuses that are a live night. */
export const LIVE_OCCURRENCE_STATUSES = ["PLANNED", "GENERATED", "PUBLISHED"] as const;

/** True when the anchor itself is over: event cancelled / archived / completed, series archived. */
export function anchorEnded(anchor: OpenCallAnchorContext): boolean {
  return anchor.kind === "event"
    ? ENDED_EVENT_STATUSES.has(anchor.event.status)
    : anchor.series.archivedAt !== null;
}

/**
 * Load the anchor for a PUBLIC or system read (no auth). A missing event or
 * series answers OPEN_CALL_NOT_FOUND, the same as a missing call.
 */
export async function loadOpenCallAnchor(
  repos: Pick<TxRepos, "events" | "series">,
  form: Pick<OpenCallFormRecord, "eventId" | "seriesId">,
): Promise<OpenCallAnchorContext> {
  const anchor = anchorOfForm(form);
  if (anchor.kind === "event") {
    const event = await repos.events.getById(anchor.eventId);
    if (!event) throw fail("OPEN_CALL_NOT_FOUND");
    return { kind: "event", event };
  }
  const series = await repos.series.getById(anchor.seriesId);
  if (!series) throw fail("OPEN_CALL_NOT_FOUND");
  return { kind: "series", series };
}

/**
 * Series edit rights (the series builder's bar): the owner or an edit-role
 * delegate for a person's series, an ORG_EDIT_ROLES member for an org's.
 */
export async function ensureActorCanEditSeries(
  tx: TxRepos,
  seriesId: string,
  actorHumanId: string,
  logger?: LoggerPort,
): Promise<EventSeriesRecord> {
  const series = await tx.series.getById(seriesId);
  if (!series) throw fail("SERIES_NOT_FOUND");
  await ensureSeriesOwnerAccess(
    tx,
    series.ownerScope,
    series.ownerId,
    actorHumanId,
    { purpose: "edit" },
    logger,
  );
  return series;
}

/**
 * Edit rights on the call's anchor: event edit rights for an event call,
 * series edit rights for a series call (FR-001, FR-005).
 */
export async function ensureActorCanEditOpenCallAnchor(
  tx: TxRepos,
  form: Pick<OpenCallFormRecord, "eventId" | "seriesId">,
  actorHumanId: string,
  logger?: LoggerPort,
): Promise<OpenCallAnchorContext> {
  const anchor = anchorOfForm(form);
  if (anchor.kind === "event") {
    const event = await ensureActorCanEditEvent(tx, anchor.eventId, actorHumanId);
    return { kind: "event", event };
  }
  const series = await ensureActorCanEditSeries(
    tx,
    anchor.seriesId,
    actorHumanId,
    logger,
  );
  return { kind: "series", series };
}

/**
 * One date an applicant can be booked for. For an event call: one of the
 * event's SCHEDULED EventDate rows, or the event itself when it has none.
 * For a series call: a live occurrence (PLANNED / GENERATED / PUBLISHED),
 * with the event it was materialised into, if any.
 */
export interface OpenCallDate {
  startsAt: Date;
  endsAt: Date | null;
  eventId: string | null;
  eventDateId: string | null;
  occurrenceId: string | null;
}

/**
 * The call's dates (Q2: the event's dates are the dates applicants choose
 * from; Q40: a series call's dates are the series' dates), ascending.
 * `upcomingOnly` keeps dates that start strictly after `now`.
 */
export async function listOpenCallDates(
  repos: Pick<TxRepos, "eventDates" | "seriesOccurrences" | "events">,
  anchor: OpenCallAnchorContext,
  options: { now: Date; upcomingOnly: boolean },
): Promise<OpenCallDate[]> {
  const after = (d: { startsAt: Date }) =>
    !options.upcomingOnly || d.startsAt.getTime() > options.now.getTime();

  if (anchor.kind === "event") {
    const event = anchor.event;
    // ALL rows, not just SCHEDULED ones: the event's own start is the
    // fallback only for an event with NO date rows at all. An event whose
    // rows are all CANCELLED has no live date, so its call reads as ended.
    const rows = await repos.eventDates.listByEvent({ eventId: event.id });
    const scheduled = rows.filter((row) => row.status === "SCHEDULED");
    const dates: OpenCallDate[] =
      rows.length > 0
        ? scheduled.map((row) => ({
            startsAt: row.startsAt,
            endsAt: row.endsAt,
            eventId: event.id,
            eventDateId: row.id,
            occurrenceId: null,
          }))
        : [
            {
              startsAt: event.startsAt,
              endsAt: event.endsAt,
              eventId: event.id,
              eventDateId: null,
              occurrenceId: null,
            },
          ];
    return dates
      .filter(after)
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  }

  const occurrences = await repos.seriesOccurrences.listBySeriesAndStatuses(
    anchor.series.id,
    [...LIVE_OCCURRENCE_STATUSES],
    options.upcomingOnly ? options.now : new Date(0),
  );
  // A night whose materialised event was CANCELLED is off, even while its
  // occurrence row still reads live (cancelling the event alone does not
  // touch the occurrence). The sweep's SQL (listOpenCallSweepDue) applies
  // the same rule.
  const materialised = [
    ...new Set(occurrences.map((o) => o.eventId).filter((id): id is string => id !== null)),
  ];
  const cancelled = new Set(
    materialised.length > 0
      ? (await repos.events.findManyByIds(materialised))
          .filter((e) => e.status === "CANCELLED")
          .map((e) => e.id)
      : [],
  );
  return occurrences
    .filter((o) => o.eventId === null || !cancelled.has(o.eventId))
    .map((o) => ({
      startsAt: o.startsAt,
      endsAt: o.endsAt,
      eventId: o.eventId,
      eventDateId: null,
      occurrenceId: o.id,
    }))
    .filter(after)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/**
 * Why a call is over regardless of the Close button: its anchor ended
 * (FR-022, cancelled / archived), or its last date has started (FR-021).
 * Null while the anchor still has an upcoming date.
 */
export type OpenCallEndedReason = "event_ended" | "last_date_started";

export async function openCallEndedReason(
  repos: Pick<TxRepos, "eventDates" | "seriesOccurrences" | "events">,
  anchor: OpenCallAnchorContext,
  now: Date,
): Promise<{ reason: OpenCallEndedReason | null; upcoming: OpenCallDate[] }> {
  if (anchorEnded(anchor)) return { reason: "event_ended", upcoming: [] };
  const upcoming = await listOpenCallDates(repos, anchor, {
    now,
    upcomingOnly: true,
  });
  return {
    reason: upcoming.length === 0 ? "last_date_started" : null,
    upcoming,
  };
}

/**
 * The series a dated event belongs to, through its occurrence link. A
 * DETACHED occurrence (an event split off its series) is no longer one of
 * the series' nights, so it answers null.
 */
export async function findEventSeriesLink(
  repos: Pick<TxRepos, "seriesOccurrences">,
  eventId: string,
): Promise<{ seriesId: string; occurrenceId: string } | null> {
  const [info] = await repos.seriesOccurrences.getCalendarInfoForEventIds([eventId]);
  if (!info) return null;
  const occurrence = await repos.seriesOccurrences.getById(info.occurrenceId);
  if (!occurrence || occurrence.status === "DETACHED") return null;
  return { seriesId: info.seriesId, occurrenceId: info.occurrenceId };
}

/**
 * The open call that covers an event (FR-001): the event's OWN call if it
 * has one, else the call of the series it belongs to, else null. Steps 4+
 * (applying, the call tab of a dated event) read the call through this, so
 * "an act never applies twice for one night".
 *
 * `postedOnly` is required so every caller chooses (owner ruling Q41: a
 * saved call is a DRAFT until posted):
 *   - public and applicant callers (the call page, applying, the event
 *     page's "open call" link) MUST pass `postedOnly: true`, so a draft is
 *     never served or applied to;
 *   - the organizer's call tab passes `postedOnly: false`, so the draft it
 *     is editing is found.
 * An event's own call and its series' call never coexist (writeOpenCall
 * refuses the second), so skipping a draft never surfaces a different call
 * for the same night.
 */
export async function resolveOpenCallForEvent(
  repos: Pick<TxRepos, "eventApplications" | "seriesOccurrences">,
  eventId: string,
  options: { postedOnly: boolean },
): Promise<{ form: OpenCallFormRecord; via: "event" | "series" } | null> {
  const visible = (form: OpenCallFormRecord | null): form is OpenCallFormRecord =>
    form !== null && (!options.postedOnly || form.postedAt !== null);
  const own = await repos.eventApplications.getOpenCall({ kind: "event", eventId });
  if (visible(own)) return { form: own, via: "event" };
  const link = await findEventSeriesLink(repos, eventId);
  if (!link) return null;
  const seriesCall = await repos.eventApplications.getOpenCall({
    kind: "series",
    seriesId: link.seriesId,
  });
  return visible(seriesCall) ? { form: seriesCall, via: "series" } : null;
}
