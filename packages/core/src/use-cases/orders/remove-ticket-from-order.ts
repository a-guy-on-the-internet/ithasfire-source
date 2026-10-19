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

export const removeTicketFromOrderInputSchema = z
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

export const removeTicketFromOrderOutputSchema = updateOrderItemsOutputSchema;

export type RemoveTicketFromOrderInput = z.infer<
  typeof removeTicketFromOrderInputSchema
>;
export type RemoveTicketFromOrderOutput = UpdateOrderItemsOutput;

export type RemoveTicketFromOrderDeps = {
  repos: Repos;
  logger?: LoggerPort;
  clock: UpdateOrderItemsDeps["clock"];
};

type OrderItemInput = {
  ticketTypeId: string;
  qty: number;
  seatIds?: string[];
};

export async function removeTicketFromOrder(
  deps: RemoveTicketFromOrderDeps,
  rawInput: unknown,
): Promise<RemoveTicketFromOrderOutput> {
  const logger = deps.logger?.child({ useCase: "removeTicketFromOrder" });

  const execute = async () => {
    const input = parseInput(removeTicketFromOrderInputSchema, rawInput);

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
    const existingItem = items.find(
      (item) => item.ticketTypeId === input.ticketTypeId,
    );

    if (!existingItem) {
      throw fail("TICKET_ITEM_NOT_FOUND");
    }

    const incomingSeatIds = input.seatIds ?? [];

    if (incomingSeatIds.length > 0 && incomingSeatIds.length !== input.qty) {
      throw fail("SEAT_ASSIGNMENT_QTY_MISMATCH");
    }

    const existingSeatIds = existingItem.seatIds ?? [];
    const hasSeatAssignments = existingSeatIds.length > 0;

    if (incomingSeatIds.length > 0) {
      if (!hasSeatAssignments) {
        throw fail("SEAT_IDS_NOT_ASSIGNED");
      }

      for (const seatId of incomingSeatIds) {
        if (!existingSeatIds.includes(seatId)) {
          throw fail("SEAT_NOT_IN_ORDER");
        }
      }

      const remainingSeatIds = existingSeatIds.filter(
        (seatId) => !incomingSeatIds.includes(seatId),
      );
      const newQty = existingItem.qty - input.qty;
      if (newQty < 0) {
        throw fail("QTY_EXCEEDS_ORDER");
      }

      if (newQty === 0) {
        items.splice(items.indexOf(existingItem), 1);
      } else {
        existingItem.qty = newQty;
        existingItem.seatIds = remainingSeatIds;
      }
    } else {
      if (hasSeatAssignments) {
        throw fail("SEAT_IDS_REQUIRED");
      }

      const newQty = existingItem.qty - input.qty;
      if (newQty < 0) {
        throw fail("QTY_EXCEEDS_ORDER");
      }

      if (newQty === 0) {
        items.splice(items.indexOf(existingItem), 1);
      } else {
        existingItem.qty = newQty;
      }
    }

    if (items.length === 0) {
      throw fail("ORDER_EMPTY");
    }

    const result = await updateOrderItems(deps, {
      actorHumanId: input.actorHumanId,
      eventId: input.eventId,
      orderId: input.orderId,
      currency: input.currency,
      items,
    });

    return removeTicketFromOrderOutputSchema.parse(result);
  };

  if (logger) {
    return logger.withTime("removeTicketFromOrder", execute);
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
