import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { parseInput } from "../../lib/io";
import { ensureEmailVerified } from "../_helpers/ensure-email-verified";
import { fail } from "@th/errors";

export const listDuePayoutsInputSchema = z.object({
  actorHumanId: z.uuid(),
  now: z.coerce.date().optional(),
  limit: z.number().int().min(1).max(100).default(25),
});

export const listDuePayoutsOutputSchema = z.object({
  payouts: z.array(
    z.object({
      id: z.uuid(),
      scheduledFor: z.coerce.date(),
    }),
  ),
});

export type ListDuePayoutsInput = z.infer<typeof listDuePayoutsInputSchema>;
export type ListDuePayoutsOutput = z.infer<typeof listDuePayoutsOutputSchema>;

export type ListDuePayoutsDeps = {
  repos: Repos;
  clock: ClockPort;
  authz: AuthZPort;
  logger?: LoggerPort;
};

/**
 * List payout batches that are due for execution.
 *
 * Note: while payouts are tied to a HUMAN or ORGANIZATION at the business level,
 * this listing is operational (scheduler/worker) so it returns all due payouts.
 */
export async function listDuePayouts(
  deps: ListDuePayoutsDeps,
  rawInput: unknown,
): Promise<ListDuePayoutsOutput> {
  const logger = deps.logger?.child({ useCase: "listDuePayouts" });
  const input = parseInput(listDuePayoutsInputSchema, rawInput);

  await deps.repos.tx(async (tx) => {
    await ensureEmailVerified(tx, input.actorHumanId);
  });

  const staff = await deps.authz.hasStaffRole({
    actorHumanId: input.actorHumanId,
    requiredRoles: ["ADMIN", "SUPPORT"],
  });
  if (!staff.allowed) {
    throw fail("STAFF_ONLY");
  }

  const now = input.now ?? deps.clock.now();
  const payouts = await deps.repos.payouts.listDue(now, input.limit);

  logger?.info("payouts_due_listed", { count: payouts.length });

  return listDuePayoutsOutputSchema.parse({ payouts });
}
