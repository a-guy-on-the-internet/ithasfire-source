import type { FileStoragePort } from "@th/ports/file-storage";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { z } from "zod";
import {
  BANNER_CONTENT_TYPE_BY_EXTENSION,
  BANNER_PRESIGN_TTL_SECONDS,
  BANNER_UPLOAD_SOURCE,
  MAX_BANNER_BYTES,
} from "./request-banner-upload";
import {
  setProfileImageFromUpload,
  type ProfileImageConfig,
} from "./set-profile-image-from-upload";
import { PROFILE_IMAGE_KEY_PREFIX } from "./storage-url";

export const setBannerFromUploadInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    key: z.string().min(1),
  })
  .strict();

export const setBannerFromUploadOutputSchema = z
  .object({
    bannerUrl: z.string().url(),
  })
  .strict();

export type SetBannerFromUploadInput = z.infer<
  typeof setBannerFromUploadInputSchema
>;
export type SetBannerFromUploadOutput = z.infer<
  typeof setBannerFromUploadOutputSchema
>;

export type SetBannerFromUploadDeps = {
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

const bannerImageConfig: ProfileImageConfig = {
  field: "bannerUrl",
  keyPrefix: PROFILE_IMAGE_KEY_PREFIX.bannerUrl,
  contentTypeByExtension: BANNER_CONTENT_TYPE_BY_EXTENSION,
  kind: {
    source: BANNER_UPLOAD_SOURCE,
    useCase: "setBannerFromUpload",
    maxBytes: MAX_BANNER_BYTES,
    presignTtlSeconds: BANNER_PRESIGN_TTL_SECONDS,
  },
  notOwnedCode: "BANNER_KEY_NOT_OWNED",
  notFoundCode: "UPLOADED_BANNER_NOT_FOUND",
};

/**
 * Sets the human's profile banner from an upload made through
 * `requestBannerUpload`. Publishes a metadata-stripped copy, never the upload
 * itself; see `setProfileImageFromUpload` for the whole flow.
 */
export async function setBannerFromUpload(
  deps: SetBannerFromUploadDeps,
  rawInput: unknown,
): Promise<SetBannerFromUploadOutput> {
  const logger = deps.logger?.child({ useCase: "setBannerFromUpload" });

  const execute = async () => {
    const input = parseInput(setBannerFromUploadInputSchema, rawInput);
    const url = await setProfileImageFromUpload(deps, bannerImageConfig, input, logger);
    return setBannerFromUploadOutputSchema.parse({ bannerUrl: url });
  };

  if (logger) {
    return logger.withTime("setBannerFromUpload", execute);
  }

  return execute();
}
