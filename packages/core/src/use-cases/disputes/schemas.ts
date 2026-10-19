import { z } from "zod";

import type { DisputeStatus } from "@th/ports/repos/disputes";

export const disputeStatusSchema = z.enum([
  "NEEDS_TRIAGE",
  "OPEN",
  "UNDER_REVIEW",
  "WON",
  "LOST",
  "WARNING_OPEN",
  "WARNING_UNDER_REVIEW",
  "WARNING_CLOSED",
] satisfies readonly DisputeStatus[]);

const optionalStripeIdSchema = z
  .string()
  .trim()
  .min(3)
  .nullable()
  .optional()
  .transform((value) => value ?? null);

const optionalUuidSchema = z
  .string()
  .uuid()
  .nullable()
  .optional()
  .catch(null)
  .transform((value) => value ?? null);

const optionalDateSchema = z.coerce
  .date()
  .nullable()
  .optional()
  .transform((value) => value ?? null);

export const stripeDisputeLifecycleInputSchema = z
  .object({
    stripeEventId: z.string().trim().min(3).optional(),
    stripeDisputeId: z.string().trim().min(3),
    stripeChargeId: optionalStripeIdSchema,
    paymentIntentId: optionalStripeIdSchema,
    metadataOrderId: optionalUuidSchema,
    metadataEventId: optionalUuidSchema,
    amountCents: z.coerce.number().int().nonnegative(),
    /**
     * Stripe's dispute fee, summed across balance transactions. Absent on most
     * lifecycle events — it usually only appears at `funds_withdrawn` — so
     * `null` means "Stripe didn't tell us this time", NOT "the fee is zero".
     * The persistence step must not clobber a known fee with an absent one.
     */
    feeCents: z.coerce
      .number()
      .int()
      .nullable()
      .optional()
      .transform((value) => value ?? null),
    currency: z
      .string()
      .trim()
      .length(3)
      .transform((value) => value.toLowerCase()),
    reason: z.string().trim().min(1),
    stripeStatus: z.string().trim().min(1).nullable().optional(),
    isWarning: z.boolean().optional().default(false),
    evidenceDueBy: optionalDateSchema,
    fundsWithdrawnAt: optionalDateSchema,
    closedAt: optionalDateSchema,
    outcome: z
      .string()
      .trim()
      .min(1)
      .nullable()
      .optional()
      .transform((value) => value ?? null),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();

export const disputeLifecycleOutputSchema = z
  .object({
    ok: z.literal(true),
    disputeId: z.string().min(1),
    stripeDisputeId: z.string().min(3),
    orderId: z.string().uuid().nullable(),
    status: disputeStatusSchema,
    triageReason: z.string().nullable(),
  })
  .strict();

export type StripeDisputeLifecycleInput = z.infer<
  typeof stripeDisputeLifecycleInputSchema
>;
export type DisputeLifecycleOutput = z.infer<
  typeof disputeLifecycleOutputSchema
>;
