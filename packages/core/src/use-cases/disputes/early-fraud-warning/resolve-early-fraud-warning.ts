import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { EarlyFraudWarningResolution } from "@th/ports/repos/early-fraud-warnings";

import { asKnownError } from "../../../lib/errors";
import { parseInput } from "../../../lib/io";

// ─────────────────────────────────────────────────────────────────────────────
// resolveEarlyFraudWarning — closes the active warning on a charge.
//
// Called from the webhook when the window has closed one way or the other:
//   * `charge.dispute.created` on the charge → DISPUTED (the chargeback the
//     warning predicted has landed);
//   * `charge.refunded` → REFUNDED when the charge is fully refunded in
//     Stripe's eyes (`refunded: true`) OR when the PLATFORM considers the
//     order fully refunded (`Order.status === "REFUNDED"`). The second arm
//     matters: a platform refund withholds the processing fee by design, so
//     Stripe reports it as a partial (`refunded: false`, `amount_refunded`
//     below the charge) and the first arm never fires — observed live on a
//     $51.29 charge refunded as $49.33. A genuinely partial platform refund
//     (order PART_REFUNDED) leaves the warning open: the issuer's chargeback
//     can still land for the remainder.
//
// Known residual — the platform-full arm reads `Order.status` at webhook
// time, and `charge.refunded` CAN arrive before the refund transaction's
// `REFUNDED` write commits (Stripe fires on its side of the call; our row
// lands after). In that window this resolves as `partial_refund` and the
// warning's `resolution` is never stamped. What is NOT lost: Stripe's
// `radar.early_fraud_warning.updated` flips `actionable` off once the refund
// settles, and the ops queue (`listActionable`) and the order panel both key
// on that flag, so the warning still leaves the queue. Only the local
// REFUNDED/DISPUTED provenance row is missing; accepted rather than adding a
// second read path for a race no one has observed.
//
// IGNORED is reserved for an ops decision surface; no caller yet.
//
// No-op (not an error) when the charge has no active warning: most disputes
// and refunds were never warned about. The repo's compare-and-set means the
// FIRST resolution sticks — a refund arriving after the dispute stays
// DISPUTED.
// ─────────────────────────────────────────────────────────────────────────────

export const earlyFraudWarningResolutionSchema = z.enum([
  "REFUNDED",
  "DISPUTED",
  "IGNORED",
] satisfies readonly EarlyFraudWarningResolution[]);

export const resolveEarlyFraudWarningInputSchema = z
  .object({
    stripeChargeId: z.string().trim().min(3),
    resolution: earlyFraudWarningResolutionSchema,
    stripeEventId: z.string().trim().min(3).nullable().optional(),
    stripeEventType: z.string().trim().min(3).nullable().optional(),
    /**
     * The refund facts from `charge.refunded`, REFUNDED only. When Stripe
     * reports the charge as not fully refunded, the local order must read
     * `REFUNDED` (platform-full) for the warning to close.
     */
    refund: z
      .object({
        stripeFullyRefunded: z.boolean(),
        amountRefundedCents: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    /**
     * Stripe dispute / refund id that closed the window, for the audit row.
     * The refund hook falls back to the CHARGE id when newer API versions omit
     * `charge.refunds` from the event — the audit row then names the charge,
     * not the refund; the Dashboard resolves either.
     */
    sourceId: z.string().trim().min(3).nullable().optional(),
  })
  .strict();

export const resolveEarlyFraudWarningOutputSchema = z
  .object({
    ok: z.literal(true),
    resolved: z.boolean(),
    earlyFraudWarningId: z.string().nullable(),
    resolution: earlyFraudWarningResolutionSchema.nullable(),
    skippedReason: z
      .enum(["no_active_warning", "already_resolved", "partial_refund"])
      .nullable(),
  })
  .strict();

export type ResolveEarlyFraudWarningInput = z.infer<
  typeof resolveEarlyFraudWarningInputSchema
>;
export type ResolveEarlyFraudWarningOutput = z.infer<
  typeof resolveEarlyFraudWarningOutputSchema
>;

export type ResolveEarlyFraudWarningDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function resolveEarlyFraudWarning(
  deps: ResolveEarlyFraudWarningDeps,
  rawInput: unknown,
): Promise<ResolveEarlyFraudWarningOutput> {
  const input = parseInput(resolveEarlyFraudWarningInputSchema, rawInput);

  try {
    const result = await deps.repos.tx(async (tx) => {
      const active = await tx.earlyFraudWarnings.findActiveByStripeChargeId(
        input.stripeChargeId,
      );
      if (!active) {
        return {
          resolved: false,
          earlyFraudWarningId: null,
          resolution: null,
          skippedReason: "no_active_warning" as const,
        };
      }

      if (
        input.resolution === "REFUNDED" &&
        input.refund &&
        !input.refund.stripeFullyRefunded
      ) {
        const platformFull =
          input.refund.amountRefundedCents > 0 &&
          (await isOrderFullyRefunded(tx, active));
        if (!platformFull) {
          return {
            resolved: false,
            earlyFraudWarningId: active.id,
            resolution: null,
            skippedReason: "partial_refund" as const,
          };
        }
      }

      const now = deps.clock.now();
      const updated = await tx.earlyFraudWarnings.markResolved({
        id: active.id,
        resolution: input.resolution,
        resolvedAt: now,
      });
      if (!updated) {
        return {
          resolved: false,
          earlyFraudWarningId: active.id,
          resolution: active.resolution,
          skippedReason: "already_resolved" as const,
        };
      }

      await tx.audit.log({
        entity: "early_fraud_warning",
        entityId: updated.id,
        action: "early_fraud_warning.resolved",
        data: {
          stripeEventId: input.stripeEventId ?? null,
          stripeEventType: input.stripeEventType ?? null,
          stripeEfwId: updated.stripeEfwId,
          stripeChargeId: updated.stripeChargeId,
          orderId: updated.orderId,
          resolution: updated.resolution,
          sourceId: input.sourceId ?? null,
          refund: input.refund ?? null,
        },
        at: now,
      });

      return {
        resolved: true,
        earlyFraudWarningId: updated.id,
        resolution: updated.resolution,
        skippedReason: null,
      };
    });

    deps.logger?.info("early_fraud_warning.resolve", {
      stripeChargeId: input.stripeChargeId,
      requested: input.resolution,
      ...result,
    });

    return resolveEarlyFraudWarningOutputSchema.parse({ ok: true, ...result });
  } catch (error) {
    throw asKnownError("resolveEarlyFraudWarning", error);
  }
}

/**
 * "Fully refunded" as the PLATFORM sees it — `Order.status === "REFUNDED"`
 * (set by the refund use cases / `reconcileStripeFullRefund`). Resolved from
 * the warning's own order link first, then the PaymentIntent, the same way
 * the charge resolver links in the first place. Unknown order → false.
 */
async function isOrderFullyRefunded(
  tx: Pick<TxRepos, "orders">,
  warning: { orderId: string | null; paymentIntentId: string | null },
): Promise<boolean> {
  if (warning.orderId) {
    const order = await tx.orders.getById(warning.orderId);
    if (order) return order.status === "REFUNDED";
  }
  if (warning.paymentIntentId) {
    const ref = await tx.orders.findByPaymentIntent(warning.paymentIntentId);
    if (ref) return ref.status === "REFUNDED";
  }
  return false;
}
