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
import { ticketSortSchema, ticketStatusSchema } from "@th/schema";
import type { ListPlatformTicketsItem } from "@th/types";

import { callOrDependencyFailed, parseInput } from "../../lib/io";
import { fail } from "@th/errors";

const PLATFORM_STAFF_ROLES = [
  "ADMIN",
  "REVIEWER",
  "SUPPORT",
  "DEVELOPER",
] as const;

export const listPlatformTicketsInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    searchQuery: z.string().max(200).optional(),
    status: ticketStatusSchema.optional(),
    statuses: z.array(ticketStatusSchema).optional(),
    eventId: z.string().uuid().optional(),
    orgId: z.string().uuid().optional(),
    sort: ticketSortSchema.optional(),
  })
  .merge(offsetPaginationInputSchema)
  .strict();

const listPlatformTicketsItemSchema = z
  .object({
    id: z.string().uuid(),
    code: z.string().min(1),
    status: ticketStatusSchema,
    eventId: z.string().uuid(),
    eventTitle: z.string().min(1),
    ticketTypeId: z.string().uuid().nullable(),
    ticketTypeName: z.string().nullable(),
    orderId: z.string().uuid().nullable(),
    ownerHumanId: z.string().uuid(),
    ownerName: z.string().nullable(),
    ownerEmail: z.string().email().nullable(),
    issuedAt: z.coerce.date(),
    scannedAt: z.coerce.date().nullable(),
    seatLabel: z.string().nullable(),
    transferCount: z.number().int().nonnegative(),
    scanCount: z.number().int().nonnegative(),
  })
  .strict();

export const listPlatformTicketsOutputSchema = offsetPaginatedResultSchema(
  listPlatformTicketsItemSchema,
);

export type ListPlatformTicketsInput = z.infer<
  typeof listPlatformTicketsInputSchema
>;
export type ListPlatformTicketsOutput = z.infer<
  typeof listPlatformTicketsOutputSchema
>;

export type ListPlatformTicketsDeps = {
  repos: Repos;
  authz: AuthZPort;
  logger?: LoggerPort;
};

export async function listPlatformTickets(
  deps: ListPlatformTicketsDeps,
  rawInput: unknown,
): Promise<ListPlatformTicketsOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "listPlatformTickets" });

  const execute = async () => {
    const input = parseInput(listPlatformTicketsInputSchema, rawInput);

    const staffCheck = await callOrDependencyFailed(
      () =>
        deps.authz.hasStaffRole({
          actorHumanId: input.actorHumanId,
          requiredRoles: [...PLATFORM_STAFF_ROLES],
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
        deps.repos.tickets.listAll({
          searchQuery: input.searchQuery,
          status: input.status,
          statuses: input.statuses,
          eventId: input.eventId,
          orgId: input.orgId,
          sort: input.sort,
          limit: pagination.limit,
          offset: pagination.offset,
        }),
      scopedLogger,
      { action: "repos.tickets.listAll", actorHumanId: input.actorHumanId },
    );

    const output = buildOffsetPaginatedResult<ListPlatformTicketsItem>({
      items: result.items,
      total: result.total,
      limit: pagination.limit,
      offset: pagination.offset,
    });

    return listPlatformTicketsOutputSchema.parse(output);
  };

  if (scopedLogger) {
    return scopedLogger.withTime("listPlatformTickets", execute);
  }

  return execute();
}
