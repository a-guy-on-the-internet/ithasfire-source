import { z } from "zod";

import { fail } from "@th/errors";
import type { TxRepos } from "@th/ports/repos";
import type {
  OpenCallDateChoiceTarget,
  OpenCallFormRecord,
  OpenCallSubmissionRecord,
} from "@th/ports/repos/events";

import { ORG_EDIT_ROLES } from "../../../../lib/rbac";
import {
  LIVE_OCCURRENCE_STATUSES,
  listOpenCallDates,
  loadOpenCallAnchor,
  openCallEndedReason,
  type OpenCallAnchorContext,
  type OpenCallDate,
} from "./open-call-anchor";
import {
  hashStatusToken,
  STATUS_TOKEN_GRACE_MS,
  statusTokenHashesEqual,
  statusTokenSchema,
} from "./status-token";

/**
 * Shared pieces of the open-call APPLICATION use cases (open calls v1 step
 * 4): who the applicant is (session or status token), the call's state, and
 * the date-choice rules (FR-007).
 */

/**
 * Longest guest name (FR-006). The same bound as a free-text lineup name
 * (`attachEventHuman`'s externalName), so a picked guest's name always fits
 * on the lineup unchanged.
 */
export const OPEN_CALL_GUEST_NAME_MAX = 120;

// ── Applicant auth ─────────────────────────────────────────────────────────

/**
 * How the applicant proves "this application is mine":
 *   - `session`: for a person application, the signed-in human who
 *     submitted it (the submission's humanId); for an org application, any
 *     CURRENT ORG_EDIT_ROLES member of that org (`actsForOpenCallOrg`, owner
 *     Q45 extended to every session path), so a submitter who left the org
 *     loses access.
 *   - `token`: the raw status-link token (FR-009, NFR-001).
 */
export const openCallApplicantAuthSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("session"),
      actorHumanId: z.uuid(),
      submissionId: z.uuid(),
    })
    .strict(),
  z.object({ kind: z.literal("token"), token: statusTokenSchema }).strict(),
]);

export type OpenCallApplicantAuth = z.infer<typeof openCallApplicantAuthSchema>;

export interface ResolvedOpenCallApplication {
  submission: OpenCallSubmissionRecord;
  form: OpenCallFormRecord;
  anchor: OpenCallAnchorContext;
}

type ApplicantRepos = Pick<
  TxRepos,
  "eventApplications" | "events" | "series" | "eventDates" | "seriesOccurrences" | "authz"
>;

/**
 * THE rule for who may act, by session, on an ORGANISATION's application
 * (orchestrator decision 2026-10-07, one rule everywhere): a CURRENT member
 * of the applying org holding an ORG_EDIT_ROLES role. The same rule submit
 * uses to apply as the org. The submitter has no standing of their own: one
 * who left the org or was demoted below EDITOR loses access, and every other
 * edit member has it.
 */
export async function actsForOpenCallOrg(
  repos: Pick<TxRepos, "authz">,
  orgId: string,
  humanId: string,
): Promise<boolean> {
  const membership = await repos.authz.getOrgMembership({ orgId, humanId });
  return membership !== null && ORG_EDIT_ROLES.includes(membership.role);
}

/**
 * Resolve the applicant's own application, or refuse.
 *
 * OPEN_CALL_APPLICATION_NOT_FOUND for an unknown token, a submission that is
 * someone else's, an attendee (ATTEND) submission and a missing call: all
 * look the same, so neither a token nor a submission id can be probed.
 * OPEN_CALL_LINK_EXPIRED for a real token past its life (30 days after the
 * last date the application chose, NFR-001). Expiry applies to the token
 * only; the session path has its own lifetime.
 *
 * SESSION path: a person's application, its submitter (humanId); an
 * ORGANISATION's application, {@link actsForOpenCallOrg}. A refusal looks
 * like any other miss (NOT_FOUND).
 */
export async function resolveOpenCallApplication(
  repos: ApplicantRepos,
  auth: OpenCallApplicantAuth,
  now: Date,
): Promise<ResolvedOpenCallApplication> {
  let submission: OpenCallSubmissionRecord | null;
  if (auth.kind === "session") {
    submission = await repos.eventApplications.getOpenCallSubmissionById(auth.submissionId);
    if (!submission) throw fail("OPEN_CALL_APPLICATION_NOT_FOUND");
    const allowed = submission.applyingAsOrgId
      ? await actsForOpenCallOrg(repos, submission.applyingAsOrgId, auth.actorHumanId)
      : submission.humanId === auth.actorHumanId;
    if (!allowed) throw fail("OPEN_CALL_APPLICATION_NOT_FOUND");
  } else {
    const hash = hashStatusToken(auth.token);
    submission = await repos.eventApplications.getOpenCallSubmissionByTokenHash(hash);
    if (
      !submission ||
      !submission.statusTokenHash ||
      !statusTokenHashesEqual(submission.statusTokenHash, hash)
    ) {
      throw fail("OPEN_CALL_APPLICATION_NOT_FOUND");
    }
  }

  const form = await repos.eventApplications.getOpenCallById(submission.formId);
  if (!form) throw fail("OPEN_CALL_APPLICATION_NOT_FOUND");
  let anchor: OpenCallAnchorContext;
  try {
    anchor = await loadOpenCallAnchor(repos, form);
  } catch (error) {
    // A missing anchor reads as a missing application; anything else (a
    // database failure) surfaces as itself.
    if ((error as { code?: unknown } | null)?.code === "OPEN_CALL_NOT_FOUND") {
      throw fail("OPEN_CALL_APPLICATION_NOT_FOUND", { cause: error });
    }
    throw error;
  }

  if (auth.kind === "token") {
    const expiresAt = await statusTokenExpiresAt(repos, submission, anchor);
    if (now.getTime() > expiresAt.getTime()) throw fail("OPEN_CALL_LINK_EXPIRED");
  }
  return { submission, form, anchor };
}

