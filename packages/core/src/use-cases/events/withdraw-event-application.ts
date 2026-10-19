import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { EventGateType, EventVisibility } from "@th/ports/repos/events";
import { applicationSubmissionStatusSchema } from "@th/schema";

import { parseInput } from "../../lib/io";
import { isStatusConflict } from "./_shared/status-conflict";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const withdrawEventApplicationInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    eventId: z.string().uuid(),
    /**
     * Optional explicit target. When omitted the actor's LATEST submission
     * for the event is withdrawn (same resolution as
     * getViewerApplicationStatus). When present, the submission must belong
     * to the actor — anyone else's is FORBIDDEN.
     */
    submissionId: z.string().uuid().optional(),
  })
  .strict();

export const withdrawEventApplicationOutputSchema = z
  .object({
    eventId: z.string().uuid(),
    submissionId: z.string().uuid(),
    status: applicationSubmissionStatusSchema,
  })
  .strict();

export type WithdrawEventApplicationInput = z.infer<
  typeof withdrawEventApplicationInputSchema
>;
export type WithdrawEventApplicationOutput = z.infer<
  typeof withdrawEventApplicationOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type WithdrawEventApplicationDeps = {
  repos: Pick<Repos, "tx" | "events" | "eventApplications">;
  clock: ClockPort;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The APPLICANT pulls back their own PENDING submission (spec Phase 2 item
 * 2, parity with withdraw-booking-request):
 *  - identity is the signed-in human — a submission is withdrawable only by
 *    the human who owns it (`humanId` match; anonymous submissions have no
 *    on-platform owner and cannot be withdrawn — their PENDING rows carry no
 *    approval token to authenticate against, so the anon exit paths are the
 *    organizer's decision or the expiry sweep);
 *  - idempotent: withdrawing an already-WITHDRAWN submission is a success
 *    no-op;
 *  - any other non-PENDING state (APPROVED / REJECTED / WAITLISTED /
 *    EXPIRED) throws `INVALID_STATUS` — a decided application is taken up
 *    with the organizer, not silently unwound;
 *  - NO organizer notification (verified parity: withdraw-booking-request
 *    sends none — the queue simply reflects the new status).
 */
export async function withdrawEventApplication(
  deps: WithdrawEventApplicationDeps,
  rawInput: unknown,
): Promise<WithdrawEventApplicationOutput> {
  const input = parseInput(withdrawEventApplicationInputSchema, rawInput);

  const event = await deps.repos.events.getById(input.eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }

  const submission = await resolveSubmission(deps.repos, input);

  // Idempotent no-op.
  if (submission.status === "WITHDRAWN") {
    return withdrawEventApplicationOutputSchema.parse({
      eventId: event.id,
      submissionId: submission.id,
      status: submission.status,
    });
  }

  if (submission.status !== "PENDING") {
    throw fail("INVALID_STATUS");
  }

  const now = deps.clock.now();

  const withdrawn = await deps.repos.tx(async (tx) => {
    // Re-read inside the transaction: a concurrent review that committed
    // after our pre-read becomes INVALID_STATUS instead of being clobbered
    // (same re-check discipline as withdraw-booking-request).
    const fresh = await tx.eventApplications.getSubmissionById(submission.id);
    if (!fresh) {
      throw fail("SUBMISSION_NOT_FOUND");
    }
    if (fresh.status === "WITHDRAWN") return fresh;
    if (fresh.status !== "PENDING") {
      throw fail("INVALID_STATUS");
    }

    // Status-GUARDED write (expectedFromStatuses): even the tx re-read
    // above can race a concurrent approval under READ COMMITTED, so the
    // WHERE re-checks PENDING inside the write itself — a lost race
    // surfaces as a conflict, mapped to INVALID_STATUS, instead of
    // clobbering the reviewer's decision. approvalToken/tokenExpiresAt are
    // cleared defensively: null on a PENDING row anyway, but a withdraw
    // must never leave a live claim credential behind under any
    // interleaving. Reviewer fields stay untouched — a withdraw is not a
    // review.
    let updated;
    try {
      updated = await tx.eventApplications.updateSubmissionStatus({
        submissionId: fresh.id,
        status: "WITHDRAWN",
        approvalToken: null,
        tokenExpiresAt: null,
        expectedFromStatuses: ["PENDING"],
      });
    } catch (error) {
      if (isStatusConflict(error)) {
        throw fail("INVALID_STATUS");
      }
      throw error;
    }

    await tx.audit.log({
      entity: "event",
      entityId: event.id,
      action: "event_application_withdrawn",
      data: {
        actorHumanId: input.actorHumanId,
        submissionId: fresh.id,
        fromStatus: fresh.status,
      },
      at: now,
    });

    return updated;
  });

  deps.logger?.info("event_gate", {
    category: "event_gate",
    eventId: event.id,
    visibility: event.visibility as EventVisibility,
    gateType: event.gateType as EventGateType,
    action: "application_withdrawn",
    result: "success",
    viewerHumanId: input.actorHumanId,
    metadata: { submissionId: withdrawn.id },
  });

  return withdrawEventApplicationOutputSchema.parse({
    eventId: event.id,
    submissionId: withdrawn.id,
    status: withdrawn.status,
  });
}

/**
 * Ownership-scoped resolution: an explicit submissionId must belong to this
 * event AND this human (someone else's → FORBIDDEN, mirroring
 * withdraw-booking-request's NOT_RESOURCE_OWNER discipline); without one,
 * the actor's own latest submission is the target.
 */
async function resolveSubmission(
  repos: Pick<Repos, "eventApplications">,
  input: WithdrawEventApplicationInput,
) {
  if (input.submissionId) {
    const submission = await repos.eventApplications.getSubmissionById(
      input.submissionId,
    );
    // Open calls v1: attendee path only; a PERFORM submission is not found.
    if (
      !submission ||
      submission.purpose !== "ATTEND" ||
      submission.eventId !== input.eventId
    ) {
      throw fail("SUBMISSION_NOT_FOUND");
    }
    if (!submission.humanId || submission.humanId !== input.actorHumanId) {
      throw fail("FORBIDDEN");
    }
    return submission;
  }

  const submission =
    await repos.eventApplications.getSubmissionByEventAndHuman(
      input.eventId,
      "ATTEND",
      input.actorHumanId,
    );
  if (!submission) {
    throw fail("SUBMISSION_NOT_FOUND");
  }
  return submission;
}
