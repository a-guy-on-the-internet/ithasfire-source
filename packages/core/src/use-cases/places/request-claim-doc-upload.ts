import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { FileStoragePort } from "@th/ports/file-storage";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { ORG_ADMIN_ROLES } from "../../lib/rbac";
import { enforceQuota, incrementResourceUsage } from "../quotas/enforce-quota";
import {
  assertPlaceClaimable,
  assertPlaceDisputable,
} from "./_shared/claim-eligibility";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { fail } from "@th/errors";

const ALLOWED_CONTENT_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
] as const;
const MAX_DOC_BYTES = 10 * 1024 * 1024; // 10 MB — matches requestVerificationDocUpload

const contentTypeToExtension: Record<
  (typeof ALLOWED_CONTENT_TYPES)[number],
  string
> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
};

/**
 * Input mirrors requestVerificationDocUpload EXACTLY (same presign fields +
 * limits) so the UI swap is a rename, plus a `context` discriminator that
 * selects the claim vs dispute precondition, and an optional `orgId` so an
 * ORG claim/dispute charges the claimant's org storage quota.
 */
export const requestClaimDocUploadInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    placeId: z.string().uuid(),
    contentType: z.enum(ALLOWED_CONTENT_TYPES),
    sizeBytes: z.number().int().positive().max(MAX_DOC_BYTES),
    fileName: z.string().min(1).max(255),
    /** "claim" → place must be CLAIMABLE; "dispute" → place must be already-owned. */
    context: z.enum(["claim", "dispute"]),
    /**
     * When the claim/dispute is filed on behalf of an org, the claimant's org
     * id — used to charge that org's storage quota. Omitted for HUMAN claims
     * (no quota is charged; see note in the body).
     */
    orgId: z.string().uuid().nullable().optional(),
  })
  .strict();

export const requestClaimDocUploadOutputSchema = z
  .object({
    key: z.string().min(1),
    uploadUrl: z.string().url(),
  })
  .strict();

export type RequestClaimDocUploadInput = z.infer<
  typeof requestClaimDocUploadInputSchema
>;
export type RequestClaimDocUploadOutput = z.infer<
  typeof requestClaimDocUploadOutputSchema
>;

export type RequestClaimDocUploadDeps = {
  repos: Pick<
    Repos,
    "places" | "placeVerificationRequests" | "resourceQuotas"
  >;
  authz: Pick<AuthZPort, "hasOrgRole">;
  storage: FileStoragePort;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * Presigns a PUT URL for a claim/dispute proof document to PRIVATE storage.
 *
 * Unlike requestVerificationDocUpload (which gates on canManagePlace — VERIFIED,
 * non-revoked ownership), a CLAIMANT is by definition NOT an owner yet (the claim
 * CTA is only shown on unclaimed venues) and a DISPUTER is contesting someone
 * ELSE's ownership. So auth here is: an authenticated actor + the place being in
 * a valid state for that context (same claimable/disputable predicates the
 * submit/dispute mutations enforce). Files are NEVER public; they are viewed via
 * time-limited signed GET URLs and hard-deleted on decision.
 */
export async function requestClaimDocUpload(
  deps: RequestClaimDocUploadDeps,
  rawInput: unknown,
): Promise<RequestClaimDocUploadOutput> {
  const logger = deps.logger?.child({ useCase: "requestClaimDocUpload" });

  const execute = async () => {
    const input = parseInput(requestClaimDocUploadInputSchema, rawInput);

    // Precondition: the place must be in a valid state for this context. These
    // reuse the exact predicates of submit-place-claim / file-place-ownership-
    // dispute, so a presign can never be obtained for a place you couldn't
    // actually claim/dispute.
    if (input.context === "claim") {
      await assertPlaceClaimable(deps, input.placeId);
    } else {
      await assertPlaceDisputable(deps, input.placeId);
    }

    // Quota: charge the CLAIMANT'S org for an org claim/dispute. For a HUMAN
    // claim we do NOT charge any org (the stub's orgIdsWithAccess is empty and
    // the claimant isn't an owner yet); there is no per-human storage quota
    // concept, and these proof docs are hard-deleted on the review decision, so
    // we deliberately skip quota accounting for human-claim uploads.
    const quotaOrgId = input.orgId ?? null;
    if (quotaOrgId) {
      // SECURITY: charging an org's storage quota is a mutation of THAT org's
      // state — the actor must be an admin of it. Without this gate any authed
      // user could inflate a victim org's STORAGE_BYTES_ORG counter (presign
      // bumps usage regardless of the actual PUT) and DoS its legitimate
      // uploads. Mirrors submit-place-claim's org-claim authorization.
      const perm = await deps.authz.hasOrgRole({
        actorHumanId: input.actorHumanId,
        orgId: quotaOrgId,
        requiredRoles: [...ORG_ADMIN_ROLES],
      });
      if (!perm.allowed) {
        throw fail("INSUFFICIENT_ROLE");
      }
      await enforceQuota(deps.repos as any, {
        subjectType: "ORG",
        subjectId: quotaOrgId,
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
        "th-claim-context": input.context,
      },
      options: {
        expiresSec: 15 * 60,
      },
    });

    if (quotaOrgId) {
      await incrementResourceUsage(deps.repos as any, {
        subjectType: "ORG",
        subjectId: quotaOrgId,
        kind: "STORAGE_BYTES_ORG",
        delta: BigInt(input.sizeBytes),
      });
    }

    return requestClaimDocUploadOutputSchema.parse({ key, uploadUrl });
  };

  if (logger) {
    return logger.withTime("requestClaimDocUpload", execute);
  }
  return execute();
}
