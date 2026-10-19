import { Prisma } from "@prisma/client";
import { fail } from "@th/errors";
import type {
  AttendeeReviewAggRow,
  AttendeeReviewRecord,
  AttendeeReviewSource,
  AttendeeReviewsRepo,
} from "@th/ports/repos/attendee-reviews";
import type { ReviewAggregateSubjectType } from "@th/ports/repos/review-aggregates";

import { resolveWithheldOwners } from "./banned-owner";
import type { PrismaClientOrTx } from "./types";

const AGG_SELECT = {
  id: true,
  humanId: true,
  source: true,
  overallRating: true,
  soundQuality: true,
  venueComfort: true,
  organization: true,
  valueForMoney: true,
} as const;

const mapAggRow = (row: {
  id: string;
  humanId: string | null;
  source: AttendeeReviewSource;
  overallRating: number;
  soundQuality: number | null;
  venueComfort: number | null;
  organization: number | null;
  valueForMoney: number | null;
}): AttendeeReviewAggRow => ({
  // Distinct-reviewer key: humanId for signed-in reviewers, else the row id so
  // each anonymous COMMUNITY guest counts once (FR-010 suppression).
  reviewerKey: row.humanId ?? row.id,
  source: row.source,
  overallRating: row.overallRating,
  soundQuality: row.soundQuality,
  venueComfort: row.venueComfort,
  organization: row.organization,
  valueForMoney: row.valueForMoney,
});

/** The AttendeeReview column each aggregation subject type keys off. */
const SUBJECT_COLUMN: Record<
  ReviewAggregateSubjectType,
  "eventId" | "placeId" | "ownerId" | "seriesId"
> = {
  EVENT: "eventId",
  PLACE: "placeId",
  OWNER: "ownerId",
  SERIES: "seriesId",
};

const REVIEW_SELECT = {
  id: true,
  eventId: true,
  humanId: true,
  anonymousName: true,
  anonymousEmail: true,
  source: true,
  overallRating: true,
  soundQuality: true,
  venueComfort: true,
  organization: true,
  valueForMoney: true,
  text: true,
  placeId: true,
  ownerType: true,
  ownerId: true,
  seriesId: true,
  hidden: true,
  flagged: true,
  flagReason: true,
  createdAt: true,
  updatedAt: true,
} as const;

