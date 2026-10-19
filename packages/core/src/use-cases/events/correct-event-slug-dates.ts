import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";

import { describeError, parseInput } from "../../lib/io";
import { markForSearchReindex } from "../search/search-reindex-marks";
import { formatEventSlugDateSegment } from "./_shared/slug";
import { mapSlugUpdateError } from "./regenerate-event-slug";

/**
 * Rewrites the date segment of slugs minted before ba1a3df50, when the
 * segment was the UTC start instead of the LOCAL start in `Event.timezone`
 * (a 7pm Chicago show on Mon 12 Oct had `…-2026-10-13-0000--<shortId>`).
 * Owner ruling 2026-10-15: rewrite them; old URLs keep resolving through
 * `EventSlugHistory`.
 *
 * A SYSTEM operation: no human actor and no RBAC. It is run by
 * `apps/api/src/scripts/backfill/correct-event-slug-dates.ts`, one keyset page
 * per call. Dry run unless `apply: true`.
 *
 * Per event, against the slug's `YYYY-MM-DD-HHmm` segment:
 *   - equals the local rendering of the current start → `already_correct`;
 *   - equals the UTC rendering (and that differs from local) → `corrected`:
 *     ONLY the date segment is replaced. Host, region and title are kept as
 *     they are; they may differ from a fresh derivation on purpose;
 *   - with `utcMintedBefore` set, for an event created before it: the
 *     segment ITSELF is read as a UTC instant T and re-rendered in the
 *     event's zone → `corrected` with `basis: "slug_instant"` (see below);
 *   - anything else → `start_moved` (the start changed after the slug was
 *     made). Left alone and reported;
 *     One case can't be told apart: a slug minted in local time whose start
 *     later moved by exactly the zone's UTC offset reads as a UTC slug and
 *     is `corrected`. That is accepted: the result is still the real local
 *     start, and the old URL redirects through history.
 *   - no `-YYYY-MM-DD-HHmm--<shortId>` tail → `unparseable`.
 *
 * The rule is "segment === UTC rendering", not "dates differ": a 14:00 CDT
 * show is 19:00Z, same date, but its old segment `…-1900` is still wrong.
 *
 * `basis: "slug_instant"` (opt-in, `utcMintedBefore`). A recurring series'
 * `Event.startsAt` mirrors its NEXT upcoming occurrence, so a slug minted from
 * the first occurrence never matches the current start and the rule above
 * calls it `start_moved` (17 of them in the prod dry run of 2026-10-15). But
 * until ba1a3df50 was deployed EVERY slug was minted in UTC, so for an event
 * created before that deploy, reading the segment as a UTC instant is exact:
 * it is the instant the slug was minted from, whatever the start is now.
 * Rendering that instant in `Event.timezone` gives the right local segment.
 * An event created at/after the cutoff has a local slug and is never
 * reinterpreted. A segment that is not a real date/time (month 13, 24:00)
 * stays `start_moved`, as does one whose local rendering equals the segment.
 *   WHEN WAS THE CURRENT SLUG MINTED? The segment may only be read as UTC
 *   if the CURRENT slug was minted before the cutoff. The event's newest
 *   slug-writing audit row decides it (`slugInstantGate`, under the row lock
 *   on apply, identically in the dry run). The slug writers and their rows:
 *   `event.slug_assigned` (create, publish), `event.slug_rederived_at_publish`
 *   (first publish), `event.slug_regenerated` (organiser), and this
 *   backfill's own `event.slug_date_corrected`.
 *     - no such row → the slug dates from creation: `createdAt < cutoff`
 *       (already required above) means UTC → reinterpreted;
 *     - any `event.slug_date_corrected` row whose `newSlug` is the current
 *       slug → `already_correct`, checked FIRST and regardless of order (our
 *       rows carry the operator's clock, the app's the server's);
 *     - newest is `event.slug_date_corrected` → this backfill wrote the
 *       current slug, a LOCAL segment; reading it as UTC would shift it again
 *       → `already_correct`. This is what makes `slug_instant` idempotent. It
 *       also stops a series corrected by `current_start` from being
 *       reinterpreted once its start moves on to a later occurrence;
 *     - newest is another writer, `at >= cutoff` → minted locally after the
 *       deploy (say a draft from 10-01 first published after it) →
 *       `minted_after_cutoff`, left alone;
 *     - newest is another writer, `at < cutoff` → minted in UTC →
 *       reinterpreted. So an event this backfill corrected and that OLD code
 *       then re-minted in UTC (a run before the deploy) is fixed by the next
 *       run after it.
 *   RESIDUAL RISK: a slug written with NO audit row after the deploy reads as
 *   "minted at creation". Known writer: the one-off
 *   `apps/api/src/scripts/backfill/backfill-event-slugs.ts` (plain
 *   `prisma.event.update`). Do not run it between the deploy and this
 *   backfill, or check its events by hand. The cutoff must also be no later
 *   than the deploy of ba1a3df50; the dry run's `slug_instant` rows are worth
 *   eyeballing before apply. Without the flag nothing reads the audit. The
 *   lookup filters on `entityId` with no index behind it, which is fine at
 *   this volume: it runs only for `slug_instant` candidates.
 *
 * Applying is one transaction per event (row lock, re-read, re-classify, then
 * history + slug + audit + per-event reindex mark when PUBLISHED). A failing
 * event is collected as `failed` and reported, and the batch continues.
 *
 * SCHEMA-NARROW: every read and write touches only the columns it needs, so
 * the backfill runs against a database whose `Event` table is BEHIND the
 * Prisma schema (prod before its migrations deploy; a full `getById` there
 * failed with "The column (not available) does not exist"). So the re-read is
 * `getSlugDateRow` and the write `setSlugOnly`, never `getById` /
 * `updateSlug` (both use the full event select). The other writes are narrow
 * already: `lockRows` is `SELECT id … FOR UPDATE`; `recordSlugHistory`,
 * `audit.log` and `markForSearchReindex` write their own tables
 * (`EventSlugHistory`, `AuditLog`, `SearchReindexPending`), not `Event`.
 * IDEMPOTENT. A `current_start` correction is idempotent by itself: the new
 * segment IS the local rendering of the current start, so the next run calls
 * it `already_correct` without reading anything else. A `slug_instant`
 * correction is idempotent only through the audit-row gate above.
 */

