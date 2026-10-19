import { createHash, randomUUID } from "node:crypto";

import { fail, isAppError } from "@th/errors";
import {
  isFileStorageError,
  type FileStoragePort,
} from "@th/ports/file-storage";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { EnqueuePendingObjectDeletionItem } from "@th/ports/repos/pending-object-deletions";
import type {
  QuotaSubjectType,
  ResourceLimitKind,
} from "@th/ports/repos/resource-quotas";

import { describeError } from "../../lib/io";
import { incrementResourceUsage } from "../quotas/enforce-quota";
import { reportableStorageError } from "./reportable-storage-error";
import {
  IMAGE_STRIP_BUSY,
  IMAGE_UNREADABLE,
  stripUploadedImage,
} from "./strip-uploaded-image";
import { verifyUploadedObjectSize } from "./verify-uploaded-object-size";

/**
 * Publishing an uploaded image that has NO DATABASE ROW of its own (profile
 * avatar and banner, entity-page images): the same metadata strip as event
 * images (`finalize-event-image-upload.ts`), with the upload's fate recorded
 * in the deletion outbox instead of on a row.
 *
 * THE CLAIM. Each upload key gets one outbox row with a deterministic id
 * ({@link uploadClaimId}): the deletion of the upload key due after its
 * presigned PUT URL has expired. Whoever inserts it first decides what the
 * upload became, by its `source`:
 *
 *   - `<kind>_original_after_presign`, `sourceId` = the stripped copy's key:
 *     published. Only this finalize credits the strip's savings to the quota.
 *   - `<kind>_refused`: the bytes were unreadable. Only this finalize credits
 *     the upload's bytes back and reports it.
 *
 * Inserting is `ON CONFLICT DO NOTHING`, so N racing finalizes get one
 * winner across processes, and the claim outlives any number of re-PUTs
 * through the still-valid presigned URL (it is drained only after that URL
 * has expired). Without it, each re-PUT of unreadable bytes would credit the
 * charge back again, and each re-PUT of a different image would publish a
 * second copy from one charge: both mint quota.
 *
 * A finalize that loses the claim to a publish of the SAME copy is a repeat
 * (a double submit, a retry after a lost response) and returns that copy.
 * Any other loser is refused, and its own copy is outboxed. Once the upload
 * key is gone, the claim still answers a repeat ({@link prepareStrippedUpload}
 * returns `published`) until it is drained.
 *
 * The claim row lives under `pending_object_deletion`'s free-form
 * `source`/`sourceId` columns; no schema of its own.
 */

/**
 * Slack past the presign expiry before the claim row deletes the upload key
 * again: a PUT that started just before expiry may still be streaming.
 */
export const PRESIGN_EXPIRY_MARGIN_MS = 15 * 60 * 1000;

/** One kind of row-less upload. */
export type UnrowedUploadKind = {
  /** Outbox `source` prefix, e.g. `"avatar_upload"`. */
  source: string;
  /** Use-case name for logs and report tags. */
  useCase: string;
  /** The request schema's size cap. */
  maxBytes: number;
  /** The presigned PUT URL's lifetime, as the request use case signs it. */
  presignTtlSeconds: number;
};

/** The quota the request use case charged the upload's declared size to. */
export type UploadQuotaSubject = {
  subjectType: QuotaSubjectType;
  subjectId: string;
  kind: ResourceLimitKind;
};

/**
 * Whom the functions below credit: the subject the REQUEST charged, or
 * `null` when the request charged nothing (an upload charged only when its
 * caller publishes it, a community moderator's place page image). With
 * `null` nothing is ever credited: no savings, no refused bytes, no
 * abandoned charge.
 */
export type UploadCreditSubject = UploadQuotaSubject | null;

