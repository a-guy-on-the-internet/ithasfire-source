import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { FileStoragePort } from "@th/ports/file-storage";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { PlaceLayoutStreamingPort } from "@th/ports/place-layouts";
import type { Repos, TxRepos } from "@th/ports/repos";
import { parseInput } from "../../lib/io";
import { incrementResourceUsage } from "../quotas/enforce-quota";
import { plainTextMultilineOptional } from "../../lib/sanitize-plain-text";
import { fail } from "@th/errors";

export const deletePlaceLayoutInputSchema = z.object({
  placeId: z.string().uuid(),
  actorHumanId: z.string().uuid(),
  reason: plainTextMultilineOptional(500).optional(),
});

export const deletePlaceLayoutOutputSchema = z.object({
  deleted: z.boolean(),
  deletedChecksum: z.string().nullable(),
});

export type DeletePlaceLayoutInput = z.infer<
  typeof deletePlaceLayoutInputSchema
>;
export type DeletePlaceLayoutOutput = z.infer<
  typeof deletePlaceLayoutOutputSchema
>;

export type DeletePlaceLayoutDeps = {
  repos: Repos;
  authz: Pick<AuthZPort, "canManagePlace">;
  streaming: PlaceLayoutStreamingPort;
  storage?: Pick<FileStoragePort, "listObjects" | "deleteObject">;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Reports the swallowed best-effort CSV cleanup failure. */
  reportError?: ReporterPort;
};

export async function deletePlaceLayout(
  deps: DeletePlaceLayoutDeps,
  rawInput: unknown,
): Promise<DeletePlaceLayoutOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "deletePlaceLayout" });

  const execute = async () => {
    const input = parseInput(deletePlaceLayoutInputSchema, rawInput);

    // Same gate as requestPlaceLayoutUpload: only a manager of THIS place may
    // wipe its seat map (security review F2, 2026-09-29).
    const perm = await deps.authz.canManagePlace({
      actorHumanId: input.actorHumanId,
      placeId: input.placeId,
    });
    if (!perm.allowed) {
      throw fail("INSUFFICIENT_ROLE");
    }

    const existing = await deps.repos.placeLayouts.getByPlace(input.placeId);
    if (!existing) {
      return {
        deleted: false,
        deletedChecksum: null,
      } satisfies DeletePlaceLayoutOutput;
    }

    const result = await deps.repos.tx(async (tx) =>
      runDeleteTransaction({
        tx,
        placeId: input.placeId,
        previousChecksum: existing.checksum,
        actorHumanId: input.actorHumanId,
        reason: input.reason ?? null,
        clock: deps.clock,
      }),
    );

    if (result.deleted) {
      await deps.streaming.publishPlaceLayoutReplaced({
        placeId: input.placeId,
        checksum: null,
      });

      // Best-effort: clean up raw CSV objects from R2 and reclaim storage quota.
      await reclaimRawCsvStorage({
        placeId: input.placeId,
        repos: deps.repos,
        storage: deps.storage,
        logger: scopedLogger,
        reportError: deps.reportError,
      });
    }

    return result;
  };

  if (scopedLogger) {
    return scopedLogger.withTime("deletePlaceLayout", execute);
  }

  return execute();
}

async function runDeleteTransaction(params: {
  tx: TxRepos;
  placeId: string;
  previousChecksum: string;
  actorHumanId: string;
  reason: string | null;
  clock: ClockPort;
}): Promise<DeletePlaceLayoutOutput> {
  const { tx, placeId, previousChecksum, actorHumanId, reason, clock } = params;

  await tx.placeLayoutBlobs.deleteForPlace(placeId);
  await tx.placeLayoutStatuses.deleteByPlace(placeId);
  const { deleted } = await tx.placeLayouts.deleteForPlace(placeId);

  if (!deleted) {
    return {
      deleted: false,
      deletedChecksum: null,
    } satisfies DeletePlaceLayoutOutput;
  }

  await tx.audit.log({
    entity: "placeLayout",
    entityId: placeId,
    action: "placeLayout.deleted",
    data: {
      actorHumanId,
      previousChecksum,
      reason,
    },
    at: clock.now(),
  });

  return {
    deleted: true,
    deletedChecksum: previousChecksum,
  } satisfies DeletePlaceLayoutOutput;
}

// ─────────────────────────────────────────────────────────────────────────────
// Raw CSV storage reclamation
// ─────────────────────────────────────────────────────────────────────────────

const RAW_CSV_PREFIX = (placeId: string) => `place-layouts/raw/${placeId}/`;

async function reclaimRawCsvStorage(params: {
  placeId: string;
  repos: Repos;
  storage?: Pick<FileStoragePort, "listObjects" | "deleteObject">;
  logger?: LoggerPort;
  reportError?: ReporterPort;
}): Promise<void> {
  const { placeId, repos, storage, logger, reportError } = params;
  if (!storage) return;

  try {
    // Resolve the place's owning org for quota attribution.
    const place = await repos.places.getById(placeId);
    const orgId = place?.orgIdsWithAccess[0];

    const prefix = RAW_CSV_PREFIX(placeId);
    let cursor: string | undefined;
    let totalBytes = 0n;

    // Paginate through all raw CSV objects for this place.
    do {
      const page = await storage.listObjects({ prefix, cursor, limit: 100 });
      for (const obj of page.keys) {
        try {
          await storage.deleteObject({ key: obj.key });
          if (obj.size) {
            totalBytes += BigInt(obj.size);
          }
        } catch {
          // best-effort per-object cleanup
        }
      }
      cursor = page.nextCursor;
    } while (cursor);

    if (totalBytes > 0n && orgId) {
      await incrementResourceUsage(repos as any, {
        subjectType: "ORG",
        subjectId: orgId,
        kind: "STORAGE_BYTES_ORG",
        delta: -totalBytes,
      });
    }
  } catch (err) {
    logger?.warn("delete_place_layout_csv_cleanup_failed", {
      placeId,
      error: String(err),
    });
    try {
      reportError?.(err, {
        tags: { useCase: "deletePlaceLayout", site: "csv_cleanup" },
        extra: { placeId },
      });
    } catch {
      // Reporting must never change behaviour.
    }
  }
}
