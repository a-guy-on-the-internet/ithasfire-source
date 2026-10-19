import { z } from "zod";

import { fail } from "@th/errors";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../../lib/io";
import {
  anchorOfForm,
  ensureActorCanEditOpenCallAnchor,
  findEventSeriesLink,
} from "./_shared/open-call-anchor";

export const discardOpenCallDraftInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    formId: z.uuid(),
  })
  .strict();

export const discardOpenCallDraftOutputSchema = z
  .object({
    formId: z.uuid(),
    /** False when the call was already gone: nothing changed. */
    discarded: z.boolean(),
  })
  .strict();

export type DiscardOpenCallDraftInput = z.infer<typeof discardOpenCallDraftInputSchema>;
export type DiscardOpenCallDraftOutput = z.infer<typeof discardOpenCallDraftOutputSchema>;

export type DiscardOpenCallDraftDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * Discard a DRAFT open call (never posted, owner ruling Q41). A draft holds
 * its night under FR-001 like a posted call does, so a forgotten series
 * draft would otherwise block every event in the series from opening its
 * own call, with no way out. Auth: edit rights on the call's event or
 * series, checked before any lock or write.
 *
 * Refused (INVALID_STATUS, meta.reason):
 *   - "posted": a posted call is stopped with Close, never deleted, so its
 *     applicants and history stay;
 *   - "has_submissions": a draft can't have any (submit refuses drafts),
 *     but submissions cascade with the form, so this is checked anyway.
 *
 * Locks, in the create path's order: the per-series advisory lock when the
 * call belongs to a series or to an event in one (so a discard and a create
 * on the same series serialise), then the form row FOR UPDATE (no submission
 * can land while it is held: its FK check needs KEY SHARE on the row).
 *
 * Idempotent: an already-gone call returns `{discarded: false}`, not an
 * error. An ATTEND form id is treated as gone (it is not a call).
 */
export async function discardOpenCallDraft(
  deps: DiscardOpenCallDraftDeps,
  rawInput: unknown,
): Promise<DiscardOpenCallDraftOutput> {
  const input = parseInput(discardOpenCallDraftInputSchema, rawInput);

  const discarded = await deps.repos.tx(async (tx) => {
    const form = await tx.eventApplications.getOpenCallById(input.formId);
    if (!form) return false;
    await ensureActorCanEditOpenCallAnchor(tx, form, input.actorHumanId, deps.logger);

    const ref = anchorOfForm(form);
    const seriesId =
      ref.kind === "series"
        ? ref.seriesId
        : ((await findEventSeriesLink(tx, ref.eventId))?.seriesId ?? null);
    if (seriesId) {
      await tx.eventApplications.lockSeriesOpenCalls(seriesId);
    }

    const locked = await tx.eventApplications.lockOpenCallForClose(form.id);
    if (!locked) return false;
    if (locked.postedAt) {
      throw fail("INVALID_STATUS", { meta: { reason: "posted" } });
    }
    const submissions = await tx.eventApplications.countSubmissionsByForm({
      formId: locked.id,
    });
    if (submissions > 0) {
      throw fail("INVALID_STATUS", { meta: { reason: "has_submissions" } });
    }

    const deleted = await tx.eventApplications.deleteOpenCallDraft(locked.id);
    if (!deleted) return false;

    await tx.audit.log({
      entity: ref.kind === "event" ? "event" : "event_series",
      entityId: ref.kind === "event" ? ref.eventId : ref.seriesId,
      action: "open_call_draft_discarded",
      data: {
        actorHumanId: input.actorHumanId,
        formId: locked.id,
        publicId: locked.publicId,
      },
      at: deps.clock.now(),
    });
    return true;
  });

  deps.logger?.info("open_call", {
    category: "open_call",
    formId: input.formId,
    action: "draft_discarded",
    discarded,
    actorHumanId: input.actorHumanId,
  });

  return discardOpenCallDraftOutputSchema.parse({ formId: input.formId, discarded });
}
