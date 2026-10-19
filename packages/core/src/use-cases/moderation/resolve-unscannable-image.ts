import { z } from "zod";

import { fail } from "@th/errors";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { plainTextMultilineOptional } from "../../lib/sanitize-plain-text";
import { moderationQueueHealthWindowShape } from "./_shared/queue-health-window";

// ─────────────────────────────────────────────────────────────────────────────
// OPERATOR ACTION: terminally resolve ONE unscannable row.
//
// The `degradedExhausted` bucket is DEFINED as rows past the requeue cap that
// no automation will ever touch again: the drain will not claim them (they are
// not PENDING), the hourly requeue will not revive them (`requeues < cap`
// fails), and no human can judge them because there are no bytes to look at.
// The ops page could show them and offer nothing; the recorded real-world fix
// has been a hand-written UPDATE against production.
//
// THE RISK THIS PATH CREATES, AND WHAT CONTAINS IT. "Resolve this row" applied
// to the wrong row is a way to make a moderator's pending judgement disappear
// without a moderator making it. The containment is NOT this file's `if`s —
// it is the repo's WHERE (`resolveUnscannable`), which matches
// `degraded = true` and therefore cannot see a genuine content hold at all.
// The checks below exist to give a human a readable answer; the check that
// matters is one SQL statement and holds even against a moderator deciding the
// same row concurrently.
//
// WHY ORPHANED AND NOT REJECTED. A REJECT enqueues the R2 object for deletion.
// For an object we were never able to FETCH, that is a deletion aimed at bytes
// whose existence we could not establish — and it would also fire the
// uploader's "your image was removed" notice for a machine-side failure that
// says nothing about their image. ORPHANED is already the documented terminal
// state for "there is nothing here to judge": invisible on public surfaces, out
// of the moderator queue, out of the requeue selection, carrying no fabricated
// verdict. See `markOrphaned`'s docblock, whose reasoning this follows.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE FLOOR under `maxRequeues`, and why a floor is needed at all.
 *
 * `.positive()` alone blocks 0 and negatives, which is necessary and nowhere
 * near sufficient. The port contract promises this action only touches "rows
 * that have genuinely exhausted the automation", and nothing about a positive
 * integer enforces that: a caller passing `maxRequeues: 1` while the requeue
 * job runs at 3 would terminally resolve a degraded row that was still TWO
 * automated retries away from being anyone's problem — and, during a provider
 * outage, one that would very likely have recovered on its own the moment the
 * provider did. The row would be hidden forever with an audit trail saying an
 * operator decided it was unscannable, which it was not.
 *
 * Derived from `moderationQueueHealthWindowShape.maxRequeues` by PARSING its
 * default rather than copying the number, so the floor and the requeue job's
 * cap cannot drift. If that default moves, this moves with it.
 *
 * The echo is still required — see `maxRequeues` below. A caller may hand back
 * a cap ABOVE the automation's (a stricter, more conservative selection); it
 * may not go under it.
 */
const MIN_RESOLVABLE_REQUEUES: number =
  moderationQueueHealthWindowShape.maxRequeues.parse(undefined);

export const resolveUnscannableImageInputSchema = z
  .object({
    /**
     * The already-authorized operator. AUTHZ IS AT THE TRANSPORT — ADMIN only
     * for this one, deliberately narrower than the ADMIN/DEVELOPER read gate:
     * this mutates moderation state. Same split as `reviewFlaggedImage`, which
     * also accepts an authorized actor and records it rather than re-checking.
     */
    actorHumanId: z.string().uuid(),
    recordId: z.string().uuid(),
    /**
     * The requeue cap the operator was LOOKING AT. Echoed from
     * `snapshot.thresholds.maxRequeues` rather than defaulted, so the
     * eligibility the button promised is the eligibility the UPDATE enforces.
     * A mismatch would refuse rows the operator can plainly see in the list —
     * an "it does nothing" bug with no error to read.
     *
     * FLOORED at the automation's own cap (see {@link MIN_RESOLVABLE_REQUEUES}).
     * The echo may be STRICTER than the requeue job's cap and never looser: a
     * client that could pass 1 could terminally resolve rows the requeue job
     * had not finished trying, which is precisely what "exhausted" is supposed
     * to rule out. Rejected at the boundary rather than silently clamped —
     * clamping would quietly execute a different action than the one asked for,
     * and this action is terminal.
     */
    maxRequeues: z.number().int().min(MIN_RESOLVABLE_REQUEUES),
    /** Why. Free text, sanitized and bounded like the moderator review note. */
    note: plainTextMultilineOptional(1000).optional(),
  })
  .strict();

