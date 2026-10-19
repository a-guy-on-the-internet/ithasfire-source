import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { MetricsPort } from "@th/ports/metric";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { ORG_SCAN_ROLES, requireScannerAccessOnOrg } from "../../lib/rbac";

// ── Schema ───────────────────────────────────────────────────────────────────

export const cancelPosReaderActionInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  orgId: z.string().uuid(),
  posReaderId: z.string().uuid(),
});

export type CancelPosReaderActionInput = z.infer<
  typeof cancelPosReaderActionInputSchema
>;

export const cancelPosReaderActionOutputSchema = z.object({
  cancelled: z.literal(true),
});

export type CancelPosReaderActionOutput = z.infer<
  typeof cancelPosReaderActionOutputSchema
>;

// ── Deps ─────────────────────────────────────────────────────────────────────

export type CancelPosReaderActionDeps = {
  repos: Repos;
  authz: AuthZPort;
  payments: PaymentProcessorPort;
  logger?: LoggerPort;
  metrics?: MetricsPort;
};

// ── Use case ─────────────────────────────────────────────────────────────────

/**
 * Clears whatever the reader is currently prompting for — the "never mind"
 * button when a buyer walks away mid-tap or the operator rang up the wrong
 * thing.
 *
 * This cancels the READER ACTION, not the order. The PaymentIntent stays
 * un-confirmed and the order stays PENDING; the operator can re-dispatch the
 * same order to the same or a different reader. Abandoned PENDING orders and
 * their seat holds are reaped by the existing expired-holds path.
 *
 * Auth: ORG_SCAN_ROLES on the reader's own org. Unlike dispatch there is no
 * order to derive the org from, so `orgId` is an input — which is exactly why
 * the membership check runs against that org AND the reader is then confirmed
 * to belong to it. Checking only one of the two would let an operator cancel
 * on another org's reader.
 *
 * Cancelling when nothing is in flight is a no-op, not an error.
 */
export async function cancelPosReaderAction(
  deps: CancelPosReaderActionDeps,
  rawInput: unknown,
): Promise<CancelPosReaderActionOutput> {
  const input = parseInput(cancelPosReaderActionInputSchema, rawInput);

  await requireScannerAccessOnOrg({
    repos: deps.repos,
    authz: deps.authz,
    orgId: input.orgId,
    actorHumanId: input.actorHumanId,
    roles: ORG_SCAN_ROLES,
    errorCode: "INSUFFICIENT_ROLE",
  });

  const reader = await deps.repos.posReaders.getById({ id: input.posReaderId });
  if (!reader) {
    throw fail("POS_READER_NOT_FOUND");
  }
  if (reader.orgId !== input.orgId) {
    throw fail("POS_READER_ORG_MISMATCH");
  }

  await deps.payments.cancelReaderAction({ readerId: reader.stripeReaderId });

  deps.logger?.info("pos.reader.action_cancelled", {
    actorHumanId: input.actorHumanId,
    orgId: input.orgId,
    posReaderId: reader.id,
  });
  deps.metrics?.increment("pos.reader_action.cancelled", {
    orgId: input.orgId,
  });

  return cancelPosReaderActionOutputSchema.parse({ cancelled: true });
}