/** The outbox `source` values one kind writes. */
export function unrowedUploadSources(kind: Pick<UnrowedUploadKind, "source">) {
  return {
    /** The claim of a published upload (due after the presign expires). */
    claim: `${kind.source}_original_after_presign`,
    /** The claim of a refused upload (due after the presign expires). */
    refused: `${kind.source}_refused`,
    /** The upload key, due now (the post-commit delete is the fast path). */
    original: `${kind.source}_original`,
    /** A stripped copy written by a finalize that lost the claim. */
    unclaimedCopy: `${kind.source}_stripped_unclaimed`,
    /**
     * The request's record of who asked for the upload key (`sourceId` =
     * the human), due after its presigned URL has expired
     * ({@link recordUploadRequest}).
     */
    request: `${kind.source}_request`,
    /** A refused copy's never-credit marker ({@link creditMarkerId}). */
    unclaimedCopyNoCredit: `${kind.source}_stripped_unclaimed_no_credit`,
  };
}

/**
 * The claim row's id. A hash, so the outbox (read by ops) never holds the
 * upload key in an id; the row's `targetKey` names it anyway.
 */
export function uploadClaimId(uploadKey: string): string {
  return `upload-claim:${createHash("sha256").update(uploadKey).digest("hex")}`;
}

/**
 * The upload request's row id ({@link recordUploadRequest}): a hash, like
 * the claim's, so the outbox never holds the upload key in an id.
 */
export function uploadRequestId(uploadKey: string): string {
  return `upload-request:${createHash("sha256").update(uploadKey).digest("hex")}`;
}

/**
 * Records, when the upload is REQUESTED and before its presigned URL is
 * handed out, who asked for the key: an outbox row (`sourceId` = the human)
 * that deletes the upload key after the URL has expired.
 *
 *   - It names the uploader without trusting the object store: a finalize
 *     by anyone else is refused (`prepareStrippedUpload`'s `uploader`). The
 *     presign-time metadata stamp says the same, but not every store keeps
 *     query-string metadata.
 *   - An upload nobody finalizes (GPS and all, public at its key) is
 *     deleted by the drain instead of staying public forever. Its charge is
 *     not credited back, as before: the drain moves no quota.
 *
 * Due at the same moment as the claim of a finalize made right away (the
 * claim is due `TTL + margin` after the finalize), so a finalize late in the
 * window finds its upload deleted and is refused as missing. Both rows
 * delete the same key; the drain treats a missing key as deleted.
 */
export async function recordUploadRequest(
  repo: Pick<TxRepos["pendingObjectDeletions"], "enqueueOnce">,
  args: {
    kind: Pick<UnrowedUploadKind, "source" | "presignTtlSeconds">;
    uploadKey: string;
    actorHumanId: string;
    now: Date;
  },
): Promise<void> {
  await repo.enqueueOnce({
    id: uploadRequestId(args.uploadKey),
    targetKey: args.uploadKey,
    targetKind: "KEY",
    source: unrowedUploadSources(args.kind).request,
    sourceId: args.actorHumanId,
    notBefore: afterPresign(args.kind, args.now),
  });
}

/**
 * How long a never-credit-again marker stays in the outbox. It only has to
 * outlive any cleanup still holding a HEAD of the same key; a day is far
 * past that. Its drain re-deletes a key that is already gone (a no-op).
 */
export const CREDIT_MARKER_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The id of the marker that says "this key's bytes have been credited back,
 * or must never be": a replaced profile image's cleanup credits only when it
 * INSERTS this row (`cleanup-replaced-image.ts`), and a finalize that loses
 * the claim inserts it for its never-charged copy first. A hash, so the id
 * never spells the key.
 */
export function creditMarkerId(key: string): string {
  return `replaced-credit:${createHash("sha256").update(key).digest("hex")}`;
}

const UPLOAD_NAME =
  /^\d{4}-\d{2}-\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.([a-z0-9]+)$/;

