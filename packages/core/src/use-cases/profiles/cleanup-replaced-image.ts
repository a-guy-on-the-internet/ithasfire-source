import type { FileStoragePort } from "@th/ports/file-storage";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { describeError } from "../../lib/io";
import { incrementResourceUsage } from "../quotas/enforce-quota";
import {
  CREDIT_MARKER_TTL_MS,
  creditMarkerId,
  uploadClaimId,
} from "../storage/publish-stripped-upload";

/** Outbox `source` of the once-per-key credit marker (see below). */
export const REPLACED_IMAGE_CREDIT_SOURCE = "profile_image_replaced";

/**
 * What the post-commit cleanup needs to know, captured INSIDE the transaction
 * (the old URL is only readable from the pre-upsert row) and acted on AFTER it.
 */
export type ReplacedImageCleanupIntent = {
  /** Storage key of the image the profile no longer points at. */
  oldKey: string;
  /** Quota subject — profile images are always owned by a HUMAN. */
  humanId: string;
};

/**
 * Best-effort cleanup of the image a profile picture/banner just REPLACED:
 * delete the orphaned blob and hand its bytes back to the storage quota.
 *
 * ── THIS MUST NEVER RUN INSIDE THE CALLER'S TRANSACTION ───────────────────
 *
 * It takes the full `Repos` bag, not a `TxRepos` handle, and that is the whole
 * point: `TxRepos = Omit<Repos, "tx">`, so passing a transaction handle here is
 * a compile error rather than a silent regression.
 *
 * This block USED to sit as the last statement inside `repos.tx(...)` in both
 * `set-avatar-from-upload` and `set-banner-from-upload`, wrapped in a bare
 * `try { … } catch { }`. That did not degrade gracefully — it lied:
 *
 *   - `incrementResourceUsage` issues a `$queryRaw` INSERT … ON CONFLICT DO
 *     UPDATE. Any statement that errors at the database (a failed SELECT does
 *     it too) puts the Postgres session into the aborted state;
 *   - Postgres then answers the subsequent COMMIT with ROLLBACK and NO error;
 *   - Prisma does not surface that, so `$transaction` RESOLVES.
 *
 * Measured on this repo's Prisma 7.1.0 + PrismaPg: a swallow with nothing after
 * it in the callback made `$transaction` return success, throw nothing, and
 * discard every write in it. Because the swallow was the LAST statement, a
 * database hiccup there threw away the `entityPages.upsert` that pointed the
 * profile at the NEW image — while the use case still returned
 * `{ avatarUrl: url }` as success, with no log line, metric or Sentry event.
 *
 * Running post-commit also fixes an ordering bug that was independent of the
 * transaction hazard: `deleteObject` is IRREVERSIBLE and used to run BEFORE the
 * commit, so a rollback (silent or not) left the profile row pointing at a
 * blob that had already been destroyed. Now the row is durable before anything
 * is deleted; the worst case is an orphaned object and a slightly-inflated
 * quota counter, both recoverable, neither user-visible.
 *
 * The swallow stays — a storage or quota hiccup must not fail an image the user
 * has already successfully saved — but post-commit the swallow is HONEST, and
 * per CLAUDE.md's error-reporting convention it reports to Sentry (guarded, so
 * a throwing reporter cannot manufacture a new failure) and logs at `error`,
 * never `warn`, which the Sentry pino integration does not capture.
 */
export async function cleanupReplacedImage(
  deps: {
    storage: FileStoragePort;
    logger?: LoggerPort;
    reportError?: ReporterPort;
  },
  /**
   * The NON-transactional repo bag. Passing a `TxRepos` handle from inside an
   * open transaction would reintroduce the silent-rollback hazard above; the
   * `Repos` type is the guard that makes that a compile error.
   */
  repos: Repos,
  intent: ReplacedImageCleanupIntent,
  params: {
    /** Tag for the report/log line, e.g. `"setAvatarFromUpload"`. */
    useCase: string;
  },
): Promise<void> {
  try {
    const oldHead = await deps.storage.headObject({ key: intent.oldKey });
    await deps.storage.deleteObject({ key: intent.oldKey });

    // Reclaim storage quota for the deleted file. Its own transaction, so a
    // constraint or connection failure aborts only THIS work and surfaces to
    // the catch below instead of poisoning someone else's transaction.
    //
    // `reclaimedBytes` is a const rather than a re-read of `oldHead.size`
    // because narrowing does NOT survive into the nested callback below.
    const reclaimedBytes = oldHead.exists ? (oldHead.size ?? 0) : 0;
    if (reclaimedBytes > 0) {
      await repos.tx(async (tx) => {
        // AT MOST ONCE PER KEY. Two cleanups of one key (two finalizes that
        // both read the same old URL before either wrote) can both HEAD it
        // before either deletes it; each would credit its size. The marker
        // row's id is the claim: `ON CONFLICT DO NOTHING`, one inserter
        // across processes, and only the inserter credits. A finalize that
        // lost an upload claim has inserted it already for its never-charged
        // copy (`claimStrippedUpload`), so that copy is never credited. It is
        // an outbox row so it needs no table of its own; the drain removes it
        // after `CREDIT_MARKER_TTL_MS` by deleting a key that is already gone
        // (a no-op).
        //
        // The TTL is enough even though a key CAN be written again: a
        // finalize on another instance that passed the strip's `stillNeeded`
        // check before the claim committed writes the same copy key (same
        // upload, same bytes) after this cleanup deleted it. That finalize
        // then sees a repeat and links nothing, and while the marker lives a
        // cleanup of the rewritten copy credits nothing; past the TTL no page
        // can point at it (the profile finalizes publish only claimed copies,
        // and updatePage accepts no new profile-prefix URL).
        const marker = await tx.pendingObjectDeletions.enqueueOnce({
          id: creditMarkerId(intent.oldKey),
          targetKey: intent.oldKey,
          targetKind: "KEY",
          source: REPLACED_IMAGE_CREDIT_SOURCE,
          notBefore: new Date(Date.now() + CREDIT_MARKER_TTL_MS),
        });
        if (!marker.inserted) return;

        // NOT AN UPLOAD WHOSE CHARGE WAS SETTLED. A key with an upload claim
        // is an upload a finalize already accounted for: published (the
        // charge now pays for its stripped copy, credited when THAT copy is
        // replaced) or refused (credited back then). Bytes found there now
        // were re-PUT through the still-valid presigned URL, never charged:
        // crediting them would mint quota. Deleted above all the same.
        if (await tx.pendingObjectDeletions.getById(uploadClaimId(intent.oldKey))) {
          return;
        }

        await incrementResourceUsage(tx, {
          subjectType: "HUMAN",
          subjectId: intent.humanId,
          kind: "STORAGE_BYTES_HUMAN",
          delta: BigInt(-reclaimedBytes),
        });
      });
    }
  } catch (error) {
    // Guarded so a throwing reporter cannot manufacture a new failure out of a
    // swallowed one.
    try {
      deps.reportError?.(error, {
        tags: { useCase: params.useCase, stage: "cleanup_replaced_image" },
        extra: { humanId: intent.humanId, oldKey: intent.oldKey },
      });
    } catch {
      // ignored on purpose
    }
    deps.logger?.error("profile_image_cleanup_failed", {
      useCase: params.useCase,
      humanId: intent.humanId,
      oldKey: intent.oldKey,
      error: describeError(error),
    });
  }
}
