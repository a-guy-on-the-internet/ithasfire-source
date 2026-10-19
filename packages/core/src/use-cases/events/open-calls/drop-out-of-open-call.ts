import { z } from "zod";

import { fail } from "@th/errors";
import type { EventHumanRecord } from "@th/ports/repos/event-humans";
import type { EventRecord } from "@th/ports/repos/events";

import {
  removeOwnLineupRowInTx,
  runLineupLeaveAftermath,
  type LineupLeaveEffectsDeps,
} from "../../event-humans/leave-event-lineup";

import { parseInput } from "../../../lib/io";
import { anchorOfForm } from "./_shared/open-call-anchor";
import {
  openCallApplicantAuthSchema,
  resolveOpenCallApplication,
} from "./_shared/open-call-application";
import {
  actOfSubmission,
  lockDecidableSubmission,
  openCallDroppedOutNoticeSchema,
  pickEventIdsOf,
  pickedActLineupRows,
  reportDroppedOutSeamUnwired,
  runOpenCallNotice,
  type OpenCallDroppedOutNotice,
} from "./_shared/open-call-decision";

export const dropOutOfOpenCallInputSchema = z
  .object({ auth: openCallApplicantAuthSchema })
  .strict();

export const dropOutOfOpenCallOutputSchema = z
  .object({
    submissionId: z.uuid(),
    status: z.literal("WITHDRAWN"),
    /** True when it had already dropped out: nothing changed. */
    alreadyDroppedOut: z.boolean(),
    /** The lineup rows this call removed. */
    removedEventHumanIds: z.array(z.uuid()),
    /** What step 7 sends to the organizer side; null on a repeat. */
    notice: openCallDroppedOutNoticeSchema.nullable(),
  })
  .strict();

export type DropOutOfOpenCallInput = z.infer<typeof dropOutOfOpenCallInputSchema>;
export type DropOutOfOpenCallOutput = z.infer<typeof dropOutOfOpenCallOutputSchema>;

/**
 * The leave path's deps (a signed-in person's drop out runs its aftermath:
 * the cooldown clear, the booking-act pass for a session drop out, and the
 * editors' `event.lineup-left` ONLY as the fallback while the dropped-out
 * seam is unwired) plus that seam. The transport binds the same leave deps
 * as `eventHumans.leaveLineup`.
 */
export type DropOutOfOpenCallDeps = LineupLeaveEffectsDeps & {
  /**
   * Tells the organizer side (step 7, FR-017). After the commit; a failure
   * is logged and reported, and the drop out stands.
   */
  notifyOpenCallDroppedOut?: (notice: OpenCallDroppedOutNotice) => Promise<unknown>;
};

/**
 * A picked act drops out (FR-017, Q10 "one tap"): their lineup row(s) for
 * the call go, and the application becomes WITHDRAWN with droppedOutAt.
 *
 * Auth is the applicant's (step 4, `resolveOpenCallApplication`): the
 * status-link token (guests, NFR-001; expiry applies), or a session: the
 * person who applied as themselves, or, for an ORGANISATION's application,
 * ANY member holding an ORG_EDIT_ROLES role in it (owner ruling 2026-10-07,
 * the same set that hears organizer-side notices), not only the member who
 * sent it. A VIEWER / SCANNER / FINANCE member, an ex-member, or a member
 * of another org gets OPEN_CALL_APPLICATION_NOT_FOUND (no probing).
 *
 * PERSON acts (a person applying as themselves, by session or token) drop
 * out WITH leaveEventLineup's semantics (FR-017), through its own shared
 * pieces, never a copy: each removed row goes through
 * `removeOwnLineupRowInTx` (the `left_lineup` audit) inside THIS
 * transaction, and after the commit `runLineupLeaveAftermath` runs per
 * night: the cooldown clear, and the booking-act pass for a SESSION drop
 * out only. The editors hear ONCE, through `notifyOpenCallDroppedOut`; the
 * per-night `event.lineup-left` is skipped (while that seam is unwired it
 * is sent per night instead, and the gap reported). The volunteer branch of
 * a leave never applies: only PERFORMER rows are removed here. One
 * transaction covers every night, which a series pick needs and a per-event
 * `leaveEventLineup` call could not give.
 * Organisation and guest acts keep the plain status-link path.
 *
 * Rows removed: the act's PERFORMER rows (identity rule in
 * _shared/open-call-decision) on the submission's pick events: the call's
 * event, or the materialised events of the series nights the applicant
 * chose. A VOLUNTEER / HOST / other row of the same person stays (a
 * VOLUNTEER row belongs to its signup). An organizer-added PERFORMER row for
 * the same act on a chosen-but-not-picked night goes too (same act, same
 * call).
 *
 * Only a picked (APPROVED) application drops out. PENDING uses withdraw;
 * PENDING, REJECTED, EXPIRED and a plain (never picked) WITHDRAWN all answer
 * OPEN_CALL_APPLICATION_NOT_PICKED. Idempotent: already dropped out (has
 * droppedOutAt) is success with alreadyDroppedOut true. An act removed from
 * the lineup by the organizer side (still APPROVED) may still drop out: it
 * records their choice, with no rows left to remove.
 *
 * Concurrency: the submission row lock FOR UPDATE first, then the lineup
 * row deletes, then the guarded APPROVED → WITHDRAWN update. Same order as
 * pick, so a pick retry and a drop out on one application cannot deadlock.
 */
