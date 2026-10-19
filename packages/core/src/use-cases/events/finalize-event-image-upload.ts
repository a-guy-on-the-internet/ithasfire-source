import { randomUUID } from "node:crypto";

import { z } from "zod";
import type { Repos } from "@th/ports/repos";
import type { AuthZPort } from "@th/ports/authz";
import {
  isFileStorageError,
  type FileStoragePort,
} from "@th/ports/file-storage";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import { fail } from "../../lib/errors";
import { describeError } from "../../lib/io";
import { fail as appFail, isAppError } from "@th/errors";
import type { ImageRecord } from "@th/ports/repos/images";
import type { EnqueuePendingObjectDeletionItem } from "@th/ports/repos/pending-object-deletions";
import { enqueueImageModeration } from "../moderation/enqueue-image-moderation";
import { incrementResourceUsage } from "../quotas/enforce-quota";
import { eventStorageQuotaSubject } from "../storage/event-media-targets";
import { reportableStorageError } from "../storage/reportable-storage-error";
import {
  IMAGE_STRIP_BUSY,
  IMAGE_UNREADABLE,
  stripUploadedImage,
} from "../storage/strip-uploaded-image";
import { verifyUploadedObjectSize } from "../storage/verify-uploaded-object-size";
import {
  EVENT_IMAGE_PRESIGN_TTL_SECONDS,
  MAX_EVENT_IMAGE_BYTES,
} from "./request-event-image-upload";

/**
 * Outbox `source` values this use case writes (free-form column; these name
 * the producer for whoever triages a dead letter).
 */
export const FINALIZE_IMAGE_DELETION_SOURCES = {
  /** The original upload, due now (the post-commit delete is the fast path). */
  original: "event_image_upload_original",
  /** The original upload again, after its presigned PUT URL has expired. */
  originalAfterPresign: "event_image_upload_original_after_presign",
  /** A stripped copy written by a finalize that lost the race to another. */
  losingCopy: "event_image_stripped_losing_copy",
} as const;

/**
 * Slack past the presign expiry before the second deletion: a PUT that
 * started just before expiry may still be streaming 25 MB.
 */
const PRESIGN_EXPIRY_MARGIN_MS = 15 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Input Schema
// ─────────────────────────────────────────────────────────────────────────────

export const finalizeEventImageUploadInputSchema = z
  .object({
    actorHumanId: z.string().min(1),
    imageId: z.string().min(1),
  })
  .strict();

export type FinalizeEventImageUploadInput = z.infer<
  typeof finalizeEventImageUploadInputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Output Schema
// ─────────────────────────────────────────────────────────────────────────────

export const finalizeEventImageUploadOutputSchema = z.object({
  imageId: z.string().min(1),
  publicUrl: z.string().min(1),
  contentType: z.string().nullable(),
  sizeBytes: z.number().int().positive().nullable(),
  /** Pixel size read from the file header; null when it could not be read. */
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
});

export type FinalizeEventImageUploadOutput = z.infer<
  typeof finalizeEventImageUploadOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────

