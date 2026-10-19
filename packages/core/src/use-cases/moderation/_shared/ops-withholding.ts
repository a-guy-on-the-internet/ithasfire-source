import type {
  ImageModerationRecord,
  ModerationQueueHealthSignal,
} from "@th/ports/repos/image-moderation-records";

// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE PLATFORM-OPS SURFACES WITHHOLD, AND WHY IT IS ONE DEFINITION.
//
// The ops procedures (`moderation.queueSnapshot` / `queueSignal` /
// `lookupByKey`) gate on ADMIN **or DEVELOPER** — deliberately, because a
// DEVELOPER on call at 3am should not need a moderator role to see that the
// drain is dead. The cost of that gate is that these surfaces admit people who
// are NOT moderators, and one class of row they can reach is un-reviewed
// flagged CONTENT.
//
// `storageKey` IS the image. The R2 adapter composes public URLs by pure string
// join (`${publicBaseUrl}/${key}`) and moderation gating is APP-side, not
// enforced at the CDN — the public base URL appears in the markup of every
// published event. So dropping `publicUrl` while keeping `storageKey` withholds
// nothing at all; that was the shape of the first cut, and it was theatre.
//
// There are now TWO surfaces that must apply the same rule — the bucket
// drill-down, which knows which bucket it is in, and the storage-key lookup,
// which knows only a record. Written as two functions over one stated rule
// rather than two `if`s in two files: a lookup that echoes back the key the
// drill-down withholds defeats the control completely, and that is precisely
// the kind of divergence that happens when the condition is retyped.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Is this record an UN-REVIEWED CONTENT HOLD — an image the provider actually
 * scored at or above threshold, still waiting on a human?
 *
 * These three clauses are the `awaitingReview` queue-health predicate with its
 * age cutoff removed, and the removal is deliberate: a hold flagged ten minutes
 * ago is exactly as un-reviewed as one flagged last week. `awaitingReview`
 * carries `moderatedAt <= moderatedBefore` because it answers "is the review
 * queue ROTTING"; this answers "may a non-moderator see this", and age has
 * nothing to do with that.
 *
 * `degraded: false` is what separates a content hold from a scanner failure.
 * A `degraded: true` FLAGGED row means we could not scan bytes that exist —
 * an operational row an engineer needs to be able to name.
 */
export function isUnreviewedContentHold(
  record: Pick<ImageModerationRecord, "status" | "degraded" | "reviewedAt">,
): boolean {
  return (
    record.status === "FLAGGED" &&
    record.degraded === false &&
    record.reviewedAt === null
  );
}

/**
 * Does this drill-down bucket contain un-reviewed content holds?
 *
 * Exactly one of the five does. `pendingOverdue` is un-scanned, `orphanedRecent`
 * has no bytes left to fetch, and the two degraded buckets are scanner
 * failures — all four keep `storageKey`, because an engineer triaging a
 * provider outage needs to be able to identify the row.
 *
 * Written as an exhaustive switch rather than `signal === "awaitingReview"` so
 * a sixth bucket cannot be added without someone answering this question for
 * it. The default branch is a compile error, not a runtime guess.
 */
export function signalWithholdsContent(
  signal: ModerationQueueHealthSignal,
): boolean {
  switch (signal) {
    case "awaitingReview":
      return true;
    case "pendingOverdue":
    case "degradedRecent":
    case "degradedExhausted":
    case "orphanedRecent":
      return false;
    default: {
      const unhandled: never = signal;
      throw new Error(`unhandled queue-health signal: ${String(unhandled)}`);
    }
  }
}
