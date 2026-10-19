import { Prisma } from "@prisma/client";
import type {
  ApplicationSubmissionStatus,
  CreateOpenCallSubmissionInput,
  EventApplicationQuestionSnapshotEntry,
  EventApplicationsRepo,
  MyOpenCallApplicationRecord,
  OpenCallDateChoiceRecord,
  OpenCallDateChoiceTarget,
  OpenCallPeerRecord,
  OpenCallSubmissionRecord,
  UpdateOpenCallSubmissionInput,
} from "@th/ports/repos/events";

import { WITHHELD_HUMAN_IDS_SQL, WITHHELD_ORG_IDS_SQL } from "./banned-owner";
import type { PrismaClientOrTx } from "./types";

/**
 * Open-call APPLICATION methods of the event-applications repo (open calls
 * v1 step 4): PERFORM submissions, their date choices, the peer list and the
 * applicant's own list. `makeEventApplicationsRepo` spreads them in.
 *
 * Every read filters `form: { purpose: 'PERFORM' }` and every write is keyed
 * so it can only reach a PERFORM row, so an attendee (ATTEND) submission is
 * invisible here: a lookup by its id or token hash answers null.
 */

type OpenCallSubmissionMethods = Pick<
  EventApplicationsRepo,
  | "createOpenCallSubmission"
  | "getOpenCallSubmissionById"
  | "getOpenCallSubmissionByTokenHash"
  | "updateOpenCallSubmission"
  | "withdrawPendingOpenCallSubmission"
  | "setOpenCallSubmissionPrivacy"
  | "isLatestOpenCallSubmission"
  | "listOpenCallPeers"
  | "listOpenCallSubmissionsByHuman"
>;

export const PERFORM_FORM = { purpose: "PERFORM" } as const;

/**
 * SQL predicate: `n` is a LATER row (createdAt DESC, id DESC under
 * COLLATE "C", exactly the peer list's order) of the same applicant identity
 * as `t`, on t's form. Identity as in listOpenCallPeers' key: an org row is
 * the org; a self row the human (self rows only); a guest row
 * lower(contactEmail). Static SQL, no values.
 */
const LATER_SAME_IDENTITY_SQL = Prisma.sql`
  n."formId" = t."formId"
  AND (
    n."createdAt" > t."createdAt"
    OR (n."createdAt" = t."createdAt" AND n."id" COLLATE "C" > t."id" COLLATE "C")
  )
  AND (
    (t."applyingAsOrgId" IS NOT NULL AND n."applyingAsOrgId" = t."applyingAsOrgId")
    OR (t."applyingAsOrgId" IS NULL AND t."humanId" IS NOT NULL
        AND n."applyingAsOrgId" IS NULL AND n."humanId" = t."humanId")
    OR (t."applyingAsOrgId" IS NULL AND t."humanId" IS NULL
        AND n."applyingAsOrgId" IS NULL AND n."humanId" IS NULL
        AND lower(n."contactEmail") = lower(t."contactEmail"))
  )
`;

export const SUBMISSION_SELECT = {
  id: true,
  formId: true,
  eventId: true,
  humanId: true,
  applyingAsOrgId: true,
  guestName: true,
  guestUrl: true,
  contactEmail: true,
  contactLocale: true,
  status: true,
  answers: true,
  questionsSnapshot: true,
  isPrivate: true,
  openedAt: true,
  statusTokenHash: true,
  droppedOutAt: true,
  removedFromLineupAt: true,
  decisionReason: true,
  createdAt: true,
  updatedAt: true,
  dateChoices: {
    select: {
      eventId: true,
      occurrenceId: true,
      eventDateId: true,
      event: { select: { startsAt: true } },
      occurrence: { select: { startsAt: true } },
      eventDate: { select: { startsAt: true } },
    },
  },
} as const satisfies Prisma.EventApplicationSubmissionSelect;

export type SubmissionRow = Prisma.EventApplicationSubmissionGetPayload<{
  select: typeof SUBMISSION_SELECT;
}>;

const coerceRecord = (value: Prisma.JsonValue | null): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function requireId(value: unknown, method: string, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`eventApplications.${method}: ${name} is required`);
  }
  return value;
}

export function mapChoice(row: SubmissionRow["dateChoices"][number]): OpenCallDateChoiceRecord {
  const startsAt =
    row.occurrence?.startsAt ?? row.eventDate?.startsAt ?? row.event?.startsAt ?? null;
  if (!startsAt) {
    // The FK cascades delete a choice with its target, so a target-less row
    // is a broken invariant.
    throw new Error("OpenCallDateChoice has no target");
  }
  return {
    eventId: row.eventId,
    occurrenceId: row.occurrenceId,
    eventDateId: row.eventDateId,
    startsAt,
  };
}