export type FinalizeEventImageUploadDeps = {
  repos: Pick<
    Repos,
    "events" | "images" | "imageModerationRecords" | "pendingObjectDeletions" | "tx"
  >;
  authz: Pick<AuthZPort, "canEditEvent">;
  fileStorage: Pick<
    FileStoragePort,
    "headObject" | "getObjectUrl" | "deleteObject" | "getObject" | "putObject"
  >;
  logger: LoggerPort;
  /**
   * Reports the deliberate swallows: a failed delete of an oversize upload,
   * a failed delete of the original upload once its stripped copy is live
   * (or once it was refused), an upload the metadata stripper could not
   * parse (refused; reported so a stripper bug on real photos is visible),
   * and a finalize refused because the strip queue was full (rethrown, but
   * the transport would not report it).
   */
  reportError?: ReporterPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Finalizes an event image upload after the client has PUT bytes to R2.
 *
 * Verifies the object exists in R2 at no more than its declared size, then
 * PUBLISHES A METADATA-STRIPPED COPY instead of the upload: the bytes are read,
 * EXIF/GPS, XMP, IPTC, comments and appended secondary images are dropped
 * (orientation kept; see `strip-image-metadata.ts`), and the result is written
 * to a new key that cannot be derived from the upload's (`strippedImageKey`).
 * The row's `key` and `publicUrl` move to that copy and the moderation record
 * names it.
 *
 * THE ORIGINAL IS DELETED THROUGH THE OUTBOX. In the same transaction as the
 * row update, two deletions of the upload key are enqueued: one due now, and
 * one due after the presigned PUT URL expires (a re-PUT through the
 * still-valid URL after finalize would otherwise stay public). The
 * post-commit `deleteObject` is only the fast path; the drain job retries
 * whatever it misses.
 *
 * Once the fast-path delete lands, the due-now row is removed again, so a
 * normal finalize leaves only the delayed row behind.
 *
 * Bytes the stripper cannot parse are refused (`INVALID_INPUT` /
 * `image_unreadable`): the upload is deleted, and the row is RETIRED
 * (soft-deleted, its declared bytes credited back to the quota it was
 * charged to) so a repeat finalize gets `IMAGE_NOT_FOUND` instead of
 * refusing, and enqueueing, all over again. Only the delayed deletion is
 * outboxed, plus a due-now one if the inline delete failed.
 *
 * Concurrent finalizes: the strip runs in a process-wide slot and is shared
 * by concurrent calls for the same upload (`strip-uploaded-image.ts`); a call
 * that reaches a slot after the row was finalized returns it without reading
 * the object. Across processes `markUploaded` is conditional on the row not
 * being uploaded yet, so one wins. The loser enqueues no moderation, outboxes
 * its own copy if it wrote a different key, and returns the winner's row.
 *
 * Also records the image's pixel size, read from the stripped bytes inside
 * the strip slot, so the event poster `<img>` can carry `width`/`height` and the
 * browser can reserve its box before the bytes arrive (null when the header
 * cannot be read).
 *
 * `sizeBytes` stays the DECLARED size: the quota was charged from it at
 * presign, and every release path (sweep, cancel, delete) credits the row's
 * `sizeBytes` back, so changing it here would make charge and credit differ.
 */
export const finalizeEventImageUpload = async (
  deps: FinalizeEventImageUploadDeps,
  rawInput: unknown,
): Promise<FinalizeEventImageUploadOutput> => {
  const { repos, authz, fileStorage, logger } = deps;

  // ─── Parse input ───────────────────────────────────────────────────────────
  const parsed = finalizeEventImageUploadInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return fail(
      "invalid_input",
      parsed.error.issues[0]?.message ?? "invalid_input",
    );
  }
  const input = parsed.data;

  // ─── Fetch image record ────────────────────────────────────────────────────
  const image = await repos.images.getById(input.imageId);
  if (!image) {
    return appFail("IMAGE_NOT_FOUND");
  }

  // ─── Authorization ──────────────────────────────────────────────────────────
  // COMMUNITY listings (FR-015, community-managed-event-listings spec):
  // canEditEvent always fails for ownerless rows, so suggestion-borne uploads
  // are finalized by their UPLOADER (createdByHumanId) instead — the same
  // signed-in identity that requested the presigned PUT and was
  // quota-charged. OWNED events are unchanged: must be an event editor.
  const event = await repos.events.getById(image.eventId ?? image.ownerId);
  if (event?.stewardship === "COMMUNITY") {
    if (image.createdByHumanId !== input.actorHumanId) {
      return appFail("NOT_AUTHORIZED");
    }
  } else {
    const canEdit = await authz.canEditEvent({
      actorHumanId: input.actorHumanId,
      eventId: image.ownerId,
    });
    if (!canEdit.allowed) {
      return appFail("NOT_AUTHORIZED");
    }
  }

  // ─── Check if already finalized ────────────────────────────────────────────
  if (image.uploadedAt) {
    // Already finalized, just return existing data
    return finalizedOutput(image);
  }
  // Retired without being finalized: a refused upload, or swept.
  if (image.deletedAt) {
    return appFail("IMAGE_NOT_FOUND");
  }

  // ─── Verify object exists in R2, at no more than the declared size ────────
  // F11: the quota was charged from `image.sizeBytes` (the declaration), so an
  // object bigger than that — or than the event-image cap — is deleted and
  // refused. The row stays un-finalized, so the orphan sweep reclaims it.
  const head = await verifyUploadedObjectSize(
    { storage: fileStorage, logger, reportError: deps.reportError },
    {
      key: image.key,
      maxBytes: MAX_EVENT_IMAGE_BYTES,
      declaredBytes: image.sizeBytes,
      context: "finalizeEventImageUpload",
    },
  );
  if (!head.exists) {
    return alreadyFinalizedOrNotComplete(deps, image);
  }

  // ─── Strip metadata into a new object ─────────────────────────────────────
  // After the size gate, so an oversize object is never read. Outside the tx:
  // it is network I/O. A storage failure throws before anything commits; a
  // retry with the same bytes re-derives the same stripped key. The row is
  // read again once a strip slot is held: a finalize that queued behind
  // another for the same image then never reads the object.
  let stripped: Awaited<ReturnType<typeof stripUploadedImage>>;
  try {
    stripped = await stripUploadedImage(
      { fileStorage },
      {
        uploadKey: image.key,
        contentType: image.contentType ?? "",
        public: true,
        stillNeeded: async () => {
          const fresh = await repos.images.getById(image.id);
          return !!fresh && !fresh.uploadedAt && !fresh.deletedAt;
        },
      },
    );
  } catch (err) {
    // Gone between the HEAD and the read: a concurrent finalize deleted it.
    if (isFileStorageError(err) && err.code === "not_found") {
      return alreadyFinalizedOrNotComplete(deps, image);
    }
    // The process's strip queue is full: refused (retryable, the client
    // gets TOO_MANY_REQUESTS). The transport does not report a
    // TOO_MANY_REQUESTS, so this does: a full queue means real uploads are
    // being turned away. Every refusal, unthrottled: they come in bursts
    // that Sentry groups into one issue, and the error log already reaches
    // Sentry per call, so throttling only the report would not cut volume.
    if (isAppError(err) && err.code === "RATE_LIMITED" && err.message === IMAGE_STRIP_BUSY) {
      logger.error("Event image finalize refused: the strip queue is full", {
        imageId: input.imageId,
        err,
      });
      report(deps, err, {
        tags: {
          area: "image_metadata_strip",
          useCase: "finalizeEventImageUpload",
          step: "strip_busy",
        },
        extra: { imageId: input.imageId },
      });
    }
    throw err;
  }
  if (!stripped.ok && stripped.superseded) {
    return alreadyFinalizedOrNotComplete(deps, image);
  }
  if (!stripped.ok) {
    // Not a walkable image of its declared type. Refused rather than
    // published unstripped. Reported as well as logged (once per upload, by
    // the call that retires it, below): a real photo landing here would be a
    // stripper bug, and it must be visible.
    const stripError = stripped.error;
    logger.warn("Event image upload refused: metadata could not be stripped", {
      imageId: input.imageId,
      key: image.key,
      contentType: image.contentType,
      reason: stripError.reason,
    });
    // The refused bytes may still carry metadata (a truncated phone photo
    // does), and they are public at the upload key: delete now. Then retire
    // the row in one tx with the outbox rows that finish the job: the
    // delayed deletion (a re-PUT through the still-valid URL), and a due-now
    // one only if the delete just failed. Retiring is conditional, so of N
    // racing refusals exactly one credits the quota and enqueues.
    const deletedNow = await deleteUploadBestEffort(deps, {
      imageId: input.imageId,
      key: image.key,
    });
    const retired = await repos.tx(async (tx) => {
      const now = new Date();
      const won = await tx.images.softDeleteIfUnfinalized({
        id: image.id,
        deletedAt: now,
      });
      if (!won) return false;
      // Credit back what request-event-image-upload charged, to the same
      // subject (the event's owner, else the uploading human).
      const subject = event
        ? (eventStorageQuotaSubject(event) ??
          (image.createdByHumanId
            ? {
                subjectType: "HUMAN" as const,
                subjectId: image.createdByHumanId,
                kind: "STORAGE_BYTES_HUMAN" as const,
              }
            : null))
        : null;
      if (subject && image.sizeBytes) {
        await incrementResourceUsage(tx, { ...subject, delta: -image.sizeBytes });
      }
      await tx.pendingObjectDeletions.enqueueMany(
        uploadKeyDeletions(image, now, { dueNow: !deletedNow }),
      );
      return true;
    });
    if (retired) {
      report(deps, stripError, {
        tags: {
          area: "image_metadata_strip",
          useCase: "finalizeEventImageUpload",
          step: "parse",
        },
        extra: { imageId: input.imageId, key: image.key, reason: stripError.reason },
      });
    } else {
      // A concurrent call got there first: it either finalized the image
      // (different bytes, re-PUT in between) or refused it already (and
      // reported it).
      const fresh = await repos.images.getById(image.id);
      if (fresh?.uploadedAt) return finalizedOutput(fresh);
    }
    return appFail("INVALID_INPUT", {
      message: IMAGE_UNREADABLE,
      meta: { reason: IMAGE_UNREADABLE },
    });
  }
  // No bytes here: the helper read the pixel size inside its strip slot and
  // let the file go, so nothing below (tx, delete, outbox) holds 25 MB.
  const copy = stripped;
  const dimensions = copy.dimensions;
  const publicUrl = copy.publicUrl;

  // ─── Mark as uploaded + enqueue moderation + outbox the original ───────────
  // All in one tx: the moderation record can't be lost if the process dies
  // between writes, and the original's deletion is durable the moment the
  // row stops pointing at it. The image hero starts life PENDING (hidden on
  // public surfaces via read-time gating) until the async drain runs the
  // provider. Moderation is enqueued only by the finalize that WINS the
  // conditional mark, so a double-finalize never re-PENDINGs a decided
  // record. Both writes name the STRIPPED key: it is what the public URL
  // serves, and the visibility gate looks images up by the row's key.
  const outcome = await repos.tx(async (tx) => {
    const now = new Date();
    const marked = await tx.images.markUploaded({
      id: input.imageId,
      uploadedAt: now,
      key: copy.key,
      publicUrl,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
    });

    if (!marked) {
      // Lost to a concurrent finalize (or the row is gone). Same bytes give
      // the same key, so the winner's object may BE ours: outbox ours only
      // when the winner points elsewhere.
      const winner = await tx.images.getById(input.imageId);
      if (winner?.key !== copy.key) {
        await tx.pendingObjectDeletions.enqueueMany([
          {
            targetKey: copy.key,
            targetKind: "KEY",
            source: FINALIZE_IMAGE_DELETION_SOURCES.losingCopy,
            sourceId: input.imageId,
          },
        ]);
      }
      return { won: false as const, winner, dueNowId: null };
    }

    await enqueueImageModeration(tx, {
      storageKey: copy.key,
      kind: "EVENT_HERO",
      subjectType: "EVENT",
      subjectId: image.eventId ?? image.ownerId,
      publicUrl,
      contentType: image.contentType,
      createdByHumanId: image.createdByHumanId,
    });

    const dueNowId = randomUUID();
    await tx.pendingObjectDeletions.enqueueMany(
      uploadKeyDeletions(image, now, { dueNow: true, dueNowId }),
    );
    return { won: true as const, dueNowId };
  });

  if (!outcome.won) {
    logger.info("Event image finalize lost to a concurrent finalize", {
      imageId: input.imageId,
      winnerKey: outcome.winner?.key ?? null,
    });
    if (!outcome.winner?.uploadedAt) return appFail("IMAGE_NOT_FOUND");
    return finalizedOutput(outcome.winner);
  }

  // ─── Delete the original now (fast path; the outbox is the guarantee) ─────
  // After the commit: until then the row still names the upload key, and a
  // rollback must not leave it pointing at a deleted object. When it lands,
  // the due-now outbox row has nothing left to do: remove it, so the drain
  // only ever sees the delayed row from a normal finalize.
  if (await deleteUploadBestEffort(deps, { imageId: input.imageId, key: image.key })) {
    await removeFulfilledDeletion(deps, {
      imageId: input.imageId,
      outboxId: outcome.dueNowId,
    });
  }

  logger.info("Event image upload finalized", {
    imageId: input.imageId,
    eventId: image.ownerId,
    publicUrl,
    metadataRemoved: copy.removed,
    metadataRemovedCount: copy.removedCount,
  });

  return {
    imageId: image.id,
    publicUrl,
    contentType: image.contentType,
    sizeBytes: image.sizeBytes ? Number(image.sizeBytes) : null,
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
  };
};

