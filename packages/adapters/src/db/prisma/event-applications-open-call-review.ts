import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";
import type {
  ApplicationSubmissionStatus,
  ApplicationMessageAuthorSide,
  ApplicationMessageRecord,
  ApplicationNoteRecord,
  ApplicationVoteValue,
  EventApplicationsRepo,
  OpenCallReviewCardRecord,
  OpenCallReviewSubmissionRecord,
  OpenCallTraceCounts,
} from "@th/ports/repos/events";
import { TRACK_RECORD_EVENT_STATUSES } from "@th/types/repos/events";

import {
  mapChoice,
  PERFORM_FORM,
  requireId,
  SUBMISSION_SELECT,
} from "./event-applications-open-call-submissions";
import type { PrismaClientOrTx } from "./types";

/**
 * ORGANIZER-SIDE methods of the event-applications repo (open calls v1 step
 * 5): the review queue with its per-card extras, the first-open stamp,
 * votes, notes and the applicant <-> organizer thread.
 * `makeEventApplicationsRepo` spreads them in.
 *
 * Authz is core's job: it resolves the organizer side and checks that the
 * submission belongs to the form before calling any of these. The queue
 * read is scoped to a PERFORM form; the vote / note / message methods are
 * keyed by a submission id core has already scoped.
 */

type OpenCallReviewMethods = Pick<
  EventApplicationsRepo,
  | "listOpenCallReviewCards"
  | "markOpenCallSubmissionOpened"
  | "setApplicationVote"
  | "getApplicationVoteSummary"
  | "createApplicationNote"
  | "listApplicationNotes"
  | "createApplicationMessage"
  | "listApplicationMessages"
  | "markApplicationMessagesRead"
>;

const MAX_CARDS = 100;

/**
 * The queue card's submission columns: the shared select MINUS answers,
 * the questions snapshot, the email and the token hash. FR-010: answers
 * leave the database for the organizer side only through opening a card
 * (which stamps openedAt first), never through the list.
 */
const {
  answers: _answers,
  questionsSnapshot: _questionsSnapshot,
  contactEmail: _contactEmail,
  contactLocale: _contactLocale,
  statusTokenHash: _statusTokenHash,
  ...REVIEW_SUBMISSION_SELECT_BASE
} = SUBMISSION_SELECT;
const REVIEW_SUBMISSION_SELECT = {
  ...REVIEW_SUBMISSION_SELECT_BASE,
} as const satisfies Prisma.EventApplicationSubmissionSelect;

type ReviewSubmissionRow = Prisma.EventApplicationSubmissionGetPayload<{
  select: typeof REVIEW_SUBMISSION_SELECT;
}>;

function mapReviewSubmission(row: ReviewSubmissionRow): OpenCallReviewSubmissionRecord {
  return {
    id: row.id,
    formId: row.formId,
    eventId: row.eventId,
    humanId: row.humanId,
    applyingAsOrgId: row.applyingAsOrgId,
    guestName: row.guestName,
    guestUrl: row.guestUrl,
    status: row.status as ApplicationSubmissionStatus,
    isPrivate: row.isPrivate,
    openedAt: row.openedAt,
    droppedOutAt: row.droppedOutAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    dateChoices: row.dateChoices
      .map(mapChoice)
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime()),
  };
}
const MAX_MESSAGES = 100;
const MAX_NOTES = 500;

const clamp = (n: number, min: number, max: number) =>
  Math.min(Math.max(Math.trunc(Number.isFinite(n) ? n : min), min), max);

const MESSAGE_SELECT = {
  id: true,
  submissionId: true,
  authorSide: true,
  authorHumanId: true,
  body: true,
  readAt: true,
  createdAt: true,
} as const satisfies Prisma.ApplicationMessageSelect;