export const SLUG_DATE_CORRECTED_AUDIT_ACTION = "event.slug_date_corrected";

/**
 * Every audit action written in the same transaction as a change to
 * `Event.slug` (assign-slug-on-create, publish-event, regenerate-event-slug,
 * and this backfill). Adding a slug writer means adding its action here.
 */
export const SLUG_WRITING_AUDIT_ACTIONS: ReadonlySet<string> = new Set([
  "event.slug_assigned",
  "event.slug_rederived_at_publish",
  "event.slug_regenerated",
  SLUG_DATE_CORRECTED_AUDIT_ACTION,
]);
/** Contains-filter prefix shared by every action above. */
const SLUG_AUDIT_ACTION_PREFIX = "event.slug_";
const AUDIT_PAGE = 100;

/** `-YYYY-MM-DD-HHmm--<shortId>` at the end; shortIds are `[a-z0-9]` only. */
const SLUG_DATE_TAIL = /-(\d{4}-\d{2}-\d{2}-\d{4})--([a-z0-9]+)$/;

export const correctEventSlugDatesInputSchema = z
  .object({
    /** Keyset cursor: the last event id of the previous page. */
    afterId: z.string().min(1).max(64).nullable().default(null),
    limit: z.number().int().min(1).max(500).default(200),
    /** False (the default) = dry run: classify, write nothing. */
    apply: z.boolean().default(false),
    /**
     * Opt-in: events created strictly before this instant had their slug
     * minted in UTC, so a segment matching neither rendering of the current
     * start is read as a UTC instant (`basis: "slug_instant"`). Must be no
     * later than the deploy of ba1a3df50, and not in the future. Null (the
     * default) = the current-start rule only.
     */
    utcMintedBefore: z.date().nullable().default(null),
  })
  .strict();

export type CorrectEventSlugDatesInput = z.input<
  typeof correctEventSlugDatesInputSchema
>;

