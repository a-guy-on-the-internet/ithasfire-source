import { z } from "zod";

import type { Repos } from "@th/ports/repos";
import type { TicketStatus } from "@th/types";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";

const ticketStatusSchema = z.enum([
  "VALID",
  "SCANNED",
  "INVALID",
  "REFUNDED",
  "LISTED",
] satisfies readonly TicketStatus[]);

export const listMyOrderTicketsInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  orderId: z.string().uuid(),
});

export const listMyOrderTicketsOutputSchema = z.object({
  orderId: z.string().uuid(),
  tickets: z.array(
    z.object({
      id: z.string().uuid(),
      code: z.string().min(4),
      status: ticketStatusSchema,
      scannedAt: z.date().nullable(),
      orderItemId: z.string().uuid().nullable(),
      ticketTypeId: z.string().uuid().nullable(),
    }),
  ),
});

export type ListMyOrderTicketsInput = z.infer<
  typeof listMyOrderTicketsInputSchema
>;
export type ListMyOrderTicketsOutput = z.infer<
  typeof listMyOrderTicketsOutputSchema
>;

export type ListMyOrderTicketsDeps = {
  repos: Repos;
};

export async function listMyOrderTickets(
  deps: ListMyOrderTicketsDeps,
  rawInput: unknown,
): Promise<ListMyOrderTicketsOutput> {
  const input = parseInput(listMyOrderTicketsInputSchema, rawInput);

  const order = await deps.repos.orders.getById(input.orderId);
  if (!order) {
    throw fail("ORDER_NOT_FOUND");
  }

  const isBuyer = order.buyerHumanId === input.actorHumanId;

  const tickets = await deps.repos.tickets.listByOrderId(order.id);

  // Buyers see every ticket on the order. Transfer recipients see only the
  // tickets they currently own — they shouldn't be exposed to the rest of
  // the original buyer's seats.
  const visibleTickets = isBuyer
    ? tickets
    : tickets.filter((t) => t.ownerHumanId === input.actorHumanId);

  if (!isBuyer && visibleTickets.length === 0) {
    throw fail("ORDER_NOT_FOUND");
  }

  const detailed = visibleTickets.map((record) => ({
    id: record.id,
    code: record.code,
    status: record.status,
    scannedAt: record.scannedAt,
    orderItemId: record.orderItemId,
    ticketTypeId: record.ticketTypeId,
  }));

  return listMyOrderTicketsOutputSchema.parse({
    orderId: order.id,
    tickets: detailed,
  });
}
