import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { FileStoragePort } from "@th/ports/file-storage";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { enforceQuota, incrementResourceUsage } from "../quotas/enforce-quota";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { fail } from "@th/errors";

const ALLOWED_CONTENT_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
] as const;
const MAX_DOC_BYTES = 10 * 1024 * 1024; // 10 MB

const contentTypeToExtension: Record<
  (typeof ALLOWED_CONTENT_TYPES)[number],
  string
> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
};

export const requestVerificationDocUploadInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    placeId: z.string().uuid(),
    contentType: z.enum(ALLOWED_CONTENT_TYPES),
    sizeBytes: z.number().int().positive().max(MAX_DOC_BYTES),
    fileName: z.string().min(1).max(255),
  })
  .strict();

export const requestVerificationDocUploadOutputSchema = z
  .object({
    key: z.string().min(1),
    uploadUrl: z.string().url(),
  })
  .strict();

export type RequestVerificationDocUploadInput = z.infer<
  typeof requestVerificationDocUploadInputSchema
>;
export type RequestVerificationDocUploadOutput = z.infer<
  typeof requestVerificationDocUploadOutputSchema
>;

export type RequestVerificationDocUploadDeps = {
  repos: Pick<Repos, "places" | "authz" | "resourceQuotas">;
  authz: Pick<AuthZPort, "canManagePlace">;
  storage: FileStoragePort;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * Presigns a PUT URL for uploading a verification document to private storage.
 *
 * Gated by canManagePlace (org OWNER/ADMIN for the place's org).
 * Files are NEVER public — they are viewed via time-limited signed GET URLs.
 */
export async function requestVerificationDocUpload(
  deps: RequestVerificationDocUploadDeps,
  rawInput: unknown,
): Promise<RequestVerificationDocUploadOutput> {
  const logger = deps.logger?.child({
    useCase: "requestVerificationDocUpload",
  });

  const execute = async () => {
    const input = parseInput(requestVerificationDocUploadInputSchema, rawInput);

    // Verify the place exists
    const place = await deps.repos.places.getById(input.placeId);
    if (!place) {
      throw fail("PLACE_NOT_FOUND");
    }

    // Verify the actor can manage this place
    const perm = await deps.authz.canManagePlace({
      actorHumanId: input.actorHumanId,
      placeId: input.placeId,
    });
    if (!perm.allowed) {
      throw fail("INSUFFICIENT_ROLE");
    }

    // Enforce storage quota for the place's org (use first linked org)
    const placeOrgId = place.orgIdsWithAccess[0];
    if (placeOrgId) {
      await enforceQuota(deps.repos as any, {
        subjectType: "ORG",
        subjectId: placeOrgId,
        kind: "STORAGE_BYTES_ORG",
        delta: BigInt(input.sizeBytes),
      });
    }

    const ext = contentTypeToExtension[input.contentType];
    const key = `place-verification/${input.placeId}/${randomUUID()}.${ext}`;

    const { uploadUrl } = await deps.storage.presignPutObject({
      key,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      public: false,
      metadata: {
        "th-kind": "place-verification-doc",
        "th-place-id": input.placeId,
        "th-actor-human-id": input.actorHumanId,
      },
      options: {
        expiresSec: 15 * 60,
      },
    });

    // Increment storage usage
    if (placeOrgId) {
      await incrementResourceUsage(deps.repos as any, {
        subjectType: "ORG",
        subjectId: placeOrgId,
        kind: "STORAGE_BYTES_ORG",
        delta: BigInt(input.sizeBytes),
      });
    }

    return requestVerificationDocUploadOutputSchema.parse({
      key,
      uploadUrl,
    });
  };

  if (logger) {
    return logger.withTime("requestVerificationDocUpload", execute);
  }

  return execute();
}
