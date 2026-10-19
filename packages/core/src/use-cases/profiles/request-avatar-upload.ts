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
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

const contentTypeToExtension: Record<
  (typeof ALLOWED_CONTENT_TYPES)[number],
  string
> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** The other way round, for the finalize to read a key's type back. */
export const AVATAR_CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> =
  Object.fromEntries(
    Object.entries(contentTypeToExtension).map(([type, ext]) => [ext, type]),
  );

/**
 * Lifetime of the presigned PUT URL. The finalize deletes the upload key
 * again once it has expired (`publish-stripped-upload.ts`), so a re-PUT
 * through it after finalize cannot stay public.
 */
export const AVATAR_PRESIGN_TTL_SECONDS = 15 * 60;

/** Outbox `source` prefix of this kind's upload rows (`publish-stripped-upload.ts`). */
export const AVATAR_UPLOAD_SOURCE = "avatar_upload";

export const requestAvatarUploadInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    contentType: z.enum(ALLOWED_CONTENT_TYPES),
    sizeBytes: z.number().int().positive().max(MAX_AVATAR_BYTES),
  })
  .strict();

export const requestAvatarUploadOutputSchema = z
  .object({
    key: z.string().min(1),
    uploadUrl: z.string().url(),
  })
  .strict();

export type RequestAvatarUploadInput = z.infer<
  typeof requestAvatarUploadInputSchema
>;
export type RequestAvatarUploadOutput = z.infer<
  typeof requestAvatarUploadOutputSchema
>;

export type RequestAvatarUploadDeps = {
  repos: Pick<Repos, "resourceQuotas" | "pendingObjectDeletions">;
  storage: FileStoragePort;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function requestAvatarUpload(
  deps: RequestAvatarUploadDeps,
  rawInput: unknown,
): Promise<RequestAvatarUploadOutput> {
  const logger = deps.logger?.child({ useCase: "requestAvatarUpload" });

  const execute = async () => {
    const input = parseInput(requestAvatarUploadInputSchema, rawInput);
    const now = deps.clock.now();

    // Enforce per-human storage quota
    await enforceQuota(deps.repos as any, {
      subjectType: "HUMAN",
      subjectId: input.actorHumanId,
      kind: "STORAGE_BYTES_HUMAN",
      delta: BigInt(input.sizeBytes),
    });

    const ext = contentTypeToExtension[input.contentType];
    const key = `${PROFILE_IMAGE_KEY_PREFIX.avatarUrl(input.actorHumanId)}${now.toISOString().slice(0, 10)}/${randomUUID()}.${ext}`;

    // Before the URL exists: who asked for this key, and its deletion once
    // the URL has expired, so an upload never finalized does not stay
    // public with its metadata (publish-stripped-upload.ts).
    await recordUploadRequest(deps.repos.pendingObjectDeletions, {
      kind: { source: AVATAR_UPLOAD_SOURCE, presignTtlSeconds: AVATAR_PRESIGN_TTL_SECONDS },
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
        "th-kind": "avatar",
        "th-owner-human-id": input.actorHumanId,
      },
      options: {
        expiresSec: AVATAR_PRESIGN_TTL_SECONDS,
      },
    });

    // Track human storage usage
    await incrementResourceUsage(deps.repos as any, {
      subjectType: "HUMAN",
      subjectId: input.actorHumanId,
      kind: "STORAGE_BYTES_HUMAN",
      delta: BigInt(input.sizeBytes),
    });

    return requestAvatarUploadOutputSchema.parse({
      key,
      uploadUrl,
    });
  };

  if (logger) {
    return logger.withTime("requestAvatarUpload", execute);
  }

  return execute();
}
