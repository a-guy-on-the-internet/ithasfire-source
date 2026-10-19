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
import type { ListAllSettlementsItem } from "@th/types";

import { callOrDependencyFailed, parseInput } from "../../lib/io";
import { fail } from "@th/errors";

const PLATFORM_STAFF_ROLES = [
  "ADMIN",
  "REVIEWER",
  "SUPPORT",
  "DEVELOPER",
] as const;

const settlementStatusSchema = z.enum(["pending", "transferred", "failed"]);

export const listAllSettlementsInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    status: settlementStatusSchema.optional(),
    scheduledPayoutDateGte: z.coerce.date().optional(),
    scheduledPayoutDateLte: z.coerce.date().optional(),
    searchQuery: z.string().max(200).optional(),
  })
  .merge(offsetPaginationInputSchema)
  .strict();

const listAllSettlementsItemSchema = z
  .object({
    id: z.string().uuid(),
    payeeId: z.string().uuid(),
    payeeSubjectType: z.string(),
    payeeSubjectId: z.string(),
    payeeLabel: z.string().nullable(),
    date: z.coerce.date(),
    scheduledPayoutDate: z.coerce.date(),
    amountCents: z.number().int(),
    currency: z.string().min(1),
    status: z.string(),
    stripeTransferId: z.string().nullable(),
    stripePaymentIntentIds: z.array(z.string()),
    eventId: z.string().uuid().nullable(),
    eventTitle: z.string().nullable(),
    lineCount: z.number().int().nonnegative(),
    createdAt: z.coerce.date(),
  })
  .strict();

export const listAllSettlementsOutputSchema = offsetPaginatedResultSchema(
  listAllSettlementsItemSchema,
);

export type ListAllSettlementsInput = z.infer<
  typeof listAllSettlementsInputSchema
>;
export type ListAllSettlementsOutput = z.infer<
  typeof listAllSettlementsOutputSchema
>;

export type ListAllSettlementsDeps = {
  repos: Repos;
  authz: AuthZPort;
  logger?: LoggerPort;
};

export async function listAllSettlements(
  deps: ListAllSettlementsDeps,
  rawInput: unknown,
): Promise<ListAllSettlementsOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "listAllSettlements" });

  const execute = async () => {
    const input = parseInput(listAllSettlementsInputSchema, rawInput);

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
        deps.repos.settlements.listAll({
          status: input.status,
          scheduledPayoutDateGte: input.scheduledPayoutDateGte,
          scheduledPayoutDateLte: input.scheduledPayoutDateLte,
          searchQuery: input.searchQuery,
          limit: pagination.limit,
          offset: pagination.offset,
        }),
      scopedLogger,
      { action: "repos.settlements.listAll", actorHumanId: input.actorHumanId },
    );

    const output = buildOffsetPaginatedResult<ListAllSettlementsItem>({
      items: result.items,
      total: result.total,
      limit: pagination.limit,
      offset: pagination.offset,
    });

    return listAllSettlementsOutputSchema.parse(output);
  };

  if (scopedLogger) {
    return scopedLogger.withTime("listAllSettlements", execute);
  }

  return execute();
}
