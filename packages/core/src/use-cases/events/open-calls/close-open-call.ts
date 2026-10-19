import { z } from "zod";

import { fail } from "@th/errors";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../../lib/io";
import {
  anchorOfForm,
  ensureActorCanEditOpenCallAnchor,
} from "./_shared/open-call-anchor";
import { runOpenCallNotice, type OpenCallNotThisTimeNotice } from "./_shared/open-call-decision";
import { anchorTitle } from "./get-open-call-application-status";

/**
 * Most "not this time" notices a close sends inside its own request. Each
 * notice is a few reads plus a send per recipient, so a call with hundreds
 * of PENDING applications would hold the organizer's request open for
 * minutes. The rest are left to step 8's reconcile, which re-calls the
 * (idempotent) notifier for every REJECTED application whose notice was not
 * sent (`openCallNoticeWasSent`). The close itself is unaffected.
 */
export const CLOSE_NOTICES_IN_REQUEST_MAX = 25;
/**
 * The info log line a close writes when it leaves notices to step 8
 * (fields: formId, deferred, sent). A STABLE key: step 8's reconcile and any
 * log-based alert search for it; do not rename.
 */
export const CLOSE_NOTICES_DEFERRED_LOG_KEY = "open_call.close_notices_deferred";

export const closeOpenCallInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    formId: z.uuid(),
  })
  .strict();

export const closeOpenCallOutputSchema = z
  .object({
    formId: z.uuid(),
    /** Null only for a draft call (see `posted`). */
    closedAt: z.date().nullable(),
    /**
     * False for a DRAFT call (never posted, owner ruling Q41): closing it is
     * a no-op. Nothing is written or swept, so it can still be posted later.
     */
    posted: z.boolean(),
    /** True when the call was already closed: nothing changed. */
    alreadyClosed: z.boolean(),
    /** How many PENDING applications this close set to "not this time". */
    swept: z.number().int().nonnegative(),
    /**
     * The ids it swept. Each gets the standard "not this time" notice after
     * the commit (`notifyOpenCallNotThisTime`); an empty list on a repeat
     * close means nothing is sent twice.
     */
    sweptSubmissionIds: z.array(z.uuid()),
  })
  .strict();

export type CloseOpenCallInput = z.infer<typeof closeOpenCallInputSchema>;
export type CloseOpenCallOutput = z.infer<typeof closeOpenCallOutputSchema>;

export type CloseOpenCallDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
  reportError?: ReporterPort;
  /**
   * The standard "not this time" reply to each swept applicant (FR-020; no
   * note). After the commit, once per swept submission; a failure is logged
   * and reported, and the close stands. The notifier is idempotent per
   * (submission, kind), so step 8's job reconciles any miss by re-calling
   * it; delivery never depends on this return value alone. At most
   * CLOSE_NOTICES_IN_REQUEST_MAX are sent in the close request.
   */
  notifyOpenCallNotThisTime?: (notice: OpenCallNotThisTimeNotice) => Promise<unknown>;
};

/**
 * Close an open call (FR-005) and run the close sweep (FR-020): every
 * PENDING application on the call becomes REJECTED ("not this time") with
 * reviewedAt stamped. Applicants already picked or told (APPROVED, REJECTED,
 * WITHDRAWN, EXPIRED) are untouched. Auth: edit rights on the call's event or
 * series.
 *
 * Idempotent: closing a closed call changes nothing and returns swept 0.
 *
 * ── One transaction, and the race with a submit ────────────────────────
 * The closedAt write and the sweep share one transaction, under the form
 * row's FOR UPDATE lock (`lockOpenCallForClose`):
 *   - a submit whose INSERT is already in flight holds FOR KEY SHARE on the
 *     form row (its foreign-key check). FOR UPDATE waits for it to commit,
 *     and the sweep statement, which runs after, sees and sweeps that row;
 *   - a submit that starts after the lock reads the call through
 *     `lockOpenCallForSubmit` (FOR KEY SHARE, step 4), which waits for this
 *     transaction and then sees closedAt set, and refuses.
 * Without the lock, a submit could read "open", insert PENDING after the
 * sweep statement ran, and leave an application nobody will ever answer.
 * Two closes at once serialise on the same lock; the second sees closedAt
 * and returns alreadyClosed with swept 0.
 */
