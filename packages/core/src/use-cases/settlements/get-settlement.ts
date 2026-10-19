import { z } from "zod";

import type { Repos } from "@th/ports/repos";
import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";

export const getSettlementInputSchema = z.object({
  settlementId: z.string().uuid(),
});

export const getSettlementOutputSchema = z.object({
  settlement: z.object({
    id: z.string().uuid(),
    payeeId: z.string().uuid(),
    date: z.string(),
    amountCents: z.number().int(),
    currency: z.string(),
    status: z.string(),
    stripeTransferId: z.string().nullable(),
  }),
  payee: z
    .object({
      id: z.string(),
      subjectType: z.string(),
      subjectId: z.string(),
      stripeAccountId: z.string().nullable(),
      payoutsEnabled: z.boolean(),
    })
    .nullable(),
  lines: z.array(
    z.object({
      id: z.string().uuid(),
      orderId: z.string().uuid(),
      orderSplitId: z.string().uuid(),
      amountCents: z.number().int(),
      currency: z.string(),
    }),
  ),
});

export type GetSettlementInput = z.infer<typeof getSettlementInputSchema>;
export type GetSettlementOutput = z.infer<typeof getSettlementOutputSchema>;

export type GetSettlementDeps = { repos: Repos };

export async function getSettlement(
  deps: GetSettlementDeps,
  rawInput: unknown,
): Promise<GetSettlementOutput> {
  const input = parseInput(getSettlementInputSchema, rawInput);
  const settlement = await deps.repos.settlements.getById(input.settlementId);
  if (!settlement)
    throw fail("SETTLEMENT_NOT_FOUND");

  const payee = await deps.repos.payees
    .getById(settlement.payeeId)
    .catch(() => null);
  const lines = await deps.repos.settlementLines.listBySettlementId(
    settlement.id,
  );

  return getSettlementOutputSchema.parse({
    settlement: {
      id: settlement.id,
      payeeId: settlement.payeeId,
      date: settlement.date.toISOString(),
      amountCents: settlement.amountCents,
      currency: settlement.currency,
      status: settlement.status,
      stripeTransferId: settlement.stripeTransferId ?? null,
    },
    payee: payee
      ? {
          id: payee.id,
          subjectType: payee.subjectType,
          subjectId: payee.subjectId,
          stripeAccountId: payee.stripeAccountId,
          payoutsEnabled: payee.payoutsEnabled,
        }
      : null,
    lines: lines.map((l) => ({
      id: l.id,
      orderId: l.orderId,
      orderSplitId: l.orderSplitId,
      amountCents: l.amountCents,
      currency: l.currency,
    })),
  });
}