/**
 * The content type of an upload key the request use case minted:
 * `<prefix><YYYY-MM-DD>/<uuid>.<ext>`, with `ext` one of the kind's. Null for
 * anything else, including a stripped copy's key (32 hex chars, no dashes),
 * so a finalize cannot be pointed at a published copy to delete it.
 */
export function uploadKeyContentType(
  key: string,
  prefix: string,
  contentTypeByExtension: Readonly<Record<string, string>>,
): string | null {
  if (!key.startsWith(prefix)) return null;
  const match = UPLOAD_NAME.exec(key.slice(prefix.length));
  const ext = match?.[1];
  if (!ext || !Object.hasOwn(contentTypeByExtension, ext)) return null;
  return contentTypeByExtension[ext] ?? null;
}

export type PublishStrippedUploadDeps = {
  repos: Pick<Repos, "pendingObjectDeletions" | "tx">;
  fileStorage: Pick<
    FileStoragePort,
    "headObject" | "deleteObject" | "getObject" | "putObject" | "getObjectUrl"
  >;
  logger?: LoggerPort;
  /**
   * Reports: an unreadable upload (once, by the finalize that claims it), a
   * full strip queue, a failed delete of an upload, a failed removal of a
   * fulfilled outbox row. All but the strip queue are deliberate swallows.
   */
  reportError?: ReporterPort;
};

export type PrepareStrippedUploadArgs = {
  kind: UnrowedUploadKind;
  uploadKey: string;
  /** From {@link uploadKeyContentType}. */
  contentType: string;
  quotaSubject: UploadCreditSubject;
  /**
   * Who must be finalizing, for a kind whose key prefix does not name the
   * uploader (a place or org page: any of its managers passes the prefix
   * check). An upload someone else requested is answered `missing`, with
   * nothing read, deleted or credited, so the quota credit can only land on
   * the subject that was charged.
   *
   * Two signals, either one refuses:
   *   1. the request's outbox row ({@link recordUploadRequest}), whatever
   *      the store does; checked BEFORE the HEAD, so not even the size
   *      gate's delete runs for someone else's upload;
   *   2. the presign-time metadata stamp under `metadataKey`, when the HEAD
   *      returns it. Free (the HEAD runs anyway), and it still answers for
   *      an upload requested before the request row existed.
   * With neither (an old upload on a store that drops the stamp), the key
   * alone decides, as before: a random token only its requester was given.
   */
  uploader?: { humanId: string; metadataKey?: string };
};

export type PreparedUpload =
  | {
      status: "stripped";
      /** Key and URL of the stripped copy (written, not yet claimed). */
      key: string;
      publicUrl: string;
      sizeBytes: number;
      /** Size of the upload: what the request charged (signed length). */
      uploadSize: number;
      removedCount: number;
    }
  | {
      /** This upload was published before; `key` is its stripped copy. */
      status: "published";
      key: string;
    }
  | {
      /** Never uploaded, refused before, or its claim has been drained. */
      status: "missing";
    };

/**
 * Size gate, then strip into a new key, for an upload with no row.
 *
 * Unreadable bytes are refused here (deleted; `INVALID_INPUT` /
 * `image_unreadable`), and the claim decides the credit. A `stripped` result
 * must be followed by {@link claimStrippedUpload} in the caller's transaction
 * and {@link finishStrippedUpload} after it.
 *
 * Reads nothing when the upload is already claimed: the strip slot asks the
 * outbox first, so a repeat after a publish returns the copy without reading
 * the object again (and deletes the upload if a re-PUT brought it back).
 */
