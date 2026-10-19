import { Prisma } from "@prisma/client";
import type {
  RsvpReminderCandidate,
  RsvpReminderChannel,
  RsvpRemindersRepo,
} from "@th/ports/repos/rsvp-reminders";

import type { PrismaClientOrTx } from "./types";

/**
 * Shape returned by the due-set query. `eventDateId` is NULL on the
 * event-level branch of the UNION; `settledChannels` is the aggregated set of
 * this (subject × human)'s already-settled ledger rows (empty array, never
 * NULL — see the COALESCE in the query).
 */
type RawCandidateRow = {
  eventDateId: string | null;
  eventId: string;
  humanId: string;
  rsvpCreatedAt: Date;
  startsAt: Date;
  endsAt: Date | null;
  settledChannels: string[] | null;
};

const CHANNELS = new Set<string>(["in_app", "push", "email", "sms"]);

/**
 * `channel` is TEXT in the ledger (matching VolunteerShiftNotification), so a
 * row written by a future build with a channel this one doesn't know about
 * must not widen the port's union by lying. Unknown values are dropped; the
 * only consequence is that the use case may re-send a channel it cannot name,
 * which is the safe direction for a reminder.
 */
const mapCandidate = (row: RawCandidateRow): RsvpReminderCandidate => ({
  eventDateId: row.eventDateId,
  eventId: row.eventId,
  humanId: row.humanId,
  rsvpCreatedAt: row.rsvpCreatedAt,
  startsAt: row.startsAt,
  endsAt: row.endsAt,
  settledChannels: (row.settledChannels ?? []).filter(
    (channel): channel is RsvpReminderChannel => CHANNELS.has(channel),
  ),
});

/** Postgres unique-violation. A lost claim race, not an error. */
const UNIQUE_VIOLATION = "P2002";

/**
 * A released claim is pushed back to the UNIX epoch rather than deleted: the
 * row is the record that this channel still owes a send (deleting it would
 * make a partially-delivered reminder look complete to the due-set query), and
 * the epoch makes it outstanding immediately, so a failed send retries on the
 * very next tick instead of waiting out the staleness window.
 *
 * CONSEQUENCE FOR THE LEAK METRIC: a released row is "older than an hour" from
 * the moment it is written, so the alertable count MUST exclude the epoch —
 * `sentAt IS NULL AND claimedAt > to_timestamp(0) AND claimedAt < now() - 1h`.
 * Without that term the metric counts every healthy retry and never returns to
 * zero, which is an alert nobody can act on.
 */
const RELEASED_CLAIM_AT = new Date(0);

/** The one-of-two subject columns, per the `exactly_one_subject` CHECK. */
const subjectWhere = (eventDateId: string | null, eventId: string) =>
  eventDateId === null
    ? { eventId, eventDateId: null }
    : { eventDateId, eventId: null };