export type SlugDateOutcome =
  | "corrected"
  | "already_correct"
  | "start_moved"
  | "unparseable"
  /**
   * A `slug_instant` candidate whose current slug was written at or after
   * `utcMintedBefore` (newest slug-writing audit row), so it is LOCAL already.
   */
  | "minted_after_cutoff"
  /** Deleted or unslugged between the page read and the write. */
  | "gone"
  | "failed";

/**
 * Why a slug was corrected: its segment was the UTC rendering of the CURRENT
 * start, or (opt-in) the segment itself read as a UTC instant.
 */
export type SlugDateBasis = "current_start" | "slug_instant";

export type SlugDateRowResult = {
  eventId: string;
  previousSlug: string;
  /** The corrected slug (written, or would be in a dry run); null otherwise. */
  newSlug: string | null;
  outcome: SlugDateOutcome;
  /** Set on `corrected` rows, and on `failed` rows that were going to be. */
  basis?: SlugDateBasis;
  /** `describeError` of the failure, for `failed` rows only. */
  error?: string;
};

export type CorrectEventSlugDatesOutput = {
  applied: boolean;
  scanned: number;
  counts: Record<SlugDateOutcome, number>;
  rows: SlugDateRowResult[];
  /** Pass as `afterId` for the next page; null when this page was the last. */
  nextAfterId: string | null;
};

export type CorrectEventSlugDatesDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Reports a per-event failure, which is collected rather than thrown. */
  reportError?: ReporterPort;
};

type Classification =
  | { outcome: "corrected"; newSlug: string; basis: SlugDateBasis }
  | { outcome: "already_correct" | "start_moved" | "unparseable" };

const SEGMENT_PARTS = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})$/;

/**
 * The `YYYY-MM-DD-HHmm` segment read as a UTC instant, or null when it is not
 * a real date and time (month 13, 30 Feb, 24:00): the round trip through the
 * UTC rendering must give the segment back.
 */
export function parseSlugSegmentAsUtc(segment: string): Date | null {
  const parts = SEGMENT_PARTS.exec(segment);
  if (!parts) return null;
  const [, y, mo, d, h, mi] = parts.map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const instant = new Date(Date.UTC(y, mo - 1, d, h, mi));
  if (Number.isNaN(instant.getTime())) return null;
  return formatEventSlugDateSegment(instant, "UTC") === segment
    ? instant
    : null;
}

/**
 * Pure: what the correction would do to one slug. The `slug_instant` result
 * is a CANDIDATE: the caller must still check when the current slug was
 * minted (`slugInstantGate`).
 */
export function classifyEventSlugDate(
  row: {
    slug: string;
    startsAt: Date;
    timezone: string | null;
    /** Needed only for `slug_instant`; absent = never reinterpreted. */
    createdAt?: Date | null;
  },
  options: { utcMintedBefore?: Date | null } = {},
): Classification {
  const match = SLUG_DATE_TAIL.exec(row.slug);
  if (!match) {
    return { outcome: "unparseable" };
  }
  const segment = match[1]!;
  // Replace only the matched tail's date; everything before it is kept.
  const withSegment = (next: string) =>
    `${row.slug.slice(0, match.index)}${row.slug
      .slice(match.index)
      .replace(segment, next)}`;

  const localSegment = formatEventSlugDateSegment(row.startsAt, row.timezone);
  if (segment === localSegment) {
    return { outcome: "already_correct" };
  }
  const utcSegment = formatEventSlugDateSegment(row.startsAt, "UTC");
  if (segment === utcSegment) {
    return {
      outcome: "corrected",
      newSlug: withSegment(localSegment),
      basis: "current_start",
    };
  }

  const cutoff = options.utcMintedBefore;
  if (cutoff && row.createdAt && row.createdAt.getTime() < cutoff.getTime()) {
    const mintedFrom = parseSlugSegmentAsUtc(segment);
    if (mintedFrom) {
      const reinterpreted = formatEventSlugDateSegment(
        mintedFrom,
        row.timezone,
      );
      if (reinterpreted !== segment) {
        return {
          outcome: "corrected",
          newSlug: withSegment(reinterpreted),
          basis: "slug_instant",
        };
      }
    }
  }
  return { outcome: "start_moved" };
}