export async function prepareStrippedUpload(
  deps: PublishStrippedUploadDeps,
  args: PrepareStrippedUploadArgs,
): Promise<PreparedUpload> {
  const { kind, uploadKey } = args;
  const claimId = uploadClaimId(uploadKey);

  if (args.uploader) {
    const request = await deps.repos.pendingObjectDeletions.getById(
      uploadRequestId(uploadKey),
    );
    if (request && request.sourceId !== args.uploader.humanId) {
      return refuseOthersUpload(deps, kind, uploadKey, "request_row");
    }
  }

  // F11 size gate: an object bigger than its signed declaration (or the
  // kind's cap) is deleted and refused before anything reads it.
  const head = await verifyUploadedObjectSize(
    { storage: deps.fileStorage, logger: deps.logger, reportError: deps.reportError },
    { key: uploadKey, maxBytes: kind.maxBytes, context: kind.useCase },
  );
  if (!head.exists) return previouslyPublished(deps, kind, uploadKey);

  // The stamp, for an upload with no request row. After the size gate,
  // which only deletes an object larger than its signed Content-Length (one
  // the store should never have accepted).
  const stampedUploader = args.uploader?.metadataKey
    ? head.metadata?.[args.uploader.metadataKey]
    : undefined;
  if (
    args.uploader &&
    stampedUploader !== undefined &&
    stampedUploader !== args.uploader.humanId
  ) {
    return refuseOthersUpload(deps, kind, uploadKey, "metadata");
  }

  let stripped: Awaited<ReturnType<typeof stripUploadedImage>>;
  try {
    stripped = await stripUploadedImage(
      { fileStorage: deps.fileStorage },
      {
        uploadKey,
        contentType: args.contentType,
        public: true,
        stillNeeded: async () =>
          !(await deps.repos.pendingObjectDeletions.getById(claimId)),
      },
    );
  } catch (err) {
    // Gone between the HEAD and the read: a concurrent finalize deleted it.
    if (isFileStorageError(err) && err.code === "not_found") {
      return previouslyPublished(deps, kind, uploadKey);
    }
    // Same as event images: a full strip queue refuses (TOO_MANY_REQUESTS,
    // which the transport does not report), so it is logged and reported
    // here, per call.
    if (isAppError(err) && err.code === "RATE_LIMITED" && err.message === IMAGE_STRIP_BUSY) {
      deps.logger?.error("Image upload refused: the strip queue is full", {
        useCase: kind.useCase,
        err,
      });
      report(deps, err, {
        tags: { area: "image_metadata_strip", useCase: kind.useCase, step: "strip_busy" },
      });
    }
    throw err;
  }

  if (!stripped.ok && stripped.superseded) {
    // Already claimed. Whatever the upload key holds now (a re-PUT, or the
    // moment before the winner's own delete) is not going to be published.
    await deleteUploadBestEffort(deps, kind, uploadKey);
    return previouslyPublished(deps, kind, uploadKey);
  }

  if (!stripped.ok) {
    const stripError = stripped.error;
    deps.logger?.warn("Image upload refused: metadata could not be stripped", {
      useCase: kind.useCase,
      key: uploadKey,
      contentType: args.contentType,
      reason: stripError.reason,
    });
    // The refused bytes may still carry metadata, and they are public at
    // the upload key: delete now. Then claim the upload as refused, with a
    // due-now deletion only if that delete failed. The claim is what makes
    // the credit happen once, however many times the bytes are re-PUT.
    const deletedNow = await deleteUploadBestEffort(deps, kind, uploadKey);
    const sources = unrowedUploadSources(kind);
    const credited = await deps.repos.tx(async (tx) => {
      const now = new Date();
      const claim = await tx.pendingObjectDeletions.enqueueOnce({
        id: claimId,
        targetKey: uploadKey,
        targetKind: "KEY",
        source: sources.refused,
        notBefore: afterPresign(kind, now),
      });
      if (!deletedNow) {
        await tx.pendingObjectDeletions.enqueueMany([
          { targetKey: uploadKey, targetKind: "KEY", source: sources.original },
        ]);
      }
      if (!claim.inserted) return false;
      // Back to the quota the request charged: the signed Content-Length
      // makes the stored size exactly the declared size it charged. Nothing
      // when the request charged nothing (a null subject).
      if (head.size > 0 && args.quotaSubject !== null) {
        await incrementResourceUsage(tx, {
          ...args.quotaSubject,
          delta: -BigInt(head.size),
        });
      }
      return true;
    });
    if (credited) {
      // Once per upload (the claimer): a real photo landing here would be a
      // stripper bug, and it must be visible.
      report(deps, stripError, {
        tags: { area: "image_metadata_strip", useCase: kind.useCase, step: "parse" },
        extra: { key: uploadKey, reason: stripError.reason },
      });
    }
    return fail("INVALID_INPUT", {
      message: IMAGE_UNREADABLE,
      meta: { reason: IMAGE_UNREADABLE },
    });
  }

  return {
    status: "stripped",
    key: stripped.key,
    publicUrl: stripped.publicUrl,
    sizeBytes: stripped.sizeBytes,
    uploadSize: head.size,
    removedCount: stripped.removedCount,
  };
}

