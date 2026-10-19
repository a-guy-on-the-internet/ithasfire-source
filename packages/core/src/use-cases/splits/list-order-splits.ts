import { z } from "zod";

import type { Repos } from "@th/ports/repos";
import { parseInput } from "../../lib/io";

export const listOrderSplitsInputSchema = z.object({
  orderId: z.string().uuid(),
});

export const listOrderSplitsOutputSchema = z.object({
  orderId: z.string().uuid(),
  splits: z.array(
    z.object({
      id: z.string().uuid(),
      payeeId: z.string().uuid(),
      amountCents: z.number().int(),
      // Nullable on purpose: a payee row that does not resolve (hard-deleted,
      // or a stale id) degrades THIS row only. The split still carries its
      // `payeeId`, which is enough for a caller to render something. A
      // non-nullable shape here failed the whole read on its own output, so
      // one orphan split hid every other split on the order.
      payee: z
        .object({
          id: z.string().uuid(),
          subjectType: z.string(),
          subjectId: z.string(),
          stripeAccountId: z.string().nullable(),
          payoutsEnabled: z.boolean(),
        })
        .nullable(),
    }),
  ),
  totalCents: z.number().int(),
});

export type ListOrderSplitsInput = z.infer<typeof listOrderSplitsInputSchema>;
export type ListOrderSplitsOutput = z.infer<typeof listOrderSplitsOutputSchema>;

export type ListOrderSplitsDeps = {
  repos: Repos;
};

export async function listOrderSplits(
  deps: ListOrderSplitsDeps,
  rawInput: unknown,
): Promise<ListOrderSplitsOutput> {
  const input = parseInput(listOrderSplitsInputSchema, rawInput);
  const { orderId } = input;

  const splits = await deps.repos.splits.getForOrder(orderId);

  // Bulk-fetch all payees in one query
  const payeeIds = [...new Set(splits.map((s) => s.payeeId))];
  const payees =
    payeeIds.length > 0 ? await deps.repos.payees.getByIds(payeeIds) : [];
  const payeeMap = new Map(payees.map((p) => [p.id, p]));

  const detailed = splits.map((s) => {
    const payee = payeeMap.get(s.payeeId) ?? null;
    return {
      id: s.id,
      payeeId: s.payeeId,
      amountCents: s.amountCents,
      payee: payee
        ? {
            id: payee.id,
            subjectType: payee.subjectType,
            subjectId: payee.subjectId,
            stripeAccountId: payee.stripeAccountId,
            payoutsEnabled: payee.payoutsEnabled,
          }
        : null,
    };
  });

  const total = detailed.reduce((acc, d) => acc + d.amountCents, 0);

  return listOrderSplitsOutputSchema.parse({
    orderId,
    splits: detailed,
    totalCents: total,
  });
}
