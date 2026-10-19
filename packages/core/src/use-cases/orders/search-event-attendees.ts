/**
 * Search Event Attendees
 *
 * Allows event organizers to search for ticket buyers by name or email
 * for a specific event. Uses Postgres ILIKE on the buyer's name and auth email.
 *
 * This avoids the complexity of a dedicated search index — for the scale
 * of orders-per-event (~thousands), a DB query with existing indexes is sufficient.
 */
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
import { orderSourceSchema, orderStatusSchema } from "@th/schema";

import { callOrDependencyFailed, parseInput } from "../../lib/io";
import { ORG_EDIT_OR_FINANCE_ROLES } from "../../lib/rbac";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Input / Output Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const searchEventAttendeesInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    orgId: z.string().uuid(),
    eventId: z.string().uuid(),
    /** Free-text query — matches buyer name or email (ILIKE) */
    query: z.string().max(200).default(""),
    status: orderStatusSchema.optional(),
  })
  .merge(offsetPaginationInputSchema)
  .strict();

const attendeeItemSchema = z
  .object({
    orderId: z.string().uuid(),
    buyerHumanId: z.string().uuid(),
    buyerName: z.string().nullable(),
    buyerEmail: z.string().email().nullable(),
    ticketCount: z.number().int(),
    amountGrossCents: z.number().int(),
    currency: z.string().min(1),
    status: orderStatusSchema,
    // Lets the table badge a COMP. Without it a comp and a genuinely free
    // ticket are both "$0.00 SUCCEEDED" and indistinguishable.
    source: orderSourceSchema,
    occurredAt: z.coerce.date(),
  })
  .strict();

export const searchEventAttendeesOutputSchema =
  offsetPaginatedResultSchema(attendeeItemSchema);

export type SearchEventAttendeesInput = z.infer<
  typeof searchEventAttendeesInputSchema
>;
export type SearchEventAttendeesOutput = z.infer<
  typeof searchEventAttendeesOutputSchema
>;

export type SearchEventAttendeesDeps = {
  repos: Repos;
  authz: AuthZPort;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

export async function searchEventAttendees(
  deps: SearchEventAttendeesDeps,
  rawInput: unknown,
): Promise<SearchEventAttendeesOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "searchEventAttendees" });

  const execute = async () => {
    const input = parseInput(searchEventAttendeesInputSchema, rawInput);

    // Edit OR finance. This was `canFinanceOrg` (OWNER/ADMIN/FINANCE), which
    // locked EDITOR out of the door list for their own event while the admin
    // rail still offered them the link — they routed straight into a 403.
    // Reading who is coming is part of running the event, so the read follows
    // ORG_EDIT_OR_FINANCE_ROLES. Bulk EGRESS is the narrower right and stays
    // finance-only: see the CSV export use case, which keeps its own
    // ORG_FINANCE_ROLES gate rather than inheriting this one.
    const permission = await callOrDependencyFailed(
      () =>
        deps.authz.hasOrgRole({
          actorHumanId: input.actorHumanId,
          orgId: input.orgId,
          requiredRoles: [...ORG_EDIT_OR_FINANCE_ROLES],
        }),
      scopedLogger,
      {
        action: "authz.hasOrgRole",
        orgId: input.orgId,
        actorHumanId: input.actorHumanId,
      },
    );

    if (!permission.allowed) {
      throw fail("FORBIDDEN");
    }

    const pagination = sanitizeOffsetPagination({
      limit: input.limit,
      offset: input.offset,
    });

    const result = await callOrDependencyFailed(
      () =>
        deps.repos.orders.searchEventAttendees({
          orgId: input.orgId,
          eventId: input.eventId,
          searchQuery: input.query || undefined,
          status: input.status,
          limit: pagination.limit,
          offset: pagination.offset,
        }),
      scopedLogger,
      {
        action: "repos.orders.searchEventAttendees",
        orgId: input.orgId,
        eventId: input.eventId,
      },
    );

    const output = buildOffsetPaginatedResult({
      items: result.items,
      total: result.total,
      limit: pagination.limit,
      offset: pagination.offset,
    });

    return searchEventAttendeesOutputSchema.parse(output);
  };

  if (scopedLogger) {
    return scopedLogger.withTime("searchEventAttendees", execute);
  }

  return execute();
}
