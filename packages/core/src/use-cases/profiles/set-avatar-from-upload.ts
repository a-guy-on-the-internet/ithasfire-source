import type { FileStoragePort } from "@th/ports/file-storage";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { z } from "zod";
import {
  AVATAR_CONTENT_TYPE_BY_EXTENSION,
  AVATAR_PRESIGN_TTL_SECONDS,
  AVATAR_UPLOAD_SOURCE,
  MAX_AVATAR_BYTES,
} from "./request-avatar-upload";
import {
  setProfileImageFromUpload,
  type ProfileImageConfig,
} from "./set-profile-image-from-upload";
import { PROFILE_IMAGE_KEY_PREFIX } from "./storage-url";

export const setAvatarFromUploadInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    key: z.string().min(1),
  })
  .strict();

export const setAvatarFromUploadOutputSchema = z
  .object({
    avatarUrl: z.string().url(),
  })
  .strict();

export type SetAvatarFromUploadInput = z.infer<
  typeof setAvatarFromUploadInputSchema
>;
export type SetAvatarFromUploadOutput = z.infer<
  typeof setAvatarFromUploadOutputSchema
>;

export type SetAvatarFromUploadDeps = {
  repos: Repos;
  storage: FileStoragePort;
  logger?: LoggerPort;
  /**
   * Best-effort Sentry hook for the deliberate swallows (the replaced
   * image's cleanup, the original upload's delete) and for an unreadable
   * upload or a full strip queue. See `set-profile-image-from-upload.ts`.
   */
  reportError?: ReporterPort;
};

const avatarImageConfig: ProfileImageConfig = {
  field: "avatarUrl",
  keyPrefix: PROFILE_IMAGE_KEY_PREFIX.avatarUrl,
  contentTypeByExtension: AVATAR_CONTENT_TYPE_BY_EXTENSION,
  kind: {
    source: AVATAR_UPLOAD_SOURCE,
    useCase: "setAvatarFromUpload",
    maxBytes: MAX_AVATAR_BYTES,
    presignTtlSeconds: AVATAR_PRESIGN_TTL_SECONDS,
  },
  notOwnedCode: "AVATAR_KEY_NOT_OWNED",
  notFoundCode: "UPLOADED_AVATAR_NOT_FOUND",
};

/**
 * Sets the human's profile avatar from an upload made through
 * `requestAvatarUpload`. Publishes a metadata-stripped copy, never the upload
 * itself; see `setProfileImageFromUpload` for the whole flow.
 */
export async function setAvatarFromUpload(
  deps: SetAvatarFromUploadDeps,
  rawInput: unknown,
): Promise<SetAvatarFromUploadOutput> {
  const logger = deps.logger?.child({ useCase: "setAvatarFromUpload" });

  const execute = async () => {
    const input = parseInput(setAvatarFromUploadInputSchema, rawInput);
    const url = await setProfileImageFromUpload(deps, avatarImageConfig, input, logger);
    return setAvatarFromUploadOutputSchema.parse({ avatarUrl: url });
  };

  if (logger) {
    return logger.withTime("setAvatarFromUpload", execute);
  }

  return execute();
}
