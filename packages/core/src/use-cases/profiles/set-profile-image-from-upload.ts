import { isFileStorageError, type FileStoragePort } from "@th/ports/file-storage";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";

import {
  claimStrippedUpload,
  finishStrippedUpload,
  prepareStrippedUpload,
  uploadKeyContentType,
  type ClaimedUpload,
  type UnrowedUploadKind,
  type UploadQuotaSubject,
} from "../storage/publish-stripped-upload";
import {
  cleanupReplacedImage,
  type ReplacedImageCleanupIntent,
} from "./cleanup-replaced-image";
import { extractStorageKeyFromUrl } from "./storage-url";

export type SetProfileImageFromUploadDeps = {
  repos: Repos;
  storage: FileStoragePort;
  logger?: LoggerPort;
  /**
   * Best-effort Sentry hook for the deliberate swallows: the post-commit
   * cleanup of the replaced image, the delete of the original upload and of
   * its fulfilled outbox row; also an unreadable upload (once) and a full
   * strip queue.
   */
  reportError?: ReporterPort;
};

/** What differs between the avatar and the banner. */
export type ProfileImageConfig = {
  field: "avatarUrl" | "bannerUrl";
  /** Every key of this kind for one human starts with it. */
  keyPrefix: (humanId: string) => string;
  /** Extension → content type, as the request use case mints keys. */
  contentTypeByExtension: Readonly<Record<string, string>>;
  kind: UnrowedUploadKind;
  notOwnedCode: "AVATAR_KEY_NOT_OWNED" | "BANNER_KEY_NOT_OWNED";
  notFoundCode: "UPLOADED_AVATAR_NOT_FOUND" | "UPLOADED_BANNER_NOT_FOUND";
};

/**
 * Sets a profile avatar or banner from an upload, PUBLISHING A
 * METADATA-STRIPPED COPY (EXIF/GPS, XMP, IPTC, comments dropped; see
 * `strip-uploaded-image.ts`) at a key that cannot be derived from the
 * upload's. The page's URL names the copy; the upload is deleted after the
 * commit and outboxed in the same transaction as the page write.
 *
 * The upload has no row, so its fate is recorded in the deletion outbox
 * (`publish-stripped-upload.ts`, "THE CLAIM"): the first finalize publishes,
 * a repeat with the same bytes returns the same URL (without reading the
 * object again), and a refused or re-PUT upload is refused. Unreadable bytes
 * are refused with `INVALID_INPUT` / `image_unreadable` and their charge is
 * credited back once.
 *
 * The claim commits with the page write. A crash between the strip's write
 * and that commit leaves the upload at its key (a token only the uploader
 * holds, as before finalize) and an unlinked copy; a retry claims that
 * same copy.
 *
 * The replaced image's cleanup deletes the OLD page URL's key (the stripped
 * copy for anything set since this change, the upload key for older
 * profiles), never the copy just published.
 *
 * Returns the copy's public URL.
 */