/**
 * The outbox rows that delete an upload key: one due now (when `dueNow`), and
 * one due after the presigned PUT URL has expired (skipped when that moment
 * has passed).
 */
function uploadKeyDeletions(
  image: Pick<ImageRecord, "id" | "key" | "createdAt">,
  now: Date,
  opts: { dueNow: boolean; dueNowId?: string },
): EnqueuePendingObjectDeletionItem[] {
  const items: EnqueuePendingObjectDeletionItem[] = [];
  if (opts.dueNow) {
    items.push({
      ...(opts.dueNowId ? { id: opts.dueNowId } : {}),
      targetKey: image.key,
      targetKind: "KEY",
      source: FINALIZE_IMAGE_DELETION_SOURCES.original,
      sourceId: image.id,
    });
  }
  const afterPresign = new Date(
    image.createdAt.getTime() +
      EVENT_IMAGE_PRESIGN_TTL_SECONDS * 1000 +
      PRESIGN_EXPIRY_MARGIN_MS,
  );
  if (afterPresign > now) {
    items.push({
      targetKey: image.key,
      targetKind: "KEY",
      source: FINALIZE_IMAGE_DELETION_SOURCES.originalAfterPresign,
      sourceId: image.id,
      notBefore: afterPresign,
    });
  }
  return items;
}

