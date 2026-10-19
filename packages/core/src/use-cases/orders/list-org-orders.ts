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
import {
  orderSortSchema,
  orderSourceSchema,
  orderStatusSchema,
} from "@th/schema";
import type { ListOrdersForOrgItem } from "@th/types";

import { callOrDependencyFailed, parseInput } from "../../lib/io";
import { disputeStatusSchema } from "../disputes/schemas";
import { resolveOrderStatusFilter } from "./_shared/dispute-list-filter";
import { fail } from "@th/errors";

export const listOrgOrdersInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    orgId: z.string().uuid(),
    eventId: z.string().uuid().optional(),
    searchQuery: z.string().max(200).optional(),
    status: orderStatusSchema.optional(),
    occurredAtGte: z.coerce.date().optional(),
    occurredAtLte: z.coerce.date().optional(),
    sort: orderSortSchema.optional(),
  })
  .merge(offsetPaginationInputSchema)
  .strict();

const listOrgOrdersItemSchema = z
  .object({
    id: z.string().uuid(),
    eventId: z.string().uuid(),
    eventTitle: z.string().min(1),
    buyerHumanId: z.string().uuid(),
    buyerName: z.string().nullable(),
    buyerEmail: z.string().email().nullable(),
    amountGrossCents: z.number().int(),
    feesPlatformCents: z.number().int(),
    taxAmountCents: z.number().int(),
    currency: z.string().min(1),
    status: orderStatusSchema,
    stripePaymentIntentId: z.string().nullable(),
    occurredAt: z.coerce.date(),
    source: orderSourceSchema,
    /** Mirror of the order's Dispute row (OPEN / UNDER_REVIEW / LOST / WON / WARNING_*). */
    disputeStatus: disputeStatusSchema.nullable(),
  })
  .strict();

export const listOrgOrdersOutputSchema = offsetPaginatedResultSchema(
  listOrgOrdersItemSchema,
);

export type ListOrgOrdersInput = z.infer<typeof listOrgOrdersInputSchema>;
export type ListOrgOrdersOutput = z.infer<typeof listOrgOrdersOutputSchema>;

export type ListOrgOrdersDeps = {
  repos: Repos;
  authz: AuthZPort;
  logger?: LoggerPort;
};

export async function listOrgOrders(
  deps: ListOrgOrdersDeps,
  rawInput: unknown,
): Promise<ListOrgOrdersOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "listOrgOrders" });

  const execute = async () => {
    const input = parseInput(listOrgOrdersInputSchema, rawInput);

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

    const pagination = sanitizeOffsetPagination({
      limit: input.limit,
      offset: input.offset,
    });

    const result = await callOrDependencyFailed(
      () =>
        deps.repos.orders.listForOrg({
          orgId: input.orgId,
          eventId: input.eventId,
          searchQuery: input.searchQuery,
          ...resolveOrderStatusFilter({ status: input.status }),
          occurredAtGte: input.occurredAtGte,
          occurredAtLte: input.occurredAtLte,
          sort: input.sort,
          limit: pagination.limit,
          offset: pagination.offset,
        }),
      scopedLogger,
      {
        action: "repos.orders.listForOrg",
        orgId: input.orgId,
        actorHumanId: input.actorHumanId,
      },
    );

    const output = buildOffsetPaginatedResult<ListOrdersForOrgItem>({
      items: result.items,
      total: result.total,
      limit: pagination.limit,
      offset: pagination.offset,
    });

    return listOrgOrdersOutputSchema.parse(output);
  };

  if (scopedLogger) {
    return scopedLogger.withTime("listOrgOrders", execute);
  }

  return execute();
}
