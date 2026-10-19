import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { fail } from "@th/errors";
import type { TxRepos } from "@th/ports/repos";
import type { OpenCallSubmissionRecord } from "@th/ports/repos/events";

import { parseInput } from "../../../lib/io";
import { stampFirstOpen } from "./_shared/first-open";
import { anchorOfForm } from "./_shared/open-call-anchor";
import { resolveOrganizerSubmission } from "./_shared/organizer-side";
import { applicationVoteValueSchema } from "./_shared/review-card";

export const castApplicationVoteInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    formId: z.uuid(),
    submissionId: z.uuid(),
    /** Yes / Maybe / No; null clears the actor's vote. */
    vote: applicationVoteValueSchema.nullable(),
  })
  .strict();

export const castApplicationVoteOutputSchema = z
  .object({
    myVote: applicationVoteValueSchema.nullable(),
    votes: z
      .object({
        yes: z.number().int().nonnegative(),
        maybe: z.number().int().nonnegative(),
        no: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export type CastApplicationVoteInput = z.input<typeof castApplicationVoteInputSchema>;
export type CastApplicationVoteOutput = z.infer<typeof castApplicationVoteOutputSchema>;

export type CastApplicationVoteDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * Cast, change or clear the actor's vote on an application (FR-014). One
 * vote per (application, organizer human): the write is an atomic upsert
 * on that unique key, so changing a vote replaces it and two racing votes
 * by one human leave one row. `vote: null` deletes the row (the natural
 * "no vote" state the `myVote: NONE` filter reads).
 *
 * Anyone on the organizer side, any status (FR-023 keeps past calls
 * reviewable), EXCEPT on their own application: refused with
 * OPEN_CALL_VOTE_OWN_APPLICATION when the actor submitted it, or it was
 * sent as an org the actor is a member of (any role). Conflict of
 * interest, same spirit as `ensureDelegateNotSelfRecipient`. They may still
 * read it and add notes. Votes are organizer-side only and never feed the
 * queue's order (principle 6).
 *
 * A vote (not a clear) is a judgement on the answers, so it stamps
 * `openedAt` in the same transaction when nobody has opened the card yet
 * (FR-010 edit lock, `stampFirstOpen`): nobody votes YES on an answer that
 * can still change.
 *
 * Audit: the new value, inside the same transaction.
 */
export async function castApplicationVote(
  deps: CastApplicationVoteDeps,
  rawInput: unknown,
): Promise<CastApplicationVoteOutput> {
  const input = parseInput(castApplicationVoteInputSchema, rawInput);
  const now = deps.clock.now();

  const summary = await deps.repos.tx(async (tx) => {
    const { form, submission } = await resolveOrganizerSubmission(tx, input);
    await ensureNotOwnApplication(tx, submission, input.actorHumanId);
    if (input.vote !== null) {
      await stampFirstOpen(tx, {
        form,
        submission,
        actorHumanId: input.actorHumanId,
        now,
        via: "vote",
      });
    }
    await tx.eventApplications.setApplicationVote({
      submissionId: submission.id,
      humanId: input.actorHumanId,
      vote: input.vote,
      at: now,
    });
    const ref = anchorOfForm(form);
    await tx.audit.log({
      entity: ref.kind === "event" ? "event" : "event_series",
      entityId: ref.kind === "event" ? ref.eventId : ref.seriesId,
      action: "open_call_application_vote_cast",
      data: {
        actorHumanId: input.actorHumanId,
        formId: form.id,
        submissionId: submission.id,
        vote: input.vote,
      },
      at: now,
    });
    return tx.eventApplications.getApplicationVoteSummary({
      submissionId: submission.id,
      viewerHumanId: input.actorHumanId,
    });
  });

  deps.logger?.info("open_call", {
    category: "open_call",
    action: "vote_cast",
    formId: input.formId,
    submissionId: input.submissionId,
    actorHumanId: input.actorHumanId,
  });

  return castApplicationVoteOutputSchema.parse({
    myVote: summary.myVote,
    votes: summary.votes,
  });
}

/**
 * Refuse a vote on the actor's own application: they submitted it, or it
 * was sent as an org they belong to (any role, current membership).
 */
async function ensureNotOwnApplication(
  tx: Pick<TxRepos, "authz">,
  submission: Pick<OpenCallSubmissionRecord, "humanId" | "applyingAsOrgId">,
  actorHumanId: string,
): Promise<void> {
  if (submission.humanId === actorHumanId) {
    throw fail("OPEN_CALL_VOTE_OWN_APPLICATION");
  }
  if (submission.applyingAsOrgId) {
    const membership = await tx.authz.getOrgMembership({
      orgId: submission.applyingAsOrgId,
      humanId: actorHumanId,
    });
    if (membership) throw fail("OPEN_CALL_VOTE_OWN_APPLICATION");
  }
}
