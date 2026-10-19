import { z } from "zod";

import type {
  EventApplicationQuestionSnapshotEntry,
  OpenCallReviewCardRecord,
  OpenCallTraceCounts,
} from "@th/ports/repos/events";
import { applicationSubmissionStatusSchema } from "@th/schema";

import { PUBLIC_LINEUP_ROLES } from "../../../../lib/event-human-roles";
import { ORG_EDIT_ROLES } from "../../../../lib/rbac";

/**
 * The organizer side's view of one application (FR-013, FR-014). ORGANIZER
 * SIDE ONLY: votes, the tally, note counts and statuses live here and in no
 * applicant-facing schema (NFR-002).
 */

/**
 * EventHuman roles that count as PLAYING a night for the trust traces: the
 * public-lineup roles (every role but VOLUNTEER). Product rule borrowed from
 * profile show listings: if an event's public lineup credits you, you played.
 */
export const TRACE_LINEUP_ROLES = PUBLIC_LINEUP_ROLES;

/**
 * OrgMember roles that make a PERSON's own lineup nights on their org's
 * events count as "ran" for the traces (FR-013 "did not organise"): the
 * event-edit roles. Only nights the person is on the lineup of: holding the
 * role never credits the org's other nights. A plain member (VIEWER,
 * FINANCE, SCANNER) who plays it still "played". v1 limit: CURRENT
 * membership (OrgMember keeps no history).
 */
export const TRACE_ORGANISER_ORG_ROLES = ORG_EDIT_ROLES;

export const applicationVoteValueSchema = z.enum(["YES", "MAYBE", "NO"]);

/**
 * Trust traces as SHOWN (FR-013): "New here" instead of zeros. Display
 * only: no use case sorts, filters or gates on these (principles 5 and 6).
 */
export const openCallTracesSchema = z.discriminatedUnion("newHere", [
  z.object({ newHere: z.literal(true) }).strict(),
  z
    .object({
      newHere: z.literal(false),
      /** Null = nothing to show for this line (never a zero). */
      playedHereNights: z.number().int().positive().nullable(),
      playedNights: z.number().int().positive().nullable(),
      ranNights: z.number().int().positive().nullable(),
    })
    .strict(),
]);

export type OpenCallTraces = z.infer<typeof openCallTracesSchema>;

/**
 * Raw counts → what the card shows. A guest (no counts) or a signed-in
 * applicant who has neither played nor run a night is "New here". Otherwise
 * each line is its count, or null when that count is zero, so the screen
 * never prints a zero.
 */
export function toDisplayTraces(counts: OpenCallTraceCounts | null): OpenCallTraces {
  if (!counts || (counts.playedNights <= 0 && counts.ranNights <= 0)) {
    return { newHere: true };
  }
  const shown = (n: number) => (n > 0 ? n : null);
  return {
    newHere: false,
    playedHereNights: shown(counts.playedHereNights),
    playedNights: shown(counts.playedNights),
    ranNights: shown(counts.ranNights),
  };
}

const voteTallySchema = z
  .object({
    yes: z.number().int().nonnegative(),
    maybe: z.number().int().nonnegative(),
    no: z.number().int().nonnegative(),
  })
  .strict();

export const openCallReviewCardSchema = z
  .object({
    submissionId: z.uuid(),
    status: applicationSubmissionStatusSchema,
    appliedAs: z.enum(["person", "org", "guest"]),
    name: z.string().nullable(),
    photoUrl: z.string().nullable(),
    pageSlug: z.string().nullable(),
    /** A guest's own link. Signed-in applicants link through `pageSlug`. */
    url: z.string().nullable(),
    // NO answers / questions here (FR-010): the queue must not show an
    // answer the applicant can still change. They come with
    // `openOpenCallApplication`, which stamps openedAt (the edit lock).
    /** Dates chosen, by occurrence / EventDate id, ascending. */
    dateChoices: z.array(z.object({ id: z.string(), startsAt: z.date() }).strict()),
    appliedAt: z.date(),
    /** First opened by the organizer side (null = not yet). */
    openedAt: z.date().nullable(),
    votes: voteTallySchema,
    myVote: applicationVoteValueSchema.nullable(),
    noteCount: z.number().int().nonnegative(),
    /** Applicant messages the organizer side has not read. */
    unreadMessages: z.number().int().nonnegative(),
    traces: openCallTracesSchema,
  })
  .strict();

export type OpenCallReviewCard = z.infer<typeof openCallReviewCardSchema>;

/** The questions as they were when the answers were given, in form order. */
export const openCallQuestionsSchema = z.array(
  z
    .object({
      id: z.string(),
      label: z.string(),
      type: z.string(),
      options: z.array(z.object({ id: z.string(), label: z.string() }).strict()).nullable(),
    })
    .strict(),
);

export function projectQuestions(
  snapshot: Record<string, EventApplicationQuestionSnapshotEntry>,
): z.infer<typeof openCallQuestionsSchema> {
  return Object.entries(snapshot)
    .map(([id, entry]) => ({ id, entry }))
    .sort((a, b) => (a.entry.order ?? 0) - (b.entry.order ?? 0))
    .map(({ id, entry }) => ({
      id,
      label: entry.label,
      type: entry.type,
      options: entry.options?.map((o) => ({ id: o.id, label: o.label })) ?? null,
    }));
}

/** Field by field (never spread), so a column added later can't leak. */
export function projectReviewCard(card: OpenCallReviewCardRecord): OpenCallReviewCard {
  const s = card.submission;
  const appliedAs = s.applyingAsOrgId ? "org" : s.humanId ? "person" : "guest";
  return {
    submissionId: s.id,
    status: s.status,
    appliedAs,
    name: card.displayName,
    photoUrl: card.photoUrl,
    pageSlug: card.pageSlug,
    url: appliedAs === "guest" ? s.guestUrl : null,
    dateChoices: s.dateChoices.flatMap((c) => {
      const id = c.occurrenceId ?? c.eventDateId ?? null;
      return id ? [{ id, startsAt: c.startsAt }] : [];
    }),
    appliedAt: s.createdAt,
    openedAt: s.openedAt,
    votes: { yes: card.votes.yes, maybe: card.votes.maybe, no: card.votes.no },
    myVote: card.myVote,
    noteCount: card.noteCount,
    unreadMessages: card.unreadForOrganizer,
    // A guest never carries counts, whatever the repo returned.
    traces: toDisplayTraces(appliedAs === "guest" ? null : card.traces),
  };
}
