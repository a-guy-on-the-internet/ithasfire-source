import { z } from "zod";
import { randomUUID } from "node:crypto";

import type { AuthZPort } from "@th/ports/authz";
import type { FileStoragePort } from "@th/ports/file-storage";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { enforceQuota, incrementResourceUsage } from "../quotas/enforce-quota";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Input / Output Schemas
// ─────────────────────────────────────────────────────────────────────────────

/** Hard cap for a raw layout CSV (enforced again before parsing). */
export const MAX_PLACE_LAYOUT_CSV_BYTES = 5 * 1024 * 1024;

export const requestPlaceLayoutUploadInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    placeId: z.string().uuid(),
    /** Content-Type — only text/csv is accepted for now. */
    contentType: z.literal("text/csv"),
    /** Declared payload size in bytes. Max 5 MB. */
    sizeBytes: z
      .number()
      .int()
      .positive()
      .max(MAX_PLACE_LAYOUT_CSV_BYTES, "file_too_large"),
  })
  .strict();

export const requestPlaceLayoutUploadOutputSchema = z
  .object({
    /** Storage key the client must pass as `upload.ref` to replacePlaceLayout. */
    key: z.string().min(1),
    /** Presigned URL the client can PUT bytes to. */
    uploadUrl: z.string().min(1),
  })
  .strict();

export type RequestPlaceLayoutUploadInput = z.infer<
  typeof requestPlaceLayoutUploadInputSchema
>;
export type RequestPlaceLayoutUploadOutput = z.infer<
  typeof requestPlaceLayoutUploadOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────

export type RequestPlaceLayoutUploadDeps = {
  repos: Pick<Repos, "places" | "authz" | "resourceQuotas">;
  authz: Pick<AuthZPort, "canManagePlace">;
  storage: FileStoragePort;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Presigns a PUT URL for uploading a place-layout CSV to private object
 * storage. The returned `key` is then passed as `upload.ref` to the
 * `replacePlaceLayout` use case.
 *
 * Gated by `canManagePlace` — requires OWNER/ADMIN role on the place's org.
 */
export async function requestPlaceLayoutUpload(
  deps: RequestPlaceLayoutUploadDeps,
  rawInput: unknown,
): Promise<RequestPlaceLayoutUploadOutput> {
  const logger = deps.logger?.child({ useCase: "requestPlaceLayoutUpload" });

  const execute = async () => {
    const input = parseInput(requestPlaceLayoutUploadInputSchema, rawInput);

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

    // Enforce storage quota for the place's org
    const placeOrgId = place.orgIdsWithAccess[0];
    if (placeOrgId) {
      await enforceQuota(deps.repos as any, {
        subjectType: "ORG",
        subjectId: placeOrgId,
        kind: "STORAGE_BYTES_ORG",
        delta: BigInt(input.sizeBytes),
      });
    }

    const key = `place-layouts/raw/${input.placeId}/${randomUUID()}.csv`;

    const { uploadUrl } = await deps.storage.presignPutObject({
      key,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      public: false,
      metadata: {
        "th-kind": "place-layout-csv",
        "th-place-id": input.placeId,
        "th-actor-human-id": input.actorHumanId,
      },
      options: {
        expiresSec: 15 * 60, // 15 minutes to complete upload
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

    return requestPlaceLayoutUploadOutputSchema.parse({ key, uploadUrl });
  };

  if (logger) {
    return logger.withTime("requestPlaceLayoutUpload", execute);
  }

  return execute();
}
