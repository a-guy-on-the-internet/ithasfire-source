import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import { isAppError } from "@th/errors";

import { applyRescindDecision } from "../_shared/apply-rescind-decision";
import { isStatusConflict } from "../_shared/status-conflict";
import { rescindEventApplicationDecision } from "../rescind-event-application-decision";
import { reportSwallowed } from "./_shared";

/**
 * Phase 2 of removing what an invite let in: every still-APPROVED ATTEND
 * submission the invite approved goes through the EXISTING rescind path,
 * which moves it back to PENDING and revokes its unlocks by submission.
 * `th_ea_` grants die with the APPROVED status. Shared by
 * `revokeEventGuestInvite` (one PERSONAL invite, R9) and
 * `setEventSharedInvite`'s RESET_AND_REMOVE (every earlier SHARED link).
 *
 * The caller has ALREADY committed phase 1 (the invite row marked dead and
 * `revokeByInvite` run). Phase 1 is what removes people: the read path
 * (`inviteApprovalRevoked`) refuses an approval from a dead invite whether
 * or not this phase reached it. So this phase is best-effort:
 *
 *  - a failed rescind is logged + reported (`channel: invite_rescind_failed`)
 *    and the loop goes on to the rest; never rethrown;
 *  - stopping at {@link MAX_RESCIND_PAGES} with rows left is reported too
 *    (`invite_rescind_truncated`);
 *  - a failed LIST (the read of what is left to rescind) ends the loop with
 *    the counts so far, logged + reported (`invite_rescind_list_failed`):
 *    phase 1 has committed, so throwing would tell the organiser the removal
 *    failed when it did not;
 *  - running it again repairs a stranded approval (idempotent).
 *
 * Each rescind is guarded: it only lands while the row is still APPROVED and
 * still carries this invite. A decision or withdraw committing between the
 * list and the rescind wins; that row counts as moved on, not as a failure.
 *
 * It runs whatever the gate type is NOW: the organizer may have switched the
 * event APPLICATION → PASSWORD after the invite approved people, and those
 * approvals must still go (they would open the gate again if the event is
 * switched back).
 *
 * No "back in review" notice: the guest never applied, so that message would
 * be wrong. The rescind deps get no notifier.
 */

export type RescindInviteApprovalsDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
  reportError?: ReporterPort;
};

const RESCIND_PAGE_SIZE = 200;
/** 20 × 200 rescinds per invite. */
const MAX_RESCIND_PAGES = 20;

export async function rescindInviteApprovals(
  deps: RescindInviteApprovalsDeps,
  args: {
    eventId: string;
    inviteId: string;
    actorHumanId: string;
    /** Tags the reports and log lines (the calling use case). */
    useCase: string;
    /** Merged into each rescind's audit row, e.g. `{ viaInviteRevoke: id }`. */
    auditData: Record<string, unknown>;
  },
): Promise<{ submissionsRescinded: number }> {
  const { eventId, inviteId, useCase } = args;
  let submissionsRescinded = 0;
  // Rows already tried (rescinded, moved on, or failed). A failed or no-op
  // row can still list as APPROVED at offset 0; skipping it keeps the loop
  // from retrying it on every page.
  const attempted = new Set<string>();
  const listApproved = async () => {
    try {
      return await deps.repos.eventApplications.listSubmissions({
        eventId,
        purpose: "ATTEND",
        statuses: ["APPROVED"],
        inviteId,
        limit: RESCIND_PAGE_SIZE,
      });
    } catch (error) {
      // Deliberate swallow (see the header): stop with partial counts.
      deps.logger?.error(`events.${useCase}.rescind_list_failed`, {
        eventId,
        inviteId,
        submissionsRescinded,
        err: error,
      });
      reportSwallowed(deps.reportError, error, {
        tags: { useCase, channel: "invite_rescind_list_failed" },
        extra: { eventId, inviteId, submissionsRescinded },
      });
      return null;
    }
  };
  // Defence in depth: the adapter filters, but never rescind a row the
  // invite didn't approve.
  const pending = (items: { id: string; inviteId: string | null }[]) =>
    items.filter((s) => s.inviteId === inviteId && !attempted.has(s.id));

  let drained = false;
  let page = 0;
  for (; page < MAX_RESCIND_PAGES; page += 1) {
    // Always offset 0: each rescind moves its row out of APPROVED.
    const listed = await listApproved();
    if (!listed) return { submissionsRescinded };
    const { items } = listed;
    const approvedByInvite = pending(items);
    if (approvedByInvite.length === 0) {
      // A full page of rows already tried may hide untried ones behind it.
      drained = items.length < RESCIND_PAGE_SIZE;
      break;
    }
    for (const submission of approvedByInvite) {
      attempted.add(submission.id);
      try {
        const rescinded = await rescindOne(deps, {
          actorHumanId: args.actorHumanId,
          eventId,
          inviteId,
          submissionId: submission.id,
          auditData: args.auditData,
        });
        if (rescinded) submissionsRescinded += 1;
      } catch (error) {
        // Deliberate swallow: the invite is dead and the read path already
        // refuses this approval (see the header). Keep going.
        deps.logger?.error(`events.${useCase}.rescind_failed`, {
          eventId,
          inviteId,
          submissionId: submission.id,
          err: error,
        });
        reportSwallowed(deps.reportError, error, {
          tags: { useCase, channel: "invite_rescind_failed" },
          extra: { eventId, inviteId, submissionId: submission.id },
        });
      }
    }
  }
  if (!drained && page >= MAX_RESCIND_PAGES) {
    const listed = await listApproved();
    if (!listed) return { submissionsRescinded };
    drained = pending(listed.items).length === 0;
  }
  if (!drained) {
    deps.logger?.error(`events.${useCase}.rescind_truncated`, {
      eventId,
      inviteId,
      submissionsRescinded,
    });
    reportSwallowed(
      deps.reportError,
      new Error("invite removal stopped before rescinding every approval"),
      {
        tags: { useCase, channel: "invite_rescind_truncated" },
        extra: { eventId, inviteId, submissionsRescinded },
      },
    );
  }
  return { submissionsRescinded };
}