export async function setProfileImageFromUpload(
  deps: SetProfileImageFromUploadDeps,
  config: ProfileImageConfig,
  input: { actorHumanId: string; key: string },
  logger: LoggerPort | undefined,
): Promise<string> {
  const expectedPrefix = config.keyPrefix(input.actorHumanId);
  // Only a key the request use case minted for this human: anything else
  // (another human's key, or a published copy's key) is refused before any
  // storage call.
  const contentType = uploadKeyContentType(
    input.key,
    expectedPrefix,
    config.contentTypeByExtension,
  );
  if (!contentType) {
    return fail(config.notOwnedCode);
  }

  // Profile images are charged to the human (request-avatar/banner-upload).
  const quotaSubject: UploadQuotaSubject = {
    subjectType: "HUMAN",
    subjectId: input.actorHumanId,
    kind: "STORAGE_BYTES_HUMAN",
  };
  const publishDeps = {
    repos: deps.repos,
    fileStorage: deps.storage,
    logger,
    reportError: deps.reportError,
  };

  const prepared = await prepareStrippedUpload(publishDeps, {
    kind: config.kind,
    uploadKey: input.key,
    contentType,
    quotaSubject,
  });
  if (prepared.status === "missing") {
    return fail(config.notFoundCode);
  }
  if (prepared.status === "published") {
    // A repeat after the upload was published (and usually deleted). Same
    // answer as the first call, as long as the profile still shows it. The
    // copy is gone once a later image replaced it: getObjectUrl HEADs the
    // key, and its not_found is this not-found too.
    let url: string;
    try {
      ({ url } = await deps.storage.getObjectUrl({
        key: prepared.key,
        options: { public: true },
      }));
    } catch (err) {
      if (isFileStorageError(err) && err.code === "not_found") {
        return fail(config.notFoundCode);
      }
      throw err;
    }
    const page = await deps.repos.entityPages.getByOwner("HUMAN", input.actorHumanId);
    if (page?.[config.field] !== url) {
      return fail(config.notFoundCode);
    }
    return url;
  }

  const url = prepared.publicUrl;

  // A CONTAINER, not a bare `let`. TypeScript does not track assignments made
  // inside a nested function, so `let intent: T | null = null` stays narrowed
  // to `null` and the `if (intent)` guard below narrows it to `never` — which
  // is assignable to any parameter and silently disables the type check on
  // the call it guards.
  const pending: { cleanup: ReplacedImageCleanupIntent | null } = {
    cleanup: null,
  };

  const claim = await deps.repos.tx(async (tx): Promise<ClaimedUpload> => {
    // The claim and the upload's deletions commit with the page write.
    const claim = await claimStrippedUpload(tx, {
      kind: config.kind,
      uploadKey: input.key,
      copy: { key: prepared.key, sizeBytes: prepared.sizeBytes },
      uploadSize: prepared.uploadSize,
      quotaSubject,
    });
    if (claim.status !== "claimed") return claim;

    const current = await tx.entityPages.getByOwner("HUMAN", input.actorHumanId);

    await tx.entityPages.upsert({
      ownerType: "HUMAN",
      ownerId: input.actorHumanId,
      slug: current?.slug ?? input.actorHumanId,
      displayName: current?.displayName ?? null,
      avatarUrl: config.field === "avatarUrl" ? url : (current?.avatarUrl ?? null),
      bannerUrl: config.field === "bannerUrl" ? url : (current?.bannerUrl ?? null),
    });

    const oldKey = extractStorageKeyFromUrl(current?.[config.field] ?? null);
    if (
      oldKey &&
      oldKey !== prepared.key &&
      oldKey !== input.key &&
      oldKey.startsWith(expectedPrefix)
    ) {
      // Only RECORD the intent here. The object-storage round trips and the
      // quota write used to run right here as the last statement of this
      // transaction, inside a bare `try {} catch {}` — see
      // `cleanup-replaced-image.ts` for why that silently discarded the
      // upsert above and still reported success.
      pending.cleanup = { oldKey, humanId: input.actorHumanId };
    }
    return claim;
  });

  // Post-commit: the page names the copy before the upload is deleted.
  await finishStrippedUpload(publishDeps, {
    kind: config.kind,
    uploadKey: input.key,
    dueNowId: claim.dueNowId,
  });

  if (claim.status === "refused") {
    return fail(config.notFoundCode);
  }

  // Post-commit. The new URL is durable before the OLD blob — an
  // irreversible delete — is touched, so a rollback can no longer leave the
  // profile pointing at a key that has already been destroyed.
  if (pending.cleanup) {
    await cleanupReplacedImage(
      { storage: deps.storage, logger, reportError: deps.reportError },
      deps.repos,
      pending.cleanup,
      { useCase: config.kind.useCase },
    );
  }

  logger?.info("Profile image published", {
    field: config.field,
    key: prepared.key,
    repeat: claim.status === "repeat",
    metadataRemovedCount: prepared.removedCount,
  });

  return url;
}
