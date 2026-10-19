import { z } from "zod";

import { fail } from "@th/errors";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { ApplicationMessageRecord } from "@th/ports/repos/events";

import { parseInput } from "../../../lib/io";
import { plainTextMultilineRequired } from "../../../lib/sanitize-plain-text";
import {
  APPLICATION_MESSAGE_MAX,
  applicationMessageSchema,
  applicationThreadPartySchema,
  type NotifyApplicationMessagePostedFn,
  projectApplicationMessage,
  resolveThreadParty,
  threadIsReadOnly,
} from "./_shared/application-thread";
import { anchorOfForm } from "./_shared/open-call-anchor";

export const postApplicationMessageInputSchema = z
  .object({
    party: applicationThreadPartySchema,
    body: plainTextMultilineRequired(APPLICATION_MESSAGE_MAX),
  })
  .strict();

export const postApplicationMessageOutputSchema = z
  .object({ message: applicationMessageSchema })
  .strict();

export type PostApplicationMessageInput = z.input<typeof postApplicationMessageInputSchema>;
export type PostApplicationMessageOutput = z.infer<typeof postApplicationMessageOutputSchema>;

export type PostApplicationMessageDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
  /** The other side's notice (FR-015). Unwired = nobody is told. */
  notifyApplicationMessagePosted?: NotifyApplicationMessagePostedFn;
  /** Best-effort reporter for the notification swallow branch. */
  reportError?: ReporterPort;
};

/**
 * Append one message to an application's thread (FR-015), from either side.
 *
 * Auth: the organizer side (`isOnOrganizerSide`) naming call + application,
 * or the applicant by session or status token (step 4 auth, token expiry
 * included). Refusals are the same NOT_FOUND / LINK_EXPIRED answers as the
 * rest of the open-call surface.
 *
 * Posting works while the application is open and after a decision, so a
 * "not this time" can be answered. A WITHDRAWN application's thread is
 * read-only (OPEN_CALL_THREAD_CLOSED); see `threadIsReadOnly`.
 *
 * A message does NOT stamp `openedAt`: an organizer asking "please add your
 * link" must leave the applicant able to edit (unlike opening, voting or
 * noting, see `_shared/first-open.ts`).
 *
 * NOTE: rate limiting is TRANSPORT-owned (same split as booking messages):
 * the procedure that wires this must throttle per actor / per token.
 *
 * Audit: metadata only, never the body.
 */
export async function postApplicationMessage(
  deps: PostApplicationMessageDeps,
  rawInput: unknown,
): Promise<PostApplicationMessageOutput> {
  const input = parseInput(postApplicationMessageInputSchema, rawInput);
  const now = deps.clock.now();

  const { message, formId, side } = await deps.repos.tx(async (tx) => {
    const party = await resolveThreadParty(tx, input.party, now);
    if (threadIsReadOnly(party.submission)) {
      throw fail("OPEN_CALL_THREAD_CLOSED");
    }
    const created = await tx.eventApplications.createApplicationMessage({
      submissionId: party.submission.id,
      authorSide: party.side,
      authorHumanId: party.authorHumanId,
      body: input.body,
      createdAt: now,
    });
    const ref = anchorOfForm(party.form);
    await tx.audit.log({
      entity: ref.kind === "event" ? "event" : "event_series",
      entityId: ref.kind === "event" ? ref.eventId : ref.seriesId,
      action: "open_call_application_message_posted",
      data: {
        formId: party.form.id,
        submissionId: party.submission.id,
        messageId: created.id,
        authorSide: party.side,
        actorHumanId: party.authorHumanId,
        bodyLength: created.body.length,
      },
      at: now,
    });
    return { message: created, formId: party.form.id, side: party.side };
  });

  await notifyOtherSide(deps, formId, message);

  deps.logger?.info("open_call", {
    category: "open_call",
    action: "message_posted",
    formId,
    submissionId: message.submissionId,
    messageId: message.id,
    authorSide: side,
  });

  return postApplicationMessageOutputSchema.parse({
    message: projectApplicationMessage(message, side),
  });
}

/**
 * Post-commit notice to the other side. Deliberate
 * swallow with a guarded reportError (CLAUDE.md convention): a throwing
 * notifier never fails the committed message.
 */
async function notifyOtherSide(
  deps: PostApplicationMessageDeps,
  formId: string,
  message: ApplicationMessageRecord,
): Promise<void> {
  if (!deps.notifyApplicationMessagePosted) return;
  try {
    await deps.notifyApplicationMessagePosted({
      formId,
      submissionId: message.submissionId,
      messageId: message.id,
      recipientSide: message.authorSide === "ORGANIZER" ? "APPLICANT" : "ORGANIZER",
      authorHumanId: message.authorHumanId,
      body: message.body,
    });
  } catch (error) {
    deps.logger?.error("open_call.notify_message_posted_failed", {
      formId,
      submissionId: message.submissionId,
      messageId: message.id,
      err: error,
    });
    try {
      deps.reportError?.(error, {
        tags: { useCase: "postApplicationMessage" },
        extra: { formId, submissionId: message.submissionId, messageId: message.id },
      });
    } catch {
      // Reporting is best-effort: a throwing reporter must never fail the
      // committed message.
    }
  }
}
