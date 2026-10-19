import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { payeeSubjectTypeSchema } from "@th/schema";

import { parseInput } from "../../lib/io";
import { ensureEmailVerified } from "../_helpers/ensure-email-verified";
import { fail } from "@th/errors";

export const schedulePayoutInputSchema = z.object({
  actorHumanId: z.uuid(),
  subjectType: payeeSubjectTypeSchema,
  subjectId: z.uuid(),
  scheduledFor: z.coerce.date(),
});

export const schedulePayoutOutputSchema = z.object({
  payoutId: z.uuid(),
});

export type SchedulePayoutInput = z.infer<typeof schedulePayoutInputSchema>;
export type SchedulePayoutOutput = z.infer<typeof schedulePayoutOutputSchema>;

export type SchedulePayoutDeps = {
  repos: Repos;
  clock: ClockPort;
  authz: AuthZPort;
  logger?: LoggerPort;
};

/**
 * Schedule a payout batch for execution at/after a specific timestamp.
 *
 * Scope rules:
 * - Every payout is explicitly tied to either a HUMAN or ORGANIZATION.
 */
export async function schedulePayout(
  deps: SchedulePayoutDeps,
  rawInput: unknown,
): Promise<SchedulePayoutOutput> {
  const logger = deps.logger?.child({ useCase: "schedulePayout" });
  const input = parseInput(schedulePayoutInputSchema, rawInput);

  if (input.scheduledFor.getTime() < deps.clock.now().getTime() - 60_000) {
    throw {
      code: "invalid_input",
      issues: [{ code: "custom", message: "scheduled_for_in_past", path: [] }],
    } as const;
  }

  // Money-out flow: require verified email.
  await deps.repos.tx(async (tx) => {
    await ensureEmailVerified(tx, input.actorHumanId);
  });

  // Staff-only for now (we can relax later, but keep it safe).
  const staff = await deps.authz.hasStaffRole({
    actorHumanId: input.actorHumanId,
    requiredRoles: ["ADMIN", "SUPPORT"],
  });
  if (!staff.allowed) {
    throw fail("STAFF_ONLY");
  }

  // Validate the subject has a Payee configured.
  const payee = await deps.repos.payees.getBySubject({
    type: input.subjectType,
    id: input.subjectId,
  });
  if (!payee) {
    throw fail("PAYEE_NOT_FOUND");
  }

  const payout = await deps.repos.payouts.create({
    scheduledFor: input.scheduledFor,
  });

  await deps.repos.tx(async (tx) => {
    await tx.audit.log({
      entity: "payout",
      entityId: payout.id,
      action: "payout_scheduled",
      data: {
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        payeeId: payee.id,
        scheduledFor: input.scheduledFor.toISOString(),
      },
      at: deps.clock.now(),
    });
  });

  logger?.info("payout_scheduled", { payoutId: payout.id });

  return schedulePayoutOutputSchema.parse({ payoutId: payout.id });
}
