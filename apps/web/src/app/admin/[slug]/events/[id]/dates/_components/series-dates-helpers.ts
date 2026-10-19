// Pure derivation + formatting helpers behind the admin Dates page
// (recurring-series redesign Phase 2). Kept free of React/Tamagui so the unit
// suite imports the REAL functions — no mirrored local copies (same
// discipline as recurrence-helpers.ts).

import { parseRrule } from "../../../new/_components/recurrence-helpers";

// ── Row shape (structural mirror of series.listSeriesDatesForAdmin items) ──

export type SeriesDateOccurrenceStatus =
  | "PLANNED"
  | "SKIPPED"
  | "GENERATED"
  | "PUBLISHED"
  | "CANCELLED"
  | "DETACHED";

export type SeriesDateEventSummary = {
  eventId: string;
  title: string;
  slug: string | null;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED" | "CANCELLED" | "COMPLETED";
  ticketTypeCount: number;
  soldCount: number;
};

export type SeriesDateRow = {
  occurrenceId: string;
  startsAt: Date;
  endsAt: Date | null;
  status: SeriesDateOccurrenceStatus;
  manual: boolean;
  skipNote: string | null;
  note: string | null;
  event: SeriesDateEventSummary | null;
};

// ── Row state → pill + actions + meta ──────────────────────────────────────

/**
 * The Dates page's visual row states. Derived from the occurrence status plus
 * the linked event's readiness:
 *   - `published`     PUBLISHED occurrence → green pill, sold count, [Open]
 *   - `draft-ready`   GENERATED + ticket types copied → amber pill,
 *                     "Ready — tickets copied", [Open][Publish]
 *   - `draft-unready` GENERATED + zero ticket types → amber pill,
 *                     "Tickets not set up", [Open] (publish withheld)
 *   - `planned`       PLANNED → outline pill, "No draft yet",
 *                     [Create draft][Skip]
 *   - `skipped`       SKIPPED → struck muted date, skip note, [Restore]
 *   - `cancelled`     CANCELLED → red pill, [Open] when an event remains
 *   - `completed`     GENERATED whose event already COMPLETED → ink pill,
 *                     sold count, [Open]
 *   - `archived`      GENERATED whose event was ARCHIVED → ghost pill, [Open]
 *   - `detached`      DETACHED, or a GENERATED row whose event record is
 *                     gone (generate-events SKIPS occurrences that already
 *                     link an event id, so [Create draft] cannot repair it —
 *                     terminal/degraded; meta explains the missing draft)
 */
export type SeriesDateRowKind =
  | "published"
  | "draft-ready"
  | "draft-unready"
  | "planned"
  | "skipped"
  | "cancelled"
  | "completed"
  | "archived"
  | "detached";

export function deriveRowKind(row: SeriesDateRow): SeriesDateRowKind {
  switch (row.status) {
    case "PUBLISHED":
      return "published";
    case "GENERATED":
      // Event record gone: terminal/degraded. generateEventsFromSeries skips
      // occurrences that already carry an event link, so offering
      // [Create draft] here would no-op forever.
      if (!row.event) return "detached";
      // Out-of-sync guards: if the linked event already moved past DRAFT
      // (published / cancelled / completed / archived individually), reflect
      // the event's truth instead of offering a Publish the server rejects.
      if (row.event.status === "PUBLISHED") return "published";
      if (row.event.status === "CANCELLED") return "cancelled";
      if (row.event.status === "COMPLETED") return "completed";
      if (row.event.status === "ARCHIVED") return "archived";
      return row.event.ticketTypeCount > 0 ? "draft-ready" : "draft-unready";
    case "PLANNED":
      return "planned";
    case "SKIPPED":
      return "skipped";
    case "CANCELLED":
      return "cancelled";
    case "DETACHED":
      return "detached";
  }
}

/**
 * Whether the occurrence's start is already in the past. Instant comparison —
 * timezone-independent. Used to suppress [Create draft] on past planned rows:
 * the generate use case refuses past dates, so the button would only ever
 * produce a "couldn't create" warning.
 */
export function isPastRow(row: SeriesDateRow, now: Date = new Date()): boolean {
  return row.startsAt.getTime() < now.getTime();
}

/**
 * Organizer note on a manually-added date ("added" rows) — rendered under the
 * row meta. Null for schedule-generated rows (their `note` is unused today).
 */
export function deriveManualNote(row: SeriesDateRow): string | null {
  return row.manual && row.note ? row.note : null;
}

/**
 * "Ready" for the bulk-publish bar: a draft event exists AND its ticket
 * types were copied. Drafts with zero ticket types are the "Tickets not set
 * up" state and are deliberately excluded — publishing them would go live
 * with nothing to sell.
 */
export function isReadyDraft(row: SeriesDateRow): boolean {
  return (
    row.status === "GENERATED" &&
    row.event?.status === "DRAFT" &&
    row.event.ticketTypeCount > 0
  );
}

export function readyDraftRows(rows: SeriesDateRow[]): SeriesDateRow[] {
  return rows.filter(isReadyDraft);
}

