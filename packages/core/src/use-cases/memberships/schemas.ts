import { z } from "zod";

import { plainTextOptional } from "../../lib/sanitize-plain-text";

/**
 * Shared wire shapes for membership use cases. Output-parsed at the use-case
 * boundary (the listPromos pattern) so the transport contract is explicit and
 * a repo returning extra fields can never leak them.
 */

export const membershipTierOutputSchema = z.object({
  id: z.string().uuid(),
  ownerOrgId: z.string().uuid().nullable(),
  ownerHumanId: z.string().uuid().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  /** The OWNER'S statement of what members get — their claim, not ours. */
  benefitsDescription: z.string().nullable(),
  priceCents: z.number().int(),
  currency: z.string(),
  interval: z.enum(["MONTH", "YEAR"]),
  stripeProductId: z.string().nullable(),
  stripePriceId: z.string().nullable(),
  status: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]),
  sortOrder: z.number().int(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type MembershipTierOutput = z.infer<typeof membershipTierOutputSchema>;

/**
 * The writable terms of a DISCOUNT benefit, shared verbatim by
 * `attachTierBenefit` and `updateTierBenefit` so the two write paths cannot
 * accept different shapes. Cross-field rules that Zod can't express live in
 * `assertBenefitTerms` (attach-tier-benefit.ts), also shared.
 *
 * A benefit deliberately has NO code, no window, no redemption cap and no
 * status: those are campaign properties. Its validity window IS the
 * membership.
 */
export const benefitTermsSchema = z.object({
  discountKind: z.enum(["AMOUNT", "PERCENT"]),
  /** Cents off (AMOUNT) or percent (PERCENT). Range rules in assertBenefitTerms. */
  discountValue: z.number().int().positive().max(1_000_000_00),
  maxDiscountCents: z.number().int().positive().max(1_000_000_00).nullable().optional(),
  categoryId: z.string().uuid().nullable().optional(),
  placeId: z.string().uuid().nullable().optional(),
  /**
   * Sanitized, not merely trimmed. This is owner-authored text that lands on
   * the buyer's CHECKOUT LINE, so it goes through the same plain-text cleaner
   * every other owner-authored label does — which strips markup, control
   * characters and bidi overrides. React escapes at the sink, but a bidi
   * override would still let a label render differently than it is stored, on
   * a surface that is asking someone for money.
   */
  label: plainTextOptional(80)
    // Sanitizing can EMPTY a label that was pure markup ("<b></b>" → ""), and
    // an empty string is not the same as "no override": the checkout line
    // falls back with `label ?? generated`, so "" would render a blank label
    // where the tier name belongs. Collapse it to null at the boundary.
    .transform((value) => (value === "" ? null : value))
    .nullable()
    .optional(),
});

export const membershipTierBenefitOutputSchema = z.object({
  id: z.string().uuid(),
  tierId: z.string().uuid(),
  discountKind: z.enum(["AMOUNT", "PERCENT"]),
  discountValue: z.number().int(),
  maxDiscountCents: z.number().int().nullable(),
  categoryId: z.string().uuid().nullable(),
  placeId: z.string().uuid().nullable(),
  label: z.string().nullable(),
});

export type MembershipTierBenefitOutput = z.infer<
  typeof membershipTierBenefitOutputSchema
>;

export const membershipOutputSchema = z.object({
  id: z.string().uuid(),
  tierId: z.string().uuid(),
  memberHumanId: z.string().uuid(),
  /** Stripe's subscription status vocabulary verbatim — see membership-status.ts. */
  status: z.string(),
  currentPeriodStart: z.coerce.date(),
  currentPeriodEnd: z.coerce.date(),
  cancelAtPeriodEnd: z.boolean(),
  canceledAt: z.coerce.date().nullable(),
  startedAt: z.coerce.date(),
});

export type MembershipOutput = z.infer<typeof membershipOutputSchema>;