/**
 * Rescind one invite approval through the existing rescind path. That use
 * case only runs on an APPLICATION-gated event; when the gate has since
 * been switched, the same durable writes run here through the shared
 * `applyRescindDecision`. Resolves false when there was nothing left to
 * rescind (already rescinded or otherwise moved on).
 */
async function rescindOne(
  deps: RescindInviteApprovalsDeps,
  args: {
    actorHumanId: string;
    eventId: string;
    inviteId: string;
    submissionId: string;
    auditData: Record<string, unknown>;
  },
): Promise<boolean> {
  try {
    await rescindEventApplicationDecision(
      {
        repos: deps.repos,
        clock: deps.clock,
        logger: deps.logger,
        reportError: deps.reportError,
      },
      {
        actorHumanId: args.actorHumanId,
        eventId: args.eventId,
        submissionId: args.submissionId,
      },
      // Only while it is still THIS invite's approval: an organizer decision
      // (or a withdraw) landing after our list must not be overwritten.
      { expectedInviteId: args.inviteId, expectedFromStatuses: ["APPROVED"] },
    );
    return true;
  } catch (error) {
    // The row moved on between our list and this call (rescinded, decided,
    // withdrawn, or no longer this invite's): done, nothing to report.
    if (
      isAppError(error) &&
      (error.code === "SUBMISSION_NOT_REVIEWED" ||
        error.code === "INVALID_STATUS")
    ) {
      return false;
    }
    if (isStatusConflict(error)) return false;
    if (!(isAppError(error) && error.code === "EVENT_NOT_APPLICATION_GATED")) {
      throw error;
    }
  }

  // Same durable writes as the rescind use case (shared helper), guarded
  // on the row still being an APPROVED approval from THIS invite. A row that
  // moved on (someone else rescinded it, or a review changed it) is done.
  const now = deps.clock.now();
  try {
    return await deps.repos.tx(async (tx) => {
      const submission = await tx.eventApplications.getSubmissionById(
        args.submissionId,
      );
      if (
        !submission ||
        submission.eventId !== args.eventId ||
        submission.purpose !== "ATTEND" ||
        submission.inviteId !== args.inviteId ||
        submission.status !== "APPROVED"
      ) {
        return false;
      }
      await applyRescindDecision(tx, {
        eventId: args.eventId,
        submission,
        actorHumanId: args.actorHumanId,
        at: now,
        expectedFromStatuses: ["APPROVED"],
        expectedInviteId: args.inviteId,
        auditData: args.auditData,
      });
      return true;
    });
  } catch (error) {
    // Lost the APPROVED CAS: a concurrent rescind/review got there first.
    if (isStatusConflict(error)) return false;
    throw error;
  }
}