/** Meta line under/next to the date — resolved to i18n by the view. */
export type SeriesDateRowMeta =
  | { kind: "sold"; count: number }
  | { kind: "ready" }
  | { kind: "notSetUp" }
  | { kind: "noDraftYet" }
  | { kind: "skipNote"; note: string }
  | { kind: "draftMissing" }
  | { kind: "none" };

export function deriveRowMeta(row: SeriesDateRow): SeriesDateRowMeta {
  // Degraded GENERATED row: the occurrence claims an event that no longer
  // exists. Say so — a bare "Detached" pill alone would read as intentional.
  if (row.status === "GENERATED" && !row.event) {
    return { kind: "draftMissing" };
  }
  switch (deriveRowKind(row)) {
    case "published":
    case "completed":
      return { kind: "sold", count: row.event?.soldCount ?? 0 };
    case "draft-ready":
      return { kind: "ready" };
    case "draft-unready":
      return { kind: "notSetUp" };
    case "planned":
      return { kind: "noDraftYet" };
    case "skipped":
      return row.skipNote
        ? { kind: "skipNote", note: row.skipNote }
        : { kind: "none" };
    case "cancelled":
    case "archived":
    case "detached":
      return { kind: "none" };
  }
}

// ── Date formatting (series timezone, mono uppercase) ──────────────────────

/**
 * "FRI JUL 31" — the row's mono date, formatted in the SERIES timezone (not
 * the browser's). The year is appended only when the occurrence falls outside
 * `now`'s year in that timezone, so a season-long series stays terse.
 * Uppercasing happens here (not CSS) because the string feeds a mono slot
 * whose width budget assumes caps.
 */
export function formatRowDate(
  date: Date,
  timeZone: string,
  locale: string,
  now: Date = new Date(),
): string {
  const yearOf = (d: Date) =>
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(d);
  const withYear = yearOf(date) !== yearOf(now);
  const label = new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" as const } : {}),
  }).format(date);
  return label.replace(/[.,]/g, "").toLocaleUpperCase(locale);
}

/** "8:00 PM" — wall-clock time in the series timezone. */
export function formatRowTime(
  date: Date,
  timeZone: string,
  locale: string,
): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  })
    .format(date)
    .toLocaleUpperCase(locale);
}

/** "OCT 16" (+ year when outside now's year) — schedule "through" date. */
export function formatThroughDate(
  untilIso: string,
  timeZone: string,
  locale: string,
  now: Date = new Date(),
): string | null {
  const parsed = new Date(untilIso);
  if (Number.isNaN(parsed.getTime())) return null;
  const yearOf = (d: Date) =>
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(d);
  const withYear = yearOf(parsed) !== yearOf(now);
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" as const } : {}),
  })
    .format(parsed)
    .replace(/[.,]/g, "")
    .toLocaleUpperCase(locale);
}

/** Full weekday name ("Friday") in the series timezone, for the rule text. */
export function weekdayNameInTimeZone(
  date: Date,
  timeZone: string,
  locale: string,
): string {
  return new Intl.DateTimeFormat(locale, { timeZone, weekday: "long" }).format(
    date,
  );
}

// ── Schedule summary descriptor ────────────────────────────────────────────

/**
 * Coarse natural-language classification of the series schedule for the
 * header's mono summary line. `weekly` carries the interval so the view can
 * render "Every Friday" / "Every other Friday" / "Every N weeks"; anything
 * the simple grammar can't say honestly degrades to `custom`.
 */
export type ScheduleDescriptor =
  | { kind: "weekly"; interval: number }
  | { kind: "daily"; interval: number }
  | { kind: "monthly"; interval: number }
  | { kind: "fixed" }
  | { kind: "custom" };

export function describeSchedule(schedule: {
  kind: "RRULE" | "FIXED_DATES";
  rrule: string | null;
}): ScheduleDescriptor {
  if (schedule.kind === "FIXED_DATES" || !schedule.rrule) {
    return { kind: "fixed" };
  }
  const rule = parseRrule(schedule.rrule);
  if (!rule) return { kind: "custom" };
  const interval = rule.interval ?? 1;
  switch (rule.freq) {
    case "DAILY":
      return { kind: "daily", interval };
    case "WEEKLY":
      // Multiple weekdays can't be said as "Every <weekday>" — be honest.
      if ((rule.byday?.length ?? 0) > 1) return { kind: "custom" };
      return { kind: "weekly", interval };
    case "MONTHLY":
      return { kind: "monthly", interval };
    default:
      return { kind: "custom" };
  }
}

// ── Bulk publish summary ───────────────────────────────────────────────────

export type BulkPublishOutcome = {
  published: number;
  failed: number;
  /** First failure's user-facing message (per-item error tolerance). */
  firstFailureReason: string | null;
};

export function summarizeBulkPublish(
  results: Array<{ ok: true } | { ok: false; reason: string }>,
): BulkPublishOutcome {
  let published = 0;
  let failed = 0;
  let firstFailureReason: string | null = null;
  for (const result of results) {
    if (result.ok) {
      published += 1;
    } else {
      failed += 1;
      if (firstFailureReason === null) firstFailureReason = result.reason;
    }
  }
  return { published, failed, firstFailureReason };
}
