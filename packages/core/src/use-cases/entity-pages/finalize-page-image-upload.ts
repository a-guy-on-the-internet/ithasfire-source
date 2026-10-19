import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import { isFileStorageError, type FileStoragePort } from "@th/ports/file-storage";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import { z } from "zod";

import { parseInput } from "../../lib/io";
import { fail, isAppError } from "@th/errors";
import {
  ENTITY_PAGE_IMAGE_UPLOADER_METADATA_KEY,
  entityPageImageContentTypeToExtension,
  entityPageImageOwnerIdSchema,
  entityPageOwnerTypeSchema,
  getEntityPageImageKeyPrefix,
  getEntityPageImageQuotaSubject,
  MAX_ENTITY_PAGE_IMAGE_BYTES,
} from "./page-image-upload-helpers";
import {
  PAGE_IMAGE_COMMUNITY_REQUEST_SOURCE,
  PAGE_IMAGE_PRESIGN_TTL_SECONDS,
  PAGE_IMAGE_UPLOAD_SOURCE,
} from "./request-page-image-upload";
import {
  COMMUNITY_PAGE_REFUSAL_CODES,
  logCommunityPageUpdate,
  recheckCommunityPageEditor,
  resolveEntityPageEditor,
} from "./entity-page-access";
import {
  abandonStrippedUpload,
  claimStrippedUpload,
  finishStrippedUpload,
  prepareStrippedUpload,
  uploadKeyContentType,
  uploadRequestId,
  type UnrowedUploadKind,
} from "../storage/publish-stripped-upload";
import { enqueueImageModeration } from "../moderation/enqueue-image-moderation";
import { enforceQuota, incrementResourceUsage } from "../quotas/enforce-quota";

export const finalizePageImageUploadInputSchema = z
  .object({
    actorHumanId: z.string().min(1),
    ownerType: entityPageOwnerTypeSchema,
    ownerId: entityPageImageOwnerIdSchema,
    key: z.string().min(1).max(1024),
  })
  .strict();

export const finalizePageImageUploadOutputSchema = z
  .object({
    publicUrl: z.string().url(),
  })
  .strict();

export type FinalizePageImageUploadInput = z.infer<
  typeof finalizePageImageUploadInputSchema
>;
export type FinalizePageImageUploadOutput = z.infer<
  typeof finalizePageImageUploadOutputSchema
>;

export type FinalizePageImageUploadDeps = {
  /** `places` and `events` serve the community moderator access rules. */
  repos: Pick<
    Repos,
    "entityPages" | "pendingObjectDeletions" | "tx" | "places" | "events"
  >;
  authz: Pick<AuthZPort, "requireOrgRole" | "canManagePlace" | "hasStaffRole">;
  clock: ClockPort;
  storage: FileStoragePort;
  logger?: LoggerPort;
  /**
   * Reports the deliberate swallows (a failed delete of an oversize upload,
   * of the original upload, of its fulfilled outbox row), an unreadable
   * upload (once), and a full strip queue.
   */
  reportError?: ReporterPort;
};

const PAGE_IMAGE_CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> =
  Object.fromEntries(
    Object.entries(entityPageImageContentTypeToExtension).map(([type, ext]) => [
      ext,
      type,
    ]),
  );

const PAGE_IMAGE_UPLOAD_KIND: UnrowedUploadKind = {
  source: PAGE_IMAGE_UPLOAD_SOURCE,
  useCase: "finalizePageImageUpload",
  maxBytes: MAX_ENTITY_PAGE_IMAGE_BYTES,
  presignTtlSeconds: PAGE_IMAGE_PRESIGN_TTL_SECONDS,
};

/**
 * Confirms an entity-page image upload and returns the URL the client puts
 * into the page (block content, avatar, banner).
 *
 * The URL names a METADATA-STRIPPED COPY (EXIF/GPS, XMP, IPTC, comments
 * dropped; see `strip-uploaded-image.ts`) at a key that cannot be derived
 * from the upload's, never the upload. The upload is deleted after the copy
 * is claimed, and outboxed with the claim (`publish-stripped-upload.ts`).
 *
 * This finalize writes nothing else, so the claim's transaction IS the
 * anchor: it commits right after the strip and before the URL is returned.
 * A crash between the strip's write and that commit leaves the upload at
 * its key and an unreferenced copy beside it, with nothing outboxed. That
 * is acceptable: no URL was handed out, the upload key is a random token
 * only the uploader holds (as it was before finalize), and the client's
 * retry re-derives the same copy and claims it. If it never retries, both
 * objects stay: no sweep covers row-less uploads, and neither is linked from
 * anywhere. Anchoring earlier is not possible without a row: the claim
 * names the copy, whose key is known only after the strip.
 *
 * A repeat (same upload, same bytes) returns the same URL; once the upload
 * has been deleted, the claim answers it until the claim is drained (the
 * presign TTL + 15 min), then the repeat gets UPLOADED_PAGE_IMAGE_NOT_FOUND.
 * Unreadable bytes are refused (`INVALID_INPUT` / `image_unreadable`) and
 * their charge is credited back once.
 */
