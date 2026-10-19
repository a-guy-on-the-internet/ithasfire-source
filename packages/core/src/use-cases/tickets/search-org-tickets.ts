/**
 * Search Org Tickets
 *
 * Allows org members with scan permissions to search tickets across all org
 * events by attendee name or email. Designed for the door-scan workflow where
 * the scanner looks up a person and picks the relevant ticket to scan.
 *
 * Re-uses the existing `repos.tickets.listAll` adapter which already supports
 * orgId + searchQuery filtering with Postgres ILIKE.
 */
import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import {
  buildOffsetPaginatedResult,
  offsetPaginatedResultSchema,
  offsetPaginationInputSchema,
  sanitizeOffsetPagination,
} from "@th/ports/pagination";
import { ticketStatusSchema } from "@th/schema";

import { callOrDependencyFailed, parseInput } from "../../lib/io";
import { requireOrgMembership, ORG_SCAN_ROLES } from "../../lib/rbac";

// ─────────────────────────────────────────────────────────────────────────────
// Input / Output Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const searchOrgTicketsInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    orgId: z.string().uuid(),
    /** Free-text query — matches owner name, email, or ticket code (ILIKE) */
    query: z.string().min(2).max(200),
    /** Optional status filter — defaults to showing VALID + SCANNED */
    statuses: z.array(ticketStatusSchema).optional(),
  })
  .merge(offsetPaginationInputSchema)
  .strict();

const searchOrgTicketsItemSchema = z
  .object({
    ticketId: z.string().uuid(),
    ticketCode: z.string().min(1),
    status: ticketStatusSchema,
    eventId: z.string().uuid(),
    eventTitle: z.string().min(1),
    ticketTypeName: z.string().nullable(),
    ownerHumanId: z.string().uuid(),
    ownerName: z.string().nullable(),
    ownerEmail: z.string().nullable(),
    issuedAt: z.coerce.date(),
    scannedAt: z.coerce.date().nullable(),
    seatLabel: z.string().nullable(),
  })
  .strict();

export const searchOrgTicketsOutputSchema = offsetPaginatedResultSchema(
  searchOrgTicketsItemSchema,
);

export type SearchOrgTicketsInput = z.infer<typeof searchOrgTicketsInputSchema>;
export type SearchOrgTicketsOutput = z.infer<
  typeof searchOrgTicketsOutputSchema
>;

export type SearchOrgTicketsDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

export async function searchOrgTickets(
  deps: SearchOrgTicketsDeps,
  rawInput: unknown,
): Promise<SearchOrgTicketsOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "searchOrgTickets" });

  const execute = async () => {
    const input = parseInput(searchOrgTicketsInputSchema, rawInput);

    // RBAC: must have a scan-capable role in this org
    await requireOrgMembership({
      repos: deps.repos,
      orgId: input.orgId,
      actorHumanId: input.actorHumanId,
      roles: ORG_SCAN_ROLES,
    });

    const pagination = sanitizeOffsetPagination({
      limit: input.limit,
      offset: input.offset,
    });

    // Default to VALID + SCANNED when no explicit filter (most useful for scan flow)
    const statuses = input.statuses?.length
      ? input.statuses
      : (["VALID", "SCANNED"] as const);

    const result = await callOrDependencyFailed(
      () =>
        deps.repos.tickets.listAll({
          orgId: input.orgId,
          searchQuery: input.query,
          statuses: [...statuses],
          sort: "issuedAt_desc",
          limit: pagination.limit,
          offset: pagination.offset,
        }),
      scopedLogger,
      {
        action: "repos.tickets.listAll",
        orgId: input.orgId,
      },
    );

    const items = result.items.map((item) => ({
      ticketId: item.id,
      ticketCode: item.code,
      status: item.status,
      eventId: item.eventId,
      eventTitle: item.eventTitle,
      ticketTypeName: item.ticketTypeName,
      ownerHumanId: item.ownerHumanId,
      ownerName: item.ownerName,
      ownerEmail: item.ownerEmail,
      issuedAt: item.issuedAt,
      scannedAt: item.scannedAt,
      seatLabel: item.seatLabel,
    }));

    const output = buildOffsetPaginatedResult({
      items,
      total: result.total,
      limit: pagination.limit,
      offset: pagination.offset,
    });

    return searchOrgTicketsOutputSchema.parse(output);
  };

  if (scopedLogger) {
    return scopedLogger.withTime("searchOrgTickets", execute);
  }

  return execute();
}
