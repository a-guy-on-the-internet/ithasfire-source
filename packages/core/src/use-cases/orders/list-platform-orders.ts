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
import type { ListPlatformOrdersItem } from "@th/types";

import { callOrDependencyFailed, parseInput } from "../../lib/io";
import { resolveOrderStatusFilter } from "./_shared/dispute-list-filter";
import {
  buyerChargeBreakdownSchema,
  computeBuyerChargeBreakdown,
} from "../../lib/orders/buyer-charge-breakdown";
import { fail } from "@th/errors";

const PLATFORM_STAFF_ROLES = [
  "ADMIN",
  "REVIEWER",
  "SUPPORT",
  "DEVELOPER",
] as const;

export const listPlatformOrdersInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    searchQuery: z.string().max(200).optional(),
    status: orderStatusSchema.optional(),
    statuses: z.array(orderStatusSchema).optional(),
    source: orderSourceSchema.optional(),
    orgId: z.string().uuid().optional(),
    eventId: z.string().uuid().optional(),
    /** Buyer filter — scope to orders placed by this Human (Order.buyerHumanId). */
    humanId: z.string().uuid().optional(),
    occurredAtGte: z.coerce.date().optional(),
    occurredAtLte: z.coerce.date().optional(),
    sort: orderSortSchema.optional(),
  })
  .merge(offsetPaginationInputSchema)
  .strict();

const platformOrderItemSummarySchema = z
  .object({
    id: z.string().uuid(),
    // Every OrderItemKind — platform_credit and membership lines exist on real
    // rows; a strict schema that omits them 500s the whole page.
    kind: z.enum(["ticket", "discount", "surcharge", "platform_credit", "membership"]),
    ticketTypeName: z.string().nullable(),
    qty: z.number().int().nonnegative(),
    unitPriceCents: z.number().int(),
    amountCents: z.number().int(),
    status: z.enum(["active", "refunded", "transferred"]),
    paidOutAt: z.coerce.date().nullable(),
    refundedAt: z.coerce.date().nullable(),
    transferredAt: z.coerce.date().nullable(),
    ticketCode: z.string().nullable(),
    ticketScannedAt: z.coerce.date().nullable(),
    seatId: z.string().nullable(),
    ticketOwnerName: z.string().nullable(),
  })
  .strict();

const listPlatformOrdersItemSchema = z
  .object({
    id: z.string().uuid(),
    // The adapter has emitted the order kind since 656de00f; the strict
    // schema never declared it, so every platform list call failed output
    // validation with unrecognized_keys ["kind"].
    kind: z.enum(["TICKETING", "MEMBERSHIP"]),
    // Null for MEMBERSHIP orders (no event) — the adapter emits null there
    // and the DTO type has always allowed it; the schema did not.
    eventId: z.string().uuid().nullable(),
    eventTitle: z.string().min(1).nullable(),
    orgId: z.string().uuid().nullable(),
    orgName: z.string().nullable(),
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
    paymentMethodType: z.string().nullable(),
    occurredAt: z.coerce.date(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
    itemCount: z.number().int().nonnegative(),
    feePolicySnapshot: z.unknown(),
    billingCountry: z.string().max(2).nullable(),
    billingAddress: z
      .object({
        line1: z.string().nullable(),
        line2: z.string().nullable(),
        city: z.string().nullable(),
        state: z.string().nullable(),
        postalCode: z.string().nullable(),
        country: z.string().nullable(),
      })
      .nullable(),
    stripeTaxCalculationId: z.string().nullable(),
    parentOrderId: z.string().uuid().nullable(),
    /**
     * The discount attributed to this order. `code` is NULL for a
     * membership-sourced one — a benefit has no code, and the ledger's
     * internal `benefit:{id}` marker is not something an operator could type
     * or search. Consumers must branch on `source` rather than rendering
     * `code` directly, or a member discount shows as a blank field.
     */
    promo: z
      .object({
        source: z.enum(["code", "membership"]),
        code: z.string().nullable(),
        amountDiscountCents: z.number().int(),
      })
      .nullable(),
    items: z.array(platformOrderItemSummarySchema),
    /**
     * What the buyer was charged, as lines that sum to `totalCents`
     * (`computeBuyerChargeBreakdown`). `feesPlatformCents` above is the
     * RECORDED fee, which under ABSORB the organiser paid, not the buyer.
     */
    charges: buyerChargeBreakdownSchema,
  })
  .strict();

export const listPlatformOrdersOutputSchema = offsetPaginatedResultSchema(
  listPlatformOrdersItemSchema,
);

export type ListPlatformOrdersInput = z.infer<
  typeof listPlatformOrdersInputSchema
>;
export type ListPlatformOrdersOutput = z.infer<
  typeof listPlatformOrdersOutputSchema
>;

export type ListPlatformOrdersDeps = {
  repos: Repos;
  authz: AuthZPort;
  logger?: LoggerPort;
};

export async function listPlatformOrders(
  deps: ListPlatformOrdersDeps,
  rawInput: unknown,
): Promise<ListPlatformOrdersOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "listPlatformOrders" });

  const execute = async () => {
    const input = parseInput(listPlatformOrdersInputSchema, rawInput);

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
        deps.repos.orders.listAll({
          searchQuery: input.searchQuery,
          ...resolveOrderStatusFilter({
            status: input.status,
            statuses: input.statuses,
          }),
          source: input.source,
          orgId: input.orgId,
          eventId: input.eventId,
          buyerHumanId: input.humanId,
          occurredAtGte: input.occurredAtGte,
          occurredAtLte: input.occurredAtLte,
          sort: input.sort,
          limit: pagination.limit,
          offset: pagination.offset,
        }),
      scopedLogger,
      { action: "repos.orders.listAll", actorHumanId: input.actorHumanId },
    );

    const output = buildOffsetPaginatedResult({
      // The breakdown reads item meta; the meta itself stays server-side.
      items: result.items.map((order: ListPlatformOrdersItem) => ({
        ...order,
        items: order.items.map(({ meta: _meta, ...item }) => item),
        charges: computeBuyerChargeBreakdown({
          stripePaymentIntentId: order.stripePaymentIntentId,
          amountGrossCents: order.amountGrossCents,
          feesPlatformCents: order.feesPlatformCents,
          taxAmountCents: order.taxAmountCents,
          feePolicySnapshot: order.feePolicySnapshot,
          items: order.items.map((item) => ({
            kind: item.kind,
            amountCents: item.amountCents,
            meta: item.meta ?? null,
          })),
        }),
      })),
      total: result.total,
      limit: pagination.limit,
      offset: pagination.offset,
    });

    return listPlatformOrdersOutputSchema.parse(output);
  };

  if (scopedLogger) {
    return scopedLogger.withTime("listPlatformOrders", execute);
  }

  return execute();
}
