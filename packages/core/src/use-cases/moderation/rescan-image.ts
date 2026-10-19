import { z } from "zod";

import { fail } from "@th/errors";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { ImageModerationRecord } from "@th/ports/repos/image-moderation-records";

import { parseInput } from "../../lib/io";

// ─────────────────────────────────────────────────────────────────────────────
// OPERATOR ACTION: re-scan ONE image.
//
// The mechanism already existed — `create()` is idempotent on `storageKey` and
// RESETS the row to PENDING, which is how a re-upload to the same key gets
// re-moderated. The use is real: after a provider outage, or after a threshold
// change that should apply retroactively, an operator wants one specific object
// scored again.
//
// THE TRAP, STATED PLAINLY. `create()` resets ANY existing row. Pointed at an
// APPROVED or REJECTED record it silently revives a human decision — and
// re-scanning a REJECTED image can put it back into circulation, because a
// clean re-score lands on APPROVED and read-time gating then passes it. A
// moderator's rejection would be undone by an ops button, with an audit row
// that says "rescan".
//
// SO THE GUARD IS THE `WHERE`, NOT THIS FILE. `repos.requeueForRescan` matches
// only machine states — PENDING, ORPHANED, or FLAGGED with `degraded = true` —
// in a single statement. The pre-read below exists to give a human a readable
// answer ("this is REJECTED, refusing"); it is NOT the safety property, because
// a read-then-write guard leaves a TOCTOU window against a moderator deciding
// the same row a millisecond later. Both layers are here; only the second one
// would survive a race, and only the first one can explain itself.
// ─────────────────────────────────────────────────────────────────────────────

export const rescanImageInputSchema = z
  .object({
    /**
     * The already-authorized operator. AUTHZ IS AT THE TRANSPORT — ADMIN only,
     * deliberately narrower than the ADMIN/DEVELOPER read gate: this mutates
     * moderation state.
     */
    actorHumanId: z.string().uuid(),
    recordId: z.string().uuid(),
  })
  .strict();

export type RescanImageInput = z.infer<typeof rescanImageInputSchema>;

export const rescanImageOutputSchema = z
  .object({
    /** True only when the row actually moved back to PENDING. */
    requeued: z.boolean(),
    /** The record's status AFTER this call. Re-read on the refusal path. */
    status: z.enum(["PENDING", "APPROVED", "FLAGGED", "REJECTED", "ORPHANED"]),
    /**
     * Why nothing happened.
     *
     * `human_decided` is a distinct outcome from a generic refusal because it
     * is the one an operator will hit and misread. "This image was REJECTED by
     * a moderator; re-scanning it is not how you put it back" is a sentence the
     * UI can only write if the server says which case it was.
     */
    reason: z.enum(["requeued", "human_decided"]),
  })
  .strict();

export type RescanImageOutput = z.infer<typeof rescanImageOutputSchema>;

export type RescanImageDeps = {
  repos: Pick<Repos, "tx">;
  clock: ClockPort;
  logger: LoggerPort;
};

/**
 * Is this record in a MACHINE state — one no human has ruled on?
 *
 * Mirrors `RESCANNABLE_MACHINE_STATES` in the Prisma adapter, which is the
 * enforcing copy. Duplicated deliberately and only for the READABLE refusal:
 * the two can only disagree by making this function more permissive than the
 * SQL, in which case the SQL still refuses and the operator gets a confusing
 * "it did nothing" instead of an unsafe write. The failure direction is the
 * point.
 *
 *   - PENDING            → not yet scored. Re-scan just re-times it.
 *   - ORPHANED           → machine-made terminal state. If the object is back
 *                          (a storage blip, a restored bucket), this is the
 *                          only way to get it scored.
 *   - FLAGGED + degraded → the scanner FAILED. Exactly what a post-outage
 *                          re-scan is for.
 *
 * Everything else is a person's decision: APPROVED, REJECTED, and FLAGGED with
 * `degraded = false` (a real content hold awaiting a moderator — re-scanning
 * would clear the verdict out from under the queue).
 */
function isMachineState(
  record: Pick<ImageModerationRecord, "status" | "degraded">,
): boolean {
  switch (record.status) {
    case "PENDING":
    case "ORPHANED":
      return true;
    case "FLAGGED":
      return record.degraded;
    case "APPROVED":
    case "REJECTED":
      return false;
    default: {
      // A status this code has never heard of is NOT rescannable. Fail closed:
      // the whole point of this guard is that unknown states are somebody
      // else's decision until proven otherwise.
      const unhandled: never = record.status;
      void unhandled;
      return false;
    }
  }
}

/**
 * Send one image back to PENDING so the drain re-scores it.
 *
 * Refuses anything a human has decided. The refusal is enforced in the repo's
 * WHERE and explained by the pre-read here; see the block comment above for why
 * it is both and not either.
 *
 * The requeue and the audit row commit in ONE transaction.
 */
export async function rescanImage(
  deps: RescanImageDeps,
  rawInput: unknown,
): Promise<RescanImageOutput> {
  const input = parseInput(rescanImageInputSchema, rawInput);

  const result = await deps.repos.tx(async (tx) => {
    const now = deps.clock.now();

    const current = await tx.imageModerationRecords.getById(input.recordId);
    if (!current) {
      throw fail("NOT_FOUND", { meta: { entity: "image_moderation_record" } });
    }

    if (!isMachineState(current)) {
      // The readable refusal. No audit row: nothing changed, and an audit trail
      // of refused clicks is noise that dilutes the rows that matter.
      return {
        requeued: false as const,
        status: current.status,
        reason: "human_decided" as const,
      };
    }

    const count = await tx.imageModerationRecords.requeueForRescan({
      id: input.recordId,
      now,
    });

    if (count !== 1) {
      // The read said machine state; the WHERE disagreed. That means a human
      // decided this row between the two statements — the exact race the
      // repo-level guard exists for. Report it as what it is.
      const reread = await tx.imageModerationRecords.getById(input.recordId);
      return {
        requeued: false as const,
        status: reread?.status ?? current.status,
        reason: "human_decided" as const,
      };
    }

    await tx.audit.log({
      entity: "image_moderation_record",
      entityId: current.id,
      action: "image_moderation.rescan_requested",
      data: {
        actorHumanId: input.actorHumanId,
        fromStatus: current.status,
        toStatus: "PENDING",
        // The verdict being discarded, recorded before it is cleared — after
        // the reset these columns are null and the audit row would be unable
        // to say what was thrown away.
        degraded: current.degraded,
        previousMaxSeverity: current.maxSeverity,
        previousProvider: current.provider,
        requeues: current.requeues,
        attempts: current.attempts,
        lastError: current.lastError,
        kind: current.kind,
        subjectType: current.subjectType,
        subjectId: current.subjectId,
        storageKey: current.storageKey,
      },
      at: now,
    });

    return {
      requeued: true as const,
      status: "PENDING" as const,
      reason: "requeued" as const,
    };
  });

  if (result.requeued) {
    deps.logger.info("moderation.rescanImage.requeued", {
      recordId: input.recordId,
      actorHumanId: input.actorHumanId,
    });
  } else {
    deps.logger.info("moderation.rescanImage.refused", {
      recordId: input.recordId,
      actorHumanId: input.actorHumanId,
      status: result.status,
    });
  }

  return rescanImageOutputSchema.parse(result);
}
