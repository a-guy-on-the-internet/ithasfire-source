import { z } from "zod";

import { fail } from "@th/errors";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../../lib/io";
import {
  anchorOfForm,
  ensureActorCanEditOpenCallAnchor,
  openCallEndedReason,
} from "./_shared/open-call-anchor";

export const reopenOpenCallInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    formId: z.uuid(),
  })
  .strict();

export const reopenOpenCallOutputSchema = z
  .object({
    formId: z.uuid(),
    /** False when the call was already open: nothing changed. */
    reopened: z.boolean(),
  })
  .strict();

export type ReopenOpenCallInput = z.infer<typeof reopenOpenCallInputSchema>;
export type ReopenOpenCallOutput = z.infer<typeof reopenOpenCallOutputSchema>;

export type ReopenOpenCallDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * Reopen a closed call (FR-005): it accepts new applications again. Allowed
 * only while the call still has an upcoming date: for an event call, the
 * event is not cancelled / archived / completed and one of its dates has not
 * started; for a series call, the series is not archived and has a live
 * occurrence (PLANNED / GENERATED / PUBLISHED) still to come. Otherwise
 * OPEN_CALL_NOT_REOPENABLE (meta.reason "event_ended" | "last_date_started").
 * A DRAFT call (never posted, Q41) is refused the same way with reason
 * "not_posted": posting is how a draft opens.
 *
 * Applications the close sweep set to "not this time" stay that way: those
 * applicants were told, and reopening must not take that back. Idempotent:
 * reopening an open call changes nothing. Auth: edit rights on the anchor.
 * Runs under the same row lock as close, so a close and a reopen at once
 * serialise.
 */
export async function reopenOpenCall(
  deps: ReopenOpenCallDeps,
  rawInput: unknown,
): Promise<ReopenOpenCallOutput> {
  const input = parseInput(reopenOpenCallInputSchema, rawInput);

  const result = await deps.repos.tx(async (tx) => {
    const form = await tx.eventApplications.getOpenCallById(input.formId);
    if (!form) throw fail("OPEN_CALL_NOT_FOUND");
    const anchor = await ensureActorCanEditOpenCallAnchor(
      tx,
      form,
      input.actorHumanId,
      deps.logger,
    );

    const locked = await tx.eventApplications.lockOpenCallForClose(form.id);
    if (!locked) throw fail("OPEN_CALL_NOT_FOUND");
    if (!locked.postedAt) {
      // A draft call was never open, so there is nothing to reopen: "Post
      // call" is how it opens (owner ruling Q41).
      throw fail("OPEN_CALL_NOT_REOPENABLE", { meta: { reason: "not_posted" } });
    }
    if (!locked.closedAt) {
      return { formId: locked.id, reopened: false };
    }

    const now = deps.clock.now();
    const { reason } = await openCallEndedReason(tx, anchor, now);
    if (reason) {
      throw fail("OPEN_CALL_NOT_REOPENABLE", { meta: { reason } });
    }

    await tx.eventApplications.setOpenCallClosed({
      formId: locked.id,
      closedAt: null,
      closedByHumanId: null,
    });

    const ref = anchorOfForm(locked);
    await tx.audit.log({
      entity: ref.kind === "event" ? "event" : "event_series",
      entityId: ref.kind === "event" ? ref.eventId : ref.seriesId,
      action: "open_call_reopened",
      data: { actorHumanId: input.actorHumanId, formId: locked.id },
      at: now,
    });

    return { formId: locked.id, reopened: true };
  });

  deps.logger?.info("open_call", {
    category: "open_call",
    formId: result.formId,
    action: "reopened",
    changed: result.reopened,
    actorHumanId: input.actorHumanId,
  });

  return reopenOpenCallOutputSchema.parse(result);
}
