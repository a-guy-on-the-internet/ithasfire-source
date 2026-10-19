import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";

import { asKnownError } from "../../../lib/errors";
import { parseInput } from "../../../lib/io";
import {
  notifyEarlyFraudWarningOps,
  type EarlyFraudWarningNotifyDeps,
} from "./notify-early-fraud-warning";
import { resolveChargeContext } from "./resolve-charge-context";

// ─────────────────────────────────────────────────────────────────────────────
// recordEarlyFraudWarning — `radar.early_fraud_warning.created` (and
// `.updated`) intake.
//
// Persists the warning idempotently on the Stripe EFW id, links it to the
// order/owner the way a dispute would, writes an audit row inside the same
// transaction, and — for a NEWLY seen warning only — pings ops on Discord
// with a path to the refund. Replays and `.updated` deliveries refresh the
// row (Stripe flips `actionable` to false once the charge is disputed or
// refunded) and never re-alert.
//
// The "already seen" check is a read inside the write transaction, not a
// mutex: two deliveries of the same event racing within milliseconds could
// both alert. That is a duplicate Discord ping, not money, and Stripe's
// retries are seconds apart — the idempotency budget goes to the row, which
// is what the dispute desk and the order panel read.
// ─────────────────────────────────────────────────────────────────────────────

const optionalUuidSchema = z
  .string()
  .uuid()
  .nullable()
  .optional()
  .catch(null)
  .transform((value) => value ?? null);

const optionalStripeIdSchema = z
  .string()
  .trim()
  .min(3)
  .nullable()
  .optional()
  .transform((value) => value ?? null);

export const recordEarlyFraudWarningInputSchema = z
  .object({
    stripeEventId: z.string().trim().min(3).nullable().optional(),
    stripeEventType: z.string().trim().min(3).nullable().optional(),
    stripeEfwId: z.string().trim().min(3),
    stripeChargeId: z.string().trim().min(3),
    paymentIntentId: optionalStripeIdSchema,
    metadataOrderId: optionalUuidSchema,
    metadataEventId: optionalUuidSchema,
    fraudType: z.string().trim().min(1).max(64),
    actionable: z.boolean(),
    stripeCreatedAt: z.coerce.date(),
  })
  .strict();

export const recordEarlyFraudWarningOutputSchema = z
  .object({
    ok: z.literal(true),
    earlyFraudWarningId: z.string().min(1),
    stripeEfwId: z.string().min(1),
    orderId: z.string().nullable(),
    ownerOrgId: z.string().nullable(),
    ownerHumanId: z.string().nullable(),
    actionable: z.boolean(),
    /** False on a replay / `.updated` delivery: the row already existed. */
    created: z.boolean(),
    /** True only when the Discord alert was actually sent. */
    alerted: z.boolean(),
  })
  .strict();

export type RecordEarlyFraudWarningInput = z.infer<
  typeof recordEarlyFraudWarningInputSchema
>;
export type RecordEarlyFraudWarningOutput = z.infer<
  typeof recordEarlyFraudWarningOutputSchema
>;

export type RecordEarlyFraudWarningDeps = Omit<
  EarlyFraudWarningNotifyDeps,
  "repos"
> & {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
  reportError?: ReporterPort | null;
};

export async function recordEarlyFraudWarning(
  deps: RecordEarlyFraudWarningDeps,
  rawInput: unknown,
): Promise<RecordEarlyFraudWarningOutput> {
  const input = parseInput(recordEarlyFraudWarningInputSchema, rawInput);

  const persisted = await (async () => {
    try {
      return await deps.repos.tx(async (tx) => {
        const now = deps.clock.now();
        const existing = await tx.earlyFraudWarnings.findByStripeEfwId(
          input.stripeEfwId,
        );
        const context = await resolveChargeContext(tx, {
          existingOrderId: existing?.orderId ?? null,
          paymentIntentId: input.paymentIntentId,
          metadataOrderId: input.metadataOrderId,
          metadataEventId: input.metadataEventId,
        });

        const warning = await tx.earlyFraudWarnings.upsertFromStripe({
          stripeEfwId: input.stripeEfwId,
          stripeChargeId: input.stripeChargeId,
          paymentIntentId:
            input.paymentIntentId ??
            context.order?.stripePaymentIntentId ??
            existing?.paymentIntentId ??
            null,
          orderId: context.order?.id ?? existing?.orderId ?? null,
          ownerOrgId: context.owner?.ownerOrgId ?? existing?.ownerOrgId ?? null,
          ownerHumanId:
            context.owner?.ownerHumanId ?? existing?.ownerHumanId ?? null,
          fraudType: input.fraudType,
          actionable: input.actionable,
          stripeCreatedAt: input.stripeCreatedAt,
        });

        await tx.audit.log({
          entity: "early_fraud_warning",
          entityId: warning.id,
          action: existing
            ? "early_fraud_warning.refreshed"
            : "early_fraud_warning.recorded",
          data: {
            stripeEventId: input.stripeEventId ?? null,
            stripeEventType: input.stripeEventType ?? null,
            stripeEfwId: warning.stripeEfwId,
            stripeChargeId: warning.stripeChargeId,
            paymentIntentId: warning.paymentIntentId,
            orderId: warning.orderId,
            ownerOrgId: warning.ownerOrgId,
            ownerHumanId: warning.ownerHumanId,
            fraudType: warning.fraudType,
            actionable: warning.actionable,
            unresolvedReason: context.unresolvedReason,
          },
          at: now,
        });

        return { warning, context, created: !existing };
      });
    } catch (error) {
      throw asKnownError("recordEarlyFraudWarning", error);
    }
  })();

  let alerted = false;
  if (persisted.created) {
    // Best-effort, outside the transaction: the row is the outcome, the
    // ping is the courtesy. The notifier never throws.
    ({ alerted } = await notifyEarlyFraudWarningOps(deps, {
      warning: persisted.warning,
      order: persisted.context.order,
      event: persisted.context.event,
      stripeEventId: input.stripeEventId ?? null,
    }));
  } else {
    deps.logger?.info("early_fraud_warning.replayed", {
      stripeEfwId: input.stripeEfwId,
      stripeEventId: input.stripeEventId ?? null,
      actionable: input.actionable,
    });
  }

  return recordEarlyFraudWarningOutputSchema.parse({
    ok: true,
    earlyFraudWarningId: persisted.warning.id,
    stripeEfwId: persisted.warning.stripeEfwId,
    orderId: persisted.warning.orderId,
    ownerOrgId: persisted.warning.ownerOrgId,
    ownerHumanId: persisted.warning.ownerHumanId,
    actionable: persisted.warning.actionable,
    created: persisted.created,
    alerted,
  });
}