type ReviewRow = {
  id: string;
  eventId: string | null;
  humanId: string | null;
  anonymousName: string | null;
  anonymousEmail: string | null;
  source: AttendeeReviewSource;
  overallRating: number;
  soundQuality: number | null;
  venueComfort: number | null;
  organization: number | null;
  valueForMoney: number | null;
  text: string | null;
  placeId: string | null;
  ownerType: string | null;
  ownerId: string | null;
  seriesId: string | null;
  hidden: boolean;
  flagged: boolean;
  flagReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const mapRecord = (row: ReviewRow): AttendeeReviewRecord => ({
  id: row.id,
  eventId: row.eventId,
  humanId: row.humanId,
  anonymousName: row.anonymousName,
  anonymousEmail: row.anonymousEmail,
  source: row.source,
  overallRating: row.overallRating,
  soundQuality: row.soundQuality,
  venueComfort: row.venueComfort,
  organization: row.organization,
  valueForMoney: row.valueForMoney,
  text: row.text,
  placeId: row.placeId,
  ownerType: row.ownerType,
  ownerId: row.ownerId,
  seriesId: row.seriesId,
  hidden: row.hidden,
  flagged: row.flagged,
  flagReason: row.flagReason,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export function makeAttendeeReviewsRepo(
  p: PrismaClientOrTx,
): AttendeeReviewsRepo {
  return {
    create: async (input) => {
      try {
        const row = await p.attendeeReview.create({
          data: {
            eventId: input.eventId,
            humanId: input.humanId,
            overallRating: input.overallRating,
            soundQuality: input.soundQuality ?? null,
            venueComfort: input.venueComfort ?? null,
            organization: input.organization ?? null,
            valueForMoney: input.valueForMoney ?? null,
            text: input.text ?? null,
            placeId: input.placeId ?? null,
            ownerType: input.ownerType ?? null,
            ownerId: input.ownerId ?? null,
            seriesId: input.seriesId ?? null,
          },
          select: REVIEW_SELECT,
        });
        return mapRecord(row);
      } catch (error) {
        // P2002 here can only be the (eventId, humanId) unique index — `id`
        // is a fresh uuid. Map the race loser to the same domain error as
        // the use-case pre-check (attendee-reviews FR-001).
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          throw fail("ATTENDEE_REVIEW_ALREADY_SUBMITTED", { cause: error });
        }
        throw error;
      }
    },

    // UNVERIFIED, venue-direct COMMUNITY review (FR-009). placeId only — no
    // eventId, owner, or series rollup — so the (eventId, humanId) unique index
    // never binds it (fully open, no race to map).
    createCommunityReview: async (input) => {
      const row = await p.attendeeReview.create({
        data: {
          source: "COMMUNITY",
          eventId: null,
          humanId: input.humanId ?? null,
          anonymousName: input.anonymousName ?? null,
          anonymousEmail: input.anonymousEmail ?? null,
          overallRating: input.overallRating,
          soundQuality: input.soundQuality ?? null,
          venueComfort: input.venueComfort ?? null,
          organization: input.organization ?? null,
          valueForMoney: input.valueForMoney ?? null,
          text: input.text ?? null,
          placeId: input.placeId,
          ownerType: null,
          ownerId: null,
          seriesId: null,
        },
        select: REVIEW_SELECT,
      });
      return mapRecord(row);
    },

    getById: async (id) => {
      const row = await p.attendeeReview.findUnique({
        where: { id },
        select: REVIEW_SELECT,
      });
      return row ? mapRecord(row) : null;
    },

    findByEventAndHuman: async ({ eventId, humanId }) => {
      const row = await p.attendeeReview.findUnique({
        where: { eventId_humanId: { eventId, humanId } },
        select: REVIEW_SELECT,
      });
      return row ? mapRecord(row) : null;
    },

    // Verified attendance: at least one SCANNED ticket owned by the human
    // for this event (attendee-reviews FR-001 / NFR-002), on an account whose
    // email is verified (B2: guest checkout attaches tickets by email, so an
    // unverified account may hold someone else's scanned ticket).
    hasScannedTicket: async ({ eventId, humanId }) => {
      const count = await p.ticket.count({
        where: {
          eventId,
          ownerHumanId: humanId,
          status: "SCANNED",
          owner: { authUser: { is: { emailVerified: true } } },
        },
      });
      return count > 0;
    },

    // ── Aggregation (FR-004) ─────────────────────────────────────────────
    listSubjectIdsWithReviews: async ({ subjectType, limit, afterSubjectId }) => {
      const column = SUBJECT_COLUMN[subjectType];
      // groupBy (DB-level distinct), NOT findMany+distinct: Prisma applies
      // `take` before its in-memory distinct, which could silently drop
      // subjectIds mid-page (same footgun documented in place-reviews). The
      // dynamic groupBy column defeats Prisma's literal-key generics, so the
      // args are assembled and cast to the generated groupBy arg type.
      // `eventId` is a REQUIRED column, so Prisma types it with the
      // non-nullable StringFilter, which rejects `not: null` outright
      // ("Argument `not` must not be null") rather than treating it as a
      // no-op. Applying it unconditionally therefore threw on the EVENT sweep
      // — and that throw happens in recompute-review-aggregates' paging loop,
      // OUTSIDE its per-subject try/catch, so it failed the whole job and no
      // aggregate of ANY subject type was ever published. Only the
      // denormalized targets (placeId/ownerId/seriesId) are nullable and need
      // the null bucket excluded.
      const idFilter: Record<string, unknown> = {};
      if (subjectType !== "EVENT") idFilter.not = null;
      if (afterSubjectId) idFilter.gt = afterSubjectId;

      const args = {
        by: [column],
        where: {
          hidden: false,
          ...(Object.keys(idFilter).length > 0 ? { [column]: idFilter } : {}),
        },
        orderBy: { [column]: "asc" },
        take: limit,
      };
      const groupBy = p.attendeeReview.groupBy as unknown as (
        a: unknown,
      ) => Promise<Array<Record<string, string | null>>>;
      const rows = await groupBy(args);
      return rows
        .map((r) => r[column])
        .filter((v): v is string => v != null);
    },

    listAggRowsForSubject: async ({ subjectType, subjectId }) => {
      const column = SUBJECT_COLUMN[subjectType];
      // Ban that sticks: a BANNED reviewer's reviews leave the public
      // aggregates (next recompute); nothing deleted. See ./banned-owner.ts.
      const { humanIds: bannedHumanIds } = await resolveWithheldOwners(p);
      const rows = await p.attendeeReview.findMany({
        where: {
          hidden: false,
          [column]: subjectId,
          ...(bannedHumanIds.length > 0
            ? {
                OR: [
                  { humanId: null },
                  { humanId: { notIn: [...bannedHumanIds] } },
                ],
              }
            : {}),
        },
        select: AGG_SELECT,
      });
      return rows.map(mapAggRow);
    },

    // ── Organizer feedback + moderation (FR-007 / FR-009) ─────────────────
    listForEventFeedback: async (eventId) => {
      const rows = await p.attendeeReview.findMany({
        where: { eventId, hidden: false },
        select: REVIEW_SELECT,
        orderBy: { createdAt: "desc" },
      });
      return rows.map(mapRecord);
    },

    // Owner private feedback (FR-006): every non-hidden review anchored to this
    // place — verified (via denormalized placeId) AND community (placeId-only).
    listForPlaceFeedback: async (placeId) => {
      const rows = await p.attendeeReview.findMany({
        where: { placeId, hidden: false },
        select: REVIEW_SELECT,
        orderBy: { createdAt: "desc" },
      });
      return rows.map(mapRecord);
    },

    // Verified-review upsell candidates (FR-003): non-cancelled events at this
    // place where the human owns a SCANNED ticket and has NOT already reviewed.
    // Window/ended checks are re-applied by the use case.
    listReviewableEventCandidatesForPlace: async ({ placeId, humanId }) => {
      const events = await p.event.findMany({
        where: {
          placeId,
          status: { notIn: ["CANCELLED", "ARCHIVED"] },
          // B2: only on an account whose email is verified (see
          // `hasScannedTicket`).
          tickets: {
            some: {
              ownerHumanId: humanId,
              status: "SCANNED",
              owner: { authUser: { is: { emailVerified: true } } },
            },
          },
          attendeeReviews: { none: { humanId } },
        },
        select: {
          id: true,
          title: true,
          startsAt: true,
          endsAt: true,
          status: true,
        },
        orderBy: { startsAt: "desc" },
      });
      return events.map((e) => ({
        eventId: e.id,
        title: e.title,
        startsAt: e.startsAt,
        endsAt: e.endsAt,
        status: e.status,
      }));
    },

    setFlagged: async ({ reviewId, flagged, flagReason }) => {
      const row = await p.attendeeReview.update({
        where: { id: reviewId },
        data: { flagged, flagReason },
        select: REVIEW_SELECT,
      });
      return mapRecord(row);
    },

    setHidden: async ({ reviewId, hidden }) => {
      const row = await p.attendeeReview.update({
        where: { id: reviewId },
        data: { hidden },
        select: REVIEW_SELECT,
      });
      return mapRecord(row);
    },
  } satisfies AttendeeReviewsRepo;
}