export function makeRsvpRemindersRepo(
  p: PrismaClientOrTx,
): RsvpRemindersRepo {
  return {
    // Raw SQL on purpose. Two of these predicates are impossible in Prisma's
    // query builder: the "does this person still owe a send" test is a
    // CORRELATED subquery (it needs the outer row's humanId), and
    // `settledChannels` is a correlated aggregate. Doing either client-side —
    // fetch, then subtract — would let a settled backlog consume the whole
    // `limit` and starve the rows that still need sending, for the full width
    // of the catch-up window.
    //
    // Everything interpolated is a bound parameter (`Prisma.sql` tagged
    // template), never string-concatenated; the only literals are schema enum
    // values fixed in this file.
    //
    // NOTE: `Event.attendanceMode` is `@map("attendance_mode")` — the column is
    // snake_case even though the Prisma field is not. Every other column here
    // is unmapped camelCase.
    findDue: async ({
      windowStart,
      windowEnd,
      leadMinutes,
      staleClaimBefore,
      limit,
    }) => {
      const rows = await p.$queryRaw<RawCandidateRow[]>(Prisma.sql`
        WITH due AS (
          -- Per-date RSVPs on recurring listings. The occurrence carries its
          -- own start/end, so DST and per-date duration are preserved.
          SELECT
            ed."id"       AS "eventDateId",
            ed."eventId"  AS "eventId",
            r."humanId"   AS "humanId",
            r."createdAt" AS "rsvpCreatedAt",
            ed."startsAt" AS "startsAt",
            ed."endsAt"   AS "endsAt",
            COALESCE((
              SELECT array_agg(rr."channel")
              FROM "RsvpReminder" rr
              WHERE rr."eventDateId" = ed."id"
                AND rr."humanId" = r."humanId"
                AND rr."sentAt" IS NOT NULL
            ), ARRAY[]::text[]) AS "settledChannels"
          FROM "EventDateRsvp" r
          JOIN "EventDate" ed ON ed."id" = r."eventDateId"
          JOIN "Event" e ON e."id" = ed."eventId"
          WHERE ed."status" = 'SCHEDULED'
            AND ed."startsAt" >= ${windowStart}
            AND ed."startsAt" <  ${windowEnd}
            AND e."status" = 'PUBLISHED'
            AND e."attendance_mode" = 'RSVP'
            -- RSVP'd before the lead mark. Someone who said "I'm going" with
            -- less than "leadMinutes" to go already has their confirmation,
            -- and that IS their reminder. Filtered HERE rather than skipped in
            -- the use case because a skip writes no ledger row, so the class
            -- would sit at the head of the startsAt-ASC ordering and eat the
            -- LIMIT on every tick — starving every other listing in the window.
            AND r."createdAt" <= ed."startsAt" - (${leadMinutes}::double precision * INTERVAL '1 minute')
            -- Still owes a send: no ledger rows at all, or at least one
            -- OUTSTANDING row (claimed, never settled, and stale — a failed
            -- send that released its claim, or a worker evicted mid-batch).
            AND (
              NOT EXISTS (
                SELECT 1 FROM "RsvpReminder" rr
                WHERE rr."eventDateId" = ed."id"
                  AND rr."humanId" = r."humanId"
              )
              OR EXISTS (
                SELECT 1 FROM "RsvpReminder" rr
                WHERE rr."eventDateId" = ed."id"
                  AND rr."humanId" = r."humanId"
                  AND rr."sentAt" IS NULL
                  AND rr."claimedAt" < ${staleClaimBefore}
              )
            )

          UNION ALL

          -- Event-level RSVPs, restricted to listings with NO EventDate rows
          -- (genuinely single-date). On a recurring listing Event."startsAt" is
          -- re-pinned by community.refresh-recurring-dates to whichever
          -- occurrence is next, so reminding on it would fire once for a date
          -- the person never picked — the per-date branch above is the real
          -- attendance signal there.
          SELECT
            NULL::text    AS "eventDateId",
            e."id"        AS "eventId",
            r."humanId"   AS "humanId",
            r."createdAt" AS "rsvpCreatedAt",
            e."startsAt"  AS "startsAt",
            e."endsAt"    AS "endsAt",
            COALESCE((
              SELECT array_agg(rr."channel")
              FROM "RsvpReminder" rr
              WHERE rr."eventId" = e."id"
                AND rr."humanId" = r."humanId"
                AND rr."sentAt" IS NOT NULL
            ), ARRAY[]::text[]) AS "settledChannels"
          FROM "EventRsvp" r
          JOIN "Event" e ON e."id" = r."eventId"
          WHERE e."startsAt" >= ${windowStart}
            AND e."startsAt" <  ${windowEnd}
            AND e."status" = 'PUBLISHED'
            AND e."attendance_mode" = 'RSVP'
            AND NOT EXISTS (
              SELECT 1 FROM "EventDate" ed2 WHERE ed2."eventId" = e."id"
            )
            AND r."createdAt" <= e."startsAt" - (${leadMinutes}::double precision * INTERVAL '1 minute')
            AND (
              NOT EXISTS (
                SELECT 1 FROM "RsvpReminder" rr
                WHERE rr."eventId" = e."id"
                  AND rr."humanId" = r."humanId"
              )
              OR EXISTS (
                SELECT 1 FROM "RsvpReminder" rr
                WHERE rr."eventId" = e."id"
                  AND rr."humanId" = r."humanId"
                  AND rr."sentAt" IS NULL
                  AND rr."claimedAt" < ${staleClaimBefore}
              )
            )
        )
        SELECT
          "eventDateId",
          "eventId",
          "humanId",
          "rsvpCreatedAt",
          "startsAt",
          "endsAt",
          "settledChannels"
        FROM due
        -- Soonest first: under a row limit, the date that starts next is the one
        -- whose reminder can least afford to wait another tick.
        ORDER BY "startsAt" ASC, "eventId" ASC, "humanId" ASC
        LIMIT ${limit}
      `);
      return rows.map(mapCandidate);
    },

    // Claim-before-send, one row per channel. Exactly ONE subject column is
    // written — per-date rows null out `eventId`, event-level rows null out
    // `eventDateId` — which is what lets the two single-subject unique indexes
    // each cover their own case (see the RsvpReminder docstring). The P2002
    // catch is the race winner/loser decision, not an error path.
    claim: async ({
      eventDateId,
      eventId,
      humanId,
      channels,
      now,
      staleClaimBefore,
    }) => {
      const subject = subjectWhere(eventDateId, eventId);
      const won: RsvpReminderChannel[] = [];

      for (const channel of channels) {
        try {
          await p.rsvpReminder.create({
            data: { ...subject, humanId, channel, claimedAt: now },
            select: { id: true },
          });
          won.push(channel);
          continue;
        } catch (error) {
          if (
            !(
              error instanceof Prisma.PrismaClientKnownRequestError &&
              error.code === UNIQUE_VIOLATION
            )
          ) {
            throw error;
          }
        }

        // A row already exists. Retake it ONLY if it is outstanding — a
        // settled row, or one another tick is currently holding, is left
        // alone. Under READ COMMITTED an UPDATE re-checks its qualification
        // against the row it waited on, so two ticks racing the same
        // outstanding row produce exactly one winner.
        const retaken = await p.rsvpReminder.updateMany({
          where: {
            ...subject,
            humanId,
            channel,
            sentAt: null,
            claimedAt: { lt: staleClaimBefore },
          },
          data: { claimedAt: now },
        });
        if (retaken.count > 0) won.push(channel);
      }

      return won;
    },

    // Settle: stamp `sentAt`, which takes the channel out of the due set for
    // good. Guarded on `sentAt: null` so a late settle can never overwrite an
    // earlier one's timestamp.
    markSent: async ({ eventDateId, eventId, humanId, channels, sentAt }) => {
      if (channels.length === 0) return;
      await p.rsvpReminder.updateMany({
        where: {
          ...subjectWhere(eventDateId, eventId),
          humanId,
          channel: { in: channels },
          sentAt: null,
        },
        data: { sentAt },
      });
    },

    // Release: keep the row (it records an unpaid debt) and make it
    // immediately outstanding. `updateMany` — not `delete` — so releasing a
    // claim that is already gone is a no-op rather than a P2025: the rollback
    // path must never throw over the send failure that triggered it.
    release: async ({ eventDateId, eventId, humanId, channels }) => {
      if (channels.length === 0) return;
      await p.rsvpReminder.updateMany({
        where: {
          ...subjectWhere(eventDateId, eventId),
          humanId,
          channel: { in: channels },
          sentAt: null,
        },
        data: { claimedAt: RELEASED_CLAIM_AT },
      });
    },
  } satisfies RsvpRemindersRepo;
}
