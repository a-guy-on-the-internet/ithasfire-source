/**
 * Request Admin Export
 *
 * Validates the export request and enqueues a background CSV export job.
 * The job will fetch all pages, build the CSV, upload to R2, and create
 * an in-app notification with a time-limited download link.
 *
 * This use case does NOT touch file storage or build any CSV — it only
 * validates permissions and enqueues.
 */
import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Supported export types — each maps 1:1 to a use case + CSV column set
// in the job handler.
// ─────────────────────────────────────────────────────────────────────────────
export const adminExportTypeSchema = z.enum(["org_orders", "org_settlements"]);

export type AdminExportType = z.infer<typeof adminExportTypeSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Input / Output
// ─────────────────────────────────────────────────────────────────────────────
export const requestAdminExportInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    orgId: z.string().uuid(),
    exportType: adminExportTypeSchema,
    /** Optional filters forwarded to the underlying query. */
    filters: z
      .object({
        searchQuery: z.string().max(200).optional(),
        status: z.string().max(50).optional(),
        sort: z.string().max(50).optional(),
      })
      .optional(),
  })
  .strict();

export const requestAdminExportOutputSchema = z.object({
  /** Whether the export job was enqueued. */
  enqueued: z.boolean(),
});

export type RequestAdminExportInput = z.infer<
  typeof requestAdminExportInputSchema
>;
export type RequestAdminExportOutput = z.infer<
  typeof requestAdminExportOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────
export type RequestAdminExportDeps = {
  repos: Repos;
  authz: AuthZPort;
  logger?: LoggerPort;
  /**
   * Enqueue a job on the jobs service.
   * In the API this is typically an HTTP POST to JOBS_SERVICE_URL.
   */
  enqueueJob: (jobName: string, payload: unknown) => Promise<void>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────
export async function requestAdminExport(
  deps: RequestAdminExportDeps,
  rawInput: unknown,
): Promise<RequestAdminExportOutput> {
  const log = deps.logger?.child({ useCase: "requestAdminExport" });

  const input = parseInput(requestAdminExportInputSchema, rawInput);

  // Permission check — same gate used by listOrgOrders / listOrgSettlements
  const permission = await deps.authz.canFinanceOrg({
    actorHumanId: input.actorHumanId,
    orgId: input.orgId,
  });

  if (!permission.allowed) {
    throw fail("FORBIDDEN");
  }

  log?.info("request_admin_export", {
    exportType: input.exportType,
    orgId: input.orgId,
    actorHumanId: input.actorHumanId,
  });

  await deps.enqueueJob("admin.csv-export", {
    actorHumanId: input.actorHumanId,
    orgId: input.orgId,
    exportType: input.exportType,
    filters: input.filters ?? {},
  });

  return { enqueued: true };
}
