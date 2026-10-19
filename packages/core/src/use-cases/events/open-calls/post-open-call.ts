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
import { effectiveOpenCallPaySchema } from "./_shared/open-call-pay";

export const postOpenCallInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    formId: z.uuid(),
  })
  .strict();

export const postOpenCallOutputSchema = z
  .object({
    formId: z.uuid(),
    publicId: z.string(),
    postedAt: z.date(),
    /** True when the call was already posted: nothing changed. */
    alreadyPosted: z.boolean(),
  })
  .strict();

export type PostOpenCallInput = z.infer<typeof postOpenCallInputSchema>;
export type PostOpenCallOutput = z.infer<typeof postOpenCallOutputSchema>;

export type PostOpenCallDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * "Post call" (owner ruling Q41). Saving a call makes a DRAFT; posting makes
 * it public: served by `getPublicOpenCall`, listed on the poster's page, and
 * open to applications. Auth: edit rights on the call's event or series,
 * checked before any lock or write.
 *
 * Refused when:
 *   - the call is missing or not an open call → OPEN_CALL_NOT_FOUND;
 *   - its anchor has ended (event cancelled / archived / completed or its
 *     last date started; series archived or no live date ahead) →
 *     EVENT_NOT_EDITABLE / SERIES_INACTIVE with meta.reason, as for creating
 *     a call;
 *   - it is closed without ever having been posted (not reachable through
 *     the use cases; a data repair could make it) → INVALID_STATUS;
 *   - its stored pay fails FR-002 → invalid_input (re-validated here, so a
 *     call can never go public with incomplete pay terms).
 *
 * Idempotent: posting a posted call returns alreadyPosted with no change,
 * even if it has since been closed. One-way: there is no unpost (Close is
 * how a call stops).
 */
export async function postOpenCall(
  deps: PostOpenCallDeps,
  rawInput: unknown,
): Promise<PostOpenCallOutput> {
  const input = parseInput(postOpenCallInputSchema, rawInput);

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
    if (locked.postedAt) {
      return {
        formId: locked.id,
        publicId: locked.publicId,
        postedAt: locked.postedAt,
        alreadyPosted: true,
      };
    }
    if (locked.closedAt) {
      throw fail("INVALID_STATUS", { meta: { reason: "closed" } });
    }

    const now = deps.clock.now();
    const { reason } = await openCallEndedReason(tx, anchor, now);
    if (reason) {
      throw anchor.kind === "event"
        ? fail("EVENT_NOT_EDITABLE", { meta: { reason } })
        : fail("SERIES_INACTIVE", { meta: { reason } });
    }

    parseInput(effectiveOpenCallPaySchema, {
      payKind: locked.payKind,
      payDetails: locked.payDetails,
    });

    const posted = await tx.eventApplications.setOpenCallPosted({
      formId: locked.id,
      postedAt: now,
      postedByHumanId: input.actorHumanId,
    });

    const ref = anchorOfForm(locked);
    await tx.audit.log({
      entity: ref.kind === "event" ? "event" : "event_series",
      entityId: ref.kind === "event" ? ref.eventId : ref.seriesId,
      action: "open_call_posted",
      data: { actorHumanId: input.actorHumanId, formId: locked.id },
      at: now,
    });

    return {
      formId: posted.id,
      publicId: posted.publicId,
      postedAt: now,
      alreadyPosted: false,
    };
  });

  deps.logger?.info("open_call", {
    category: "open_call",
    formId: result.formId,
    action: "posted",
    alreadyPosted: result.alreadyPosted,
    actorHumanId: input.actorHumanId,
  });

  return postOpenCallOutputSchema.parse(result);
}