function mapMessage(
  row: Prisma.ApplicationMessageGetPayload<{ select: typeof MESSAGE_SELECT }>,
): ApplicationMessageRecord {
  return {
    id: row.id,
    submissionId: row.submissionId,
    authorSide: row.authorSide as ApplicationMessageAuthorSide,
    authorHumanId: row.authorHumanId,
    body: row.body,
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}

const NOTE_SELECT = {
  id: true,
  submissionId: true,
  authorHumanId: true,
  body: true,
  createdAt: true,
  author: { select: { name: true } },
} as const satisfies Prisma.ApplicationNoteSelect;

function mapNote(
  row: Prisma.ApplicationNoteGetPayload<{ select: typeof NOTE_SELECT }>,
): ApplicationNoteRecord {
  return {
    id: row.id,
    submissionId: row.submissionId,
    authorHumanId: row.authorHumanId,
    authorName: row.author?.name ?? null,
    body: row.body,
    createdAt: row.createdAt,
  };
}

const emptyTally = () => ({ yes: 0, maybe: 0, no: 0 });

function addToTally(
  tally: { yes: number; maybe: number; no: number },
  vote: string,
  count: number,
): void {
  if (vote === "YES") tally.yes += count;
  else if (vote === "MAYBE") tally.maybe += count;
  else if (vote === "NO") tally.no += count;
}

/**
 * Trust-trace counts (FR-013) for many applicant entities in ONE statement.
 *
 * `nights` expands each relevant PUBLIC event that HAPPENED (status in
 * TRACK_RECORD_EVENT_STATUSES: published or completed, never a draft or
 * cancelled; visibility PUBLIC, the house rule of listPerformancesByHuman,
 * so a private night never leaves its circle) into the number of its dates
 * that are over: its SCHEDULED EventDate rows that have ended, or the event
 * itself once ended when it has no date rows.
 *
 * "Organised by" the entity: a person organises their own personal event
 * (orgId null, humanId = them), and an event of an org where they
 * CURRENTLY hold one of `organiserOrgRoles` (core passes ORG_EDIT_ROLES)
 * ONLY when they are on its lineup themselves (self-booking through their
 * own org, FR-013 "did not organise"). Holding an edit role never credits
 * the org's other nights: a new EDITOR of a venue org does not "run" its
 * history. An org organises the events it owns. "Ran" sums organised
 * nights.
 * "Played" sums lineup rows (roles `lineupRoles`) on events the entity did
 * NOT organise, so a night is ran or played, never both. "Here" restricts
 * played to the call's place(s): the event call's place, or the places of a
 * series call's materialised events. Every value is a bind parameter.
 */
async function loadTraceCounts(
  p: PrismaClientOrTx,
  input: {
    formId: string;
    humanIds: string[];
    orgIds: string[];
    now: Date;
    lineupRoles: readonly string[];
    organiserOrgRoles: readonly string[];
  },
): Promise<Map<string, OpenCallTraceCounts>> {
  const out = new Map<string, OpenCallTraceCounts>();
  if (input.humanIds.length + input.orgIds.length === 0) return out;
  const statuses = [...TRACK_RECORD_EVENT_STATUSES];
  const roles = [...input.lineupRoles];
  const organiserRoles = [...input.organiserOrgRoles];
  const rows = await p.$queryRaw<
    Array<{ kind: string; id: string; played: number; playedHere: number; ran: number }>
  >(Prisma.sql`
    WITH here AS (
      SELECT e."placeId"
      FROM "EventApplicationForm" f
      JOIN "Event" e ON e."id" = f."eventId"
      WHERE f."id" = ${input.formId} AND e."placeId" IS NOT NULL
      UNION
      SELECT e."placeId"
      FROM "EventApplicationForm" f
      JOIN "EventSeriesOccurrence" o ON o."seriesId" = f."seriesId"
      JOIN "Event" e ON e."id" = o."eventId"
      WHERE f."id" = ${input.formId} AND e."placeId" IS NOT NULL
    ),
    ents AS (
      SELECT 'human'::text AS kind, x AS id FROM unnest(${input.humanIds}::text[]) AS x
      UNION ALL
      SELECT 'org'::text AS kind, x AS id FROM unnest(${input.orgIds}::text[]) AS x
    ),
    -- Orgs whose events a PERSON entity organises (current organiser role).
    org_rel AS (
      SELECT ents.id AS hid, m."orgId"
      FROM ents
      JOIN "OrgMember" m ON m."humanId" = ents.id
      WHERE ents.kind = 'human' AND m."role"::text = ANY(${organiserRoles}::text[])
    ),
    nights AS (
      SELECT e."id", e."orgId", e."humanId", e."placeId",
        (CASE
          WHEN EXISTS (SELECT 1 FROM "EventDate" d0 WHERE d0."eventId" = e."id")
          THEN (
            SELECT COUNT(*) FROM "EventDate" d
            WHERE d."eventId" = e."id"
              AND d."status" = 'SCHEDULED'::"EventDateStatus"
              AND COALESCE(d."endsAt", d."startsAt") <= ${input.now}::timestamp
          )
          WHEN e."endsAt" <= ${input.now}::timestamp THEN 1
          ELSE 0
        END)::int AS n
      FROM "Event" e
      WHERE e."status" = ANY(${statuses}::"EventStatus"[])
        AND e."visibility" = 'PUBLIC'::"EventVisibility"
        AND (
          e."id" IN (
            SELECT eh0."eventId" FROM "EventHuman" eh0
            WHERE eh0."humanId" = ANY(${input.humanIds}::text[])
               OR eh0."orgId" = ANY(${input.orgIds}::text[])
          )
          OR e."orgId" = ANY(${input.orgIds}::text[])
          OR (e."orgId" IS NULL AND e."humanId" = ANY(${input.humanIds}::text[]))
        )
    ),
    -- Which (entity, event) pairs the entity ORGANISED.
    organised AS (
      SELECT ents.kind, ents.id, nn."id" AS "eventId", nn.n
      FROM ents
      JOIN nights nn
        ON (ents.kind = 'org' AND nn."orgId" = ents.id)
        OR (ents.kind = 'human' AND nn."orgId" IS NULL AND nn."humanId" = ents.id)
        -- Self-booking: an org where the person holds an organiser role AND
        -- the person's own lineup row on this event (same roles as played).
        OR (ents.kind = 'human'
            AND EXISTS (
              SELECT 1 FROM org_rel r WHERE r.hid = ents.id AND r."orgId" = nn."orgId"
            )
            AND EXISTS (
              SELECT 1 FROM "EventHuman" eh1
              WHERE eh1."eventId" = nn."id"
                AND eh1."humanId" = ents.id
                AND eh1."role"::text = ANY(${roles}::text[])
            ))
    ),
    played AS (
      SELECT ents.kind, ents.id, nn.n, nn."placeId"
      FROM ents
      JOIN "EventHuman" eh
        ON (ents.kind = 'human' AND eh."humanId" = ents.id)
        OR (ents.kind = 'org' AND eh."orgId" = ents.id)
      JOIN nights nn ON nn."id" = eh."eventId"
      WHERE eh."role"::text = ANY(${roles}::text[])
        AND NOT EXISTS (
          SELECT 1 FROM organised og
          WHERE og.kind = ents.kind AND og.id = ents.id AND og."eventId" = nn."id"
        )
    )
    SELECT ents.kind, ents.id,
      COALESCE((
        SELECT SUM(pl.n) FROM played pl WHERE pl.kind = ents.kind AND pl.id = ents.id
      ), 0)::int AS "played",
      COALESCE((
        SELECT SUM(pl.n) FROM played pl
        WHERE pl.kind = ents.kind AND pl.id = ents.id
          AND pl."placeId" IN (SELECT h."placeId" FROM here h)
      ), 0)::int AS "playedHere",
      COALESCE((
        SELECT SUM(og.n) FROM organised og WHERE og.kind = ents.kind AND og.id = ents.id
      ), 0)::int AS "ran"
    FROM ents
  `);
  for (const r of rows) {
    out.set(`${r.kind}:${r.id}`, {
      playedNights: Number(r.played),
      playedHereNights: Number(r.playedHere),
      ranNights: Number(r.ran),
    });
  }
  return out;
}

export function makeOpenCallReviewMethods(p: PrismaClientOrTx): OpenCallReviewMethods {
  return {
    listOpenCallReviewCards: async (input) => {
      const formId = requireId(input.formId, "listOpenCallReviewCards", "formId");
      const viewerHumanId = requireId(
        input.viewerHumanId,
        "listOpenCallReviewCards",
        "viewerHumanId",
      );
      const take = clamp(input.limit, 1, MAX_CARDS);

      let where: Prisma.EventApplicationSubmissionWhereInput;
      if (input.onlySubmissionId) {
        // One card (opening it): no queue filters, any status.
        where = { id: input.onlySubmissionId, formId, form: PERFORM_FORM };
      } else {
        const and: Prisma.EventApplicationSubmissionWhereInput[] = [];
        const statuses = input.filter.statuses;
        // FR-012: WITHDRAWN shows only when the status filter asks for it.
        and.push(
          statuses && statuses.length > 0
            ? { status: { in: statuses } }
            : { status: { not: "WITHDRAWN" } },
        );
        if (input.filter.dateId) {
          const dateId = input.filter.dateId;
          and.push({
            dateChoices: { some: { OR: [{ occurrenceId: dateId }, { eventDateId: dateId }] } },
          });
        }
        const myVote = input.filter.myVote;
        if (myVote === "NONE") {
          and.push({ votes: { none: { humanId: viewerHumanId } } });
        } else if (myVote) {
          and.push({ votes: { some: { humanId: viewerHumanId, vote: myVote } } });
        }
        // Keyset resume on (createdAt, id). The cursor row is resolved on
        // THIS form, so a foreign or unknown id restarts from the top.
        const after = input.cursor
          ? await p.eventApplicationSubmission.findFirst({
              where: { id: input.cursor, formId },
              select: { id: true, createdAt: true },
            })
          : null;
        if (after) {
          and.push({
            OR: [
              { createdAt: { gt: after.createdAt } },
              { createdAt: after.createdAt, id: { gt: after.id } },
            ],
          });
        }
        where = { formId, form: PERFORM_FORM, AND: and };
      }

      // THE order (FR-012, principle 6): time applied, oldest first. Traces,
      // votes and notes never reach this clause.
      const rows = await p.eventApplicationSubmission.findMany({
        where,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: take + 1,
        select: REVIEW_SUBMISSION_SELECT,
      });
      const page = rows.slice(0, take);
      const nextCursor =
        !input.onlySubmissionId && rows.length > take ? (page.at(-1)?.id ?? null) : null;
      if (page.length === 0) return { items: [], nextCursor: null };

      const ids = page.map((r) => r.id);
      const humanIds = [
        ...new Set(page.filter((r) => !r.applyingAsOrgId && r.humanId).map((r) => r.humanId!)),
      ];
      const orgIds = [
        ...new Set(page.filter((r) => r.applyingAsOrgId).map((r) => r.applyingAsOrgId!)),
      ];

      // A fixed number of bulk reads for the whole page (never per card).
      const [voteGroups, myVotes, noteGroups, unreadGroups, humans, orgs, pages, traces] =
        await Promise.all([
          p.applicationVote.groupBy({
            by: ["submissionId", "vote"],
            where: { submissionId: { in: ids } },
            _count: { _all: true },
          }),
          p.applicationVote.findMany({
            where: { submissionId: { in: ids }, humanId: viewerHumanId },
            select: { submissionId: true, vote: true },
          }),
          p.applicationNote.groupBy({
            by: ["submissionId"],
            where: { submissionId: { in: ids } },
            _count: { _all: true },
          }),
          p.applicationMessage.groupBy({
            by: ["submissionId"],
            where: { submissionId: { in: ids }, authorSide: "APPLICANT", readAt: null },
            _count: { _all: true },
          }),
          humanIds.length > 0
            ? p.human.findMany({ where: { id: { in: humanIds } }, select: { id: true, name: true } })
            : Promise.resolve([] as Array<{ id: string; name: string | null }>),
          orgIds.length > 0
            ? p.organization.findMany({
                where: { id: { in: orgIds } },
                select: { id: true, name: true },
              })
            : Promise.resolve([] as Array<{ id: string; name: string | null }>),
          humanIds.length + orgIds.length === 0
            ? Promise.resolve(
                [] as Array<{
                  ownerType: string;
                  ownerId: string;
                  slug: string;
                  displayName: string | null;
                  avatarUrl: string | null;
                }>,
              )
            : p.entityPage.findMany({
                // Photo and slug from a PUBLIC page only, as on the peer list.
                where: {
                  visibility: "PUBLIC",
                  OR: [
                    ...(humanIds.length > 0
                      ? [{ ownerType: "HUMAN" as const, ownerId: { in: humanIds } }]
                      : []),
                    ...(orgIds.length > 0
                      ? [{ ownerType: "ORGANIZATION" as const, ownerId: { in: orgIds } }]
                      : []),
                  ],
                },
                select: {
                  ownerType: true,
                  ownerId: true,
                  slug: true,
                  displayName: true,
                  avatarUrl: true,
                },
              }),
          loadTraceCounts(p, {
            formId,
            humanIds,
            orgIds,
            now: input.now,
            lineupRoles: input.lineupRoles,
            organiserOrgRoles: input.organiserOrgRoles,
          }),
        ]);

      // v1: every stored vote counts, including votes by people who have
      // since left the organizer side (a vote is the record of a review that
      // happened). Revisit with the sides model.
      //
      // Same v1 limit on the traces' organiser status: it reads CURRENT
      // org membership (OrgMember keeps no history). A member who has left
      // an org sees their old self-booked nights there read as "played"; a
      // person who became EDITOR later sees their earlier nights on its
      // lineups read as "ran".
      const tallies = new Map<string, { yes: number; maybe: number; no: number }>();
      for (const g of voteGroups) {
        const t = tallies.get(g.submissionId) ?? emptyTally();
        addToTally(t, g.vote, g._count._all);
        tallies.set(g.submissionId, t);
      }
      const myVoteOf = new Map(myVotes.map((v) => [v.submissionId, v.vote as ApplicationVoteValue]));
      const notesOf = new Map(noteGroups.map((g) => [g.submissionId, g._count._all]));
      const unreadOf = new Map(unreadGroups.map((g) => [g.submissionId, g._count._all]));
      const humanName = new Map(humans.map((h) => [h.id, h.name]));
      const orgName = new Map(orgs.map((o) => [o.id, o.name]));
      const pageOf = (type: "HUMAN" | "ORGANIZATION", id: string) =>
        pages.find((pg) => pg.ownerType === type && pg.ownerId === id) ?? null;

      const items: OpenCallReviewCardRecord[] = page.map((row) => {
        let displayName: string | null;
        let photoUrl: string | null = null;
        let pageSlug: string | null = null;
        let traceCounts: OpenCallTraceCounts | null = null;
        if (row.applyingAsOrgId) {
          const pg = pageOf("ORGANIZATION", row.applyingAsOrgId);
          displayName = orgName.get(row.applyingAsOrgId) ?? pg?.displayName ?? null;
          photoUrl = pg?.avatarUrl ?? null;
          pageSlug = pg?.slug ?? null;
          traceCounts = traces.get(`org:${row.applyingAsOrgId}`) ?? null;
        } else if (row.humanId) {
          const pg = pageOf("HUMAN", row.humanId);
          displayName = pg?.displayName ?? humanName.get(row.humanId) ?? null;
          photoUrl = pg?.avatarUrl ?? null;
          pageSlug = pg?.slug ?? null;
          traceCounts = traces.get(`human:${row.humanId}`) ?? null;
        } else {
          displayName = row.guestName;
        }
        return {
          submission: mapReviewSubmission(row),
          displayName,
          photoUrl,
          pageSlug,
          votes: tallies.get(row.id) ?? emptyTally(),
          myVote: myVoteOf.get(row.id) ?? null,
          noteCount: notesOf.get(row.id) ?? 0,
          unreadForOrganizer: unreadOf.get(row.id) ?? 0,
          traces: traceCounts,
        };
      });
      return { items, nextCursor };
    },

    markOpenCallSubmissionOpened: async (input) => {
      // ONE single-table UPDATE (no relation filter, so the WHERE is
      // re-checked under the row lock): an applicant edit holding the row
      // either commits first or sees openedAt set and matches nothing.
      const { count } = await p.eventApplicationSubmission.updateMany({
        where: {
          id: requireId(input.submissionId, "markOpenCallSubmissionOpened", "submissionId"),
          formId: requireId(input.formId, "markOpenCallSubmissionOpened", "formId"),
          openedAt: null,
        },
        data: { openedAt: input.openedAt },
      });
      return count > 0;
    },

    setApplicationVote: async (input) => {
      const submissionId = requireId(input.submissionId, "setApplicationVote", "submissionId");
      const humanId = requireId(input.humanId, "setApplicationVote", "humanId");
      if (input.vote === null) {
        await p.applicationVote.deleteMany({ where: { submissionId, humanId } });
        return;
      }
      // Atomic upsert on the (submissionId, humanId) unique index: two
      // concurrent votes by one human leave exactly one row (the later
      // write's value). The id is minted here (Prisma's uuid() default is
      // client-side). Timestamps are naive UTC like every Prisma column.
      await p.$executeRaw(Prisma.sql`
        INSERT INTO "ApplicationVote" ("id", "submissionId", "humanId", "vote", "createdAt", "updatedAt")
        VALUES (
          ${randomUUID()}, ${submissionId}, ${humanId},
          ${input.vote}::"ApplicationVoteValue", ${input.at}::timestamp, ${input.at}::timestamp
        )
        ON CONFLICT ("submissionId", "humanId")
        DO UPDATE SET "vote" = EXCLUDED."vote", "updatedAt" = EXCLUDED."updatedAt"
      `);
    },

    getApplicationVoteSummary: async (input) => {
      const submissionId = requireId(input.submissionId, "getApplicationVoteSummary", "submissionId");
      const [groups, mine] = await Promise.all([
        p.applicationVote.groupBy({
          by: ["vote"],
          where: { submissionId },
          _count: { _all: true },
        }),
        p.applicationVote.findUnique({
          where: {
            submissionId_humanId: {
              submissionId,
              humanId: requireId(input.viewerHumanId, "getApplicationVoteSummary", "viewerHumanId"),
            },
          },
          select: { vote: true },
        }),
      ]);
      const votes = emptyTally();
      for (const g of groups) addToTally(votes, g.vote, g._count._all);
      return { votes, myVote: (mine?.vote as ApplicationVoteValue | undefined) ?? null };
    },

    createApplicationNote: async (input) => {
      const row = await p.applicationNote.create({
        data: {
          submissionId: requireId(input.submissionId, "createApplicationNote", "submissionId"),
          authorHumanId: requireId(input.authorHumanId, "createApplicationNote", "authorHumanId"),
          body: input.body,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        },
        select: NOTE_SELECT,
      });
      return mapNote(row);
    },

    listApplicationNotes: async (input) => {
      const rows = await p.applicationNote.findMany({
        where: {
          submissionId: requireId(input.submissionId, "listApplicationNotes", "submissionId"),
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: clamp(input.limit, 1, MAX_NOTES),
        select: NOTE_SELECT,
      });
      return rows.map(mapNote);
    },

    createApplicationMessage: async (input) => {
      const row = await p.applicationMessage.create({
        data: {
          submissionId: requireId(input.submissionId, "createApplicationMessage", "submissionId"),
          authorSide: input.authorSide,
          authorHumanId: input.authorHumanId,
          body: input.body,
          createdAt: input.createdAt,
        },
        select: MESSAGE_SELECT,
      });
      return mapMessage(row);
    },

    listApplicationMessages: async (input) => {
      const submissionId = requireId(input.submissionId, "listApplicationMessages", "submissionId");
      const take = clamp(input.limit, 1, MAX_MESSAGES);
      // Same keyset as BookingRequestMessage: the cursor row is resolved on
      // THIS submission, so another thread's id restarts from the top.
      const after = input.cursor
        ? await p.applicationMessage.findFirst({
            where: { id: input.cursor, submissionId },
            select: { id: true, createdAt: true },
          })
        : null;
      const rows = await p.applicationMessage.findMany({
        where: {
          submissionId,
          ...(after
            ? {
                OR: [
                  { createdAt: { gt: after.createdAt } },
                  { createdAt: after.createdAt, id: { gt: after.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: take + 1,
        select: MESSAGE_SELECT,
      });
      const items = rows.slice(0, take).map(mapMessage);
      const nextCursor = rows.length > take ? (items.at(-1)?.id ?? null) : null;
      return { items, nextCursor };
    },

    markApplicationMessagesRead: async (input) => {
      // Stamp the OTHER side's unread rows up to the cutoff. `readAt: null`
      // in the WHERE keeps it monotonic and idempotent: a stamped row keeps
      // its first stamp, and the reader's own rows are never touched.
      const other: ApplicationMessageAuthorSide =
        input.readerSide === "ORGANIZER" ? "APPLICANT" : "ORGANIZER";
      const { count } = await p.applicationMessage.updateMany({
        where: {
          submissionId: requireId(input.submissionId, "markApplicationMessagesRead", "submissionId"),
          authorSide: other,
          readAt: null,
          createdAt: { lte: input.upToCreatedAt },
        },
        data: { readAt: input.readAt },
      });
      return count;
    },
  };
}