export type ClaimedUpload =
  | {
      /** This finalize published the upload. */
      status: "claimed";
      dueNowId: string;
    }
  | {
      /** An earlier finalize published this same copy. */
      status: "repeat";
      dueNowId: string;
    }
  | {
      /** The upload was refused, or published as a different copy. */
      status: "refused";
      dueNowId: string;
    };

/**
 * Claims a stripped upload, INSIDE the caller's transaction (with the write
 * that publishes the copy, when there is one). Enqueues the upload key's
 * deletions: the claim row (due after the presign expires) and a due-now
 * row, whose id {@link finishStrippedUpload} takes.
 *
 * The claimer credits what the strip saved (`uploadSize - copy size`), so
 * the quota holds the stored copy's size: every later credit (a replaced
 * avatar's cleanup) reads the copy's own size. With a null `quotaSubject`
 * (the request charged nothing) it credits nothing; a caller that charges at
 * publish does so in the same transaction, on `claimed` only, so a repeat
 * never charges twice.
 *
 * A caller must not publish anything unless the result is `claimed`; on
 * `refused` it should fail the request after its transaction commits.
 */
export async function claimStrippedUpload(
  tx: TxRepos,
  args: {
    kind: UnrowedUploadKind;
    uploadKey: string;
    copy: { key: string; sizeBytes: number };
    uploadSize: number;
    quotaSubject: UploadCreditSubject;
  },
): Promise<ClaimedUpload> {
  const sources = unrowedUploadSources(args.kind);
  const now = new Date();
  const claim = await tx.pendingObjectDeletions.enqueueOnce({
    id: uploadClaimId(args.uploadKey),
    targetKey: args.uploadKey,
    targetKind: "KEY",
    source: sources.claim,
    // Not an entity id here: the published copy, so a repeat can find it.
    sourceId: args.copy.key,
    notBefore: afterPresign(args.kind, now),
  });

  const dueNowId = randomUUID();
  const deletions: EnqueuePendingObjectDeletionItem[] = [
    {
      id: dueNowId,
      targetKey: args.uploadKey,
      targetKind: "KEY",
      source: sources.original,
    },
  ];

  if (claim.inserted) {
    await tx.pendingObjectDeletions.enqueueMany(deletions);
    const saved = args.uploadSize - args.copy.sizeBytes;
    // A null subject was never charged: the caller charges the copy itself.
    if (saved > 0 && args.quotaSubject !== null) {
      await incrementResourceUsage(tx, {
        ...args.quotaSubject,
        delta: -BigInt(saved),
      });
    }
    return { status: "claimed", dueNowId };
  }

  if (
    claim.existing?.source === sources.claim &&
    claim.existing.sourceId === args.copy.key
  ) {
    // Same upload key, same bytes: the copy we wrote IS the published one.
    await tx.pendingObjectDeletions.enqueueMany(deletions);
    return { status: "repeat", dueNowId };
  }

  // Refused before, or published from other bytes (a re-PUT after the
  // publish). Our copy is nobody's: outbox it with the upload.
  deletions.push({
    targetKey: args.copy.key,
    targetKind: "KEY",
    source: sources.unclaimedCopy,
  });
  await tx.pendingObjectDeletions.enqueueMany(deletions);
  // Never charged, so never credited: until the drain deletes it, the copy
  // is a live object under the owner's prefix, and a replaced-image cleanup
  // that met it would otherwise credit its size. The marker makes that
  // cleanup skip the credit.
  await tx.pendingObjectDeletions.enqueueOnce({
    id: creditMarkerId(args.copy.key),
    targetKey: args.copy.key,
    targetKind: "KEY",
    source: sources.unclaimedCopyNoCredit,
    notBefore: new Date(now.getTime() + CREDIT_MARKER_TTL_MS),
  });
  return { status: "refused", dueNowId };
}