export async function dropOutOfOpenCall(
  deps: DropOutOfOpenCallDeps,
  rawInput: unknown,
): Promise<DropOutOfOpenCallOutput> {
  const input = parseInput(dropOutOfOpenCallInputSchema, rawInput);
  const via = input.auth.kind === "token" ? ("status_link" as const) : ("session" as const);

  const result = await deps.repos.tx(async (tx) => {
    const now = deps.clock.now();
    const { submission: read, form } = await resolveOpenCallApplication(tx, input.auth, now);
    const submission = await lockDecidableSubmission(tx, form, read.id);
    if (submission.status === "WITHDRAWN" && submission.droppedOutAt !== null) {
      return {
        submissionId: submission.id,
        alreadyDroppedOut: true,
        removedEventHumanIds: [] as string[],
        notice: null,
        leftAsPerson: [] as Array<{ event: EventRecord; row: EventHumanRecord }>,
        personId: null as string | null,
      };
    }
    if (submission.status !== "APPROVED") throw fail("OPEN_CALL_APPLICATION_NOT_PICKED");

    const act = actOfSubmission(submission);
    const eventIds = await pickEventIdsOf(tx, form, submission);
    const rows = await pickedActLineupRows(tx, eventIds, act);
    const leftAsPerson: Array<{ event: EventRecord; row: EventHumanRecord }> = [];
    for (const row of rows) {
      if (act.kind === "human") {
        const event = await tx.events.getById(row.eventId);
        await removeOwnLineupRowInTx(tx, {
          row,
          ownRow: row,
          actorHumanId: act.humanId,
          now,
          auditExtra: { via: "open_call_drop_out", submissionId: submission.id },
        });
        if (event) leftAsPerson.push({ event, row });
      } else {
        await tx.eventHumans.detach(row.id);
      }
    }

    const flipped = await tx.eventApplications.markOpenCallSubmissionDroppedOut({
      submissionId: submission.id,
      formId: form.id,
      droppedOutAt: now,
    });
    // Unreachable while we hold the row lock; fail closed if it ever isn't.
    if (!flipped) throw fail("OPEN_CALL_APPLICATION_NOT_PICKED");

    const ref = anchorOfForm(form);
    await tx.audit.log({
      entity: ref.kind === "event" ? "event" : "event_series",
      entityId: ref.kind === "event" ? ref.eventId : ref.seriesId,
      action: "open_call_application_dropped_out",
      data: {
        formId: form.id,
        submissionId: submission.id,
        via,
        // Who pressed it (an org's drop out can be any edit member's).
        actorHumanId: input.auth.kind === "session" ? input.auth.actorHumanId : null,
        removedEventHumanIds: rows.map((r) => r.id),
      },
      at: now,
    });
    const notice: OpenCallDroppedOutNotice = {
      kind: "open_call_dropped_out",
      submissionId: submission.id,
      formId: form.id,
      anchor: ref,
      via,
      removedEventIds: [...new Set(rows.map((r) => r.eventId))],
    };
    return {
      submissionId: submission.id,
      alreadyDroppedOut: false,
      removedEventHumanIds: rows.map((r) => r.id),
      notice,
      leftAsPerson,
      personId: act.kind === "human" ? act.humanId : null,
    };
  });

  // A person's drop out: the leave aftermath per night, after the commit,
  // with two differences from a plain leave:
  //   - with the seam wired, the editors' `event.lineup-left` is skipped on
  //     EVERY night: the one `notifyOpenCallDroppedOut` below is their
  //     notice (owner ruling 2026-10-01, "ONE notice per person"), not one
  //     email per night;
  //   - the booking act is passed only for a SESSION drop out. A status link
  //     can be forwarded; a token must never reach a CONFIRMED booking, so
  //     with a token drop out the booking stays as it is (the person, signed
  //     in, can still leave it from the booking itself).
  //   Editors are ALWAYS told: where the dropped-out seam is unwired (a
  //   composition root that has not bound it), a person's drop out falls
  //   back to lineup-left per night (N emails is degraded, silence is worse)
  //   and the gap is reported. An organisation's or guest's drop out, and a
  //   person's with no row left to remove, have no lineup-left to send, so
  //   the report is the only trace. A WIRED seam that throws is reported,
  //   not retried, and lineup-left is not sent in its place.
  const droppedOutSeamWired = deps.notifyOpenCallDroppedOut !== undefined;
  if (!result.alreadyDroppedOut && !droppedOutSeamWired) {
    reportDroppedOutSeamUnwired(deps, "dropOutOfOpenCall", {
      submissionId: result.submissionId,
      fallback: result.personId && result.leftAsPerson.length > 0 ? "lineup_left" : "none",
    });
  }
  if (!result.alreadyDroppedOut && result.personId) {
    for (const left of result.leftAsPerson) {
      await runLineupLeaveAftermath(deps, {
        event: left.event,
        row: left.row,
        actorHumanId: result.personId,
        signup: null,
        skipEditorNotice: droppedOutSeamWired,
        skipBookingActPass: via !== "session",
        useCase: "dropOutOfOpenCall",
      });
    }
  }

  deps.logger?.info("open_call", {
    category: "open_call",
    action: "dropped_out",
    submissionId: result.submissionId,
    alreadyDroppedOut: result.alreadyDroppedOut,
    removedRows: result.removedEventHumanIds.length,
    via,
  });

  if (result.notice) {
    await runOpenCallNotice(deps, "dropOutOfOpenCall", deps.notifyOpenCallDroppedOut, result.notice);
  }

  return dropOutOfOpenCallOutputSchema.parse({
    submissionId: result.submissionId,
    status: "WITHDRAWN",
    alreadyDroppedOut: result.alreadyDroppedOut,
    removedEventHumanIds: result.removedEventHumanIds,
    notice: result.notice,
  });
}
