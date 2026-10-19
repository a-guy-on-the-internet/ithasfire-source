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
import type { ListOrdersForHumanOwnedEventsItem } from "@th/types";

import { callOrDependencyFailed, parseInput } from "../../lib/io";
import { disputeStatusSchema } from "../disputes/schemas";
import { resolveOrderStatusFilter } from "./_shared/dispute-list-filter";

export const listMyEventOrdersInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    eventId: z.string().uuid().optional(),
    orgId: z.string().uuid().optional(),
    searchQuery: z.string().max(200).optional(),
    status: orderStatusSchema.optional(),
    occurredAtGte: z.coerce.date().optional(),
    occurredAtLte: z.coerce.date().optional(),
    sort: orderSortSchema.optional(),
  })
  .merge(offsetPaginationInputSchema)
  .strict();

const listMyEventOrdersItemSchema = z
  .object({
    id: z.string().uuid(),
    eventId: z.string().uuid(),
    eventTitle: z.string().min(1),
    orgId: z.string().uuid().nullable(),
    buyerHumanId: z.string().uuid(),
    buyerName: z.string().nullable(),
    buyerEmail: z.string().email().nullable(),
    amountGrossCents: z.number().int(),
    feesPlatformCents: z.number().int(),
    taxAmountCents: z.number().int(),
    currency: z.string().min(1),
    status: orderStatusSchema,
    source: orderSourceSchema,
    stripePaymentIntentId: z.string().nullable(),
    occurredAt: z.coerce.date(),
    /** Mirror of the order's Dispute row (OPEN / UNDER_REVIEW / LOST / WON / WARNING_*). */
    disputeStatus: disputeStatusSchema.nullable(),
  })
  .strict();

export const listMyEventOrdersOutputSchema = offsetPaginatedResultSchema(
  listMyEventOrdersItemSchema,
);

export type ListMyEventOrdersInput = z.infer<
  typeof listMyEventOrdersInputSchema
>;
export type ListMyEventOrdersOutput = z.infer<
  typeof listMyEventOrdersOutputSchema
>;

export type ListMyEventOrdersDeps = {
  repos: Repos;
  authz: AuthZPort;
  logger?: LoggerPort;
};

export async function listMyEventOrders(
  deps: ListMyEventOrdersDeps,
  rawInput: unknown,
): Promise<ListMyEventOrdersOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "listMyEventOrders" });

  const execute = async () => {
    const input = parseInput(listMyEventOrdersInputSchema, rawInput);

    // We intentionally *don't* use AuthZPort here. The rule is: orders are visible to the
    // event owner (Event.humanId === actorHumanId), optionally scoped further by orgId/eventId.
    // This use-case is useful for solo organizers who own events directly.

    const pagination = sanitizeOffsetPagination({
      limit: input.limit,
      offset: input.offset,
    });

    const result = await callOrDependencyFailed(
      () =>
        deps.repos.orders.listForHumanOwnedEvents({
          ownerHumanId: input.actorHumanId,
          eventId: input.eventId,
          orgId: input.orgId,
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
        action: "repos.orders.listForHumanOwnedEvents",
        ownerHumanId: input.actorHumanId,
      },
    );

    const output =
      buildOffsetPaginatedResult<ListOrdersForHumanOwnedEventsItem>({
        items: result.items,
        total: result.total,
        limit: pagination.limit,
        offset: pagination.offset,
      });

    return listMyEventOrdersOutputSchema.parse(output);
  };

  if (scopedLogger) {
    return scopedLogger.withTime("listMyEventOrders", execute);
  }

  return execute();
}
