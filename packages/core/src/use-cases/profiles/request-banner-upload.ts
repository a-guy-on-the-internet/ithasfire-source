import type { FileStoragePort } from "@th/ports/file-storage";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { enforceQuota, incrementResourceUsage } from "../quotas/enforce-quota";
import { recordUploadRequest } from "../storage/publish-stripped-upload";
import { PROFILE_IMAGE_KEY_PREFIX } from "./storage-url";

const ALLOWED_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
export const MAX_BANNER_BYTES = 10 * 1024 * 1024;

const contentTypeToExtension: Record<
  (typeof ALLOWED_CONTENT_TYPES)[number],
  string
> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** The other way round, for the finalize to read a key's type back. */
export const BANNER_CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> =
  Object.fromEntries(
    Object.entries(contentTypeToExtension).map(([type, ext]) => [ext, type]),
  );

/**
 * Lifetime of the presigned PUT URL. The finalize deletes the upload key
 * again once it has expired (`publish-stripped-upload.ts`), so a re-PUT
 * through it after finalize cannot stay public.
 */
export const BANNER_PRESIGN_TTL_SECONDS = 15 * 60;

/** Outbox `source` prefix of this kind's upload rows (`publish-stripped-upload.ts`). */
export const BANNER_UPLOAD_SOURCE = "banner_upload";

export const requestBannerUploadInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    contentType: z.enum(ALLOWED_CONTENT_TYPES),
    sizeBytes: z.number().int().positive().max(MAX_BANNER_BYTES),
  })
  .strict();

export const requestBannerUploadOutputSchema = z
  .object({
    key: z.string().min(1),
    uploadUrl: z.string().url(),
  })
  .strict();

export type RequestBannerUploadInput = z.infer<
  typeof requestBannerUploadInputSchema
>;
export type RequestBannerUploadOutput = z.infer<
  typeof requestBannerUploadOutputSchema
>;

export type RequestBannerUploadDeps = {
  repos: Pick<Repos, "resourceQuotas" | "pendingObjectDeletions">;
  storage: FileStoragePort;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function requestBannerUpload(
  deps: RequestBannerUploadDeps,
  rawInput: unknown,
): Promise<RequestBannerUploadOutput> {
  const logger = deps.logger?.child({ useCase: "requestBannerUpload" });

  const execute = async () => {
    const input = parseInput(requestBannerUploadInputSchema, rawInput);
    const now = deps.clock.now();

    // Enforce per-human storage quota
    await enforceQuota(deps.repos as any, {
      subjectType: "HUMAN",
      subjectId: input.actorHumanId,
      kind: "STORAGE_BYTES_HUMAN",
      delta: BigInt(input.sizeBytes),
    });

    const ext = contentTypeToExtension[input.contentType];
    const key = `${PROFILE_IMAGE_KEY_PREFIX.bannerUrl(input.actorHumanId)}${now.toISOString().slice(0, 10)}/${randomUUID()}.${ext}`;

    // Before the URL exists: who asked for this key, and its deletion once
    // the URL has expired, so an upload never finalized does not stay
    // public with its metadata (publish-stripped-upload.ts).
    await recordUploadRequest(deps.repos.pendingObjectDeletions, {
      kind: { source: BANNER_UPLOAD_SOURCE, presignTtlSeconds: BANNER_PRESIGN_TTL_SECONDS },
      uploadKey: key,
      actorHumanId: input.actorHumanId,
      now,
    });

    const { uploadUrl } = await deps.storage.presignPutObject({
      key,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      public: true,
      metadata: {
        "th-kind": "banner",
        "th-owner-human-id": input.actorHumanId,
      },
      options: {
        expiresSec: BANNER_PRESIGN_TTL_SECONDS,
      },
    });

    // Track human storage usage
    await incrementResourceUsage(deps.repos as any, {
      subjectType: "HUMAN",
      subjectId: input.actorHumanId,
      kind: "STORAGE_BYTES_HUMAN",
      delta: BigInt(input.sizeBytes),
    });

    return requestBannerUploadOutputSchema.parse({
      key,
      uploadUrl,
    });
  };

  if (logger) {
    return logger.withTime("requestBannerUpload", execute);
  }

  return execute();
}
