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
import type { ListSettlementsForOrgItem } from "@th/types";

import { callOrDependencyFailed, parseInput } from "../../lib/io";
import { fail } from "@th/errors";

const settlementStatusSchema = z.enum(["pending", "transferred", "failed"]);

export const listOrgSettlementsInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    orgId: z.string().uuid(),
    status: settlementStatusSchema.optional(),
    scheduledPayoutDateGte: z.coerce.date().optional(),
    scheduledPayoutDateLte: z.coerce.date().optional(),
  })
  .merge(offsetPaginationInputSchema)
  .strict();

const listOrgSettlementsItemSchema = z
  .object({
    id: z.string().uuid(),
    payeeId: z.string().uuid(),
    date: z.coerce.date(),
    scheduledPayoutDate: z.coerce.date(),
    amountCents: z.number().int(),
    currency: z.string().min(1),
    status: z.string(),
    stripeTransferId: z.string().nullable(),
    eventId: z.string().uuid().nullable(),
    eventTitle: z.string().nullable(),
    lineCount: z.number().int().nonnegative(),
    createdAt: z.coerce.date(),
  })
  .strict();

export const listOrgSettlementsOutputSchema = offsetPaginatedResultSchema(
  listOrgSettlementsItemSchema,
);

export type ListOrgSettlementsInput = z.infer<
  typeof listOrgSettlementsInputSchema
>;
export type ListOrgSettlementsOutput = z.infer<
  typeof listOrgSettlementsOutputSchema
>;

export type ListOrgSettlementsDeps = {
  repos: Repos;
  authz: AuthZPort;
  logger?: LoggerPort;
};

export async function listOrgSettlements(
  deps: ListOrgSettlementsDeps,
  rawInput: unknown,
): Promise<ListOrgSettlementsOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "listOrgSettlements" });

  const execute = async () => {
    const input = parseInput(listOrgSettlementsInputSchema, rawInput);

    const permission = await callOrDependencyFailed(
      () =>
        deps.authz.canFinanceOrg({
          actorHumanId: input.actorHumanId,
          orgId: input.orgId,
        }),
      scopedLogger,
      {
        action: "authz.canFinanceOrg",
        orgId: input.orgId,
        actorHumanId: input.actorHumanId,
      },
    );

    if (!permission.allowed) {
      throw fail("FORBIDDEN");
    }

    // Resolve the org's payee id
    const payee = await callOrDependencyFailed(
      () =>
        deps.repos.payees.getBySubject({
          type: "ORGANIZATION",
          id: input.orgId,
        }),
      scopedLogger,
      { action: "repos.payees.getBySubject", orgId: input.orgId },
    );

    if (!payee) {
      // Org has no payee yet — return empty list
      return listOrgSettlementsOutputSchema.parse(
        buildOffsetPaginatedResult<ListSettlementsForOrgItem>({
          items: [],
          total: 0,
          limit: input.limit ?? 25,
          offset: input.offset ?? 0,
        }),
      );
    }

    const pagination = sanitizeOffsetPagination({
      limit: input.limit,
      offset: input.offset,
    });

    const result = await callOrDependencyFailed(
      () =>
        deps.repos.settlements.listForOrg({
          payeeId: payee.id,
          status: input.status,
          scheduledPayoutDateGte: input.scheduledPayoutDateGte,
          scheduledPayoutDateLte: input.scheduledPayoutDateLte,
          limit: pagination.limit,
          offset: pagination.offset,
        }),
      scopedLogger,
      { action: "repos.settlements.listForOrg", orgId: input.orgId },
    );

    const output = buildOffsetPaginatedResult<ListSettlementsForOrgItem>({
      items: result.items,
      total: result.total,
      limit: pagination.limit,
      offset: pagination.offset,
    });

    return listOrgSettlementsOutputSchema.parse(output);
  };

  if (scopedLogger) {
    return scopedLogger.withTime("listOrgSettlements", execute);
  }

  return execute();
}