/**
 * The upload is missing. If a concurrent finalize already finished this
 * image (it deletes the upload after committing), that is a finished image,
 * not a missing one; otherwise the client never completed its PUT.
 */
async function alreadyFinalizedOrNotComplete(
  deps: Pick<FinalizeEventImageUploadDeps, "repos" | "logger">,
  image: ImageRecord,
): Promise<FinalizeEventImageUploadOutput> {
  const fresh = await deps.repos.images.getById(image.id);
  if (fresh?.uploadedAt) return finalizedOutput(fresh);
  if (!fresh || fresh.deletedAt) return appFail("IMAGE_NOT_FOUND");
  deps.logger.warn("Image not found in storage during finalization", {
    imageId: image.id,
    key: image.key,
  });
  return appFail("UPLOAD_NOT_COMPLETE");
}

function finalizedOutput(image: ImageRecord): FinalizeEventImageUploadOutput {
  return {
    imageId: image.id,
    publicUrl: image.publicUrl,
    contentType: image.contentType,
    sizeBytes: image.sizeBytes ? Number(image.sizeBytes) : null,
    width: image.width,
    height: image.height,
  };
}

/** Best-effort reporting must never change the outcome. */
function report(
  deps: Pick<FinalizeEventImageUploadDeps, "reportError">,
  err: unknown,
  context: Parameters<ReporterPort>[1],
): void {
  try {
    deps.reportError?.(err, context);
  } catch {
    // Swallowed: there is nowhere else to report a reporter failure.
  }
}