export type ResolveUnscannableImageInput = z.infer<
  typeof resolveUnscannableImageInputSchema
>;

export const resolveUnscannableImageOutputSchema = z
  .object({
    /** True only on a genuine transition (the CAS affected exactly one row). */
    resolved: z.boolean(),
    /**
     * The record's status AFTER this call — re-read on the no-op path, so the
     * UI never reports a state the row is not in.
     */
    status: z.enum(["PENDING", "APPROVED", "FLAGGED", "REJECTED", "ORPHANED"]),
    /**
     * Why nothing happened, when nothing happened.
     *
     * ONE bucket for every ineligible case on purpose. The alternative — a
     * reason per failed clause — would have to report "this is a content hold,
     * not a scanner failure" to a caller who is by construction not authorized
     * to know that, and it would turn a 0-row CAS into a second read whose
     * answer could already be stale. "Not eligible, here is the current
     * status" is everything the operator can act on.
     */
    reason: z.enum(["resolved", "not_eligible"]),
  })
  .strict();

export type ResolveUnscannableImageOutput = z.infer<
  typeof resolveUnscannableImageOutputSchema
>;

export type ResolveUnscannableImageDeps = {
  repos: Pick<Repos, "tx">;
  clock: ClockPort;
  logger: LoggerPort;
};

/**
 * Terminally resolve one unscannable (`degradedExhausted`) moderation record to
 * ORPHANED.
 *
 * IDEMPOTENT BY COMPARE-AND-SET. The second click affects 0 rows — `reviewedAt`
 * is no longer null and the status is no longer FLAGGED — and returns
 * `resolved: false` with the row's real status. No second audit row, no error.
 *
 * The CAS and the audit row commit in ONE transaction, so an audit trail
 * without a state change (or the reverse) is not representable.
 */
export async function resolveUnscannableImage(
  deps: ResolveUnscannableImageDeps,
  rawInput: unknown,
): Promise<ResolveUnscannableImageOutput> {
  const input = parseInput(resolveUnscannableImageInputSchema, rawInput);
  const note = input.note ?? null;

  const result = await deps.repos.tx(async (tx) => {
    const now = deps.clock.now();

    const current = await tx.imageModerationRecords.getById(input.recordId);
    if (!current) {
      // A genuinely absent record is an error, unlike an ineligible one: the
      // operator is holding an id for something that does not exist, and
      // returning "not eligible" would send them looking for a state machine
      // problem instead of a stale page.
      throw fail("NOT_FOUND", { meta: { entity: "image_moderation_record" } });
    }

    const count = await tx.imageModerationRecords.resolveUnscannable({
      id: input.recordId,
      maxRequeues: input.maxRequeues,
      resolvedByHumanId: input.actorHumanId,
      resolvedAt: now,
      note: note ?? undefined,
    });

    if (count !== 1) {
      // Lost the CAS, or never matched it. Re-read INSIDE the transaction so
      // the status reported is the one this transaction can see, rather than a
      // pre-CAS snapshot that a concurrent moderator may already have moved.
      const reread = await tx.imageModerationRecords.getById(input.recordId);
      return {
        resolved: false as const,
        status: reread?.status ?? current.status,
        reason: "not_eligible" as const,
      };
    }

    await tx.audit.log({
      entity: "image_moderation_record",
      entityId: current.id,
      action: "image_moderation.resolved_unscannable",
      data: {
        actorHumanId: input.actorHumanId,
        fromStatus: current.status,
        toStatus: "ORPHANED",
        // The eligibility evidence, recorded so the audit row is readable
        // without re-deriving why this record qualified — by then the columns
        // it qualified on have been overwritten.
        degraded: current.degraded,
        requeues: current.requeues,
        maxRequeues: input.maxRequeues,
        attempts: current.attempts,
        lastError: current.lastError,
        kind: current.kind,
        subjectType: current.subjectType,
        subjectId: current.subjectId,
        storageKey: current.storageKey,
        note,
      },
      at: now,
    });

    return {
      resolved: true as const,
      status: "ORPHANED" as const,
      reason: "resolved" as const,
    };
  });

  if (result.resolved) {
    deps.logger.info("moderation.resolveUnscannableImage.resolved", {
      recordId: input.recordId,
      actorHumanId: input.actorHumanId,
      maxRequeues: input.maxRequeues,
    });
  } else {
    deps.logger.info("moderation.resolveUnscannableImage.not_eligible", {
      recordId: input.recordId,
      actorHumanId: input.actorHumanId,
      status: result.status,
    });
  }

  return resolveUnscannableImageOutputSchema.parse(result);
}