export async function closeOpenCall(
  deps: CloseOpenCallDeps,
  rawInput: unknown,
): Promise<CloseOpenCallOutput> {
  const input = parseInput(closeOpenCallInputSchema, rawInput);

  const result = await deps.repos.tx(async (tx) => {
    // Auth BEFORE the row lock, so a stranger can't hold the call's lock.
    const form = await tx.eventApplications.getOpenCallById(input.formId);
    if (!form) throw fail("OPEN_CALL_NOT_FOUND");
    const anchorContext = await ensureActorCanEditOpenCallAnchor(
      tx,
      form,
      input.actorHumanId,
      deps.logger,
    );

    const locked = await tx.eventApplications.lockOpenCallForClose(form.id);
    if (!locked) throw fail("OPEN_CALL_NOT_FOUND");
    if (!locked.postedAt) {
      // A draft call takes no applications (submit refuses it), so there is
      // nothing to stop and nobody to sweep. Writing closedAt here would only
      // strand the draft: a closed call can't be posted, and reopen needs a
      // posted one. Harmless and idempotent: no write, swept 0.
      return {
        formId: locked.id,
        closedAt: null,
        posted: false,
        alreadyClosed: false,
        swept: 0,
        sweptSubmissionIds: [] as string[],
        title: anchorTitle(anchorContext),
        anchor: anchorOfForm(form),
      };
    }
    if (locked.closedAt) {
      return {
        formId: locked.id,
        closedAt: locked.closedAt,
        posted: true,
        alreadyClosed: true,
        swept: 0,
        sweptSubmissionIds: [] as string[],
        title: anchorTitle(anchorContext),
        anchor: anchorOfForm(form),
      };
    }

    const now = deps.clock.now();
    await tx.eventApplications.setOpenCallClosed({
      formId: locked.id,
      closedAt: now,
      closedByHumanId: input.actorHumanId,
    });
    const { ids } = await tx.eventApplications.rejectPendingOpenCallSubmissions({
      formId: locked.id,
      reviewedAt: now,
    });

    const anchor = anchorOfForm(locked);
    await tx.audit.log({
      entity: anchor.kind === "event" ? "event" : "event_series",
      entityId: anchor.kind === "event" ? anchor.eventId : anchor.seriesId,
      action: "open_call_closed",
      data: {
        actorHumanId: input.actorHumanId,
        formId: locked.id,
        sweptSubmissionIds: ids,
      },
      at: now,
    });

    return {
      formId: locked.id,
      closedAt: now,
      posted: true,
      alreadyClosed: false,
      swept: ids.length,
      sweptSubmissionIds: ids,
      title: anchorTitle(anchorContext),
      anchor,
    };
  });

  deps.logger?.info("open_call", {
    category: "open_call",
    formId: result.formId,
    action: "closed",
    alreadyClosed: result.alreadyClosed,
    swept: result.swept,
    actorHumanId: input.actorHumanId,
  });

  // FR-020: each swept applicant hears "not this time" (the standard reply,
  // no note). Sequential, one notice per submission; one failing notice is
  // reported and the rest still go out. At most CLOSE_NOTICES_IN_REQUEST_MAX
  // here; the remainder is step 8's reconcile.
  const inRequest = result.sweptSubmissionIds.slice(0, CLOSE_NOTICES_IN_REQUEST_MAX);
  const deferred = result.sweptSubmissionIds.length - inRequest.length;
  if (deferred > 0) {
    deps.logger?.info(CLOSE_NOTICES_DEFERRED_LOG_KEY, {
      category: "open_call",
      formId: result.formId,
      action: "close_notices_deferred",
      deferred,
      sent: inRequest.length,
    });
  }
  for (const submissionId of inRequest) {
    await runOpenCallNotice(deps, "closeOpenCall", deps.notifyOpenCallNotThisTime, {
      kind: "open_call_not_this_time",
      submissionId,
      formId: result.formId,
      anchor: result.anchor,
      title: result.title,
      decisionReason: null,
    });
  }

  const { title: _title, anchor: _anchor, ...output } = result;
  return closeOpenCallOutputSchema.parse(output);
}
