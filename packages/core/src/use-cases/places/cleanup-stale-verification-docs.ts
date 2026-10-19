import type { ClockPort } from "@th/ports/clock";
import type { FileStoragePort } from "@th/ports/file-storage";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { incrementResourceUsage } from "../quotas/enforce-quota";
import { z } from "zod";

const DEFAULT_MAX_AGE_DAYS = 30;

export const cleanupStaleVerificationDocsInputSchema = z
  .object({
    /** Max age in days before an un-deleted doc is considered stale. Default 30. */
    maxAgeDays: z.number().int().positive().default(DEFAULT_MAX_AGE_DAYS),
  })
  .strict();

export const cleanupStaleVerificationDocsOutputSchema = z
  .object({
    scanned: z.number().int().nonnegative(),
    deleted: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  })
  .strict();

export type CleanupStaleVerificationDocsInput = z.infer<
  typeof cleanupStaleVerificationDocsInputSchema
>;
export type CleanupStaleVerificationDocsOutput = z.infer<
  typeof cleanupStaleVerificationDocsOutputSchema
>;

export type CleanupStaleVerificationDocsDeps = {
  repos: Pick<
    Repos,
    | "placeVerificationDocuments"
    | "placeVerificationRequests"
    | "resourceQuotas"
  >;
  storage: FileStoragePort;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * Scheduled daily job that catches stale verification documents.
 *
 * Stale = `deletedAt IS NULL` AND either:
 * - The parent request is older than `maxAgeDays`, OR
 * - The parent request has a non-PENDING status (decision was made but
 *   R2 deletion failed or was skipped).
 *
 * For each stale doc: delete from R2, then set `deletedAt` in DB.
 */
export async function cleanupStaleVerificationDocs(
  deps: CleanupStaleVerificationDocsDeps,
  rawInput?: unknown,
): Promise<CleanupStaleVerificationDocsOutput> {
  const logger = deps.logger?.child({
    useCase: "cleanupStaleVerificationDocs",
  });

  const execute = async () => {
    const input = cleanupStaleVerificationDocsInputSchema.parse(rawInput ?? {});

    const staleDocs = await deps.repos.placeVerificationDocuments.listStale({
      maxAgeDays: input.maxAgeDays,
      includeDecided: true,
    });

    logger?.info("stale_verification_docs_found", { count: staleDocs.length });

    let deleted = 0;
    let failed = 0;
    // Accumulate reclaimed bytes per org so we can batch-decrement storage quotas.
    const reclaimedByOrg = new Map<string, bigint>();

    for (const doc of staleDocs) {
      try {
        await deps.storage.deleteObject({ key: doc.storageKey });

        await deps.repos.placeVerificationDocuments.markDeleted({
          requestId: doc.requestId,
          deletedAt: deps.clock.now(),
        });

        deleted++;

        // Track bytes for quota reclamation (resolve orgId from the request).
        const prev = reclaimedByOrg.get(doc.requestId);
        if (prev !== undefined) {
          // Same requestId seen before — just add bytes (orgId already resolved).
          reclaimedByOrg.set(doc.requestId, prev + BigInt(doc.sizeBytes));
        } else {
          reclaimedByOrg.set(doc.requestId, BigInt(doc.sizeBytes));
        }
      } catch (err) {
        failed++;
        logger?.warn("stale_doc_cleanup_failed", {
          documentId: doc.id,
          storageKey: doc.storageKey,
          error: String(err),
        });
      }
    }

    // Reclaim org storage quotas. We group by requestId above, now resolve
    // each requestId → orgId and decrement once per org.
    const orgTotals = new Map<string, bigint>();
    for (const [requestId, bytes] of reclaimedByOrg) {
      try {
        const req =
          await deps.repos.placeVerificationRequests.getById(requestId);
        if (req?.orgId) {
          orgTotals.set(req.orgId, (orgTotals.get(req.orgId) ?? 0n) + bytes);
        }
      } catch {
        // Non-fatal — we just skip the quota reclamation for this request.
      }
    }
    for (const [orgId, bytes] of orgTotals) {
      try {
        await incrementResourceUsage(deps.repos as any, {
          subjectType: "ORG",
          subjectId: orgId,
          kind: "STORAGE_BYTES_ORG",
          delta: -bytes,
        });
      } catch (err) {
        logger?.warn("storage_quota_decrement_failed", {
          orgId,
          bytes: bytes.toString(),
          error: String(err),
        });
      }
    }

    logger?.info("stale_verification_docs_cleanup_done", {
      scanned: staleDocs.length,
      deleted,
      failed,
    });

    return cleanupStaleVerificationDocsOutputSchema.parse({
      scanned: staleDocs.length,
      deleted,
      failed,
    });
  };

  if (logger) {
    return logger.withTime("cleanupStaleVerificationDocs", execute);
  }

  return execute();
}
