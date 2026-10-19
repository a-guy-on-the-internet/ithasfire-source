import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { OrderItemRecord } from "@th/ports/repos/orders";
import { parseInput } from "../../lib/io";
import { extractSeatIdsFromMeta } from "./checkout-helpers";
import { fail } from "@th/errors";
import {
  updateOrderItems,
  updateOrderItemsOutputSchema,
  type UpdateOrderItemsDeps,
  type UpdateOrderItemsOutput,
} from "./update-order-items";

export const addTicketToOrderInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    eventId: z.uuid(),
    orderId: z.uuid(),
    ticketTypeId: z.uuid(),
    qty: z.number().int().positive(),
    seatIds: z.array(z.string().uuid()).min(1).optional(),
    currency: z
      .string()
      .trim()
      .min(3)
      .max(3)
      .regex(/^[A-Za-z]{3}$/)
      .transform((value) => value.toLowerCase())
      .optional(),
  })
  .strict();

export const addTicketToOrderOutputSchema = updateOrderItemsOutputSchema;

export type AddTicketToOrderInput = z.infer<typeof addTicketToOrderInputSchema>;
export type AddTicketToOrderOutput = UpdateOrderItemsOutput;

export type AddTicketToOrderDeps = {
  repos: Repos;
  logger?: LoggerPort;
  clock: UpdateOrderItemsDeps["clock"];
};

type OrderItemInput = {
  ticketTypeId: string;
  qty: number;
  seatIds?: string[];
};

export async function addTicketToOrder(
  deps: AddTicketToOrderDeps,
  rawInput: unknown,
): Promise<AddTicketToOrderOutput> {
  const logger = deps.logger?.child({ useCase: "addTicketToOrder" });

  const execute = async () => {
    const input = parseInput(addTicketToOrderInputSchema, rawInput);

    const existing = await deps.repos.orders.getById(input.orderId);
    if (!existing) {
      throw fail("ORDER_NOT_FOUND");
    }

    if (existing.buyerHumanId !== input.actorHumanId) {
      throw fail("ORDER_NOT_OWNED");
    }

    if (existing.status !== "PENDING") {
      throw fail("ORDER_NOT_PENDING");
    }

    if (existing.eventId !== input.eventId) {
      throw fail("ORDER_EVENT_MISMATCH");
    }

    if (
      input.currency &&
      existing.currency.toLowerCase() !== input.currency.toLowerCase()
    ) {
      throw fail("CURRENCY_MISMATCH");
    }

    const items = buildTicketItems(existing.items);
    const incomingSeatIds = input.seatIds ?? [];

    if (incomingSeatIds.length > 0 && incomingSeatIds.length !== input.qty) {
      throw fail("SEAT_ASSIGNMENT_QTY_MISMATCH");
    }

    const existingItem = items.find(
      (item) => item.ticketTypeId === input.ticketTypeId,
    );

    if (existingItem) {
      const existingSeatIds = existingItem.seatIds ?? [];
      const hasSeatAssignments =
        existingSeatIds.length > 0 || incomingSeatIds.length > 0;

      if (hasSeatAssignments) {
        if (existingSeatIds.length === 0 || incomingSeatIds.length === 0) {
          throw fail("SEAT_IDS_REQUIRED");
        }

        const combined = [...existingSeatIds, ...incomingSeatIds];
        const unique = new Set(combined);
        if (unique.size !== combined.length) {
          throw fail("SEAT_IDS_DUPLICATE");
        }

        existingItem.seatIds = combined;
      }

      existingItem.qty += input.qty;
    } else {
      const nextItem: OrderItemInput = {
        ticketTypeId: input.ticketTypeId,
        qty: input.qty,
      };

      if (incomingSeatIds.length > 0) {
        nextItem.seatIds = incomingSeatIds;
      }

      items.push(nextItem);
    }

    const result = await updateOrderItems(deps, {
      actorHumanId: input.actorHumanId,
      eventId: input.eventId,
      orderId: input.orderId,
      currency: input.currency,
      items,
    });

    return addTicketToOrderOutputSchema.parse(result);
  };

  if (logger) {
    return logger.withTime("addTicketToOrder", execute);
  }

  return execute();
}

function buildTicketItems(items: OrderItemRecord[]): OrderItemInput[] {
  return items
    .filter((item) => item.kind === "ticket" && item.ticketTypeId)
    .map((item) => {
      const seatIds = extractSeatIdsFromMeta(item.meta);
      const base: OrderItemInput = {
        ticketTypeId: item.ticketTypeId as string,
        qty: item.qty,
      };
      if (seatIds.length > 0) {
        base.seatIds = seatIds;
      }
      return base;
    });
}