export function mapSubmission(row: SubmissionRow): OpenCallSubmissionRecord {
  return {
    id: row.id,
    formId: row.formId,
    eventId: row.eventId,
    humanId: row.humanId,
    applyingAsOrgId: row.applyingAsOrgId,
    guestName: row.guestName,
    guestUrl: row.guestUrl,
    contactEmail: row.contactEmail,
    contactLocale: row.contactLocale,
    status: row.status as ApplicationSubmissionStatus,
    answers: coerceRecord(row.answers),
    questionsSnapshot: coerceRecord(row.questionsSnapshot) as unknown as Record<
      string,
      EventApplicationQuestionSnapshotEntry
    >,
    isPrivate: row.isPrivate,
    openedAt: row.openedAt,
    statusTokenHash: row.statusTokenHash,
    droppedOutAt: row.droppedOutAt,
    removedFromLineupAt: row.removedFromLineupAt,
    decisionReason: row.decisionReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    dateChoices: row.dateChoices
      .map(mapChoice)
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime()),
  };
}

/** Runtime guard: exactly one target id, as the SQL CHECK demands. */
function choiceData(
  target: OpenCallDateChoiceTarget,
): { occurrenceId: string } | { eventDateId: string } {
  const t = target as { occurrenceId?: unknown; eventDateId?: unknown; eventId?: unknown };
  const occ = typeof t.occurrenceId === "string" && t.occurrenceId ? t.occurrenceId : null;
  const ed = typeof t.eventDateId === "string" && t.eventDateId ? t.eventDateId : null;
  if ((occ === null) === (ed === null) || t.eventId !== undefined) {
    throw new Error("eventApplications: a date choice names exactly one occurrenceId or eventDateId");
  }
  return occ ? { occurrenceId: occ } : { eventDateId: ed! };
}

