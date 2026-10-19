/**
 * Client-side row shape for the admin memberships table, mapped from
 * `memberships.tiers.list` (core: `listTiersForOwner`). One definition shared
 * by the view + dialogs so the lock flags (`priceLocked`, `memberCount`) can't
 * drift between the table and the edit form that disables fields off them.
 */

export interface TierBenefitRow {
  id: string;
  tierId: string;
  discountKind: BenefitDiscountKind;
  discountValue: number;
  maxDiscountCents: number | null;
  categoryId: string | null;
  placeId: string | null;
  label: string | null;
}

export type TierStatus = "DRAFT" | "ACTIVE" | "ARCHIVED";
export type TierInterval = "MONTH" | "YEAR";
export type BenefitDiscountKind = "AMOUNT" | "PERCENT";

export interface TierRow {
  id: string;
  name: string;
  description: string | null;
  /** The owner's own statement of what members get. */
  benefitsDescription: string | null;
  priceCents: number;
  currency: string;
  interval: TierInterval;
  status: TierStatus;
  sortOrder: number;
  /** Members currently entitled (active / trialing). */
  memberCount: number;
  /**
   * True once `priceCents` can no longer be edited (a member has ever existed,
   * or the Stripe Price is minted). Archive-and-replace is the path.
   */
  priceLocked: boolean;
  benefits: TierBenefitRow[];
  createdAt: Date;
}