/**
 * The caller's publish was refused AFTER {@link prepareStrippedUpload} wrote
 * the stripped copy and BEFORE {@link claimStrippedUpload} committed (an
 * access re-check inside the claim's transaction, say: a community
 * moderator whose place was claimed meanwhile). In ITS OWN transaction:
 *
 *   - claims the upload as refused (the `<kind>_refused` claim row, as for
 *     unreadable bytes), so the credit below happens once and a later
 *     finalize of the same key can never publish it;
 *   - outboxes the never-charged copy (with its never-credit marker, as a
 *     losing finalize does) and the upload key, due now; when an earlier
 *     finalize of the same bytes already PUBLISHED this copy, only the
 *     upload key (the copy is live);
 *   - credits the request's charge (`uploadSize`) back when it won the
 *     claim (nothing for a null `quotaSubject`: the request charged
 *     nothing).
 *
 * Returns the upload's due-now row id for {@link finishStrippedUpload}
 * (the post-commit fast-path delete). The caller re-throws its refusal.
 */
export async function abandonStrippedUpload(
  deps: Pick<PublishStrippedUploadDeps, "repos">,
  args: {
    kind: UnrowedUploadKind;
    uploadKey: string;
    copy: { key: string };
    uploadSize: number;
    quotaSubject: UploadCreditSubject;
  },
): Promise<{ dueNowId: string; credited: boolean }> {
  const sources = unrowedUploadSources(args.kind);
  return deps.repos.tx(async (tx) => {
    const now = new Date();
    const claim = await tx.pendingObjectDeletions.enqueueOnce({
      id: uploadClaimId(args.uploadKey),
      targetKey: args.uploadKey,
      targetKind: "KEY",
      source: sources.refused,
      notBefore: afterPresign(args.kind, now),
    });
    const dueNowId = randomUUID();
    const uploadDueNow: EnqueuePendingObjectDeletionItem = {
      id: dueNowId,
      targetKey: args.uploadKey,
      targetKind: "KEY",
      source: sources.original,
    };
    if (
      !claim.inserted &&
      claim.existing?.source === sources.claim &&
      claim.existing.sourceId === args.copy.key
    ) {
      // An earlier finalize of the SAME bytes published this very copy
      // (claimStrippedUpload's repeat): the copy is live, so it is neither
      // outboxed nor marked never-credit. Only the upload goes.
      await tx.pendingObjectDeletions.enqueueMany([uploadDueNow]);
      return { dueNowId, credited: false };
    }
    await tx.pendingObjectDeletions.enqueueMany([
      uploadDueNow,
      { targetKey: args.copy.key, targetKind: "KEY", source: sources.unclaimedCopy },
    ]);
    await tx.pendingObjectDeletions.enqueueOnce({
      id: creditMarkerId(args.copy.key),
      targetKey: args.copy.key,
      targetKind: "KEY",
      source: sources.unclaimedCopyNoCredit,
      notBefore: new Date(now.getTime() + CREDIT_MARKER_TTL_MS),
    });
    const subject = claim.inserted ? args.quotaSubject : null;
    if (subject !== null && args.uploadSize > 0) {
      await incrementResourceUsage(tx, {
        ...subject,
        delta: -BigInt(args.uploadSize),
      });
    }
    return { dueNowId, credited: subject !== null };
  });
}

