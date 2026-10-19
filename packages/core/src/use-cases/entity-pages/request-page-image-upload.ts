import { randomUUID } from "node:crypto";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { FileStoragePort } from "@th/ports/file-storage";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { z } from "zod";

import { parseInput } from "../../lib/io";
import { enforceQuota, incrementResourceUsage } from "../quotas/enforce-quota";
import {
  recordUploadRequest,
  unrowedUploadSources,
} from "../storage/publish-stripped-upload";
import { fail } from "@th/errors";
import {
  MAX_ENTITY_PAGE_IMAGE_BYTES,
  buildEntityPageImageMetadata,
  entityPageImageContentTypeSchema,
  entityPageImageContentTypeToExtension,
  entityPageImageOwnerIdSchema,
  entityPageOwnerTypeSchema,
  getEntityPageImageKeyPrefix,
  getEntityPageImageQuotaSubject,
} from "./page-image-upload-helpers";
import { resolveEntityPageEditor } from "./entity-page-access";

/**
 * Lifetime of the presigned PUT URL. The finalize deletes the upload key
 * again once it has expired (`publish-stripped-upload.ts`), so a re-PUT
 * through it after finalize cannot stay public.
 */
export const PAGE_IMAGE_PRESIGN_TTL_SECONDS = 15 * 60;

/** Outbox `source` prefix of page-image upload rows (`publish-stripped-upload.ts`). */
export const PAGE_IMAGE_UPLOAD_SOURCE = "entity_page_image_upload";

/**
 * The `source` prefix of the REQUEST row (only that row) of a community
 * moderator's upload to an unowned PLACE page. The row's source is what pins
 * the upload to the place's quota (STORAGE_BYTES_PLACE,
 * `getEntityPageImageQuotaSubject`): the request only CHECKS that quota, and
 * the finalize reads the row back by the key's request id and CHARGES the
 * stripped copy's size to the place, even if the actor's editor kind changed
 * in between. Every other row of the upload keeps `PAGE_IMAGE_UPLOAD_SOURCE`.
 */
export const PAGE_IMAGE_COMMUNITY_UPLOAD_SOURCE =
  "entity_page_image_upload_community";

/** The request row `source` that marks a place-charged community upload. */
export const PAGE_IMAGE_COMMUNITY_REQUEST_SOURCE = unrowedUploadSources({
  source: PAGE_IMAGE_COMMUNITY_UPLOAD_SOURCE,
}).request;

export const requestPageImageUploadInputSchema = z
  .object({
    actorHumanId: z.string().min(1),
    ownerType: entityPageOwnerTypeSchema,
    ownerId: entityPageImageOwnerIdSchema,
    contentType: entityPageImageContentTypeSchema,
    sizeBytes: z
      .number()
      .int()
      .positive()
      .max(MAX_ENTITY_PAGE_IMAGE_BYTES, "file_too_large"),
  })
  .strict();

export const requestPageImageUploadOutputSchema = z
  .object({
    key: z.string().min(1),
    uploadUrl: z.string().url(),
  })
  .strict();

export type RequestPageImageUploadInput = z.infer<
  typeof requestPageImageUploadInputSchema
>;
export type RequestPageImageUploadOutput = z.infer<
  typeof requestPageImageUploadOutputSchema
>;

export type RequestPageImageUploadDeps = {
  /** `places` and `events` serve the community moderator access rules. */
  repos: Pick<
    Repos,
    | "entityPages"
    | "resourceQuotas"
    | "pendingObjectDeletions"
    | "places"
    | "events"
  >;
  authz: Pick<AuthZPort, "requireOrgRole" | "canManagePlace" | "hasStaffRole">;
  storage: FileStoragePort;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function requestPageImageUpload(
  deps: RequestPageImageUploadDeps,
  rawInput: unknown,
): Promise<RequestPageImageUploadOutput> {
  const logger = deps.logger?.child({ useCase: "requestPageImageUpload" });

  const execute = async (): Promise<RequestPageImageUploadOutput> => {
    const input = parseInput(requestPageImageUploadInputSchema, rawInput);

    // Writes no page data: a community moderator's advisory check is
    // enough here; the finalize re-checks under the claim lock.
    const editor = await resolveEntityPageEditor(deps, input);
    // A moderator's upload is held by the place, not the moderator (R5).
    const communityUpload = editor.kind === "community_moderator";

    const page = await deps.repos.entityPages.getByOwner(
      input.ownerType,
      input.ownerId,
    );
    if (!page) {
      throw fail("PAGE_NOT_FOUND");
    }

    const quotaSubject = getEntityPageImageQuotaSubject(input, {
      communityUpload,
    });
    await enforceQuota(deps.repos as any, {
      ...quotaSubject,
      delta: BigInt(input.sizeBytes),
    });

    const ext = entityPageImageContentTypeToExtension[input.contentType];
    const now = deps.clock.now();
    const day = now.toISOString().slice(0, 10);
    const key = `${getEntityPageImageKeyPrefix(input.ownerType, input.ownerId)}${day}/${randomUUID()}.${ext}`;

    // Before the URL exists: who asked for this key (a place or org page's
    // prefix does not say; the finalize refuses anyone else), and its
    // deletion once the URL has expired, so an upload never finalized does
    // not stay public with its metadata (publish-stripped-upload.ts).
    await recordUploadRequest(deps.repos.pendingObjectDeletions, {
      kind: {
        // The source pins who was charged (see PAGE_IMAGE_COMMUNITY_UPLOAD_SOURCE).
        source: communityUpload
          ? PAGE_IMAGE_COMMUNITY_UPLOAD_SOURCE
          : PAGE_IMAGE_UPLOAD_SOURCE,
        presignTtlSeconds: PAGE_IMAGE_PRESIGN_TTL_SECONDS,
      },
      uploadKey: key,
      actorHumanId: input.actorHumanId,
      now,
    });

    const { uploadUrl } = await deps.storage.presignPutObject({
      key,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      public: true,
      metadata: buildEntityPageImageMetadata(input),
      options: { expiresSec: PAGE_IMAGE_PRESIGN_TTL_SECONDS },
    });

    // A community upload is charged at finalize, by the stripped copy's
    // size, so a request nobody finalizes costs the place nothing: charged
    // here, 21 unfinished 25 MiB requests would hold a place's 512 MiB
    // forever (the drain deletes the object but moves no quota). The check
    // above still refuses a request the place cannot hold.
    if (!communityUpload) {
      await incrementResourceUsage(deps.repos as any, {
        ...quotaSubject,
        delta: BigInt(input.sizeBytes),
      });
    }

    return requestPageImageUploadOutputSchema.parse({ key, uploadUrl });
  };

  if (logger) {
    return logger.withTime("requestPageImageUpload", execute);
  }
  return execute();
}
