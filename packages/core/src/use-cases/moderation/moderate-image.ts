import { z } from "zod";

import {
  isFileStorageError,
  type FileStoragePort,
} from "@th/ports/file-storage";
import type { LoggerPort } from "@th/ports/logger";
import type { ModerationPort } from "@th/ports/moderation";
import type { Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";
import type { ImageModerationCategory } from "@th/types/repos/image-moderation-records";

import { parseInput } from "../../lib/io";
import { getEntityPageImageKeyPrefix } from "../entity-pages/page-image-upload-helpers";
import { pageImageKeysMentionedIn } from "../entity-pages/page-image-urls";

// ─────────────────────────────────────────────────────────────────────────────
// Input / Output
// ─────────────────────────────────────────────────────────────────────────────

export const moderateImageInputSchema = z
  .object({
    /** The R2 storage key of the object to moderate (the record's join key). */
    storageKey: z.string().min(1).max(2048),
  })
  .strict();

export type ModerateImageInput = z.infer<typeof moderateImageInputSchema>;

export const moderateImageOutputSchema = z
  .object({
    status: z.enum([
      "PENDING",
      "APPROVED",
      "FLAGGED",
      "REJECTED",
      "ORPHANED",
    ]),
    maxSeverity: z.number(),
    degraded: z.boolean(),
    /**
     * True when nothing was moderated this call — the record was missing or
     * already decided (a concurrent drain run beat us). Lets the drain skip
     * counting / notifying on a no-op.
     *
     * An ORPHANED outcome is NOT a no-op: this call resolved the row, and the
     * drain counts it (just not as a moderation verdict).
     */
    noop: z.boolean(),
    /**
     * Set (true) only on an ORPHANED outcome for a place page image that was
     * removed on purpose before it was scanned (see
     * {@link isRemovedPageImage}). The drain counts these apart from real
     * orphans and keeps them out of its orphan circuit breaker: a place
     * merge deletes every page image at once, with no grace.
     */
    removedOnPurpose: z.boolean().optional(),
  })
  .strict();

export type ModerateImageOutput = z.infer<typeof moderateImageOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────

export type ModerateImageConfig = {
  /**
   * Fallback severity at/above which an image is FLAGGED (held for a human)
   * rather than auto-APPROVED. Applies to any category without an explicit
   * entry in {@link ModerateImageConfig.categoryThresholds}.
   */
  reviewThreshold: number;
  /**
   * Per-category overrides. A UNIFORM threshold is the wrong instrument for
   * this catalogue: two of Azure's four categories are load-bearing genre
   * signals here and two are not. Gig posters for metal, burlesque, drag and
   * horror-themed DIY shows score SEXUAL/VIOLENCE 2 (and sometimes 4) honestly,
   * so holding those low would bury moderators in false positives on legitimate
   * art. HATE and SELF_HARM have no equivalent legitimate register at any
   * severity, and that is where the actual liability sits — so they get a much
   * lower bar.
   *
   * Shipped values (decided 2026-08-20): SEXUAL 6, VIOLENCE 6, HATE 2,
   * SELF_HARM 2. Note what SEXUAL/VIOLENCE 6 buys: a severity-4 result in those
   * categories publishes WITHOUT review. That is a deliberate trade, not an
   * oversight.
   *
   * Absent/partial map falls back to `reviewThreshold` per category, so an
   * unset environment behaves exactly as it did before this existed.
   */
  categoryThresholds?: Partial<Record<ImageModerationCategory, number>>;
};

/**
 * True when any single category met or exceeded its own threshold.
 *
 * Deliberately NOT driven by `maxSeverity`: the max collapses four independent
 * signals into one number, which cannot express "HATE 2 is a hold but SEXUAL 4
 * is fine". `maxSeverity` is still recorded on the row for display and triage.
 *
 * An empty `categories` array (which the adapter only produces on the degraded
 * path) returns false here — degraded is handled by its own branch at the call
 * site and must never depend on this function.
 */
export function exceedsCategoryThreshold(
  categories: ReadonlyArray<{
    category: ImageModerationCategory;
    severity: number;
  }>,
  config: ModerateImageConfig,
): boolean {
  return categories.some(
    (entry) =>
      entry.severity >=
      (config.categoryThresholds?.[entry.category] ?? config.reviewThreshold),
  );
}

export type ModerateImageDeps = {
  /**
   * `entityPages` (optional, read-only) tells a place page image that was
   * REMOVED on purpose from one that went missing: see
   * {@link isRemovedPageImage}. Without it every missing object is reported.
   */
  repos: Pick<Repos, "imageModerationRecords"> &
    Partial<Pick<Repos, "entityPages">>;
  fileStorage: Pick<FileStoragePort, "getObject">;
  moderation: ModerationPort;
  config: ModerateImageConfig;
  logger: LoggerPort;
  /**
   * Swallow reporting, two sites (CLAUDE.md error convention — guarded, so a
   * throwing reporter never changes behaviour):
   *   - FR-006: a degraded (provider-failed) verdict is held for a human AND
   *     surfaced to Sentry;
   *   - an ORPHANED resolution — the object is gone, so nobody is ever told by
   *     the product. Sentry is the ONLY place that swallow becomes visible.
   */
  reportError?: ReporterPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs one image through the moderation provider and writes the verdict back
 * onto its `ImageModerationRecord`. The USE CASE owns the threshold decision
 * (FR-004) — the port only reports severities.
 *
 * Idempotent on `storageKey`:
 *   - missing record            → no-op (nothing to moderate);
 *   - already-decided record    → no-op (a concurrent run resolved it);
 *   - PENDING record            → fetch bytes, call the provider, markResult.
 *
 * FETCHING BYTES HAS TWO FAILURE MODES, and conflating them was a real prod
 * defect (Sentry HEARTH-FIRE-WEB-20):
 *
 *   - `code: "not_found"` — PERMANENT. The record outlived its object: it was
 *     verified present at upload (`finalize-event-image-upload` does a
 *     `headObject` before enqueuing), then deleted. No amount of retrying makes
 *     bytes reappear. We resolve the row to ORPHANED on the FIRST pass, report
 *     to Sentry, and stop. Treating this as transient is what burned the whole
 *     attempt budget and then dead-lettered the row to FLAGGED — parking a
 *     moderator in front of an image that does not exist and inviting them to
 *     "approve" it into publication.
 *   - anything else (`transient` / `dependency_failed` / an unexpected throw) —
 *     the object may well be there; storage is just not answering. RETHROWN
 *     unchanged so the drain retries with backoff and, on exhaustion,
 *     dead-letters to FLAGGED+degraded (NFR-005).
 *
 * Neither path ever writes a VERDICT: an object we could not read must not be
 * scored. ORPHANED is a terminal status, not a verdict — it carries no severity.
 *
 * DOWNSCALE: Azure Content Safety caps image size/dimensions (~4MB / 2048px). No
 * server-side image library (sharp or equivalent) exists in this repo, so we do
 * NOT add a heavy dependency unilaterally here — oversize images are sent as-is;
 * Azure rejects them, the adapter returns a degraded FLAGGED result, and they
 * route to human review. That is a safe fail-CLOSED outcome (FR-006), just a
 * noisier one. Add sharp-based downscale here once/if a resize lib lands.
 *
 * KEY INVARIANT: storage keys embed a fresh uuid per upload and are never reused
 * for different bytes (see enqueue-image-moderation.ts), so `markResult`-by-key
 * can never stamp a stale verdict onto different content, and there is no
 * PENDING/human-review conflict (claimDue only returns PENDING; humans only act
 * on FLAGGED).
 */
export async function moderateImage(
  deps: ModerateImageDeps,
  rawInput: unknown,
): Promise<ModerateImageOutput> {
  const { repos, fileStorage, moderation, config, logger, reportError } = deps;
  const input = parseInput(moderateImageInputSchema, rawInput);

  const record = await repos.imageModerationRecords.getByKey(input.storageKey);

  // Missing record → nothing to moderate (absence = unmoderated/legacy).
  if (!record) {
    logger.info("moderateImage.no_record", { storageKey: input.storageKey });
    // Report status PENDING — an honest "we don't know" rather than a verdict we
    // never computed. The drain only branches on `noop`, and read-time gating
    // treats an absent record as visible regardless, so behaviour is unchanged.
    return {
      status: "PENDING",
      maxSeverity: 0,
      degraded: false,
      noop: true,
    };
  }

  // Already decided → idempotent no-op (a concurrent drain run resolved it).
  if (record.status !== "PENDING") {
    logger.info("moderateImage.already_decided", {
      storageKey: input.storageKey,
      status: record.status,
    });
    return {
      status: record.status,
      maxSeverity: record.maxSeverity ?? 0,
      degraded: record.degraded,
      noop: true,
    };
  }

  // Fetch bytes. See the docblock: `not_found` is PERMANENT and resolves the row
  // to ORPHANED here; everything else is transient and propagates so the drain
  // retries. Neither path scores an object we could not read.
  let object: Awaited<ReturnType<FileStoragePort["getObject"]>>;
  try {
    object = await fileStorage.getObject({ key: input.storageKey });
  } catch (err) {
    // Detection is by the port's CONTRACTED error code, never a message match —
    // the message is provider prose ("object_not_found") and would rot the
    // moment an adapter reworded it or a second store was added.
    if (!isFileStorageError(err) || err.code !== "not_found") {
      throw err;
    }

    // `isFileStorageError` only validates `code`, so `message` is a type-level
    // assertion, not a checked fact. An adapter throwing a bare
    // `{ code: "not_found" }` would pass `undefined` here, which Prisma reads as
    // "leave this column alone" — a silently blank `last_error` on the one row
    // whose whole purpose is to record why it was abandoned.
    const detail = err.message ?? "object_not_found";

    // A community moderator's place page image (PAGE_MEDIA, subject PLACE)
    // can be deleted before it is scanned, through the outbox, once the page
    // no longer names it: a Clear or a draft discard after a 24 h grace, or a
    // place merge with no grace at all. That is not a storage fault: resolve
    // the row the same way, but leave it out of `orphanedRecent`, Sentry and
    // the drain's orphan breaker (`removedOnPurpose`).
    if (await isRemovedPageImage(deps, record)) {
      await repos.imageModerationRecords.markOrphaned({
        storageKey: input.storageKey,
        resolvedAt: new Date(),
        lastError: `removed_before_scan: ${detail}`,
        removedOnPurpose: true,
      });
      logger.info("moderateImage.removed_before_scan", {
        storageKey: input.storageKey,
        recordId: record.id,
      });
      return {
        status: "ORPHANED",
        maxSeverity: 0,
        degraded: false,
        noop: false,
        removedOnPurpose: true,
      };
    }

    await repos.imageModerationRecords.markOrphaned({
      storageKey: input.storageKey,
      resolvedAt: new Date(),
      lastError: detail,
    });

    // Deliberate swallow: we resolve instead of throwing, and the product tells
    // NOBODY (no hold notice — there is nothing for the uploader to act on, and
    // the image is already unreachable from every public surface). Sentry is
    // the only place this becomes visible, so the report is required, not
    // optional. Guarded — a throwing reporter never changes behaviour.
    //
    // A real `Error`, not the caught value: `createFileStorageError` returns a
    // PLAIN OBJECT, which Sentry renders as "Object captured as exception with
    // keys: code, message" under a synthetic stack, grouping every orphan in
    // the app under one shapeless issue. The degraded branch below constructs
    // one for the same reason. The original code/message ride in `extra`.
    try {
      reportError?.(
        new Error("image moderation object missing (orphaned)"),
        {
          tags: { area: "image-moderation", reason: "orphaned_object" },
          extra: {
            code: err.code,
            message: detail,
            storageKey: input.storageKey,
            recordId: record.id,
          },
        },
      );
    } catch {
      // best-effort only
    }

    logger.error("moderateImage.orphaned_object", {
      storageKey: input.storageKey,
      recordId: record.id,
      error: detail,
    });

    return {
      status: "ORPHANED",
      maxSeverity: 0,
      degraded: false,
      // NOT a no-op: this call resolved the row. The drain counts it as an
      // `orphaned` outcome and must not treat it as a moderation verdict.
      noop: false,
    };
  }

  const contentType =
    record.contentType ?? object.contentType ?? "application/octet-stream";

  const result = await moderation.moderateImage({
    imageBytes: object.content,
    contentType,
    imageId: record.id,
    subjectType: record.subjectType ?? undefined,
    subjectId: record.subjectId ?? undefined,
  });

  // Threshold decision lives HERE, not in the adapter. A degraded (provider
  // failed) result is always held for a human (fail-closed, FR-006) — that
  // branch is evaluated FIRST and never consults the category thresholds, so a
  // degraded verdict (which carries an empty `categories`) can't be reasoned
  // into an APPROVE.
  const flagged =
    result.degraded || exceedsCategoryThreshold(result.categories, config);
  const status = flagged ? "FLAGGED" : "APPROVED";

  await repos.imageModerationRecords.markResult({
    storageKey: input.storageKey,
    status,
    maxSeverity: result.maxSeverity,
    categories: result.categories,
    provider: result.provider,
    degraded: result.degraded,
    moderatedAt: new Date(),
  });

  if (result.degraded) {
    // FR-006: the adapter already reported its own fail-closed error, but we
    // also make the held-on-provider-failure outcome visible here. Guarded so
    // a throwing reporter never changes behaviour.
    try {
      reportError?.(
        new Error("image moderation degraded (fail-closed to FLAGGED)"),
        {
          tags: { area: "image-moderation", provider: result.provider },
          extra: { storageKey: input.storageKey, imageId: record.id },
        },
      );
    } catch {
      // best-effort only
    }
  }

  logger.info("moderateImage.resolved", {
    storageKey: input.storageKey,
    status,
    maxSeverity: result.maxSeverity,
    degraded: result.degraded,
    provider: result.provider,
  });

  return {
    status,
    maxSeverity: result.maxSeverity,
    degraded: result.degraded,
    noop: false,
  };
}

/**
 * Whether a missing object is a place page image nothing names any more, so
 * its deletion was deliberate. Page images have no row of their own; the
 * only deletions of a stripped copy are the outbox's (handover Clear and
 * draft discard, both after a 24 h grace and only for keys the page no
 * longer names; a place merge, which deletes the page with no grace). So
 * "the page (or its draft) no longer names the key" is the durable sign of
 * a deliberate removal. The outbox row itself is no help: the drain hard-deletes it in
 * the same run that deletes the object.
 *
 * A key the page STILL names that is gone is a real fault (a broken image
 * on the page): reported as before. Any other kind of record, a missing
 * `entityPages` dep, or a lookup that throws also answers false, so a doubt
 * is reported rather than hidden (a throwing lookup is reported as well).
 */
async function isRemovedPageImage(
  deps: ModerateImageDeps,
  record: {
    id: string;
    kind: string;
    subjectType: string | null;
    subjectId: string | null;
    storageKey: string;
  },
): Promise<boolean> {
  const entityPages = deps.repos.entityPages;
  if (
    !entityPages ||
    record.kind !== "PAGE_MEDIA" ||
    record.subjectType !== "PLACE" ||
    !record.subjectId
  ) {
    return false;
  }
  const prefix = getEntityPageImageKeyPrefix("PLACE", record.subjectId);
  if (!record.storageKey.startsWith(prefix)) return false;
  try {
    const page = await entityPages.getByOwner("PLACE", record.subjectId);
    if (!page) return true;
    const [theme, blocks, draft] = await Promise.all([
      entityPages.getTheme(page.id),
      entityPages.listBlocks(page.id),
      entityPages.getDraft(page.id),
    ]);
    const named = pageImageKeysMentionedIn(
      [page, theme, blocks.map((b) => b.data), draft?.data, draft?.placePatch],
      prefix,
    );
    return !named.includes(record.storageKey);
  } catch (err) {
    // Deliberate swallow: answering false falls through to the ordinary
    // orphan report, so the image is never hidden; the failed lookup itself
    // is reported too (CLAUDE.md error convention). Guarded, so a throwing
    // reporter never changes the answer.
    deps.logger.warn("moderateImage.page_reference_check_failed", {
      storageKey: record.storageKey,
      err,
    });
    try {
      deps.reportError?.(err, {
        tags: { area: "image-moderation", step: "page_reference_check" },
        extra: { recordId: record.id, storageKey: record.storageKey },
      });
    } catch {
      // best-effort only
    }
    return false;
  }
}
