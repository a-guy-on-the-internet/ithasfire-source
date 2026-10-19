import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import { stripeRefundReasonSchema } from "@th/schema";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";
import { plainTextMultilineRequired } from "../../lib/sanitize-plain-text";
import type { NotifyFn } from "./notify-buyer";
import {
  refundFullOrder,
  refundFullOrderInputSchema,
  refundFullOrderOutputSchema,
} from "./refund-full-order";

export const staffRefundOrderInputSchema = z.object({
  actorHumanId: z.uuid(),
  orderId: z.uuid(),
  reason: stripeRefundReasonSchema.optional(),

  /**
   * Free-form justification recorded in audit logs.
   * Required for staff refunds so we have a paper trail.
   */
  note: plainTextMultilineRequired(500).pipe(z.string().min(3)),
});

export const staffRefundOrderOutputSchema = refundFullOrderOutputSchema;

export type StaffRefundOrderInput = z.infer<typeof staffRefundOrderInputSchema>;
export type StaffRefundOrderOutput = z.infer<
  typeof staffRefundOrderOutputSchema
>;

export type StaffRefundOrderDeps = {
  repos: Repos;
  payments: PaymentProcessorPort;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  authz: AuthZPort;
  logger?: LoggerPort;
  /**
   * Multi-channel notification dispatcher. Optional — forwarded to the
   * delegated refundFullOrder so the BUYER gets a fire-and-forget in-app
   * refund confirmation. The notify call lives in refundFullOrder (single
   * source) so staff and self-serve full refunds can't double-notify.
   */
  notify?: NotifyFn;
  /**
   * Passed to refundFullOrder: tells a seller whose legacy listing the
   * refund closed how to list again (`sendLegacyRelistNotices`).
   */
  publicAppUrl?: string | null;
  /**
   * Forwarded to the delegated refundFullOrder so refund-debit swallows
   * (no_credits_for_order / clamp drift) reach Sentry from the staff path
   * too (Step C review, BLOCKING).
   */
  reportError?: ReporterPort | null;
};

/**
 * Staff/admin refund orchestration entry point.
 *
 * Today, we only support our "full refund net of Stripe fee" policy.
 * This wrapper exists so admin tooling can call a stable use case while we
 * evolve post-payout strategies later.
 */
export async function staffRefundOrder(
  deps: StaffRefundOrderDeps,
  rawInput: unknown,
): Promise<StaffRefundOrderOutput> {
  const logger = deps.logger?.child({ useCase: "staffRefundOrder" });
  const input = parseInput(staffRefundOrderInputSchema, rawInput);

  const staff = await deps.authz.hasStaffRole({
    actorHumanId: input.actorHumanId,
    requiredRoles: ["ADMIN", "SUPPORT"],
  });

  if (!staff.allowed) {
    throw fail("STAFF_ONLY");
  }

  // Delegate to the existing, tested policy.
  // Staff bypass the buyer ownership check since they have elevated roles.
  const out = await refundFullOrder(
    {
      repos: deps.repos,
      payments: deps.payments,
      idempotency: deps.idempotency,
      clock: deps.clock,
      logger,
      notify: deps.notify,
      publicAppUrl: deps.publicAppUrl,
      reportError: deps.reportError,
      _skipBuyerCheck: true,
    },
    refundFullOrderInputSchema.parse({
      actorHumanId: input.actorHumanId,
      orderId: input.orderId,
      reason: input.reason,
    }),
  );

  // Attach the staff note to the audit log (reuse order entity).
  // We write a second audit row so we don't need to modify the full refund schema.
  await deps.repos.tx(async (tx) => {
    await tx.audit.log({
      entity: "order",
      entityId: input.orderId,
      action: "refund_note",
      data: {
        note: input.note,
      },
      at: deps.clock.now(),
    });
  });

  return staffRefundOrderOutputSchema.parse(out);
}
