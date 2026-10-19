import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import {
  buildOffsetPaginatedResult,
  offsetPaginatedResultSchema,
  offsetPaginationInputSchema,
  sanitizeOffsetPagination,
} from "@th/ports/pagination";
import type { AuditLogListItem } from "@th/types";

import { callOrDependencyFailed, parseInput } from "../../lib/io";
import { fail } from "@th/errors";

/**
 * Read-only platform-wide audit-log viewer (`/platform/audit-log`). Distinct
 * from the org-scoped `/admin/[slug]/activity` surface described in
 * `docs/specs/2026-03-03/audit-log-viewer.md` — that spec is out of scope
 * here.
 *
 * RBAC: ADMIN + REVIEWER. Reviewing the audit trail is core to a REVIEWER's
 * job, and this surface is strictly read-only (no mutation risk), which is
 * lower-risk than the ADMIN-only /platform/roles grant/revoke surface. Wider
 * than that, but narrower than the general STAFF_ALL/STAFF_CUSTOMER sets
 * used for customer-data panels — audit rows aren't customer-support data.
 */
const AUDIT_LOG_STAFF_ROLES = ["ADMIN", "REVIEWER"] as const;

export const listAuditLogsInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    /** Contains-style, case-insensitive filter on `entity` (free-text, no enum). */
    entity: z.string().trim().min(1).max(200).optional(),
    /** Contains-style, case-insensitive filter on `action` (free-text, no enum). */
    action: z.string().trim().min(1).max(200).optional(),
    /** Exact-match filter on `entityId`. */
    entityId: z.string().min(1).max(200).optional(),
    /**
     * Filters on `data.actorHumanId` (the human who performed the audited
     * action) — NOT the requesting staff actor above. See
     * `ListAuditLogsInput`'s doc comment for the JSON-path-filter caveat.
     */
    humanId: z.string().uuid().optional(),
    atGte: z.coerce.date().optional(),
    atLte: z.coerce.date().optional(),
    sort: z.enum(["at_desc", "at_asc"]).optional(),
  })
  .merge(offsetPaginationInputSchema)
  .strict();

const auditLogListItemSchema = z
  .object({
    id: z.string().uuid(),
    entity: z.string(),
    entityId: z.string().nullable(),
    action: z.string(),
    data: z.unknown(),
    actorHumanId: z.string().nullable(),
    at: z.coerce.date(),
  })
  .strict();

export const listAuditLogsOutputSchema = offsetPaginatedResultSchema(
  auditLogListItemSchema,
);

export type ListAuditLogsInput = z.infer<typeof listAuditLogsInputSchema>;
export type ListAuditLogsOutput = z.infer<typeof listAuditLogsOutputSchema>;

export type ListAuditLogsDeps = {
  repos: Pick<Repos, "audit">;
  authz: Pick<AuthZPort, "hasStaffRole">;
  logger?: LoggerPort;
};

export async function listAuditLogs(
  deps: ListAuditLogsDeps,
  rawInput: unknown,
): Promise<ListAuditLogsOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "listAuditLogs" });

  const execute = async () => {
    const input = parseInput(listAuditLogsInputSchema, rawInput);

    const staffCheck = await callOrDependencyFailed(
      () =>
        deps.authz.hasStaffRole({
          actorHumanId: input.actorHumanId,
          requiredRoles: [...AUDIT_LOG_STAFF_ROLES],
        }),
      scopedLogger,
      { action: "authz.hasStaffRole", actorHumanId: input.actorHumanId },
    );

    if (!staffCheck.allowed) {
      throw fail("FORBIDDEN");
    }

    const pagination = sanitizeOffsetPagination({
      limit: input.limit,
      offset: input.offset,
    });

    const result = await callOrDependencyFailed(
      () =>
        deps.repos.audit.list({
          entity: input.entity,
          action: input.action,
          entityId: input.entityId,
          actorHumanId: input.humanId,
          atGte: input.atGte,
          atLte: input.atLte,
          sort: input.sort,
          limit: pagination.limit,
          offset: pagination.offset,
        }),
      scopedLogger,
      { action: "repos.audit.list", actorHumanId: input.actorHumanId },
    );

    const output = buildOffsetPaginatedResult<AuditLogListItem>({
      items: result.items,
      total: result.total,
      limit: pagination.limit,
      offset: pagination.offset,
    });

    return listAuditLogsOutputSchema.parse(output);
  };

  if (scopedLogger) {
    return scopedLogger.withTime("listAuditLogs", execute);
  }

  return execute();
}