export function makeOpenCallSubmissionMethods(
  p: PrismaClientOrTx,
  helpers: {
    /** The P2002 match on the one-open-application indexes (event-applications.ts). */
    isOpenDedupeViolation: (error: unknown) => boolean;
  },
): OpenCallSubmissionMethods {
  return {
    createOpenCallSubmission: async (input: CreateOpenCallSubmissionInput) => {
      const formId = requireId(input.formId, "createOpenCallSubmission", "formId");
      const statusTokenHash = requireId(
        input.statusTokenHash,
        "createOpenCallSubmission",
        "statusTokenHash",
      );
      try {
        const row = await p.eventApplicationSubmission.create({
          data: {
            id: requireId(input.id, "createOpenCallSubmission", "id"),
            formId,
            eventId: input.eventId,
            humanId: input.humanId,
            applyingAsOrgId: input.applyingAsOrgId,
            guestName: input.guestName,
            guestUrl: input.guestUrl,
            contactEmail: input.contactEmail,
            contactLocale: input.contactLocale,
            answers: input.answers as Prisma.InputJsonValue,
            questionsSnapshot: input.questionsSnapshot as unknown as Prisma.InputJsonValue,
            isPrivate: input.isPrivate,
            statusTokenHash,
            metadata: {},
            createdAt: input.submittedAt,
            updatedAt: input.submittedAt,
            dateChoices: {
              create: input.dateChoices.map((c) => ({
                ...choiceData(c),
                createdAt: input.submittedAt,
              })),
            },
          },
          select: SUBMISSION_SELECT,
        });
        return mapSubmission(row);
      } catch (error) {
        // Same index-name match as createSubmission: only the dedupe indexes
        // are a duplicate application; a statusTokenHash or date-choice
        // collision is a bug and surfaces as itself.
        if (helpers.isOpenDedupeViolation(error)) {
          throw {
            code: "duplicate_open_application",
            message: "duplicate_open_application",
            cause: error,
          } as const;
        }
        throw error;
      }
    },

    getOpenCallSubmissionById: async (submissionId) => {
      const row = await p.eventApplicationSubmission.findFirst({
        where: {
          id: requireId(submissionId, "getOpenCallSubmissionById", "submissionId"),
          form: PERFORM_FORM,
        },
        select: SUBMISSION_SELECT,
      });
      return row ? mapSubmission(row) : null;
    },

    getOpenCallSubmissionByTokenHash: async (statusTokenHash) => {
      // findUnique on the unique index, then the purpose check: an ATTEND row
      // never carries a status token, but the read stays PERFORM-only anyway.
      const row = await p.eventApplicationSubmission.findUnique({
        where: {
          statusTokenHash: requireId(
            statusTokenHash,
            "getOpenCallSubmissionByTokenHash",
            "statusTokenHash",
          ),
        },
        select: { ...SUBMISSION_SELECT, form: { select: { purpose: true } } },
      });
      if (!row || row.form.purpose !== "PERFORM") return null;
      const { form: _form, ...rest } = row;
      return mapSubmission(rest);
    },

    updateOpenCallSubmission: async (input: UpdateOpenCallSubmissionInput) => {
      const id = requireId(input.submissionId, "updateOpenCallSubmission", "submissionId");
      const choices = input.dateChoices.map(choiceData);
      // The guard lives in the write: PENDING, not yet opened by the
      // organizer side. The UPDATE takes the row lock, so an
      // organizer "open" (which stamps openedAt) either commits first and
      // this matches nothing, or waits for this transaction.
      const { count } = await p.eventApplicationSubmission.updateMany({
        // Same-table columns only, so this is ONE UPDATE whose WHERE is
        // re-checked under the row lock. No relation filter: Prisma may run
        // one as SELECT ids + UPDATE, checking the guard outside the lock.
        // formId (same table) is the PERFORM form the caller read this id
        // on, so an attendee row never matches.
        where: {
          id,
          formId: requireId(input.formId, "updateOpenCallSubmission", "formId"),
          status: "PENDING",
          openedAt: null,
        },
        data: {
          answers: input.answers as Prisma.InputJsonValue,
          questionsSnapshot: input.questionsSnapshot as unknown as Prisma.InputJsonValue,
          isPrivate: input.isPrivate,
        },
      });
      if (count === 0) return null;
      await p.openCallDateChoice.deleteMany({ where: { submissionId: id } });
      if (choices.length > 0) {
        await p.openCallDateChoice.createMany({
          data: choices.map((c) => ({ ...c, submissionId: id })),
        });
      }
      const row = await p.eventApplicationSubmission.findUnique({
        where: { id },
        select: SUBMISSION_SELECT,
      });
      return row ? mapSubmission(row) : null;
    },

    withdrawPendingOpenCallSubmission: async (input) => {
      const { count } = await p.eventApplicationSubmission.updateMany({
        where: {
          id: requireId(input.submissionId, "withdrawPendingOpenCallSubmission", "submissionId"),
          formId: requireId(input.formId, "withdrawPendingOpenCallSubmission", "formId"),
          status: "PENDING",
          // No relation filter (see updateOpenCallSubmission): one UPDATE,
          // guard re-checked under the row lock; formId scopes it to the
          // PERFORM form the caller read.
        },
        data: { status: "WITHDRAWN" },
      });
      return count > 0;
    },

    setOpenCallSubmissionPrivacy: async (input) => {
      const id = requireId(input.submissionId, "setOpenCallSubmissionPrivacy", "submissionId");
      const formId = requireId(input.formId, "setOpenCallSubmissionPrivacy", "formId");
      // ONE statement. `pre` locks the row (FOR UPDATE) and reads the
      // pre-image from the LOCKED version, so of two concurrent toggles the
      // second waits and sees the first's value (only one reports a change).
      // The UPDATE's guard: not WITHDRAWN (any other status, opened or not)
      // and no LATER row of the same identity on the form (the row the peer
      // list judges privacy by), so toggling a superseded row is refused
      // rather than silently doing nothing. A re-application racing this
      // either is visible here (refused) or commits after it (equivalent to
      // the toggle happening first; the new row carries its own choice).
      // formId scopes it to the PERFORM form the caller read. updatedAt is
      // set by hand (raw SQL skips Prisma's @updatedAt), as naive UTC like
      // every Prisma timestamp. All values are bind parameters. (`pre`, not
      // `old`: PG 18 reserves OLD/NEW as RETURNING aliases.)
      const rows = await p.$queryRaw<Array<{ wasPrivate: boolean }>>(Prisma.sql`
        WITH pre AS (
          SELECT s."id", s."isPrivate"
          FROM "EventApplicationSubmission" s
          WHERE s."id" = ${id} AND s."formId" = ${formId}
          FOR UPDATE
        )
        UPDATE "EventApplicationSubmission" t
        SET "isPrivate" = ${input.isPrivate},
            "updatedAt" = (now() AT TIME ZONE 'UTC')
        FROM pre
        WHERE t."id" = pre."id"
          AND t."status" <> 'WITHDRAWN'::"ApplicationSubmissionStatus"
          AND NOT EXISTS (
            SELECT 1 FROM "EventApplicationSubmission" n
            WHERE ${LATER_SAME_IDENTITY_SQL}
          )
        RETURNING pre."isPrivate" AS "wasPrivate"
      `);
      if (rows.length === 0) return null;
      const row = await p.eventApplicationSubmission.findUnique({
        where: { id },
        select: SUBMISSION_SELECT,
      });
      return row ? { record: mapSubmission(row), wasPrivate: rows[0]!.wasPrivate } : null;
    },

    isLatestOpenCallSubmission: async (input) => {
      const id = requireId(input.submissionId, "isLatestOpenCallSubmission", "submissionId");
      const formId = requireId(input.formId, "isLatestOpenCallSubmission", "formId");
      const rows = await p.$queryRaw<Array<{ latest: boolean }>>(Prisma.sql`
        SELECT NOT EXISTS (
          SELECT 1 FROM "EventApplicationSubmission" n
          WHERE ${LATER_SAME_IDENTITY_SQL}
        ) AS "latest"
        FROM "EventApplicationSubmission" t
        JOIN "EventApplicationForm" f
          ON f."id" = t."formId" AND f."purpose" = 'PERFORM'::"ApplicationFormPurpose"
        WHERE t."id" = ${id} AND t."formId" = ${formId}
      `);
      return rows[0]?.latest === true;
    },

    listOpenCallPeers: async (input) => {
      const formId = requireId(input.formId, "listOpenCallPeers", "formId");
      const limit = Math.max(0, Math.min(input.limit, 500));
      // The viewer's own identity (every row sharing it is excluded, not
      // just the submission they are looking at): self rows of their human,
      // the org they applied as, or (a guest) their lowercased email.
      const viewerKeys: string[] = [];
      if (input.viewer.humanId) viewerKeys.push(`human:${input.viewer.humanId}`);
      if (input.viewer.applyingAsOrgId) viewerKeys.push(`org:${input.viewer.applyingAsOrgId}`);
      if (!input.viewer.humanId && input.viewer.contactEmail) {
        viewerKeys.push(`guest:${input.viewer.contactEmail.toLowerCase()}`);
      }
      if (viewerKeys.length === 0) viewerKeys.push("");

      // ONE entry per applicant IDENTITY (window over the identity key): an
      // applicant told "not this time" may re-apply (FR-011), and two
      // entries for one name would reveal that. Privacy is PER IDENTITY:
      // the identity's LATEST row (createdAt DESC, id DESC) decides, over
      // ALL its rows. If that row is private or WITHDRAWN the identity is
      // not listed at all, so an applicant who switches "Keep my
      // application private" on (any time, even after opening) or
      // re-applies privately disappears, rather than surfacing through an
      // older public row. The list is ordered by the identity's FIRST row
      // (also over all rows), so a re-applicant keeps their original place
      // and position reveals nothing. Banned people / orgs
      // (ban-that-sticks, checked on the row shown) and the viewer are
      // filtered HERE, never after the fact (FR-008, NFR-002). Every value
      // is a bind parameter.
      const rows = await p.$queryRaw<
        Array<{
          humanId: string | null;
          applyingAsOrgId: string | null;
          guestName: string | null;
          guestUrl: string | null;
          humanName: string | null;
          orgName: string | null;
        }>
      >(Prisma.sql`
        WITH ranked AS (
          SELECT s."humanId", s."applyingAsOrgId", s."guestName", s."guestUrl",
                 s."isPrivate", s."status", k.key,
                 MIN(s."createdAt") OVER (PARTITION BY k.key) AS "firstAt",
                 ROW_NUMBER() OVER (
                   PARTITION BY k.key ORDER BY s."createdAt" DESC, s."id" COLLATE "C" DESC
                 ) AS rn
          FROM "EventApplicationSubmission" s
          JOIN "EventApplicationForm" f
            ON f."id" = s."formId" AND f."purpose" = 'PERFORM'::"ApplicationFormPurpose"
          CROSS JOIN LATERAL (
            SELECT CASE
              WHEN s."applyingAsOrgId" IS NOT NULL THEN 'org:' || s."applyingAsOrgId"
              WHEN s."humanId" IS NOT NULL THEN 'human:' || s."humanId"
              ELSE 'guest:' || lower(s."contactEmail")
            END AS key
          ) k
          WHERE s."formId" = ${formId}
            AND k.key IS NOT NULL
        )
        SELECT x."humanId", x."applyingAsOrgId", x."guestName", x."guestUrl",
               h."name" AS "humanName", o."name" AS "orgName"
        FROM ranked x
        LEFT JOIN "Human" h ON h."id" = x."humanId"
        LEFT JOIN "Organization" o ON o."id" = x."applyingAsOrgId"
        WHERE x.rn = 1
          AND x."isPrivate" = false
          AND x."status" <> 'WITHDRAWN'::"ApplicationSubmissionStatus"
          AND x.key NOT IN (${Prisma.join(viewerKeys)})
          AND (x."humanId" IS NULL OR x."humanId" NOT IN (${WITHHELD_HUMAN_IDS_SQL}))
          AND (x."applyingAsOrgId" IS NULL OR x."applyingAsOrgId" NOT IN (${WITHHELD_ORG_IDS_SQL}))
        ORDER BY x."firstAt" ASC, x.key COLLATE "C" ASC
        LIMIT ${limit}
      `);

      const humanIds = rows
        .filter((r) => !r.applyingAsOrgId && r.humanId)
        .map((r) => r.humanId!);
      const orgIds = rows.filter((r) => r.applyingAsOrgId).map((r) => r.applyingAsOrgId!);
      const pages =
        humanIds.length + orgIds.length === 0
          ? []
          : await p.entityPage.findMany({
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
            });
      const pageOf = (type: "HUMAN" | "ORGANIZATION", id: string) =>
        pages.find((pg) => pg.ownerType === type && pg.ownerId === id) ?? null;

      const peers: OpenCallPeerRecord[] = [];
      for (const r of rows) {
        if (r.applyingAsOrgId) {
          const page = pageOf("ORGANIZATION", r.applyingAsOrgId);
          const name = r.orgName ?? page?.displayName ?? null;
          if (!name) continue;
          peers.push({
            kind: "org",
            name,
            photoUrl: page?.avatarUrl ?? null,
            pageSlug: page?.slug ?? null,
            url: null,
          });
        } else if (r.humanId) {
          const page = pageOf("HUMAN", r.humanId);
          const name = page?.displayName ?? r.humanName ?? null;
          if (!name) continue;
          peers.push({
            kind: "human",
            name,
            photoUrl: page?.avatarUrl ?? null,
            pageSlug: page?.slug ?? null,
            url: null,
          });
        } else if (r.guestName) {
          peers.push({
            kind: "guest",
            name: r.guestName,
            photoUrl: null,
            pageSlug: null,
            url: r.guestUrl,
          });
        }
      }
      return peers;
    },

    listOpenCallSubmissionsByHuman: async (input) => {
      const humanId = requireId(input.humanId, "listOpenCallSubmissionsByHuman", "humanId");
      const orgIds = [...new Set(input.orgIds ?? [])].filter((id) => id.length > 0);
      const rows = await p.eventApplicationSubmission.findMany({
        where: {
          form: PERFORM_FORM,
          OR: [
            { humanId, applyingAsOrgId: null },
            ...(orgIds.length > 0 ? [{ applyingAsOrgId: { in: orgIds } }] : []),
          ],
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: Math.max(0, Math.min(input.limit, 200)),
        select: {
          id: true,
          status: true,
          applyingAsOrgId: true,
          createdAt: true,
          applyingAsOrg: { select: { name: true } },
          form: {
            select: {
              publicId: true,
              eventId: true,
              seriesId: true,
              event: { select: { title: true } },
              series: { select: { name: true } },
            },
          },
        },
      });
      const out: MyOpenCallApplicationRecord[] = [];
      for (const r of rows) {
        const f = r.form;
        const anchor = f.eventId
          ? ({ kind: "event", eventId: f.eventId } as const)
          : f.seriesId
            ? ({ kind: "series", seriesId: f.seriesId } as const)
            : null;
        const title = f.event?.title ?? f.series?.name ?? null;
        if (!anchor || title === null) continue;
        out.push({
          submissionId: r.id,
          publicId: f.publicId,
          anchor,
          title,
          status: r.status as ApplicationSubmissionStatus,
          applyingAsOrgId: r.applyingAsOrgId,
          applyingAsOrgName: r.applyingAsOrg?.name ?? null,
          createdAt: r.createdAt,
        });
      }
      return out;
    },
  };
}