/**
 * After the caller's commit: delete the upload (fast path; the outbox is the
 * guarantee) and, when that lands, remove the due-now row it made redundant.
 */
export async function finishStrippedUpload(
  deps: PublishStrippedUploadDeps,
  args: { kind: UnrowedUploadKind; uploadKey: string; dueNowId: string },
): Promise<void> {
  if (await deleteUploadBestEffort(deps, args.kind, args.uploadKey)) {
    try {
      await deps.repos.pendingObjectDeletions.markDeleted(args.dueNowId);
    } catch (err) {
      // Deliberate swallow: the drain deletes an already-deleted key (a
      // no-op) and removes the row itself.
      deps.logger?.error("Could not remove a fulfilled image deletion from the outbox", {
        useCase: args.kind.useCase,
        outboxId: args.dueNowId,
        err,
        error: describeError(err),
      });
      report(deps, err, {
        tags: {
          area: "image_metadata_strip",
          useCase: args.kind.useCase,
          step: "remove_fulfilled_deletion",
        },
        extra: { outboxId: args.dueNowId },
      });
    }
  }
}

function afterPresign(
  kind: Pick<UnrowedUploadKind, "presignTtlSeconds">,
  now: Date,
): Date {
  // The presign happened before the upload, which happened before now, so
  // `now + TTL` is past the URL's expiry whenever it was signed.
  return new Date(now.getTime() + kind.presignTtlSeconds * 1000 + PRESIGN_EXPIRY_MARGIN_MS);
}

function refuseOthersUpload(
  deps: Pick<PublishStrippedUploadDeps, "logger">,
  kind: UnrowedUploadKind,
  uploadKey: string,
  signal: "request_row" | "metadata",
): PreparedUpload {
  deps.logger?.warn("Image upload finalize refused: another human's upload", {
    useCase: kind.useCase,
    key: uploadKey,
    signal,
  });
  return { status: "missing" };
}

async function previouslyPublished(
  deps: Pick<PublishStrippedUploadDeps, "repos">,
  kind: UnrowedUploadKind,
  uploadKey: string,
): Promise<PreparedUpload> {
  const claim = await deps.repos.pendingObjectDeletions.getById(uploadClaimId(uploadKey));
  if (claim?.source === unrowedUploadSources(kind).claim && claim.sourceId) {
    return { status: "published", key: claim.sourceId };
  }
  return { status: "missing" };
}

/**
 * Deletes an upload (the bytes WITH metadata). A deliberate swallow: an
 * outbox row retries it. Logged at error and reported all the same: until
 * the drain gets to it, the original is readable at its key.
 */
async function deleteUploadBestEffort(
  deps: Pick<PublishStrippedUploadDeps, "fileStorage" | "logger" | "reportError">,
  kind: UnrowedUploadKind,
  key: string,
): Promise<boolean> {
  try {
    await deps.fileStorage.deleteObject({ key });
    return true;
  } catch (err) {
    deps.logger?.error("Could not delete an original image upload", {
      useCase: kind.useCase,
      key,
      err,
      error: describeError(err),
    });
    report(deps, reportableStorageError(err), {
      tags: { area: "image_metadata_strip", useCase: kind.useCase, step: "delete_original" },
      extra: { key },
    });
    return false;
  }
}

/** Best-effort reporting must never change the outcome. */
function report(
  deps: Pick<PublishStrippedUploadDeps, "reportError">,
  err: unknown,
  context: Parameters<ReporterPort>[1],
): void {
  try {
    deps.reportError?.(err, context);
  } catch {
    // Swallowed: there is nowhere else to report a reporter failure.
  }
}