/**
 * Deletes the client's original upload (the bytes WITH metadata): the fast
 * path ahead of the outbox rows. A deliberate swallow: the image itself is
 * fine (or already refused), and the outbox retries the delete, so a storage
 * hiccup must not fail the request. Still logged at error AND reported: until
 * the drain gets to it, the original is publicly readable at its key.
 * Returns whether the delete landed.
 */
async function deleteUploadBestEffort(
  deps: Pick<FinalizeEventImageUploadDeps, "fileStorage" | "logger" | "reportError">,
  args: { imageId: string; key: string },
): Promise<boolean> {
  try {
    await deps.fileStorage.deleteObject({ key: args.key });
    return true;
  } catch (err) {
    deps.logger.error("Could not delete the original event image upload", {
      imageId: args.imageId,
      key: args.key,
      err,
      error: describeError(err),
    });
    report(deps, reportableStorageError(err), {
      tags: {
        area: "image_metadata_strip",
        useCase: "finalizeEventImageUpload",
        step: "delete_original",
      },
      extra: { imageId: args.imageId, key: args.key },
    });
    return false;
  }
}

/**
 * Removes the due-now outbox row once the fast-path delete has done its job.
 * A deliberate swallow: if this fails, the drain deletes an already-deleted
 * key (a no-op) and removes the row itself, so nothing is lost but one
 * outbox slot. Logged and reported all the same.
 */
async function removeFulfilledDeletion(
  deps: Pick<FinalizeEventImageUploadDeps, "repos" | "logger" | "reportError">,
  args: { imageId: string; outboxId: string },
): Promise<void> {
  try {
    await deps.repos.pendingObjectDeletions.markDeleted(args.outboxId);
  } catch (err) {
    deps.logger.error("Could not remove a fulfilled image deletion from the outbox", {
      imageId: args.imageId,
      outboxId: args.outboxId,
      err,
      error: describeError(err),
    });
    report(deps, err, {
      tags: {
        area: "image_metadata_strip",
        useCase: "finalizeEventImageUpload",
        step: "remove_fulfilled_deletion",
      },
      extra: { imageId: args.imageId, outboxId: args.outboxId },
    });
  }
}