type SlugInstantGate = "allowed" | "already_correct" | "minted_after_cutoff";

/**
 * Decides a `slug_instant` candidate from the event's slug-writing audit rows
 * (see "WHEN WAS THE CURRENT SLUG MINTED?" above). Reads ALL of them (paged;
 * a handful per event), so no limit can truncate the answer. Called inside
 * the apply transaction after the row lock, so a concurrent run's or an
 * organiser's write is seen once it commits.
 *
 * First, regardless of order: if any of this backfill's own rows wrote the
 * CURRENT slug (`data.newSlug`), the slug is ours → `already_correct`. Our
 * rows are stamped by the operator's clock and the app's by the server's, so
 * "newest" alone can misorder them under clock skew. Only then does the
 * newest row decide.
 */
async function slugInstantGate(
  audit: TxRepos["audit"],
  eventId: string,
  currentSlug: string,
  cutoff: Date,
): Promise<SlugInstantGate> {
  const writers: { action: string; at: Date; data: unknown }[] = [];
  for (let offset = 0; ; offset += AUDIT_PAGE) {
    const { items, total } = await audit.list({
      entityId: eventId,
      // Contains-style (ILIKE) in the adapter, where `_` may also act as a
      // LIKE wildcard. Harmless: rows are matched exactly against the
      // allowlist below.
      action: SLUG_AUDIT_ACTION_PREFIX,
      sort: "at_desc",
      limit: AUDIT_PAGE,
      offset,
    });
    for (const item of items) {
      if (
        item.entityId === eventId &&
        SLUG_WRITING_AUDIT_ACTIONS.has(item.action)
      ) {
        writers.push(item);
      }
    }
    if (items.length < AUDIT_PAGE || offset + items.length >= total) break;
  }

  const wroteCurrentSlug = writers.some(
    (w) =>
      w.action === SLUG_DATE_CORRECTED_AUDIT_ACTION &&
      typeof w.data === "object" &&
      w.data !== null &&
      (w.data as { newSlug?: unknown }).newSlug === currentSlug,
  );
  if (wroteCurrentSlug) return "already_correct";

  if (writers.length === 0) {
    // No slug-writing row: minted at creation, which the classifier has
    // already required to be before the cutoff.
    return "allowed";
  }
  const newestAt = Math.max(...writers.map((w) => w.at.getTime()));
  const newest = writers.filter((w) => w.at.getTime() === newestAt);
  // A tie with this backfill's own row: treat the slug as ours (never shift
  // it again). Otherwise every tied row has the same `at`.
  if (newest.some((w) => w.action === SLUG_DATE_CORRECTED_AUDIT_ACTION)) {
    return "already_correct";
  }
  return newestAt >= cutoff.getTime() ? "minted_after_cutoff" : "allowed";
}