export async function finalizePageImageUpload(
  deps: FinalizePageImageUploadDeps,
  rawInput: unknown,
): Promise<FinalizePageImageUploadOutput> {
  const logger = deps.logger?.child({ useCase: "finalizePageImageUpload" });

  const execute = async (): Promise<FinalizePageImageUploadOutput> => {
    const input = parseInput(finalizePageImageUploadInputSchema, rawInput);

    const editor = await resolveEntityPageEditor(deps, input);

    const expectedPrefix = getEntityPageImageKeyPrefix(
      input.ownerType,
      input.ownerId,
    );
    // Only a key the request use case minted for this page: anything else
    // (another owner's key, or a published copy's key) is refused.
    const contentType = uploadKeyContentType(
      input.key,
      expectedPrefix,
      PAGE_IMAGE_CONTENT_TYPE_BY_EXTENSION,
    );
    if (!contentType) {
      throw fail("PAGE_IMAGE_KEY_NOT_OWNED");
    }

    const page = await deps.repos.entityPages.getByOwner(
      input.ownerType,
      input.ownerId,
    );
    if (!page) {
      throw fail("PAGE_NOT_FOUND");
    }

    // The upload's quota: the org; for a community moderator's upload to an
    // unowned place, the PLACE (R5); else the REQUESTING human. Which of the
    // last two is pinned by the request's outbox row
    // (`PAGE_IMAGE_COMMUNITY_REQUEST_SOURCE`), read back here rather than
    // re-derived from today's editor, so a moderator who became the owner
    // in between still lands on the place. A request with no row (requested
    // before the row existed) charged the human.
    //
    // WHEN it is charged differs. The org and the human were charged the
    // declared size at request, and the strip's savings (or a refused
    // upload's whole charge) are credited back below (`creditSubject`). The
    // place was only CHECKED at request: it is charged here, the stripped
    // copy's size, in the claim's transaction, so a request nobody
    // finalizes costs it nothing, and nothing is ever credited to it here.
    //
    // The prefix names only the place, so any of its managers passes the key
    // check: `uploader` refuses an upload someone else requested (as not
    // found: nothing read, deleted or credited), so a credit lands on the
    // subject that was charged. It reads the request's outbox row
    // (`recordUploadRequest`), then the presign-time metadata stamp; an
    // upload with neither falls back to trusting the key, a random token
    // only the requester was given.
    const requestRow = await deps.repos.pendingObjectDeletions.getById(
      uploadRequestId(input.key),
    );
    const communityUpload =
      requestRow?.source === PAGE_IMAGE_COMMUNITY_REQUEST_SOURCE &&
      requestRow.sourceId === input.actorHumanId;
    const quotaSubject = getEntityPageImageQuotaSubject(input, {
      communityUpload,
    });
    const creditSubject = communityUpload ? null : quotaSubject;
    const publishDeps = {
      repos: deps.repos,
      fileStorage: deps.storage,
      logger,
      reportError: deps.reportError,
    };

    // HEAD + size gate (F11), then the strip into a new key.
    const prepared = await prepareStrippedUpload(publishDeps, {
      kind: PAGE_IMAGE_UPLOAD_KIND,
      uploadKey: input.key,
      contentType,
      quotaSubject: creditSubject,
      uploader: {
        humanId: input.actorHumanId,
        metadataKey: ENTITY_PAGE_IMAGE_UPLOADER_METADATA_KEY,
      },
    });
    if (prepared.status === "missing") {
      throw fail("UPLOADED_PAGE_IMAGE_NOT_FOUND");
    }
    if (prepared.status === "published") {
      // A repeat. The copy may be gone since (removed from the page and
      // drained): getObjectUrl HEADs the key, and its not_found is ours.
      try {
        const { url } = await deps.storage.getObjectUrl({
          key: prepared.key,
          options: { public: true },
        });
        return finalizePageImageUploadOutputSchema.parse({ publicUrl: url });
      } catch (err) {
        if (isFileStorageError(err) && err.code === "not_found") {
          throw fail("UPLOADED_PAGE_IMAGE_NOT_FOUND");
        }
        throw err;
      }
    }

    // A community moderator's claim runs under the place's claim lock,
    // re-checked, so an upload started before a claim landed does not
    // publish after it; its audit row and its image review record
    // (`enqueueImageModeration`, R5) ride the same transaction. A community
    // upload's place charge rides it too, on `claimed` only (the claim row
    // is inserted once, so a repeat never charges again), checked against
    // the place's quota first: requests in flight together all passed the
    // request's check. The claim lock serializes that check only while the
    // finalizer is still a moderator. One who has meanwhile become the
    // place's owner finalizes a community upload (the request row decides
    // the charge) with no lock, so concurrent finalizes can each pass the
    // check and overshoot the quota by at most one upload apiece. When the
    // re-check or that quota check refuses, the
    // copy just written and the upload are outboxed and any request charge
    // credited back (abandonStrippedUpload), then the refusal is re-thrown:
    // no URL is handed out.
    const claimInTx = () => deps.repos.tx(async (tx) => {
      const now = deps.clock.now();
      await recheckCommunityPageEditor(tx, editor, now);
      const claimed = await claimStrippedUpload(tx, {
        kind: PAGE_IMAGE_UPLOAD_KIND,
        uploadKey: input.key,
        copy: { key: prepared.key, sizeBytes: prepared.sizeBytes },
        uploadSize: prepared.uploadSize,
        quotaSubject: creditSubject,
      });
      if (claimed.status === "claimed" && communityUpload) {
        const charge = {
          ...quotaSubject,
          delta: BigInt(prepared.sizeBytes),
        };
        await enforceQuota(tx, charge);
        await incrementResourceUsage(tx, charge);
      }
      if (claimed.status === "claimed" && editor.kind === "community_moderator") {
        // Owner ruling R5: a moderator's page image goes through the image
        // review events use. PENDING until the worker scans it, and hidden
        // on the public page until APPROVED (gatePublicPageImages). Owner
        // uploads stay unreviewed, as before. The key is the STRIPPED copy,
        // the only one a page can name. The finalize does not know which
        // slot (avatar, banner, block) the URL will fill, so the kind is
        // PAGE_MEDIA for all of them.
        await enqueueImageModeration(tx, {
          storageKey: prepared.key,
          kind: "PAGE_MEDIA",
          subjectType: "PLACE",
          subjectId: editor.placeId,
          publicUrl: prepared.publicUrl,
          contentType:
            PAGE_IMAGE_CONTENT_TYPE_BY_EXTENSION[
              prepared.key.slice(prepared.key.lastIndexOf(".") + 1)
            ] ?? contentType,
          createdByHumanId: input.actorHumanId,
        });
      }
      if (claimed.status === "claimed") {
        await logCommunityPageUpdate(
          tx,
          editor,
          {
            actorHumanId: input.actorHumanId,
            pageId: page.id,
            op: "finalizePageImageUpload",
            fields: ["pageImage"],
            from: null,
            to: { key: prepared.key, url: prepared.publicUrl },
          },
          now,
        );
      }
      return claimed;
    });
    let claim: Awaited<ReturnType<typeof claimInTx>>;
    try {
      claim = await claimInTx();
    } catch (err) {
      if (
        (editor.kind === "community_moderator" &&
          isAppError(err) &&
          COMMUNITY_PAGE_REFUSAL_CODES.has(err.code)) ||
        (communityUpload && isQuotaRefusal(err))
      ) {
        try {
          const abandoned = await abandonStrippedUpload(publishDeps, {
            kind: PAGE_IMAGE_UPLOAD_KIND,
            uploadKey: input.key,
            copy: { key: prepared.key },
            uploadSize: prepared.uploadSize,
            quotaSubject: creditSubject,
          });
          await finishStrippedUpload(publishDeps, {
            kind: PAGE_IMAGE_UPLOAD_KIND,
            uploadKey: input.key,
            dueNowId: abandoned.dueNowId,
          });
        } catch (cleanupErr) {
          // Deliberate swallow: the caller is owed the REFUSAL, not the
          // cleanup's error. The copy stays unreferenced (no URL was handed
          // out) and the charge uncredited until someone looks; reported so
          // someone does. Guarded: a throwing reporter changes nothing.
          logger?.error("Could not clean up a refused page image finalize", {
            key: input.key,
            copyKey: prepared.key,
            err: cleanupErr,
          });
          try {
            deps.reportError?.(cleanupErr, {
              tags: {
                useCase: "finalizePageImageUpload",
                step: "abandon_refused_upload",
              },
              extra: { key: input.key, copyKey: prepared.key },
            });
          } catch {
            // Reporting is best-effort.
          }
        }
      }
      throw err;
    }

    await finishStrippedUpload(publishDeps, {
      kind: PAGE_IMAGE_UPLOAD_KIND,
      uploadKey: input.key,
      dueNowId: claim.dueNowId,
    });

    if (claim.status === "refused") {
      throw fail("UPLOADED_PAGE_IMAGE_NOT_FOUND");
    }

    logger?.info("Entity page image published", {
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      key: prepared.key,
      repeat: claim.status === "repeat",
      metadataRemovedCount: prepared.removedCount,
    });

    return finalizePageImageUploadOutputSchema.parse({
      publicUrl: prepared.publicUrl,
    });
  };

  if (logger) {
    return logger.withTime("finalizePageImageUpload", execute);
  }
  return execute();
}

/** `enforceQuota`'s `{ code: "forbidden", message: "quota_exceeded" }`. */
function isQuotaRefusal(err: unknown): boolean {
  return (
    !isAppError(err) &&
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "forbidden" &&
    (err as { message?: unknown }).message === "quota_exceeded"
  );
}
