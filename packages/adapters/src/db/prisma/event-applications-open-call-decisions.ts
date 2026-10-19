import { Prisma } from "@prisma/client";
import type {
  EventApplicationsRepo,
  OpenCallLineupAct,
} from "@th/ports/repos/events";

import {
  mapSubmission,
  PERFORM_FORM,
  requireId,
  SUBMISSION_SELECT,
} from "./event-applications-open-call-submissions";
import { makeOpenCallSweepMethods, type OpenCallSweepMethods } from "./event-applications-open-call-sweep";
import type { PrismaClientOrTx } from "./types";

/**
 * Open-call DECISION methods of the event-applications repo (open calls v1
 * step 6): the submission row lock, pick, "not this time", drop out, the
 * lineup-removal stamp, and locking every application of one act.
 * `makeEventApplicationsRepo` spreads them in.
 *
 * Every write is ONE single-table UPDATE keyed by (id, formId) with its
 * status guard in the WHERE, so the guard is re-checked under the row lock
 * (no relation filter: Prisma may run one as SELECT ids + UPDATE, checking
 * the guard outside the lock). `formId` is the PERFORM form the caller read
 * the id on, so an attendee row never matches.
 */

type OpenCallDecisionMethods = Pick<
  EventApplicationsRepo,
  | "lockOpenCallSubmission"
  | "approveOpenCallSubmission"
  | "rejectOpenCallSubmission"
  | "markOpenCallSubmissionDroppedOut"
  | "markOpenCallSubmissionRemovedFromLineup"
  | "lockOpenCallSubmissionsByAct"
>;

const UNDECIDED = ["PENDING", "WAITLISTED"] as const;

export function makeOpenCallDecisionMethods(
  p: PrismaClientOrTx,
): OpenCallDecisionMethods & OpenCallSweepMethods {
  return {
    // The step-8 sweep's flips and reconcile reads (same guarded-UPDATE
    // discipline) — see ./event-applications-open-call-sweep.ts.
    ...makeOpenCallSweepMethods(p),
    lockOpenCallSubmission: async (input) => {
      const id = requireId(input.submissionId, "lockOpenCallSubmission", "submissionId");
      const formId = requireId(input.formId, "lockOpenCallSubmission", "formId");
      // The submission row ONLY: no join, so `FOR UPDATE` cannot reach the
      // form row (close holds that FOR UPDATE and then updates submissions;
      // locking it here would invert the order). All values are bind
      // parameters.
      const locked = await p.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT s."id"
        FROM "EventApplicationSubmission" s
        WHERE s."id" = ${id} AND s."formId" = ${formId}
        FOR UPDATE
      `);
      if (locked.length === 0) return null;
      // Read under the lock we now hold; PERFORM-only like every open-call read.
      const row = await p.eventApplicationSubmission.findFirst({
        where: { id, formId, form: PERFORM_FORM },
        select: SUBMISSION_SELECT,
      });
      return row ? mapSubmission(row) : null;
    },

    approveOpenCallSubmission: async (input) => {
      const { count } = await p.eventApplicationSubmission.updateMany({
        where: {
          id: requireId(input.submissionId, "approveOpenCallSubmission", "submissionId"),
          formId: requireId(input.formId, "approveOpenCallSubmission", "formId"),
          status: { in: [...UNDECIDED] },
        },
        data: {
          status: "APPROVED",
          reviewerHumanId: requireId(
            input.reviewerHumanId,
            "approveOpenCallSubmission",
            "reviewerHumanId",
          ),
          reviewedAt: input.reviewedAt,
        },
      });
      return count > 0;
    },

    rejectOpenCallSubmission: async (input) => {
      const { count } = await p.eventApplicationSubmission.updateMany({
        where: {
          id: requireId(input.submissionId, "rejectOpenCallSubmission", "submissionId"),
          formId: requireId(input.formId, "rejectOpenCallSubmission", "formId"),
          status: { in: [...UNDECIDED] },
        },
        data: {
          status: "REJECTED",
          reviewerHumanId: requireId(
            input.reviewerHumanId,
            "rejectOpenCallSubmission",
            "reviewerHumanId",
          ),
          reviewedAt: input.reviewedAt,
          decisionReason: input.decisionReason,
        },
      });
      return count > 0;
    },

    markOpenCallSubmissionDroppedOut: async (input) => {
      const { count } = await p.eventApplicationSubmission.updateMany({
        where: {
          id: requireId(input.submissionId, "markOpenCallSubmissionDroppedOut", "submissionId"),
          formId: requireId(input.formId, "markOpenCallSubmissionDroppedOut", "formId"),
          status: "APPROVED",
        },
        data: { status: "WITHDRAWN", droppedOutAt: input.droppedOutAt },
      });
      return count > 0;
    },

    markOpenCallSubmissionRemovedFromLineup: async (input) => {
      const { count } = await p.eventApplicationSubmission.updateMany({
        where: {
          id: requireId(
            input.submissionId,
            "markOpenCallSubmissionRemovedFromLineup",
            "submissionId",
          ),
          formId: requireId(input.formId, "markOpenCallSubmissionRemovedFromLineup", "formId"),
          status: "APPROVED",
          removedFromLineupAt: null,
        },
        data: { removedFromLineupAt: input.removedAt },
      });
      return count > 0;
    },

    lockOpenCallSubmissionsByAct: async (input) => {
      const formId = requireId(input.formId, "lockOpenCallSubmissionsByAct", "formId");
      const act = input.act as OpenCallLineupAct;
      let identity: Prisma.Sql;
      if (act.kind === "human") {
        const humanId = requireId(act.humanId, "lockOpenCallSubmissionsByAct", "humanId");
        identity = Prisma.sql`s."humanId" = ${humanId} AND s."applyingAsOrgId" IS NULL`;
      } else if (act.kind === "org") {
        const orgId = requireId(act.orgId, "lockOpenCallSubmissionsByAct", "orgId");
        identity = Prisma.sql`s."applyingAsOrgId" = ${orgId}`;
      } else {
        const name = act.name.trim();
        if (name.length === 0) return [];
        // Name only (a superset): core matches the url under the lock.
        identity = Prisma.sql`s."humanId" IS NULL AND s."applyingAsOrgId" IS NULL
          AND lower(btrim(s."guestName")) = lower(${name})`;
      }
      // ANY status, locked FOR UPDATE in id order: the Sort runs below the
      // LockRows node, so rows are locked in ascending id order and two
      // lineup-exit paths locking several rows cannot invert. Submission
      // rows ONLY (no join, so the form row is never locked). Every value is
      // a bind parameter.
      const locked = await p.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT s."id"
        FROM "EventApplicationSubmission" s
        WHERE s."formId" = ${formId} AND ${identity}
        ORDER BY s."id" COLLATE "C"
        FOR UPDATE
      `);
      if (locked.length === 0) return [];
      const rows = await p.eventApplicationSubmission.findMany({
        where: { id: { in: locked.map((r) => r.id) }, formId, form: PERFORM_FORM },
        select: SUBMISSION_SELECT,
      });
      return rows.map(mapSubmission).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
  };
}