/**
 * When a status token stops working (NFR-001): 30 days after the last date
 * the application chose. Without stored choices:
 *   - event call (single date, the night is implied): the event's last date;
 *   - series call (choices are always stored, so only when a schedule change
 *     cascaded them away): the series' last live occurrence after the
 *     application was made, else the day it was made. Generous on purpose,
 *     so an applicant whose dates were moved can still read their status.
 */
export async function statusTokenExpiresAt(
  repos: Pick<TxRepos, "eventDates" | "seriesOccurrences" | "events">,
  submission: Pick<OpenCallSubmissionRecord, "dateChoices" | "createdAt">,
  anchor: OpenCallAnchorContext,
): Promise<Date> {
  const last = submission.dateChoices.at(-1);
  let base: Date;
  if (last) {
    base = last.startsAt;
  } else if (anchor.kind === "event") {
    const dates = await listOpenCallDates(repos, anchor, {
      now: submission.createdAt,
      upcomingOnly: false,
    });
    base = dates.at(-1)?.startsAt ?? anchor.event.startsAt;
  } else {
    const occurrences = await repos.seriesOccurrences.listBySeriesAndStatuses(
      anchor.series.id,
      [...LIVE_OCCURRENCE_STATUSES],
      submission.createdAt,
    );
    const latest = occurrences.reduce<Date | null>(
      (max, o) => (max === null || o.startsAt.getTime() > max.getTime() ? o.startsAt : max),
      null,
    );
    base = latest ?? submission.createdAt;
  }
  return new Date(base.getTime() + STATUS_TOKEN_GRACE_MS);
}

// ── Call state ─────────────────────────────────────────────────────────────

export type OpenCallClosedReason = "closed_by_poster" | "last_date_started" | "event_ended";

/**
 * Whether the call is closed right now and why (same rule as the public
 * page), plus its upcoming dates (the dates an applicant may choose).
 */
export async function openCallState(
  repos: Pick<TxRepos, "eventDates" | "seriesOccurrences" | "events">,
  form: Pick<OpenCallFormRecord, "closedAt">,
  anchor: OpenCallAnchorContext,
  now: Date,
): Promise<{ closedReason: OpenCallClosedReason | null; upcoming: OpenCallDate[] }> {
  const { reason, upcoming } = await openCallEndedReason(repos, anchor, now);
  return { closedReason: form.closedAt ? "closed_by_poster" : reason, upcoming };
}

// ── Date choices (FR-007) ──────────────────────────────────────────────────

/** Most dates one application may choose. */
export const MAX_DATE_CHOICES = 100;

export const dateIdsSchema = z.array(z.uuid()).max(MAX_DATE_CHOICES).default([]);

/** The id a client names a choosable date by: its occurrence or EventDate id. */
export function openCallDateId(date: OpenCallDate): string | null {
  return date.occurrenceId ?? date.eventDateId;
}

/**
 * Turn the applicant's chosen date ids into stored targets.
 *
 * Choosable dates = the call's UPCOMING dates (`upcoming`). Every id must be
 * one of them (OPEN_CALL_DATE_INVALID otherwise: another call's date, a past
 * date, a cancelled one, a materialised event id). Duplicates collapse.
 *
 * Series call: the target is always the OCCURRENCE. An occurrence id is
 * stable whether or not the night was materialised into an event yet, and
 * the materialised eventId is never accepted as a choice, so one night can't
 * be chosen twice by two routes. Choices are always stored for a series,
 * even when only one night is upcoming (it's chosen for the applicant):
 * series gain nights over time, so an implied night would turn ambiguous.
 *
 * Event call: with more than one upcoming date, at least one is required
 * (OPEN_CALL_DATES_REQUIRED) and each is stored as its EventDate. With one
 * upcoming date the night is implied and NOTHING is stored (the applicant
 * may name that one date or none).
 */
export function resolveDateChoices(
  anchor: OpenCallAnchorContext,
  upcoming: OpenCallDate[],
  dateIds: readonly string[],
): OpenCallDateChoiceTarget[] {
  const wanted = [...new Set(dateIds)];
  const byId = new Map<string, OpenCallDate>();
  for (const d of upcoming) {
    const id = openCallDateId(d);
    if (id) byId.set(id, d);
  }
  for (const id of wanted) {
    if (!byId.has(id)) throw fail("OPEN_CALL_DATE_INVALID");
  }

  if (anchor.kind === "series") {
    if (wanted.length === 0) {
      const only = upcoming.length === 1 ? upcoming[0]?.occurrenceId : null;
      if (!only) throw fail("OPEN_CALL_DATES_REQUIRED");
      return [{ occurrenceId: only }];
    }
    return wanted.map((id) => ({ occurrenceId: byId.get(id)!.occurrenceId! }));
  }

  if (upcoming.length <= 1) return [];
  if (wanted.length === 0) throw fail("OPEN_CALL_DATES_REQUIRED");
  return wanted.map((id) => ({ eventDateId: byId.get(id)!.eventDateId! }));
}