export async function correctEventSlugDates(
  deps: CorrectEventSlugDatesDeps,
  rawInput: unknown,
): Promise<CorrectEventSlugDatesOutput> {
  const input = parseInput(correctEventSlugDatesInputSchema, rawInput);
  const utcMintedBefore = input.utcMintedBefore;
  if (
    utcMintedBefore &&
    utcMintedBefore.getTime() > deps.clock.now().getTime()
  ) {
    // A future cutoff would reinterpret slugs already minted in local time.
    throw {
      code: "invalid_input",
      message: "utc_minted_before_in_future",
    } as const;
  }

  const page = await deps.repos.events.listSluggedPage({
    afterId: input.afterId,
    limit: input.limit,
  });

  const counts: Record<SlugDateOutcome, number> = {
    corrected: 0,
    already_correct: 0,
    start_moved: 0,
    unparseable: 0,
    minted_after_cutoff: 0,
    gone: 0,
    failed: 0,
  };
  const rows: SlugDateRowResult[] = [];

  for (const row of page) {
    const planned = classifyEventSlugDate(row, { utcMintedBefore });
    let result: SlugDateRowResult;
    if (planned.outcome !== "corrected") {
      result = {
        eventId: row.id,
        previousSlug: row.slug,
        newSlug: null,
        outcome: planned.outcome,
      };
    } else if (!input.apply) {
      // The dry run reports what apply would do, including the audit gate.
      const gate =
        planned.basis === "slug_instant" && utcMintedBefore
          ? await slugInstantGate(
              deps.repos.audit,
              row.id,
              row.slug,
              utcMintedBefore,
            )
          : "allowed";
      result =
        gate === "allowed"
          ? {
              eventId: row.id,
              previousSlug: row.slug,
              newSlug: planned.newSlug,
              outcome: "corrected",
              basis: planned.basis,
            }
          : {
              eventId: row.id,
              previousSlug: row.slug,
              newSlug: null,
              outcome: gate,
            };
    } else {
      try {
        result = await applyOne(deps, row.id, utcMintedBefore);
      } catch (error) {
        result = {
          eventId: row.id,
          previousSlug: row.slug,
          newSlug: planned.newSlug,
          outcome: "failed",
          basis: planned.basis,
          error: describeError(error),
        };
        deps.logger?.error("event.slug_date_correction_failed", {
          eventId: row.id,
          previousSlug: row.slug,
          err: error,
        });
        try {
          deps.reportError?.(error, {
            tags: { useCase: "correctEventSlugDates" },
            extra: { eventId: row.id, previousSlug: row.slug },
          });
        } catch {
          // A throwing reporter must not change the batch's behaviour.
        }
      }
    }
    counts[result.outcome] += 1;
    rows.push(result);
  }

  return {
    applied: input.apply,
    scanned: page.length,
    counts,
    rows,
    nextAfterId:
      page.length === input.limit ? page[page.length - 1]!.id : null,
  };
}

/**
 * One event, one transaction. Re-reads the row under its lock and classifies
 * again, so a slug regenerated or a start moved since the page read is never
 * overwritten.
 */
async function applyOne(
  deps: CorrectEventSlugDatesDeps,
  eventId: string,
  utcMintedBefore: Date | null,
): Promise<SlugDateRowResult> {
  return deps.repos.tx(async (tx) => {
    const now = deps.clock.now();
    await tx.events.lockRows({ ids: [eventId], mode: "update" });
    // Narrow re-read, not `getById` (see "SCHEMA-NARROW" above).
    const event = await tx.events.getSlugDateRow(eventId);
    if (!event) {
      return { eventId, previousSlug: "", newSlug: null, outcome: "gone" };
    }
    const previousSlug = event.slug;
    const fresh = classifyEventSlugDate(event, { utcMintedBefore });
    if (fresh.outcome !== "corrected") {
      return { eventId, previousSlug, newSlug: null, outcome: fresh.outcome };
    }
    if (fresh.basis === "slug_instant" && utcMintedBefore) {
      const gate = await slugInstantGate(
        tx.audit,
        eventId,
        previousSlug,
        utcMintedBefore,
      );
      if (gate !== "allowed") {
        return { eventId, previousSlug, newSlug: null, outcome: gate };
      }
    }

    await tx.events.recordSlugHistory({
      eventId,
      slug: previousSlug,
      recordedAt: now,
    });

    try {
      // Narrow write, not `updateSlug` (see "SCHEMA-NARROW" above). Only the
      // date segment moves; `regionCode` is not touched.
      await tx.events.setSlugOnly({ eventId, slug: fresh.newSlug });
    } catch (error) {
      throw mapSlugUpdateError(error);
    }

    await tx.audit.log({
      entity: "event",
      entityId: eventId,
      action: SLUG_DATE_CORRECTED_AUDIT_ACTION,
      data: {
        previousSlug,
        newSlug: fresh.newSlug,
        basis: fresh.basis,
        source: "BACKFILL",
        actorHumanId: null,
      },
      at: now,
    });

    // A published event's search document links by slug.
    if (event.status === "PUBLISHED") {
      await markForSearchReindex(tx, [{ kind: "event", id: eventId }], now);
    }

    deps.logger?.info(SLUG_DATE_CORRECTED_AUDIT_ACTION, {
      eventId,
      previousSlug,
      newSlug: fresh.newSlug,
      basis: fresh.basis,
    });

    return {
      eventId,
      previousSlug,
      newSlug: fresh.newSlug,
      outcome: "corrected",
      basis: fresh.basis,
    };
  });
}
